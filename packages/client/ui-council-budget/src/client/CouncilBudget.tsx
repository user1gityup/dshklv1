/**
 * Council budget panel.
 *
 * Answers "what does this configuration buy" before any call is made, and
 * lets seats and tools be toggled from the same place. Toggles write through
 * the settings scope, which the host council reads per invocation, so a change
 * takes effect on the next run without a restart.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ISessions, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { project, usd } from './capacity.ts'
import type { PanelSeat, Price, Subscription } from './capacity.ts'
import { seatsFrom } from './capacity.ts'
import { NS } from './locales.ts'
import css from './CouncilBudget.module.css'

/** Full component props. */
export type CouncilBudgetProps =
  PropsRuntime<'sidebar.region.action'>
  & PropsLocale<typeof NS>
  & { sessions: ISessions; settings: SettingsFace }

/** The narrow settings surface the panel needs. */
export type SettingsFace = SettingsScope<Record<string, unknown>>

/** localStorage slot for the OpenRouter key, shared with the monitor panel. */
const KEY_STORAGE = 'dsh:openrouter-monitor:api-key'

/** The council's tools, listed so they can be seen and switched off. */
const TOOLS = ['council', 'swarm', 'council_capacity', 'memory_write', 'memory_recall', 'memory_forget'] as const

/** Fold the harness's own session projections into observed work. */
function useObserved(sessions: ISessions): { outputTokens: number; inputTokens: number; sessions: number } {
  const list = useSyncExternalStore(
    fn => sessions.list.subscribe(fn),
    () => sessions.list.getSnapshot(),
  )
  return useMemo(() => {
    let outputTokens = 0
    let inputTokens = 0
    let counted = 0
    for (const id of list.ids) {
      const row = list.byId[id] as { projectionValues?: Record<string, unknown> } | undefined
      const usage = row?.projectionValues?.['tokenUsage'] as
        { uncachedInputTokens?: number; outputTokens?: number } | undefined
      if (usage === undefined) continue
      const out = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
      // A session with no output never ran a turn and would drag the mean down.
      if (out <= 0) continue
      outputTokens += out
      inputTokens += typeof usage.uncachedInputTokens === 'number' ? usage.uncachedInputTokens : 0
      counted += 1
    }
    return { outputTokens, inputTokens, sessions: counted }
  }, [list])
}

