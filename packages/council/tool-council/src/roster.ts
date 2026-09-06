/**
 * Who does what in a swarm.
 *
 * Two things decide an assignment, and they are not equally weighted. The
 * first is fit: a worker declared for `code` should get the code. The second,
 * and the reason this module exists at all, is cost — a subscription worker is
 * already paid for, so work handed to it is free at the margin while the same
 * work on a metered provider is not. Any tie therefore breaks toward the
 * subscription.
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

/** Cost classes in preference order: free at the margin comes first. */
const COST_ORDER: Record<CostClass, number> = { included: 0, metered: 1 }

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
 * Assign every unit of a decomposition to a worker.
 *
 * Order of preference, strongest first:
 *  1. A provider the decomposition named explicitly, if that worker is enabled.
 *  2. A worker declaring this kind of work, cheapest cost class first.
 *  3. Any enabled worker accepting `any`, cheapest cost class first.
 *
 * Within a cost class, the least-loaded worker wins, so one subscription is
 * not drained while another sits idle.
 * @param tasks - the decomposition.
 * @param roster - configured workers.
 * @returns the assignment plan.
 */
export function assignWorkers(
  tasks: readonly SubTask[],
  roster: readonly Worker[],
): AssignmentPlan {
  const enabled = roster.filter(worker => worker.enabled)
  const load = new Map<string, number>()
  const assignments: Assignment[] = []
  const unassigned: string[] = []

  const held = (worker: Worker): number => load.get(worker.provider) ?? 0
  const hasRoom = (worker: Worker): boolean =>
    worker.maxConcurrent === undefined || held(worker) < worker.maxConcurrent

  /** Cheapest cost class first, then least loaded, then stable by name. */
  const best = (candidates: readonly Worker[]): Worker | undefined =>
    [...candidates].sort((a, b) =>
      COST_ORDER[a.costClass] - COST_ORDER[b.costClass]
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
    const matching = enabled.filter(worker => accepts(worker, kind) && hasRoom(worker))
    const anyone = enabled.filter(worker => accepts(worker, 'any') && hasRoom(worker))

    const chosen = named ?? best(matching) ?? best(anyone)
    if (chosen === undefined) {
      unassigned.push(task.id)
      assignments.push({ task, reason: 'no enabled worker could take it' })
      continue
    }

    load.set(chosen.provider, held(chosen) + 1)
    const reason = named !== undefined
      ? 'named by the decomposition'
      : chosen.costClass === 'included'
        ? `${kind} on a subscription worker`
        : `${kind}; no subscription worker was free`
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
      // `included` because nothing is billed per token for it. It sorts behind
      // `claude-code` on a tie only because the names order that way, not
      // because the subscription is cheaper.
      costClass: 'included',
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
 * A CLI seat bills a subscription already paid for, so it counts as `included`
 * and wins ties; an OpenRouter seat is metered and picks up what is left.
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
      costClass: seat.transport === 'cli' ? 'included' : 'metered',
      kinds,
    }
  })
}

/** Kinds a seat takes when the user has not narrowed it. */
const DEFAULT_SEAT_KINDS: readonly WorkKind[] = ['code', 'tests', 'docs', 'research', 'review', 'any']
