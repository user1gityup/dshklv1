/**
 * Console report rendering.
 *
 * The renderer takes a palette rather than deciding colour itself, so the same
 * function produces the coloured terminal view and the plain text handed back
 * to the model as the tool result.
 */

import type { Palette, SeatId } from './colors.ts'
import type { CouncilResult, SeatReview, Verdict } from './council.ts'
import type { SeatConfig, SeatReply } from './seats.ts'

const RULE = '─'.repeat(72)

/** Look up a seat's display name, falling back to its id. */
function nameOf(seats: readonly SeatConfig[], id: SeatId): string {
  return seats.find(seat => seat.id === id)?.name ?? id
}

/** Format a duration compactly. */
function duration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Render the drafts section. */
function renderDrafts(
  drafts: readonly SeatReply[],
  seats: readonly SeatConfig[],
  palette: Palette,
  out: string[],
): void {
  out.push(palette.muted(RULE))
  out.push('INITIAL ANSWERS')
  out.push('')
  for (const draft of drafts) {
    const label = palette.seatName(draft.seat, `[${nameOf(seats, draft.seat)}]`)
    const timing = palette.muted(` (${duration(draft.ms)})`)
    if (draft.error !== undefined) {
      out.push(`${label}${timing} ${palette.failure(`failed: ${draft.error}`)}`)
      out.push('')
      continue
    }
    out.push(`${label}${timing}`)
    out.push(palette.seat(draft.seat, draft.text))
    out.push('')
  }
}

/** Render the review and vote section. */
function renderReviews(
  reviews: readonly SeatReview[],
  seats: readonly SeatConfig[],
  palette: Palette,
  out: string[],
): void {
  if (reviews.length === 0) return
  out.push(palette.muted(RULE))
  out.push('REVIEWS AND VOTES')
  out.push('')
  for (const review of reviews) {
    const label = palette.seatName(review.seat, `[${nameOf(seats, review.seat)}]`)
    if (review.error !== undefined) {
      out.push(`${label} ${palette.failure(`failed: ${review.error}`)}`)
      out.push('')
      continue
    }
    // The voted-for seat is painted in ITS colour, not the reviewer's, so a
    // vote reads as a pointer from one seat to another.
    const voted = review.vote === undefined
      ? palette.muted('no clear vote')
      : palette.seat(review.vote, nameOf(seats, review.vote))
    const confidence = palette.muted(`confidence ${review.confidence.toFixed(2)}`)
    out.push(`${label} votes for ${voted}  ${confidence}`)
    if (review.critique !== '') out.push(palette.seat(review.seat, review.critique))
    out.push('')
  }
}

/** Render the tally lines. */
function renderTally(
  verdict: Verdict,
  seats: readonly SeatConfig[],
  palette: Palette,
  out: string[],
): void {
  if (verdict.scores.size === 0) return
  const ranked = [...verdict.scores.entries()].sort((a, b) => b[1] - a[1])
  out.push(palette.muted('Tally:'))
  for (const [id, score] of ranked) {
    const votes = verdict.counts.get(id) ?? 0
    const line = `  ${nameOf(seats, id)}: ${score.toFixed(2)} confidence from ${String(votes)} vote${votes === 1 ? '' : 's'}`
    out.push(palette.seat(id, line))
  }
  out.push('')
}

/** Explain how the winner was chosen. */
function verdictExplanation(verdict: Verdict, seats: readonly SeatConfig[]): string {
  if (verdict.winner === undefined) return 'No answer could be chosen: every seat failed or abstained.'
  const who = nameOf(seats, verdict.winner)
  switch (verdict.method) {
    case 'peer':
      return `${who} won on peer endorsement — another seat backed it, not just its own author.`
    case 'confidence':
      return `${who} won on confidence-weighted vote (self-votes count half).`
    case 'majority':
      return verdict.tied
        ? `${who} won a tie broken arbitrarily: confidence and vote count were level.`
        : `${who} won on vote count after a confidence tie.`
    case 'sole-draft':
      return `${who} was the only seat to answer, so its draft stands unreviewed.`
    default:
      return `${who} selected.`
  }
}

/**
 * Render a full council report.
 * @param result - the completed run.
 * @param palette - painter deciding whether escapes are emitted.
 * @returns the report as a single string, newline separated.
 */
