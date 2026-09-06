/**
 * What executing a decomposition will cost, before any of it runs.
 *
 * The council's estimator prices a *conversation*: N seats answering one
 * question for a couple of rounds. Execution is a different shape — units of
 * work, run by workers, some of which are paid for by subscription and some
 * metered per token — so it needs its own arithmetic rather than a reused
 * number that happens to be in the same currency.
 *
 * Every figure here is an estimate and says so. The only cost anyone should
 * trust afterwards is the provider's own reported spend.
 */

import type { ModelPrice } from './estimate.ts'
import type { SubTask } from './decompose.ts'
import { executionWaves } from './decompose.ts'

/** How a provider is paid for. */
export type CostClass =
  /** Absorbed by a subscription already paid for; no metered cost. */
  | 'included'
  /** Billed per token. */
  | 'metered'

/** One worker provider and how it bills. */
export interface ProviderCost {
  readonly name: string
  readonly costClass: CostClass
  /** Model id for price lookup. Metered providers without one cannot be priced. */
  readonly model?: string | undefined
}

/** Estimated cost of one unit of work. */
export interface TaskCost {
  readonly id: string
  readonly provider: string
  readonly costClass: CostClass
  /** Output tokens assumed for this unit. */
  readonly outputTokens: number
  /** Estimated USD, or undefined when the provider could not be priced. */
  readonly usd?: number | undefined
}

/** Estimated cost of a whole decomposition. */
export interface ExecutionEstimate {
  readonly tasks: readonly TaskCost[]
  /** Units running concurrently, in execution order. */
  readonly waveSizes: readonly number[]
  /** Sum of every priced unit. */
  readonly meteredUsd: number
  /** Units carried by a subscription rather than metered spend. */
  readonly includedCount: number
  /** Units whose provider carries no price, so they are missing from the total. */
  readonly unpricedCount: number
  /** Caveats the reader must weigh before trusting the figure. */
  readonly caveats: readonly string[]
}

/**
 * Output tokens assumed per unit of work.
 *
 * A unit of build work is substantially larger than a chat answer: it reads
 * context, writes code, and reports back. Deliberately generous — an estimate
 * that under-predicts is worse than useless at an approval gate, because it
 * buys consent for a number that was never real.
 */
const TOKENS_PER_TASK = 6_000

/** Input runs this multiple of output for agentic work, which re-reads context. */
const PROMPT_RATIO = 4

/**
 * Price one unit of work.
 * @param task - the unit.
 * @param provider - the provider it will run on.
 * @param pricing - OpenRouter price table.
 * @returns the unit's estimated cost.
 */
function priceTask(
  task: SubTask,
  provider: ProviderCost,
  pricing: ReadonlyMap<string, ModelPrice>,
): TaskCost {
  const base = {
    id: task.id,
    provider: provider.name,
    costClass: provider.costClass,
    outputTokens: TOKENS_PER_TASK,
  }
  if (provider.costClass === 'included') return base
  const price = provider.model === undefined ? undefined : pricing.get(provider.model)
  if (price === undefined) return base
  const usd = TOKENS_PER_TASK * price.completion + TOKENS_PER_TASK * PROMPT_RATIO * price.prompt
  return { ...base, usd }
}

/**
 * Estimate what running a decomposition will cost.
 * @param tasks - the validated task graph.
 * @param providers - providers available, keyed by name.
 * @param pricing - OpenRouter price table.
 * @param fallbackProvider - provider used by units that name none.
 * @returns the estimate and its caveats.
 */
export function estimateExecution(
  tasks: readonly SubTask[],
  providers: readonly ProviderCost[],
  pricing: ReadonlyMap<string, ModelPrice>,
  fallbackProvider: string,
): ExecutionEstimate {
  const byName = new Map(providers.map(provider => [provider.name, provider]))
  // A unit naming no provider, or an unknown one, runs on the default: that is
  // what execution would actually do, so the estimate must price it that way.
  const fallback = byName.get(fallbackProvider)
    ?? { name: fallbackProvider, costClass: 'metered' as const }

  const priced = tasks.map((task) => {
    const provider = (task.provider === undefined ? undefined : byName.get(task.provider)) ?? fallback
    return priceTask(task, provider, pricing)
  })

  const meteredUsd = priced.reduce((sum, task) => sum + (task.usd ?? 0), 0)
  const includedCount = priced.filter(task => task.costClass === 'included').length
  const unpricedCount = priced.filter(task => task.costClass === 'metered' && task.usd === undefined).length

  const caveats: string[] = [
    `each unit is assumed to produce ~${TOKENS_PER_TASK.toLocaleString()} output tokens with ${String(PROMPT_RATIO)}x that in input`,
  ]
  if (unpricedCount > 0) {
    caveats.push(`${String(unpricedCount)} unit(s) run on a provider with no published price and are missing from the total`)
  }
  if (includedCount > 0) {
    caveats.push(`${String(includedCount)} unit(s) run on a subscription and cost nothing metered, but still consume that subscription's quota`)
  }
  const waves = executionWaves(tasks)
  if (waves.length > 0 && Math.max(...waves.map(wave => wave.length)) > 4) {
    caveats.push('a wide wave runs many workers at once: spend arrives faster than a sequential run, even though the total is the same')
  }

  return {
    tasks: priced,
    waveSizes: waves.map(wave => wave.length),
    meteredUsd,
    includedCount,
    unpricedCount,
    caveats,
  }
}

/**
 * Render an execution estimate for the approval surface.
 * @param estimate - the estimate.
 * @returns markdown lines.
 */
export function renderExecutionEstimate(estimate: ExecutionEstimate): readonly string[] {
  const out: string[] = [
    `**Execution estimate** — ${String(estimate.tasks.length)} unit(s) in ${String(estimate.waveSizes.length)} wave(s) of ${estimate.waveSizes.join(', ')}`,
    '',
    `- Metered cost: **$${estimate.meteredUsd.toFixed(4)}**`,
  ]
  if (estimate.includedCount > 0) {
    out.push(`- On subscription (no metered cost): ${String(estimate.includedCount)} unit(s)`)
  }
  if (estimate.unpricedCount > 0) {
    out.push(`- Unpriced, so missing from the total: ${String(estimate.unpricedCount)} unit(s)`)
  }
  out.push('')
  for (const caveat of estimate.caveats) out.push(`> ${caveat}`)
  return out
}
