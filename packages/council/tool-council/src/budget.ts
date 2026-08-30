/**
 * Pre-flight budget guard.
 *
 * Checking the live balance before spending beats reconstructing spend
 * afterwards: the provider's own number is authoritative, needs no token
 * arithmetic, and is available before any expensive call is made. The same
 * endpoint read twice also yields the exact cost of a run as a delta.
 */

/** OpenRouter credits endpoint. */
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits'

/** A point-in-time reading of the OpenRouter account. */
export interface Balance {
  /** Credits purchased to date, in USD. */
  readonly purchased: number
  /** Credits consumed to date, in USD. */
  readonly used: number
  /** Purchased minus used. */
  readonly remaining: number
}

/** What the guard decided, and why. */
export interface BudgetDecision {
  /** Whether the run may proceed. */
  readonly allowed: boolean
  /** Human-readable reason, always populated. */
  readonly reason: string
  /** The reading the decision was made from, when one could be taken. */
  readonly balance?: Balance | undefined
  /** Projected spend for the current month at the observed rate. */
  readonly projectedMonthlyUsd?: number | undefined
  /** True when spend is on track to exceed the monthly target. */
  readonly overPace: boolean
}

/** Budget limits the guard enforces. */
export interface BudgetLimits {
  /** Refuse to start a run when remaining credit is below this. */
  readonly minBalanceUsd?: number | undefined
  /** Monthly spend target used for the pace warning. */
  readonly monthlyUsd?: number | undefined
  /** Day of month used for pace maths; defaults to today. */
  readonly dayOfMonth?: number | undefined
  /** Days in the current month; defaults to the real value. */
  readonly daysInMonth?: number | undefined
}

/**
 * Read the current OpenRouter balance.
 * @param apiKey - an inference key; `/credits` accepts one.
 * @param signal - abort signal from the tool execution.
 * @returns the reading, or `undefined` when it could not be taken.
 */
export async function readBalance(
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<Balance | undefined> {
  if (apiKey === undefined || apiKey === '') return undefined
  try {
    const response = await fetch(CREDITS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } }
    const purchased = body.data?.total_credits
    const used = body.data?.total_usage
    if (typeof purchased !== 'number' || typeof used !== 'number') return undefined
    return { purchased, used, remaining: purchased - used }
  } catch {
    return undefined
  }
}

/**
 * Decide whether a run may proceed against the current balance.
 *
 * An unreadable balance allows the run: a monitoring failure must not become
 * an outage. The pace warning is advisory and never blocks, because month-to-date
 * usage includes spend from outside the council.
 * @param balance - the current reading, or undefined when unavailable.
 * @param limits - configured thresholds.
 * @returns the decision and its reasoning.
 */
export function judgeBudget(balance: Balance | undefined, limits: BudgetLimits = {}): BudgetDecision {
  if (balance === undefined) {
    return { allowed: true, reason: 'balance unavailable; proceeding without a budget check', overPace: false }
  }
  const minBalance = limits.minBalanceUsd ?? 0
  if (balance.remaining < minBalance) {
    return {
      allowed: false,
      reason: `remaining credit $${balance.remaining.toFixed(2)} is below the $${minBalance.toFixed(2)} floor; run refused`,
      balance,
      overPace: false,
    }
  }

  const monthly = limits.monthlyUsd
  if (monthly === undefined || monthly <= 0) {
    return { allowed: true, reason: `remaining credit $${balance.remaining.toFixed(2)}`, balance, overPace: false }
  }
  const now = new Date()
  const day = limits.dayOfMonth ?? now.getUTCDate()
  const days = limits.daysInMonth
    ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  // `used` is lifetime, not month-to-date, so pace is only meaningful once the
  // caller resets or tops up monthly. Treating it as month-to-date is the
  // documented approximation; it errs toward warning early, never late.
  const projected = day <= 0 ? balance.used : (balance.used / day) * days
  const overPace = projected > monthly
  return {
    allowed: true,
    reason: overPace
      ? `spending pace projects $${projected.toFixed(2)} this month against a $${monthly.toFixed(2)} target`
      : `remaining credit $${balance.remaining.toFixed(2)}; pace projects $${projected.toFixed(2)} of $${monthly.toFixed(2)}`,
    balance,
    projectedMonthlyUsd: projected,
    overPace,
  }
}

/**
 * Cost of a run, as the difference between two readings.
 * @param before - reading taken before the run.
 * @param after - reading taken after the run.
 * @returns the spend in USD, or undefined when either reading is missing.
 */
export function spendBetween(before: Balance | undefined, after: Balance | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined
  const delta = after.used - before.used
  // A negative delta means a top-up landed mid-run; report nothing rather than
  // a nonsense negative cost.
  return delta >= 0 ? delta : undefined
}
