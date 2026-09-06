/**
 * The proposing round: every seat writes the same change, separately.
 *
 * One model writing code is one model's blind spots. Four writing the same
 * change independently, into trees that cannot see each other, gives the
 * selection round something real to choose between — and a seat that
 * misunderstood the task shows up as a candidate nobody votes for rather than
 * as a commit somebody has to find later.
 *
 * Nothing here touches a repository. Each seat's work lands under its own root
 * and stays there until a person implements the winner. That is the whole
 * safety property: the round can be run, read and thrown away at no cost
 * beyond the tokens it spent.
 *
 * Seats read through the same broker they use everywhere else, so a seat can
 * ask for the file it is about to rewrite. It gets one such request, for the
 * same reason a swarm unit does: each is another paid call.
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SeatConfig } from './seats.ts'
import { askSeat } from './seats.ts'
import type { FileSeam } from './files.ts'
import { gatherFiles, parseReadRequests, readRequestSection } from './files.ts'
import type { Candidate, WriteSeam } from './writes.ts'
import { applyWrites, parseWriteRequests, renderCandidates, writeRequestSection } from './writes.ts'
import type { SelectionResult } from './select.ts'
import { runSelection } from './select.ts'

/** Newline, spelled out because reports are assembled from arrays. */
const NL = String.fromCharCode(10)

/** How far a proposing run got. */
export type ProposePhase =
  /** Priced and waiting at the approval gate. Nothing ran. */
  | 'plan'
  /** Could not proceed. */
  | 'blocked'
  /** Seats proposed, and the selection round ran. */
  | 'full'

/** Everything one proposing run needs. */
export interface ProposeOptions {
  /** What the seats should implement, in the user's own terms. */
  readonly task: string
  /** Every configured seat. */
  readonly seats: readonly SeatConfig[]
  /** Absolute source roots the change targets. */
  readonly fileRoots: readonly string[]
  /** Directory under which each seat's own tree is created. */
  readonly workRoot: string
  /** Whether the gate has been passed. */
  readonly approved: boolean
  readonly files: FileSeam
  readonly writes: WriteSeam
  readonly apiKey?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs: number
  readonly sequential?: boolean | undefined
  readonly memory?: { file?: string | undefined; text?: string | undefined } | undefined
  readonly webMaxResults?: number | undefined
  /** Run id, so a second run does not overwrite the first. Generated when absent. */
  readonly runId?: string | undefined
}

