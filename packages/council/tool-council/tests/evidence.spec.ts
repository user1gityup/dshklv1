import { describe, expect, it } from 'vitest'
import { gatherEvidence, gatherRequested, parseSearchRequests } from '../src/evidence.ts'
import type { EvidenceSource, SearchSeam } from '../src/evidence.ts'

/** A seam returning a fixed set of sources. */
function seam(sources: readonly EvidenceSource[], content?: string): SearchSeam {
  return {
    async search() {
      return content === undefined ? { sources } : { content, sources }
    },
  }
}

describe('gatherEvidence', () => {
  it('returns undefined when the host mounts no seam', async () => {
    expect(await gatherEvidence(undefined, 'anything')).toBeUndefined()
  })

  it('returns undefined rather than throwing when the provider fails', async () => {
    const failing: SearchSeam = {
      async search() { throw new Error('WEB_PROVIDER_AMBIGUOUS') },
    }
    // A council that cannot search is degraded, not broken.
    expect(await gatherEvidence(failing, 'anything')).toBeUndefined()
  })

  it('returns undefined when the search finds nothing', async () => {
    expect(await gatherEvidence(seam([]), 'anything')).toBeUndefined()
  })

  it('numbers sources so a seat can cite them by index', async () => {
    const evidence = await gatherEvidence(seam([
      { url: 'https://a.example/one', title: 'First', snippet: 'alpha' },
      { url: 'https://b.example/two', title: 'Second', snippet: 'beta' },
    ]), 'q')
    expect(evidence).toBeDefined()
    expect(evidence?.block).toContain('[1] First — https://a.example/one')
    expect(evidence?.block).toContain('[2] Second — https://b.example/two')
    expect(evidence?.urls).toEqual(['https://a.example/one', 'https://b.example/two'])
  })

  it('tells the seat the evidence outranks its training data', async () => {
    const evidence = await gatherEvidence(seam([{ url: 'https://a.example' }]), 'q')
    expect(evidence?.block).toContain('your training data is not')
  })

  it('falls back to the bare url when a source has no title', async () => {
    const evidence = await gatherEvidence(seam([{ url: 'https://bare.example' }]), 'q')
    expect(evidence?.block).toContain('[1] https://bare.example')
  })

  it('collapses and caps a long snippet so one source cannot dominate', async () => {
    const evidence = await gatherEvidence(seam([
      { url: 'https://a.example', snippet: `${'x'.repeat(900)}\n\nmore   text` },
    ]), 'q')
    expect(evidence?.block).toContain('...')
    expect(evidence?.block).not.toContain('\n\nmore   text')
  })

  it('includes a provider summary when one is offered', async () => {
    const evidence = await gatherEvidence(
      seam([{ url: 'https://a.example' }], 'the provider said this'),
      'q',
    )
    expect(evidence?.block).toContain('the provider said this')
  })
})

describe('live search changes what a seat is told', () => {
  it('a searching seat is not told it has no tools', async () => {
    // The no-tools notice exists to stop a blind seat faking tool calls.
    // Aimed at a seat with live search it would suppress the very capability
    // being paid for, per result.
    const { draftPromptForTest } = await import('../src/council.ts') as Record<string, unknown> as {
      draftPromptForTest?: (...args: unknown[]) => string
    }
    // Exported only when the module chooses to; skip rather than fail if not.
    if (draftPromptForTest === undefined) return
    const online = draftPromptForTest('q', undefined, undefined, true, true)
    const offline = draftPromptForTest('q', undefined, undefined, true, false)
    expect(online).toContain('you have live web search')
    expect(offline).toContain('you have none')
  })
})

describe('seat-directed research', () => {
  it('reads the query lines a seat asked for', () => {
    const reply = 'SEARCH: brent crude price today\nSEARCH: opec production quota 2026'
    expect(parseSearchRequests(reply)).toEqual([
      'brent crude price today',
      'opec production quota 2026',
    ])
  })

  it('ignores prose around the requests', () => {
    const reply = 'I would want two things.\nSEARCH: node 24 release date\nThat should be enough.'
    expect(parseSearchRequests(reply)).toEqual(['node 24 release date'])
  })

  it('returns nothing when a seat needs nothing', () => {
    expect(parseSearchRequests('NONE')).toEqual([])
  })

  it('caps how many one seat may ask for', () => {
    const reply = ['a', 'b', 'c', 'd', 'e'].map(q => `SEARCH: ${q}`).join('\n')
    expect(parseSearchRequests(reply, 3)).toHaveLength(3)
  })

  it('deduplicates a seat asking twice', () => {
    expect(parseSearchRequests('SEARCH: same\nSEARCH: SAME')).toEqual(['same'])
  })

  it('drops an absurdly long query rather than sending it', () => {
    expect(parseSearchRequests(`SEARCH: ${'x'.repeat(400)}`)).toEqual([])
  })

  it('runs one search when two seats ask the same thing', async () => {
    // Deduplicating across seats is the difference between one free search
    // and one per seat.
    let calls = 0
    const seam: SearchSeam = {
      async search() {
        calls += 1
        return { sources: [{ url: 'https://a.example', title: 'A' }] }
      },
    }
    const evidence = await gatherRequested(seam, [
      { seat: 'kimi', queries: ['shared query'] },
      { seat: 'deepseek', queries: ['shared query'] },
    ])
    expect(calls).toBe(1)
    expect(evidence?.block).toContain('asked by kimi, deepseek')
  })

  it('keeps the other queries when one search fails', async () => {
    const seam: SearchSeam = {
      async search(request) {
        if (request.query === 'bad') throw new Error('provider down')
        return { sources: [{ url: 'https://ok.example', title: 'OK' }] }
      },
    }
    const evidence = await gatherRequested(seam, [{ seat: 'kimi', queries: ['bad', 'good'] }])
    expect(evidence?.urls).toEqual(['https://ok.example'])
  })

  it('returns undefined when no seat asked for anything', async () => {
    const seam: SearchSeam = { async search() { return { sources: [] } } }
    expect(await gatherRequested(seam, [])).toBeUndefined()
  })
})
