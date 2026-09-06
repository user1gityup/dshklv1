/**
 * Reading the real Claude Code quota.
 *
 * Nothing on disk carries the allowance: the session logs record tokens spent
 * but never the ceiling they were spent against, so folding tokens can only
 * ever answer "how much work", never "how much is left". The one source of the
 * real percentages is `claude -p "/usage"`, which the CLI answers locally — no
 * assistant turn — and prints as prose meant for a person.
 *
 * That call takes seconds and costs one request against the very quota it
 * reports, so it never runs on a timer here. Boot reads the status line's
 * cache file, which is free; a live call happens only when the user asks.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Figures parsed out of one `/usage` answer. Every field is optional: the source is prose. */
export interface QuotaReading {
  /** Percent of the current session window used. */
  sessionPercent?: number
  /** When the session window resets, as the CLI worded it. */
  sessionResets?: string
  /** Percent of the current week used. */
  weekPercent?: number
  /** When the week resets, as the CLI worded it. */
  weekResets?: string
  /** Requests in the last 24 hours. */
  requests24h?: number
  /** Sessions in the last 24 hours. */
  sessions24h?: number
  /** Requests in the last 7 days. */
  requests7d?: number
  /** Sessions in the last 7 days. */
  sessions7d?: number
  /** Share of usage spent above {@link bigContextThresholdK} context. */
  bigContextPercent?: number
  /** Context threshold, in thousands of tokens, the share above is measured at. */
  bigContextThresholdK?: number
  /** Share of usage from sessions active {@link longSessionHours}+ hours. */
  longSessionPercent?: number
  /** Session-age threshold, in hours, the share above is measured at. */
  longSessionHours?: number
  /** Epoch milliseconds the reading was taken. */
  capturedAt?: number
}

/** Where the status line keeps its cached figures; shared with it, not owned. */
export function defaultCachePath(): string {
  return join(homedir(), '.claude', 'statusline', 'usage-cache.json')
}

/**
 * Locate the Claude Code executable.
 *
 * npm puts `claude`, `claude.cmd` and `claude.ps1` on PATH, but node refuses
 * to spawn a `.cmd` without a shell (CVE-2024-27980) and this must never open
 * one, so the real binary inside the package is what gets used.
 * @returns an absolute path when one is found, else the bare command name.
 */
export function claudeBinary(): string {
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'),
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/**
 * Parse the human-readable `/usage` output.
 *
 * Deliberately tolerant: this is prose, not a contract, so a wording change
 * costs one field rather than the whole reading.
 * @param text - raw `/usage` output.
 * @param now - epoch milliseconds to stamp the reading with.
 * @returns the figures that could be read.
 */
export function parseUsage(text: string, now = Date.now()): QuotaReading {
  const out: QuotaReading = { capturedAt: now }

  const session = /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text)
  if (session?.[1] !== undefined) {
    out.sessionPercent = Number(session[1])
    if (session[2] !== undefined) out.sessionResets = session[2].trim()
  }

  const week = /Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text)
  if (week?.[1] !== undefined) {
    out.weekPercent = Number(week[1])
    if (week[2] !== undefined) out.weekResets = week[2].trim()
  }

  const day = /Last 24h\s*·\s*(\d+)\s*requests\s*·\s*(\d+)\s*sessions/i.exec(text)
  if (day?.[1] !== undefined && day[2] !== undefined) {
    out.requests24h = Number(day[1])
    out.sessions24h = Number(day[2])
  }

  const week7 = /Last 7d\s*·\s*(\d+)\s*requests\s*·\s*(\d+)\s*sessions/i.exec(text)
  if (week7?.[1] !== undefined && week7[2] !== undefined) {
    out.requests7d = Number(week7[1])
    out.sessions7d = Number(week7[2])
  }

  // The efficiency levers: what characterised the usage, not what it cost.
  const bigContext = /(\d+)%\s*of your usage was at >\s*(\d+)k context/i.exec(text)
  if (bigContext?.[1] !== undefined && bigContext[2] !== undefined) {
    out.bigContextPercent = Number(bigContext[1])
    out.bigContextThresholdK = Number(bigContext[2])
  }

  const longSessions = /(\d+)%\s*of your usage came from sessions active for (\d+)\+\s*hours/i.exec(text)
  if (longSessions?.[1] !== undefined && longSessions[2] !== undefined) {
    out.longSessionPercent = Number(longSessions[1])
    out.longSessionHours = Number(longSessions[2])
  }

  return out
}

/** A reading with neither percentage is a failed read, not a quota at zero. */
export function isUsable(reading: QuotaReading): boolean {
  return reading.sessionPercent !== undefined || reading.weekPercent !== undefined
}

/**
 * Read the cached figures the status line wrote.
 * @param path - cache file; defaults to the status line's own.
 * @returns the cached reading, or undefined when there is none worth showing.
 */
export function readCache(path = defaultCachePath()): QuotaReading | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const reading = parsed as QuotaReading
    return isUsable(reading) ? reading : undefined
  } catch {
    // A truncated or half-written cache is not worth failing boot over.
    return undefined
  }
}

/**
 * Write figures back to the shared cache, so a refresh made here also freshens
 * the status line instead of each surface paying for its own call.
 * @param reading - figures to store.
 * @param path - cache file; defaults to the status line's own.
 */
export function writeCache(reading: QuotaReading, path = defaultCachePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(reading, null, 2))
  } catch {
    // The cache is a courtesy to the status line; failing to write it must not
    // lose the reading the panel is about to show.
  }
}

/**
 * Run `/usage` and return its raw output.
 * @param timeoutMs - hard cap; the child is killed and whatever arrived is returned.
 * @returns raw `/usage` output, empty when the call failed.
 */
export async function readUsageText(timeoutMs = 90_000): Promise<string> {
  return new Promise<string>((resolve) => {
    let stdout = ''
    let child
    try {
      child = spawn(claudeBinary(), ['-p', '/usage'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve('')
      return
    }
    // A refresh that hangs must not hold a process open behind the panel.
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(stdout) }, timeoutMs)
    child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(stdout) })
  })
}

/**
 * Take a live reading and fold it into the shared cache.
 * @param timeoutMs - hard cap on the CLI call.
 * @param path - cache file; defaults to the status line's own.
 * @returns the reading, or undefined when the call produced nothing usable.
 */
export async function refresh(timeoutMs?: number, path?: string): Promise<QuotaReading | undefined> {
  const reading = parseUsage(await readUsageText(timeoutMs))
  // Never overwrite good figures with an empty read: a failed refresh leaves
  // the last known numbers standing, stale by their own timestamp.
  if (!isUsable(reading)) return undefined
  writeCache(reading, path)
  return reading
}
