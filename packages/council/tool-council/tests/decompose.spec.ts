import { describe, expect, it } from 'vitest'
import {
  decomposePrompt, executionWaves, parseDecomposition, validateGraph,
} from '../src/decompose.ts'
import type { SubTask } from '../src/decompose.ts'

/** Build a task with sensible defaults. */
function task(id: string, dependsOn: string[] = []): SubTask {
  return { id, title: id, detail: '', dependsOn }
}

describe('decomposePrompt', () => {
  it('names the providers a worker may run on', () => {
    const prompt = decomposePrompt('q', 'a', ['claude-code', 'codex'])
    expect(prompt).toContain('claude-code, codex')
  })

  it('says so plainly when no provider is registered', () => {
    expect(decomposePrompt('q', 'a', [])).toContain('(none registered)')
  })

  it('carries both the question and the agreed approach', () => {
    const prompt = decomposePrompt('THE QUESTION', 'THE APPROACH', [])
    expect(prompt).toContain('THE QUESTION')
    expect(prompt).toContain('THE APPROACH')
  })
})

describe('parseDecomposition', () => {
  it('reads a fenced json block', () => {
    const reply = 'Here is the split:\n```json\n[{"id":"a","title":"A","detail":"d","dependsOn":[]}]\n```\nDone.'
    const out = parseDecomposition(reply)
    expect(out.tasks).toHaveLength(1)
    expect(out.tasks[0]?.id).toBe('a')
    expect(out.problems).toEqual([])
  })

  it('reads a bare array with prose around it', () => {
    const out = parseDecomposition('sure: [{"id":"a","title":"A","dependsOn":[]}] hope that helps')
    expect(out.tasks).toHaveLength(1)
  })

  it('reports a reply containing no json rather than throwing', () => {
    const out = parseDecomposition('I would split this into three parts, roughly.')
    expect(out.tasks).toEqual([])
    expect(out.problems[0]).toContain('no readable json')
  })

  it('discards entries with no id or title, and says how many', () => {
    const reply = '[{"id":"a","title":"A","dependsOn":[]},{"detail":"orphan"}]'
    const out = parseDecomposition(reply)
    expect(out.tasks).toHaveLength(1)
    expect(out.problems.some(p => p.includes('discarded'))).toBe(true)
  })

  it('keeps a suggested provider and drops an empty one', () => {
    const reply = '[{"id":"a","title":"A","dependsOn":[],"provider":"codex"},'
      + '{"id":"b","title":"B","dependsOn":[],"provider":"  "}]'
    const out = parseDecomposition(reply)
    expect(out.tasks[0]?.provider).toBe('codex')
    expect(out.tasks[1]?.provider).toBeUndefined()
  })
})

describe('validateGraph', () => {
  it('accepts a graph with a startable unit', () => {
    expect(validateGraph([task('a'), task('b', ['a'])])).toEqual([])
  })

  it('rejects an empty graph', () => {
    expect(validateGraph([])[0]).toContain('no units')
  })

  it('catches a dependency on a unit that does not exist', () => {
    const problems = validateGraph([task('a', ['ghost'])])
    expect(problems.some(p => p.includes('ghost'))).toBe(true)
  })

  it('catches a duplicate id', () => {
    const problems = validateGraph([task('a'), task('a')])
    expect(problems.some(p => p.includes('duplicate'))).toBe(true)
  })

  it('catches a self-dependency', () => {
    const problems = validateGraph([task('a', ['a'])])
    expect(problems.some(p => p.includes('itself'))).toBe(true)
  })

  it('catches a cycle, which would deadlock a swarm', () => {
    const problems = validateGraph([task('a', ['b']), task('b', ['a'])])
    expect(problems.some(p => p.includes('circular'))).toBe(true)
  })

  it('catches a graph where nothing can start', () => {
    const problems = validateGraph([task('a', ['b']), task('b', ['a'])])
    expect(problems.some(p => p.includes('nothing can start'))).toBe(true)
  })
})

describe('executionWaves', () => {
  it('puts independent units in one wave', () => {
    const waves = executionWaves([task('a'), task('b'), task('c')])
    expect(waves).toHaveLength(1)
    expect(waves[0]).toHaveLength(3)
  })

  it('orders dependants into later waves', () => {
    const waves = executionWaves([task('a'), task('b', ['a']), task('c', ['b'])])
    expect(waves.map(w => w.map(t => t.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('runs siblings of a shared dependency together', () => {
    const waves = executionWaves([task('root'), task('x', ['root']), task('y', ['root'])])
    expect(waves).toHaveLength(2)
    expect(waves[1]?.map(t => t.id).sort()).toEqual(['x', 'y'])
  })

  it('stops rather than spinning on a cyclic graph', () => {
    // validateGraph rejects these, but the wave planner must not hang if one
    // ever reaches it.
    expect(executionWaves([task('a', ['b']), task('b', ['a'])])).toEqual([])
  })
})
