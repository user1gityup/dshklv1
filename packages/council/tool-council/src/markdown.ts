/**
 * Markdown rendering for the conversation surface.
 *
 * The web chat renders markdown, not ANSI, so escape codes would arrive as
 * literal garbage. Seat identity is carried by a coloured disc that matches the
 * console palette — cyan, green, magenta, yellow — which survives any markdown
 * renderer without needing HTML or custom components.
 */

import type { SeatId } from './colors.ts'
import type { CouncilResult, SeatReview } from './council.ts'
import type { SeatConfig, SeatReply } from './seats.ts'

/** Discs matching the console palette, so a seat looks the same in both sinks. */
const SEAT_DISC: Record<string, string> = {
  claude: '\u{1F535}',
  openai: '\u{1F7E2}',
  kimi: '\u{1F7E3}',
  deepseek: '\u{1F7E1}',
}

/** Discs handed to seats the user added, in order of first appearance. */
const EXTRA_DISCS = ['\u{1F7E0}', '\u{1F534}', '\u{26AA}', '\u{26AB}'] as const
const assigned = new Map<string, string>()

/** Resolve a seat's disc, assigning one to an unknown seat. */
function disc(seat: SeatId): string {
  const builtin = SEAT_DISC[seat]
  if (builtin !== undefined) return builtin
  const already = assigned.get(seat)
  if (already !== undefined) return already
  const next = EXTRA_DISCS[assigned.size % EXTRA_DISCS.length] ?? '\u{26AA}'
  assigned.set(seat, next)
  return next
}

/** Look up a seat's display name. */
function nameOf(seats: readonly SeatConfig[], id: SeatId): string {
  return seats.find(seat => seat.id === id)?.name ?? id
}

/** Format a duration compactly. */
function duration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Render one seat's draft. */
function draftSection(draft: SeatReply, seats: readonly SeatConfig[]): string[] {
  const head = `### ${disc(draft.seat)} ${nameOf(seats, draft.seat)}`
  if (draft.error !== undefined) {
    return [`${head} — _failed_`, '', `> ${draft.error}`, '']
  }
  const cost = draft.usage?.costUsd === undefined ? '' : ` · $${draft.usage.costUsd.toFixed(4)}`
  return [`${head}  \`${duration(draft.ms)}${cost}\``, '', draft.text, '']
}

/** Render one seat's review and vote. */
function reviewLine(review: SeatReview, seats: readonly SeatConfig[]): string[] {
  const who = `${disc(review.seat)} **${nameOf(seats, review.seat)}**`
  if (review.error !== undefined) return [`- ${who} — _failed: ${review.error}_`]
  const voted = review.vote === undefined
    ? '_no clear vote_'
    : `${disc(review.vote)} **${nameOf(seats, review.vote)}**`
  const lines = [`- ${who} votes ${voted} · confidence ${review.confidence.toFixed(2)}`]
  if (review.critique !== '') lines.push(`  > ${review.critique.split('\n').join('\n  > ')}`)
  return lines
}

/**
 * Render a council result as markdown for the conversation surface.
 * @param result - the completed run.
 * @returns markdown text.
 */
export function renderMarkdown(result: CouncilResult): string {
  const out: string[] = []

  if (result.phase === 'plan') {
    out.push('## Council — planning only', '')
    if (result.plan !== undefined && result.plan !== '') {
      const author = result.planSeat === undefined ? '' : ` ${disc(result.planSeat)} ${nameOf(result.seats, result.planSeat)}`
      out.push(`**Plan**${author}`, '', result.plan, '')
    }
    if (result.estimate !== undefined) {
      const est = result.estimate
      out.push('**Estimate** — a guess, not a quote', '')
      out.push(`- Job size: ${est.scale} (~${est.outputTokens.toLocaleString()} output tokens per seat, ${String(est.rounds)} rounds)`)
      for (const seat of est.seats) {
        const figure = seat.costUsd === undefined
          ? (seat.metered ? 'unpriced' : 'subscription, not metered')
          : `~$${seat.costUsd.toFixed(4)}`
        out.push(`- ${disc(seat.seat)} ${seat.name}: ${figure}`)
      }
      out.push(`- **Estimated metered total: ~$${est.meteredCostUsd.toFixed(2)}** (basis: ${est.basis})`)
      for (const warning of est.warnings) out.push(`- **!** ${warning}`)
      out.push('')
    }
    out.push('_Stopped before drafting. Approve to run the full council._')
    return out.join('\n')
  }

  out.push('## Council', '')
  if (result.budget !== undefined) out.push(`_${result.budget.reason}_`, '')

  out.push('## Answers', '')
  for (const draft of result.drafts) out.push(...draftSection(draft, result.seats))

  if (result.reviews.length > 0) {
    out.push('## Reviews and votes', '')
    for (const review of result.reviews) out.push(...reviewLine(review, result.seats))
    out.push('')
  }

  const ranked = [...result.verdict.scores.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length > 0) {
    out.push('**Tally**', '')
    for (const [id, score] of ranked) {
      const votes = result.verdict.counts.get(id) ?? 0
      out.push(`- ${disc(id)} ${nameOf(result.seats, id)}: ${score.toFixed(2)} confidence from ${String(votes)} vote${votes === 1 ? '' : 's'}`)
    }
    out.push('')
  }

  out.push('## Collective answer', '')
  if (result.verdict.winner !== undefined) {
    // Name HOW it won, not just that it did: 'peer' and 'confidence' mean
    // materially different things about how much the result can be trusted.
    const how = result.verdict.method === 'peer'
      ? 'peer endorsement'
      : result.verdict.method === 'confidence'
        ? 'confidence (self-votes count half)'
        : result.verdict.method
    out.push(`_Won by ${disc(result.verdict.winner)} **${nameOf(result.seats, result.verdict.winner)}** on ${how}._`, '')
    for (const seat of result.verdict.missingVoters) {
      out.push(`> **!** ${nameOf(result.seats, seat)} could not review, so its vote is missing from this tally.`, '')
    }
  }
  out.push(result.answer === '' ? '_No answer could be chosen: every seat failed or abstained._' : result.answer)
  if (result.spentUsd !== undefined) out.push('', `_Spent this run: $${result.spentUsd.toFixed(4)}_`)
  return out.join('\n')
}
