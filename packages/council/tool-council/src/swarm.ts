/**
 * Running a request as a swarm, without a council deciding first.
 *
 * The council path exists to settle *what to do* when that is genuinely in
 * doubt, and it costs a full round of drafts and reviews to do it. Plenty of
 * work is not in doubt: the user knows what they want and wants it split
 * across the agents they already configured. Making them buy a debate first
 * would be charging them for an answer they already have.
 *
 * So this path decomposes the request itself, assigns the units across the
 * enabled seats, and stops — the same two-factor gate the council stops at,
 * for the same reason. Nothing here runs a unit until a person has pressed
 * Approve and then spoken. The estimate is shown at that gate rather than
 * after, because a number that arrives afterwards is a bill, not a choice.
 *
 * Workers are seats, not subagent providers. A seat is a one-shot prompt over
 * its own transport, so a unit's worker reads, searches and reports; it does
 * not hold a session and it writes nothing unless the seat's own argv lets it.
 * That is a real ceiling on what this can do, and it is deliberate: the seat
 * roster is the set of agents the user configured, and widening what one may
 * do is a change to that seat, made by the user, not a power this module
 * grants itself.
 */

import type { SubTask } from './decompose.ts'
import { directDecomposePrompt, executionWaves, parseDecomposition } from './decompose.ts'
import type { Assignment, Worker } from './roster.ts'
import { assignWorkers, seatRoster } from './roster.ts'
import type { ExecutionEstimate, ProviderCost } from './execution-cost.ts'
import { estimateExecution, renderExecutionEstimate } from './execution-cost.ts'
import type { ModelPrice } from './estimate.ts'
import type { SeatConfig } from './seats.ts'
import { askSeat } from './seats.ts'
import { choosePlanner } from './council.ts'
import type { FileSeam } from './files.ts'
import { gatherFiles, parseReadRequests, readRequestSection } from './files.ts'

/** Newline, spelled out because the report is assembled from arrays. */
const NL = String.fromCharCode(10)

/** How a seat's swarm participation is overridden. */
export interface SwarmOverride {
  readonly enabled?: boolean | undefined
  readonly kinds?: readonly string[] | undefined
}

/** Everything one swarm run needs. */
export interface SwarmRunOptions {
  /** What the user asked for, verbatim. */
  readonly query: string
  /** Every configured seat, shipped and user-added. */
  readonly seats: readonly SeatConfig[]
  /** Per-seat swarm state, keyed by seat id. */
  readonly overrides: Readonly<Record<string, SwarmOverride>>
  /**
   * Whether the gate has been passed. False plans and stops; nothing is run
   * and nothing but the one planning call is spent.
   */
  readonly approved: boolean
  /** OpenRouter key, used only by OpenRouter seats. */
  readonly apiKey?: string | undefined
  /** OpenRouter price table, for the estimate shown at the gate. */
  readonly pricing: ReadonlyMap<string, ModelPrice>
  /** Hard cap per seat call. */
  readonly timeoutMs: number
  /** Seat id that should write the decomposition. */
  readonly planner?: string | undefined
  /**
   * The graph to run, when one was already approved.
   *
   * An approved run MUST NOT decompose again. Re-planning would produce a
   * different graph from the one the user read and approved, so the approval
   * would be carrying work nobody saw. Supplying the stored graph is also what
   * makes approval cost nothing: the planning call was already paid for before
   * the gate.
   */
  readonly tasks?: readonly SubTask[] | undefined
  /** Run units one at a time instead of a wave at a time. */
  readonly sequential?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly memory?: { file?: string | undefined; text?: string | undefined } | undefined
  readonly webMaxResults?: number | undefined
  /**
   * File seam used to serve paths a unit asks for. A worker never reads for
   * itself; it names a path and this reads it, or refuses.
   */
  readonly files?: FileSeam | undefined
  /** Absolute directories a unit may be shown files from. */
  readonly fileRoots?: readonly string[] | undefined
}

/** What one worker did with one unit. */
export interface SwarmUnitResult {
  readonly task: SubTask
  /** Seat id that ran it. */
  readonly seat: string
  readonly text: string
  readonly error?: string | undefined
  readonly ms: number
}

/** How far a swarm run got, and why it stopped there. */
export type SwarmPhase =
  /** Decomposed and priced, waiting at the approval gate. Nothing ran. */
  | 'plan'
  /** Could not proceed: no worker, no usable graph, or no planner. */
  | 'blocked'
  /** Units ran. */
  | 'full'

