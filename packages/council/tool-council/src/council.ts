/**
 * Council orchestration: draft, review, tally.
 *
 * Both rounds fan out with `Promise.allSettled` semantics — every seat returns
 * a reply object rather than throwing — so one unreachable CLI or one rate-limited
 * model degrades that seat only. A council of two still produces a verdict.
 */

import type { RunEstimate } from './estimate.ts'
import type { BudgetDecision, BudgetLimits } from './budget.ts'
import { judgeBudget, readBalance, spendBetween } from './budget.ts'
import type { SeatId } from './colors.ts'
import type { SeatConfig, SeatReply } from './seats.ts'
import { auditDraft } from './verify.ts'
import type { DraftAudit, FetchSeam } from './verify.ts'
import { gatherEvidence, gatherRequested, parseSearchRequests, researchPrompt } from './evidence.ts'
import type { FileSeam } from './files.ts'
import { gatherFiles, parseReadRequests, readRequestSection } from './files.ts'
import type { Evidence, SearchSeam } from './evidence.ts'
import { askSeat } from './seats.ts'

/** One seat's review of the drafts, with its vote. */
export interface SeatReview {
  readonly seat: SeatId
  /** Seat voted for, when it named one the council recognises. */
  readonly vote?: SeatId | undefined
  /** Self-reported confidence in that vote, clamped to 0..1. */
  readonly confidence: number
  /** Prose critique, verbatim from the seat. */
  readonly critique: string
  /** Failure description; `undefined` on success. */
  readonly error?: string | undefined
  /** Wall time spent on the call. */
  readonly ms: number
}

/**
 * How much a seat's vote for itself counts.
 *
 * A self-vote is not worthless — a seat that genuinely wrote the best draft
 * should be able to say so — but at full weight it turns the tally into a
 * confidence contest that the least calibrated seat wins. Halving it means a
 * seat needs at least some outside support to beat a peer-endorsed rival.
 */
const SELF_VOTE_WEIGHT = 0.5

/** Final tally across all reviews. */
export interface Verdict {
  /** Seat whose draft won, or `undefined` when nobody could be chosen. */
  readonly winner?: SeatId | undefined
  /** Summed confidence per candidate. */
  readonly scores: ReadonlyMap<SeatId, number>
  /** Raw vote counts per candidate. */
  readonly counts: ReadonlyMap<SeatId, number>
  /** How the winner was decided. */
  readonly method: 'peer' | 'confidence' | 'majority' | 'sole-draft' | 'none'
  /** True when two candidates tied on confidence and count. */
  readonly tied: boolean
  /** Confidence contributed by seats other than the candidate itself. */
  readonly peerScores: ReadonlyMap<SeatId, number>
  /** Seats whose review failed, so their vote never counted. */
  readonly missingVoters: readonly SeatId[]
}

/** How far a run got. */
export type CouncilPhase = 'plan' | 'full'

/** A progress event emitted as the council works. */
export interface CouncilEvent {
  /** Which round produced it. */
  readonly round: 'plan' | 'draft' | 'review'
  /** Seat that settled. */
  readonly seat: SeatId
  /** Seat display name. */
  readonly name: string
  /** Wall time for that seat's call. */
  readonly ms: number
  /** Provider-reported cost, when the transport reports one. */
  readonly costUsd?: number | undefined
  /** Whether the call produced usable text. */
  readonly ok: boolean
  /** Metered cost accumulated across the run so far. */
  readonly runningCostUsd: number
}

