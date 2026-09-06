/**
 * Swarm switch, seated beside the council switch in the composer row.
 *
 * Separate from council mode on purpose: they are different commitments.
 * Council mode spends money to think; swarm mode spends money to *act*, with
 * workers that write files and run commands. Fusing them into one switch would
 * make the larger commitment invisible inside the smaller one.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './CouncilToggle.module.css'

/** Props for the composer-row swarm switch. */
export type SwarmToggleProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/**
 * Toggle swarm mode from the composer row.
 * @param props - locale seat and the council settings scope.
 * @returns the switch.
 */
export function SwarmToggle({ t, settings }: SwarmToggleProps): JSX.Element {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const on = snapshot.value?.['swarmMode'] === true

  return (
    <button
      type="button"
      className={on ? `${css.toggle} ${css.on}` : css.toggle}
      aria-pressed={on}
      aria-label={t('swarm.toggleLabel')}
      title={on ? t('swarm.toggleOn') : t('swarm.toggleHint')}
      onClick={() => { void settings.set('swarmMode', !on) }}
    >
      <span className={css.disc} aria-hidden="true">{on ? '⣿' : '⣀'}</span>
      <span className={css.label}>{t('swarm.toggleTitle')}</span>
    </button>
  )
}
