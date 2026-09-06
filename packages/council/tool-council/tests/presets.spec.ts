import { describe, expect, it } from 'vitest'
import { listPresets, presetIdProblem, removePreset, renderPresets, savePreset, MAX_QUERY } from '../src/presets.ts'
import type { PresetMap } from '../src/presets.ts'

const HELD: PresetMap = {
  'dsh/gate-audit': { name: 'Gate audit', query: 'audit the gates' },
  'web/ship-landing': { name: 'Ship landing', query: 'ship the landing page', autoAdvance: true },
}

describe('presetIdProblem', () => {
  it('accepts area/name in lowercase kebab', () => {
    expect(presetIdProblem('dsh/gate-audit')).toBeUndefined()
    expect(presetIdProblem('green/solar-quote-flow')).toBeUndefined()
  })

  it('insists on an area, because a flat list cannot be scanned', () => {
    expect(presetIdProblem('gate-audit')).toContain('no area')
  })

  it('rejects capitals, spaces and extra segments', () => {
    expect(presetIdProblem('DSH/Gate-Audit')).toContain('lowercase kebab')
    expect(presetIdProblem('dsh/gate audit')).toContain('lowercase kebab')
    expect(presetIdProblem('dsh/a/b')).toContain('exactly')
    expect(presetIdProblem(' dsh/a')).toContain('whitespace')
  })
})

describe('savePreset', () => {
  it('adds a preset and leaves the others alone', () => {
    const out = savePreset(HELD, 'dsh/smoke', { name: 'Smoke', query: 'run the smoke test' })
    expect(out.problem).toBeUndefined()
    expect(Object.keys(out.presets)).toHaveLength(3)
    expect(out.presets['dsh/gate-audit']).toEqual(HELD['dsh/gate-audit'])
  })

  it('refuses to overwrite a familiar button by accident', () => {
    const out = savePreset(HELD, 'dsh/gate-audit', { name: 'Other', query: 'something else' })
    expect(out.problem).toContain('already exists')
    expect(out.presets).toEqual(HELD)
  })

  it('overwrites when told to, and says so', () => {
    const out = savePreset(HELD, 'dsh/gate-audit', { name: 'Other', query: 'something else' }, true)
    expect(out.problem).toBeUndefined()
    expect(out.replaced).toBe(true)
    expect(out.presets['dsh/gate-audit']?.name).toBe('Other')
  })

  it('will not save an empty request', () => {
    expect(savePreset(HELD, 'dsh/x', { name: 'X', query: '   ' }).problem).toContain('no request')
  })

  it('caps the request, since a whole document belongs in a file', () => {
    const out = savePreset(HELD, 'dsh/x', { name: 'X', query: 'a'.repeat(MAX_QUERY + 1) })
    expect(out.problem).toContain('at most')
  })

  it('never leaves a blank button when no name is given', () => {
    const out = savePreset({}, 'dsh/gate-audit', { name: '', query: 'q' })
    expect(out.presets['dsh/gate-audit']?.name).toBe('gate-audit')
  })

  it('touches nothing but the presets it was given', () => {
    // The whole reason this module exists: no approval key is reachable here.
    const out = savePreset(HELD, 'dsh/new', { name: 'New', query: 'q' })
    expect(Object.keys(out.presets).every(key => key.includes('/'))).toBe(true)
  })
})

describe('removePreset', () => {
  it('removes one and reports an id that was never there', () => {
    expect(Object.keys(removePreset(HELD, 'dsh/gate-audit').presets)).toEqual(['web/ship-landing'])
    expect(removePreset(HELD, 'dsh/nope').problem).toContain('no preset')
  })
})

describe('listPresets', () => {
  it('sorts by id so an area groups itself', () => {
    const ids = listPresets({ ...HELD, 'dsh/apply': { name: 'A', query: 'q' } }).map(([id]) => id)
    expect(ids).toEqual(['dsh/apply', 'dsh/gate-audit', 'web/ship-landing'])
  })
})

describe('renderPresets', () => {
  it('groups the report by area and marks the ones that advance themselves', () => {
    const text = renderPresets(HELD)
    expect(text).toContain('**dsh**')
    expect(text).toContain('**web**')
    expect(text).toContain('advances itself')
  })

  it('says so when there are none', () => {
    expect(renderPresets({})).toContain('No saved runs')
  })
})
