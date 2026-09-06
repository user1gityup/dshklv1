/**
 * Presence and placement: the panel must register above the council budget,
 * and it must bind the namespace the host publishes into. Both are silent
 * failures otherwise — a slot at the wrong order simply renders below, and a
 * mistyped namespace simply renders an empty panel.
 */
import { describe, expect, it, vi } from 'vitest'

describe('claude-quota plugin', () => {
  it('exports the services it needs', async () => {
    const mod = await import('../src/client/index.ts')
    expect(Array.isArray(mod.inject)).toBe(true)
    expect(mod.inject).toContain('slots')
    expect(mod.inject).toContain('settingsScope')
  })

  it('registers above the council budget panel and binds claude-quota', async () => {
    const mod = await import('../src/client/index.ts')
    const register = vi.fn()
    const bind = vi.fn(() => ({}))
    mod.apply({
      effect: (run: () => unknown) => { run() },
      locale: { register: vi.fn(() => () => undefined) },
      slots: { register },
      settingsScope: { bind },
    } as never)

    expect(register).toHaveBeenCalledTimes(1)
    const [spec] = register.mock.calls[0] as [{ name: string; order: number; inject: () => unknown }]
    expect(spec.name).toBe('sidebar.region.action')
    // The council budget registers at order 1; this must sort before it.
    expect(spec.order).toBeLessThan(1)
    spec.inject()
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'claude-quota' }))
  })

  it('ships both dictionaries with the same keys', async () => {
    const { en, zh } = await import('../src/client/locales.ts')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(typeof en['panel.title']).toBe('string')
    expect(typeof en['refresh.cost']).toBe('string')
  })
})
