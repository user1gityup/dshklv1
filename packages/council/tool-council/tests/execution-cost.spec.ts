import { describe, expect, it } from 'vitest'
import { estimateExecution, renderExecutionEstimate } from '../src/execution-cost.ts'
import type { ProviderCost } from '../src/execution-cost.ts'
import type { SubTask } from '../src/decompose.ts'
import type { ModelPrice } from '../src/estimate.ts'

/** Build a task with sensible defaults. */
function task(id: string, provider?: string, dependsOn: string[] = []): SubTask {
  return { id, title: id, detail: '', dependsOn, ...provider === undefined ? {} : { provider } }
}

const PRICING = new Map<string, ModelPrice>([
  ['cheap/model', { prompt: 0.000_000_1, completion: 0.000_000_4 }],
])

const PROVIDERS: readonly ProviderCost[] = [
  { name: 'claude-code', costClass: 'included' },
  { name: 'free-claude', costClass: 'free' },
  { name: 'metered-one', costClass: 'metered', model: 'cheap/model' },
  { name: 'no-price', costClass: 'metered' },
]

describe('estimateExecution', () => {
  it('charges nothing metered for subscription workers', () => {
    const out = estimateExecution([task('a', 'claude-code')], PROVIDERS, PRICING, 'metered-one')
    expect(out.meteredUsd).toBe(0)
    expect(out.includedCount).toBe(1)
    expect(out.freeCount).toBe(0)
  })

  it('counts a free worker apart from a subscription one', () => {
    // Both are $0.0000, so without a separate count the gate cannot tell a run
    // that spends nothing from one that spends the month's quota.
    const out = estimateExecution([task('a', 'free-claude')], PROVIDERS, PRICING, 'metered-one')
    expect(out.meteredUsd).toBe(0)
    expect(out.freeCount).toBe(1)
    expect(out.includedCount).toBe(0)
  })

  it('says out loud that a free unit spends no quota either', () => {
    const out = estimateExecution([task('a', 'free-claude')], PROVIDERS, PRICING, 'metered-one')
    expect(out.caveats.some(caveat => caveat.includes('no subscription quota'))).toBe(true)
    expect(renderExecutionEstimate(out).some(line => line.includes('free seat'))).toBe(true)
  })

  it('prices a metered worker from the price table', () => {
    const out = estimateExecution([task('a', 'metered-one')], PROVIDERS, PRICING, 'metered-one')
    expect(out.meteredUsd).toBeGreaterThan(0)
    expect(out.unpricedCount).toBe(0)
  })

  it('counts an unpriced worker rather than silently charging zero', () => {
    // Silently treating an unpriced worker as free is how an estimate buys
    // consent for a number that was never real.
    const out = estimateExecution([task('a', 'no-price')], PROVIDERS, PRICING, 'metered-one')
    expect(out.unpricedCount).toBe(1)
    expect(out.caveats.some(c => c.includes('no published price'))).toBe(true)
  })

  it('runs a unit naming no provider on the fallback', () => {
    const out = estimateExecution([task('a')], PROVIDERS, PRICING, 'claude-code')
    expect(out.tasks[0]?.provider).toBe('claude-code')
    expect(out.includedCount).toBe(1)
  })

  it('runs a unit naming an unknown provider on the fallback too', () => {
    // Execution would fall back, so the estimate must price the fallback.
    const out = estimateExecution([task('a', 'does-not-exist')], PROVIDERS, PRICING, 'claude-code')
    expect(out.tasks[0]?.provider).toBe('claude-code')
  })

  it('reports wave widths, so concurrent spend is visible', () => {
    const tasks = [task('root'), task('x', undefined, ['root']), task('y', undefined, ['root'])]
    const out = estimateExecution(tasks, PROVIDERS, PRICING, 'metered-one')
    expect(out.waveSizes).toEqual([1, 2])
  })

  it('warns when a wave runs many workers at once', () => {
    const wide = ['a', 'b', 'c', 'd', 'e'].map(id => task(id))
    const out = estimateExecution(wide, PROVIDERS, PRICING, 'metered-one')
    expect(out.caveats.some(c => c.includes('wide wave'))).toBe(true)
  })

  it('scales with the number of units', () => {
    const one = estimateExecution([task('a', 'metered-one')], PROVIDERS, PRICING, 'metered-one')
    const four = estimateExecution(
      ['a', 'b', 'c', 'd'].map(id => task(id, 'metered-one')),
      PROVIDERS, PRICING, 'metered-one',
    )
    expect(four.meteredUsd).toBeCloseTo(one.meteredUsd * 4, 10)
  })

  it('handles an empty decomposition without dividing by zero', () => {
    const out = estimateExecution([], PROVIDERS, PRICING, 'metered-one')
    expect(out.meteredUsd).toBe(0)
    expect(out.waveSizes).toEqual([])
  })
})

describe('renderExecutionEstimate', () => {
  it('leads with the metered figure and keeps the caveats', () => {
    const out = renderExecutionEstimate(
      estimateExecution([task('a', 'metered-one'), task('b', 'claude-code')], PROVIDERS, PRICING, 'metered-one'),
    )
    const text = out.join('\n')
    expect(text).toContain('Metered cost')
    expect(text).toContain('subscription')
    expect(text).toContain('output tokens')
  })
})