/** The outcome of one swarm run. */
export interface SwarmResult {
  readonly phase: SwarmPhase
  readonly query: string
  readonly tasks: readonly SubTask[]
  /** Faults that make the graph unsafe to run. Non-empty means blocked. */
  readonly problems: readonly string[]
  readonly assignments: readonly Assignment[]
  readonly estimate?: ExecutionEstimate | undefined
  readonly results: readonly SwarmUnitResult[]
  /** Markdown for the main window. */
  readonly report: string
}

/** Run thunks together or one at a time. */
async function fanOut<T>(tasks: readonly (() => Promise<T>)[], sequential: boolean): Promise<T[]> {
  if (!sequential) return await Promise.all(tasks.map(task => task()))
  const out: T[] = []
  for (const task of tasks) out.push(await task())
  return out
}

/**
 * The prompt one worker gets for one unit.
 *
 * A worker has not read the conversation and never sees the other workers, so
 * everything it needs travels here: the original request for context, its own
 * unit, and the reports of the units it depends on. Dependency output is
 * included rather than summarised — a worker asked to build on a result it
 * cannot see will invent one.
 * A worker that may ask for files is told so here, and told how. It gets one
 * chance to ask: the reply naming paths is answered with their contents and
 * the unit is put again. Asking therefore costs a second call, and only for
 * the units that actually ask — which is why it is not a round of its own.
 * @param query - the original request.
 * @param task - the unit to do.
 * @param done - results of units already finished.
 * @param roots - directories the worker may ask to be shown files from.
 * @param files - file evidence already served to this worker, when re-asking.
 * @returns the prompt.
 */
export function unitPrompt(
  query: string,
  task: SubTask,
  done: readonly SwarmUnitResult[],
  roots: readonly string[] = [],
  files = '',
): string {
  const upstream = task.dependsOn
    .map(id => done.find(result => result.task.id === id))
    .filter((result): result is SwarmUnitResult => result !== undefined && result.error === undefined)
  const context = upstream.length === 0
    ? ''
    : `${NL}${NL}WHAT THE UNITS YOU DEPEND ON REPORTED:${NL}${upstream
      .map(result => `--- ${result.task.id}: ${result.task.title} ---${NL}${result.text}`)
      .join(`${NL}${NL}`)}`

  // Once files have been served the offer is withdrawn: a worker allowed to
  // ask again could ask forever, and each round is another paid call.
  const offer = files !== '' || roots.length === 0
    ? ''
    : `${NL}${readRequestSection(roots)}${NL}${NL}If you need to see source before you can do your unit, reply with READ: lines and nothing else. You will be given the files and asked again. You get one such request, so ask for everything you need at once.`
  const served = files === '' ? '' : `${NL}${NL}${files}`

  return `You are one worker in a team. Do YOUR unit only, and report what you did.

Do not do another worker's unit, and do not restate the whole plan. If your
unit turns out to be impossible or already done, say so plainly rather than
inventing work.

THE OVERALL REQUEST (context — not your unit):
${query}

YOUR UNIT: ${task.title}
${task.detail}${context}${served}${offer}`
}

/** One seat's cost shape, for the estimate. */
function providerCosts(roster: readonly Worker[], seats: readonly SeatConfig[]): readonly ProviderCost[] {
  return roster.map((worker) => {
    const seat = seats.find(entry => entry.id === worker.provider)
    return {
      name: worker.provider,
      costClass: worker.costClass,
      ...seat?.model === undefined ? {} : { model: seat.model },
    }
  })
}

