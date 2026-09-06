import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { SeatConfig } from '../src/seats.ts'
import * as seats from '../src/seats.ts'
import type { FileSeam } from '../src/files.ts'
import type { Candidate } from '../src/writes.ts'
import { CANDIDATE_CHARS, runSelection, selectionPrompt } from '../src/select.ts'
import type { SelectionOptions } from '../src/select.ts'

const SEATS: readonly SeatConfig[] = [
  { id: 'claude', name: 'Claude', transport: 'cli', command: 'claude', args: ['-p', '{prompt}'], enabled: true },
  { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
]

const CONTENTS: Record<string, string> = {
  [resolve('/work/claude/lib/auth.js')]: 'claude version',
  [resolve('/work/kimi/lib/auth.js')]: 'kimi version',
}

const SEAM: FileSeam = {
  async read(path: string): Promise<string> {
    const text = CONTENTS[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  },
}

/** A candidate holding one file at the given seat root. */
function candidate(seat: string, root: string, label = 'lib/auth.js'): Candidate {
  return {
    seat,
    root: resolve(root),
    files: [{ label, path: resolve(root, label), chars: 14 }],
    refused: [],
  }
}

/** Queue votes in call order. */
function stubVotes(replies: readonly string[]): { prompts: string[] } {
  const prompts: string[] = []
  let call = 0
  vi.spyOn(seats, 'askSeat').mockImplementation(async (seat, prompt) => {
    prompts.push(prompt)
    const reply = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    return await Promise.resolve({ seat: seat.id, text: reply, ms: 1 })
  })
  return { prompts }
}

function options(overrides: Partial<SelectionOptions> = {}): SelectionOptions {
  return {
    task: 'fix the auth bug',
    candidates: [candidate('claude', '/work/claude'), candidate('kimi', '/work/kimi')],
    seats: SEATS,
    files: SEAM,
    timeoutMs: 1_000,
    ...overrides,
  }
}

describe('selectionPrompt', () => {
  it('names the votable seats and the task, and demands the vote line first', () => {
    const prompt = selectionPrompt('do the thing', ['### Candidate from kimi'], ['claude', 'kimi'])
    expect(prompt).toContain('VOTE: <one of: claude, kimi>')
    expect(prompt).toContain('do the thing')
    expect(prompt).toContain('### Candidate from kimi')
  })
})

describe('runSelection', () => {
  it('picks the candidate the seats voted for', async () => {
    stubVotes(['VOTE: kimi\nCONFIDENCE: 0.9\nCRITIQUE: kimi is cleaner'])
    const result = await runSelection(options())
    expect(result.winner).toBe('kimi')
    expect(result.chosen?.seat).toBe('kimi')
    expect(result.report).toContain('Selected: kimi')
  })

  it('says plainly that nothing was written to the repositories', async () => {
    stubVotes(['VOTE: kimi\nCONFIDENCE: 0.9\nCRITIQUE: fine'])
    const result = await runSelection(options())
    expect(result.report).toContain('Nothing has been written to the repositories')
  })

  it('buys no vote when only one seat produced code', async () => {
    const stub = stubVotes(['VOTE: claude\nCONFIDENCE: 1\nCRITIQUE: x'])
    const result = await runSelection(options({ candidates: [candidate('claude', '/work/claude')] }))
    expect(result.winner).toBe('claude')
    expect(result.verdict.method).toBe('sole-draft')
    expect(stub.prompts).toEqual([])
  })

  it('buys no vote when nobody produced code', async () => {
    const stub = stubVotes(['VOTE: claude\nCONFIDENCE: 1\nCRITIQUE: x'])
    const result = await runSelection(options({ candidates: [] }))
    expect(result.winner).toBeUndefined()
    expect(result.report).toContain('nothing to choose between')
    expect(stub.prompts).toEqual([])
  })

  it('skips a candidate whose files cannot be read back', async () => {
    stubVotes(['VOTE: claude\nCONFIDENCE: 0.8\nCRITIQUE: x'])
    const result = await runSelection(options({
      candidates: [candidate('claude', '/work/claude'), candidate('ghost', '/work/ghost')],
    }))
    // Only claude remains readable, so it is the sole candidate rather than
    // one of two, and no vote is bought.
    expect(result.verdict.method).toBe('sole-draft')
    expect(result.winner).toBe('claude')
  })

  it('reports a voter that failed instead of dropping its silence', async () => {
    vi.spyOn(seats, 'askSeat').mockImplementation(async seat => await Promise.resolve(
      seat.id === 'kimi'
        ? { seat: seat.id, text: '', error: 'seat died', ms: 1 }
        : { seat: seat.id, text: 'VOTE: kimi\nCONFIDENCE: 0.7\nCRITIQUE: ok', ms: 1 },
    ))
    const result = await runSelection(options())
    expect(result.reviews.find(review => review.seat === 'kimi')?.error).toBe('seat died')
    expect(result.report).toContain('no vote (seat died)')
  })

  it('does not let a vote for a seat that wrote nothing win', async () => {
    stubVotes(['VOTE: deepseek\nCONFIDENCE: 0.9\nCRITIQUE: none of these'])
    const result = await runSelection(options())
    expect(result.winner).not.toBe('deepseek')
  })

  it('caps how much of a candidate reaches the prompt and says it truncated', async () => {
    const long = 'x'.repeat(CANDIDATE_CHARS + 500)
    const seam: FileSeam = { async read(): Promise<string> { return long } }
    const stub = stubVotes(['VOTE: claude\nCONFIDENCE: 0.6\nCRITIQUE: x'])
    await runSelection(options({ files: seam }))
    const prompt = stub.prompts[0] ?? ''
    expect(prompt).toContain(`showing ${String(CANDIDATE_CHARS)} of ${String(long.length)}`)
  })
})
