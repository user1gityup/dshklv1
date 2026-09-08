/**
 * The council → propose → swarm → council chain, as one resumable run.
 *
 * Each of the tools already works alone, and stringing them together by asking
 * the model to call them in order is what this replaces. That version has no
 * memory: nothing carries the agreed approach into the decomposition, nothing
 * carries the units' output into the review, and a model that forgets a stage
 * simply does not run it. Here the stage is durable state, so the chain is a
 * fact about the run rather than a hope about the model.
 *
 * One call advances ONE stage. That is deliberate: every stage spends, and a
 * call that could spend three times over is a call no gate can price. Between
 * stages the run sits in settings, which is also what makes it survivable —
 * see the hold below.
 *
 * **The stage list belongs to the run, not to this module.** A run that only
 * has to decide something wants council → swarm → review; a run that has to
 * BUILD something wants a proposing stage in the middle, where every seat
 * writes its own version of the change into a tree of its own and the user
 * picks between them before any work is split up. Hard-coding one order made
 * the second kind impossible to express: a request that described its own
 * stages in prose got the three-stage chain anyway, and the samples it asked
 * for had nowhere to come from. So the order is data now, carried in the state
 * and validated on the way in, and {@link PIPELINE_STAGES} is only the default.
 *
 * **A spent quota holds the run; it never fails it.** A seat that runs out of
 * subscription allowance has produced no work and lost none: the approved
 * graph, the plan it came from and the units already finished all stay exactly
 * where they are, and the run resumes at the same stage once the window rolls
 * over. Treating exhaustion as failure would throw away an approval the user
 * paid a planning call for, and charge them a second one to get back.
 */

import { detectQuotaHold, holdElapsed, holdRemaining } from './quota-hold.ts'
import type { QuotaHold } from './quota-hold.ts'
import type { SubTask } from './decompose.ts'
import type { SwarmUnitResult } from './swarm.ts'

/** Every stage the chain knows how to run, in their natural order. */
export const ALL_PIPELINE_STAGES = ['council', 'propose', 'swarm', 'review'] as const

/** One stage of the chain. */
export type PipelineStage = (typeof ALL_PIPELINE_STAGES)[number]

/**
 * The default order: decide, split, review.
 *
 * Kept as the default rather than the only order because it is what a run that
 * answers a question wants, and because every run stored before the order
 * became configurable is one of these.
 */
export const PIPELINE_STAGES = ['council', 'swarm', 'review'] as const satisfies readonly PipelineStage[]

/**
 * The order a build wants: decide, write competing versions, split, review.
 *
 * The proposing stage sits between the decision and the work because that is
 * the only point where choosing is cheap. Once the swarm has split the job the
 * choice has already been made implicitly by whoever wrote the graph.
 */
export const BUILD_PIPELINE_STAGES = ['council', 'propose', 'swarm', 'review'] as const satisfies readonly PipelineStage[]

/**
 * Read a stage list written as text, e.g. `council,propose,swarm,review`.
 *
 * Unknown names are dropped rather than rejected: a list that names one stage
 * this build does not have should still run the stages it does, and a run is
 * worse off stopped than shortened. An empty result falls back to the default,
 * so a typo can never produce a chain with nothing in it.
 * @param text - comma or space separated stage names, in order.
 * @returns the stages, or the default when none survive.
 */
export function parseStages(text: string | undefined): readonly PipelineStage[] {
  if (text === undefined || text.trim() === '') return PIPELINE_STAGES
  const known = new Set<string>(ALL_PIPELINE_STAGES)
  const seen = new Set<string>()
  const out: PipelineStage[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.trim().toLowerCase()
    // A stage repeated in one list would run twice and be indexed once, so the
    // progress line and `nextStage` would disagree about where the run is.
    if (!known.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name as PipelineStage)
  }
  return out.length === 0 ? PIPELINE_STAGES : out
}

/** How a call ended. */
export type PipelinePhase =
  /** A stage ran and the next one is waiting at its gate. */
  | 'staged'
  /** Every stage is done. */
  | 'done'
  /** Parked on a spent allowance. Nothing was lost and nothing was spent. */
  | 'held'
  /** Cannot proceed for a reason waiting will not fix. */
  | 'blocked'

/** One stage of the chain that has finished. */
export interface StageRecord {
  readonly stage: PipelineStage
  /** The stage's own report, as shown when it ran. */
  readonly text: string
  /** Epoch ms the stage finished. */
  readonly at: number
}

