/**
 * Traffic flow across the search lanes.
 *
 * One council round asks for up to eight lookups. Sent down a single lane they
 * run one after another, and the round is as slow as their sum — measured at
 * roughly 15-25s per `claude -p` search, so eight of them is two to three
 * minutes of a council doing nothing else. Two authenticated CLIs are sitting
 * there idle while that happens.
 *
 * This module decides which lane each search takes. It never queues and never
 * blocks: every call gets an ordered list of lanes it may use, best first, and
 * the caller walks that list until one answers. Spreading rather than queueing
 * is deliberate — a blocking pool turns one wedged CLI into a stalled round,
 * while an ordering can be wrong at worst and still finish.
 *
 * Three policies, because the right answer differs by run:
 *
 *   - `balanced`  — least-loaded lane wins. The default: with two lanes and
 *                   eight queries it halves the round's wall time, and it
 *                   degrades to a single lane cleanly when only one is usable.
 *   - `cheapest`  — strict cost order, the older behaviour. One lane carries
 *                   everything until it fails. Slowest, and the most
 *                   predictable about what gets billed.
 *   - `fastest`   — order by measured latency. Useful once a lane has history;
 *                   before that it behaves like `balanced`.
 *
 * Cost class always outranks the policy. A metered route is never preferred
 * over an idle subscription route just because it is quicker — the budget this
 * runs inside is the reason the CLI lanes exist at all.
 */

/** What a lane costs the user per search. */
export type CostClass = 'included' | 'metered'

/** How the director spreads work across lanes of the same cost class. */
export type TrafficPolicy = 'balanced' | 'cheapest' | 'fastest'

/** Every policy name, for schema validation and the settings UI. */
export const TRAFFIC_POLICIES: readonly TrafficPolicy[] = ['balanced', 'cheapest', 'fastest']

/** The subset of a search provider the director needs. */
export interface LaneProvider {
  available(): boolean
}

/** One candidate lane. */
export interface Lane<P extends LaneProvider = LaneProvider> {
  /** Stable name, used in diagnostics and the cooldown table. */
  readonly name: string
  /** What using it costs. */
  readonly cost: CostClass
  /** The thing that performs the search. */
  readonly provider: P
  /**
   * How many searches this lane carries comfortably at once.
   *
   * A soft weight, not a gate: load is scored as in-flight divided by this, so
   * a lane declaring 2 takes twice the share of one declaring 1. Nothing is
   * ever refused for being over capacity — refusing would mean queueing, and
   * queueing is what this exists to avoid.
   */
  readonly capacity?: number | undefined
  /**
   * Optional balance probe, in USD. Returning 0 marks the lane unusable
   * without spending a request to discover that. Undefined means unknown,
   * which is treated as usable — a probe failure must not disable a lane.
   */
  readonly balanceUsd?: (() => Promise<number | undefined>) | undefined
}

/** How long a failing lane stays demoted. */
export const COOLDOWN_MS = 5 * 60_000

/**
 * Weight given to the newest sample in a lane's rolling latency.
 *
 * High enough that a lane which just got slow is noticed within a round or
 * two, low enough that one unlucky search does not re-order everything.
 */
const EWMA_ALPHA = 0.3

/** Why a lane was passed over. */
export interface LaneBlock {
  readonly name: string
  readonly cost: CostClass
  readonly reason: string
}

/** A lane's running record, for reporting and for the `fastest` policy. */
export interface LaneStats {
  readonly name: string
  readonly cost: CostClass
  /** Searches currently running on this lane. */
  readonly inFlight: number
  /** Searches ever dispatched to it. */
  readonly dispatched: number
  /** Searches it answered. */
  readonly succeeded: number
  /** Searches it failed. */
  readonly failed: number
  /** Rolling mean latency in ms, undefined until it has answered once. */
  readonly meanMs?: number | undefined
  /** Why it is currently unusable, when it is. */
  readonly blocked?: string | undefined
}

/** Mutable per-lane bookkeeping. */
interface LaneState {
  inFlight: number
  dispatched: number
  succeeded: number
  failed: number
  meanMs?: number | undefined
  failedAt?: number | undefined
  failReason?: string | undefined
}

/**
 * Picks which lane each search takes, and remembers how each one behaved.
 *
 * Holds no timers and starts nothing. It is asked for an ordering, told when a
 * search begins, and told how it ended.
 */
export class TrafficDirector<P extends LaneProvider = LaneProvider> {
  private readonly lanes: readonly Lane<P>[]
  private readonly state = new Map<string, LaneState>()
  private readonly cooldownMs: number
  /** Which policy the director is applying. Settable so a run can override it. */
  policy: TrafficPolicy

  constructor(lanes: readonly Lane<P>[], policy: TrafficPolicy = 'balanced', cooldownMs = COOLDOWN_MS) {
    this.lanes = lanes
    this.policy = policy
    this.cooldownMs = cooldownMs
    for (const lane of lanes) {
      this.state.set(lane.name, { inFlight: 0, dispatched: 0, succeeded: 0, failed: 0 })
    }
  }

  /** Every configured lane, in declaration order. */
  get all(): readonly Lane<P>[] {
    return this.lanes
  }

  /** @returns the bookkeeping for a lane, creating it if the lane is new. */
  private at(name: string): LaneState {
    let found = this.state.get(name)
    if (found === undefined) {
      found = { inFlight: 0, dispatched: 0, succeeded: 0, failed: 0 }
      this.state.set(name, found)
    }
    return found
  }

