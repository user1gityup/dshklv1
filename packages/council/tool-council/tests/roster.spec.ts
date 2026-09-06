import { describe, expect, it } from 'vitest'
import { assignWorkers, defaultRoster, inferKind, seatRoster } from '../src/roster.ts'
import type { SeatConfig } from '../src/seats.ts'
import type { Worker } from '../src/roster.ts'
import type { SubTask } from '../src/decompose.ts'

/** Build a unit with sensible defaults. */
function task(id: string, title = id, detail = '', provider?: string): SubTask {
  return { id, title, detail, dependsOn: [], ...provider === undefined ? {} : { provider } }
}

const CLAUDE: Worker = {
  provider: 'claude-code', name: 'Claude', enabled: true,
  costClass: 'included', kinds: ['code', 'tests', 'any'],
}
const CODEX: Worker = {
  provider: 'codex', name: 'OpenAI', enabled: true,
  costClass: 'included', kinds: ['code', 'any'],
}
const METERED: Worker = {
  provider: 'spawn', name: 'Metered', enabled: true,
  costClass: 'metered', kinds: ['any'],
}

describe('inferKind', () => {
  it('reads implementation work as code', () => {
    expect(inferKind(task('a', 'Implement the parser'))).toBe('code')
  })
  it('reads test work as tests', () => {
    expect(inferKind(task('a', 'Add spec coverage for the tally'))).toBe('tests')
  })
  it('reads documentation as docs', () => {
    expect(inferKind(task('a', 'Update the README'))).toBe('docs')
  })
  it('falls back to any when nothing matches', () => {
    expect(inferKind(task('a', 'Consider the situation'))).toBe('any')
  })
})

describe('assignWorkers', () => {
  it('prefers a subscription worker over a metered one', () => {
    // The whole point: work that is free at the margin should go to the seat
    // already paid for.
    const plan = assignWorkers([task('a', 'Implement a feature')], [METERED, CLAUDE])
    expect(plan.assignments[0]?.provider).toBe('claude-code')
    expect(plan.assignments[0]?.reason).toContain('subscription')
  })

  it('never assigns a disabled worker', () => {
    const off: Worker = { ...CLAUDE, enabled: false }
    const plan = assignWorkers([task('a', 'Implement a feature')], [off, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })

  it('refuses to re-enable a disabled worker the decomposition named', () => {
    // A decomposition must not be able to overrule the user's own switch.
    const off: Worker = { ...CLAUDE, enabled: false }
    const plan = assignWorkers([task('a', 'Work', '', 'claude-code')], [off, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })

  it('honours an explicit provider when that worker is enabled', () => {
    const plan = assignWorkers([task('a', 'Work', '', 'codex')], [CLAUDE, CODEX])
    expect(plan.assignments[0]?.provider).toBe('codex')
    expect(plan.assignments[0]?.reason).toContain('named')
  })

  it('spreads load across equally-priced workers', () => {
    const tasks = ['a', 'b', 'c', 'd'].map(id => task(id, 'Implement something'))
    const plan = assignWorkers(tasks, [CLAUDE, CODEX])
    expect(plan.load.get('claude-code')).toBe(2)
    expect(plan.load.get('codex')).toBe(2)
  })

  it('respects a worker concurrency ceiling', () => {
    const capped: Worker = { ...CLAUDE, maxConcurrent: 1 }
    const tasks = ['a', 'b'].map(id => task(id, 'Implement something'))
    const plan = assignWorkers(tasks, [capped, METERED])
    expect(plan.load.get('claude-code')).toBe(1)
    expect(plan.load.get('spawn')).toBe(1)
  })

  it('reports units nobody can take rather than inventing a worker', () => {
    const plan = assignWorkers([task('a', 'Implement something')], [])
    expect(plan.unassigned).toEqual(['a'])
    expect(plan.assignments[0]?.provider).toBeUndefined()
  })

  it('falls back to an any-worker when no worker declares the kind', () => {
    const docsOnly: Worker = { ...CLAUDE, kinds: ['docs'] }
    const plan = assignWorkers([task('a', 'Implement something')], [docsOnly, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })
})

describe('defaultRoster', () => {
  it('includes only providers actually registered on this host', () => {
    const roster = defaultRoster(['claude-code'])
    expect(roster.map(w => w.provider)).toEqual(['claude-code'])
  })

  it('puts the subscription workers on by default and the metered one off', () => {
    const roster = defaultRoster(['claude-code', 'codex', 'spawn'])
    expect(roster.find(w => w.provider === 'claude-code')?.enabled).toBe(true)
    expect(roster.find(w => w.provider === 'codex')?.enabled).toBe(true)
    expect(roster.find(w => w.provider === 'spawn')?.enabled).toBe(false)
  })

  it('is empty when nothing is registered', () => {
    expect(defaultRoster([])).toEqual([])
  })
})

describe('seatRoster', () => {
  const seats: readonly SeatConfig[] = [
    { id: 'claude', name: 'Claude', transport: 'cli', enabled: true },
    { id: 'free-claude', name: 'Free Claude', transport: 'cli', enabled: false },
    { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
  ]

  it('offers every configured seat as a worker, in seat order', () => {
    expect(seatRoster(seats).map(worker => worker.provider))
      .toEqual(['claude', 'free-claude', 'kimi'])
  })

  it('prices a CLI seat as included and an OpenRouter seat as metered', () => {
    const roster = seatRoster(seats)
    expect(roster.map(worker => worker.costClass)).toEqual(['included', 'included', 'metered'])
  })

  it('starts a seat in the swarm the way it starts on the council', () => {
    expect(seatRoster(seats).map(worker => worker.enabled)).toEqual([true, false, true])
  })

  it('lets a swarm override switch a seat on without touching the council', () => {
    const roster = seatRoster(seats, { 'free-claude': { enabled: true } })
    expect(roster.find(worker => worker.provider === 'free-claude')?.enabled).toBe(true)
    // The seat itself is untouched: the override is swarm-only state.
    expect(seats[1]?.enabled).toBe(false)
  })

  it('narrows a seat to the kinds the override names', () => {
    const roster = seatRoster(seats, { kimi: { kinds: ['research', 'docs'] } })
    expect(roster.find(worker => worker.provider === 'kimi')?.kinds).toEqual(['research', 'docs'])
  })

  it('drops a kind the roster does not recognise rather than trusting it', () => {
    const roster = seatRoster(seats, { kimi: { kinds: ['research', 'nonsense'] } })
    expect(roster.find(worker => worker.provider === 'kimi')?.kinds).toEqual(['research'])
  })

  it('assigns real work across the seat roster', () => {
    const plan = assignWorkers(
      [{ id: 'a', title: 'implement the parser', detail: '', dependsOn: [] }],
      seatRoster(seats),
    )
    // A CLI seat is `included`, so it wins the tie against the metered one.
    expect(plan.assignments[0]?.provider).toBe('claude')
    expect(plan.unassigned).toEqual([])
  })

  it('is empty when no seat is configured, rather than inventing a worker', () => {
    expect(seatRoster([])).toEqual([])
  })
})