/** Everything one council run produced. */
export interface CouncilResult {
  /** Which phase this run stopped at. */
  readonly phase: CouncilPhase
  /**
   * Sources retrieved and shared with every seat before drafting. Empty when
   * no tool-less seat was active, or when retrieval failed — the report says
   * which, so an ungrounded answer is never mistaken for a grounded one.
   */
  readonly evidenceUrls?: readonly string[] | undefined
  /** Why the spending gate stayed shut, when it did. */
  readonly approval?: { readonly allowed: boolean; readonly reason: string; readonly missing?: 'trigger' | 'verbal' | 'plan' | 'expired' | undefined } | undefined
  /**
   * Per-draft citation audit. Present whenever drafts ran, so the report can
   * show which answers were actually sourced and which only looked sourced.
   */
  readonly audits?: readonly DraftAudit[] | undefined
  /**
   * Planner seats that failed before one succeeded. Reported rather than
   * swallowed: a plan written by the third choice is worth knowing about.
   */
  readonly planFailures?: readonly { readonly seat: SeatId; readonly error: string }[] | undefined
  /** Competing plans, when the council voted on the plan. */
  readonly planDrafts?: readonly SeatReply[] | undefined
  /** Votes cast on those plans. */
  readonly planReviews?: readonly SeatReview[] | undefined
  /** How the winning plan won. */
  readonly planVerdict?: Verdict | undefined
  /** Why the Approve control could not be offered, when it could not. */
  readonly issueProblem?: string | undefined
  /** The agreed approach, when a planning round ran or one was supplied. */
  readonly plan?: string | undefined
  /** The seat that produced the plan, when the council generated it. */
  readonly planSeat?: SeatId | undefined
  /** The pre-flight budget decision, when a check was configured. */
  readonly budget?: BudgetDecision | undefined
  /** Actual OpenRouter spend for this run, measured as a balance delta. */
  readonly spentUsd?: number | undefined
  /** Pre-flight estimate produced during the planning gate. */
  readonly estimate?: RunEstimate | undefined
  readonly query: string
  readonly seats: readonly SeatConfig[]
  readonly drafts: readonly SeatReply[]
  readonly reviews: readonly SeatReview[]
  readonly verdict: Verdict
  /** The winning draft's text, empty when there is no winner. */
  readonly answer: string
}

/** Options one run needs beyond the seats themselves. */
export interface RunOptions {
  readonly query: string
  readonly seats: readonly SeatConfig[]
  readonly apiKey?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs: number
  /** Run seats one at a time instead of in parallel. */
  readonly sequential?: boolean | undefined
  /**
   * An already-approved plan. When present the planning round is skipped and
   * every draft is written against this plan.
   */
  readonly plan?: string | undefined
  /** Seat id that writes the plan. Defaults to the cheapest configured seat. */
  readonly plannerSeat?: string | undefined
  /**
   * How the plan is produced. `single` asks one cheap seat; `council` has every
   * seat propose a plan and the council vote on which to follow.
   *
   * The plan is the decision every later round inherits, so resting it on one
   * seat makes the cheapest seat the most influential one in the run.
   */
  readonly planMode?: 'single' | 'council' | undefined
  /** Skip planning entirely and go straight to drafting. */
  readonly skipPlan?: boolean | undefined
  /** Budget thresholds checked before any call is made. */
  readonly budget?: BudgetLimits | undefined
  /**
   * Shared memory handed to each seat: CLI seats receive the file path, hosted
   * seats receive the text inline because they have no filesystem.
   */
  readonly memory?: { file?: string | undefined; text?: string | undefined } | undefined
  /** Estimate attached to a plan-phase result by the caller. */
  readonly estimate?: RunEstimate | undefined
  /**
   * Called as each seat settles, so a long run reports progress instead of
   * going silent for minutes.
   */
  readonly onEvent?: ((event: CouncilEvent) => void) | undefined
  /**
   * Stop after the planning round and return the plan for review. This is the
   * point of the phase: one cheap call decides direction before N expensive
   * ones commit to it.
   */
  readonly planOnly?: boolean | undefined
  /**
   * Web seam used to retrieve one shared evidence block before drafting.
   * Omitted, or failing, simply means seats are told no evidence was
   * retrieved — which is still far better than leaving them to guess.
   */
  readonly web?: (SearchSeam & Partial<FetchSeam>) | undefined
  /**
   * Web results each hosted seat may request per call. Undefined or zero
   * leaves them offline, answering from training data alone.
   */
  readonly webMaxResults?: number | undefined
  /**
   * Let each seat say what it wants looked up, then run those searches through
   * the web seam on its behalf. The seam's router prefers a subscription
   * route, so the searches themselves are normally free — only the short round
   * where seats state their queries costs anything.
   */
  readonly seatResearch?: boolean | undefined
  /**
   * File seam used to serve the paths seats ask for. A seat never reads for
   * itself; it names a path and this reads it, or refuses.
   */
  readonly files?: FileSeam | undefined
  /**
   * Absolute directories the seats may be shown files from. Empty — the
   * default — means no seat is told it can ask for a file at all.
   */
  readonly fileRoots?: readonly string[] | undefined
}

