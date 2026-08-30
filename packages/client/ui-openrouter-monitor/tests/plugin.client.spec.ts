/**
 * Basic presence test: the plugin should register a sidebar footer action.
 */
import { describe, it, expect } from 'vitest'

describe('openrouter-monitor plugin', () => {
  it('exports inject array', async () => {
    const mod = await import('../src/client/index.ts')
    expect(Array.isArray(mod.inject)).toBe(true)
    expect(mod.inject).toContain('slots')
  })

  it('exports apply function', async () => {
    const mod = await import('../src/client/index.ts')
    expect(typeof mod.apply).toBe('function')
  })

  it('locales have all keys defined', async () => {
    const { en } = await import('../src/client/locales.ts')
    expect(typeof en['trigger.aria']).toBe('string')
    expect(typeof en['panel.title']).toBe('string')
    expect(typeof en['balance.label']).toBe('string')
  })
})
