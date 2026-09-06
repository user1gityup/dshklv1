import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { FileSeam } from '../src/files.ts'
import {
  MAX_FILE_CHARS,
  MAX_READS_PER_SEAT,
  MAX_READS_TOTAL,
  gatherFiles,
  parseReadRequests,
  parseRoots,
  readRequestSection,
  resolveWithinRoots,
} from '../src/files.ts'

const ROOT = resolve('/repo')
const OTHER = resolve('/other')

/** A seam over an in-memory map, so the tests need no disk. */
function seamOf(contents: Readonly<Record<string, string>>): FileSeam {
  return {
    async read(path: string): Promise<string> {
      const text = contents[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  }
}

describe('parseRoots', () => {
  it('is empty when nothing is configured, so nothing is readable by default', () => {
    expect(parseRoots(undefined)).toEqual([])
    expect(parseRoots('')).toEqual([])
    expect(parseRoots('   ')).toEqual([])
  })

  it('splits on commas, absolutises, and drops duplicates', () => {
    const roots = parseRoots(' /repo , /other ,/repo')
    expect(roots).toEqual([ROOT, OTHER])
  })
})

describe('readRequestSection', () => {
  it('says nothing when no root is granted, so no seat is told it can ask', () => {
    expect(readRequestSection([])).toBe('')
  })

  it('names the roots and the per-seat limit', () => {
    const section = readRequestSection([ROOT])
    expect(section).toContain('READ: <path>')
    expect(section).toContain(ROOT)
    expect(section).toContain(String(MAX_READS_PER_SEAT))
  })
})

describe('parseReadRequests', () => {
  it('pulls READ lines out of surrounding prose', () => {
    const reply = [
      'I would need to see the auth code.',
      'READ: lib/auth.js',
      'SEARCH: prisma migrations',
      'read: lib/session.js',
    ].join('\n')
    expect(parseReadRequests(reply)).toEqual(['lib/auth.js', 'lib/session.js'])
  })

  it('strips quoting and deduplicates case-insensitively', () => {
    const reply = 'READ: "lib/auth.js"\nREAD: LIB/AUTH.JS\nREAD: `lib/session.js`'
    expect(parseReadRequests(reply)).toEqual(['lib/auth.js', 'lib/session.js'])
  })

  it('caps how many one seat may ask for', () => {
    const reply = ['a', 'b', 'c', 'd', 'e'].map(name => `READ: ${name}.js`).join('\n')
    expect(parseReadRequests(reply)).toHaveLength(MAX_READS_PER_SEAT)
  })

  it('ignores an empty or absurdly long path', () => {
    const reply = `READ:   \nREAD: ${'x'.repeat(400)}\nREAD: ok.js`
    expect(parseReadRequests(reply)).toEqual(['ok.js'])
  })
})

describe('resolveWithinRoots', () => {
  it('resolves a relative path inside a root and labels it with forward slashes', () => {
    const found = resolveWithinRoots('lib/auth.js', [ROOT])
    expect(found?.path).toBe(resolve(ROOT, 'lib/auth.js'))
    expect(found?.label).toBe('lib/auth.js')
  })

  it('refuses traversal above a root even when it starts inside one', () => {
    expect(resolveWithinRoots('lib/../../secrets.txt', [ROOT])).toBeUndefined()
    expect(resolveWithinRoots('../secrets.txt', [ROOT])).toBeUndefined()
  })

  it('refuses an absolute path outside every root, and accepts one inside', () => {
    expect(resolveWithinRoots(resolve('/etc/passwd'), [ROOT])).toBeUndefined()
    expect(resolveWithinRoots(resolve(ROOT, 'lib/auth.js'), [ROOT])?.label).toBe('lib/auth.js')
  })

  it('refuses the root itself and a NUL-bearing path', () => {
    expect(resolveWithinRoots('.', [ROOT])).toBeUndefined()
    expect(resolveWithinRoots('lib/\0auth.js', [ROOT])).toBeUndefined()
  })

  it('tries every root before giving up', () => {
    expect(resolveWithinRoots('app.js', [ROOT, OTHER])?.path).toBe(resolve(ROOT, 'app.js'))
    expect(resolveWithinRoots(resolve(OTHER, 'app.js'), [ROOT, OTHER])?.label).toBe('app.js')
  })
})

describe('gatherFiles', () => {
  const seam = seamOf({
    [resolve(ROOT, 'lib/auth.js')]: 'export const auth = 1',
    [resolve(ROOT, 'lib/session.js')]: 'export const session = 2',
    [resolve(ROOT, 'big.js')]: 'x'.repeat(MAX_FILE_CHARS + 500),
    [resolve(ROOT, 'binary.bin')]: 'head\0tail',
  })

  it('reads nothing when no root is granted', async () => {
    const got = await gatherFiles(seam, [], [{ seat: 'kimi', paths: ['lib/auth.js'] }])
    expect(got).toBeUndefined()
  })

  it('reads nothing when no seam is supplied', async () => {
    const got = await gatherFiles(undefined, [ROOT], [{ seat: 'kimi', paths: ['lib/auth.js'] }])
    expect(got).toBeUndefined()
  })

  it('serves a requested file and names who asked', async () => {
    const got = await gatherFiles(seam, [ROOT], [{ seat: 'kimi', paths: ['lib/auth.js'] }])
    expect(got?.paths).toEqual(['lib/auth.js'])
    expect(got?.block).toContain('export const auth = 1')
    expect(got?.block).toContain('asked by kimi')
    expect(got?.block).toContain('[F1] lib/auth.js')
  })

  it('reads one file once when two seats ask for it differently', async () => {
    const got = await gatherFiles(seam, [ROOT], [
      { seat: 'kimi', paths: ['lib/auth.js'] },
      { seat: 'deepseek', paths: [resolve(ROOT, 'lib/auth.js')] },
    ])
    expect(got?.paths).toEqual(['lib/auth.js'])
    expect(got?.block).toContain('asked by kimi, deepseek')
  })

  it('refuses a path outside the roots and says so in the block', async () => {
    const got = await gatherFiles(seam, [ROOT], [{ seat: 'kimi', paths: ['../secrets.txt'] }])
    expect(got?.paths).toEqual([])
    expect(got?.refused[0]).toContain('outside the directories')
    expect(got?.block).toContain('NOT SHOWN:')
  })

  it('reports an unreadable file without losing the others', async () => {
    const got = await gatherFiles(seam, [ROOT], [
      { seat: 'kimi', paths: ['missing.js', 'lib/auth.js'] },
    ])
    expect(got?.paths).toEqual(['lib/auth.js'])
    expect(got?.refused.join(' ')).toContain('missing.js')
  })

  it('marks truncation rather than trimming silently', async () => {
    const got = await gatherFiles(seam, [ROOT], [{ seat: 'kimi', paths: ['big.js'] }])
    expect(got?.block).toContain(`showing ${String(MAX_FILE_CHARS)} of ${String(MAX_FILE_CHARS + 500)}`)
  })

  it('refuses a file that is not text', async () => {
    const got = await gatherFiles(seam, [ROOT], [{ seat: 'kimi', paths: ['binary.bin'] }])
    expect(got?.paths).toEqual([])
    expect(got?.refused.join(' ')).toContain('not a text file')
  })

  it('caps how many files one run reads however many seats ask', async () => {
    const many: Record<string, string> = {}
    const paths: string[] = []
    for (let index = 0; index < MAX_READS_TOTAL + 4; index += 1) {
      const name = `f${String(index)}.js`
      many[resolve(ROOT, name)] = `file ${String(index)}`
      paths.push(name)
    }
    const got = await gatherFiles(
      seamOf(many),
      [ROOT],
      paths.map((path, index) => ({ seat: `seat${String(index)}`, paths: [path] })),
    )
    expect(got?.paths).toHaveLength(MAX_READS_TOTAL)
  })
})
