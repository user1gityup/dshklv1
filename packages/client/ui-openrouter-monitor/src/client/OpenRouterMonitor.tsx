/**
 * OpenRouter Monitor — a server-monitor-style popover showing API balance
 * and per-model cost breakdown. Lives as a sidebar footer action.
 *
 * The API key is stored in the plugin's own localStorage slot.
 * It's separate from DSH's credential system and is only used by this plugin.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  BalanceSnapshot,
  ModelPrice,
  UsageSnapshot,
} from './openrouter-api.ts'
import { fetchActivity, fetchCredits, fetchModelPricing } from './openrouter-api.ts'
import { NS } from './locales.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the sidebar shell's SlotMap merge ('sidebar.footer.action' + owner props).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './OpenRouterMonitor.module.css'

/** Full component props. */
export type OpenRouterMonitorProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & { sessions: ISessions }

/** localStorage key for the API key. */
const KEY_STORAGE = 'dsh:openrouter-monitor:api-key'

/** localStorage key for the management key that unlocks per-model activity. */
const MGMT_STORAGE = 'dsh:openrouter-monitor:management-key'

/* ── Formatting helpers ──────────────────────────────── */

/** Format a USD amount. */
function formatUsd(cents: number): string {
  const abs = Math.abs(cents)
  const decimals = abs < 0.01 ? 4 : 2
  return `$${cents.toFixed(decimals)}`
}

