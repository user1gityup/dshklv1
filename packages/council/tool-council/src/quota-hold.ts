/**
 * Recognising "the quota is spent" and turning it into a time to come back.
 *
 * A seat that runs out of subscription quota is not a broken seat and its unit
 * is not a failed unit: the work is fine, the allowance is not. Treating that
 * as a failure loses the run — the graph, the approval that paid for it, and
 * the units already done — and the user then pays a second planning call to
 * get back to where they were. So exhaustion is detected here and reported as
 * a HOLD with a time, and the caller keeps its state untouched until then.
 *
 * The wording comes from two different places and neither is structured. The
 * Claude Code CLI prints prose at a person ("usage limit reached · resets 3pm
 * (America/Los_Angeles)"); OpenRouter answers HTTP 429, sometimes with a
 * `Retry-After` or an epoch in the body. Both are matched loosely on purpose:
 * a missed match costs a lost run, while a false positive only costs a wait
 * the user can end by pressing the button again.
 */

/** How long to wait when exhaustion is certain but the reset time is not. */
export const DEFAULT_HOLD_MS = 30 * 60 * 1000

/** Never hold longer than this on a parsed time; a bad parse must not park a run for a day. */
export const MAX_HOLD_MS = 8 * 60 * 60 * 1000

/** A run parked because an allowance ran out, and when it is worth trying again. */
export interface QuotaHold {
  /** The seat whose allowance ran out, when one error can be attributed. */
  readonly seat?: string | undefined
  /** The wording that was matched, trimmed for the report. */
  readonly detail: string
  /** Epoch ms to resume at. */
  readonly resumeAt: number
  /** How the time was arrived at, so a report can say "resets 3pm" or "in 30 minutes". */
  readonly source: 'stated' | 'default'
}

/** Errors that mean "no allowance left", not "this call was wrong". */
const EXHAUSTED = [
  /usage limit reached/i,
  /rate limit(?:ed)?/i,
  /\bquota\b[^.]*\b(exceeded|exhausted|reached|remaining)\b/i,
  /out of (?:credits|quota)/i,
  /\bHTTP 429\b/,
  /too many requests/i,
  /insufficient (?:credits|balance)/i,
]

/** Errors that look similar but are the user's own configuration, not an allowance. */
const NOT_EXHAUSTED = [
  /no OpenRouter API key/i,
  /no command configured/i,
  /no model configured/i,
  /\bHTTP 401\b/,
  /\bHTTP 403\b/,
]

/**
 * Read a wall-clock reset time out of the CLI's prose.
 *
 * The CLI states the reset in the user's own timezone with no date, so "3pm"
 * means the next 3pm — today if it has not passed, tomorrow if it has. Taking
 * it as today unconditionally would produce a time in the past and resume
 * immediately into the same wall.
 * @param text - the error wording.
 * @param now - epoch ms to resolve relative wording against.
 * @returns epoch ms, or undefined when no time is stated.
 */
function statedClockTime(text: string, now: number): number | undefined {
  const match = /reset[s]?(?:\s*at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (match?.[1] === undefined) return undefined
  const hour12 = Number(match[1])
  if (!Number.isFinite(hour12) || hour12 > 23) return undefined
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (minute > 59) return undefined

  const meridiem = match[3]?.toLowerCase()
  let hour = hour12
  if (meridiem === 'pm' && hour12 < 12) hour = hour12 + 12
  if (meridiem === 'am' && hour12 === 12) hour = 0

  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  let when = at.getTime()
  // A stated time that has already passed is tomorrow's, not this morning's.
  if (when <= now) when += 24 * 60 * 60 * 1000
  return when
}

/**
 * Read a duration out of "try again in 45 minutes" / "retry after 60 seconds".
 * @param text - the error wording.
 * @param now - epoch ms to add to.
 * @returns epoch ms, or undefined when no duration is stated.
 */
function statedDuration(text: string, now: number): number | undefined {
  const match = /(?:try again|retry(?:\s*after)?|resets?)\s*(?:in\s*)?(\d{1,4})\s*(second|minute|hour)s?/i.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = match[2].toLowerCase()
  const ms = unit === 'second' ? 1_000 : unit === 'minute' ? 60_000 : 3_600_000
  return now + amount * ms
}

/**
 * Decide whether one error means the allowance is spent.
 * @param error - the seat's error text.
 * @returns true when this is exhaustion rather than a fault.
 */
export function isQuotaExhausted(error: string): boolean {
  if (NOT_EXHAUSTED.some(pattern => pattern.test(error))) return false
  return EXHAUSTED.some(pattern => pattern.test(error))
}

/**
 * Turn seat failures into a hold, when they are about allowance.
 *
 * Only the first exhaustion is described: a wave of five units against one
 * spent subscription produces five identical errors, and a report listing all
 * five says nothing the first does not.
 * @param failures - seat id and error text for each failed call.
 * @param now - epoch ms, injectable for tests.
 * @returns the hold, or undefined when nothing here is about allowance.
 */
export function detectQuotaHold(
  failures: readonly { readonly seat?: string | undefined; readonly error: string }[],
  now: number = Date.now(),
): QuotaHold | undefined {
  const hit = failures.find(failure => isQuotaExhausted(failure.error))
  if (hit === undefined) return undefined

  const stated = statedDuration(hit.error, now) ?? statedClockTime(hit.error, now)
  const bounded = stated === undefined || stated > now + MAX_HOLD_MS
    ? now + DEFAULT_HOLD_MS
    : stated
  return {
    ...(hit.seat === undefined ? {} : { seat: hit.seat }),
    detail: hit.error.trim().slice(0, 200),
    resumeAt: bounded,
    source: stated === undefined || stated > now + MAX_HOLD_MS ? 'default' : 'stated',
  }
}

/**
 * Whether a held run may go again.
 *
 * The reading is consulted only to release a hold EARLY: a fresh reading with
 * headroom means the window already rolled over, which is common when the hold
 * time was the 30-minute default rather than a stated one. It can never extend
 * a hold, because a stale cache file must not keep a run parked.
 * @param resumeAt - epoch ms the hold was set to end at.
 * @param now - epoch ms.
 * @param sessionPercent - latest known session usage, when a reading exists.
 * @returns true when the run should proceed.
 */
export function holdElapsed(
  resumeAt: number,
  now: number = Date.now(),
  sessionPercent?: number,
): boolean {
  if (now >= resumeAt) return true
  return sessionPercent !== undefined && sessionPercent < 90
}

/**
 * How long is left, worded for a report.
 * @param resumeAt - epoch ms the hold ends at.
 * @param now - epoch ms.
 * @returns e.g. "in 12 minutes", or "now".
 */
export function holdRemaining(resumeAt: number, now: number = Date.now()): string {
  const left = resumeAt - now
  if (left <= 0) return 'now'
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `in ${String(minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? `in ${String(hours)} hour${hours === 1 ? '' : 's'}`
    : `in ${String(hours)}h ${String(rest)}m`
}
