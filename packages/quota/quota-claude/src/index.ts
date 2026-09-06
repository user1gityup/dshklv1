/**
 * Claude Code quota, published for the browser.
 *
 * The panel that shows this runs in a browser tab: it cannot spawn a CLI and
 * cannot read `~/.claude`. This host half does both and publishes the figures
 * through the `claude-quota` settings namespace, which the client already
 * mirrors reactively — the same seam the council uses to hand the budget panel
 * its measured CLI usage, and one that needs no new wire method.
 *
 * Two rules shape the design:
 *
 * 1. **A live reading costs a request against the quota it reports.** So one
 *    never happens on a timer or at boot. Boot publishes the status line's
 *    cache, which is free, and a live call runs only when the user presses
 *    Refresh — which arrives here as a bump to `refreshRequestedAt`.
 * 2. **Percentages are the provider's own, not an estimate.** They come from
 *    `/usage` and are shown as it worded them. Nothing here infers a ceiling
 *    from token counts.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { isUsable, readCache, refresh, type QuotaReading } from './reading.ts'

/** Cordis plugin name. */
export const name = 'quota-claude'

/** Required services: the namespace this publishes through. */
export const inject = ['settings']

/** Settings namespace this plugin owns; the panel binds the same name. */
export const CLAUDE_QUOTA_NAMESPACE = settingsNamespace('claude-quota')

/**
 * Absent numeric field.
 *
 * A settings `update` treats `undefined` as "leave unchanged", not "clear", so
 * a field that has gone missing needs a value that means missing. Zero cannot
 * serve: 0% used is a real reading on a fresh week.
 */
export const ABSENT = -1

/** What the panel reads. Flat scalars only — a nested default breaks boot. */
export interface Config {
  /** Master switch. False registers nothing. */
  enabled?: boolean
  /** Cache file to share with the status line. Empty means its default path. */
  cachePath?: string
  /** Hard cap on one live `/usage` call, in milliseconds. */
  timeoutMs?: number
  /** Percent of the session window used; {@link ABSENT} when unread. */
  sessionPercent?: number
  /** When the session window resets, as the CLI worded it. */
  sessionResets?: string
  /** Percent of the week used; {@link ABSENT} when unread. */
  weekPercent?: number
  /** When the week resets, as the CLI worded it. */
  weekResets?: string
  /** Requests in the last 24 hours; {@link ABSENT} when unread. */
  requests24h?: number
  /** Sessions in the last 24 hours; {@link ABSENT} when unread. */
  sessions24h?: number
  /** Requests in the last 7 days; {@link ABSENT} when unread. */
  requests7d?: number
  /** Sessions in the last 7 days; {@link ABSENT} when unread. */
  sessions7d?: number
  /** Share of usage above the big-context threshold; {@link ABSENT} when unread. */
  bigContextPercent?: number
  /** Big-context threshold in thousands of tokens; {@link ABSENT} when unread. */
  bigContextThresholdK?: number
  /** Share of usage from long sessions; {@link ABSENT} when unread. */
  longSessionPercent?: number
  /** Long-session threshold in hours; {@link ABSENT} when unread. */
  longSessionHours?: number
  /** Epoch milliseconds the published figures were captured; 0 when never. */
  capturedAt?: number
  /**
   * Set by the panel to ask for a live reading. The host runs one when this
   * moves forward, which keeps the spend behind a deliberate user action
   * rather than behind a page load.
   */
  refreshRequestedAt?: number
  /** `''` idle, `running` while a live call is out, `ok` or `failed` after one. */
  refreshState?: string
}

