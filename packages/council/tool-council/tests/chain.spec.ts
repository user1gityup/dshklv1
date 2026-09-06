import { describe, expect, it } from 'vitest'
import { detectQuotaHold, holdElapsed, holdRemaining, isQuotaExhausted, DEFAULT_HOLD_MS } from '../src/quota-hold.ts'
import { nextStage, runPipeline, startPipeline } from '../src/pipeline.ts'
import type { PipelineState, StageOutput } from '../src/pipeline.ts'

/** A fixed clock, so a stated reset time resolves the same way every run. */
const NOW = new Date('2026-09-04T10:00:00').getTime()

/** A stage runner that answers each stage from a table, and records what it saw. */
function runner(table: Partial<Record<string, StageOutput>>): {
  runStage: (stage: string, input: unknown) => Promise<StageOutput>
  seen: { stage: string; input: unknown }[]
} {
  const seen: { stage: string; input: unknown }[] = []
  return {
    seen,
    runStage: async (stage, input) => {
      seen.push({ stage, input })
      return await Promise.resolve(table[stage] ?? { report: `${stage} ok`, complete: true })
    },
  }
}

describe('isQuotaExhausted', () => {
  it('reads the CLI wording as an allowance, not a fault', () => {
    expect(isQuotaExhausted('Claude usage limit reached · resets 3pm')).toBe(true)
    expect(isQuotaExhausted('HTTP 429 Too Many Requests')).toBe(true)
    expect(isQuotaExhausted('insufficient credits')).toBe(true)
  })

  it('does not mistake a misconfiguration for a spent allowance', () => {
    // These would park a run forever on something waiting cannot fix.
    expect(isQuotaExhausted('no OpenRouter API key available')).toBe(false)
    expect(isQuotaExhausted('HTTP 401 Unauthorized')).toBe(false)
    expect(isQuotaExhausted('no model configured')).toBe(false)
  })
})

describe('detectQuotaHold', () => {
  it('returns nothing when the failures are ordinary faults', () => {
    expect(detectQuotaHold([{ seat: 'kimi', error: 'HTTP 500 upstream' }], NOW)).toBeUndefined()
  })

  it('takes the reset time the CLI stated', () => {
    const hold = detectQuotaHold([{ seat: 'claude', error: 'usage limit reached · resets 3pm' }], NOW)
    expect(hold?.source).toBe('stated')
    expect(new Date(hold?.resumeAt ?? 0).getHours()).toBe(15)
  })

  it('reads a stated time already past as tomorrow, not as the morning just gone', () => {
    // 9am at 10am must not resolve to an hour ago, or the run resumes straight
    // back into the same wall.
    const hold = detectQuotaHold([{ error: 'usage limit reached, resets 9am' }], NOW)
    expect(hold?.resumeAt).toBeGreaterThan(NOW)
  })

  it('takes a stated duration over a clock time', () => {
    const hold = detectQuotaHold([{ error: 'rate limited, try again in 45 minutes' }], NOW)
    expect(hold?.resumeAt).toBe(NOW + 45 * 60_000)
  })

  it('falls back to a bounded default when no time is given', () => {
    const hold = detectQuotaHold([{ seat: 'claude', error: 'usage limit reached' }], NOW)
    expect(hold?.source).toBe('default')
    expect(hold?.resumeAt).toBe(NOW + DEFAULT_HOLD_MS)
  })

  it('describes only the first exhaustion, not one per unit in the wave', () => {
    const hold = detectQuotaHold([
      { seat: 'claude', error: 'usage limit reached' },
      { seat: 'claude', error: 'usage limit reached' },
    ], NOW)
    expect(hold?.seat).toBe('claude')
  })
})

describe('holdElapsed', () => {
  it('holds until the time passes', () => {
    expect(holdElapsed(NOW + 60_000, NOW)).toBe(false)
    expect(holdElapsed(NOW - 1, NOW)).toBe(true)
  })

  it('releases early when a fresh reading shows headroom', () => {
    expect(holdElapsed(NOW + 60_000, NOW, 10)).toBe(true)
  })

  it('never extends a hold on a reading that says the quota is spent', () => {
    // A stale cache must not park a run past its own reset time.
    expect(holdElapsed(NOW - 1, NOW, 99)).toBe(true)
  })
})