/** Format a relative timestamp. */
function formatAgo(ms: number): string {
  if (ms < 5_000) return 'just now'
  const secs = Math.floor(ms / 1_000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

/** Bar width as percentage of the max cost in the list. */
function barPct(cost: number, max: number): number {
  return max === 0 ? 0 : Math.round((cost / max) * 100)
}

/* ── Color helpers ───────────────────────────────────── */

function balanceColor(remaining: number): string {
  if (remaining <= 0) return css.balanceDanger ?? ''
  if (remaining < 1) return css.balanceWarn ?? ''
  return css.balanceOk ?? ''
}

type Status = 'loading' | 'ready' | 'error' | 'no-key'

/* ── Component ───────────────────────────────────────── */

/**
 * Sidebar footer action: a credit-card icon that opens the monitor popover.
 */
export function OpenRouterMonitor({
  wide,
  t,
  sessions,
}: OpenRouterMonitorProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>('no-key')
  const [balance, setBalance] = useState<BalanceSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [savedKey, setSavedKey] = useState<string | null>(null)
  // Distance from the viewport bottom up to the top of the trigger. The panel
  // is pinned to the left edge, so without this it would render on top of the
  // very button that opens it — both live in the sidebar footer.
  const [panelBottom, setPanelBottom] = useState(0)
  const [mgmtKey, setMgmtKey] = useState<string | null>(null)
  const sessionTokens = useLocalSessionTokens(sessions)
  const [pricing, setPricing] = useState<Map<string, ModelPrice> | null>(null)
  const [mgmtInput, setMgmtInput] = useState('')

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Read saved key on mount.
  useEffect(() => {
    const stored = localStorage.getItem(KEY_STORAGE)
    if (stored) {
      setSavedKey(stored)
      setStatus('loading')
    }
    setMgmtKey(localStorage.getItem(MGMT_STORAGE))
  }, [])

  // Public catalogue: prices local token counts without any credential.
  useEffect(() => {
    if (!open || pricing !== null) return
    const ac = new AbortController()
    fetchModelPricing(ac.signal).then(setPricing).catch(() => setPricing(new Map()))
    return () => ac.abort()
  }, [open, pricing])

  // Only OpenRouter-routed models belong in an OpenRouter monitor; a model the
  // catalogue does not list was billed by some other provider.

  /** Save the management key that unlocks per-model activity. */
  const saveMgmtKey = useCallback(() => {
    const trimmed = mgmtInput.trim()
    if (!trimmed) return
    localStorage.setItem(MGMT_STORAGE, trimmed)
    setMgmtKey(trimmed)
    setMgmtInput('')
    setStatus('loading')
  }, [mgmtInput])

  /** Remove the management key; balance keeps working without it. */
  const removeMgmtKey = useCallback(() => {
    localStorage.removeItem(MGMT_STORAGE)
    setMgmtKey(null)
    setUsage(null)
  }, [])

  /** Save a key and start loading. */
  const saveKey = useCallback(() => {
    const trimmed = keyInput.trim()
    if (!trimmed) return
    localStorage.setItem(KEY_STORAGE, trimmed)
    setSavedKey(trimmed)
    setKeyInput('')
    setStatus('loading')
  }, [keyInput])

  /** Remove the stored key. */
  const removeKey = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE)
    setSavedKey(null)
    setStatus('no-key')
    setBalance(null)
    setUsage(null)
  }, [])

  /**
   * Fetch balance and usage from OpenRouter.
   */
  const loadData = useCallback(async () => {
    if (!savedKey) {
      setStatus('no-key')
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setStatus('loading')
    setError(null)

    try {
      // Balance is required; usage is best-effort. OpenRouter exposes no
      // aggregate per-model endpoint to an ordinary API key, so a failure
      // there must not hide a balance that loaded fine.
      const [balRes, usgRes] = await Promise.allSettled([
        fetchCredits(savedKey, ac.signal),
        mgmtKey ? fetchActivity(mgmtKey, ac.signal) : Promise.reject(new Error('no management key')),
      ])
      if (ac.signal.aborted) return
      if (balRes.status === 'rejected') throw balRes.reason
      setBalance(balRes.value)
      setUsage(usgRes.status === 'fulfilled' ? usgRes.value : null)
      setStatus('ready')
      setLastUpdated(Date.now())
    } catch (err) {
      if (ac.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [savedKey, mgmtKey])

  // Load on first open or when key changes.
  useEffect(() => {
    if (savedKey && status === 'loading') loadData()
  }, [savedKey, status, loadData])

  // Auto-refresh every 60s while open.
  useEffect(() => {
    if (!open || status !== 'ready') return
    const timer = setInterval(loadData, 60_000)
    return () => clearInterval(timer)
  }, [open, status, loadData])

  // Keep the panel clear of the trigger it opens from.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPanelBottom(Math.max(0, window.innerHeight - rect.top + 8))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev && savedKey && status === 'ready') loadData()
      return !prev
    })
  }, [savedKey, status, loadData])

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={t('trigger.aria')}
        title={t('trigger.tooltip')}
        aria-expanded={open}
        onClick={toggle}
      >
        <svg className={css.triggerIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="0.5" y="4" width="23" height="16" rx="2" ry="2" />
          <line x1="0.5" y1="10" x2="23.5" y2="10" />
          <line x1="6" y1="14" x2="10" y2="14" />
          <line x1="12" y1="14" x2="14" y2="14" />
        </svg>
        {wide ? <span className={css.triggerLabel}>{t('trigger.tooltip')}</span> : null}
        {savedKey && balance ? (
          <span className={`${css.triggerBalance} ${balanceColor(balance.remaining)}`}>
            {formatUsd(balance.remaining)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className={css.panel} style={{ bottom: panelBottom }} role="dialog" aria-label={t('panel.title')}>
          {/* Header */}
          <div className={css.header}>
            <h3 className={css.title}>{t('panel.title')}</h3>
            <span className={css.statusDot} data-status={
              status === 'ready' ? 'ok' : status === 'error' ? 'err' : 'loading'
            } />
            <span className={css.statusText}>
              {status === 'loading' ? t('status.refreshing')
                : status === 'ready' && lastUpdated ? t('status.updated', { time: formatAgo(Date.now() - lastUpdated) })
                  : ''}
            </span>
          </div>

          {/* No key state */}
          {status === 'no-key' ? (
            <div className={css.keyMissing}>
              <p className={css.keyMissingTitle}>{t('keyMissing.title')}</p>
              <p className={css.keyMissingBody}>{t('keyMissing.body')}</p>
              <div className={css.keyForm}>
                <input
                  type="password"
                  className={css.keyInput}
                  placeholder="sk-or-v1-..."
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveKey()}
                />
                <button type="button" className={css.keySaveBtn} onClick={saveKey}>
                  Save
                </button>
              </div>
            </div>
          ) : status === 'error' ? (
            <div className={css.error}>
              <p>{error ?? t('balance.error')}</p>
              <button type="button" className={css.retryBtn} onClick={loadData}>Retry</button>
              <button type="button" className={css.retryBtn} onClick={removeKey}>Remove key</button>
            </div>
          ) : (
            <div className={css.content}>
              {/* Balance card */}
              <div className={css.card}>
                <div className={css.cardHeader}>
                  <span className={css.cardLabel}>{t('balance.label')}</span>
                  <button type="button" className={css.cardAction} onClick={loadData}>
                    &#x21bb;
                  </button>
                </div>
                {balance ? (
                  <div className={css.balanceRow}>
                    <span className={`${css.balanceValue} ${balanceColor(balance.remaining)}`}>
                      {formatUsd(balance.remaining)}
                    </span>
                    <span className={css.balanceMeta}>
                      remaining of {formatUsd(balance.purchased)}
                    </span>
                    <div className={css.balanceBar}>
                      <div
                        className={css.balanceBarFill}
                        style={{
                          width: `${balance.purchased > 0
                            ? Math.round((balance.used / balance.purchased) * 100)
                            : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className={css.cardValue}>
                    {sessionTokens.output > 0 || sessionTokens.input > 0 ? (
                      <div className={css.modelSection}>
                        <div className={css.modelHeader}>{t('session.label')}</div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.in')}</span>
                          <span className={css.usageValue}>{sessionTokens.input.toLocaleString()}</span>
                        </div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.out')}</span>
                          <span className={css.usageValue}>{sessionTokens.output.toLocaleString()}</span>
                        </div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.cached')}</span>
                          <span className={css.usageValue}>{sessionTokens.cached.toLocaleString()}</span>
                        </div>
                      </div>
                    ) : null}
                    <div>{mgmtKey ? t('usage.pendingDay') : t('usage.unavailable')}</div>
                    {mgmtKey ? null : (
                      <div className={css.mgmtRow}>
                        <div className={css.mgmtHint}>{t('mgmt.hint')}</div>
                        <input
                          type="password"
                          className={css.keyInput}
                          placeholder={t('mgmt.placeholder')}
                          value={mgmtInput}
                          onChange={e => setMgmtInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && saveMgmtKey()}
                        />
                        <button type="button" className={css.keySaveBtn} onClick={saveMgmtKey}>
                          {t('mgmt.save')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Usage card */}
              <div className={css.card}>
                <div className={css.cardHeader}>
                  <span className={css.cardLabel}>{t('usage.label')}</span>
                </div>
                {usage ? (
                  <div className={css.usageSection}>
                    <div className={css.usageRow}>
                      <span className={css.usageLabel}>{t('usage.totalSpent')}</span>
                      <span className={css.usageValue}>{formatUsd(usage.totalCost)}</span>
                    </div>
                    <div className={css.usageRow}>
                      <span className={css.usageLabel}>{t('usage.thisMonth')}</span>
                      <span className={css.usageValue}>
                        {usage.totalGenerations.toLocaleString()} calls
                      </span>
                    </div>
                    {usage.models.length > 0 ? (
                      <div className={css.modelSection}>
                        <div className={css.modelHeader}>{t('model.header')}</div>
                        {usage.models.map(m => (
                          <ModelRow
                            key={m.model}
                            usage={m}
                            maxCost={usage.models[0]?.cost ?? 0}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className={css.cardValue}>
                    {sessionTokens.output > 0 || sessionTokens.input > 0 ? (
                      <div className={css.modelSection}>
                        <div className={css.modelHeader}>{t('session.label')}</div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.in')}</span>
                          <span className={css.usageValue}>{sessionTokens.input.toLocaleString()}</span>
                        </div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.out')}</span>
                          <span className={css.usageValue}>{sessionTokens.output.toLocaleString()}</span>
                        </div>
                        <div className={css.usageRow}>
                          <span className={css.usageLabel}>{t('session.cached')}</span>
                          <span className={css.usageValue}>{sessionTokens.cached.toLocaleString()}</span>
                        </div>
                      </div>
                    ) : null}
                    <div>{mgmtKey ? t('usage.pendingDay') : t('usage.unavailable')}</div>
                    {mgmtKey ? null : (
                      <div className={css.mgmtRow}>
                        <div className={css.mgmtHint}>{t('mgmt.hint')}</div>
                        <input
                          type="password"
                          className={css.keyInput}
                          placeholder={t('mgmt.placeholder')}
                          value={mgmtInput}
                          onChange={e => setMgmtInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && saveMgmtKey()}
                        />
                        <button type="button" className={css.keySaveBtn} onClick={saveMgmtKey}>
                          {t('mgmt.save')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Key management */}
              {mgmtKey ? (
                <button type="button" className={css.clearKeyBtn} onClick={removeMgmtKey}>
                  {t('mgmt.clear')}
                </button>
              ) : null}
              <button type="button" className={css.clearKeyBtn} onClick={removeKey}>
                Remove saved key
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** One row in the per-model cost breakdown. */
function ModelRow({ usage, maxCost }: { usage: { model: string; label: string; cost: number; generations: number }; maxCost: number }) {
  return (
    <div className={css.modelRow}>
      <span className={css.modelName} title={usage.model}>{usage.label}</span>
      <span className={css.modelCost}>{formatUsd(usage.cost)}</span>
      <div className={css.modelBarTrack}>
        <div
          className={css.modelBarFill}
          style={{ width: `${barPct(usage.cost, maxCost)}%` }}
        />
      </div>
    </div>
  )
}
/**
 * Fold the open session's assistant messages into per-model output-token
 * counts. This is the no-extra-credential fallback: the harness records the
 * model and provider-reported usage per message, but no pricing, so this
 * counts tokens rather than dollars and covers only the current session.
 * @param sessions - the injected sessions service.
 * @returns per-model rows, highest token count first.
 */
/** Whole-session token totals the harness records for the open session. */
interface SessionTokens {
  input: number
  output: number
  cached: number
}

/**
 * Read the open session's token usage.
 *
 * The harness records token counts but no model attribution — no conversation
 * node, projection, or session row carries a model id — so this reports
 * session totals rather than a per-model split. Per-model belongs to
 * {@link fetchActivity}, which OpenRouter serves only for completed UTC days.
 * @param sessions - the injected sessions service.
 * @returns token totals for the open session, all zero when none is open.
 */
function useLocalSessionTokens(sessions: ISessions): SessionTokens {
  const listState = useSyncExternalStore(
    fn => sessions.list.subscribe(fn),
    () => sessions.list.getSnapshot(),
  )
  const empty = { input: 0, output: 0, cached: 0 }
  const currentId = listState.current
  if (currentId === undefined) return empty
  const row = listState.byId[currentId] as { projectionValues?: Record<string, unknown> } | undefined
  const usage = row?.projectionValues?.['tokenUsage'] as {
    uncachedInputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
  } | undefined
  if (!usage) return empty
  const read = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    input: read(usage.uncachedInputTokens),
    output: read(usage.outputTokens),
    cached: read(usage.cacheReadTokens),
  }
}
