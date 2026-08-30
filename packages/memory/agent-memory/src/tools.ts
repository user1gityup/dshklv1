/**
 * Model-facing memory tools.
 *
 * Kept in their own module so the storage plumbing stays testable without a
 * tool registry, and so a deployment that wants the digest without giving
 * models write access can mount the plugin and skip these.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { MemoryEntry, MemoryKind } from './spec.ts'
import { memoryKinds } from './spec.ts'

/** The subset of a KV table these tools need. */
export interface EntryTable {
  get(key: string): MemoryEntry | undefined
  put(key: string, value: MemoryEntry): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, MemoryEntry]>
}

/** Wrap a value schema as a JSON-rendered tool output. */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const WRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    created: { type: 'boolean', required: true },
  },
} as const satisfies ValueSchemaSpec

const RECALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          text: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
    total: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const FORGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { removed: { type: 'boolean', required: true } },
} as const satisfies ValueSchemaSpec

/** Stable id derived from the text, so the same fact written twice updates. */
function idFor(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return `m${(hash >>> 0).toString(36)}`
}

/** Score one entry against a query; higher is a better match. */
function score(entry: MemoryEntry, query: string, tags: readonly string[]): number {
  let points = 0
  const needle = query.toLowerCase()
  if (needle !== '' && entry.text.toLowerCase().includes(needle)) points += 10
  for (const tag of tags) {
    if (entry.tags.includes(tag)) points += 5
  }
  // Recency breaks ties without ever outweighing a content match.
  return points + Math.min(4, entry.updatedAt / 1e13)
}

/** A registry able to accept tool definitions. */
export interface ToolSink {
  register(definition: ReturnType<typeof defineTool>): () => void
}

/**
 * Register the memory tools against one table.
 * @param tools - the tool registry.
 * @param table - the durable entries table.
 * @param scope - default scope stamped on new entries.
 * @returns disposers for every registration.
 */
export function registerMemoryTools(
  tools: ToolSink,
  table: EntryTable,
  scope: string,
): readonly (() => void)[] {
  const disposers: (() => void)[] = []

  disposers.push(tools.register(defineTool({
    name: 'memory_write',
    description:
      'Remember one durable fact, preference, decision, or reference. Shared with every agent and council seat across sessions. Writing the same text twice updates the existing entry rather than duplicating it.',
    parameters: {
      text: { type: 'string', required: true, description: 'The thing to remember, stated so it makes sense with no other context.' },
      kind: { type: 'string', enum: [...memoryKinds], description: 'What kind of item this is. Defaults to fact.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for later recall.' },
    },
    output: jsonOutput(WRITE_SCHEMA),
    async execute(args) {
      const text = args.text.trim()
      const id = idFor(text)
      const existing = table.get(id)
      const now = Date.now()
      const entry: MemoryEntry = {
        id,
        kind: (args.kind as MemoryKind | undefined) ?? existing?.kind ?? 'fact',
        text,
        tags: args.tags === undefined ? existing?.tags ?? [] : [...args.tags],
        scope: existing?.scope ?? scope,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await table.put(id, entry)
      return { id, created: existing === undefined }
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search shared memory. Omit the query to list everything, newest first.',
    parameters: {
      query: { type: 'string', description: 'Text to match against remembered items.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only return entries carrying every one of these tags.' },
      limit: { type: 'integer', description: 'Maximum entries to return. Defaults to 20.' },
    },
    output: jsonOutput(RECALL_SCHEMA),
    async execute(args) {
      const all = [...table.entries()].map(([, value]) => value)
      const tags = args.tags === undefined ? [] : [...args.tags]
      const filtered = tags.length === 0
        ? all
        : all.filter(entry => tags.every(tag => entry.tags.includes(tag)))
      const query = args.query ?? ''
      const ranked = [...filtered]
        .map(entry => ({ entry, points: score(entry, query, tags) }))
        // A query that matches nothing should return nothing, not everything.
        .filter(row => query === '' || row.points >= 10 || tags.length > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, args.limit ?? 20)
      return {
        matches: ranked.map(({ entry }) => ({
          id: entry.id,
          kind: entry.kind,
          text: entry.text,
          tags: entry.tags,
        })),
        total: filtered.length,
      }
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'memory_forget',
    description: 'Remove one remembered entry by its id, as returned by memory_recall.',
    parameters: {
      id: { type: 'string', required: true, description: 'Entry id to remove.' },
    },
    output: jsonOutput(FORGET_SCHEMA),
    async execute(args) {
      const existing = table.get(args.id)
      if (existing === undefined) return { removed: false }
      await table.delete(args.id)
      return { removed: true }
    },
  })))

  return disposers
}