describe('holdRemaining', () => {
  it('words the wait for a person', () => {
    expect(holdRemaining(NOW + 60_000, NOW)).toBe('in 1 minute')
    expect(holdRemaining(NOW + 90 * 60_000, NOW)).toBe('in 1h 30m')
    expect(holdRemaining(NOW - 1, NOW)).toBe('now')
  })
})

describe('nextStage', () => {
  it('runs council, then swarm, then review, then stops', () => {
    expect(nextStage('council')).toBe('swarm')
    expect(nextStage('swarm')).toBe('review')
    expect(nextStage('review')).toBeUndefined()
  })
})

describe('runPipeline', () => {
  it('advances one stage per call, and one only', async () => {
    const stage = runner({})
    const first = await runPipeline({ state: startPipeline('p1', 'do the thing'), runStage: stage.runStage, now: NOW })
    expect(first.phase).toBe('staged')
    expect(first.state.stage).toBe('swarm')
    expect(stage.seen).toHaveLength(1)
  })

  it('carries the agreed approach into the decomposition', async () => {
    const stage = runner({ council: { report: 'agreed', complete: true, plan: 'use the cache' } })
    const after = await runPipeline({ state: startPipeline('p1', 'q'), runStage: stage.runStage, now: NOW })
    await runPipeline({ state: after.state, runStage: stage.runStage, now: NOW })
    expect(stage.seen[1]?.input).toMatchObject({ plan: 'use the cache' })
  })

  it('stops where a stage stopped at its own gate, without advancing', async () => {
    const stage = runner({ council: { report: 'waiting for approval', complete: false } })
    const out = await runPipeline({ state: startPipeline('p1', 'q'), runStage: stage.runStage, now: NOW })
    expect(out.phase).toBe('staged')
    expect(out.state.stage).toBe('council')
    expect(out.report).toContain('waiting for approval')
  })

  it('reports done after the last stage', async () => {
    const stage = runner({})
    let state: PipelineState = startPipeline('p1', 'q')
    for (let i = 0; i < 3; i += 1) {
      const out = await runPipeline({ state, runStage: stage.runStage, now: NOW })
      state = out.state
      if (i === 2) expect(out.phase).toBe('done')
    }
  })

  it('holds on a spent allowance instead of failing, keeping the stage and the graph', async () => {
    const stage = runner({
      swarm: {
        report: 'partial',
        complete: false,
        failures: [{ seat: 'claude', error: 'usage limit reached · resets 3pm' }],
        tasks: [{ id: 'a', title: 'A', detail: '', dependsOn: [] }],
      },
    })
    const held = await runPipeline({
      state: { id: 'p1', query: 'q', stage: 'swarm', plan: 'the plan' },
      runStage: stage.runStage,
      now: NOW,
    })
    expect(held.phase).toBe('held')
    expect(held.state.stage).toBe('swarm')
    expect(held.state.plan).toBe('the plan')
    expect(held.state.tasks).toHaveLength(1)
    expect(held.report).toContain('Held')
  })

  it('spends nothing at all while the hold stands', async () => {
    const stage = runner({})
    const out = await runPipeline({
      state: {
        id: 'p1',
        query: 'q',
        stage: 'swarm',
        hold: { detail: 'usage limit reached', resumeAt: NOW + 60_000, source: 'stated' },
      },
      runStage: stage.runStage,
      now: NOW,
    })
    expect(out.phase).toBe('held')
    expect(stage.seen).toEqual([])
  })

  it('resumes the same stage once the window rolls over, not the next one', async () => {
    const stage = runner({})
    const out = await runPipeline({
      state: {
        id: 'p1',
        query: 'q',
        stage: 'swarm',
        tasks: [{ id: 'a', title: 'A', detail: '', dependsOn: [] }],
        hold: { detail: 'usage limit reached', resumeAt: NOW - 1, source: 'stated' },
      },
      runStage: stage.runStage,
      now: NOW,
    })
    expect(stage.seen[0]?.stage).toBe('swarm')
    expect(out.state.hold).toBeUndefined()
    // The approved graph survived the hold: resuming costs no new planning call.
    expect(stage.seen[0]?.input).toMatchObject({ tasks: [{ id: 'a' }] })
  })

  it('blocks on a problem waiting cannot fix', async () => {
    const stage = runner({ council: { report: '', complete: false, problems: ['No seat is switched on'] } })
    const out = await runPipeline({ state: startPipeline('p1', 'q'), runStage: stage.runStage, now: NOW })
    expect(out.phase).toBe('blocked')
    expect(out.report).toContain('No seat is switched on')
  })
})
