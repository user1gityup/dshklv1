import { describe, expect, it } from 'vitest'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { RoutingSearchProvider, byCost } from '../src/router.ts'
import type { Route } from '../src/router.ts'
import { Config, DEFAULT_LANES, parseSearchReply, resolveLanes } from '../src/index.ts'

/** A provider that answers with one source naming itself. */
function answering(id: string, delayMs = 0): WebSearchProvider {
  return {
    id,
    available: () => true,
    async search(_request: WebSearchRequest): Promise<WebSearchResult> {
      if (delayMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, delayMs) })
      return { sources: [{ url: `https://${id}.example` }], truncated: false }
    },
  }
}

/** A provider that always throws. */
function failing(id: string, message = 'provider down'): WebSearchProvider {
  return {
    id,
    available: () => true,
    search(): Promise<WebSearchResult> { return Promise.reject(new Error(message)) },
  }
}

/** The lane that answered, read back out of the single returned source. */
function answered(result: WebSearchResult): string {
  return (result.sources[0]?.url ?? '').replace('https://', '').replace('.example', '')
}

describe('byCost', () => {
  it('puts subscription routes ahead of metered ones', () => {
    const routes: Route[] = [
      { name: 'paid', cost: 'metered', provider: answering('paid') },
      { name: 'free', cost: 'included', provider: answering('free') },
    ]
    expect(byCost(routes).map(route => route.name)).toEqual(['free', 'paid'])
  })
})

describe('RoutingSearchProvider', () => {
  it('sends concurrent searches down different lanes', async () => {
    // The point of the change: two lookups at once use two subscriptions
    // instead of queueing behind one CLI.
    const router = new RoutingSearchProvider('router', [
      { name: 'claude', cost: 'included', provider: answering('claude', 20) },
      { name: 'codex', cost: 'included', provider: answering('codex', 20) },
    ])
    const [first, second] = await Promise.all([
      router.search({ query: 'a' }),
      router.search({ query: 'b' }),
    ])
    expect([answered(first), answered(second)].sort()).toEqual(['claude', 'codex'])
  })

  it('falls through to the next lane when one fails', async () => {
    const router = new RoutingSearchProvider('router', [
      { name: 'broken', cost: 'included', provider: failing('broken') },
      { name: 'working', cost: 'included', provider: answering('working') },
    ])
    expect(answered(await router.search({ query: 'a' }))).toBe('working')
    expect(router.lastAttempts).toEqual([
      { name: 'broken', cost: 'included', ok: false, reason: 'provider down', ms: expect.any(Number) as number },
      { name: 'working', cost: 'included', ok: true, ms: expect.any(Number) as number },
    ])
  })

  it('keeps a failed lane out of the next search', async () => {
    let brokenCalls = 0
    const router = new RoutingSearchProvider('router', [
      {
        name: 'broken',
        cost: 'included',
        provider: {
          id: 'broken',
          available: () => true,
          search(): Promise<WebSearchResult> {
            brokenCalls += 1
            return Promise.reject(new Error('down'))
          },
        },
      },
      { name: 'working', cost: 'included', provider: answering('working') },
    ])
    await router.search({ query: 'a' })
    await router.search({ query: 'b' })
    expect(brokenCalls).toBe(1)
    expect(router.lastAttempts[0]).toMatchObject({ name: 'broken', reason: 'cooling down: down' })
  })

  it('skips a metered lane whose balance has run dry', async () => {
    let searched = false
    const router = new RoutingSearchProvider('router', [
      { name: 'free', cost: 'included', provider: failing('free') },
      {
        name: 'paid',
        cost: 'metered',
        provider: {
          id: 'paid',
          available: () => true,
          search(): Promise<WebSearchResult> {
            searched = true
            return Promise.resolve({ sources: [], truncated: false })
          },
        },
        balanceUsd: () => Promise.resolve(0),
      },
    ])
    await expect(router.search({ query: 'a' })).rejects.toThrow('every route failed')
    expect(searched).toBe(false)
    expect(router.lastAttempts.at(-1)).toMatchObject({ name: 'paid', reason: 'balance is zero' })
  })

  it('uses a metered lane whose balance is unknown', async () => {
    const router = new RoutingSearchProvider('router', [
      {
        name: 'paid',
        cost: 'metered',
        provider: answering('paid'),
        balanceUsd: () => Promise.reject(new Error('probe failed')),
      },
    ])
    // A probe failure must not disable a lane that might well have credit.
    expect(answered(await router.search({ query: 'a' }))).toBe('paid')
  })

  it('reports a lane with no credential without trying it', async () => {
    const router = new RoutingSearchProvider('router', [
      { name: 'absent', cost: 'included', provider: { id: 'absent', available: () => false, search: () => Promise.reject(new Error('never')) } },
      { name: 'present', cost: 'included', provider: answering('present') },
    ])
    expect(answered(await router.search({ query: 'a' }))).toBe('present')
    expect(router.lastAttempts[0]).toEqual({ name: 'absent', cost: 'included', ok: false, reason: 'no credential' })
  })

  it('is unavailable only when every lane is', () => {
    const dead = { id: 'x', available: () => false, search: () => Promise.reject(new Error('never')) }
    expect(new RoutingSearchProvider('router', [{ name: 'x', cost: 'included', provider: dead }]).available()).toBe(false)
    expect(new RoutingSearchProvider('router', [
      { name: 'x', cost: 'included', provider: dead },
      { name: 'y', cost: 'included', provider: answering('y') },
    ]).available()).toBe(true)
  })

  it('does not demote a lane the caller aborted', async () => {
    const controller = new AbortController()
    const router = new RoutingSearchProvider('router', [{
      name: 'slow',
      cost: 'included',
      provider: {
        id: 'slow',
        available: () => true,
        search(_request, signal): Promise<WebSearchResult> {
          controller.abort()
          return Promise.reject(signal?.aborted === true ? new Error('aborted') : new Error('other'))
        },
      },
    }])
    await expect(router.search({ query: 'a' }, controller.signal)).rejects.toThrow('aborted')
    // An abort is the caller's decision, so the lane stays usable.
    expect(router.traffic.blocked()).toEqual([])
  })

  it('names every lane in the failure when none answers', async () => {
    const router = new RoutingSearchProvider('router', [
      { name: 'one', cost: 'included', provider: failing('one', 'first reason') },
      { name: 'two', cost: 'metered', provider: failing('two', 'second reason') },
    ])
    await expect(router.search({ query: 'a' })).rejects.toThrow(
      'web search: every route failed — one (included): first reason; two (metered): second reason',
    )
  })

  it('exposes its routes cheapest-class first', () => {
    const router = new RoutingSearchProvider('router', [
      { name: 'paid', cost: 'metered', provider: answering('paid') },
      { name: 'free', cost: 'included', provider: answering('free') },
    ])
    expect(router.routes.map(route => route.name)).toEqual(['free', 'paid'])
  })
})

