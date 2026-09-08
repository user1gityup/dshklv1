/**
 * Search routing across lanes.
 *
 * The web seam picks exactly one provider: it refuses to choose when several
 * are usable, and hard-fails when a configured one is unavailable. Neither
 * behaviour gives fallback, so routing has to happen inside a single registered
 * provider. This is that provider.
 *
 * Cost still leads:
 *
 *   1. included   — a subscription already paid for; a search adds nothing
 *   2. metered    — billed per query against a balance that can run dry
 *
 * Within a cost class the order comes from {@link TrafficDirector}, so two
 * concurrent searches over two idle CLI lanes go one each instead of queueing
 * behind the same binary. A lane that throws is demoted for a cooldown and the
 * next one runs, so one empty account cannot take web search down while
 * another lane has credit.
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { TrafficDirector } from './traffic.ts'
import type { CostClass, Lane, TrafficPolicy } from './traffic.ts'

export { TrafficDirector, TRAFFIC_POLICIES, readPolicy, COOLDOWN_MS } from './traffic.ts'
export type { CostClass, Lane, LaneBlock, LaneStats, TrafficPolicy } from './traffic.ts'

/**
 * One candidate route.
 *
 * Kept as the package's outward name for a lane; `Lane` is the same shape.
 */
export type Route = Lane<WebSearchProvider>

/** One attempt's outcome, for reporting. */
export interface RouteAttempt {
  readonly name: string
  readonly cost: CostClass
  readonly ok: boolean
  readonly reason?: string | undefined
  /** Wall time the attempt took, when it ran at all. */
  readonly ms?: number | undefined
}

/**
 * Order routes by cost, then by declaration order within a class.
 *
 * The static ordering, unaware of load. Retained because it is the ordering a
 * `cheapest` run gets, and because it is the one thing about routing that can
 * be asserted without a director.
 * @param routes - the configured routes.
 * @returns routes sorted cheapest-first.
 */
export function byCost(routes: readonly Route[]): readonly Route[] {
  const rank: Record<CostClass, number> = { included: 0, metered: 1 }
  return [...routes].sort((a, b) => rank[a.cost] - rank[b.cost])
}

/** Search that spreads across lanes, cheapest class first. */
export class RoutingSearchProvider implements WebSearchProvider {
  readonly id: string
  /** The traffic director, exposed so a host can read lane statistics. */
  readonly traffic: TrafficDirector<WebSearchProvider>
  /** Attempts from the most recent search, exposed for diagnostics. */
  lastAttempts: readonly RouteAttempt[] = []

  constructor(id: string, routes: readonly Route[], policy: TrafficPolicy = 'balanced') {
    this.id = id
    this.traffic = new TrafficDirector<WebSearchProvider>(routes, policy)
  }

  /** Every configured route, cheapest class first. */
  get routes(): readonly Route[] {
    return byCost(this.traffic.all)
  }

  /**
   * Whether any route could run. Local only — the seam calls this per search.
   * @returns true when at least one route reports itself available.
   */
  available(): boolean {
    return this.traffic.all.some(route => route.provider.available())
  }

  /**
   * Search through the lane the director picks, falling through on failure.
   * @param request - the query and result bound.
   * @param signal - cancellation from the tool execution.
   * @returns the first successful lane's result.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const now = Date.now()
    // Blocked lanes are reported but never tried, so a caller reading
    // lastAttempts still sees why a lane sat out.
    const attempts: RouteAttempt[] = this.traffic.blocked(now)
      .map(entry => ({ name: entry.name, cost: entry.cost, ok: false, reason: entry.reason }))

    for (const route of this.traffic.order(now)) {
      // A zero balance is knowable before spending a request, so check it
      // rather than discovering it through a failed search.
      if (route.balanceUsd !== undefined) {
        const balance = await route.balanceUsd().catch(() => undefined)
        if (balance !== undefined && balance <= 0) {
          attempts.push({ name: route.name, cost: route.cost, ok: false, reason: 'balance is zero' })
          continue
        }
      }
      const started = Date.now()
      this.traffic.begin(route.name)
      try {
        const result = await route.provider.search(request, signal)
        const ms = Date.now() - started
        this.traffic.settle(route.name, true, ms)
        attempts.push({ name: route.name, cost: route.cost, ok: true, ms })
        this.lastAttempts = attempts
        return result
      } catch (error) {
        const ms = Date.now() - started
        const reason = error instanceof Error ? error.message : String(error)
        // An abort is the caller's decision, not a lane fault; do not demote.
        if (signal?.aborted === true) {
          this.traffic.settle(route.name, true, ms)
          throw error
        }
        this.traffic.settle(route.name, false, ms, reason)
        attempts.push({ name: route.name, cost: route.cost, ok: false, reason, ms })
      }
    }

    this.lastAttempts = attempts
    const detail = attempts.map(a => `${a.name} (${a.cost}): ${a.reason ?? 'failed'}`).join('; ')
    throw new Error(`web search: every route failed — ${detail}`)
  }
}