/** Prompt for the planning round. */
function planPrompt(query: string): string {
  return `Before a council of models answers the question below, produce a short plan so they all work in the same direction.

Keep it under 200 words. Cover exactly:
1. RESTATEMENT — what is actually being asked, in one sentence.
2. APPROACH — the shape a good answer should take.
3. ASSUMPTIONS — anything you had to assume, that the user should correct if wrong.
4. RISKS — where an answer could go in an unwanted direction.

Then, on their own lines, judge the size of the job:
SCALE: <small|medium|large|huge>
EST_OUTPUT_TOKENS: <your estimate of output tokens ONE model needs to answer fully>

Do not answer the question itself.

QUESTION:
${query}`
}

/**
 * What a seat is told about its own tools.
 *
 * A seat with no tools that is asked to be "specific and concrete" about a
 * current fact will often emit tool-call syntax it cannot execute and then
 * present training data as verified. Saying plainly that the tools are absent
 * costs a few tokens and removes the incentive entirely.
 */
function toolNotice(toolless: boolean, hasEvidence: boolean, online: boolean): string {
  if (!toolless) return ''
  // A seat that can search must not be told it cannot. The notice exists to
  // stop a tool-less seat faking tool calls; aimed at a seat with live search
  // it would suppress the very capability the user is paying per result for.
  if (online) {
    return `

YOUR TOOLS: you have live web search in this call. Use it to check anything current, and cite what you actually consulted. Do not present recalled figures as verified — if you did not look it up, mark it [unverified].`
  }
  const source = hasEvidence
    ? 'Work from the EVIDENCE above and your own knowledge.'
    : 'No evidence could be retrieved for this question, so work from your own knowledge alone.'
  return `

YOUR TOOLS: you have none in this call. No search, no page fetch, no filesystem. ${source} Do not emit tool-call syntax of any kind — it will not run, and text shaped like a tool call is treated as a fabricated result. Mark any claim you cannot support from the evidence as [unverified], and say plainly when your knowledge may be out of date.`
}

/** Prompt for the drafting round, optionally constrained by an agreed plan. */
function draftPrompt(
  query: string,
  plan: string | undefined,
  evidence: Evidence | undefined,
  toolless: boolean,
  online: boolean,
): string {
  const guidance = plan === undefined || plan === ''
    ? ''
    : `

The council agreed this approach. Follow it unless it is plainly wrong, and say so if it is:
${plan}`
  const facts = evidence === undefined ? '' : `

${evidence.block}`
  return `You are one member of a council answering a user's question.

Give your best complete answer. Be specific and concrete. Do not mention that you are part of a council, and do not address the other members.${facts}${toolNotice(toolless, evidence !== undefined, online)}${guidance}

USER QUESTION:
${query}`
}

/**
 * Choose which seat writes the plan.
 *
 * Preference order: an explicitly configured planner, then the first enabled
 * OpenRouter seat (a metered call whose cost is known), then the first enabled
 * seat of any kind. A CLI seat is the last resort because its cost is opaque.
 * @param seats - the active roster.
 * @param preferred - explicitly configured planner seat id.
 * @returns the planning seat, or undefined when the roster is empty.
 */
export function choosePlanner(
  seats: readonly SeatConfig[],
  preferred: string | undefined,
): SeatConfig | undefined {
  const enabled = seats.filter(seat => seat.enabled)
  if (preferred !== undefined) {
    const named = enabled.find(seat => seat.id === preferred)
    if (named !== undefined) return named
  }
  return enabled.find(seat => seat.transport === 'openrouter') ?? enabled[0]
}

