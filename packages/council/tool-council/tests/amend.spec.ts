/**
 * Amending a degraded run instead of re-running it.
 *
 * The run these are written against: five seats, three drafts, two hosted
 * seats cut off at the timeout, 12m29s spent. Recovering the two used to mean
 * asking all five again, plus a fresh planning round.
 */

import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { failedSeats, isAmendable, latestRun, loadRun, saveRun, MAX_AMENDMENTS, RUN_HISTORY } from '../src/runs.ts'
import type { RunRecord } from '../src/runs.ts'
import { amendCouncil } from '../src/council.ts'
import type { SeatConfig } from '../src/seats.ts'

// Hoisted: vi.mock is lifted above every import, so the path it hands back has
// to exist before any of them run. The directory itself is not created here —
// `saveRun` mkdirs its own tree — so the block only needs a unique NAME, which
// it can build without reaching for a module it cannot import yet.
const scratchHome = vi.hoisted(() => ({
  path: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/dsh-runs-home-${String(process.pid)}-${String(Date.now())}`,
}))
const home = scratchHome.path
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => scratchHome.path }
})

afterEach(() => {
  rmSync(join(home, '.dsh', 'council-runs'), { recursive: true, force: true })
})

const SEATS: readonly SeatConfig[] = [
  { id: 'claude', name: 'Claude', transport: 'cli', command: 'claude', enabled: true },
  { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
  { id: 'deepseek', name: 'DeepSeek v4', transport: 'openrouter', model: 'deepseek/deepseek-v4-pro', enabled: true },
]

function degradedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    query: 'which window mechanism',
    at: Date.now(),
    plan: 'compare mechanisms, pick one',
    evidenceBlock: 'SOURCES\n1. https://example.invalid/a',
    evidenceUrls: ['https://example.invalid/a'],
    seatIds: ['claude', 'kimi', 'deepseek'],
    drafts: [
      { seat: 'claude', text: 'Electron, because frameless windows.', ms: 126_600 },
      { seat: 'kimi', text: '', error: 'The operation was aborted due to timeout', ms: 180_000 },
      { seat: 'deepseek', text: '', error: 'The operation was aborted due to timeout', ms: 180_000 },
    ],
    reviews: [
      { seat: 'claude', vote: 'claude', confidence: 0.6, critique: 'only one answer to judge', ms: 40_000 },
      { seat: 'kimi', confidence: 0, critique: '', error: 'fetch failed caused by other side closed', ms: 12_000 },
      { seat: 'deepseek', confidence: 0, critique: '', error: 'fetch failed caused by other side closed', ms: 9_000 },
    ],
    amendments: 0,
    ...overrides,
  }
}

describe('run records', () => {
  it('names the seats worth asking again, and only those', () => {
    const holes = failedSeats(degradedRun())
    expect(holes.drafts).toEqual(['kimi', 'deepseek'])
    expect(holes.reviews).toEqual(['kimi', 'deepseek'])
  })

  // A seat may decline to name a vote; that is an opinion, not a hole.
  it('does not treat a review without a vote as a failure', () => {
    const record = degradedRun({
      reviews: [{ seat: 'claude', confidence: 0.4, critique: 'no clear winner', ms: 1_000 }],
    })
    expect(failedSeats(record).reviews).toEqual([])
  })

  it('round-trips a record through the store', () => {
    const record = degradedRun()
    expect(saveRun(record)).toBeDefined()
    expect(loadRun(record.id)?.drafts).toHaveLength(3)
    expect(latestRun()?.id).toBe(record.id)
  })

  it('refuses an id that is not one', () => {
    expect(loadRun('../../../etc/passwd')).toBeUndefined()
    expect(loadRun('')).toBeUndefined()
  })

  it('keeps a bounded history', () => {
    for (let index = 0; index < RUN_HISTORY + 5; index += 1) {
      saveRun(degradedRun({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, at: Date.now() + index }))
    }
    expect(readdirSync(join(home, '.dsh', 'council-runs')).length).toBeLessThanOrEqual(RUN_HISTORY)
  })

  it('stops amending once the cap is reached', () => {
    expect(isAmendable(degradedRun())).toBe(true)
    expect(isAmendable(degradedRun({ amendments: MAX_AMENDMENTS }))).toBe(false)
  })

  it('has nothing to amend when every seat answered', () => {
    const clean = degradedRun({
      drafts: [{ seat: 'claude', text: 'answer', ms: 10 }],
      reviews: [{ seat: 'claude', vote: 'claude', confidence: 1, critique: 'fine', ms: 10 }],
    })
    expect(isAmendable(clean)).toBe(false)
  })

  it('survives a corrupt record rather than throwing', () => {
    saveRun(degradedRun())
    writeFileSync(join(home, '.dsh', 'council-runs', 'not-a-run.json'), '{ broken')
    expect(latestRun()?.id).toBe(degradedRun().id)
  })
})

describe('amending a run', () => {
  it('re-asks only the failed seats and keeps the rest', async () => {
    const asked: string[] = []
    const record = degradedRun()
    // Seats are re-asked through askSeat; a cli seat with a command that does
    // not exist fails fast, which is enough to prove WHICH seats were called.
    const result = await amendCouncil({
      record,
      seats: SEATS.map(seat => ({ ...seat, transport: 'cli' as const, command: `probe-${seat.id}-does-not-exist` })),
      timeoutMs: 1_000,
      onEvent: (event) => {
        asked.push(`${event.round}:${event.seat}`)
      },
    })

    // Claude answered the first time and must not be asked again.
    expect(asked.filter(entry => entry.endsWith(':claude'))).toEqual([])
    expect(asked).toContain('draft:kimi')
    expect(asked).toContain('draft:deepseek')
    // The surviving answer is carried through untouched.
    expect(result.drafts.find(draft => draft.seat === 'claude')?.text).toBe('Electron, because frameless windows.')
    expect(result.amended?.runId).toBe(record.id)
    expect(result.amended?.attempt).toBe(1)
    expect(result.amended?.stillFailing).toContain('kimi')
  })

  it('reports a seat that has left the roster instead of failing the amendment', async () => {
    const result = await amendCouncil({
      record: degradedRun(),
      seats: [SEATS[0] as SeatConfig],
      timeoutMs: 1_000,
    })

    expect(result.drafts.find(draft => draft.seat === 'kimi')?.error).toMatch(/no longer in the roster/)
    expect(result.phase).toBe('full')
  })
})
