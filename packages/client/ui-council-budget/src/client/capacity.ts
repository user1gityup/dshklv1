/**
 * Client-side capacity maths.
 *
 * Everything here runs in the browser from data the browser can already reach:
 * OpenRouter's public price table, the account balance, and the harness's own
 * per-session token projections. No host round-trip, so the panel answers
 * before any council call is made — which is the whole point of it.
 */

/** One seat's routing, as the panel understands it. */
export interface PanelSeat {
  readonly id: string
  readonly name: string
  /** `openrouter` seats are metered; `cli` seats bill a subscription. */
  readonly transport: 'openrouter' | 'cli'
  readonly model?: string | undefined
  readonly enabled: boolean
}

/**
 * Seats shipped by the council, mirrored here for display before any run.
 *
 * DUPLICATED from the host's DEFAULT_SEATS in `tool-council/src/seats.ts`,
 * which is the source of truth. The client and host faces do not share a
 * module, so this list is kept in step by hand — and a seat added there but
 * not here is simply invisible in every panel that reads it, with no error to
 * say so. That has already happened once. Change both, or neither.
 *
 * It lives in this module rather than in one panel because both the budget
 * panel and the swarm roster route off it: the workers a swarm may use ARE the
 * council's seats, so a third hand-kept copy would drift from this one the way
 * this one once drifted from the host.
 */