/**
 * Every seat that could plan, best first.
 *
 * The planner is one cheap call that gates an expensive round, so its failure
 * used to end the run: no plan meant no estimate and no drafts, and the seats
 * that were working never got to speak. Ordering the candidates lets a
 * transient failure on the cheapest seat fall through to the next one.
 * @param seats - the active roster.
 * @param preferred - explicitly configured planner seat id.
 * @returns candidate planners in the order they should be tried.
 */
export function plannerOrder(
  seats: readonly SeatConfig[],
  preferred: string | undefined,
): readonly SeatConfig[] {
  const enabled = seats.filter(seat => seat.enabled)
  const first = choosePlanner(enabled, preferred)
  if (first === undefined) return []
  return [first, ...enabled.filter(seat => seat.id !== first.id)]
}

/**
 * Prompt for the review round.
 *
 * The vote block is requested first and in a fixed single-line format because
 * models reliably comply with a leading structured line, while a trailing one
 * gets buried under prose. Parsing stays tolerant regardless.
 */
function reviewPrompt(query: string, drafts: readonly SeatReply[], seats: readonly SeatConfig[]): string {
  const nameOf = (id: SeatId): string => seats.find(seat => seat.id === id)?.name ?? id
  const answers = drafts
    .filter(draft => draft.error === undefined && draft.text !== '')
    .map(draft => `### ${nameOf(draft.seat)} (id: ${draft.seat})\n${draft.text}`)
    .join('\n\n')
  const ids = drafts.filter(draft => draft.error === undefined && draft.text !== '').map(draft => draft.seat)
  return `Four models answered the same question. Review the answers below and vote for the single best one.

Reply with EXACTLY this format, the vote line first:

VOTE: <one of: ${ids.join(', ')}>
CONFIDENCE: <number between 0 and 1>
CRITIQUE: <your assessment of the answers, including your own>

You may vote for your own answer if it is genuinely best. Judge on correctness first, then completeness, then clarity.

USER QUESTION:
${query}

ANSWERS:
${answers}`
}

/** Clamp any parsed confidence into the unit interval. */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value < 0) return 0
  if (value > 1) return value > 100 ? 1 : Math.min(1, value / 100)
  return value
}

/**
 * Parse a review reply into a vote, confidence, and critique.
 *
 * Tolerant by design: seats answer in prose more often than they follow a
 * format exactly, so a missing confidence defaults to 0.5 and a vote is
 * recovered from any recognised seat id or name anywhere in the reply.
 * @param text - the seat's raw reply.
 * @param seats - roster used to resolve names to ids.
 * @returns the parsed vote, confidence, and critique.
 */
export function parseReview(
  text: string,
  seats: readonly SeatConfig[],
): { vote?: SeatId | undefined; confidence: number; critique: string } {
  const voteLine = /^\s*VOTE\s*:\s*(.+)$/im.exec(text)
  const confidenceLine = /^\s*CONFIDENCE\s*:\s*([0-9]*\.?[0-9]+)/im.exec(text)
  const critiqueLine = /^\s*CRITIQUE\s*:\s*([\s\S]*)$/im.exec(text)

  let vote: SeatId | undefined
  const claimed = voteLine?.[1]?.trim().toLowerCase()
  if (claimed !== undefined) {
    for (const seat of seats) {
      if (claimed === seat.id || claimed.includes(seat.id) || claimed.includes(seat.name.toLowerCase())) {
        vote = seat.id
        break
      }
    }
  }
  if (vote === undefined) {
    // No parsable vote line: fall back to the first seat named anywhere.
    const lowered = text.toLowerCase()
    let bestIndex = Number.POSITIVE_INFINITY
    for (const seat of seats) {
      const at = Math.min(
        lowered.indexOf(seat.id) === -1 ? Number.POSITIVE_INFINITY : lowered.indexOf(seat.id),
        lowered.indexOf(seat.name.toLowerCase()) === -1 ? Number.POSITIVE_INFINITY : lowered.indexOf(seat.name.toLowerCase()),
      )
      if (at < bestIndex) { bestIndex = at; vote = seat.id }
    }
    if (bestIndex === Number.POSITIVE_INFINITY) vote = undefined
  }

  const confidence = clampConfidence(confidenceLine?.[1] === undefined ? 0.5 : Number(confidenceLine[1]))
  const critique = (critiqueLine?.[1] ?? text).trim()
  return { vote, confidence, critique }
}

