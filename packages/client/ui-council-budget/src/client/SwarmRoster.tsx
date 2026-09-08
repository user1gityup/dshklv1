/**
 * Swarm roster: who does what, and what it costs to have them do it.
 *
 * The workers a swarm may use ARE the council's seats. There is no separate,
 * hard-coded worker list: whatever agent the user configured in the budget
 * panel — a shipped seat, a re-pointed model, an extra OpenRouter seat they
 * added themselves — is offered here, on the same routing. A worker list of
 * its own would mean configuring the same agents twice and drifting from the
 * seats the moment either side changed.
 *
 * The panel exists because the assignment policy has a strong default —
 * subscription seats carry the code — and a default that cannot be seen or
 * overridden is just a hidden decision. Every worker shows how it bills and
 * which model it runs, so the cost consequence of switching one on is visible
 * at the moment of switching it on rather than afterwards on a bill.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import type { PanelSeat } from './capacity.ts'
import { seatsFrom } from './capacity.ts'
import { NS } from './locales.ts'
import css from './SwarmRoster.module.css'

/** Props for the roster panel. */
export type SwarmRosterProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/** Kinds of work a worker can be assigned. */
const KINDS = ['code', 'tests', 'docs', 'research', 'review'] as const

/** Kinds a seat takes when the user has not said otherwise. */
const DEFAULT_KINDS: readonly string[] = ['code', 'tests', 'docs', 'research', 'review']

/** One seat as the swarm understands it. */
interface RosterWorker {
  readonly seat: PanelSeat
  /** Whether this seat may take swarm work. */
  readonly enabled: boolean
  readonly kinds: readonly string[]
}

/**
 * Every configured seat, with the user's swarm overrides folded in.
 *
 * A seat's swarm state is deliberately separate from whether it sits on the
 * council: wanting DeepSeek to debate is not the same as wanting it to carry
 * a unit of work. Absent an override, a seat starts in the swarm the way it
 * starts on the council, so a fresh install needs no second setup pass.
 * @param section - decoded council settings.
 * @returns the roster to render.
 */
function readRoster(section: Record<string, unknown> | undefined): readonly RosterWorker[] {
  const overrides = (section?.['swarmRoster'] ?? {}) as Record<string, {
    enabled?: boolean
    kinds?: string[]
  }>
  return seatsFrom(section).map((seat) => {
    const override = overrides[seat.id]
    return {
      seat,
      enabled: override?.enabled ?? seat.enabled,
      kinds: override?.kinds ?? DEFAULT_KINDS,
    }
  })
}

/**
 * Roster panel, shown while swarm mode is on.
 * @param props - locale seat and the council settings scope.
 * @returns the panel, or null when swarm mode is off.
 */
export function SwarmRoster({ t, settings }: SwarmRosterProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  if (section?.['swarmMode'] !== true) return null

  const roster = readRoster(section)
  const overrides = { ...(section['swarmRoster'] ?? {}) } as Record<string, {
    enabled?: boolean
    kinds?: string[]
  }>

  /** Write one seat's swarm override back, leaving the others untouched. */
  const write = (seatId: string, patch: { enabled?: boolean; kinds?: string[] }): void => {
    const current = overrides[seatId] ?? {}
    void settings.set('swarmRoster', { ...overrides, [seatId]: { ...current, ...patch } })
  }

  const active = roster.filter(worker => worker.enabled)
  // A free hosted worker bills nothing, so it must not raise the per-token
  // warning the metered ones do.
  const meteredOn = active.some(worker => worker.seat.transport === 'openrouter' && worker.seat.free !== true)

  return (
    <div className={css.panel} role="group" aria-label={t('swarm.title')}>
      <label>
        {t('swarm.mode')}{' '}
        <select value={typeof section['swarmProfile'] === 'string' ? section['swarmProfile'] : ''}
          disabled={Boolean(section['pendingSwarmId']) || Boolean(section['pipelineId'])}
          onChange={(event) => { void settings.set('swarmProfile', event.target.value) }}>
          <option value="" disabled>{t('swarm.chooseMode')}</option>
          <option value="economy">{t('swarm.economy')}</option>
          <option value="fastest">{t('swarm.fastest')}</option>
        </select>
      </label>
      <div className={css.head}>
        <strong className={css.title}>{t('swarm.title')}</strong>
        <span className={css.sub}>{t('swarm.hint')}</span>
      </div>

      {roster.map((worker) => {
        const free = worker.seat.free === true
        const subscription = worker.seat.transport === 'cli'
        return (
          <div key={worker.seat.id} className={worker.enabled ? css.row : `${css.row} ${css.off}`}>
            <label className={css.name}>
              <input
                type="checkbox"
                checked={worker.enabled}
                onChange={() => { write(worker.seat.id, { enabled: !worker.enabled }) }}
              />
              <span>{worker.seat.name}</span>
              <span className={free || subscription ? css.free : css.metered}>
                {free ? t('swarm.free') : subscription ? t('swarm.subscription') : t('swarm.metered')}
              </span>
              {worker.seat.model === undefined || worker.seat.model === ''
                ? null
                : <span className={css.model}>{worker.seat.model}</span>}
            </label>
            <div className={css.kinds}>
              {KINDS.map((kind) => {
                const on = worker.kinds.includes(kind)
                return (
                  <button
                    key={kind}
                    type="button"
                    className={on ? `${css.kind} ${css.kindOn}` : css.kind}
                    aria-pressed={on}
                    disabled={!worker.enabled}
                    onClick={() => {
                      const next = on
                        ? worker.kinds.filter(entry => entry !== kind)
                        : [...worker.kinds, kind]
                      write(worker.seat.id, { kinds: next })
                    }}
                  >
                    {kind}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {active.length === 0
        ? <p className={css.warn}>{t('swarm.noneEnabled')}</p>
        : null}
      {meteredOn
        ? <p className={css.warn}>{t('swarm.meteredWarning')}</p>
        : null}
    </div>
  )
}