/** Render the plan the gate is holding. */
function planReport(
  query: string,
  tasks: readonly SubTask[],
  assignments: readonly Assignment[],
  estimate: ExecutionEstimate,
  approved: boolean,
): string {
  const lines: string[] = [
    approved ? '## Swarm — running' : '## Swarm — plan, waiting for approval',
    '',
    `**Request:** ${query}`,
    '',
    `### Units (${String(tasks.length)})`,
    '',
  ]
  for (const assignment of assignments) {
    const who = assignment.provider ?? '**nobody**'
    lines.push(`- \`${assignment.task.id}\` **${assignment.task.title}** — ${who} _(${assignment.reason})_`)
    if (assignment.task.dependsOn.length > 0) {
      lines.push(`  - after: ${assignment.task.dependsOn.map(id => `\`${id}\``).join(', ')}`)
    }
  }
  lines.push('', ...renderExecutionEstimate(estimate))
  if (!approved) {
    lines.push(
      '',
      '_Nothing has run and no unit has been spent on. Press **Approve** below,'
      + ' then send any message. Calling the swarm again only re-plans; it cannot approve._',
    )
  }
  return lines.join(NL)
}

/** Render a run that could not start. */
function blockedReport(query: string, reasons: readonly string[]): string {
  return [
    '## Swarm — cannot run',
    '',
    '> **!** Nothing ran and nothing was spent.',
    '',
    `**Request:** ${query}`,
    '',
    ...reasons.map(reason => `- ${reason}`),
  ].join(NL)
}

/** Render finished work. */
function runReport(
  query: string,
  assignments: readonly Assignment[],
  results: readonly SwarmUnitResult[],
  estimate: ExecutionEstimate,
): string {
  const failed = results.filter(result => result.error !== undefined)
  const lines: string[] = [
    '## Swarm — done',
    '',
    `**Request:** ${query}`,
    '',
    `${String(results.length - failed.length)} of ${String(results.length)} unit(s) reported.`
    + (failed.length === 0 ? '' : ` ${String(failed.length)} failed.`),
    '',
  ]
  for (const result of results) {
    const assignment = assignments.find(entry => entry.task.id === result.task.id)
    lines.push(
      `### \`${result.task.id}\` ${result.task.title}`,
      '',
      `_${assignment?.provider ?? result.seat} · ${String(Math.round(result.ms / 100) / 10)}s_`,
      '',
      result.error === undefined ? result.text : `> **failed:** ${result.error}`,
      '',
    )
  }
  lines.push(...renderExecutionEstimate(estimate))
  return lines.join(NL)
}

/**
 * Ask the planning seat to split the request, and read back what it said.
 *
 * A seat that fails, or answers with nothing a graph can be built from, stops
 * the run here rather than later: an empty or cyclic graph cannot be priced,
 * so there would be nothing truthful to put at the approval gate.
 * @param options - the run's inputs.
 * @param planner - the seat writing the decomposition.
 * @param enabled - workers a unit may name.
 * @returns the parsed graph, or the faults that stop it.
 */
async function decompose(
  options: SwarmRunOptions,
  planner: SeatConfig,
  enabled: readonly Worker[],
): Promise<{ tasks: readonly SubTask[]; problems: readonly string[] }> {
  const reply = await askSeat(
    planner,
    directDecomposePrompt(options.query, enabled.map(worker => worker.provider)),
    options.apiKey,
    options.signal,
    options.timeoutMs,
    options.memory,
    options.webMaxResults,
  )
  if (reply.error !== undefined) {
    return { tasks: [], problems: [`The planning seat **${planner.name}** failed: ${reply.error}`] }
  }
  return parseDecomposition(reply.text)
}

/**
 * Decompose a request, assign it across the seats, and — once approved — run it.
 *
 * Stops at the gate by default. The one call it makes before the gate is the
 * decomposition itself, which is what makes the estimate mean anything; that
 * cost is real and is why the planner prefers a seat whose price is known.
 * @param options - the request, the seats, and whether the gate has passed.
 * @returns what happened, and the report to show.
 */
