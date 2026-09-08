/**
 * Durable record of a finished council run, so a degraded one can be amended
 * instead of re-run.
 *
 * A council round waits for every seat and keeps whatever comes back, so one
 * seat timing out does not lose the round — but until now it did lose that
 * seat's answer permanently. The only way to get a complete run was to ask the
 * whole council again: a second planning round, a second draft from every seat
 * that had already answered, and a second bill, all to recover the two that
 * failed. Measured 2026-09-07: a stage-2 run cost 12m29s and returned three
 * drafts of five, with both hosted seats cut off at the timeout.
 *
 * So a finished run is written here, and {@link amendRun} re-asks only the
 * seats that failed. Everything that answered the first time is kept exactly
 * as it was — including the votes, which is why the report has to say which
 * reviews were cast before a recovered draft existed rather than quietly
 * presenting them as judgements on the full field.
 *
 * Records live in `$HOME/.dsh/council-runs`, not in settings: a draft is
 * thousands of words, and settings is read whole on every tool invocation.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SeatId } from './colors.ts'
import type { SeatReview } from './council.ts'
import type { SeatReply } from './seats.ts'

/** How many finished runs are kept before the oldest are pruned. */
export const RUN_HISTORY = 20

/** How many times one run may be amended, so a loop cannot spend forever. */
export const MAX_AMENDMENTS = 3

/** A finished run, with everything an amendment needs to fill its holes. */
export interface RunRecord {
  readonly id: string
  /** The question the run answered — the amendment asks the same one. */
  readonly query: string
  /** Epoch ms the run finished. */
  readonly at: number
  /** The agreed plan, so a recovered draft is written to the same direction. */
  readonly plan?: string | undefined
  /** The shared evidence block as the first drafts saw it. */
  readonly evidenceBlock?: string | undefined
  readonly evidenceUrls?: readonly string[] | undefined
  /** Seats the run was configured with, by id. */
  readonly seatIds: readonly SeatId[]
  readonly drafts: readonly SeatReply[]
  readonly reviews: readonly SeatReview[]
  /** Amendments already spent on this run. */
  readonly amendments: number
}

/** Where run records live. */
export function runsDirectory(): string {
  return join(homedir(), '.dsh', 'council-runs')
}

/** A fresh run id. */
export function newRunId(): string {
  return randomUUID()
}

/**
 * Which seats came back empty, per round.
 * @param record - the run to inspect.
 * @returns the seats worth asking again.
 */
export function failedSeats(record: RunRecord): { readonly drafts: readonly SeatId[]; readonly reviews: readonly SeatId[] } {
  return {
    drafts: record.drafts.filter(draft => draft.error !== undefined || draft.text === '').map(draft => draft.seat),
    // A review with no vote is not a failure: a seat may decline to name one.
    // Only an errored review is a hole worth paying to fill.
    reviews: record.reviews.filter(review => review.error !== undefined).map(review => review.seat),
  }
}

/** Whether a run has any hole an amendment could fill. */
export function isAmendable(record: RunRecord): boolean {
  if (record.amendments >= MAX_AMENDMENTS) return false
  const holes = failedSeats(record)
  return holes.drafts.length > 0 || holes.reviews.length > 0
}

/**
 * Write a run record, pruning the oldest once the history is full.
 *
 * Never throws: a run that answered must not fail at the last step because its
 * record could not be filed. The caller learns from the returned path whether
 * amending is available.
 * @param record - the finished run.
 * @returns the file written, or undefined when the write failed.
 */
export function saveRun(record: RunRecord): string | undefined {
  const directory = runsDirectory()
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${record.id}.json`)
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
    prune(directory)
    return path
  } catch {
    return undefined
  }
}

/** Drop the oldest records past {@link RUN_HISTORY}. */
function prune(directory: string): void {
  let entries: readonly { name: string; at: number }[]
  try {
    entries = readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .map((name) => {
        let at = 0
        try {
          at = statSync(join(directory, name)).mtimeMs
        } catch {
          at = 0
        }
        return { name, at }
      })
      .sort((left, right) => right.at - left.at)
  } catch {
    return
  }
  for (const entry of entries.slice(RUN_HISTORY)) {
    try {
      rmSync(join(directory, entry.name), { force: true })
    } catch {
      // A record that cannot be pruned is not worth failing a run over.
    }
  }
}

/** Read and validate one record. */
function readRecord(path: string): RunRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Partial<RunRecord>
  if (typeof record.id !== 'string' || typeof record.query !== 'string') return undefined
  if (!Array.isArray(record.drafts) || !Array.isArray(record.reviews)) return undefined
  return {
    id: record.id,
    query: record.query,
    at: typeof record.at === 'number' ? record.at : 0,
    ...record.plan === undefined ? {} : { plan: record.plan },
    ...record.evidenceBlock === undefined ? {} : { evidenceBlock: record.evidenceBlock },
    ...record.evidenceUrls === undefined ? {} : { evidenceUrls: record.evidenceUrls },
    seatIds: Array.isArray(record.seatIds) ? record.seatIds : [],
    drafts: record.drafts,
    reviews: record.reviews,
    amendments: typeof record.amendments === 'number' ? record.amendments : 0,
  }
}

/**
 * Load one run by id.
 * @param id - the run id, as the report printed it.
 * @returns the record, or undefined when it is unknown or unreadable.
 */
export function loadRun(id: string): RunRecord | undefined {
  // Ids come from a report the model reproduces, so a mistyped one must not
  // reach the filesystem as a path.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return undefined
  return readRecord(join(runsDirectory(), `${id}.json`))
}

/**
 * The most recent run, for a user who says "try that again" without an id.
 * @returns the newest record, or undefined when none is stored.
 */
export function latestRun(): RunRecord | undefined {
  let names: readonly string[]
  try {
    names = readdirSync(runsDirectory()).filter(name => name.endsWith('.json'))
  } catch {
    return undefined
  }
  let newest: RunRecord | undefined
  let newestAt = -1
  for (const name of names) {
    const record = readRecord(join(runsDirectory(), name))
    if (record === undefined || record.at <= newestAt) continue
    newest = record
    newestAt = record.at
  }
  return newest
}
