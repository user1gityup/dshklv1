import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSwarm } from '../src/swarm.ts'
import { askSeat } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'
import { unitCandidateRoot } from '../src/swarm-contest.ts'
vi.mock('../src/seats.ts', async original => ({ ...await original<typeof import('../src/seats.ts')>(), askSeat: vi.fn() }))
const seats: SeatConfig[] = ['free-a', 'free-b', 'paid'].map(id => ({ id, name: id, enabled: true, transport: 'openrouter', free: id.startsWith('free') }))
const task = { id: 'unit', title: 'write answer', detail: 'Return 4.', dependsOn: [], acceptance: ['Answer is 4.'] }
const base = { query: 'question', seats, overrides: {}, approved: true, pricing: new Map(), timeoutMs: 100, tasks: [task], profile: 'economy' as const }
afterEach(() => vi.resetAllMocks())

describe('swarm profiles', () => {
  it('contests every unit with free seats and requires paid acceptance', async () => {
    vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 1,
      text: prompt.startsWith('Review this unit') ? 'ACCEPT: yes\nAnswer verified.' : prompt.startsWith('Choose the best') ? 'VOTE: free-a\nCONFIDENCE: 1\nCRITIQUE: accurate' : '4',
    }))
    const result = await runSwarm(base)
    expect(result.results[0]?.seat).toBe('free-a')
    expect(result.results[0]?.review).toContain('ACCEPT: yes')
    expect(vi.mocked(askSeat).mock.calls.map(call => call[0].id).sort()).toEqual(['free-a', 'free-a', 'free-b', 'free-b', 'paid'])
  })
  it('caps failed economy execution at one paid candidate and blocks dependants', async () => {
    vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 1, text: prompt.startsWith('Choose the best') ? 'VOTE: free-a\nCONFIDENCE: 1\nCRITIQUE: best' : 'ACCEPT: no' }))
    const result = await runSwarm({ ...base, tasks: [task, { ...task, id: 'dependent', dependsOn: ['unit'] }] })
    expect(result.results[0]?.error).toContain('escalation cap')
    expect(result.results[1]?.error).toContain('dependency unit failed')
    expect(vi.mocked(askSeat).mock.calls.filter(call => call[0].id === 'paid')).toHaveLength(3)
  })
  it('does not run units before approval and rejects underspecified economy graphs', async () => {
    expect((await runSwarm({ ...base, approved: false })).phase).toBe('plan')
    expect(askSeat).not.toHaveBeenCalled()
    expect((await runSwarm({ ...base, tasks: [{ ...task, acceptance: [] }] })).phase).toBe('blocked')
    expect(askSeat).not.toHaveBeenCalled()
  })
  it('fastest uses a paid worker even if a unit names a free seat', async () => {
    vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 1, text: prompt.startsWith('Review this unit') ? 'ACCEPT: yes' : '4' }))
    const result = await runSwarm({ ...base, profile: 'fastest', tasks: [{ ...task, provider: 'free-a' }] })
    expect(result.results[0]?.seat).toBe('paid')
    expect(vi.mocked(askSeat).mock.calls.every(call => call[0].id === 'paid')).toBe(true)
  })
  it('fastest earns the code unit for the plan-vote winner over cost order', async () => {
    // claude is the cheaper subscription seat and kimi is metered, so cost
    // order alone would pick claude; kimi earned the code unit instead by
    // winning the plan vote, which is the only reason it should win here.
    const twoPaid: SeatConfig[] = [
      { id: 'claude', name: 'claude', enabled: true, transport: 'cli' },
      { id: 'kimi', name: 'kimi', enabled: true, transport: 'openrouter' },
    ]
    vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 1, text: prompt.startsWith('Review this unit') ? 'ACCEPT: yes' : '4' }))
    const codeTask = { id: 'code-unit', title: 'implement the parser', detail: '', dependsOn: [] }
    const result = await runSwarm({ ...base, seats: twoPaid, profile: 'fastest', winner: 'kimi', tasks: [codeTask] })
    expect(result.results[0]?.seat).toBe('kimi')
  })
  it('refuses economy without free competitors or a paid reviewer before spending', async () => {
    expect((await runSwarm({ ...base, seats: seats.slice(0, 2) })).phase).toBe('blocked')
    expect((await runSwarm({ ...base, seats: seats.slice(1) })).phase).toBe('blocked')
    expect(askSeat).not.toHaveBeenCalled()
  })
  it('isolates the same seat across units and confines path-like identifiers', () => {
    expect(unitCandidateRoot('/staging', 'run', 'a', 'seat')).not.toBe(unitCandidateRoot('/staging', 'run', 'b', 'seat'))
    expect(unitCandidateRoot('/staging', 'run', '../escape', '..')).toContain('%2E%2E%2Fescape')
  })
  it('writes competing code artifacts under distinct unit and seat roots', async () => {
    const written = new Map<string, string>()
    vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 1,
      text: prompt.startsWith('Review this unit') ? 'ACCEPT: yes'
        : prompt.startsWith('Choose the best') ? 'VOTE: free-a\nCONFIDENCE: 1\nCRITIQUE: good'
          : `WRITE: ${prompt.includes('TARGET FILES:\na.ts') ? 'a.ts' : 'b.ts'}\n\`\`\`\nexport const answer = 4\n\`\`\``,
    }))
    const result = await runSwarm({ ...base, tasks: [{ ...task, files: ['a.ts'] }, { ...task, id: 'second', files: ['b.ts'] }], fileRoots: ['/source'], workRoot: '/staging', writes: { async write(path, text) { written.set(path, text) } } })
    expect(result.results.every(unit => unit.error === undefined)).toBe(true)
    expect(written.size).toBe(4)
    expect(new Set(result.results.flatMap(unit => unit.candidates?.map(candidate => candidate.root) ?? [])).size).toBe(4)
  })
})
