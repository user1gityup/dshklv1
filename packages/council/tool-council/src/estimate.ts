/**
 * Cost estimation for the planning gate.
 *
 * This is a guess and is labelled as one everywhere it surfaces. A model that
 * decides mid-run to enumerate a million digits will blow through any estimate
 * made before it started. The estimate exists to catch the obvious cases —
 * "this looks like a large job and you have $4 left" — not to be accurate.
 *
 * Two inputs feed it: the planner's own size judgement, and what comparable
 * runs actually cost. History wins when it exists, because a measured average
 * beats a model's self-assessment.
 */

import type { SeatConfig } from './seats.ts'

/** Coarse size bands the planner may report. */
export const scales = ['small', 'medium', 'large', 'huge'] as const

/** One coarse size band. */
export type Scale = (typeof scales)[number]

/** Output-token guesses per band, used when the planner gives no number. */
const SCALE_TOKENS: Record<Scale, number> = {
  small: 800,
  medium: 3_000,
  large: 12_000,
  huge: 50_000,
}

/** What the planner said about the job's size. */
export interface PlanScale {
  readonly scale: Scale
  /** Output tokens the planner expects one seat to produce. */
  readonly outputTokens: number
  /** True when the planner supplied a number rather than only a band. */
  readonly explicit: boolean
}

/**
 * Read the size block out of a plan.
 *
 * Tolerant like the vote parser: a plan that ignores the format still yields a
 * usable band, defaulting to medium rather than refusing to estimate.
 * @param text - the planner's reply.
 * @returns the parsed size judgement.
 */
export function parsePlanScale(text: string): PlanScale {
  const scaleLine = /^\s*SCALE\s*:\s*(\w+)/im.exec(text)
  const tokenLine = /^\s*EST_OUTPUT_TOKENS\s*:\s*([0-9][0-9,_]*)/im.exec(text)
  const claimed = scaleLine?.[1]?.toLowerCase()
  const scale: Scale = (scales as readonly string[]).includes(claimed ?? '')
    ? (claimed as Scale)
    : 'medium'
  const raw = tokenLine?.[1]?.replace(/[,_]/g, '')
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  const explicit = Number.isFinite(parsed) && parsed > 0
  return {
    scale,
    outputTokens: explicit ? parsed : SCALE_TOKENS[scale],
    explicit,
  }
}

/** Per-token prices for one model, in USD. */
export interface ModelPrice {
  readonly prompt: number
  readonly completion: number
}

/**
 * Fetch OpenRouter's public price table.
 *
 * Unauthenticated and free, so it costs nothing to consult before deciding
 * whether a run is affordable.
 * @param signal - abort signal from the tool execution.
 * @returns model id → price, or an empty map when unavailable.
 */
export async function fetchModelPricing(signal?: AbortSignal | undefined): Promise<ReadonlyMap<string, ModelPrice>> {
  const out = new Map<string, ModelPrice>()
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { ...(signal ? { signal } : {}) })
    if (!response.ok) return out
    const body = await response.json() as {
      data?: readonly { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[]
    }
    for (const row of body.data ?? []) {
      if (typeof row.id !== 'string') continue
      const prompt = Number(row.pricing?.prompt)
      const completion = Number(row.pricing?.completion)
      if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue
      out.set(row.id, { prompt, completion })
    }
  } catch {
    // An unreachable price table degrades the estimate, not the run.
  }
  return out
}

/** What a past run actually cost, used to calibrate. */
export interface RunHistory {
  /** Metered cost of one completed full run. */
  readonly costUsd: number
}

/** One seat's share of the estimate. */
export interface SeatEstimate {
  readonly seat: string
  readonly name: string
  /** Undefined for CLI seats, whose spend this process cannot observe. */
  readonly costUsd?: number | undefined
  /** True when the seat bills a subscription rather than credits. */
  readonly metered: boolean
}

/** The complete pre-flight estimate. */
export interface RunEstimate {
  /** Total metered cost expected, in USD. */
  readonly meteredCostUsd: number
  /** Per-seat breakdown. */
  readonly seats: readonly SeatEstimate[]
  /** Output tokens assumed per seat per round. */
  readonly outputTokens: number
  /** Size band the planner reported. */
  readonly scale: Scale
  /** Rounds the full council will run (draft + review). */
  readonly rounds: number
  /** How the figure was reached. */
  readonly basis: 'history' | 'pricing' | 'unknown'
  /** Warnings the user should see before approving. */
  readonly warnings: readonly string[]
}

