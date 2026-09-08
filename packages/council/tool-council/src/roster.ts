/**
 * Who does what in a swarm.
 *
 * Two things decide an assignment, and they are not equally weighted. The
 * first is fit: a worker declared for `code` should get the code. The second,
 * and the reason this module exists at all, is cost — and cost has three
 * tiers, not two. A free worker spends nothing at all; a subscription worker
 * bills nothing but draws down a finite monthly quota; a metered worker bills
 * per token. Any tie therefore breaks toward the cheapest scarce resource,
 * which means free first and the subscription held in reserve.
 *
 * The user owns the roster. This module never invents a worker or silently
 * promotes a disabled one; if nothing is eligible it says so rather than
 * quietly falling back to whatever is cheapest to reach.
 */

import type { CostClass } from './execution-cost.ts'
import type { SubTask } from './decompose.ts'
import type { SeatConfig } from './seats.ts'

/** Kinds of work a unit can be, used only to match workers to units. */
export const workKinds = ['code', 'tests', 'docs', 'research', 'review', 'any'] as const

/** One kind of work. */
export type WorkKind = (typeof workKinds)[number]

/** One configured worker in the swarm roster. */
export interface Worker {
  /**
   * Routing key this worker runs on: a council seat id for a seat-backed
   * roster, a subagent provider name for a provider-backed one.
   */
  readonly provider: string
  /** Display name for the panel. */
  readonly name: string
  /** Off workers are never assigned, whatever a decomposition suggests. */
  readonly enabled: boolean
  /** How the worker bills. Subscription workers are preferred on ties. */
  readonly costClass: CostClass
  /** Kinds this worker should be preferred for. `any` matches everything. */
  readonly kinds: readonly WorkKind[]
  /**
   * Units this worker may hold at once. Bounds a wide wave from stacking on
   * one subscription and exhausting its quota in a single run.
   */
  readonly maxConcurrent?: number | undefined
}

/** A unit with the worker that will run it. */
export interface Assignment {
  readonly task: SubTask
  /** Chosen provider, or undefined when no worker was eligible. */
  readonly provider?: string | undefined
  /** Why this worker, in one phrase, for the panel. */
  readonly reason: string
}

/** Result of assigning a whole decomposition. */
export interface AssignmentPlan {
  readonly assignments: readonly Assignment[]
  /** Units nobody could take. Non-empty means the roster cannot run this job. */
  readonly unassigned: readonly string[]
  /** Per-provider unit counts, for the panel. */
  readonly load: ReadonlyMap<string, number>
}

/**
 * Cost classes in preference order: the cheapest scarce resource comes first.
 *
 * A free seat outranks a subscription seat because the subscription's quota is
 * finite and a monthly budget is what runs out first. While both sorted as
 * `included` this order did not exist, so the tie fell through to
 * `localeCompare` and `claude` beat `free-claude` on its first letter.
 */
const COST_ORDER: Record<CostClass, number> = { free: 0, included: 1, metered: 2 }

/**
 * Guess the kind of work a unit is, from its own words.
 *
 * Deliberately shallow. A decomposition that wants precise routing should name
 * a provider outright; this only has to be good enough to prefer a code worker
 * for something that says "implement".
 * @param task - the unit.
 * @returns the inferred kind.
 */
export function inferKind(task: SubTask): WorkKind {
  const text = `${task.title} ${task.detail}`.toLowerCase()
  if (/\btest|spec|coverage|assert/.test(text)) return 'tests'
  if (/\bdoc|readme|comment|changelog/.test(text)) return 'docs'
  if (/\breview|audit|check|verify/.test(text)) return 'review'
  if (/\bresearch|investigate|compare|evaluate|find out/.test(text)) return 'research'
  if (/\bimplement|refactor|write|build|add|fix|migrate/.test(text)) return 'code'
  return 'any'
}

/**
 * Whether a worker is willing to take a kind of work.
 * @param worker - the candidate.
 * @param kind - the inferred kind.
 * @returns true when the worker declares the kind, or declares `any`.
 */
