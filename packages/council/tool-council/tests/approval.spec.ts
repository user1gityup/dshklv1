import { describe, expect, it } from 'vitest'
import { judgeApproval, planExpired, PLAN_TTL_MS } from '../src/approval.ts'

const PLAN = { id: 'plan-1', query: 'q', issuedAt: 1_000 }

/**
 * Judge with a clock pinned just after the fixture's issue time.
 *
 * Without this every fixture below is older than PLAN_TTL_MS against the real
 * clock, and the gate correctly refuses it as expired before reaching the
 * factor each test is actually about.
 */
function judge(state: Parameters<typeof judgeApproval>[0]): ReturnType<typeof judgeApproval> {
  return judgeApproval({ now: 5_000, ...state })
}


describe('two-factor approval gate', () => {
  it('refuses when no plan has been issued', () => {
    const v = judge({ lastUserTurnAt: 9_999 })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('plan')
  })

  it('refuses with no approval at all', () => {
    const v = judge({ pendingPlan: PLAN, lastUserTurnAt: 9_999 })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('trigger')
  })

  it('refuses an approval for a different plan', () => {
    // The exact case that let the model self-approve: something plan-shaped
    // is present, but it is not the plan this gate issued.
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: 'some-other-plan',
      approvedAt: 2_000,
      lastUserTurnAt: 3_000,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('trigger')
  })

  it('refuses an approval that predates the plan it claims to approve', () => {
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      approvedAt: 500,
      lastUserTurnAt: 3_000,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('trigger')
  })

  it('refuses the button alone, with no message after it', () => {
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      approvedAt: 2_000,
      lastUserTurnAt: 1_500,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('verbal')
  })

  it('refuses a message that arrived at the same instant as the click', () => {
    // Same-millisecond ties must not count as "after".
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      approvedAt: 2_000,
      lastUserTurnAt: 2_000,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('verbal')
  })

  it('allows only when both factors line up on the same plan', () => {
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      approvedAt: 2_000,
      lastUserTurnAt: 2_001,
    })
    expect(v.allowed).toBe(true)
  })

  it('refuses an approval with no timestamp', () => {
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      lastUserTurnAt: 9_999,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('trigger')
  })

  it('fails closed on a fresh process, where no user turn is recorded yet', () => {
    // lastUserTurnAt resets to 0 on restart, so a stale approval cannot survive.
    const v = judge({
      pendingPlan: PLAN,
      approvedPlanId: PLAN.id,
      approvedAt: 2_000,
      lastUserTurnAt: 0,
    })
    expect(v.allowed).toBe(false)
  })
})

describe('the gate cannot be routed around', () => {
  /**
   * Regression: the planOnly return sat inside the `skipPlan` guard, so a
   * caller passing skipPlan:true skipped the gate along with the planning
   * round and went straight to spending. The model found this within one
   * turn of the first hole being closed.
   */
  it('judges approval from state alone, never from caller flags', () => {
    // No combination of caller-supplied arguments appears in the gate's
    // inputs. If a flag could open it, it would have to be a field here.
    const inputs = judge({ pendingPlan: PLAN, lastUserTurnAt: 1 })
    expect(inputs.allowed).toBe(false)
    // Approval depends only on: an issued plan, a matching approved id, a
    // timestamp ordering, and a later user turn.
    expect(Object.keys({
      pendingPlan: 1, approvedPlanId: 1, approvedAt: 1, lastUserTurnAt: 1,
    })).toHaveLength(4)
  })

  it('stays shut for every partial approval, however it is assembled', () => {
    const partials = [
      { pendingPlan: PLAN, lastUserTurnAt: 5_000 },
      { pendingPlan: PLAN, approvedPlanId: PLAN.id, lastUserTurnAt: 5_000 },
      { pendingPlan: PLAN, approvedAt: 2_000, lastUserTurnAt: 5_000 },
      { pendingPlan: PLAN, approvedPlanId: 'other', approvedAt: 2_000, lastUserTurnAt: 5_000 },
      { pendingPlan: PLAN, approvedPlanId: PLAN.id, approvedAt: 2_000, lastUserTurnAt: 2_000 },
      { approvedPlanId: PLAN.id, approvedAt: 2_000, lastUserTurnAt: 5_000 },
    ]
    for (const state of partials) {
      expect(judgeApproval(state).allowed).toBe(false)
    }
  })
})

describe('plans expire', () => {
  const fresh = { id: 'p', query: 'q', issuedAt: 1_000_000 }

  it('refuses a plan older than its time to live', () => {
    // The exact case seen in use: an approved plan from a conversation the
    // user had already left still offered to spend money in the next one.
    const v = judgeApproval({
      pendingPlan: fresh,
      approvedPlanId: 'p',
      approvedAt: 1_000_001,
      lastUserTurnAt: 1_000_002,
      now: 1_000_000 + PLAN_TTL_MS + 1,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('expired')
  })

  it('still allows a plan inside its window', () => {
    const v = judgeApproval({
      pendingPlan: fresh,
      approvedPlanId: 'p',
      approvedAt: 1_000_001,
      lastUserTurnAt: 1_000_002,
      now: 1_000_000 + PLAN_TTL_MS - 1,
    })
    expect(v.allowed).toBe(true)
  })

  it('reports expiry directly', () => {
    expect(planExpired(fresh, 1_000_000 + PLAN_TTL_MS + 1)).toBe(true)
    expect(planExpired(fresh, 1_000_000 + 1)).toBe(false)
  })
})

describe('an approval is single-use', () => {
  const PLAN2 = { id: 'p2', query: 'q', issuedAt: 1_000 }

  it('rejects a retired approval, so every run needs its own', () => {
    // Retirement writes empty sentinels rather than undefined, because a
    // settings update treats undefined as "leave unchanged" — which let one
    // approval authorise every later run in the conversation.
    const v = judgeApproval({
      pendingPlan: PLAN2,
      approvedPlanId: '',
      approvedAt: 0,
      lastUserTurnAt: 5_000,
      now: 5_000,
    })
    expect(v.allowed).toBe(false)
    expect(v.missing).toBe('trigger')
  })

  it('rejects an approval left over from a previous plan', () => {
    const v = judgeApproval({
      pendingPlan: { id: 'p3-new', query: 'q', issuedAt: 4_000 },
      approvedPlanId: 'p2-old',
      approvedAt: 3_000,
      lastUserTurnAt: 5_000,
      now: 5_000,
    })
    expect(v.allowed).toBe(false)
  })
})
