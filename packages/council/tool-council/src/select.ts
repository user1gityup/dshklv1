/**
 * The round that picks which seat's code is implemented.
 *
 * Four seats each wrote their own version of the same change into their own
 * tree. None of it has touched the real repository, and exactly one version
 * should. That choice is a vote, not a merge: taking the best parts of four
 * candidates would produce a fifth version nobody wrote and nobody reviewed.
 *
 * The vote reuses the council's existing machinery — `parseReview` and
 * `tally`, self-votes already discounted — because a vote on code is the same
 * shape as a vote on prose, and a second tallier would be a second set of
 * rules to keep in step with the first.
 *
 * The prompt is capped hard. Four candidates at their full size would be a
 * prompt no seat reads carefully and every metered seat charges for, so each
 * candidate is shown up to a fixed budget and the cut is stated. A voter that
 * cannot see all of a candidate is told so, rather than left to assume the
 * file simply ended.
 */

import type { SeatId } from './colors.ts'
import type { SeatConfig, SeatReply } from './seats.ts'
import { askSeat } from './seats.ts'
import type { SeatReview, Verdict } from './council.ts'
import { parseReview, tally } from './council.ts'
import type { FileSeam } from './files.ts'
import type { Candidate } from './writes.ts'

/** Newline, spelled out because the prompt is assembled from arrays. */
const NL = String.fromCharCode(10)

/** Characters shown from one candidate, across all of its files. */
export const CANDIDATE_CHARS = 12_000

/** What one selection round produced. */
export interface SelectionResult {
  /** Seat whose code won, or undefined when no vote settled it. */
  readonly winner?: SeatId | undefined
  /** The winning candidate, when there is one. */
  readonly chosen?: Candidate | undefined
  readonly reviews: readonly SeatReview[]
  readonly verdict: Verdict
  /** Markdown for the main window. */
  readonly report: string
}

/** Everything one selection round needs. */
export interface SelectionOptions {
  /** What the seats were asked to implement, in the user's own terms. */
  readonly task: string
  /** One per seat that proposed code. */
  readonly candidates: readonly Candidate[]
  /** Every seat that may vote. */
  readonly seats: readonly SeatConfig[]
  /** Seam used to read candidate files back out of the seat trees. */
  readonly files: FileSeam
  readonly apiKey?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs: number
  readonly sequential?: boolean | undefined
  readonly memory?: { file?: string | undefined; text?: string | undefined } | undefined
}

/** Run thunks together or one at a time. */
async function fanOut<T>(tasks: readonly (() => Promise<T>)[], sequential: boolean): Promise<T[]> {
  if (!sequential) return await Promise.all(tasks.map(task => task()))
  const out: T[] = []
  for (const task of tasks) out.push(await task())
  return out
}

/**
 * Read one candidate's files back, capped, and render them for the prompt.
 * @param seam - seam reading the seat trees.
 * @param candidate - the candidate to render.
 * @param signal - cancellation from the run.
 * @returns the rendered candidate, or undefined when nothing could be read.
 */
async function renderOne(
  seam: FileSeam,
  candidate: Candidate,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const lines: string[] = [`### Candidate from ${candidate.seat}`, '']
  let budget = CANDIDATE_CHARS
  let shown = 0
  for (const file of candidate.files) {
    if (budget <= 0) break
    let text: string
    try {
      text = await seam.read(file.path, signal)
    } catch {
      // A candidate file that cannot be read back is reported as missing
      // rather than silently shrinking the candidate.
      lines.push(`#### ${file.label}`, '_could not be read back_', '')
      continue
    }
    const kept = text.length <= budget ? text : text.slice(0, budget)
    budget -= kept.length
    shown += 1
    lines.push(`#### ${file.label}`)
    if (kept.length < text.length) {
      lines.push(`_showing ${String(kept.length)} of ${String(text.length)} characters_`)
    }
    lines.push('```', kept, '```', '')
  }
  if (shown === 0) return undefined
  if (shown < candidate.files.length) {
    lines.push(`_${String(candidate.files.length - shown)} further file(s) not shown, for length._`, '')
  }
  return lines.join(NL)
}

/**
 * The prompt asking a seat to vote on which candidate is implemented.
 * @param task - what the seats were asked to implement.
 * @param rendered - each candidate, already rendered and capped.
 * @param ids - seat ids that may be voted for.
 * @returns the prompt.
 */