describe('resolveLanes', () => {
  it('routes across both agent CLIs by default', () => {
    const lanes = resolveLanes(new Config({}))
    expect(lanes.map(lane => lane.name)).toEqual(['claude-cli', 'codex-cli'])
    expect(lanes.every(lane => lane.cost === 'included')).toBe(true)
  })

  it('turns web search on for the Codex lane', () => {
    // `codex exec` answers from training data and cites nothing without it.
    const codex = DEFAULT_LANES.find(lane => lane.name === 'codex-cli')
    expect(codex?.args).toContain('tools.web_search=true')
  })

  it('still honours a pinned command on the first lane', () => {
    const lanes = resolveLanes(new Config({ command: 'claude-next' }))
    expect(lanes[0]?.name).toBe('claude-cli')
    expect(lanes.map(lane => lane.name)).toEqual(['claude-cli', 'codex-cli'])
  })

  it('replaces the built-in pair when lanes are configured', () => {
    const lanes = resolveLanes(new Config({
      lanes: {
        mine: { command: 'mytool', args: ['search', '{prompt}'] },
        off: { command: 'other', enabled: false },
      },
    }))
    expect(lanes.map(lane => lane.name)).toEqual(['mine'])
  })
})

describe('parseSearchReply', () => {
  it('reads a clean JSON reply', () => {
    const result = parseSearchReply('{"summary":"s","sources":[{"url":"https://a.example","title":"A"}]}', 5)
    expect(result.content).toBe('s')
    expect(result.sources).toEqual([{ url: 'https://a.example', title: 'A' }])
  })

  it('reads JSON a model wrapped in prose', () => {
    const result = parseSearchReply('Here you go:\n{"sources":[{"url":"https://a.example"}]}\nHope that helps.', 5)
    expect(result.sources).toEqual([{ url: 'https://a.example' }])
  })

  it('harvests bare URLs when the schema was ignored entirely', () => {
    const result = parseSearchReply('I looked at https://a.example and https://b.example', 5)
    expect(result.sources.map(source => source.url)).toEqual(['https://a.example', 'https://b.example'])
  })

  it('applies the result bound to the complete set', () => {
    const result = parseSearchReply('{"sources":[{"url":"https://a.example"},{"url":"https://b.example"}]}', 1)
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('drops a source with no usable url', () => {
    const result = parseSearchReply('{"sources":[{"title":"no url"},{"url":"https://a.example"}]}', 5)
    expect(result.sources).toEqual([{ url: 'https://a.example' }])
  })
})