export const DEFAULT_SEATS: readonly PanelSeat[] = [
  { id: 'claude', name: 'Claude', transport: 'cli', enabled: true },
  // Free Claude ships disabled: it needs the local proxy running, and a seat
  // that fails on every run of a fresh install is worse than one switched on
  // deliberately.
  { id: 'free-claude', name: 'Free Claude', transport: 'cli', enabled: false },
  { id: 'openai', name: 'OpenAI', transport: 'cli', enabled: true },
  { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
  { id: 'deepseek', name: 'DeepSeek v4', transport: 'openrouter', model: 'deepseek/deepseek-v4-pro', enabled: true },
]

/**
 * Read the seat roster out of the stored settings section.
 *
 * Shipped seats with the user's per-seat overrides folded in, followed by any
 * extra OpenRouter seats they added. This is the whole set of agents the user
 * has configured, so it is also the whole set a swarm may draw workers from.
 * @param section - decoded council settings.
 * @returns every configured seat, shipped and added.
 */
export function seatsFrom(section: Record<string, unknown> | undefined): readonly PanelSeat[] {
  const overrides = (section?.['seats'] ?? {}) as Record<string, { enabled?: boolean; model?: string }>
  const extras = (section?.['extraSeats'] ?? {}) as Record<string, { name?: string; model?: string; enabled?: boolean }>
  const base = DEFAULT_SEATS.map(seat => ({
    ...seat,
    enabled: overrides[seat.id]?.enabled ?? seat.enabled,
    model: overrides[seat.id]?.model ?? seat.model,
  }))
  const added: PanelSeat[] = Object.entries(extras).map(([id, extra]) => ({
    id,
    name: extra.name ?? id,
    transport: 'openrouter' as const,
    model: extra.model,
    enabled: extra.enabled ?? true,
  }))
  return [...base, ...added]
}

/** Per-token prices for one model. */
export interface Price {
  readonly prompt: number
  readonly completion: number
}

/** What a subscription seat costs and how much it produces. */
export interface Subscription {
  /** Monthly price of one seat, in USD. */
  readonly usdPerSeat: number
  /** Output tokens one seat produces per month, measured from its own logs. */
  readonly tokensPerMonth?: number | undefined
}

/** Observed work drawn from the harness's own session rows. */
export interface Observed {
  /** Output tokens across the sessions counted. */
  readonly outputTokens: number
  /** Uncached prompt tokens across the same sessions. */
  readonly inputTokens: number
  /** Sessions contributing to the fold. */
  readonly sessions: number
}

/** What the current configuration buys. */
export interface Projection {
  /** Metered seats participating. */
  readonly meteredSeats: number
  /** Subscription seats participating. */
  readonly subscriptionSeats: number
  /** Blended USD per output token across the metered seats. */
  readonly blendedRate?: number | undefined
  /** Effective USD per output token for one subscription seat. */
  readonly subscriptionRate?: number | undefined
  /** Monthly outlay across every seat: OpenRouter budget plus subscriptions. */
  readonly monthlyOutlayUsd: number
  /** Estimated cost of one full council run at the observed unit size. */
  readonly costPerRun?: number | undefined
  /** Runs the monthly budget affords. */
  readonly runsPerMonth?: number | undefined
  /** Runs the remaining balance affords right now. */
  readonly runsRemaining?: number | undefined
  /** Output tokens in a typical unit of work. */
  readonly unitTokens: number
  /**
   * Output tokens per month the whole configuration can produce, across every
   * seat. This is the "how much power" figure.
   */
  readonly totalTokensPerMonth: number
  /** Output tokens per month a single subscription seat produces alone. */
  readonly soloTokensPerMonth?: number | undefined
  /** Council throughput as a multiple of working with one seat alone. */
  readonly powerMultiple?: number | undefined
  /** Distinct answers compared per query (seats × rounds). */
  readonly perspectivesPerQuery: number
  /**
   * Wall-clock multiple versus a single seat. Seats run concurrently, so a
   * council costs rounds, not seats — two rounds is roughly twice one answer,
   * not four times.
   */
  readonly latencyMultiple: number
  /** Why a figure is missing, when one is. */
  readonly caveats: readonly string[]
}

/** A full council spends a draft round and a review round. */
const ROUNDS = 2
/** Prompts are assumed this multiple of output. */
const PROMPT_RATIO = 3

/**
 * Project cost and capacity for the current seat configuration.
 * @param seats - the roster as configured.
 * @param pricing - OpenRouter price table.
 * @param observed - measured work from the harness's own sessions.
 * @param monthlyUsd - the monthly OpenRouter budget.
 * @param remainingUsd - credit remaining right now.
 * @returns the projection and its caveats.
 */
export function project(
  seats: readonly PanelSeat[],
  pricing: ReadonlyMap<string, Price>,
  observed: Observed,
  monthlyUsd: number,
  remainingUsd?: number | undefined,
  subscription?: Subscription | undefined,
): Projection {
  const caveats: string[] = []
  const active = seats.filter(seat => seat.enabled)
  const metered = active.filter(seat => seat.transport === 'openrouter')
  const subscriptionSeats = active.filter(seat => seat.transport === 'cli')

  const rates: number[] = []
  for (const seat of metered) {
    const price = seat.model === undefined ? undefined : pricing.get(seat.model)
    if (price === undefined) continue
    rates.push(price.completion + price.prompt * PROMPT_RATIO)
  }
  const blendedRate = rates.length === 0
    ? undefined
    : rates.reduce((sum, rate) => sum + rate, 0) / rates.length

  if (metered.length > 0 && rates.length < metered.length) {
    caveats.push('some metered seats are unpriced, so the estimate covers only the priced ones')
  }
  // A subscription's cost per token is its price divided by what it actually
  // produces — both of which are known, so these seats are priced, not excluded.
  const subTokens = subscription?.tokensPerMonth
  const subscriptionRate = subscription === undefined || subTokens === undefined || subTokens <= 0
    ? undefined
    : subscription.usdPerSeat / subTokens
  if (subscriptionSeats.length > 0 && subscriptionRate === undefined) {
    caveats.push('subscription seats are unpriced until their measured output is available')
  }

  // A "unit of work" is one typical assistant turn, sized from real sessions.
  const unitTokens = observed.sessions === 0 ? 0 : Math.round(observed.outputTokens / observed.sessions)
  if (observed.sessions === 0) caveats.push('no session history yet, so run size cannot be calibrated')

  // Every seat answers every round, so a run costs the metered seats plus the
  // subscription seats at their own effective rate.
  const meteredPerRun = blendedRate === undefined || unitTokens === 0
    ? 0
    : blendedRate * unitTokens * ROUNDS * rates.length
  const subscriptionPerRun = subscriptionRate === undefined || unitTokens === 0
    ? 0
    : subscriptionRate * unitTokens * ROUNDS * subscriptionSeats.length
  const total = meteredPerRun + subscriptionPerRun
  const costPerRun = total > 0 ? total : undefined
  const monthlyOutlayUsd = monthlyUsd + (subscription?.usdPerSeat ?? 0) * subscriptionSeats.length

  // ── how much power the configuration represents ──
  // Metered seats convert budget into tokens at their blended rate; each
  // subscription seat contributes whatever it measurably produces.
  const meteredTokensPerMonth = blendedRate === undefined || blendedRate <= 0
    ? 0
    : monthlyUsd / blendedRate
  const perSubscriptionTokens = subTokens ?? 0
  const subscriptionTokensPerMonth = perSubscriptionTokens * subscriptionSeats.length
  const totalTokensPerMonth = meteredTokensPerMonth + subscriptionTokensPerMonth
  // The baseline is one subscription seat working alone — what the user does now.
  const soloTokensPerMonth = perSubscriptionTokens > 0 ? perSubscriptionTokens : undefined
  const powerMultiple = soloTokensPerMonth === undefined || soloTokensPerMonth <= 0
    ? undefined
    : totalTokensPerMonth / soloTokensPerMonth
  const perspectivesPerQuery = active.length * ROUNDS
  // Seats are asked concurrently, so wall time tracks rounds, not seat count.
  const latencyMultiple = active.length === 0 ? 0 : ROUNDS

  return {
    meteredSeats: metered.length,
    subscriptionSeats: subscriptionSeats.length,
    blendedRate,
    subscriptionRate,
    monthlyOutlayUsd,
    costPerRun,
    // Runs affordable per month now measure against the WHOLE outlay, since
    // subscription seats are part of what a run consumes.
    runsPerMonth: costPerRun === undefined || costPerRun <= 0 ? undefined : monthlyOutlayUsd / costPerRun,
    runsRemaining: costPerRun === undefined || costPerRun <= 0 || remainingUsd === undefined
      ? undefined
      : remainingUsd / costPerRun,
    unitTokens,
    totalTokensPerMonth,
    soloTokensPerMonth,
    powerMultiple,
    perspectivesPerQuery,
    latencyMultiple,
    caveats,
  }
}

/** Format a USD amount at a sensible precision for its magnitude. */
export function usd(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1) return `$${value.toFixed(2)}`
  if (abs >= 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(5)}`
}