/** The sidebar footer action and its panel. */
export function CouncilBudget({ wide, t, sessions, settings }: CouncilBudgetProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [panelBottom, setPanelBottom] = useState(0)
  const [pricing, setPricing] = useState<ReadonlyMap<string, Price>>(new Map())
  const [remaining, setRemaining] = useState<number | undefined>(undefined)
  const [draftModel, setDraftModel] = useState('')
  const [draftName, setDraftName] = useState('')
  const [addError, setAddError] = useState<string | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  const seats = useMemo(() => seatsFrom(section), [section])
  const monthlyUsd = typeof section?.['monthlyBudgetUsd'] === 'number' ? section['monthlyBudgetUsd'] : 20
  const disabledTools = (section?.['disabledTools'] ?? []) as string[]
  // The host measures CLI-seat output from its local logs and publishes it
  // here, because the browser cannot read those logs itself.
  const weeklyCliTokens = typeof section?.['observedCliTokensPerWeek'] === 'number'
    ? section['observedCliTokensPerWeek']
    : undefined
  const subscription: Subscription = {
    usdPerSeat: typeof section?.['subscriptionUsdPerSeat'] === 'number' ? section['subscriptionUsdPerSeat'] : 20,
    ...(weeklyCliTokens === undefined ? {} : { tokensPerMonth: (weeklyCliTokens / 7) * 30 }),
  }
  const observed = useObserved(sessions)

  // Pricing and balance are fetched once per open: both are cheap, and neither
  // changes fast enough to justify polling.
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    void (async () => {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/models', { signal: ac.signal })
        if (response.ok) {
          const body = await response.json() as { data?: readonly { id?: string; pricing?: { prompt?: string; completion?: string } }[] }
          const table = new Map<string, Price>()
          for (const row of body.data ?? []) {
            if (typeof row.id !== 'string') continue
            const prompt = Number(row.pricing?.prompt)
            const completion = Number(row.pricing?.completion)
            if (Number.isFinite(prompt) && Number.isFinite(completion)) table.set(row.id, { prompt, completion })
          }
          setPricing(table)
        }
      } catch { /* an unreachable price table leaves the estimate unpriced */ }
      const key = localStorage.getItem(KEY_STORAGE)
      if (key === null || key === '') return
      try {
        const response = await fetch('https://openrouter.ai/api/v1/credits', {
          headers: { Authorization: `Bearer ${key}` },
          signal: ac.signal,
        })
        if (!response.ok) return
        const body = await response.json() as { data?: { total_credits?: number; total_usage?: number } }
        const purchased = body.data?.total_credits
        const used = body.data?.total_usage
        if (typeof purchased === 'number' && typeof used === 'number') setRemaining(purchased - used)
      } catch { /* balance stays unknown */ }
    })()
    return () => { ac.abort() }
  }, [open])

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

  const projection = useMemo(
    () => project(seats, pricing, observed, monthlyUsd, remaining, subscription),
    [seats, pricing, observed, monthlyUsd, remaining, subscription],
  )

  const toggleSeat = useCallback((seat: PanelSeat) => {
    const overrides = { ...(section?.['seats'] ?? {}) } as Record<string, { enabled?: boolean }>
    overrides[seat.id] = { ...overrides[seat.id], enabled: !seat.enabled }
    void settings.set('seats', overrides)
  }, [section, settings])

  /** Turn a model id into a stable seat key. */
  const seatKeyFor = (model: string): string =>
    (model.split('/').pop() ?? model).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()

  const addSeat = useCallback(() => {
    const model = draftModel.trim()
    if (model === '') return
    const key = seatKeyFor(model)
    if (seats.some(seat => seat.id === key)) {
      setAddError(t('add.duplicate'))
      return
    }
    const extras = { ...(section?.['extraSeats'] ?? {}) } as Record<string, unknown>
    extras[key] = {
      model,
      enabled: true,
      ...(draftName.trim() === '' ? {} : { name: draftName.trim() }),
    }
    void settings.set('extraSeats', extras)
    // An unpriced model still runs; the warning is about the estimate, not the seat.
    setAddError(pricing.has(model) ? undefined : t('add.unpriced'))
    setDraftModel('')
    setDraftName('')
  }, [draftModel, draftName, seats, section, settings, pricing, t])

  const removeSeat = useCallback((id: string) => {
    const extras = (section?.['extraSeats'] ?? {}) as Record<string, unknown>
    if (!(id in extras)) return
    // Rebuild without the key rather than deleting: a dynamic delete
    // deoptimises the object and the lint rule rejects it.
    const remaining = Object.fromEntries(Object.entries(extras).filter(([key]) => key !== id))
    void settings.set('extraSeats', remaining)
  }, [section, settings])

  const isExtra = useCallback(
    (id: string) => Object.hasOwn((section?.['extraSeats'] ?? {}) as object, id),
    [section],
  )

  const toggleTool = useCallback((tool: string) => {
    const next = disabledTools.includes(tool)
      ? disabledTools.filter(entry => entry !== tool)
      : [...disabledTools, tool]
    void settings.set('disabledTools', next)
  }, [disabledTools, settings])

  const number = (value: number | undefined, digits = 1): string =>
    value === undefined ? t('capacity.unknown') : value.toFixed(digits)

  /** Token counts read better in millions once they pass a million. */
  const millions = (value: number): string =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : Math.round(value).toLocaleString()

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
        <span className={css.triggerIcon} aria-hidden="true">▣</span>
        {wide ? <span className={css.triggerLabel}>{t('trigger.tooltip')}</span> : null}
        {projection.costPerRun !== undefined
          ? <span className={css.triggerCost}>{usd(projection.costPerRun)}</span>
          : null}
      </button>

      {open ? (
        <div className={css.panel} style={{ bottom: panelBottom }} role="dialog" aria-label={t('panel.title')}>
          <h3 className={css.title}>{t('panel.title')}</h3>

          <div className={css.section}>
            <div className={css.sectionHead}>{t('mode.title')}</div>
            <label className={css.row}>
              <input
                type="checkbox"
                checked={section?.['councilMode'] === true}
                onChange={() => { void settings.set('councilMode', section?.['councilMode'] !== true) }}
              />
              <span className={css.rowName}>{t('mode.on')}</span>
            </label>
            <div className={css.note}>{t('mode.hint')}</div>
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>{t('seats.title')}</div>
            {seats.map(seat => (
              <label key={seat.id} className={css.row}>
                <input type="checkbox" checked={seat.enabled} onChange={() => { toggleSeat(seat) }} />
                <span className={css.rowName}>{seat.name}</span>
                <span className={css.rowMeta}>
                  {seat.transport === 'openrouter'
                    ? t('seats.metered')
                    : projection.subscriptionRate === undefined ? t('seats.subscription') : t('seats.subPriced')}
                </span>
                {isExtra(seat.id) ? (
                  <button
                    type="button"
                    className={css.removeBtn}
                    title={t('add.remove')}
                    onClick={(event) => { event.preventDefault(); removeSeat(seat.id) }}
                  >
                    ×
                  </button>
                ) : null}
              </label>
            ))}

            <div className={css.addRow}>
              <input
                className={css.addInput}
                list="council-openrouter-models"
                placeholder={t('add.modelPlaceholder')}
                value={draftModel}
                onChange={(event) => { setDraftModel(event.target.value); setAddError(undefined) }}
                onKeyDown={(event) => { if (event.key === 'Enter') addSeat() }}
              />
              <datalist id="council-openrouter-models">
                {[...pricing.keys()].slice(0, 500).map(id => <option key={id} value={id} />)}
              </datalist>
              <input
                className={css.addInput}
                placeholder={t('add.namePlaceholder')}
                value={draftName}
                onChange={(event) => { setDraftName(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') addSeat() }}
              />
              <button type="button" className={css.addBtn} onClick={addSeat}>{t('add.button')}</button>
            </div>
            {addError === undefined ? null : <div className={css.caveat}>! {addError}</div>}
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>{t('capacity.title')}</div>
            <div className={css.row}>
              <span className={css.rowName}>{t('capacity.perRun')}</span>
              <span className={css.rowValue}>
                {projection.costPerRun === undefined ? t('capacity.unknown') : usd(projection.costPerRun)}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('capacity.outlay')}</span>
              <span className={css.rowValue}>{usd(projection.monthlyOutlayUsd)}</span>
            </div>
            {projection.subscriptionRate === undefined ? null : (
              <div className={css.row}>
                <span className={css.rowName}>{t('capacity.subRate')}</span>
                <span className={css.rowValue}>{usd(projection.subscriptionRate * 1_000_000)}</span>
              </div>
            )}
            <div className={css.row}>
              <span className={css.rowName}>{t('capacity.runsMonth')}</span>
              <span className={css.rowValue}>{number(projection.runsPerMonth, 0)}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('capacity.runsLeft')}</span>
              <span className={css.rowValue}>{number(projection.runsRemaining, 0)}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('capacity.unit')}</span>
              <span className={css.rowValue}>{projection.unitTokens.toLocaleString()} tok</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('balance.label')}</span>
              <span className={css.rowValue}>{remaining === undefined ? t('balance.loading') : usd(remaining)}</span>
            </div>
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>{t('power.title')}</div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.total')}</span>
              <span className={css.rowValue}>{millions(projection.totalTokensPerMonth)}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.solo')}</span>
              <span className={css.rowValue}>
                {projection.soloTokensPerMonth === undefined
                  ? t('capacity.unknown')
                  : millions(projection.soloTokensPerMonth)}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.multiple')}</span>
              <span className={css.rowValue}>
                {projection.powerMultiple === undefined ? t('capacity.unknown') : `${projection.powerMultiple.toFixed(2)}x`}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.perspectives')}</span>
              <span className={css.rowValue}>{projection.perspectivesPerQuery}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.latency')}</span>
              <span className={css.rowValue}>~{projection.latencyMultiple}x</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>{t('power.precision')}</span>
              <span className={css.rowValue}>{t('power.precisionNone')}</span>
            </div>
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>{t('tools.title')}</div>
            {TOOLS.map(tool => (
              <label key={tool} className={css.row}>
                <input
                  type="checkbox"
                  checked={!disabledTools.includes(tool)}
                  onChange={() => { toggleTool(tool) }}
                />
                <span className={css.rowName}>{tool}</span>
              </label>
            ))}
          </div>

          {projection.caveats.map(caveat => (
            <div key={caveat} className={css.caveat}>! {caveat}</div>
          ))}
          <div className={css.note}>{t('note.estimate')}</div>
        </div>
      ) : null}
    </div>
  )
}