/**
 * Wrap one seat call so it reports itself the moment it settles.
 * @param seat - the seat being asked.
 * @param round - which round this call belongs to.
 * @param call - the pending seat call.
 * @param state - mutable running-cost accumulator.
 * @param emit - progress sink, when the caller supplied one.
 * @returns the seat's reply, unchanged.
 */
async function reporting(
  seat: SeatConfig,
  round: CouncilEvent['round'],
  call: Promise<SeatReply>,
  state: { cost: number },
  emit: ((event: CouncilEvent) => void) | undefined,
): Promise<SeatReply> {
  const reply = await call
  const costUsd = reply.usage?.costUsd
  if (typeof costUsd === 'number') state.cost += costUsd
  emit?.({
    round,
    seat: seat.id,
    name: seat.name,
    ms: reply.ms,
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
    ok: reply.error === undefined && reply.text !== '',
    runningCostUsd: state.cost,
  })
  return reply
}

/** Run a set of async thunks in parallel or one at a time. */
async function fanOut<T>(tasks: readonly (() => Promise<T>)[], sequential: boolean): Promise<T[]> {
  if (!sequential) return await Promise.all(tasks.map(task => task()))
  const results: T[] = []
  for (const task of tasks) results.push(await task())
  return results
}

/**
 * Tally reviews into a verdict.
 *
 * Confidence-weighted sum decides first; a plain vote count breaks a
 * confidence tie; a lone successful draft wins uncontested.
 * @param reviews - every seat's review.
 * @param drafts - the drafts under review.
 * @returns the verdict, including whether it was tied.
 */
