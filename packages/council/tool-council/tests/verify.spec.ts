import { describe, expect, it } from 'vitest'
import { auditDraft, detectFabricatedToolCalls, extractUrls, penaltyFor } from '../src/verify.ts'
import type { FetchSeam } from '../src/verify.ts'
import { plannerOrder, tally } from '../src/council.ts'
import type { SeatReview } from '../src/council.ts'
import type { SeatReply } from '../src/seats.ts'
import { DEFAULT_SEATS } from '../src/seats.ts'

/** A seam answering with fixed status codes per URL. */
function seam(codes: Record<string, number>): FetchSeam {
  return {
    async fetch(request) {
      const code = codes[request.url]
      if (code === undefined) throw new Error('ENOTFOUND')
      return { statusCode: code }
    },
  }
}

describe('extractUrls', () => {
  it('trims sentence punctuation that clings to a url', () => {
    expect(extractUrls('See https://a.example/x.')).toEqual(['https://a.example/x'])
  })

  it('deduplicates while keeping first-seen order', () => {
    expect(extractUrls('https://b.example https://a.example https://b.example'))
      .toEqual(['https://b.example', 'https://a.example'])
  })
})

describe('detectFabricatedToolCalls', () => {
  it('catches the shapes seats actually emit', () => {
    expect(detectFabricatedToolCalls('<tool>web_search</tool>')).toContain('<tool>')
    expect(detectFabricatedToolCalls('calling web_search("brent")')).toContain('web_search(...)')
  })

  it('does not flag prose about searching', () => {
    // The distinction that matters: talking about a search is not faking one.
    expect(detectFabricatedToolCalls('I would search the web for this.')).toEqual([])
    expect(detectFabricatedToolCalls('A web search would settle it.')).toEqual([])
  })
})

describe('auditDraft', () => {
  it('trusts urls that came from the shared evidence without refetching', async () => {
    const audit = await auditDraft('kimi', 'per [1] https://a.example/x', ['https://a.example/x'], undefined)
    expect(audit.citations[0]?.status).toBe('evidence')
    expect(audit.penalty).toBe(0)
  })

  it('matches evidence urls despite www and trailing slash', async () => {
    const audit = await auditDraft('kimi', 'https://www.a.example/x/', ['https://a.example/x'], undefined)
    expect(audit.citations[0]?.status).toBe('evidence')
  })

  it('marks an unfetchable citation unreachable and penalises it', async () => {
    const audit = await auditDraft('kimi', 'source: https://ghost.example/p', [], seam({}))
    expect(audit.citations[0]?.status).toBe('unreachable')
    expect(audit.penalty).toBeGreaterThan(0)
  })

  it('accepts a citation that resolves', async () => {
    const audit = await auditDraft('kimi', 'https://real.example/p', [], seam({ 'https://real.example/p': 200 }))
    expect(audit.citations[0]?.status).toBe('reachable')
    expect(audit.penalty).toBe(0)
  })

  it('treats a 404 as a dead citation, not a reachable one', async () => {
    const audit = await auditDraft('kimi', 'https://real.example/gone', [], seam({ 'https://real.example/gone': 404 }))
    expect(audit.citations[0]?.status).toBe('unreachable')
  })

  it('penalises fabricated tool calls even with no citations at all', async () => {
    const audit = await auditDraft('kimi', '<tool>web_search</tool> the answer is 42', [], undefined)
    expect(audit.fabricatedToolCalls.length).toBeGreaterThan(0)
    expect(audit.penalty).toBeGreaterThanOrEqual(0.5)
  })

  it('never zeroes a draft outright', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://x${String(i)}.example`, status: 'unreachable' as const }))
    expect(penaltyFor(many, ['<tool>'])).toBeLessThanOrEqual(0.9)
  })

  it('survives a seam that throws, rather than failing the run', async () => {
    const exploding: FetchSeam = { async fetch() { throw new Error('boom') } }
    const audit = await auditDraft('kimi', 'https://a.example', [], exploding)
    expect(audit.citations[0]?.status).toBe('unreachable')
  })
})

/** Build a review row with the fields the tally reads. */
function review(seat: SeatReview['seat'], vote: SeatReview['vote'], confidence: number): SeatReview {
  return { seat, vote, confidence, critique: '', ms: 1 }
}

/** Build a successful draft. */
function draft(seat: SeatReply['seat'], text = 'answer'): SeatReply {
  return { seat, text, ms: 1 }
}

