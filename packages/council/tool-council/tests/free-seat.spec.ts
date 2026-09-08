/**
 * A seat that costs nothing per token.
 *
 * The council already had two cost stories: a CLI seat billing a subscription
 * this process cannot observe, and an OpenRouter seat billing per token at a
 * published price. A local free-model proxy is a third. It speaks OpenRouter's
 * own wire format, so it is an `openrouter` seat, but its price is zero rather
 * than unknown. Everything below pins that distinction, because the failure it
 * prevents is quiet: a free seat counted as metered-but-unpriced makes the
 * budget panel warn about a cost that does not exist, and makes the swarm sort
 * a free worker behind a paid one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { askSeat, loopbackBackend, DEFAULT_SEATS } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'
import { estimateRun } from '../src/estimate.ts'
import type { ModelPrice, PlanScale } from '../src/estimate.ts'
import { projectCapacity } from '../src/capacity.ts'
import { seatRoster } from '../src/roster.ts'
import { resolveSeats } from '../src/index.ts'

const PROXY_URL = 'http://127.0.0.1:8080/v1/chat/completions'

const FREE: SeatConfig = {
  id: 'openrouter-free',
  name: 'OpenRouter Free',
  transport: 'openrouter',
  baseUrl: PROXY_URL,
  model: 'proxy-auto',
  free: true,
  enabled: true,
}

const KIMI: SeatConfig = {
  id: 'kimi',
  name: 'Kimi',
  transport: 'openrouter',
  model: 'moonshotai/kimi-k2',
  enabled: true,
}

const PRICING = new Map<string, ModelPrice>([
  ['moonshotai/kimi-k2', { prompt: 0.000_001, completion: 0.000_003 }],
])

const PLAN: PlanScale = { scale: 'medium', outputTokens: 1000, explicit: true }

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Record every request a seat makes, and answer it with one whole message. */
function capture(): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\ndata: [DONE]\n\n`
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof globalThis.fetch
  return { calls }
}

describe('the shipped free seat', () => {
  it('ships disabled, free, and pointed at the local proxy', () => {
    const seat = DEFAULT_SEATS.find(entry => entry.id === 'openrouter-free')
    expect(seat?.transport).toBe('openrouter')
    expect(seat?.free).toBe(true)
    expect(seat?.baseUrl).toBe(PROXY_URL)
    // Like `free-claude`: it needs a local process, so a fresh install must not
    // fail a round on it.
    expect(seat?.enabled).toBe(false)
  })

  it('can be pointed somewhere else from the panel', () => {
    const seats = resolveSeats({ 'openrouter-free': { enabled: true, baseUrl: 'http://127.0.0.1:9999/v1/chat/completions' } })
    const seat = seats.find(entry => entry.id === 'openrouter-free')
    expect(seat?.enabled).toBe(true)
    expect(seat?.baseUrl).toBe('http://127.0.0.1:9999/v1/chat/completions')
    expect(seat?.free).toBe(true)
  })

  it('treats an empty configured endpoint as unset', () => {
    // An empty string is the settings schema's materialised default, not a
    // request to POST the empty URL.
    const seats = resolveSeats({ 'openrouter-free': { baseUrl: '' } })
    expect(seats.find(entry => entry.id === 'openrouter-free')?.baseUrl).toBe(PROXY_URL)
  })

  it('carries the endpoint and the free flag onto an extra seat', () => {
    const seats = resolveSeats({}, { local: { model: 'proxy-auto', baseUrl: PROXY_URL, free: true } })
    const seat = seats.find(entry => entry.id === 'local')
    expect(seat?.baseUrl).toBe(PROXY_URL)
    expect(seat?.free).toBe(true)
  })
})

describe('routing a free seat', () => {
  it('posts to the seat endpoint rather than to OpenRouter', async () => {
    const { calls } = capture()
    await askSeat(FREE, 'question', undefined, undefined, 5_000)
    expect(calls[0]?.url).toBe(PROXY_URL)
  })

  it('sends no Authorization header when there is no key to send', async () => {
    const { calls } = capture()
    await askSeat(FREE, 'question', undefined, undefined, 5_000)
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  // The proxy is reached over loopback, but it is still an HTTP hop that may
  // want a key of its own; a configured one must not be dropped.
  it('still sends a key when one is configured', async () => {
    const { calls } = capture()
    await askSeat(FREE, 'question', 'sk-test', undefined, 5_000)
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
  })

  // Only a seat with an endpoint of its own may go keyless. A seat calling
  // OpenRouter itself without a key would 401 on every round.
  it('still refuses an OpenRouter seat with no key', async () => {
    const reply = await askSeat(KIMI, 'question', undefined, undefined, 5_000)
    expect(reply.error).toBe('no OpenRouter API key available')
  })
})

describe('a free seat is probed like any other local backend', () => {
  it('finds the proxy port behind a hosted seat', () => {
    expect(loopbackBackend(FREE)).toEqual({
      host: '127.0.0.1',
      port: 8080,
      origin: 'http://127.0.0.1:8080',
    })
  })

  it('ignores a hosted seat pointed at a remote endpoint', () => {
    expect(loopbackBackend({ ...FREE, baseUrl: 'https://example.invalid/v1/chat/completions' })).toBeUndefined()
  })
})

describe('what a free seat costs', () => {
  it('sorts ahead of the subscription seats in the swarm, not with them', () => {
    // It used to sort AS a subscription seat, which was the bug: sharing one
    // cost class meant the tie fell to the provider name, and the seat that
    // spends real quota won it.
    const roster = seatRoster([FREE, KIMI])
    expect(roster.find(worker => worker.provider === 'openrouter-free')?.costClass).toBe('free')
    expect(roster.find(worker => worker.provider === 'kimi')?.costClass).toBe('metered')
  })

  it('is reported as unmetered rather than unpriced', () => {
    const estimate = estimateRun([FREE, KIMI], PLAN, PRICING, [])
    expect(estimate.seats.find(seat => seat.seat === 'openrouter-free')?.metered).toBe(false)
    expect(estimate.seats.find(seat => seat.seat === 'kimi')?.metered).toBe(true)
  })

  it('adds nothing to the metered cost of a run', () => {
    const withFree = estimateRun([FREE, KIMI], PLAN, PRICING, [])
    const without = estimateRun([KIMI], PLAN, PRICING, [])
    expect(withFree.meteredCostUsd).toBe(without.meteredCostUsd)
  })

  // The whole reason for the flag: a free seat left in the blend would divide
  // the OpenRouter budget across a seat that never draws on it.
  it('does not divide the OpenRouter budget', () => {
    const config = { openRouterUsd: 10, subscriptionSeats: 0 }
    const observed = { outputTokens: 100_000, days: 7, messages: 100 }
    const withFree = projectCapacity(config, [FREE, KIMI], PRICING, observed)
    const without = projectCapacity(config, [KIMI], PRICING, observed)
    expect(withFree.hostedTokensPerMonth).toBe(without.hostedTokensPerMonth)
    expect(withFree.caveats).not.toContain(
      'no hosted seat could be priced, so the OpenRouter budget could not be converted into tokens',
    )
  })
})