export function selectionPrompt(
  task: string,
  rendered: readonly string[],
  ids: readonly string[],
): string {
  return `Several models each wrote their own version of the same change. Exactly one version will be implemented. Vote for the best one.

Reply with EXACTLY this format, the vote line first:

VOTE: <one of: ${ids.join(', ')}>
CONFIDENCE: <number between 0 and 1>
CRITIQUE: <what is right and wrong with each version, including your own>

Judge on correctness first: does the code do what the task asked, and does it
break anything it touches. Then on whether it changed only what it needed to.
Then on clarity. A version that is elegant and wrong loses to one that is plain
and right.

You may vote for your own version if it is genuinely best. Where a candidate is
shown truncated, judge what you can see and say what you could not check.

THE TASK THEY WERE GIVEN:
${task}

CANDIDATES:
${rendered.join(`${NL}${NL}`)}`
}

/**
 * Run the vote that picks which candidate is implemented.
 * @param options - the candidates, the voters, and the transport settings.
 * @returns the winner, the votes, and a report.
 */
export async function runSelection(options: SelectionOptions): Promise<SelectionResult> {
  const empty: Verdict = {
    scores: new Map(),
    counts: new Map(),
    peerScores: new Map(),
    method: 'none',
    tied: false,
    missingVoters: [],
  }
  const usable: Candidate[] = []
  const rendered: string[] = []
  for (const candidate of options.candidates) {
    if (candidate.files.length === 0) continue
    const block = await renderOne(options.files, candidate, options.signal)
    if (block === undefined) continue
    usable.push(candidate)
    rendered.push(block)
  }

  if (usable.length === 0) {
    return {
      reviews: [],
      verdict: empty,
      report: [
        '## Selection — nothing to choose between',
        '',
        '> **!** No seat produced a readable candidate, so no code was selected and no vote was bought.',
      ].join(NL),
    }
  }

  // One candidate is not an election. Voting on it would spend a call per seat
  // to confirm the only option, so it is chosen outright and said to be.
  const sole = usable[0]
  if (usable.length === 1 && sole !== undefined) {
    return {
      winner: sole.seat,
      chosen: sole,
      reviews: [],
      verdict: { ...empty, method: 'sole-draft' },
      report: [
        '## Selection — one candidate',
        '',
        `Only **${sole.seat}** produced code, so it is the selection by default. No vote was bought.`,
        '',
        ...sole.files.map(file => `  - ${file.label}`),
      ].join(NL),
    }
  }

  const ids = usable.map(candidate => candidate.seat)
  const voters = options.seats.filter(seat => seat.enabled)
  const prompt = selectionPrompt(options.task, rendered, ids)
  const replies = await fanOut(
    voters.map(seat => async (): Promise<SeatReply> =>
      await askSeat(seat, prompt, options.apiKey, options.signal, options.timeoutMs, options.memory)),
    options.sequential === true,
  )

  const reviews: SeatReview[] = replies.map((reply) => {
    if (reply.error !== undefined || reply.text === '') {
      return {
        seat: reply.seat,
        confidence: 0,
        critique: '',
        error: reply.error ?? 'empty reply',
        ms: reply.ms,
      }
    }
    // Only seats that actually produced a candidate may be voted for, so a
    // vote for a seat that wrote nothing does not quietly become the winner.
    const eligible = options.seats.filter(seat => ids.includes(seat.id))
    const parsed = parseReview(reply.text, eligible)
    return {
      seat: reply.seat,
      ...parsed.vote === undefined ? {} : { vote: parsed.vote },
      confidence: parsed.confidence,
      critique: parsed.critique,
      ms: reply.ms,
    }
  })

  // `tally` scores against the set of drafts, which here are the candidates.
  const asDrafts: readonly SeatReply[] = usable.map(candidate => ({
    seat: candidate.seat,
    text: 'candidate',
    ms: 0,
  }))
  const verdict = tally(reviews, asDrafts)
  const chosen = usable.find(candidate => candidate.seat === verdict.winner)

  const lines: string[] = ['## Selection', '']
  if (verdict.winner === undefined) {
    lines.push('> **!** The vote did not settle on a version. Nothing is selected; choose one yourself, or run the round again.', '')
  } else {
    lines.push(`**Selected: ${verdict.winner}** (by ${verdict.method}${verdict.tied ? ', after a tie' : ''})`, '')
    for (const file of chosen?.files ?? []) lines.push(`  - ${file.label}`)
    lines.push('')
  }
  lines.push('### Votes', '')
  for (const review of reviews) {
    if (review.error !== undefined) {
      lines.push(`- **${review.seat}** — no vote (${review.error})`)
      continue
    }
    lines.push(`- **${review.seat}** voted ${review.vote ?? 'nobody'} at ${String(review.confidence)}`)
  }
  lines.push(
    '',
    '_Nothing has been written to the repositories. Implementing the selected version is a separate, deliberate step._',
  )

  return {
    ...verdict.winner === undefined ? {} : { winner: verdict.winner },
    ...chosen === undefined ? {} : { chosen },
    reviews,
    verdict,
    report: lines.join(NL),
  }
}
