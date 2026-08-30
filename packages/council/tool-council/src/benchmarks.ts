/**
 * Published coding-agent benchmark constants.
 *
 * Sourced from Artificial Analysis' Coding Agent Index v1.4 (composite of
 * DeepSWE, Terminal-Bench v2.1, and SWE-Atlas-QnA), read 2026-08-26. These are
 * measured figures for a specific harness/model pairing on a specific task
 * suite — they are a far better guide than token arithmetic for "how good, how
 * fast, how expensive", but they describe that suite, not your repository.
 *
 * Two limits worth carrying wherever these are used:
 *  - Cost is pay-per-token API cost. A seat billed through a subscription pays
 *    none of it, so a subscription seat's benchmark cost is what it WOULD cost
 *    metered, not what it costs you.
 *  - The benchmark pairs each model with one harness. A different harness moves
 *    the score; the site publishes a harness comparison showing exactly that.
 *
 * @see https://artificialanalysis.ai/agents/coding-agents
 */

/** One benchmarked agent/model pairing. */
export interface Benchmark {
  /** Harness and model, as the source names it. */
  readonly label: string
  /** Coding Agent Index v1.4 composite; higher is better. */
  readonly index: number
  /** Average pay-per-token API cost per task, USD. */
  readonly costPerTaskUsd: number
  /** Average wall-clock runtime per task, minutes. */
  readonly minutesPerTask: number
}

/** The published table, keyed by the council seat it informs. */
export const BENCHMARKS: Readonly<Record<string, Benchmark>> = {
  claude: {
    label: 'Claude Code — Opus 5 (xhigh)',
    index: 68,
    costPerTaskUsd: 8.17,
    minutesPerTask: 23.7,
  },
  openai: {
    label: 'Codex — GPT-5.6 Sol (max)',
    index: 65,
    costPerTaskUsd: 6.42,
    minutesPerTask: 10.2,
  },
  kimi: {
    label: 'Kimi Code CLI — Kimi K3',
    index: 63,
    costPerTaskUsd: 3.08,
    minutesPerTask: 24.1,
  },
  deepseek: {
    // The benchmarked DeepSeek pairing is V4 Flash under Codex. A v4-pro seat
    // will score higher and cost more; this row understates both.
    label: 'Codex — DeepSeek V4 Flash 0731 (max)',
    index: 50,
    costPerTaskUsd: 0.06,
    minutesPerTask: 14.5,
  },
}

/** How a council compares with working through one seat alone. */
export interface CouncilComparison {
  /** Seats contributing a benchmarked figure. */
  readonly seats: readonly { id: string; benchmark: Benchmark; metered: boolean }[]
  /** Best index among the participating seats. */
  readonly bestIndex: number
  /** Mean index across participating seats. */
  readonly meanIndex: number
  /** Metered API cost for one full council run, both rounds. */
  readonly meteredCostPerRun: number
  /** What the same run would cost if every seat were billed per token. */
  readonly unmeteredEquivalent: number
  /** Wall-clock minutes for one full run: rounds x slowest seat. */
  readonly minutesPerRun: number
  /** Minutes the single best seat would take for one answer. */
  readonly soloMinutes: number
  /** Distinct answers the council compares. */
  readonly perspectives: number
}

/** A full council spends a draft round and a review round. */
const ROUNDS = 2

/**
 * Compare a council configuration against its single strongest seat.
 *
 * Wall time assumes seats are asked concurrently, so a round costs the slowest
 * seat rather than the sum — which is the entire reason the council fans out.
 * @param seatIds - participating seat ids.
 * @param metered - which of those seats pay per token.
 * @returns the comparison, or undefined when no seat is benchmarked.
 */
export function compareCouncil(
  seatIds: readonly string[],
  metered: (id: string) => boolean,
): CouncilComparison | undefined {
  const seats = seatIds
    .map(id => ({ id, benchmark: BENCHMARKS[id], metered: metered(id) }))
    .filter((row): row is { id: string; benchmark: Benchmark; metered: boolean } => row.benchmark !== undefined)
  if (seats.length === 0) return undefined

  const indices = seats.map(row => row.benchmark.index)
  const bestIndex = Math.max(...indices)
  const meanIndex = indices.reduce((sum, value) => sum + value, 0) / indices.length
  const slowest = Math.max(...seats.map(row => row.benchmark.minutesPerTask))
  const best = seats.find(row => row.benchmark.index === bestIndex)

  const meteredCostPerRun = seats
    .filter(row => row.metered)
    .reduce((sum, row) => sum + row.benchmark.costPerTaskUsd, 0) * ROUNDS
  const unmeteredEquivalent = seats
    .reduce((sum, row) => sum + row.benchmark.costPerTaskUsd, 0) * ROUNDS

  return {
    seats,
    bestIndex,
    meanIndex,
    meteredCostPerRun,
    unmeteredEquivalent,
    minutesPerRun: slowest * ROUNDS,
    soloMinutes: best?.benchmark.minutesPerTask ?? slowest,
    perspectives: seats.length * ROUNDS,
  }
}

/**
 * Render the comparison for the console.
 * @param comparison - the computed comparison.
 * @returns lines ready to print.
 */
export function renderComparison(comparison: CouncilComparison): readonly string[] {
  const out: string[] = [
    'BENCHMARK COMPARISON — published figures, not your repository',
    '',
  ]
  for (const row of comparison.seats) {
    const cost = row.metered
      ? `$${row.benchmark.costPerTaskUsd.toFixed(2)}/task`
      : `$${row.benchmark.costPerTaskUsd.toFixed(2)}/task if metered — covered by subscription`
    out.push(`  ${row.benchmark.label}`)
    out.push(`    index ${String(row.benchmark.index)} · ${row.benchmark.minutesPerTask.toFixed(1)}m/task · ${cost}`)
  }
  out.push('')
  out.push(`  Best single seat:      index ${String(comparison.bestIndex)}, ~${comparison.soloMinutes.toFixed(1)}m`)
  out.push(`  Council mean index:    ${comparison.meanIndex.toFixed(1)} across ${String(comparison.perspectives)} perspectives`)
  out.push(`  Council wall time:     ~${comparison.minutesPerRun.toFixed(1)}m (${String(ROUNDS)} rounds, seats run concurrently)`)
  out.push(`  Council metered cost:  $${comparison.meteredCostPerRun.toFixed(2)} per run`)
  out.push(`  If nothing were subscription: $${comparison.unmeteredEquivalent.toFixed(2)} per run`)
  out.push('')
  out.push('  A council does not raise the ceiling of its best seat; it raises the')
  out.push('  chance of reaching that ceiling, by letting weaker drafts be rejected.')
  return out
}