export async function runSwarm(options: SwarmRunOptions): Promise<SwarmResult> {
  const roster = seatRoster(options.seats, options.overrides)
  const enabled = roster.filter(worker => worker.enabled)
  const empty = { query: options.query, tasks: [], problems: [], assignments: [], results: [] }

  if (enabled.length === 0) {
    return {
      ...empty,
      phase: 'blocked',
      report: blockedReport(options.query, [
        'No seat is switched on for swarm work. Turn one on in the swarm roster.',
      ]),
    }
  }

  // The planner is chosen from the seats that will do the work, so a run can
  // never be planned by a seat the user switched off.
  const workerSeats = options.seats.filter(seat => enabled.some(worker => worker.provider === seat.id))
  const planner = choosePlanner(
    workerSeats.map(seat => ({ ...seat, enabled: true })),
    options.planner,
  )
  if (planner === undefined && options.tasks === undefined) {
    return {
      ...empty,
      phase: 'blocked',
      report: blockedReport(options.query, ['No seat could write the decomposition.']),
    }
  }

  const decomposition = options.tasks === undefined
    ? await decompose(options, planner as SeatConfig, enabled)
    : { tasks: options.tasks, problems: [] as readonly string[] }
  // An empty graph always arrives with a problem attached — a planning seat
  // that failed, a reply with no json in it, or `validateGraph` rejecting what
  // was there — so the problems are the whole reason a run stops here.
  if (decomposition.problems.length > 0) {
    return {
      ...empty,
      phase: 'blocked',
      tasks: decomposition.tasks,
      problems: decomposition.problems,
      report: blockedReport(options.query, decomposition.problems),
    }
  }

  const plan = assignWorkers(decomposition.tasks, roster)
  const estimate = estimateExecution(
    decomposition.tasks,
    providerCosts(roster, options.seats),
    options.pricing,
    // Units naming no worker run on the first enabled seat, which is what
    // assignment does, so the estimate prices them the same way.
    enabled[0]?.provider ?? '',
  )

  if (plan.unassigned.length > 0) {
    return {
      ...empty,
      phase: 'blocked',
      tasks: decomposition.tasks,
      assignments: plan.assignments,
      estimate,
      report: blockedReport(options.query, [
        `No enabled seat could take: ${plan.unassigned.map(id => `\`${id}\``).join(', ')}.`,
        'Widen a seat\'s kinds in the swarm roster, or switch another seat on.',
      ]),
    }
  }

  if (!options.approved) {
    return {
      ...empty,
      phase: 'plan',
      tasks: decomposition.tasks,
      assignments: plan.assignments,
      estimate,
      report: planReport(options.query, decomposition.tasks, plan.assignments, estimate, false),
    }
  }

  // Approved: run the graph a wave at a time. A wave's units are independent
  // by construction, so they go together; the next wave waits, because its
  // units were declared to need what this one produced.
  const bySeat = new Map(options.seats.map(seat => [seat.id, seat]))
  const done: SwarmUnitResult[] = []
  for (const wave of executionWaves(decomposition.tasks)) {
    const started = done.slice()
    const batch = await fanOut(
      wave.map(task => async (): Promise<SwarmUnitResult> => {
        const assignment = plan.assignments.find(entry => entry.task.id === task.id)
        const seatId = assignment?.provider ?? enabled[0]?.provider ?? ''
        const seat = bySeat.get(seatId)
        if (seat === undefined) {
          return { task, seat: seatId, text: '', error: `no seat "${seatId}"`, ms: 0 }
        }
        const roots = options.fileRoots ?? []
        const canRead = options.files !== undefined && roots.length > 0
        let unit = await askSeat(
          seat,
          unitPrompt(options.query, task, started, canRead ? roots : []),
          options.apiKey,
          options.signal,
          options.timeoutMs,
          options.memory,
          options.webMaxResults,
        )
        // The worker asked to be shown source rather than doing the unit. Serve
        // what the roots allow and put the unit again, once. A reply that both
        // asks and answers is taken as an answer: re-asking would throw away
        // work already paid for.
        const wanted = canRead && unit.error === undefined ? parseReadRequests(unit.text) : []
        if (wanted.length > 0 && /^\s*(READ\s*:)/im.test(unit.text.trim().split(/\r?\n/)[0] ?? '')) {
          const served = await gatherFiles(options.files, roots, [{ seat: seatId, paths: wanted }], options.signal)
          if (served !== undefined) {
            const retry = await askSeat(
              seat,
              unitPrompt(options.query, task, started, roots, served.block),
              options.apiKey,
              options.signal,
              options.timeoutMs,
              options.memory,
              options.webMaxResults,
            )
            // A failed second call leaves the first reply in place; that reply
            // is only a list of paths, but it is more use than an error.
            if (retry.error === undefined && retry.text !== '') {
              unit = { ...retry, ms: unit.ms + retry.ms }
            }
          }
        }
        return {
          task,
          seat: seatId,
          text: unit.text,
          ...unit.error === undefined ? {} : { error: unit.error },
          ms: unit.ms,
        }
      }),
      options.sequential === true,
    )
    done.push(...batch)
  }

  return {
    phase: 'full',
    query: options.query,
    tasks: decomposition.tasks,
    problems: [],
    assignments: plan.assignments,
    estimate,
    results: done,
    report: runReport(options.query, plan.assignments, done, estimate),
  }
}
