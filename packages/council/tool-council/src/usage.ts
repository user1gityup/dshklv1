/**
 * Local usage accounting for the CLI-backed seats.
 *
 * Neither Claude Code nor Codex exposes remaining quota programmatically —
 * `/usage` in print mode returns only that session's cost, and the JSON
 * envelope carries no rate-limit fields. What they do leave behind is a
 * per-message usage record in their session logs, so consumption is measurable
 * locally even though the provider's quota ceiling is not.
 *
 * Percentages therefore read against a budget the user sets, not against an
 * account limit this process can see. That distinction is deliberate: a
 * fabricated "83% of your Anthropic quota" would be worse than no number.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Token counts folded over one window. */
export interface UsageTotals {
  /** Uncached prompt tokens. */
  readonly inputTokens: number
  /** Completion tokens. */
  readonly outputTokens: number
  /** Tokens served from cache. */
  readonly cacheReadTokens: number
  /** Tokens written to cache. */
  readonly cacheWriteTokens: number
  /** Assistant messages counted. */
  readonly messages: number
  /** Per-model split, keyed by model id. */
  readonly byModel: ReadonlyMap<string, number>
}

/** An empty fold, returned when no log is readable. */
const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  messages: 0,
  byModel: new Map(),
}

/** Read a numeric field defensively. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Recursively collect `.jsonl` files modified at or after `sinceMs`. */
function collectLogs(dir: string, sinceMs: number, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: readonly { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectLogs(path, sinceMs, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      // mtime is a cheap pre-filter: a file untouched since the window opened
      // cannot contain an in-window record.
      if (statSync(path).mtimeMs >= sinceMs) out.push(path)
    } catch {
      // Unreadable entry: skip rather than abort the whole scan.
    }
  }
}

/**
 * Fold Claude Code's session logs over a time window.
 * @param sinceMs - epoch milliseconds; records older than this are ignored.
 * @param root - Claude Code project root; defaults to `~/.claude/projects`.
 * @returns token totals for the window.
 */
export function readClaudeUsage(sinceMs: number, root?: string): UsageTotals {
  const base = root ?? join(homedir(), '.claude', 'projects')
  const files: string[] = []
  collectLogs(base, sinceMs, files)
  if (files.length === 0) return EMPTY

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let messages = 0
  const byModel = new Map<string, number>()

  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      let record: {
        timestamp?: unknown
        message?: { model?: unknown; usage?: Record<string, unknown> }
      }
      try {
        record = JSON.parse(line) as typeof record
      } catch {
        continue
      }
      const usage = record.message?.usage
      if (usage === undefined) continue
      const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
      // A record without a parseable stamp cannot be placed in the window, so
      // it is excluded rather than counted against an arbitrary window.
      if (!Number.isFinite(stamp) || stamp < sinceMs) continue
      const output = num(usage['output_tokens'])
      inputTokens += num(usage['input_tokens'])
      outputTokens += output
      cacheReadTokens += num(usage['cache_read_input_tokens'])
      cacheWriteTokens += num(usage['cache_creation_input_tokens'])
      messages += 1
      const model = typeof record.message?.model === 'string' ? record.message.model : 'unknown'
      byModel.set(model, (byModel.get(model) ?? 0) + output)
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, messages, byModel }
}

/** Start of the current UTC day. */
export function startOfDay(now = Date.now()): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** Start of the trailing seven-day window. */
export function startOfWeek(now = Date.now()): number {
  return startOfDay(now) - 6 * 24 * 60 * 60 * 1000
}

/** A consumption reading against a user-set allowance. */
export interface QuotaReading {
  /** Billable tokens counted in the window (input + output). */
  readonly tokens: number
  /** The allowance this is measured against, when one is configured. */
  readonly budgetTokens?: number | undefined
  /** Percentage of the allowance consumed, when one is configured. */
  readonly percent?: number | undefined
}

/**
 * Express a window's consumption against a configured allowance.
 *
 * Cache reads are excluded because they are billed at a small fraction of the
 * uncached rate; counting them at parity would make a heavily-cached session
 * look far more expensive than it is.
 * @param totals - the folded window.
 * @param budgetTokens - the user's allowance for that window.
 * @returns tokens used and, when an allowance exists, the percentage.
 */
export function quotaReading(totals: UsageTotals, budgetTokens?: number | undefined): QuotaReading {
  const tokens = totals.inputTokens + totals.outputTokens
  if (budgetTokens === undefined || budgetTokens <= 0) return { tokens }
  return { tokens, budgetTokens, percent: (tokens / budgetTokens) * 100 }
}