/**
 * One seat's sandboxed version of the change, as the chain carries it.
 *
 * Only what a later stage or a person needs to find the tree again: the code
 * itself stays on disk under the seat's own root, because a chain state that
 * carried file bodies would put tens of thousands of characters into settings,
 * which is read whole on every tool invocation.
 */
export interface PipelineCandidate {
  /** Seat that wrote it. */
  readonly seat: string
  /** Absolute root the seat's files were written under. */
  readonly root: string
  /** How many files it wrote. */
  readonly files: number
}

/**
 * The run, as it survives between calls.
 *
 * Serialised into settings by the caller. Every field is optional but `id` and
 * `query`: a run that has only just started has nothing else yet, and a state
 * that cannot be partially filled cannot be resumed.
 */
export interface PipelineState {
  readonly id: string
  readonly query: string
  /** The stage the NEXT call will run. */
  readonly stage: PipelineStage
  /**
   * The order this run advances through. Absent means {@link PIPELINE_STAGES},
   * which is what every run stored before the order was configurable has.
   */
  readonly stages?: readonly PipelineStage[] | undefined
  /** The approach the council agreed, carried into every stage after it. */
  readonly plan?: string | undefined
  /**
   * Seat whose plan won the vote, carried into every stage after it.
   *
   * The approach alone says what to do; this says who worked it out. A later
   * stage that has to pick a seat for a job — writing the decomposition, above
   * all — should route on what the run earned rather than on a configured
   * preference, and that is only possible if the winner survives the stage
   * boundary the way the approach does.
   */
  readonly winner?: string | undefined
  /** The approved graph, stored verbatim so it is never re-planned. */
  readonly tasks?: readonly SubTask[] | undefined
  /** Sandboxed versions the proposing stage wrote, carried into the swarm. */
  readonly candidates?: readonly PipelineCandidate[] | undefined
  /** What the workers reported, carried into the review. */
  readonly units?: readonly SwarmUnitResult[] | undefined
  /** Finished stages, oldest first. */
  readonly records?: readonly StageRecord[] | undefined
  /** Set while parked on a spent allowance. */
  readonly hold?: QuotaHold | undefined
}

/** What one stage runner is handed. */
export interface StageInput {
  readonly query: string
  /** The council's agreed approach; absent at stage one. */
  readonly plan?: string | undefined
  /** The seat whose plan won; absent at stage one, or when no vote settled. */
  readonly winner?: string | undefined
  /** The approved graph; present for the swarm stage once approved. */
  readonly tasks?: readonly SubTask[] | undefined
  /** The sandboxed versions; present once a proposing stage has run. */
  readonly candidates?: readonly PipelineCandidate[] | undefined
  /** What the workers reported; present at the review stage. */
  readonly units?: readonly SwarmUnitResult[] | undefined
}

/** What a stage runner gives back. */
export interface StageOutput {
  /** Markdown for the main window. */
  readonly report: string
  /** True when the stage did its work; false when it stopped at its own gate. */
  readonly complete: boolean
  /** Calls that failed, so exhaustion can be told from a fault. */
  readonly failures?: readonly { readonly seat?: string | undefined; readonly error: string }[] | undefined
  /** Reasons the stage cannot proceed at all. */
  readonly problems?: readonly string[] | undefined
  /** The approach, when the council stage produced one. */
  readonly plan?: string | undefined
  /** The winning seat, when the council stage's vote settled on one. */
  readonly winner?: string | undefined
  /** The graph, when the swarm stage produced or ran one. */
  readonly tasks?: readonly SubTask[] | undefined
  /** The sandboxed versions, when the proposing stage wrote any. */
  readonly candidates?: readonly PipelineCandidate[] | undefined
  /** Unit results, when the swarm stage ran. */
  readonly units?: readonly SwarmUnitResult[] | undefined
}

/** Everything a call needs beyond the state itself. */
export interface PipelineOptions {
  readonly state: PipelineState
  /** Runs one stage. Injected so the chain can be tested without spending. */
  readonly runStage: (stage: PipelineStage, input: StageInput) => Promise<StageOutput>
  /** Epoch ms, injectable for tests. */
  readonly now?: number | undefined
  /**
   * Latest known session usage, when a quota reading exists. Used only to
   * release a hold early, never to impose or extend one.
   */
  readonly sessionPercent?: number | undefined
}

