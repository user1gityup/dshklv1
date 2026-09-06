/**
 * Two-factor approval for the council's spending gate.
 *
 * The first version of this gate trusted the presence of a `plan` argument as
 * proof that a human had approved one. The model is the caller, so it simply
 * wrote its own plan and passed it back, turning the gate off and spending
 * money nobody had agreed to. Presence of a plan is not evidence of approval.
 *
 * Approval now needs two things the model cannot produce:
 *
 *  1. TRIGGER — a click on the Approve control, which writes the issued plan's
 *     id into settings. No settings-writing tool is exposed to the model, so
 *     this channel is reachable only by a person using the UI.
 *  2. VERBAL — a user message that arrives after that click. The model cannot
 *     fabricate a user turn.
 *
 * Either alone is insufficient by design. A stray click approves nothing until
 * the user speaks; a typo or a follow-up question runs nothing because no
 * button was pressed. Both must line up, and against the same issued plan.
 */

/** The plan the council issued and is holding. */
export interface PendingPlan {
  readonly id: string
  readonly query: string
  readonly issuedAt: number
}

/**
 * How long an issued plan stays approvable.
 *
 * The gate's state is global, not per-conversation, so without an expiry a
 * plan issued in one conversation still shows an Approve control in the next
 * one — offering to spend money on a question the user has moved on from.
 */
export const PLAN_TTL_MS = 15 * 60 * 1000

/** Everything the gate needs to decide. */
export interface ApprovalState {
  readonly pendingPlan?: PendingPlan | undefined
  /** Clock, injectable so the expiry is testable. */
  readonly now?: number | undefined
  readonly approvedPlanId?: string | undefined
  readonly approvedAt?: number | undefined
  /** When the most recent user message arrived, from the pre-step hook. */
  readonly lastUserTurnAt: number
}

/** Why the gate opened or stayed shut. */
export interface ApprovalVerdict {
  readonly allowed: boolean
  /** Plain sentence for the report; always populated. */
  readonly reason: string
  /** Which factor is missing, for the client to prompt on. */
  readonly missing?: 'trigger' | 'verbal' | 'plan' | 'expired' | undefined
}

/**
 * Whether an issued plan is still live.
 * @param plan - the issued plan.
 * @param now - current time in epoch ms.
 * @returns true when the plan is older than its time to live.
 */
export function planExpired(plan: PendingPlan, now: number = Date.now()): boolean {
  return now - plan.issuedAt > PLAN_TTL_MS
}

/**
 * Decide whether a full council run may proceed.
 *
 * Fails closed: anything unexpected leaves the gate shut. A gate that opens on
 * an unhandled case is not a gate.
 * @param state - the approval state to judge.
 * @returns the verdict and its reason.
 */
export function judgeApproval(state: ApprovalState): ApprovalVerdict {
  const pending = state.pendingPlan
  if (pending === undefined) {
    return {
      allowed: false,
      reason: 'no plan has been issued yet, so there is nothing to approve — run the council without a plan first',
      missing: 'plan',
    }
  }
  if (planExpired(pending, state.now ?? Date.now())) {
    return {
      allowed: false,
      reason: 'that plan has expired — ask again to get a fresh one',
      missing: 'expired',
    }
  }
  // An empty approvedPlanId is a retired approval, not a valid one.
  if (state.approvedPlanId === undefined || state.approvedPlanId === '' || state.approvedPlanId !== pending.id) {
    return {
      allowed: false,
      reason: 'waiting for you to press Approve on the plan above',
      missing: 'trigger',
    }
  }
  const approvedAt = state.approvedAt
  if (approvedAt === undefined) {
    return { allowed: false, reason: 'the approval carries no timestamp, so it cannot be trusted', missing: 'trigger' }
  }
  // The click must come after the plan, or it approved something older.
  if (approvedAt < pending.issuedAt) {
    return {
      allowed: false,
      reason: 'that approval predates this plan — press Approve again for the current one',
      missing: 'trigger',
    }
  }
  if (state.lastUserTurnAt <= approvedAt) {
    return {
      allowed: false,
      reason: 'approved — now send a message to run it',
      missing: 'verbal',
    }
  }
  return { allowed: true, reason: 'approved by button and confirmed by a following message' }
}
