/**
 * Cost-ordered search routing.
 *
 * The web seam picks exactly one provider: it refuses to choose when several
 * are usable, and hard-fails when a configured one is unavailable. Neither
 * behaviour gives fallback, so routing has to happen inside a single registered
 * provider. This is that provider.
 *
 * The order is by what a search actually costs the user, not by quality:
 *
 *   1. included   — a subscription already paid for; a search adds nothing
 *   2. metered    — billed per query against a balance that can run dry
 *   3. unavailable— no credential, or a balance at zero
 *
 * A route that throws is demoted for a cooldown and the next one runs, so one
 * empty account cannot take web search down while another route has credit.
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

/** What a route costs the user per search. */
export type CostClass = 'included' | 'metered'

/** One candidate route. */
export interface Route {
  /** Stable name, used in diagnostics and the cooldown table. */
  readonly name: string
  /** What using it costs. */
  readonly cost: CostClass
  /** The provider that performs the search. */
  readonly provider: WebSearchProvider
  /**
   * Optional balance probe, in USD. Returning 0 marks the route unusable
   * without spending a request to discover that. Undefined means unknown,
   * which is treated as usable — a probe failure must not disable a route.
   */
  readonly balanceUsd?: (() => Promise<number | undefined>) | undefined
}

/** How long a failing route stays demoted. */
const COOLDOWN_MS = 5 * 60_000

/** A route's recent failure, if any. */
interface Failure {
  readonly at: number
  readonly reason: string
}

/** One attempt's outcome, for reporting. */
export interface RouteAttempt {
  readonly name: string
  readonly cost: CostClass
  readonly ok: boolean
  readonly reason?: string | undefined
}

/**
 * Order routes by cost, then by declaration order within a class.
 * @param routes - the configured routes.
 * @returns routes sorted cheapest-first.
 */
export function byCost(routes: readonly Route[]): readonly Route[] {
  const rank: Record<CostClass, number> = { included: 0, metered: 1 }
  return [...routes].sort((a, b) => rank[a.cost] - rank[b.cost])
}

/** Search that tries each route in cost order until one answers. */
export class RoutingSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly routes: readonly Route[]
  private readonly failures = new Map<string, Failure>()
  /** Attempts from the most recent search, exposed for diagnostics. */
  lastAttempts: readonly RouteAttempt[] = []

  constructor(id: string, routes: readonly Route[]) {
    this.id = id
    this.routes = byCost(routes)
  }

  /**
   * Whether any route could run. Local only — the seam calls this per search.
   * @returns true when at least one route reports itself available.
   */
  available(): boolean {
    return this.routes.some(route => route.provider.available())
  }

  /** Whether a route is currently demoted after a failure. */
  private cooling(name: string, now: number): string | undefined {
    const failure = this.failures.get(name)
    if (failure === undefined) return undefined
    if (now - failure.at >= COOLDOWN_MS) {
      this.failures.delete(name)
      return undefined
    }
    return failure.reason
  }

  /**
   * Search through the cheapest route that works.
   * @param request - the query and result bound.
   * @param signal - cancellation from the tool execution.
   * @returns the first successful route's result.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const now = Date.now()
    const attempts: RouteAttempt[] = []

    for (const route of this.routes) {
      if (!route.provider.available()) {
        attempts.push({ name: route.name, cost: route.cost, ok: false, reason: 'no credential' })
        continue
      }
      const cooling = this.cooling(route.name, now)
      if (cooling !== undefined) {
        attempts.push({ name: route.name, cost: route.cost, ok: false, reason: `cooling down: ${cooling}` })
        continue
      }
      // A zero balance is knowable before spending a request, so check it
      // rather than discovering it through a failed search.
      if (route.balanceUsd !== undefined) {
        const balance = await route.balanceUsd().catch(() => undefined)
        if (balance !== undefined && balance <= 0) {
          attempts.push({ name: route.name, cost: route.cost, ok: false, reason: 'balance is zero' })
          continue
        }
      }
      try {
        const result = await route.provider.search(request, signal)
        attempts.push({ name: route.name, cost: route.cost, ok: true })
        this.lastAttempts = attempts
        return result
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // An abort is the caller's decision, not a route fault; do not demote.
        if (signal?.aborted === true) throw error
        this.failures.set(route.name, { at: Date.now(), reason })
        attempts.push({ name: route.name, cost: route.cost, ok: false, reason })
      }
    }

    this.lastAttempts = attempts
    const detail = attempts.map(a => `${a.name} (${a.cost}): ${a.reason ?? 'failed'}`).join('; ')
    throw new Error(`web search: every route failed — ${detail}`)
  }
}
