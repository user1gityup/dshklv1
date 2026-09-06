/**
 * Claude Code quota panel.
 *
 * Shows the provider's own session and weekly percentages — not an estimate
 * folded from token logs — because the host half publishes what
 * `claude -p "/usage"` reported into the `claude-quota` settings namespace and
 * this reads that namespace reactively.
 *
 * Refresh is a button, never a timer: a live reading costs one request against
 * the same quota it reports, so the spend stays behind a deliberate press. The
 * click writes `refreshRequestedAt`; the host watches that field and does the
 * work.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './locales.ts'
import css from './ClaudeQuota.module.css'

/** The narrow settings surface the panel needs. */
export type SettingsFace = SettingsScope<Record<string, unknown>>

/** Full component props. */
export type ClaudeQuotaProps =
  PropsRuntime<'sidebar.region.action'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/**
 * Absent numeric field, as the host spells it.
 *
 * A settings write cannot clear a field by writing `undefined`, so a missing
 * reading arrives as this rather than as an absent key. Zero cannot serve:
 * 0% used is a real reading at the start of a week.
 */
const ABSENT = -1

/** Read one numeric field, treating the absent sentinel as no reading. */
function figure(section: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = section?.[field]
  return typeof value === 'number' && value !== ABSENT ? value : undefined
}

/** Read one string field, treating the empty string as no reading. */
function text(section: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = section?.[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Pick the fill class for a percentage: neutral, then amber, then red. */
function severity(percent: number): string | undefined {
  if (percent >= 90) return css.hot
  if (percent >= 70) return css.warn
  return undefined
}

/** One labelled meter, or nothing when that figure was not read. */
function Meter(
  { label, percent, resets, resetsLabel }:
  { label: string; percent: number | undefined; resets: string | undefined; resetsLabel: (when: string) => string },
): ReactNode {
  if (percent === undefined) return null
  const width = Math.max(0, Math.min(100, percent))
  const tone = severity(percent)
  return (
    <div>
      <div className={css.meterRow}>
        <span>{label}</span>
        <span className={css.meterValue}>{percent}%</span>
      </div>
      <div
        className={css.track}
        role="meter"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={tone === undefined ? css.fill : `${css.fill} ${tone}`} style={{ width: `${String(width)}%` }} />
      </div>
      {resets === undefined ? null : <div className={css.resets}>{resetsLabel(resets)}</div>}
    </div>
  )
}

/** The sidebar action and its panel. */
export function ClaudeQuota({ wide, t, settings }: ClaudeQuotaProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [panelBottom, setPanelBottom] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value

  const sessionPercent = figure(section, 'sessionPercent')
  const weekPercent = figure(section, 'weekPercent')
  const requests24h = figure(section, 'requests24h')
  const sessions24h = figure(section, 'sessions24h')
  const requests7d = figure(section, 'requests7d')
  const sessions7d = figure(section, 'sessions7d')
  const bigContextPercent = figure(section, 'bigContextPercent')
  const bigContextThresholdK = figure(section, 'bigContextThresholdK')
  const longSessionPercent = figure(section, 'longSessionPercent')
  const longSessionHours = figure(section, 'longSessionHours')
  const capturedAt = figure(section, 'capturedAt')
  const refreshState = text(section, 'refreshState')
  const running = refreshState === 'running'
  const hasReading = sessionPercent !== undefined || weekPercent !== undefined

  // Keep the panel clear of the trigger that opens it.
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPanelBottom(Math.max(0, window.innerHeight - rect.top + 8))
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('pointerdown', onPointer) }
  }, [open])

  // The one write this panel makes. The host watches the field and spends the
  // request; the browser cannot spawn the CLI itself.
  const requestRefresh = useCallback(() => {
    if (running) return
    void settings.set('refreshRequestedAt', Date.now())
  }, [running, settings])

  const resetsLabel = useCallback((when: string) => t('resets', { when }), [t])

  return (
    <div ref={rootRef} className={css.root}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={t('trigger.aria')}
        title={t('trigger.tooltip')}
        aria-expanded={open}
        onClick={() => { setOpen(prev => !prev) }}
      >
        <span className={css.triggerIcon} aria-hidden="true">◔</span>
        {wide ? <span className={css.triggerLabel}>{t('trigger.tooltip')}</span> : null}
        {sessionPercent === undefined
          ? null
          : <span className={css.triggerValue}>{sessionPercent}%</span>}
      </button>

      {open ? (
        <div className={css.panel} style={{ bottom: panelBottom }} role="dialog" aria-label={t('panel.title')}>
          <h3 className={css.title}>{t('panel.title')}</h3>

          {hasReading ? (
            <>
              <div className={css.section}>
                <Meter
                  label={t('session.label')}
                  percent={sessionPercent}
                  resets={text(section, 'sessionResets')}
                  resetsLabel={resetsLabel}
                />
                <Meter
                  label={t('week.label')}
                  percent={weekPercent}
                  resets={text(section, 'weekResets')}
                  resetsLabel={resetsLabel}
                />
              </div>

              {requests24h === undefined && requests7d === undefined ? null : (
                <div className={css.section}>
                  <div className={css.sectionHead}>{t('activity.title')}</div>
                  {requests24h === undefined ? null : (
                    <div className={css.row}>
                      {t('activity.day', {
                        requests: String(requests24h),
                        sessions: String(sessions24h ?? 0),
                      })}
                    </div>
                  )}
                  {requests7d === undefined ? null : (
                    <div className={css.row}>
                      {t('activity.week', {
                        requests: String(requests7d),
                        sessions: String(sessions7d ?? 0),
                      })}
                    </div>
                  )}
                </div>
              )}

              {bigContextPercent === undefined && longSessionPercent === undefined ? null : (
                <div className={css.section}>
                  <div className={css.sectionHead}>{t('shape.title')}</div>
                  {bigContextPercent === undefined ? null : (
                    <div className={css.row}>
                      {t('shape.context', {
                        percent: String(bigContextPercent),
                        threshold: String(bigContextThresholdK ?? 150),
                      })}
                    </div>
                  )}
                  {longSessionPercent === undefined ? null : (
                    <div className={css.row}>
                      {t('shape.longSessions', {
                        percent: String(longSessionPercent),
                        hours: String(longSessionHours ?? 8),
                      })}
                    </div>
                  )}
                  <div className={css.note}>{t('shape.hint')}</div>
                </div>
              )}
            </>
          ) : (
            <div className={css.section}>
              <div className={css.sectionHead}>{t('empty.title')}</div>
              <div className={css.empty}>{t('empty.body')}</div>
            </div>
          )}

          {refreshState === 'failed' ? <div className={css.note}>{t('refresh.failed')}</div> : null}
          <div className={css.note}>{t('refresh.cost')}</div>

          <div className={css.footer}>
            <span className={css.stamp}>
              {running
                ? t('refresh.running')
                : capturedAt === undefined || capturedAt === 0
                  ? t('status.never')
                  : t('status.captured', { time: new Date(capturedAt).toLocaleTimeString() })}
            </span>
            <button
              type="button"
              className={css.refreshBtn}
              onClick={requestRefresh}
              disabled={running || !snapshot.writable}
            >
              {t('refresh.button')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
