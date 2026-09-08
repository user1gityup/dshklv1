/**
 * Capacity projection: what a given monthly configuration actually buys.
 *
 * Answers the question a budget cannot: not "am I over" but "how much work
 * does this money represent". Calibrated against the user's real measured
 * usage rather than a guess, so the answer is grounded in work already done.
 *
 * Everything here is an estimate and says so. Subscription seats have no
 * observable per-unit cost, so their contribution is counted in throughput,
 * never in dollars.
 */

import type { ModelPrice } from './estimate.ts'
import type { SeatConfig } from './seats.ts'

/** One month's configured spending power. */
export interface Configuration {
  /** OpenRouter credit budgeted per month. */
  readonly openRouterUsd: number
  /** Subscription seats available, e.g. one Claude and one Codex. */
  readonly subscriptionSeats: number
  /**
   * Output tokens one subscription seat can produce per month before its own
   * limits bite. Unknown unless the user supplies it, because no CLI exposes it.
   */
  readonly subscriptionTokensPerMonth?: number | undefined
}

/** Observed work, used to calibrate the projection. */
export interface ObservedWork {
  /** Output tokens produced over the observation window. */
  readonly outputTokens: number
  /** Length of that window, in days. */
  readonly days: number
  /** Assistant messages produced, used to size a typical unit of work. */
  readonly messages: number
}

/** What the configuration buys. */
export interface Capacity {
  /** Output tokens per month the hosted seats can afford. */
  readonly hostedTokensPerMonth: number
  /** Output tokens per month the subscription seats contribute, when known. */
  readonly subscriptionTokensPerMonth?: number | undefined
  /** Combined monthly output-token ceiling. */
  readonly totalTokensPerMonth: number
  /** Observed usage scaled to a month, for comparison. */
  readonly observedTokensPerMonth: number
  /** Multiple of current throughput this configuration represents. */
  readonly multiple: number
  /** Full council runs affordable per month at the observed size. */
  readonly councilRunsPerMonth: number
  /** Mean output tokens per assistant message in the observed window. */
  readonly tokensPerMessage: number
  /** Caveats the reader must weigh before trusting the figure. */
  readonly caveats: readonly string[]
}

/** Assume prompts run this multiple of output, matching the estimator. */
const PROMPT_RATIO = 3
/** A full council spends a draft round and a review round. */
const ROUNDS = 2
/** Days used to normalise a month. */
const DAYS_PER_MONTH = 30

/**
 * Mean blended price per output token across the hosted seats.
 * @param seats - the roster.
 * @param pricing - OpenRouter price table.
 * @returns blended USD per output token, or undefined when nothing is priced.
 */
function blendedRate(
  seats: readonly SeatConfig[],
  pricing: ReadonlyMap<string, ModelPrice>,
): number | undefined {
  const rates: number[] = []
  for (const seat of seats) {
    if (!seat.enabled || seat.transport !== 'openrouter' || seat.free === true || seat.model === undefined) continue
    const price = pricing.get(seat.model)
    if (price === undefined) continue
    // One output token also drags PROMPT_RATIO input tokens along with it.
    rates.push(price.completion + price.prompt * PROMPT_RATIO)
  }
  if (rates.length === 0) return undefined
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length
}

/**
 * Project what a configuration buys, calibrated against observed work.
 * @param config - the monthly budget and seat count.
 * @param seats - the council roster.
 * @param pricing - OpenRouter price table.
 * @param observed - measured usage to calibrate against.
 * @returns the projection and its caveats.
 */
export function projectCapacity(
  config: Configuration,
  seats: readonly SeatConfig[],
  pricing: ReadonlyMap<string, ModelPrice>,
  observed: ObservedWork,
): Capacity {
  const caveats: string[] = []
  const rate = blendedRate(seats, pricing)
  // Free seats consume none of the OpenRouter budget, so counting them here
  // would divide the budget across seats that never draw on it and understate
  // what it buys.
  const hostedSeats = seats.filter(seat => seat.enabled && seat.transport === 'openrouter' && seat.free !== true).length

  let hostedTokensPerMonth = 0
  if (rate === undefined || rate <= 0) {
    caveats.push('no hosted seat could be priced, so the OpenRouter budget could not be converted into tokens')
  } else {
    // Every hosted seat answers every round, so one "unit" of council output
    // costs the blended rate times the seats times the rounds.
    const perUnit = rate * Math.max(1, hostedSeats) * ROUNDS
    hostedTokensPerMonth = config.openRouterUsd / perUnit
  }

  const subscription = config.subscriptionTokensPerMonth
  if (subscription === undefined && config.subscriptionSeats > 0) {
    caveats.push(
      `${String(config.subscriptionSeats)} subscription seat(s) are excluded from the token total: neither Claude Code nor Codex reports a quota, so their capacity cannot be measured here`,
    )
  }
  const subscriptionTokens = subscription === undefined
    ? undefined
    : subscription * config.subscriptionSeats

  const totalTokensPerMonth = hostedTokensPerMonth + (subscriptionTokens ?? 0)
  const observedTokensPerMonth = observed.days <= 0
    ? 0
    : (observed.outputTokens / observed.days) * DAYS_PER_MONTH
  const multiple = observedTokensPerMonth <= 0 ? 0 : totalTokensPerMonth / observedTokensPerMonth
  const tokensPerMessage = observed.messages <= 0 ? 0 : observed.outputTokens / observed.messages

  // A council run is sized from a typical unit of the user's own work.
  const perRunTokens = tokensPerMessage * Math.max(1, hostedSeats) * ROUNDS
  const councilRunsPerMonth = perRunTokens <= 0 || rate === undefined
    ? 0
    : config.openRouterUsd / (perRunTokens * rate)

  caveats.push('prompt size is assumed at 3x output; a cache-heavy workload costs far less than this suggests')
  if (observed.days < 3) {
    caveats.push('the observation window is short, so scaling it to a month is unreliable')
  }

  return {
    hostedTokensPerMonth,
    subscriptionTokensPerMonth: subscriptionTokens,
    totalTokensPerMonth,
    observedTokensPerMonth,
    multiple,
    councilRunsPerMonth,
    tokensPerMessage,
    caveats,
  }
}

/**
 * Render a capacity projection for the console.
 * @param capacity - the projection.
 * @param config - the configuration it was computed for.
 * @returns lines ready to print.
 */
export function renderCapacity(capacity: Capacity, config: Configuration): readonly string[] {
  const round = (value: number): string => Math.round(value).toLocaleString()
  const out: string[] = [
    'CAPACITY — a projection, not a guarantee',
    '',
    `  Configuration: $${config.openRouterUsd.toFixed(2)}/mo OpenRouter + ${String(config.subscriptionSeats)} subscription seat(s)`,
    `  Hosted seats afford:   ~${round(capacity.hostedTokensPerMonth)} output tokens/month`,
  ]
  if (capacity.subscriptionTokensPerMonth !== undefined) {
    out.push(`  Subscription seats add: ~${round(capacity.subscriptionTokensPerMonth)} output tokens/month`)
  }
  out.push(
    `  Combined ceiling:      ~${round(capacity.totalTokensPerMonth)} output tokens/month`,
    '',
    `  You currently produce: ~${round(capacity.observedTokensPerMonth)} output tokens/month`,
    `  That is ${capacity.multiple.toFixed(2)}x your present throughput`,
    `  Affordable full council runs: ~${round(capacity.councilRunsPerMonth)}/month at ${round(capacity.tokensPerMessage)} tokens per unit of work`,
    '',
  )
  for (const caveat of capacity.caveats) out.push(`  ! ${caveat}`)
  return out
}