/** Thresholds the estimate is judged against. */
export interface EstimateLimits {
  /** Remaining OpenRouter credit. */
  readonly remainingUsd?: number | undefined
  /** Monthly OpenRouter target. */
  readonly monthlyUsd?: number | undefined
  /** Spend so far this month. */
  readonly monthUsedUsd?: number | undefined
  /** Weekly Claude token allowance the user set. */
  readonly weeklyClaudeTokens?: number | undefined
  /** Claude tokens already used this week. */
  readonly weeklyClaudeUsed?: number | undefined
}

/** Assume prompts are roughly this multiple of the output, for a rough figure. */
const PROMPT_RATIO = 3

/**
 * Estimate a full council run and judge it against the configured limits.
 * @param seats - the active roster.
 * @param plan - the planner's size judgement.
 * @param pricing - OpenRouter price table.
 * @param history - costs of comparable completed runs.
 * @param limits - budget thresholds.
 * @returns the estimate and any warnings it raises.
 */
export function estimateRun(
  seats: readonly SeatConfig[],
  plan: PlanScale,
  pricing: ReadonlyMap<string, ModelPrice>,
  history: readonly RunHistory[],
  limits: EstimateLimits = {},
): RunEstimate {
  const active = seats.filter(seat => seat.enabled)
  const rounds = 2
  const perSeat: SeatEstimate[] = []
  let metered = 0
  let priced = 0

  for (const seat of active) {
    if (seat.transport !== 'openrouter') {
      perSeat.push({ seat: seat.id, name: seat.name, metered: false })
      continue
    }
    const price = seat.model === undefined ? undefined : pricing.get(seat.model)
    if (price === undefined) {
      perSeat.push({ seat: seat.id, name: seat.name, metered: true })
      continue
    }
    const out = plan.outputTokens * rounds
    const inTok = plan.outputTokens * PROMPT_RATIO * rounds
    const cost = inTok * price.prompt + out * price.completion
    perSeat.push({ seat: seat.id, name: seat.name, costUsd: cost, metered: true })
    metered += cost
    priced += 1
  }

  // A trailing average of real runs is a better predictor than token maths,
  // but only for jobs of ordinary size; a large plan is scaled against it.
  let basis: RunEstimate['basis'] = priced > 0 ? 'pricing' : 'unknown'
  if (history.length > 0) {
    const mean = history.reduce((sum, run) => sum + run.costUsd, 0) / history.length
    const scaleFactor = plan.outputTokens / SCALE_TOKENS.medium
    const fromHistory = mean * scaleFactor
    // Take the larger of the two: under-warning is the costly failure here.
    if (fromHistory > metered) {
      metered = fromHistory
      basis = 'history'
    }
  }

  const warnings: string[] = []
  const remaining = limits.remainingUsd
  if (remaining !== undefined && metered > remaining) {
    warnings.push(
      `estimated $${metered.toFixed(2)} exceeds your remaining OpenRouter credit of $${remaining.toFixed(2)} by $${(metered - remaining).toFixed(2)}`,
    )
  }
  const monthly = limits.monthlyUsd
  const used = limits.monthUsedUsd
  if (monthly !== undefined && used !== undefined && used + metered > monthly) {
    warnings.push(
      `this run would put the month at $${(used + metered).toFixed(2)} against your $${monthly.toFixed(2)} target`,
    )
  }
  const weekly = limits.weeklyClaudeTokens
  const weeklyUsed = limits.weeklyClaudeUsed
  if (weekly !== undefined && weeklyUsed !== undefined) {
    const claudeSeats = active.filter(seat => seat.transport === 'cli').length
    const projected = weeklyUsed + plan.outputTokens * rounds * Math.max(1, claudeSeats)
    if (projected > weekly) {
      warnings.push(
        `this run would reach ${((projected / weekly) * 100).toFixed(0)}% of your weekly Claude allowance`,
      )
    }
  }
  if (plan.scale === 'huge') {
    warnings.push('the planner rated this job huge; estimates at this size are unreliable and the real cost may be far higher')
  }

  return { meteredCostUsd: metered, seats: perSeat, outputTokens: plan.outputTokens, scale: plan.scale, rounds, basis, warnings }
}