export function renderReport(result: CouncilResult, palette: Palette): string {
  const out: string[] = []
  out.push(palette.muted(RULE))
  out.push(result.phase === 'plan' ? 'COUNCIL — PLANNING ONLY' : 'COUNCIL')
  out.push('')
  out.push(`Query: ${result.query}`)
  if (result.budget !== undefined) {
    const line = `Budget: ${result.budget.reason}`
    out.push(result.budget.allowed && !result.budget.overPace ? palette.muted(line) : palette.failure(line))
  }
  if (result.spentUsd !== undefined) {
    const amendedRun = result.amended
    if (amendedRun !== undefined) {
      out.push(`amended: attempt ${String(amendedRun.attempt)} on run ${amendedRun.runId}; recovered ${String(amendedRun.recoveredDrafts.length)} answer(s), ${String(amendedRun.recoveredReviews.length)} review(s)`)
      if (amendedRun.staleReviews.length > 0) {
        out.push(`  ! ${String(amendedRun.staleReviews.length)} vote(s) predate the recovered answers and were kept, not re-asked`)
      }
    }
    out.push(palette.muted(`Spent this run: $${result.spentUsd.toFixed(4)}`))
  }
  out.push('')
  if (result.budget !== undefined && !result.budget.allowed) {
    out.push(palette.muted(RULE))
    return out.join('\n')
  }
  if (result.plan !== undefined && result.plan !== '') {
    if (result.planMerge !== undefined) {
      out.push('PLAN MERGE — original vote unchanged')
      for (const piece of result.planMerge.accepted) {
        out.push(`From ${piece.source}; supported by ${piece.supporters.join(', ')}: ${piece.quote}`)
      }
      if (result.planMerge.accepted.length === 0) out.push('No rival piece received two endorsements; original plan retained.')
      if (result.planMerge.integration !== undefined && (result.planMerge.integration.error !== undefined || result.planMerge.integration.text.trim() === '')) {
        out.push('Winner integration failed; original plan retained.')
      }
      out.push('')
    }
    out.push(palette.muted(RULE))
    const author = result.planSeat === undefined ? 'PLAN' : `PLAN (${nameOf(result.seats, result.planSeat)})`
    out.push(author)
    out.push('')
    out.push(result.planSeat === undefined ? result.plan : palette.seat(result.planSeat, result.plan))
    out.push('')
  }
  if (result.estimate !== undefined) {
    const est = result.estimate
    out.push(palette.muted(RULE))
    out.push('ESTIMATE — a guess, not a quote')
    out.push('')
    out.push(`  Job size: ${est.scale} (~${est.outputTokens.toLocaleString()} output tokens per seat, ${String(est.rounds)} rounds)`)
    for (const seat of est.seats) {
      const figure = seat.costUsd === undefined
        ? (seat.metered ? 'unpriced' : 'subscription, not metered here')
        : `~$${seat.costUsd.toFixed(4)}`
      out.push(palette.seat(seat.seat, `  ${seat.name}: ${figure}`))
    }
    out.push(`  Estimated metered total: ~$${est.meteredCostUsd.toFixed(2)} (basis: ${est.basis})`)
    for (const warning of est.warnings) out.push(palette.failure(`  ! ${warning}`))
    out.push('')
  }
  if (result.phase === 'plan') {
    out.push(palette.muted(
      'Stopped before drafting. Re-run with this plan (or an edited one) as the plan argument to spend the drafting round, or pass skipPlan to bypass planning entirely.',
    ))
    out.push(palette.muted(RULE))
    return out.join('\n')
  }
  renderDrafts(result.drafts, result.seats, palette, out)
  renderReviews(result.reviews, result.seats, palette, out)
  out.push(palette.muted(RULE))
  out.push('COLLECTIVE ANSWER')
  out.push('')
  renderTally(result.verdict, result.seats, palette, out)
  for (const seat of result.verdict.missingVoters) {
    out.push(palette.failure(`  ! ${nameOf(result.seats, seat)} could not review, so its vote is missing from this tally`))
  }
  out.push(palette.muted(verdictExplanation(result.verdict, result.seats)))
  out.push('')
  if (result.answer !== '') out.push(palette.headline(result.answer))
  out.push(palette.muted(RULE))
  return out.join('\n')
}
