// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SwarmRoster, type SwarmRosterProps } from '../src/client/SwarmRoster.tsx'
import { startPrompt } from '../src/client/PipelineControl.tsx'
afterEach(cleanup)
function mount(section: Record<string, unknown>) {
  const set = vi.fn(async () => {})
  const snapshot = { value: { swarmMode: true, ...section } }
  const settings = { getSnapshot: () => snapshot, subscribe: () => () => {}, set }
  const props = { t: (key: string) => key, settings } as unknown as SwarmRosterProps
  render(<SwarmRoster {...props} />)
  return set
}
it('saves the selected swarm mode without starting execution', () => {
  const set = mount({})
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'economy' } })
  expect(set).toHaveBeenCalledExactlyOnceWith('swarmProfile', 'economy')
})
it('locks mode selection while an approval or pipeline is held', () => {
  mount({ pendingSwarmId: 'approved-graph', swarmProfile: 'fastest' })
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
})
it('includes the saved mode in the exact pipeline prompt', () => {
  expect(startPrompt('build it', '', 'economy')).toContain('Pass mode as `economy`.')
})
