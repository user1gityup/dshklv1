import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { WriteSeam } from '../src/writes.ts'
import {
  MAX_WRITES_PER_SEAT,
  MAX_WRITE_CHARS,
  applyWrites,
  parseWriteRequests,
  renderCandidates,
  writeRequestSection,
} from '../src/writes.ts'

const SOURCE = resolve('/repo')
const SEAT_ROOT = resolve('/work/run1/kimi')
const OTHER_SEAT = resolve('/work/run1/deepseek')

/** A seam recording writes, so the tests need no disk. */
function recordingSeam(): { seam: WriteSeam; written: Map<string, string> } {
  const written = new Map<string, string>()
  return {
    written,
    seam: {
      async write(path: string, text: string): Promise<void> {
        written.set(path, text)
      },
    },
  }
}

describe('writeRequestSection', () => {
  it('says nothing when no source root is granted', () => {
    expect(writeRequestSection([])).toBe('')
  })

  it('tells the seat its work does not reach the real repository', () => {
    const section = writeRequestSection([SOURCE])
    expect(section).toContain('WRITE: <path>')
    expect(section).toContain('does not reach the real')
    expect(section).toContain(SOURCE)
  })
})

describe('parseWriteRequests', () => {
  it('pairs a WRITE line with the fenced block under it', () => {
    const reply = ['Here is my version.', 'WRITE: lib/auth.js', '```', 'export const a = 1', '```'].join('\n')
    expect(parseWriteRequests(reply)).toEqual([{ path: 'lib/auth.js', content: 'export const a = 1' }])
  })

  it('keeps the file verbatim, including blank lines and inner backticks', () => {
    const reply = ['WRITE: a.js', '````', 'one', '', '```', 'two', '````'].join('\n')
    expect(parseWriteRequests(reply)[0]?.content).toBe(['one', '', '```', 'two'].join('\n'))
  })

  it('drops a WRITE line with no fenced block rather than guessing', () => {
    const reply = 'WRITE: lib/auth.js\nI would rewrite the whole thing.'
    expect(parseWriteRequests(reply)).toEqual([])
  })

  it('drops a file whose fence was never closed, because it arrived truncated', () => {
    const reply = ['WRITE: a.js', '```', 'export const a = 1'].join('\n')
    expect(parseWriteRequests(reply)).toEqual([])
  })

  it('tolerates blank lines between the header and its fence', () => {
    const reply = ['WRITE: a.js', '', '', '```', 'body', '```'].join('\n')
    expect(parseWriteRequests(reply)[0]?.content).toBe('body')
  })

  it('takes the first version when a seat writes the same path twice', () => {
    const reply = [
      'WRITE: a.js', '```', 'first', '```',
      'WRITE: a.js', '```', 'second', '```',
    ].join('\n')
    const got = parseWriteRequests(reply)
    expect(got).toHaveLength(1)
    expect(got[0]?.content).toBe('first')
  })

  it('caps how many files one seat may propose', () => {
    const reply = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      .map(name => `WRITE: ${name}.js\n\`\`\`\nbody\n\`\`\``)
      .join('\n')
    expect(parseWriteRequests(reply)).toHaveLength(MAX_WRITES_PER_SEAT)
  })
})

describe('applyWrites', () => {
  it('writes into the seat own tree, under the path the seat named', async () => {
    const { seam, written } = recordingSeam()
    const candidate = await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [
      { path: 'lib/auth.js', content: 'export const a = 1' },
    ])
    expect(candidate.files.map(file => file.label)).toEqual(['lib/auth.js'])
    expect(written.get(resolve(SEAT_ROOT, 'lib/auth.js'))).toBe('export const a = 1')
  })

  it('never writes into the source tree itself', async () => {
    const { seam, written } = recordingSeam()
    await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [{ path: 'lib/auth.js', content: 'x' }])
    expect([...written.keys()].some(path => path.startsWith(SOURCE))).toBe(false)
  })

  it('refuses a path that names nothing inside the granted roots', async () => {
    const { seam, written } = recordingSeam()
    const candidate = await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [
      { path: '../../etc/passwd', content: 'x' },
    ])
    expect(candidate.files).toEqual([])
    expect(candidate.refused[0]).toContain('does not name a file')
    expect(written.size).toBe(0)
  })

  it('cannot reach another seat candidate', async () => {
    const { seam, written } = recordingSeam()
    await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [{ path: 'lib/auth.js', content: 'x' }])
    expect([...written.keys()].some(path => path.startsWith(OTHER_SEAT))).toBe(false)
  })

  it('refuses an oversized file rather than truncating it', async () => {
    const { seam } = recordingSeam()
    const candidate = await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [
      { path: 'big.js', content: 'x'.repeat(MAX_WRITE_CHARS + 1) },
    ])
    expect(candidate.files).toEqual([])
    expect(candidate.refused[0]).toContain('over the')
  })

  it('reports a write that failed without losing the rest', async () => {
    const written = new Map<string, string>()
    const seam: WriteSeam = {
      async write(path: string, text: string): Promise<void> {
        if (path.endsWith('bad.js')) throw new Error('EACCES')
        written.set(path, text)
      },
    }
    const candidate = await applyWrites(seam, SEAT_ROOT, [SOURCE], 'kimi', [
      { path: 'bad.js', content: 'x' },
      { path: 'good.js', content: 'y' },
    ])
    expect(candidate.files.map(file => file.label)).toEqual(['good.js'])
    expect(candidate.refused.join(' ')).toContain('EACCES')
  })

  it('refuses everything when proposing is switched off', async () => {
    const candidate = await applyWrites(undefined, SEAT_ROOT, [SOURCE], 'kimi', [
      { path: 'a.js', content: 'x' },
    ])
    expect(candidate.files).toEqual([])
    expect(candidate.refused[0]).toContain('switched off')
  })
})

describe('renderCandidates', () => {
  it('names each seat, its files, and what it could not write', () => {
    const rendered = renderCandidates([
      { seat: 'kimi', root: SEAT_ROOT, files: [{ label: 'a.js', path: 'p', chars: 10 }], refused: ['b.js — nope'] },
    ])
    expect(rendered).toContain('kimi')
    expect(rendered).toContain('a.js')
    expect(rendered).toContain('not written: b.js — nope')
  })
})