  /**
   * Whether a lane is currently demoted after a failure.
   * @param name - the lane's name.
   * @param now - the current time in ms.
   * @returns the failure reason while cooling, otherwise undefined.
   */
  private cooling(name: string, now: number): string | undefined {
    const found = this.at(name)
    if (found.failedAt === undefined) return undefined
    if (now - found.failedAt >= this.cooldownMs) {
      found.failedAt = undefined
      found.failReason = undefined
      return undefined
    }
    return found.failReason ?? 'recent failure'
  }

  /**
   * Lanes that cannot take a search right now, and why.
   * @param now - the current time in ms.
   * @returns one entry per unusable lane.
   */
  blocked(now: number = Date.now()): readonly LaneBlock[] {
    const out: LaneBlock[] = []
    for (const lane of this.lanes) {
      if (!lane.provider.available()) {
        out.push({ name: lane.name, cost: lane.cost, reason: 'no credential' })
        continue
      }
      const reason = this.cooling(lane.name, now)
      if (reason !== undefined) {
        out.push({ name: lane.name, cost: lane.cost, reason: `cooling down: ${reason}` })
      }
    }
    return out
  }

  /**
   * Usable lanes for one search, best first.
   *
   * Cost class leads in every policy; the policy only decides the order within
   * a class. Ties fall back to how many searches a lane has already taken, so
   * two identical idle lanes alternate instead of one taking everything.
   * @param now - the current time in ms.
   * @returns the ordering the caller should walk.
   */
  order(now: number = Date.now()): readonly Lane<P>[] {
    const rank: Record<CostClass, number> = { included: 0, metered: 1 }
    const usable = this.lanes
      .map((lane, index) => ({ lane, index }))
      .filter(entry => entry.lane.provider.available() && this.cooling(entry.lane.name, now) === undefined)

    const load = (lane: Lane<P>): number => {
      const capacity = lane.capacity === undefined || lane.capacity <= 0 ? 1 : lane.capacity
      return this.at(lane.name).inFlight / capacity
    }
    const share = (lane: Lane<P>): number => {
      const capacity = lane.capacity === undefined || lane.capacity <= 0 ? 1 : lane.capacity
      return this.at(lane.name).dispatched / capacity
    }
    // A lane that has never answered is scored as instant rather than as
    // unknown-and-therefore-last: an untried lane has to be tried once before
    // `fastest` can have an opinion about it.
    const speed = (lane: Lane<P>): number => this.at(lane.name).meanMs ?? 0

    const keys = (lane: Lane<P>, index: number): readonly number[] => {
      switch (this.policy) {
        case 'cheapest':
          return [rank[lane.cost], index]
        case 'fastest':
          return [rank[lane.cost], speed(lane), load(lane), share(lane), index]
        default:
          return [rank[lane.cost], load(lane), share(lane), index]
      }
    }

    return usable
      .map(entry => ({ lane: entry.lane, keys: keys(entry.lane, entry.index) }))
      .sort((a, b) => {
        for (let i = 0; i < a.keys.length; i += 1) {
          const left = a.keys[i] ?? 0
          const right = b.keys[i] ?? 0
          if (left !== right) return left - right
        }
        return 0
      })
      .map(entry => entry.lane)
  }

  /**
   * Record that a search has started on a lane.
   *
   * Must be paired with `settle`, or the lane looks permanently busy and the
   * balanced policy stops choosing it.
   * @param name - the lane's name.
   */
  begin(name: string): void {
    const found = this.at(name)
    found.inFlight += 1
    found.dispatched += 1
  }

  /**
   * Record how a search ended.
   * @param name - the lane's name.
   * @param ok - whether the lane answered.
   * @param ms - wall time the attempt took.
   * @param reason - the failure message, when it failed.
   */
  settle(name: string, ok: boolean, ms: number, reason?: string): void {
    const found = this.at(name)
    found.inFlight = Math.max(0, found.inFlight - 1)
    if (ok) {
      found.succeeded += 1
      found.meanMs = found.meanMs === undefined ? ms : found.meanMs * (1 - EWMA_ALPHA) + ms * EWMA_ALPHA
      // A lane that answers has earned its way out of the penalty box early;
      // otherwise a single failure keeps demoting a lane that already recovered.
      found.failedAt = undefined
      found.failReason = undefined
      return
    }
    found.failed += 1
    found.failedAt = Date.now()
    found.failReason = reason ?? 'failed'
  }

  /**
   * Clear a lane's demotion, so the next search may use it again.
   * @param name - the lane's name.
   */
  revive(name: string): void {
    const found = this.at(name)
    found.failedAt = undefined
    found.failReason = undefined
  }

  /**
   * What each lane has done so far.
   * @param now - the current time in ms.
   * @returns one row per configured lane, in declaration order.
   */
  stats(now: number = Date.now()): readonly LaneStats[] {
    return this.lanes.map((lane) => {
      const found = this.at(lane.name)
      const cooling = this.cooling(lane.name, now)
      const blocked = !lane.provider.available()
        ? 'no credential'
        : cooling === undefined ? undefined : `cooling down: ${cooling}`
      return {
        name: lane.name,
        cost: lane.cost,
        inFlight: found.inFlight,
        dispatched: found.dispatched,
        succeeded: found.succeeded,
        failed: found.failed,
        ...found.meanMs === undefined ? {} : { meanMs: Math.round(found.meanMs) },
        ...blocked === undefined ? {} : { blocked },
      }
    })
  }
}

/**
 * Read a policy name, falling back to the default rather than throwing.
 * @param value - whatever configuration supplied.
 * @returns a valid policy.
 */
export function readPolicy(value: unknown): TrafficPolicy {
  return TRAFFIC_POLICIES.includes(value as TrafficPolicy) ? value as TrafficPolicy : 'balanced'
}