/** Loader schema. Every field is a flat scalar; nested defaults fail their own required fields at boot. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cachePath: z.string().default(''),
  timeoutMs: z.natural().default(90_000),
  sessionPercent: z.number().default(ABSENT),
  sessionResets: z.string().default(''),
  weekPercent: z.number().default(ABSENT),
  weekResets: z.string().default(''),
  requests24h: z.number().default(ABSENT),
  sessions24h: z.number().default(ABSENT),
  requests7d: z.number().default(ABSENT),
  sessions7d: z.number().default(ABSENT),
  bigContextPercent: z.number().default(ABSENT),
  bigContextThresholdK: z.number().default(ABSENT),
  longSessionPercent: z.number().default(ABSENT),
  longSessionHours: z.number().default(ABSENT),
  capturedAt: z.number().default(0),
  refreshRequestedAt: z.number().default(0),
  refreshState: z.string().default(''),
})

/** Numbers the panel reads, with absent ones spelled out rather than omitted. */
export function publishable(reading: QuotaReading): Partial<Config> {
  const number = (value: number | undefined): number => value ?? ABSENT
  const text = (value: string | undefined): string => value ?? ''
  return {
    sessionPercent: number(reading.sessionPercent),
    sessionResets: text(reading.sessionResets),
    weekPercent: number(reading.weekPercent),
    weekResets: text(reading.weekResets),
    requests24h: number(reading.requests24h),
    sessions24h: number(reading.sessions24h),
    requests7d: number(reading.requests7d),
    sessions7d: number(reading.sessions7d),
    bigContextPercent: number(reading.bigContextPercent),
    bigContextThresholdK: number(reading.bigContextThresholdK),
    longSessionPercent: number(reading.longSessionPercent),
    longSessionHours: number(reading.longSessionHours),
    capturedAt: reading.capturedAt ?? 0,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  // The schema is erased through `never` to satisfy the provider's own
  // signature, so the returned scope is re-typed here rather than left unknown.
  const scope = ctx.settings.register(CLAUDE_QUOTA_NAMESPACE, Config as never, { base: config as never }) as
    SettingsScope<Config> | undefined
  if (scope === undefined) return
  const cachePath = config.cachePath === undefined || config.cachePath === '' ? undefined : config.cachePath
  const timeoutMs = config.timeoutMs ?? 90_000

  const live = (): Config => (ctx.settings.get(CLAUDE_QUOTA_NAMESPACE) as Config | undefined) ?? config

  /** Guards against a second call while one is out; a doubled press is one reading, not two requests. */
  let running = false

  const runLive = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await ctx.settings.update(CLAUDE_QUOTA_NAMESPACE, { refreshState: 'running' })
      const reading = await refresh(timeoutMs, cachePath)
      if (reading === undefined) {
        // Nothing usable came back. The published figures stay as they were,
        // stale by their own timestamp, which reads better than a blank panel.
        await ctx.settings.update(CLAUDE_QUOTA_NAMESPACE, { refreshState: 'failed' })
        return
      }
      await ctx.settings.update(CLAUDE_QUOTA_NAMESPACE, { ...publishable(reading), refreshState: 'ok' })
    } catch {
      try {
        await ctx.settings.update(CLAUDE_QUOTA_NAMESPACE, { refreshState: 'failed' })
      } catch {
        // A read-only settings provider is a supported deployment; the panel
        // simply keeps showing the last figures it saw.
      }
    } finally {
      running = false
    }
  }

  // Boot publishes the cache, never a live call: opening the app must not
  // spend a request, and the status line has usually left fresh figures.
  void (async () => {
    const cached = readCache(cachePath)
    if (cached === undefined || !isUsable(cached)) return
    const known = live().capturedAt
    if (known !== undefined && known >= (cached.capturedAt ?? 0)) return
    try {
      await ctx.settings.update(CLAUDE_QUOTA_NAMESPACE, publishable(cached))
    } catch {
      // As above: nothing to publish through, nothing to fix here.
    }
  })()

  // The panel's Refresh button moves `refreshRequestedAt` forward. That is the
  // whole trigger for spending a request, and it can only come from a click.
  ctx.effect(() => scope.watch((next, prev) => {
    const asked = next.refreshRequestedAt ?? 0
    if (asked <= (prev.refreshRequestedAt ?? 0)) return
    void runLive()
  }), 'quota-claude: refresh requests')
}