/** What a call did. */
export interface PipelineResult {
  readonly phase: PipelinePhase
  readonly state: PipelineState
  /** Markdown for the main window. */
  readonly report: string
}

/**
 * The order a run advances through, defaulted for runs stored before the order
 * was data.
 * @param state - the run.
 * @returns its stage list.
 */
export function stagesOf(state: PipelineState): readonly PipelineStage[] {
  const stages = state.stages
  return stages === undefined || stages.length === 0 ? PIPELINE_STAGES : stages
}

/**
 * The stage after this one, or undefined at the end of the chain.
 * @param stage - the stage that just finished.
 * @param stages - the order this run advances through.
 * @returns the next stage.
 */
export function nextStage(
  stage: PipelineStage,
  stages: readonly PipelineStage[] = PIPELINE_STAGES,
): PipelineStage | undefined {
  const at = stages.indexOf(stage)
  return at < 0 ? undefined : stages[at + 1]
}

/** How each stage reads in a report. */
const STAGE_TITLE: Record<PipelineStage, string> = {
  council: 'Council — agree the approach',
  propose: 'Propose — every seat writes its own version, in its own tree',
  swarm: 'Swarm — split and run the work',
  review: 'Council — review what came back',
}

/**
 * Start a run. Nothing has been spent at this point.
 * @param id - the run's id, used by the gate controls.
 * @param query - the user's request, in their own words.
 * @param stages - the order to advance through; defaults to the three-stage chain.
 * @returns the state a first call will advance.
 */
export function startPipeline(
  id: string,
  query: string,
  stages: readonly PipelineStage[] = PIPELINE_STAGES,
): PipelineState {
  const order = stages.length === 0 ? PIPELINE_STAGES : stages
  // The first stage is whatever the order starts with, not a fixed 'council':
  // a run told to start at the proposing stage has had its decision made
  // somewhere else already, and charging it for a council round to get there
  // would be charging for an answer it already has.
  return { id, query, stage: order[0] ?? 'council', stages: order }
}

/**
 * The progress line every report carries, so the user can see where they are.
 * @param state - the run.
 * @returns e.g. "Stage 2 of 4 · Propose — every seat writes its own version".
 */
function progress(state: PipelineState): string {
  const stages = stagesOf(state)
  const at = stages.indexOf(state.stage)
  return `Stage ${String(at + 1)} of ${String(stages.length)} · ${STAGE_TITLE[state.stage]}`
}

/**
 * The report shown while a run is parked on a spent allowance.
 * @param state - the run, with its hold set.
 * @param now - epoch ms.
 * @returns markdown.
 */
function heldReport(state: PipelineState, now: number): string {
  const hold = state.hold
  if (hold === undefined) return ''
  const who = hold.seat === undefined ? 'A seat' : `**${hold.seat}**`
  const when = hold.source === 'stated'
    ? `The allowance was said to reset ${holdRemaining(hold.resumeAt, now)}.`
    : `No reset time was given, so this waits ${holdRemaining(hold.resumeAt, now)} before trying again.`
  const done = (state.records ?? []).map(record => `- ${STAGE_TITLE[record.stage]} — finished`).join('\n')
  return [
    '## Held — waiting on quota',
    '',
    `${who} ran out of allowance part way through **${STAGE_TITLE[state.stage]}**.`,
    'Nothing was lost and nothing more was spent: the run is parked exactly where it stood.',
    '',
    when,
    '',
    done === '' ? '_No stage has finished yet._' : `**Already done**\n${done}`,
    '',
    'Run `pipeline` again after that, or press Resume — it picks up at the same stage.',
    'The plan and the approved graph are kept, so resuming costs no new planning call.',
    '',
    `_${hold.detail}_`,
  ].join('\n')
}

