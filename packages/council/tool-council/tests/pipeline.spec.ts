/**
 * End-to-end pipeline smoke test.
 *
 * Runs the whole council against a stubbed `fetch` so every stage — planning
 * gate, estimate, budget guard, live events, drafting, review, tally, and the
 * rendered layout — executes without a real model call or a cent of spend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { judgeBudget, spendBetween } from '../src/budget.ts'
import { createPalette } from '../src/colors.ts'
import { runCouncil } from '../src/council.ts'
import type { CouncilEvent } from '../src/council.ts'
import { estimateRun, parsePlanScale } from '../src/estimate.ts'
import { renderReport } from '../src/report.ts'
import type { SeatConfig } from '../src/seats.ts'

/** Two hosted seats only: CLI seats would spawn real processes. */
const SEATS: readonly SeatConfig[] = [
  { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true },
  { id: 'deepseek', name: 'DeepSeek v4', transport: 'openrouter', model: 'deepseek/deepseek-v4-pro', enabled: true },
]

/** Balance readings served in order, so a run's delta is observable. */
let creditQueue: { total_credits: number; total_usage: number }[] = []
let chatCalls = 0

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  chatCalls = 0
  creditQueue = [
    { total_credits: 20, total_usage: 5 },
    { total_credits: 20, total_usage: 5.25 },
    { total_credits: 20, total_usage: 5.25 },
  ]
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/v1/credits')) {
      const next = creditQueue.shift() ?? { total_credits: 20, total_usage: 5.25 }
      return Promise.resolve(jsonResponse({ data: next }))
    }
    if (url.includes('/v1/models')) {
      return Promise.resolve(jsonResponse({
        data: [
          { id: 'moonshotai/kimi-k2', pricing: { prompt: '0.000001', completion: '0.000002' } },
          { id: 'deepseek/deepseek-v4-pro', pricing: { prompt: '0.0000005', completion: '0.000001' } },
        ],
      }))
    }
    if (url.includes('/chat/completions')) {
      chatCalls += 1
      // First call is the planning round; later calls are drafts and reviews.
      const content = chatCalls === 1
        ? 'RESTATEMENT: test\nAPPROACH: test\nSCALE: large\nEST_OUTPUT_TOKENS: 9000'
        : 'VOTE: kimi\nCONFIDENCE: 0.8\nCRITIQUE: both fine'
      return Promise.resolve(jsonResponse({
        model: 'stub-model',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
      }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('planning gate', () => {
  it('stops before drafting and reports the plan', async () => {
    const result = await runCouncil({
      query: 'compute pi to 1200000 digits',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      planOnly: true,
      budget: { minBalanceUsd: 0.5, monthlyUsd: 20 },
    })
    expect(result.phase).toBe('plan')
    expect(result.plan).toContain('RESTATEMENT')
    expect(result.planSeat).toBe('kimi')
    expect(result.drafts).toHaveLength(0)
    // Exactly one model call: the whole point of the gate.
    expect(chatCalls).toBe(1)
  })

  it('measures spend as a balance delta', async () => {
    const result = await runCouncil({
      query: 'q',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      planOnly: true,
      budget: { minBalanceUsd: 0.5 },
    })
    expect(result.spentUsd).toBeCloseTo(0.25)
  })

  it('refuses to start when credit is below the floor', async () => {
    creditQueue = [{ total_credits: 20, total_usage: 19.9 }]
    const result = await runCouncil({
      query: 'q',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      budget: { minBalanceUsd: 1 },
    })
    expect(result.budget?.allowed).toBe(false)
    expect(chatCalls).toBe(0)
  })
})

describe('full run', () => {
  it('drafts, reviews, tallies, and emits live events', async () => {
    const events: CouncilEvent[] = []
    const result = await runCouncil({
      query: 'why is the sky blue',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      skipPlan: true,
      budget: { minBalanceUsd: 0.5, monthlyUsd: 20 },
      onEvent: event => events.push(event),
    })
    expect(result.phase).toBe('full')
    expect(result.drafts).toHaveLength(2)
    expect(result.reviews).toHaveLength(2)
    expect(result.verdict.winner).toBe('kimi')
    expect(result.answer).not.toBe('')

    // Two drafts plus two reviews, each reported once.
    expect(events).toHaveLength(4)
    expect(events.map(event => event.round)).toEqual(['draft', 'draft', 'review', 'review'])
    expect(events.every(event => event.ok)).toBe(true)
    // The running total must be monotonic, or the live display would jump about.
    const totals = events.map(event => event.runningCostUsd)
    expect([...totals].sort((a, b) => a - b)).toEqual(totals)
    expect(totals.at(-1)).toBeCloseTo(0.004)
  })

  it('renders every section of the report', async () => {
    const result = await runCouncil({
      query: 'why is the sky blue',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      skipPlan: true,
      budget: { minBalanceUsd: 0.5, monthlyUsd: 20 },
    })
    const text = renderReport(result, createPalette(false))
    for (const section of ['COUNCIL', 'Query:', 'Budget:', 'INITIAL ANSWERS', 'REVIEWS AND VOTES', 'COLLECTIVE ANSWER', 'Tally:']) {
      expect(text).toContain(section)
    }
    expect(text).toContain('Spent this run')
  })

  it('degrades to the surviving seat when one transport fails', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/v1/credits')) return Promise.resolve(jsonResponse({ data: { total_credits: 20, total_usage: 5 } }))
      if (url.includes('/chat/completions')) {
        chatCalls += 1
        // Fail every second call, so one seat survives and one does not.
        if (chatCalls % 2 === 0) return Promise.resolve(new Response('rate limited', { status: 429 }))
        return Promise.resolve(jsonResponse({
          choices: [{ message: { content: 'VOTE: kimi\nCONFIDENCE: 0.9\nCRITIQUE: ok' } }],
          usage: { cost: 0.001 },
        }))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })
    const result = await runCouncil({
      query: 'q',
      seats: SEATS,
      apiKey: 'sk-or-v1-stub',
      timeoutMs: 5_000,
      skipPlan: true,
    })
    expect(result.drafts.some(draft => draft.error !== undefined)).toBe(true)
    expect(result.answer).not.toBe('')
    expect(renderReport(result, createPalette(false))).toContain('failed:')
  })
})

describe('estimate at the gate', () => {
  it('prices a large job and warns when it exceeds remaining credit', () => {
    const scale = parsePlanScale('SCALE: large\nEST_OUTPUT_TOKENS: 400000')
    const pricing = new Map([
      ['moonshotai/kimi-k2', { prompt: 0.000001, completion: 0.000002 }],
      ['deepseek/deepseek-v4-pro', { prompt: 0.0000005, completion: 0.000001 }],
    ])
    const estimate = estimateRun(SEATS, scale, pricing, [], { remainingUsd: 1, monthlyUsd: 20, monthUsedUsd: 19 })
    expect(estimate.outputTokens).toBe(400_000)
    expect(estimate.meteredCostUsd).toBeGreaterThan(1)
    expect(estimate.warnings.some(warning => warning.includes('remaining OpenRouter credit'))).toBe(true)
    expect(estimate.warnings.some(warning => warning.includes('against your $20.00 target'))).toBe(true)
  })

  it('marks CLI seats as unmetered rather than inventing a cost', () => {
    const withCli: readonly SeatConfig[] = [
      ...SEATS,
      { id: 'claude', name: 'Claude', transport: 'cli', command: 'claude', enabled: true },
    ]
    const estimate = estimateRun(withCli, parsePlanScale('SCALE: small'), new Map(), [])
    const claude = estimate.seats.find(seat => seat.seat === 'claude')
    expect(claude?.metered).toBe(false)
    expect(claude?.costUsd).toBeUndefined()
  })

  it('prefers measured history over token maths when history is dearer', () => {
    const scale = parsePlanScale('SCALE: medium')
    const estimate = estimateRun(SEATS, scale, new Map(), [{ costUsd: 5 }, { costUsd: 7 }])
    expect(estimate.basis).toBe('history')
    expect(estimate.meteredCostUsd).toBeCloseTo(6)
  })
})

describe('budget judgement', () => {
  it('allows the run when the balance cannot be read', () => {
    expect(judgeBudget(undefined, { minBalanceUsd: 5 }).allowed).toBe(true)
  })

  it('flags an over-pace month without blocking', () => {
    const decision = judgeBudget({ purchased: 20, used: 15, remaining: 5 }, {
      monthlyUsd: 20,
      dayOfMonth: 10,
      daysInMonth: 30,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.overPace).toBe(true)
    expect(decision.projectedMonthlyUsd).toBeCloseTo(45)
  })

  it('ignores a mid-run top-up rather than reporting negative spend', () => {
    const before = { purchased: 20, used: 10, remaining: 10 }
    const after = { purchased: 40, used: 9, remaining: 31 }
    expect(spendBetween(before, after)).toBeUndefined()
  })
})