function accepts(worker: Worker, kind: WorkKind): boolean {
  return worker.kinds.includes('any') || worker.kinds.includes(kind)
}

/**
 * A preference for one unit kind, earned by this run rather than configured.
 *
 * Kept separate from `Worker.kinds`: the roster's kinds are a user or
 * default setting that outlasts the run, while an earned preference is
 * evidence from THIS run — a plan vote, a code sample the user picked — and
 * applies only to it. Neither is an opinion this module holds about which
 * model is better at what.
 */
export interface EarnedPreference {
  /** Skip cost entirely when ranking candidates; fit and load decide alone. */
  readonly ignoreCost?: boolean | undefined
  /** Kind to the provider that earned first refusal on it this run. */
  readonly specialists?: ReadonlyMap<WorkKind, string> | undefined
}

/**
 * Assign every unit of a decomposition to a worker.
 *
 * Order of preference, strongest first:
 *  1. A provider the decomposition named explicitly, if that worker is enabled.
 *  2. The provider that earned this kind this run (`earned.specialists`), if
 *     it accepts the kind and has room.
 *  3. A worker declaring this kind of work, cheapest cost class first unless
 *     `earned.ignoreCost` is set.
 *  4. Any enabled worker accepting `any`, ranked the same way.
 *
 * Within a cost class (or, with cost ignored, across the whole tier), the
 * least-loaded worker wins, so one subscription is not drained while another
 * sits idle.
 * @param tasks - the decomposition.
 * @param roster - configured workers.
 * @param earned - this run's own signals for preferring a worker, if any.
 * @returns the assignment plan.
 */
export function assignWorkers(
  tasks: readonly SubTask[],
  roster: readonly Worker[],
  earned?: EarnedPreference,
): AssignmentPlan {
  const enabled = roster.filter(worker => worker.enabled)
  const load = new Map<string, number>()
  const assignments: Assignment[] = []
  const unassigned: string[] = []

  const held = (worker: Worker): number => load.get(worker.provider) ?? 0
  const hasRoom = (worker: Worker): boolean =>
    worker.maxConcurrent === undefined || held(worker) < worker.maxConcurrent

  /** Cheapest cost class first unless told to skip it, then least loaded, then stable by name. */
  const best = (candidates: readonly Worker[]): Worker | undefined =>
    [...candidates].sort((a, b) =>
      (earned?.ignoreCost === true ? 0 : COST_ORDER[a.costClass] - COST_ORDER[b.costClass])
      || held(a) - held(b)
      || a.provider.localeCompare(b.provider),
    )[0]

  for (const task of tasks) {
    const kind = inferKind(task)

    // An explicit choice is honoured, but only if that worker is switched on:
    // a decomposition must not be able to re-enable a worker the user disabled.
    const named = task.provider === undefined
      ? undefined
      : enabled.find(worker => worker.provider === task.provider && hasRoom(worker))
    const specialist = named !== undefined ? undefined : earned?.specialists?.get(kind)
    const earnedWorker = specialist === undefined
      ? undefined
      : enabled.find(worker => worker.provider === specialist && accepts(worker, kind) && hasRoom(worker))
    const matching = enabled.filter(worker => accepts(worker, kind) && hasRoom(worker))
    const anyone = enabled.filter(worker => accepts(worker, 'any') && hasRoom(worker))

    const chosen = named ?? earnedWorker ?? best(matching) ?? best(anyone)
    if (chosen === undefined) {
      unassigned.push(task.id)
      assignments.push({ task, reason: 'no enabled worker could take it' })
      continue
    }

    load.set(chosen.provider, held(chosen) + 1)
    const reason = named !== undefined
      ? 'named by the decomposition'
      : chosen === earnedWorker
        ? `${kind}; earned this run`
        : earned?.ignoreCost === true
          ? `${kind}; least-loaded paid worker`
          : chosen.costClass === 'free'
            ? `${kind} on a free worker`
            : chosen.costClass === 'included'
              ? `${kind}; no free worker was available`
              : `${kind}; no free or subscription worker was available`
    assignments.push({ task, provider: chosen.provider, reason })
  }

  return { assignments, unassigned, load }
}

