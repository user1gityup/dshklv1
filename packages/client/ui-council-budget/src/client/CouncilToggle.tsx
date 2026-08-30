/**
 * Compact council switch, seated beside the send button.
 *
 * The budget panel is where the configuration lives; this is the one control
 * worth reaching on the way to sending, so it carries state and nothing else.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './CouncilToggle.module.css'

/** Props for the composer-row council switch. */
export type CouncilToggleProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/**
 * Toggle council mode from the composer row.
 * @param props - locale seat and the council settings scope.
 * @returns the switch.
 */
export function CouncilToggle({ t, settings }: CouncilToggleProps): JSX.Element {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const on = snapshot.value?.['councilMode'] === true

  return (
    <button
      type="button"
      className={on ? `${css.toggle} ${css.on}` : css.toggle}
      aria-pressed={on}
      aria-label={t('mode.on')}
      title={on ? t('mode.on') : t('mode.hint')}
      onClick={() => { void settings.set('councilMode', !on) }}
    >
      <span className={css.disc} aria-hidden="true">{on ? '◉' : '○'}</span>
      <span className={css.label}>{t('mode.title')}</span>
    </button>
  )
}
