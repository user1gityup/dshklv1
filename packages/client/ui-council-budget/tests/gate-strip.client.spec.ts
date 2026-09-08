/**
 * What the top-of-column gate strip decides to show.
 *
 * The strip exists because the Approve control renders on the call that issued
 * the plan, and a council report is thousands of words long — so by the time
 * it has finished streaming, the one control the run is waiting on has scrolled
 * out of reach.
 */

import { describe, expect, it } from 'vitest'
import { gateState } from '../src/client/GateStrip.tsx'

const NOW = 1_788_773_000_000
const FRESH = NOW - 60_000
const STALE = NOW - 20 * 60 * 1000

describe('gate strip state', () => {
  it('shows nothing when nothing is waiting', () => {
    expect(gateState({}, NOW)).toBeUndefined()
    expect(gateState({ pendingPlanId: '' }, NOW)).toBeUndefined()
    expect(gateState(undefined, NOW)).toBeUndefined()
  })

  it('names a held plan, with the time left on it', () => {
    const view = gateState({
      pendingPlanId: 'plan-1',
      pendingPlanIssuedAt: FRESH,
      pendingPlanQuery: 'add an app appearance',
    }, NOW)

    expect(view?.label).toBe('Council plan')
    expect(view?.state).toBe('waiting')
    expect(view?.left).toBe('14:00')
    expect(view?.question).toBe('add an app appearance')
  })

  it('turns into a nudge once the plan is approved', () => {
    const view = gateState({
      pendingPlanId: 'plan-1',
      pendingPlanIssuedAt: FRESH,
      approvedPlanId: 'plan-1',
    }, NOW)

    expect(view?.state).toBe('approved')
  })

  // An approval against a different plan is somebody else's, or an older one.
  it('keeps waiting when the approval names another plan', () => {
    const view = gateState({
      pendingPlanId: 'plan-2',
      pendingPlanIssuedAt: FRESH,
      approvedPlanId: 'plan-1',
    }, NOW)

    expect(view?.state).toBe('waiting')
  })

  // Expiry beats approval: an approved plan past its TTL still cannot run, and
  // saying "approved" would send the user off to type a message that does
  // nothing.
  it('reports an expired plan as expired even when it was approved', () => {
    const view = gateState({
      pendingPlanId: 'plan-1',
      pendingPlanIssuedAt: STALE,
      approvedPlanId: 'plan-1',
    }, NOW)

    expect(view?.state).toBe('expired')
    expect(view?.left).toBeUndefined()
  })

  it('prefers the swarm graph when both gates somehow stand', () => {
    const view = gateState({
      pendingPlanId: 'plan-1',
      pendingPlanIssuedAt: FRESH,
      pendingSwarmId: 'swarm-1',
      pendingSwarmIssuedAt: FRESH,
    }, NOW)

    expect(view?.label).toBe('Swarm graph')
    expect(view?.approvedIdKey).toBe('approvedSwarmId')
    expect(view?.approvedAtKey).toBe('approvedSwarmAt')
  })

  // The council gate's timestamp key predates the swarm's and never got the
  // prefix; writing `approvedPlanAt` would approve nothing at all.
  it('writes the council approval to the key the host actually reads', () => {
    const view = gateState({ pendingPlanId: 'plan-1', pendingPlanIssuedAt: FRESH }, NOW)

    expect(view?.approvedIdKey).toBe('approvedPlanId')
    expect(view?.approvedAtKey).toBe('approvedAt')
    expect(view?.heldKey).toBe('pendingPlanId')
  })

  it('shows nothing while auto-approve is on, because nothing waits', () => {
    expect(gateState({ pendingPlanId: 'plan-1', pendingPlanIssuedAt: FRESH, autoApprove: true }, NOW)).toBeUndefined()
  })
})