describe('tally with penalties', () => {
  const drafts = [draft('kimi', 'fabricated but fluent'), draft('claude', 'sourced')]

  it('lets a penalty flip a winner that only led on unverified fluency', () => {
    const reviews = [
      review('deepseek', 'kimi', 0.9),
      review('openai', 'claude', 0.7),
    ]
    expect(tally(reviews, drafts).winner).toBe('kimi')
    // Half off for fabrication drops 0.9 to 0.45, behind Claude's honest 0.7.
    expect(tally(reviews, drafts, new Map([['kimi', 0.5]])).winner).toBe('claude')
  })

  it('leaves an unpenalised run exactly as it was', () => {
    const reviews = [review('deepseek', 'claude', 0.8)]
    expect(tally(reviews, drafts, new Map()).winner).toBe(tally(reviews, drafts).winner)
  })
})

describe('planner fallback', () => {
  it('offers every enabled seat as a planner, best first', () => {
    const seats = [
      { id: 'claude', name: 'Claude', transport: 'cli' as const, command: 'claude', enabled: true },
      { id: 'kimi', name: 'Kimi', transport: 'openrouter' as const, model: 'm/k', enabled: true },
      { id: 'off', name: 'Off', transport: 'openrouter' as const, model: 'm/o', enabled: false },
    ]
    const order = plannerOrder(seats, undefined)
    // Cheapest first, then the rest, and never a disabled seat.
    expect(order.map(s => s.id)).toEqual(['kimi', 'claude'])
  })

  it('honours an explicit planner but still keeps fallbacks behind it', () => {
    const seats = [
      { id: 'claude', name: 'Claude', transport: 'cli' as const, command: 'claude', enabled: true },
      { id: 'kimi', name: 'Kimi', transport: 'openrouter' as const, model: 'm/k', enabled: true },
    ]
    expect(plannerOrder(seats, 'claude').map(s => s.id)).toEqual(['claude', 'kimi'])
  })

  it('returns nothing when no seat is enabled', () => {
    expect(plannerOrder([], undefined)).toEqual([])
  })
})

describe('blocked is not dead', () => {
  const blocking = (code: number): FetchSeam => ({
    async fetch() { return { statusCode: code } },
  })

  it.each([401, 403, 405, 429])('does not penalise a citation refused with HTTP %i', async (code) => {
    // npmjs.com answers 403 to plain fetches. Penalising that would punish a
    // seat for citing a real and appropriate source.
    const audit = await auditDraft('kimi', 'https://www.npmjs.com/package/x', [], blocking(code))
    expect(audit.citations[0]?.status).toBe('unchecked')
    expect(audit.penalty).toBe(0)
  })

  it.each([404, 410, 500])('still penalises a citation that genuinely fails with HTTP %i', async (code) => {
    const audit = await auditDraft('kimi', 'https://example.invalid/gone', [], blocking(code))
    expect(audit.citations[0]?.status).toBe('unreachable')
    expect(audit.penalty).toBeGreaterThan(0)
  })
})

describe('the free-claude seat is genuinely separate', () => {
  const free = DEFAULT_SEATS.find(seat => seat.id === 'free-claude')

  it('ships in the roster but starts disabled', () => {
    // It needs a local proxy running; a seat that fails on every run of a
    // fresh install is worse than one the user switches on deliberately.
    expect(free).toBeDefined()
    expect(free?.enabled).toBe(false)
  })

  it('routes to the local proxy, never to Anthropic', () => {
    expect(free?.env?.['ANTHROPIC_BASE_URL']).toContain('127.0.0.1')
  })

  it('keeps its own config directory, so it cannot use the subscription login', () => {
    // Without this the two Claude seats share ~/.claude, and the free seat
    // could silently fall back to the logged-in subscription — the exact
    // outcome it exists to avoid.
    const dir = free?.env?.['CLAUDE_CONFIG_DIR']
    expect(dir).toBeDefined()
    expect(dir).not.toBe('')
    const paid = DEFAULT_SEATS.find(seat => seat.id === 'claude')
    expect(paid?.env?.['CLAUDE_CONFIG_DIR']).toBeUndefined()
  })

  it('runs the same binary as the paid seat, with the same tools', () => {
    const paid = DEFAULT_SEATS.find(seat => seat.id === 'claude')
    expect(free?.command).toBe(paid?.command)
    expect(free?.args).toEqual(paid?.args)
  })

  it('leaves the paid seat with no environment overrides at all', () => {
    const paid = DEFAULT_SEATS.find(seat => seat.id === 'claude')
    expect(paid?.env).toBeUndefined()
  })
})

describe('a slow seat gets its own timeout', () => {
  it('gives the free seat more room than the run default', () => {
    // A free-tier provider retries through 529s before answering. One global
    // timeout cannot serve a paid seat and a free one: set for the fast seat
    // it kills the slow one mid-retry.
    const free = DEFAULT_SEATS.find(seat => seat.id === 'free-claude')
    expect(free?.timeoutMs).toBeGreaterThan(180_000)
  })

  it('leaves the paid seats on the run default', () => {
    for (const id of ['claude', 'kimi', 'deepseek']) {
      expect(DEFAULT_SEATS.find(seat => seat.id === id)?.timeoutMs).toBeUndefined()
    }
  })
})
