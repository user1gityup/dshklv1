/**
 * Durable storage-domain declaration for cross-session agent memory.
 * @module @deepseek-ai/dsh-agent-memory/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** What a remembered item is, which decides how the digest groups it. */
export const memoryKinds = ['fact', 'preference', 'decision', 'reference'] as const

/** One remembered item's kind. */
export type MemoryKind = (typeof memoryKinds)[number]

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** One durable memory entry. */
export const memoryEntrySchema = z.object({
  /** Stable id; also the table key. */
  id: z.string().min(1),
  /** Grouping used by the digest. */
  kind: z.enum(memoryKinds),
  /** The remembered content, in the user's own terms. */
  text: z.string().min(1),
  /** Free-form tags for recall filtering. */
  tags: z.array(z.string()),
  /**
   * Where this applies: `global`, or an absolute workspace path. A scoped
   * entry stays out of digests rendered for other workspaces.
   */
  scope: z.string().min(1),
  createdAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
})

/** One durable memory entry, inferred from {@link memoryEntrySchema}. */
export type MemoryEntry = z.infer<typeof memoryEntrySchema>


/** One seat's metered call inside a council run. */
export const seatCallSchema = z.object({
  /** Seat id that made the call. */
  seat: z.string().min(1),
  /** Which transport carried it, deciding whether cost is knowable. */
  transport: z.enum(['cli', 'openrouter']),
  /** Model identifier, when the transport reports one. */
  model: z.string().optional(),
  /** Which round the call belonged to. */
  round: z.enum(['plan', 'draft', 'review']),
  /** Wall time for the call. */
  ms: nonNegativeInteger,
  /** Provider-reported prompt tokens, when available. */
  inputTokens: nonNegativeInteger.optional(),
  /** Provider-reported completion tokens, when available. */
  outputTokens: nonNegativeInteger.optional(),
  /**
   * Provider-reported cost in USD. Present for OpenRouter calls, which return
   * it per request; absent for CLI seats, whose spend is billed to a separate
   * subscription and is not observable from here.
   */
  costUsd: z.number().nonnegative().optional(),
  /** Whether the call produced usable text. */
  ok: z.boolean(),
})

/** One seat call's telemetry, inferred from {@link seatCallSchema}. */
export type SeatCall = z.infer<typeof seatCallSchema>

/**
 * One council run's telemetry.
 *
 * Recorded so spend can be reconstructed after the fact: a budget tool needs
 * per-seat cost and duration history, and none of it is recoverable once the
 * run ends unless it is written down at the time.
 */
export const councilRunSchema = z.object({
  id: z.string().min(1),
  startedAt: nonNegativeInteger,
  /** Query prefix, truncated; kept for attribution, not for replay. */
  query: z.string(),
  /** Whether the run stopped at planning or went the whole way. */
  phase: z.enum(['plan', 'full']),
  calls: z.array(seatCallSchema),
  /** Summed cost of the metered calls in this run. */
  meteredCostUsd: z.number().nonnegative(),
  /** Wall time from first call to last. */
  totalMs: nonNegativeInteger,
})

/** One council run's telemetry, inferred from {@link councilRunSchema}. */
export type CouncilRun = z.infer<typeof councilRunSchema>

/** Cross-session memory shared by every agent and council seat. */
export const agentMemoryDomainSpec = defineDomain({
  name: 'agent_memory',
  version: 0,
  tables: {
    entries: domainTable<string, MemoryEntry>(memoryEntrySchema),
    runs: domainTable<string, CouncilRun>(councilRunSchema),
  },
})
