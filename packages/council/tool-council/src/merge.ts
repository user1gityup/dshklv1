import type { SeatConfig, SeatReply } from './seats.ts'

/** A quoted piece of a rival plan, supported by distinct seats. */
export interface PlanPiece {
  readonly source: string
  readonly quote: string
  readonly supporters: readonly string[]
}

/** The original winner remains the author even when integration fails. */
export interface PlanMerge {
  readonly plan: string
  readonly accepted: readonly PlanPiece[]
  readonly nominations: readonly SeatReply[]
  readonly integration?: SeatReply | undefined
}

/** Count only exact, attributed excerpts and one endorsement per voter. */
export function acceptedPieces(replies: readonly SeatReply[], drafts: readonly SeatReply[], winner: string): PlanPiece[] {
  const pieces = new Map<string, { source: string; quote: string; supporters: Set<string> }>()
  for (const reply of replies) {
    if (reply.error !== undefined) continue
    let raw: unknown
    try {
      raw = JSON.parse(reply.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''))
    } catch {
      continue // A malformed nomination cannot contribute support.
    }
    if (!Array.isArray(raw)) continue
    for (const value of raw as unknown[]) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      const source = row['source']
      const quote = row['quote']
      if (typeof source !== 'string' || typeof quote !== 'string' || quote.trim() === '' || source === winner) continue
      const draft = drafts.find(entry => entry.seat === source && entry.error === undefined)
      if (draft === undefined || !draft.text.includes(quote)) continue
      const key = JSON.stringify([source, quote])
      const piece = pieces.get(key) ?? { source, quote, supporters: new Set<string>() }
      piece.supporters.add(reply.seat)
      pieces.set(key, piece)
    }
  }
  return [...pieces.values()].filter(piece => piece.supporters.size >= 2)
    .map(piece => ({ ...piece, supporters: [...piece.supporters] }))
}

/** Ask for attributed nominations, then let only the winner revise its plan. */
export async function mergePlan(
  query: string,
  winner: SeatReply,
  drafts: readonly SeatReply[],
  seats: readonly SeatConfig[],
  ask: (seat: SeatConfig, prompt: string) => Promise<SeatReply>,
  sequential = false,
): Promise<PlanMerge> {
  const author = seats.find(seat => seat.id === winner.seat)
  if (author === undefined) return { plan: winner.text, accepted: [], nominations: [] }
  const prompt = `The plan vote is settled. ${winner.seat} won; do not change that decision.
Nominate specific compatible pieces from rival plans that improve the winning plan without changing its approach or scope.
Reply with a JSON array of {"source":"seat id","quote":"exact verbatim excerpt"}. Use [] if nothing should be borrowed.
Every nomination must quote the same complete sentence or paragraph as the source. Do not paraphrase.
REQUEST: ${query}
WINNING PLAN (${winner.seat}):
${winner.text}
RIVAL PLANS:
${drafts.filter(draft => draft.seat !== winner.seat && draft.error === undefined).map(draft => `--- ${draft.seat} ---\n${draft.text}`).join('\n\n')}`
  const nominations: SeatReply[] = []
  if (sequential) {
    for (const seat of seats) nominations.push(await ask(seat, prompt))
  } else nominations.push(...await Promise.all(seats.map(seat => ask(seat, prompt))))
  const accepted = acceptedPieces(nominations, drafts, winner.seat)
  if (accepted.length === 0) return { plan: winner.text, accepted, nominations }
  const integration = await ask(author, `You won the plan vote. Rewrite your own plan incorporating the following peer-supported pieces where compatible. Preserve the original requirements, approach, and acceptance conditions. Attribute borrowed pieces to their source seat. Explain any incompatible piece you cannot incorporate. Return the complete revised plan. There is no second vote.
REQUEST: ${query}
YOUR WINNING PLAN:
${winner.text}
ACCEPTED PIECES (at least two distinct supporters each):
${JSON.stringify(accepted)}`)
  return { plan: integration.error === undefined && integration.text.trim() !== '' ? integration.text : winner.text, accepted, nominations, integration }
}