export function tally(
  reviews: readonly SeatReview[],
  drafts: readonly SeatReply[],
  penalties: ReadonlyMap<SeatId, number> = new Map(),
): Verdict {
  const scores = new Map<SeatId, number>()
  const counts = new Map<SeatId, number>()
  const peerScores = new Map<SeatId, number>()
  const missingVoters: SeatId[] = []
  for (const review of reviews) {
    if (review.error !== undefined) {
      // A failed reviewer is a lost vote, and the report should say so rather
      // than let the remaining seats decide unchallenged.
      missingVoters.push(review.seat)
      continue
    }
    const vote = review.vote
    if (vote === undefined) continue
    const isSelf = vote === review.seat
    const weight = isSelf ? SELF_VOTE_WEIGHT : 1
    scores.set(vote, (scores.get(vote) ?? 0) + review.confidence * weight)
    counts.set(vote, (counts.get(vote) ?? 0) + 1)
    if (!isSelf) peerScores.set(vote, (peerScores.get(vote) ?? 0) + review.confidence)
  }
  // A fabricated citation has to cost something here, or fluency keeps
  // winning. Scale both totals so the penalty survives whichever branch
  // below decides the winner.
  for (const [seat, penalty] of penalties) {
    if (penalty <= 0) continue
    const factor = Math.max(0, 1 - penalty)
    const score = scores.get(seat)
    if (score !== undefined) scores.set(seat, score * factor)
    const peer = peerScores.get(seat)
    if (peer !== undefined) peerScores.set(seat, peer * factor)
  }

  const usable = drafts.filter(draft => draft.error === undefined && draft.text !== '')
  if (scores.size === 0) {
    if (usable.length === 1) {
      const only = usable[0]
      if (only !== undefined) {
        return { winner: only.seat, scores, counts, method: 'sole-draft', tied: false, peerScores, missingVoters }
      }
    }
    return { winner: undefined, scores, counts, method: 'none', tied: false, peerScores, missingVoters }
  }

  // Peer endorsement decides first when anyone has it: a draft another seat
  // was willing to back beats one only its own author argued for.
  const peerRanked = [...peerScores.entries()].sort((a, b) => b[1] - a[1])
  const topPeer = peerRanked[0]
  if (topPeer !== undefined && peerRanked.filter(([, score]) => score === topPeer[1]).length === 1) {
    return { winner: topPeer[0], scores, counts, method: 'peer', tied: false, peerScores, missingVoters }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (top === undefined) return { winner: undefined, scores, counts, method: 'none', tied: false, peerScores, missingVoters }
  const contenders = ranked.filter(([, score]) => score === top[1])
  if (contenders.length === 1) {
    return { winner: top[0], scores, counts, method: 'confidence', tied: false, peerScores, missingVoters }
  }
  // Confidence tie: fall back to raw vote count among the tied candidates.
  const byCount = contenders
    .map(([id]) => [id, counts.get(id) ?? 0] as const)
    .sort((a, b) => b[1] - a[1])
  const leader = byCount[0]
  const stillTied = byCount.filter(([, count]) => count === leader?.[1]).length > 1
  return {
    winner: leader?.[0],
    scores,
    counts,
    method: 'majority',
    tied: stillTied,
    peerScores,
    missingVoters,
  }
}

/**
 * Run one full council: draft round, review round, tally.
 * @param options - query, roster, credentials, and limits.
 * @returns every artefact the report needs.
 */
export async function runCouncil(options: RunOptions): Promise<CouncilResult> {
  const active = options.seats.filter(seat => seat.enabled)
  const sequential = options.sequential === true
  const empty = {
    winner: undefined,
    scores: new Map<SeatId, number>(),
    counts: new Map<SeatId, number>(),
    method: 'none' as const,
    tied: false,
    peerScores: new Map<SeatId, number>(),
    missingVoters: [] as SeatId[],
  }

  // ── pre-flight budget check ──
  // Read the balance before spending anything: the provider's own figure is
  // authoritative and costs one free call, which beats reconstructing spend
  // from token arithmetic afterwards.
  const spend = { cost: 0 }
  const emit = options.onEvent
  const before = options.budget === undefined ? undefined : await readBalance(options.apiKey, options.signal)
  const budget = options.budget === undefined ? undefined : judgeBudget(before, options.budget)
  if (budget !== undefined && !budget.allowed) {
    return {
      phase: 'plan',
      budget,
      query: options.query,
      seats: active,
      drafts: [],
      reviews: [],
      verdict: empty,
      answer: '',
    }
  }

  // ── planning round ──
  let plan = options.plan
  let planSeat: SeatId | undefined
  const planFailures: { seat: SeatId; error: string }[] = []
  let planDrafts: SeatReply[] = []
  let planReviews: SeatReview[] = []
  let planVerdict: Verdict | undefined
  if (plan === undefined && options.skipPlan !== true && options.planMode === 'council' && active.length > 1) {
    // Every seat proposes a plan, then the council votes on which to follow.
    // Costs a full extra round, and buys a plan the council actually agreed
    // rather than one the cheapest seat happened to write.
    planDrafts = await fanOut(
      active.map(seat => () =>
        reporting(
          seat,
          'plan',
          askSeat(seat, planPrompt(options.query), options.apiKey, options.signal, options.timeoutMs, options.memory),
          spend,
          emit,
        )),
      sequential,
    )
    for (const draft of planDrafts) {
      if (draft.error !== undefined || draft.text === '') {
        planFailures.push({ seat: draft.seat, error: draft.error ?? 'empty plan' })
      }
    }
    const usablePlans = planDrafts.filter(draft => draft.error === undefined && draft.text !== '')
    if (usablePlans.length > 1) {
      planReviews = await fanOut(
        active.map(seat => async (): Promise<SeatReview> => {
          const reply = await reporting(
            seat,
            'review',
            askSeat(
              seat,
              reviewPrompt(options.query, planDrafts, active),
              options.apiKey,
              options.signal,
              options.timeoutMs,
              options.memory,
            ),
            spend,
            emit,
          )
          if (reply.error !== undefined) {
            return { seat: seat.id, confidence: 0, critique: '', error: reply.error, ms: reply.ms }
          }
          const parsed = parseReview(reply.text, active)
          return {
            seat: seat.id,
            confidence: parsed.confidence,
            critique: parsed.critique,
            ms: reply.ms,
            ...parsed.vote === undefined ? {} : { vote: parsed.vote },
          }
        }),
        sequential,
      )
    }
    planVerdict = tally(planReviews, planDrafts)
    const winner = planVerdict.winner ?? usablePlans[0]?.seat
    const chosen = planDrafts.find(draft => draft.seat === winner)
    if (chosen !== undefined && chosen.text !== '') {
      plan = chosen.text
      planSeat = chosen.seat
    }
  }
  if (plan === undefined && options.skipPlan !== true) {
    for (const planner of plannerOrder(active, options.plannerSeat)) {
      const reply = await reporting(
        planner,
        'plan',
        askSeat(planner, planPrompt(options.query), options.apiKey, options.signal, options.timeoutMs, options.memory),
        spend,
        emit,
      )
      if (reply.error === undefined && reply.text !== '') {
        plan = reply.text
        planSeat = planner.id
        break
      }
      // Record it, then let the next seat try. A planner that cannot answer
      // must not silently cost the run its drafting round.
      planFailures.push({ seat: planner.id, error: reply.error ?? 'empty plan' })
    }
  }

  // The approval gate applies whether or not a planning round ran. It used
  // to sit inside the `skipPlan` guard, so a caller passing skipPlan:true
  // skipped the gate along with the planning round and went straight to
  // spending — which is exactly what the model did.
  if (options.planOnly === true) {
    return {
      phase: 'plan',
      plan,
      planSeat,
      ...planFailures.length === 0 ? {} : { planFailures },
      ...planDrafts.length === 0 ? {} : { planDrafts, planReviews, planVerdict },
      budget,
      estimate: options.estimate,
      spentUsd: spendBetween(before, await readBalance(options.apiKey, options.signal)),
      query: options.query,
      seats: active,
      drafts: [],
      reviews: [],
      verdict: empty,
      answer: '',
    }
  }

  // Seats say what they want looked up, and the searches run on their behalf.
  // This is the cheap half of the trade: asking costs a few hundred tokens per
  // seat, and the searches themselves go through the seam's subscription route
  // for nothing — where giving every seat its own metered web plugin costs
  // roughly 25x per call for the same information.
  //
  // The same round buys file reads. A seat has no filesystem either, and the
  // fix is the same shape: it names a path, the host reads it inside the roots
  // the user granted, and every seat is shown the result. Folding it into this
  // round rather than adding another one is what keeps it nearly free — the
  // seats are already being asked what they need.
  const fileRoots = options.fileRoots ?? []
  const canRead = options.files !== undefined && fileRoots.length > 0
  let researched: Awaited<ReturnType<typeof gatherRequested>>
  let fileEvidence: Awaited<ReturnType<typeof gatherFiles>>
  const canSearch = options.seatResearch === true && options.web !== undefined
  if ((canSearch || canRead) && active.length > 0) {
    const asks = await fanOut(
      active.map(seat => () =>
        reporting(
          seat,
          'plan',
          askSeat(seat, researchPrompt(options.query, plan, canRead ? readRequestSection(fileRoots) : ''), options.apiKey, options.signal, options.timeoutMs, options.memory),
          spend,
          emit,
        )),
      sequential,
    )
    const answered = asks.filter(ask => ask.error === undefined && ask.text !== '')
    if (canSearch) {
      const requests = answered
        .map(ask => ({ seat: ask.seat, queries: parseSearchRequests(ask.text) }))
        .filter(request => request.queries.length > 0)
      if (requests.length > 0) {
        researched = await gatherRequested(options.web, requests, options.signal)
      }
    }
    if (canRead) {
      const wanted = answered
        .map(ask => ({ seat: ask.seat, paths: parseReadRequests(ask.text) }))
        .filter(request => request.paths.length > 0)
      if (wanted.length > 0) {
        fileEvidence = await gatherFiles(options.files, fileRoots, wanted, options.signal)
      }
    }
  }

  // One search, shared by every seat. Retrieved after the planning gate so a
  // run the user abandons at the plan never pays for it, and before the drafts
  // so all seats reason over the same sources rather than their own memories.
  const online = (options.webMaxResults ?? 0) > 0
  const needsTools = active.some(seat => seat.transport === 'openrouter')
  // Shared evidence exists to compensate for blind seats. Seats with their
  // own live search do not need it, and paying for both is paying twice.
  // Seat-directed results beat one generic search: they answer what the seats
  // said they needed. Fall back to the single search only when nothing was
  // asked for, or when the research round is switched off.
  const searched = researched ?? (needsTools && !online
    ? await gatherEvidence(options.web, options.query, options.signal)
    : undefined)
  // Files ride in the same block as the searches, so every place that already
  // hands a seat its evidence hands it the source too, with no further change.
  // Sources stay the search urls: a local path is not a citation.
  const evidence = fileEvidence === undefined
    ? searched
    : {
      block: searched === undefined
        ? fileEvidence.block
        : `${searched.block}${String.fromCharCode(10)}${String.fromCharCode(10)}${fileEvidence.block}`,
      urls: searched?.urls ?? [],
    }
  const drafts = await fanOut(
    active.map(seat => () =>
      reporting(
        seat,
        'draft',
        askSeat(seat, draftPrompt(options.query, plan, evidence, seat.transport === 'openrouter', online), options.apiKey, options.signal, options.timeoutMs, options.memory, options.webMaxResults),
        spend,
        emit,
      )),
    sequential,
  )

  const usable = drafts.filter(draft => draft.error === undefined && draft.text !== '')
  if (usable.length === 0) {
    return {
      phase: 'full',
      ...planFailures.length === 0 ? {} : { planFailures },
      ...evidence === undefined ? {} : { evidenceUrls: evidence.urls },
      plan,
      planSeat,
      budget,
      spentUsd: spendBetween(before, await readBalance(options.apiKey, options.signal)),
      query: options.query,
      seats: active,
      drafts,
      reviews: [],
      verdict: empty,
      answer: '',
    }
  }

  // A single usable draft has nothing to compare against; skip the round rather
  // than spend four calls asking every seat to vote for the only candidate.
  const reviews: SeatReview[] = usable.length < 2
    ? []
    : (await fanOut(
      active.map(seat => async (): Promise<SeatReview> => {
        const reply = await reporting(
          seat,
          'review',
          askSeat(
            seat,
            reviewPrompt(options.query, drafts, active),
            options.apiKey,
            options.signal,
            options.timeoutMs,
            options.memory,
            options.webMaxResults,
          ),
          spend,
          emit,
        )
        if (reply.error !== undefined) {
          return { seat: seat.id, confidence: 0, critique: '', error: reply.error, ms: reply.ms }
        }
        const parsed = parseReview(reply.text, active)
        return {
          seat: seat.id,
          vote: parsed.vote,
          confidence: parsed.confidence,
          critique: parsed.critique,
          ms: reply.ms,
        }
      }),
      sequential,
    ))

  // Audit before tallying: the penalty has to be in hand when the winner is
  // chosen, not attached to the report afterwards.
  const fetchSeam = typeof options.web?.fetch === 'function' ? options.web as FetchSeam : undefined
  const audits = await Promise.all(
    drafts
      .filter(draft => draft.error === undefined && draft.text !== '')
      .map(async draft => auditDraft(
        draft.seat,
        draft.text,
        // A URL the provider reports the seat actually consulted is already
        // retrieved, so it counts as evidence rather than something to go and
        // check again. Without this a seat that genuinely searched would be
        // billed a second fetch to prove it.
        [...evidence?.urls ?? [], ...draft.citedUrls ?? []],
        fetchSeam,
        options.signal,
      )),
  )
  const penalties = new Map(audits.map(audit => [audit.seat, audit.penalty]))
  const verdict = tally(reviews, drafts, penalties)
  const winning = verdict.winner === undefined
    ? undefined
    : drafts.find(draft => draft.seat === verdict.winner)
  return {
    phase: 'full',
    ...planFailures.length === 0 ? {} : { planFailures },
    ...evidence === undefined ? {} : { evidenceUrls: evidence.urls },
    audits,
    plan,
    planSeat,
    budget,
    spentUsd: spendBetween(before, await readBalance(options.apiKey, options.signal)),
    query: options.query,
    seats: active,
    drafts,
    reviews,
    verdict,
    answer: winning?.text ?? '',
  }
}
