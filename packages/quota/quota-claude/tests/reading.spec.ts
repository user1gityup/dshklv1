/**
 * Parsing and publishing the quota reading.
 *
 * The `/usage` text is prose, so the parser's contract is "read what is there,
 * drop what is not" — and the publisher's contract is that a dropped field
 * still reaches the panel as the absent sentinel, because a settings write
 * cannot clear a field with `undefined`.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUsable, parseUsage, readCache, writeCache } from '../src/reading.ts'
import { ABSENT, Config, publishable } from '../src/index.ts'

/** A full answer, worded as the CLI words it. */
const FULL = [
  'Current session: 97% used · resets 2:00am',
  'Current week (all models): 17% used · resets Sep 8',
  'Last 24h · 229 requests · 6 sessions',
  'Last 7d · 1204 requests · 41 sessions',
  '99% of your usage was at > 150k context',
  '83% of your usage came from sessions active for 8+ hours',
].join('\n')

describe('parseUsage', () => {
  it('reads every documented field', () => {
    const reading = parseUsage(FULL, 1_000)
    expect(reading).toMatchObject({
      sessionPercent: 97,
      sessionResets: '2:00am',
      weekPercent: 17,
      weekResets: 'Sep 8',
      requests24h: 229,
      sessions24h: 6,
      requests7d: 1204,
      sessions7d: 41,
      bigContextPercent: 99,
      bigContextThresholdK: 150,
      longSessionPercent: 83,
      longSessionHours: 8,
      capturedAt: 1_000,
    })
  })

  it('drops one field rather than the whole reading when wording changes', () => {
    const reading = parseUsage('Current session: 12% used\nLast 24h · 3 requests · 1 sessions')
    expect(reading.sessionPercent).toBe(12)
    expect(reading.sessionResets).toBeUndefined()
    expect(reading.weekPercent).toBeUndefined()
    expect(reading.requests24h).toBe(3)
  })

  it('treats a reading with no percentage as unusable, not as a quota at zero', () => {
    expect(isUsable(parseUsage(''))).toBe(false)
    expect(isUsable(parseUsage('Current session: 0% used'))).toBe(true)
  })
})

describe('cache', () => {
  it('round-trips a reading', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'quota-')), 'usage-cache.json')
    writeCache(parseUsage(FULL, 5), path)
    expect(readCache(path)?.sessionPercent).toBe(97)
  })

  it('ignores a cache that is missing or unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-'))
    expect(readCache(join(dir, 'absent.json'))).toBeUndefined()
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    expect(readCache(broken)).toBeUndefined()
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '{}')
    expect(readCache(empty)).toBeUndefined()
  })
})

describe('publishable', () => {
  it('spells absent fields out, because undefined would leave them unchanged', () => {
    const published = publishable(parseUsage('Current session: 4% used', 7))
    expect(published.sessionPercent).toBe(4)
    expect(published.weekPercent).toBe(ABSENT)
    expect(published.weekResets).toBe('')
    expect(published.capturedAt).toBe(7)
  })

  it('keeps a real zero apart from an absent reading', () => {
    expect(publishable(parseUsage('Current session: 0% used')).sessionPercent).toBe(0)
  })
})

describe('Config', () => {
  // Schemastery materialises defaults into nested objects, and a nested
  // required field then fails before any code runs. Flat scalars only.
  it('resolves an empty section', () => {
    expect(() => Config({})).not.toThrow()
    expect(Config({}).sessionPercent).toBe(ABSENT)
    expect(Config({}).refreshRequestedAt).toBe(0)
  })
})