/** The outcome of one proposing run. */
export interface ProposeResult {
  readonly phase: ProposePhase
  readonly task: string
  readonly runId: string
  readonly candidates: readonly Candidate[]
  readonly selection?: SelectionResult | undefined
  /** Seats that were asked but produced nothing usable. */
  readonly silent: readonly string[]
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
 * The prompt asking one seat to write its version of the change.
 * @param task - what to implement.
 * @param roots - source roots, for both reading and targeting.
 * @param files - file evidence already served, when re-asking.
 * @returns the prompt.
 */
export function proposePrompt(task: string, roots: readonly string[], files = ''): string {
  // Once files have been served the read offer is withdrawn, so a seat cannot
  // spend the round asking instead of writing.
  const ask = files === '' ? readRequestSection(roots) : ''
  const served = files === '' ? '' : `${NL}${NL}${files}`
  const first = files === ''
    ? `${NL}${NL}If you need to see a file before you can write it, reply with READ: lines and nothing else. You get one such request, so ask for everything at once.`
    : ''
  return `Implement the change below by writing your own version of each file it touches.

Other models are doing the same task separately. A later round picks one
version to be implemented for real, so write the version you would defend, not
the one you think will be popular. Change only what the task asks for: a
candidate that rewrites more than it needed to loses to one that did not.

THE CHANGE:
${task}${served}${ask}${writeRequestSection(roots)}${first}`
}

/**
 * Ask every enabled seat to write the change, then pick a winner.
 * @param options - the task, the seats, and where their trees go.
 * @returns the candidates, the selection, and a report.
 */
export async function runPropose(options: ProposeOptions): Promise<ProposeResult> {
  const runId = options.runId ?? randomUUID()
  const active = options.seats.filter(seat => seat.enabled)
  const sequential = options.sequential === true

  if (options.fileRoots.length === 0) {
    return blocked(options.task, runId, 'No source directory is granted, so no seat could target a file. Set `fileRoots` first.')
  }
  if (active.length === 0) {
    return blocked(options.task, runId, 'No seat is switched on, so nobody could write anything.')
  }

  if (!options.approved) {
    return {
      phase: 'plan',
      task: options.task,
      runId,
      candidates: [],
      silent: [],
      report: [
        '## Proposing round — waiting for approval',
        '',
        `**Change:** ${options.task}`,
        '',
        `${String(active.length)} seat(s) would each write their own version, then vote on which is implemented:`,
        '',
        ...active.map(seat => `  - ${seat.name} (${seat.id})`),
        '',
        `Each seat writes into \`${resolve(options.workRoot, runId)}\`, under its own id. Nothing reaches the repositories.`,
        '',
        `Expect ${String(active.length)} writing call(s) plus ${String(active.length)} voting call(s). Writing calls are long: a seat emits whole files.`,
        '',
        '_Press **Approve** below, then send any message._',
      ].join(NL),
    }
  }

  // Each seat writes its own version. A seat that asks to read first is served
  // once and put again, the same bargain the swarm makes.
  const replies = await fanOut(
    active.map(seat => async (): Promise<{ seat: string; text: string; error?: string | undefined }> => {
      let reply = await askSeat(
        seat,
        proposePrompt(options.task, options.fileRoots),
        options.apiKey,
        options.signal,
        options.timeoutMs,
        options.memory,
        options.webMaxResults,
      )
      const wanted = reply.error === undefined ? parseReadRequests(reply.text) : []
      const asksFirst = wanted.length > 0
        && /^\s*READ\s*:/i.test((reply.text.trim().split(/\r?\n/)[0] ?? ''))
      if (asksFirst) {
        const served = await gatherFiles(options.files, options.fileRoots, [{ seat: seat.id, paths: wanted }], options.signal)
        if (served !== undefined) {
          const retry = await askSeat(
            seat,
            proposePrompt(options.task, options.fileRoots, served.block),
            options.apiKey,
            options.signal,
            options.timeoutMs,
            options.memory,
            options.webMaxResults,
          )
          if (retry.error === undefined && retry.text !== '') reply = retry
        }
      }
      return { seat: seat.id, text: reply.text, ...reply.error === undefined ? {} : { error: reply.error } }
    }),
    sequential,
  )

  const candidates: Candidate[] = []
  const silent: string[] = []
  for (const reply of replies) {
    if (reply.error !== undefined || reply.text === '') {
      silent.push(`${reply.seat} — ${reply.error ?? 'empty reply'}`)
      continue
    }
    const proposals = parseWriteRequests(reply.text)
    if (proposals.length === 0) {
      silent.push(`${reply.seat} — replied without proposing any file`)
      continue
    }
    const seatRoot = resolve(options.workRoot, runId, reply.seat)
    candidates.push(await applyWrites(options.writes, seatRoot, options.fileRoots, reply.seat, proposals))
  }

  const selection = await runSelection({
    task: options.task,
    candidates,
    seats: active,
    files: options.files,
    ...options.apiKey === undefined ? {} : { apiKey: options.apiKey },
    ...options.signal === undefined ? {} : { signal: options.signal },
    timeoutMs: options.timeoutMs,
    sequential,
    ...options.memory === undefined ? {} : { memory: options.memory },
  })

  const lines: string[] = [
    '## Proposing round',
    '',
    `**Change:** ${options.task}`,
    '',
    `Run \`${runId}\`, trees under \`${resolve(options.workRoot, runId)}\`.`,
    '',
    '### Candidates',
    '',
    renderCandidates(candidates),
  ]
  if (silent.length > 0) {
    lines.push('### Seats that proposed nothing', '')
    for (const note of silent) lines.push(`  - ${note}`)
    lines.push('')
  }
  lines.push(selection.report)

  return {
    phase: 'full',
    task: options.task,
    runId,
    candidates,
    selection,
    silent,
    report: lines.join(NL),
  }
}

/**
 * A run that stopped before spending anything.
 * @param task - the requested change.
 * @param runId - the run id.
 * @param reason - why it stopped.
 * @returns the blocked result.
 */
function blocked(task: string, runId: string, reason: string): ProposeResult {
  return {
    phase: 'blocked',
    task,
    runId,
    candidates: [],
    silent: [],
    report: ['## Proposing round — blocked', '', `> **!** ${reason}`, '', 'Nothing was run and nothing was spent.'].join(NL),
  }
}
