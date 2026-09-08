import { describe, expect, it } from 'vitest'
import { TrafficDirector, readPolicy } from '../src/traffic.ts'
import type { Lane, LaneProvider } from '../src/traffic.ts'

/** A lane provider that is simply present, or simply not. */
function provider(available = true): LaneProvider {
  return { available: () => available }
}

/** One lane, with sensible defaults for everything the test does not care about. */
function lane(name: string, extra: Partial<Lane> = {}): Lane {
  return { name, cost: 'included', provider: provider(), ...extra }
}

/** The names the director would try, in order. */
function names(director: TrafficDirector, now?: number): readonly string[] {
  return director.order(now).map(entry => entry.name)
}

describe('TrafficDirector ordering', () => {
  it('spreads across idle lanes rather than draining the first', () => {
    // The reason the whole module exists: two authenticated CLIs sitting idle
    // while eight searches queue behind one of them.
    const director = new TrafficDirector([lane('claude'), lane('codex')])
    expect(names(director)[0]).toBe('claude')
    director.begin('claude')
    expect(names(director)[0]).toBe('codex')
    director.begin('codex')
    // Both busy: the one that has taken fewer searches goes next.
    director.settle('claude', true, 10)
    expect(names(director)[0]).toBe('claude')
  })

  it('alternates between two idle lanes instead of favouring one', () => {
    const director = new TrafficDirector([lane('a'), lane('b')])
    const picks: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const first = director.order()[0]
      expect(first).toBeDefined()
      const name = first?.name ?? ''
      picks.push(name)
      director.begin(name)
      director.settle(name, true, 10)
    }
    expect(picks).toEqual(['a', 'b', 'a', 'b'])
  })

  it('gives a lane declaring more capacity a proportionally larger share', () => {
    const director = new TrafficDirector([lane('small'), lane('big', { capacity: 2 })])
    director.begin('small')
    director.begin('big')
    // One in flight each, but `big` is only half loaded.
    expect(names(director)[0]).toBe('big')
  })

  it('never prefers a metered lane over an idle included one', () => {
    const director = new TrafficDirector([
      lane('paid', { cost: 'metered' }),
      lane('free'),
    ])
    expect(names(director)).toEqual(['free', 'paid'])
    // Even saturated, the subscription lane still leads — cost outranks load.
    director.begin('free')
    director.begin('free')
    expect(names(director)).toEqual(['free', 'paid'])
  })

  it('keeps strict declaration order under the cheapest policy', () => {
    const director = new TrafficDirector([lane('first'), lane('second')], 'cheapest')
    director.begin('first')
    director.begin('first')
    expect(names(director)).toEqual(['first', 'second'])
  })

  it('prefers the quicker lane under the fastest policy', () => {
    const director = new TrafficDirector([lane('slow'), lane('quick')], 'fastest')
    director.begin('slow')
    director.settle('slow', true, 20_000)
    director.begin('quick')
    director.settle('quick', true, 2_000)
    expect(names(director)).toEqual(['quick', 'slow'])
  })

  it('tries an untried lane before one with a measured latency', () => {
    // Unknown is scored as instant on purpose: a lane has to run once before
    // `fastest` can have an opinion about it.
    const director = new TrafficDirector([lane('measured'), lane('untried')], 'fastest')
    director.begin('measured')
    director.settle('measured', true, 5_000)
    expect(names(director)[0]).toBe('untried')
  })

  it('omits a lane with no credential', () => {
    const director = new TrafficDirector([
      lane('absent', { provider: provider(false) }),
      lane('present'),
    ])
    expect(names(director)).toEqual(['present'])
    expect(director.blocked()).toEqual([
      { name: 'absent', cost: 'included', reason: 'no credential' },
    ])
  })
})

describe('TrafficDirector health', () => {
  it('demotes a failed lane for the cooldown, then restores it', () => {
    const director = new TrafficDirector([lane('flaky'), lane('steady')], 'balanced', 1_000)
    director.begin('flaky')
    director.settle('flaky', false, 5, 'HTTP 500')
    expect(names(director)).toEqual(['steady'])
    expect(director.blocked()[0]?.reason).toBe('cooling down: HTTP 500')
    // The cooldown is measured against the failure, so a later clock restores it.
    expect(names(director, Date.now() + 2_000)).toContain('flaky')
  })

  it('clears the demotion as soon as the lane answers again', () => {
    const director = new TrafficDirector([lane('flaky')], 'balanced', 60_000)
    director.begin('flaky')
    director.settle('flaky', false, 5, 'timed out')
    director.revive('flaky')
    expect(names(director)).toEqual(['flaky'])
    director.begin('flaky')
    director.settle('flaky', true, 5)
    expect(director.blocked()).toEqual([])
  })

  it('reports what each lane has done', () => {
    const director = new TrafficDirector([lane('claude'), lane('codex')])
    director.begin('claude')
    director.settle('claude', true, 1_000)
    director.begin('claude')
    director.settle('claude', false, 20, 'exit 1')
    director.begin('codex')
    const [claude, codex] = director.stats()
    expect(claude).toMatchObject({ dispatched: 2, succeeded: 1, failed: 1, inFlight: 0, meanMs: 1_000 })
    expect(claude?.blocked).toBe('cooling down: exit 1')
    expect(codex).toMatchObject({ dispatched: 1, inFlight: 1, succeeded: 0, failed: 0 })
    expect(codex?.meanMs).toBeUndefined()
  })

  it('never lets an unpaired settle drive in-flight below zero', () => {
    const director = new TrafficDirector([lane('a')])
    director.settle('a', true, 5)
    expect(director.stats()[0]?.inFlight).toBe(0)
  })

  it('weights the newest sample into the rolling latency', () => {
    const director = new TrafficDirector([lane('a')])
    director.begin('a')
    director.settle('a', true, 1_000)
    director.begin('a')
    director.settle('a', true, 2_000)
    // Between the two, nearer the older sample.
    expect(director.stats()[0]?.meanMs).toBe(1_300)
  })

  it('tracks a lane it was never told about', () => {
    const director = new TrafficDirector([lane('a')])
    director.begin('late')
    director.settle('late', true, 5)
    // No row for it — stats report configured lanes — but nothing throws.
    expect(director.stats().map(row => row.name)).toEqual(['a'])
  })

  it('exposes its lanes in declaration order', () => {
    const director = new TrafficDirector([lane('a'), lane('b')])
    expect(director.all.map(entry => entry.name)).toEqual(['a', 'b'])
  })

  it('can have its policy changed for one run', () => {
    const director = new TrafficDirector([lane('a'), lane('b')])
    director.begin('a')
    expect(names(director)).toEqual(['b', 'a'])
    director.policy = 'cheapest'
    expect(names(director)).toEqual(['a', 'b'])
  })
})

describe('readPolicy', () => {
  it('accepts every policy the schema offers', () => {
    expect(readPolicy('balanced')).toBe('balanced')
    expect(readPolicy('cheapest')).toBe('cheapest')
    expect(readPolicy('fastest')).toBe('fastest')
  })

  it('falls back rather than throwing on anything else', () => {
    // Configuration is a boundary, and a typo there must not stop the host.
    expect(readPolicy('quickest')).toBe('balanced')
    expect(readPolicy(undefined)).toBe('balanced')
  })
})
