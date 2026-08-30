/**
 * Cross-session agent memory.
 *
 * Owns one durable domain holding remembered items and council run telemetry,
 * and renders a digest file that out-of-process agents can read. The digest is
 * the distribution mechanism: a CLI seat runs in its own process and cannot
 * reach `ctx.storage`, but it can be handed a file.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { agentMemoryDomainSpec, memoryKinds } from './spec.ts'
import { registerMemoryTools } from './tools.ts'
import type { MemoryEntry, MemoryKind } from './spec.ts'

export { agentMemoryDomainSpec, memoryKinds } from './spec.ts'
export type { CouncilRun, MemoryEntry, MemoryKind, SeatCall } from './spec.ts'

/** Cordis plugin name. */
export const name = 'agent-memory'
/** The durable domain facility this plugin opens, plus the tool registry. */
export const inject = ['storageDomain', 'tools']

/** Memory configuration. */
export interface Config {
  /** Where the digest is written; defaults to `$DSH_HOME/memory/digest.md`. */
  digestPath?: string
  /** Maximum entries rendered into the digest, newest first. */
  digestLimit?: number
  /** Register the model-facing memory tools. On by default. */
  tools?: boolean
}

/** Group entries by kind, newest first inside each group. */
function groupByKind(entries: readonly MemoryEntry[]): Map<MemoryKind, MemoryEntry[]> {
  const grouped = new Map<MemoryKind, MemoryEntry[]>()
  for (const kind of memoryKinds) grouped.set(kind, [])
  for (const entry of entries) grouped.get(entry.kind)?.push(entry)
  for (const list of grouped.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return grouped
}

/**
 * Render the digest every agent reads.
 *
 * Markdown rather than JSON because its consumers are language models and two
 * of them (Claude Code, Codex) discover markdown context files natively.
 * @param entries - the remembered items.
 * @param limit - maximum entries to render.
 * @returns the digest text.
 */
export function renderDigest(entries: readonly MemoryEntry[], limit = 200): string {
  const out: string[] = ['# Shared agent memory', '']
  if (entries.length === 0) {
    out.push('_No memories recorded yet._', '')
    return out.join('\n')
  }
  out.push(
    'These facts are shared by every agent and council seat. Treat them as',
    'established context; if one contradicts what you observe, say so rather',
    'than silently ignoring it.',
    '',
  )
  let rendered = 0
  for (const [kind, list] of groupByKind(entries)) {
    if (list.length === 0) continue
    out.push(`## ${kind}`, '')
    for (const entry of list) {
      if (rendered >= limit) break
      const tags = entry.tags.length === 0 ? '' : ` _(${entry.tags.join(', ')})_`
      out.push(`- ${entry.text}${tags}`)
      rendered += 1
    }
    out.push('')
  }
  return out.join('\n')
}

/** Resolve the harness home the same way the launcher does. */
function resolveHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Default digest location, inside the harness home. */
export function defaultDigestPath(): string {
  return join(resolveHome(), 'memory', 'digest.md')
}

/**
 * Write the digest to disk, creating its directory when absent.
 * @param text - rendered digest.
 * @param path - destination; defaults to {@link defaultDigestPath}.
 * @returns the path written, or undefined when the write failed.
 */
export function writeDigest(text: string, path?: string): string | undefined {
  const target = path ?? defaultDigestPath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
    return target
  } catch {
    // A digest that cannot be written degrades sharing, not the session.
    return undefined
  }
}

/**
 * Open the memory domain and keep the digest current.
 * @param ctx - the Cordis context supplying the storage domain.
 * @param config - digest destination and size.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const digestPath = config.digestPath ?? defaultDigestPath()
  const limit = config.digestLimit ?? 200

  ctx.effect(() => {
    let disposed = false
    const open = async (): Promise<void> => {
      const domain = await ctx.storageDomain.open(agentMemoryDomainSpec)
      if (disposed) {
        await domain.close()
        return
      }
      const entries = domain.table('entries')
      const refresh = (): void => {
        const all = [...entries.entries()].map(([, value]) => value)
        writeDigest(renderDigest(all, limit), digestPath)
      }
      refresh()
      if (config.tools !== false) {
        // Scope defaults to the process cwd so a project-specific memory can be
        // distinguished from a global one later without a schema change.
        const disposers = registerMemoryTools(ctx.tools, entries, process.cwd())
        ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'agent-memory.tools')
      }
      ctx.on('domain/changed', (event: { domain?: string }) => {
        if (event.domain === agentMemoryDomainSpec.name) refresh()
      })
    }
    void open()
    return () => { disposed = true }
  }, 'agent-memory.open')
}