/**
 * Advance a run by one stage.
 *
 * Four things can happen, and only one of them spends: the run is held and
 * stays held; the stage runs and the chain moves on; the stage runs out of
 * allowance and the run parks unchanged; or the stage reports a problem
 * waiting cannot fix and the run stops.
 * @param options - the state, the stage runner, and the clock.
 * @returns the new state and what to show.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const now = options.now ?? Date.now()
  const state = options.state
  const stages = stagesOf(state)

  // Still parked: do not call a seat at all. The whole point of the hold is
  // that a spent allowance costs nothing further until it resets.
  if (state.hold !== undefined && !holdElapsed(state.hold.resumeAt, now, options.sessionPercent)) {
    return { phase: 'held', state, report: heldReport(state, now) }
  }

  // The hold has elapsed: clear it and run the same stage again. The stage is
  // deliberately not advanced — the work it was interrupted in the middle of
  // has not been done.
  const resumed: PipelineState = state.hold === undefined
    ? state
    : { ...state, hold: undefined }

  const output = await options.runStage(resumed.stage, {
    query: resumed.query,
    ...(resumed.plan === undefined ? {} : { plan: resumed.plan }),
    ...(resumed.winner === undefined ? {} : { winner: resumed.winner }),
    ...(resumed.tasks === undefined ? {} : { tasks: resumed.tasks }),
    ...(resumed.candidates === undefined ? {} : { candidates: resumed.candidates }),
    ...(resumed.units === undefined ? {} : { units: resumed.units }),
  })

  // Allowance, not fault: park with everything intact.
  const hold = detectQuotaHold(output.failures ?? [], now)
  if (hold !== undefined) {
    const held: PipelineState = {
      ...resumed,
      // Whatever the stage did manage to produce is kept, so a resumed run
      // does not redo the units — or the candidates — that already landed.
      ...(output.plan === undefined ? {} : { plan: output.plan }),
      ...(output.winner === undefined ? {} : { winner: output.winner }),
      ...(output.tasks === undefined ? {} : { tasks: output.tasks }),
      ...(output.candidates === undefined ? {} : { candidates: output.candidates }),
      ...(output.units === undefined ? {} : { units: output.units }),
      hold,
    }
    return { phase: 'held', state: held, report: heldReport(held, now) }
  }

  if ((output.problems ?? []).length > 0) {
    return {
      phase: 'blocked',
      state: resumed,
      report: [
        `## ${STAGE_TITLE[resumed.stage]} — blocked`,
        '',
        ...(output.problems ?? []).map(problem => `- ${problem}`),
        '',
        output.report,
      ].join('\n'),
    }
  }

  // The stage stopped at its own gate: state moves no further, and the report
  // is the stage's own — the gate control binds to that, not to this chain.
  if (!output.complete) {
    const waiting: PipelineState = {
      ...resumed,
      ...(output.plan === undefined ? {} : { plan: output.plan }),
      ...(output.winner === undefined ? {} : { winner: output.winner }),
      ...(output.tasks === undefined ? {} : { tasks: output.tasks }),
    }
    return {
      phase: 'staged',
      state: waiting,
      report: `${progress(waiting)}\n\n${output.report}`,
    }
  }

  const records: readonly StageRecord[] = [
    ...(resumed.records ?? []),
    { stage: resumed.stage, text: output.report, at: now },
  ]
  const after = nextStage(resumed.stage, stages)
  const advanced: PipelineState = {
    ...resumed,
    stage: after ?? resumed.stage,
    records,
    ...(output.plan === undefined ? {} : { plan: output.plan }),
    ...(output.winner === undefined ? {} : { winner: output.winner }),
    ...(output.tasks === undefined ? {} : { tasks: output.tasks }),
    ...(output.candidates === undefined ? {} : { candidates: output.candidates }),
    ...(output.units === undefined ? {} : { units: output.units }),
  }

  if (after === undefined) {
    return {
      phase: 'done',
      state: advanced,
      report: ['## Pipeline complete', '', output.report].join('\n'),
    }
  }

  // A proposing stage that just finished has left the user something to read
  // and choose between, and the next stage builds whatever they choose. Saying
  // so here is the difference between a chain that pauses for a decision and
  // one that looks like it stalled.
  const handover = resumed.stage === 'propose'
    ? [
      `**Next:** ${STAGE_TITLE[after]}, built from the version you pick.`,
      'Read the candidates above, say which one — or which parts of which — you want,',
      'then approve. Nothing is built until you have said.',
    ]
    : [
      `**Next:** ${STAGE_TITLE[after]}. Approve it to spend, or stop here — the run keeps.`,
    ]

  return {
    phase: 'staged',
    state: advanced,
    report: [
      progress(advanced),
      '',
      output.report,
      '',
      '---',
      ...handover,
    ].join('\n'),
  }
}
