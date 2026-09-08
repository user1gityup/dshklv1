// @vitest-environment jsdom
/**
 * A press that never reaches the session must SAY so, and must consume
 * nothing.
 *
 * The original control swallowed `conversation.send`'s rejection: it wrote
 * `pipelineAuto`, cleared the picked run and set busy, all before knowing the
 * prompt had landed. A wedged session therefore looked exactly like a dead
 * button — pill cleared, transcript empty, panel silent. These tests pin the
 * opposite behaviour: the reason is shown, the pick survives, and the flag is
 * only written once the session has taken the prompt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { PipelineControl, type PipelineControlProps } from '../src/client/PipelineControl.tsx'
import type { SettingsFace } from '../src/client/CouncilBudget.tsx'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'pipeline.title': 'Pipeline',
  'pipeline.hint': 'hint',
  'pipeline.run': 'Run pipeline',
  'pipeline.presets': 'Saved runs',
  'pipeline.placeholder': 'What should the chain work on?',
  'pipeline.failed': 'The prompt did not reach the session — nothing was sent. Reason:',
  'pipeline.idle': 'idle',
  'pipeline.minimize': 'Minimize',
  'pipeline.expand': 'Expand',
  'pipeline.style': 'Minimize style',
  'pipeline.styleOff': 'None',
  'pipeline.styleChevron': 'Chevron',
  'pipeline.stylePill': 'Pill',
  'pipeline.styleRail': 'Rail',
  'pipeline.styleAuto': 'Auto',
}

/** Empty global standard-kit hooks (the control reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/** A settings scope over a fixed section, recording every write. */
function scope(section: Record<string, unknown>): { face: SettingsFace; writes: [string, unknown][] } {
  const writes: [string, unknown][] = []
  const snapshot = { status: 'ready' as const, value: section, base: undefined, user: undefined, revision: 1 }
  const face = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: (field: string, value: unknown) => {
      writes.push([field, value])
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  } as unknown as SettingsFace
  return { face, writes }
}

/**
 * Mount the control with one saved run and a send of the caller's choosing.
 * @param send - the send face under test.
 * @returns the recorded settings writes.
 */
function mount(send: (text: string) => Promise<void>) {
  const { face, writes } = scope({
    pipelinePresets: { 'dsh/demo': { name: 'Demo run', query: 'do the thing', autoAdvance: true } },
    pipelineMinimizeStyle: 'off',
  })
  const props = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    t: (key: string) => COPY[key] ?? key,
    settings: face,
    send,
  } as unknown as PipelineControlProps
  render(<PipelineControl {...props} />)
  return { writes }
}

/** Pick the saved run, then press Run. */
async function pickAndRun(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Demo run/ }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
    await Promise.resolve()
  })
}

describe('PipelineControl send failures', () => {
  it('shows the reason when the session refuses the prompt', async () => {
    const send = vi.fn(async () => { throw new Error('conversation.send failed: busy: session is not accepting prompts') })
    mount(send)
    await pickAndRun()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('did not reach the session')
    expect(alert.textContent).toContain('session is not accepting prompts')
  })

  it('keeps the saved run picked and writes no flag when the send fails', async () => {
    const send = vi.fn(async () => { throw new Error('no scope') })
    const { writes } = mount(send)
    await pickAndRun()

    // Still aimed at the same run, so pressing again repeats it verbatim.
    expect(screen.getByRole('button', { name: /Demo run/ }).getAttribute('aria-pressed')).toBe('true')
    expect(writes.some(([field]) => field === 'pipelineAuto')).toBe(false)
  })

  it('writes the run\'s auto-advance flag and clears the pick once the send lands', async () => {
    const send = vi.fn(async (_text: string) => {})
    const { writes } = mount(send)
    await pickAndRun()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toContain('do the thing')
    expect(writes).toContainEqual(['pipelineAuto', true])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
