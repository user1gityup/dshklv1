import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { FileSeam } from '../src/files.ts'
import type { ModelPrice } from '../src/estimate.ts'
import type { SeatConfig } from '../src/seats.ts'
import * as seats from '../src/seats.ts'
import { runSwarm, unitPrompt } from '../src/swarm.ts'
import type { SwarmRunOptions, SwarmUnitResult } from '../src/swarm.ts'

/** A CLI seat and an OpenRouter seat, so both cost classes are exercised. */
const SEATS: readonly SeatConfig[] = [
  { id: 'claude', name: 'Claude', transport: 'cli', command: 'claude', args: ['-p', '{prompt}'], enabled: true },
  { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
]

const PRICING: ReadonlyMap<string, ModelPrice> = new Map([
  ['moonshotai/kimi-k2', { prompt: 0.000001, completion: 0.000002 }],
])

/** One decomposition the planning seat can return. */
const GRAPH = JSON.stringify([
  { id: 'read-config', title: 'Read the config', detail: 'Report what it holds.', dependsOn: [] },
  { id: 'write-notes', title: 'Write the notes', detail: 'Use the config.', dependsOn: ['read-config'] },
])

/** Queue seat replies in call order, and record the prompts each one saw. */
function stubSeat(replies: readonly (string | { error: string })[]): { prompts: string[]; seatIds: string[] } {
  const prompts: string[] = []
  const seatIds: string[] = []
  let call = 0
  vi.spyOn(seats, 'askSeat').mockImplementation(async (seat, prompt) => {
    prompts.push(prompt)
    seatIds.push(seat.id)
    const reply = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    if (typeof reply === 'object') {
      return await Promise.resolve({ seat: seat.id, text: '', error: reply.error, ms: 1 })
    }
    return await Promise.resolve({ seat: seat.id, text: reply ?? '', ms: 1 })
  })
  return { prompts, seatIds }
}

/** Baseline options; each test overrides only what it is about. */
function options(overrides: Partial<SwarmRunOptions> = {}): SwarmRunOptions {
  return {
    query: 'split the config work',
    seats: SEATS,
    overrides: {},
    approved: false,
    pricing: PRICING,
    timeoutMs: 1_000,
    ...overrides,
  }
}

describe('unitPrompt', () => {
  it('gives a worker the request, its own unit, and nothing else when it depends on nothing', () => {
    const prompt = unitPrompt(
      'build the thing',
      { id: 'a', title: 'Do a', detail: 'the detail', dependsOn: [] },
      [],
    )
    expect(prompt).toContain('build the thing')
    expect(prompt).toContain('YOUR UNIT: Do a')
    expect(prompt).not.toContain('WHAT THE UNITS YOU DEPEND ON REPORTED')
  })

  it('carries the reports of the units it depends on, so it does not invent them', () => {
    const done: readonly SwarmUnitResult[] = [
      { task: { id: 'a', title: 'Do a', detail: '', dependsOn: [] }, seat: 'claude', text: 'a said this', ms: 1 },
    ]
    const prompt = unitPrompt('q', { id: 'b', title: 'Do b', detail: '', dependsOn: ['a'] }, done)
    expect(prompt).toContain('a said this')
  })

  it('omits a dependency that failed rather than passing its empty report on', () => {
    const done: readonly SwarmUnitResult[] = [
      { task: { id: 'a', title: 'Do a', detail: '', dependsOn: [] }, seat: 'claude', text: '', error: 'boom', ms: 1 },
    ]
    const prompt = unitPrompt('q', { id: 'b', title: 'Do b', detail: '', dependsOn: ['a'] }, done)
    expect(prompt).not.toContain('WHAT THE UNITS YOU DEPEND ON REPORTED')
  })
})

describe('runSwarm stops before it spends', () => {
  it('refuses to run when no seat is switched on, without calling a seat', async () => {
    const stub = stubSeat([GRAPH])
    const result = await runSwarm(options({
      overrides: { claude: { enabled: false }, kimi: { enabled: false } },
    }))
    expect(result.phase).toBe('blocked')
    expect(result.report).toContain('No seat is switched on')
    expect(stub.prompts).toEqual([])
  })

  it('stops at the gate with a priced plan and runs no unit', async () => {
    const stub = stubSeat([GRAPH])
    const result = await runSwarm(options())
    expect(result.phase).toBe('plan')
    expect(result.tasks.map(task => task.id)).toEqual(['read-config', 'write-notes'])
    expect(result.results).toEqual([])
    expect(result.estimate?.waveSizes).toEqual([1, 1])
    expect(result.report).toContain('waiting for approval')
    // One call only: the decomposition. No unit was run.
    expect(stub.prompts).toHaveLength(1)
  })

  it('reports the planning seat failing instead of running a guessed graph', async () => {
    stubSeat([{ error: 'planner exploded' }])
    const result = await runSwarm(options())
    expect(result.phase).toBe('blocked')
    expect(result.report).toContain('planner exploded')
  })

  it('blocks on a reply with no usable units', async () => {
    stubSeat(['no json here'])
    const result = await runSwarm(options())
    expect(result.phase).toBe('blocked')
    expect(result.report).toContain('no readable json array of units')
  })

  it('blocks on a graph whose units all depend on each other', async () => {
    stubSeat([JSON.stringify([
      { id: 'a', title: 'A', detail: '', dependsOn: ['b'] },
      { id: 'b', title: 'B', detail: '', dependsOn: ['a'] },
    ])])
    const result = await runSwarm(options())
    expect(result.phase).toBe('blocked')
    expect(result.problems.length).toBeGreaterThan(0)
  })

  it('blocks when a unit needs a kind no enabled seat accepts', async () => {
    stubSeat([JSON.stringify([{ id: 'a', title: 'A', detail: '', dependsOn: [] }])])
    const result = await runSwarm(options({
      overrides: { claude: { enabled: true, kinds: [] }, kimi: { enabled: false } },
    }))
    expect(result.phase).toBe('blocked')
    expect(result.report).toContain('No enabled seat could take')
  })

  it('blocks when no enabled seat can write the decomposition', async () => {
    stubSeat([GRAPH])
    const result = await runSwarm(options({
      seats: [],
      overrides: {},
    }))
    // An empty seat list has no worker either, which is the first thing checked.
    expect(result.phase).toBe('blocked')
  })
})

describe('runSwarm once approved', () => {
  it('runs the stored graph in waves without decomposing again', async () => {
    const stub = stubSeat(['unit done'])
    const result = await runSwarm(options({
      approved: true,
      tasks: [
        { id: 'read-config', title: 'Read the config', detail: '', dependsOn: [] },
        { id: 'write-notes', title: 'Write the notes', detail: '', dependsOn: ['read-config'] },
      ],
    }))
    expect(result.phase).toBe('full')
    expect(result.results.map(unit => unit.task.id)).toEqual(['read-config', 'write-notes'])
    // Two units, two calls. A third would be a re-decomposition.
    expect(stub.prompts).toHaveLength(2)
    expect(result.report).toContain('2 of 2 unit(s) reported')
  })

  it('sends each unit to the seat it was assigned', async () => {
    const stub = stubSeat(['done'])
    await runSwarm(options({
      approved: true,
      tasks: [{ id: 'a', title: 'write the code', detail: '', dependsOn: [] }],
    }))
    // A CLI seat is `included`, so it wins the tie against the metered one.
    expect(stub.seatIds).toEqual(['claude'])
  })

  it('honours a unit that names its own seat', async () => {
    const stub = stubSeat(['done'])
    await runSwarm(options({
      approved: true,
      tasks: [{ id: 'a', title: 'research it', detail: '', dependsOn: [], provider: 'kimi' }],
    }))
    expect(stub.seatIds).toEqual(['kimi'])
  })

  it('records a unit that failed and still reports the rest', async () => {
    stubSeat([{ error: 'seat died' }])
    const result = await runSwarm(options({
      approved: true,
      tasks: [{ id: 'a', title: 'A', detail: '', dependsOn: [] }],
    }))
    expect(result.phase).toBe('full')
    expect(result.results[0]?.error).toBe('seat died')
    expect(result.report).toContain('1 failed')
  })

  it('runs a wave one unit at a time when asked to', async () => {
    const order: string[] = []
    vi.spyOn(seats, 'askSeat').mockImplementation(async (seat, prompt) => {
      order.push(prompt.includes('Do a') ? 'a' : 'b')
      return await Promise.resolve({ seat: seat.id, text: 'ok', ms: 1 })
    })
    const result = await runSwarm(options({
      approved: true,
      sequential: true,
      tasks: [
        { id: 'a', title: 'Do a', detail: '', dependsOn: [] },
        { id: 'b', title: 'Do b', detail: '', dependsOn: [] },
      ],
    }))
    expect(result.phase).toBe('full')
    expect(order).toEqual(['a', 'b'])
  })

  it('decomposes when approved with no stored graph, rather than running nothing', async () => {
    const stub = stubSeat([GRAPH, 'unit done'])
    const result = await runSwarm(options({ approved: true }))
    expect(result.phase).toBe('full')
    // One planning call plus one per unit.
    expect(stub.prompts).toHaveLength(3)
  })

  it('reports a unit whose assigned seat has since been removed', async () => {
    stubSeat(['done'])
    const result = await runSwarm(options({
      approved: true,
      seats: [SEATS[0] as SeatConfig],
      tasks: [{ id: 'a', title: 'A', detail: '', dependsOn: [], provider: 'kimi' }],
    }))
    // `kimi` is not in the roster, so assignment falls to the seat that is.
    expect(result.results[0]?.seat).toBe('claude')
  })
})

describe('a worker asking to be shown files', () => {
  const ROOT = resolve('/repo')
  const SEAM: FileSeam = {
    async read(path: string): Promise<string> {
      if (path === resolve(ROOT, 'lib/auth.js')) return 'export const auth = 1'
      throw new Error('ENOENT')
    },
  }

  it('offers the request only when a root is granted', () => {
    const task = { id: 'a', title: 'Review auth', detail: '', dependsOn: [] }
    expect(unitPrompt('q', task, [])).not.toContain('READ: <path>')
    expect(unitPrompt('q', task, [], [ROOT])).toContain('READ: <path>')
  })

  it('withdraws the offer once files have been served, so it cannot ask forever', () => {
    const task = { id: 'a', title: 'Review auth', detail: '', dependsOn: [] }
    const second = unitPrompt('q', task, [], [ROOT], 'FILES — served')
    expect(second).toContain('FILES — served')
    expect(second).not.toContain('READ: <path>')
  })

  it('serves the paths a unit asks for and puts the unit again', async () => {
    const stub = stubSeat(['READ: lib/auth.js', 'reviewed it'])
    const result = await runSwarm(options({
      approved: true,
      files: SEAM,
      fileRoots: [ROOT],
      tasks: [{ id: 'a', title: 'Review auth', detail: '', dependsOn: [] }],
    }))
    expect(stub.prompts).toHaveLength(2)
    expect(stub.prompts[1]).toContain('export const auth = 1')
    expect(result.results[0]?.text).toBe('reviewed it')
  })

  it('does not ask twice when the unit answered without asking', async () => {
    const stub = stubSeat(['reviewed it already'])
    await runSwarm(options({
      approved: true,
      files: SEAM,
      fileRoots: [ROOT],
      tasks: [{ id: 'a', title: 'Review auth', detail: '', dependsOn: [] }],
    }))
    expect(stub.prompts).toHaveLength(1)
  })

  it('takes a reply that answers and mentions a path as an answer, not a request', async () => {
    const stub = stubSeat(['I reviewed it.\nREAD: lib/auth.js would help next time.'])
    const result = await runSwarm(options({
      approved: true,
      files: SEAM,
      fileRoots: [ROOT],
      tasks: [{ id: 'a', title: 'Review auth', detail: '', dependsOn: [] }],
    }))
    expect(stub.prompts).toHaveLength(1)
    expect(result.results[0]?.text).toContain('I reviewed it.')
  })

  it('leaves the unit unable to read when no root is granted', async () => {
    const stub = stubSeat(['READ: lib/auth.js', 'reviewed it'])
    await runSwarm(options({
      approved: true,
      files: SEAM,
      tasks: [{ id: 'a', title: 'Review auth', detail: '', dependsOn: [] }],
    }))
    expect(stub.prompts).toHaveLength(1)
  })
})
