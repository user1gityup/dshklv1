// @vitest-environment jsdom
/**
 * Picking which seat's version gets built.
 *
 * The proposing stage leaves several complete versions of the same change, each
 * in a tree of its own, and the chain cannot advance until a person says which
 * one to build. That decision lives on the gate strip rather than in the
 * transcript for the same reason Approve does: by the time the candidates have
 * finished printing they are thousands of words up the column, and a choice the
 * run is blocked on must stay where it does not scroll away.
 *
 * These cover the deciding, not the drawing: which candidates count as waiting,
 * what the pick says when it is sent, and how a folded panel counts its stages.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GateStrip, pickCandidates, pickMessage } from '../src/client/GateStrip.tsx'
import type { GateStripProps } from '../src/client/GateStrip.tsx'
import { readStages, startPrompt } from '../src/client/PipelineControl.tsx'

afterEach(cleanup)

/** Two seats' versions, as the host stores them. */
const WRITTEN = JSON.stringify([
  { seat: 'claude', root: '/w/claude', files: 4 },
  { seat: 'kimi', root: '/w/kimi', files: 3 },
])

describe('pickCandidates', () => {
  it('offers the versions the proposing stage wrote', () => {
    const picks = pickCandidates({ pipelineCandidates: WRITTEN })
    expect(picks.map(one => one.seat)).toEqual(['claude', 'kimi'])
    expect(picks[0]?.files).toBe(4)
  })

  it('offers nothing before a proposing stage has run', () => {
    expect(pickCandidates({})).toEqual([])
    expect(pickCandidates({ pipelineCandidates: '' })).toEqual([])
  })

  it('stops offering once the pick is made', () => {
    // The strip is for what BLOCKS the run. A pick already made does not.
    expect(pickCandidates({ pipelineCandidates: WRITTEN, pipelinePicked: 'claude' })).toEqual([])
  })

  it('treats an unreadable store as nothing waiting, not as a broken picker', () => {
    expect(pickCandidates({ pipelineCandidates: '{ not json' })).toEqual([])
    expect(pickCandidates({ pipelineCandidates: '[{"seat":"claude"}]' })).toEqual([])
  })
})

describe('pickMessage', () => {
  it('says nothing until something is picked', () => {
    expect(pickMessage([])).toBe('')
  })

  it('names the one version to build', () => {
    expect(pickMessage(['claude'])).toBe('Build from the claude version.')
  })

  it('says plainly that several picks mean a merge', () => {
    // Without the word, the next stage builds the first and drops the rest.
    expect(pickMessage(['claude', 'kimi'])).toBe('Build from these versions, merged: claude, kimi.')
  })
})

describe('readStages', () => {
  it('defaults a run stored before the order was configurable', () => {
    expect(readStages(undefined)).toEqual(['council', 'swarm', 'review'])
    expect(readStages('')).toEqual(['council', 'swarm', 'review'])
  })

  it('counts the four stages a build run actually has', () => {
    // "Stage 2 of 3" on a four-stage run reads as one that overran.
    expect(readStages('council,propose,swarm,review')).toHaveLength(4)
  })

  it('drops a name this build does not know rather than refusing to count', () => {
    expect(readStages('council,deploy,review')).toEqual(['council', 'review'])
  })
})

describe('startPrompt', () => {
  it('asks for the default chain when no order is given', () => {
    expect(startPrompt('do the thing')).not.toContain('stages')
  })

  it('carries the order, which is the only channel the panel has to the tool', () => {
    // A saved build run that could not say `propose` here got the three-stage
    // chain whatever its text described, and produced no code samples at all.
    expect(startPrompt('build it', 'council,propose,swarm,review'))
      .toContain('Pass stages as `council,propose,swarm,review`.')
  })
})

/** A settings scope over a fixed section, recording every write. */
function scope(section: Record<string, unknown>) {
  const writes: [string, unknown][] = []
  const snapshot = { status: 'ready' as const, value: section, base: undefined, user: undefined, revision: 1 }
  const settings = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: (field: string, value: unknown) => {
      writes.push([field, value])
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  }
  return { settings, writes }
}

describe('picking on the gate strip', () => {
  /**
   * Mount the strip over the two versions the proposing stage left.
   * @param send - the send face under test.
   * @returns the recorded settings writes.
   */
  function mount(send: (text: string) => Promise<void>) {
    const { settings, writes } = scope({ pipelineCandidates: WRITTEN })
    render(<GateStrip {...({ settings, send } as unknown as GateStripProps)} />)
    return { writes }
  }

  it('offers every version, and builds nothing until one is chosen', () => {
    mount(async () => {})
    expect(screen.getByText('Pick a version')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose one or more/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^claude/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^kimi/ })).toBeTruthy()
  })

  it('keeps both picks when two land in one render batch', () => {
    // The regression: a handler that read the array captured at render time
    // let the second click replace the first, so a merge silently became a
    // single winner — the one thing multi-select exists to prevent.
    mount(async () => {})
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^claude/ }))
      fireEvent.click(screen.getByRole('button', { name: /^kimi/ }))
    })
    expect(screen.getByRole('button', { name: /Send/ }).textContent)
      .toContain('Build from these versions, merged: claude, kimi.')
  })

  it('unpicks the same way it picked', () => {
    mount(async () => {})
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^claude/ })) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^claude/ })) })
    expect(screen.getByRole('button', { name: /Choose one or more/ })).toBeTruthy()
  })

  it('writes the pick before sending it, because the next stage reads the key', () => {
    const send = vi.fn(async () => {})
    const { writes } = mount(send)
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^kimi/ })) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Send/ })) })
    expect(writes).toContainEqual(['pipelinePicked', 'kimi'])
    expect(send).toHaveBeenCalledWith('Build from the kimi version.')
  })
})