/**
 * Default roster for a fresh install.
 *
 * Subscription workers first and doing the code, which is the whole point:
 * the seats already paid for should carry the load, and metered providers
 * should pick up what is left rather than lead.
 * @param available - provider names actually registered on this host.
 * @returns a roster covering only providers that exist.
 */
export function defaultRoster(available: readonly string[]): readonly Worker[] {
  const known: readonly Worker[] = [
    {
      provider: 'claude-code',
      name: 'Claude',
      enabled: true,
      costClass: 'included',
      kinds: ['code', 'tests', 'review', 'any'],
    },
    {
      provider: 'codex',
      name: 'OpenAI',
      enabled: true,
      costClass: 'included',
      kinds: ['code', 'tests', 'any'],
    },
    {
      provider: 'free-claude',
      name: 'Free Claude',
      // Off on a fresh install: it needs the local proxy running, and a worker
      // that fails every unit is worse than one the user switches on.
      enabled: false,
      // Not `included`: the proxy bills nothing AND spends no subscription
      // quota, so it outranks the subscription workers rather than tying with
      // them and losing the tie to `claude-code` on alphabetical order.
      costClass: 'free',
      kinds: ['code', 'tests', 'docs', 'research', 'review', 'any'],
    },
    {
      provider: 'spawn',
      name: 'In-process',
      enabled: false,
      costClass: 'metered',
      kinds: ['any'],
    },
  ]
  return known.filter(worker => available.includes(worker.provider))
}

/**
 * The swarm roster built from the council's own seats.
 *
 * The workers a swarm may use ARE the seats the user configured. There is no
 * second registry to keep in step and no worker that exists only in the swarm:
 * re-point a seat's model, add an OpenRouter seat, switch one off, and the
 * swarm sees exactly that. `swarmRoster` overrides then say which of those
 * seats may take work and which kinds, without touching whether the seat sits
 * on the council — wanting a model to debate is not the same as wanting it to
 * carry a unit.
 *
 * A seat declaring itself free counts as `free` and wins ties outright; a CLI
 * seat bills a subscription already paid for, so it counts as `included` and
 * is held in reserve behind the free seats; an OpenRouter seat is metered and
 * picks up what is left.
 * @param seats - every configured seat, shipped and user-added.
 * @param overrides - per-seat swarm state, keyed by seat id.
 * @returns the roster, in seat order.
 */
export function seatRoster(
  seats: readonly SeatConfig[],
  overrides: Readonly<Record<string, { enabled?: boolean | undefined; kinds?: readonly string[] | undefined }>> = {},
): readonly Worker[] {
  return seats.map((seat) => {
    const override = overrides[seat.id]
    const kinds = override?.kinds === undefined
      ? DEFAULT_SEAT_KINDS
      : override.kinds.filter((kind): kind is WorkKind => (workKinds as readonly string[]).includes(kind))
    return {
      provider: seat.id,
      name: seat.name,
      // Absent an override a seat joins the swarm the way it joined the
      // council, so a fresh install needs no second setup pass.
      enabled: override?.enabled ?? seat.enabled,
      // A seat that declares itself free spends neither money nor a
      // subscription's quota, so it outranks a CLI seat rather than tying with
      // it. A CLI seat costs no money but does spend the subscription behind
      // it, and that quota is the thing a monthly budget runs out of.
      costClass: seat.free === true ? 'free' : seat.transport === 'cli' ? 'included' : 'metered',
      kinds,
    }
  })
}

/** Kinds a seat takes when the user has not narrowed it. */
const DEFAULT_SEAT_KINDS: readonly WorkKind[] = ['code', 'tests', 'docs', 'research', 'review', 'any']
