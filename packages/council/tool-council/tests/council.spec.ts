import { describe, expect, it } from 'vitest'
import { createPalette, supportsColor } from '../src/colors.ts'
import { choosePlanner, parseReview, tally } from '../src/council.ts'
import { describeError } from '../src/errors.ts'
import type { SeatReview } from '../src/council.ts'
import { renderReport } from '../src/report.ts'
import { executableCandidates, DEFAULT_SEATS } from '../src/seats.ts'
import type { SeatReply } from '../src/seats.ts'
import { resolveSeats } from '../src/index.ts'

const SEATS = DEFAULT_SEATS
const PHASE = 'full' as const

describe('colour support detection', () => {
  it('honours an explicit opt-out over a TTY', () => {
    expect(supportsColor({ noColor: true, isTty: true })).toBe(false)
  })

  it('honours NO_COLOR over a TTY', () => {
    expect(supportsColor({ isTty: true, env: { NO_COLOR: '1' } })).toBe(false)
  })

  it('treats an empty NO_COLOR as unset', () => {
    expect(supportsColor({ isTty: true, env: { NO_COLOR: '' } })).toBe(true)
  })

  it('colours a redirected stream when FORCE_COLOR asks', () => {
    expect(supportsColor({ isTty: false, env: { FORCE_COLOR: '1' } })).toBe(true)
  })

  it('stays plain for a dumb terminal', () => {
    expect(supportsColor({ isTty: true, env: { TERM: 'dumb' } })).toBe(false)
  })

  it('stays plain when not a TTY', () => {
    expect(supportsColor({ isTty: false })).toBe(false)
  })
})

describe('palette', () => {
  it('emits no escapes when disabled', () => {
    const plain = createPalette(false)
    expect(plain.seat('claude', 'hello')).toBe('hello')
    expect(plain.headline('answer')).toBe('answer')
  })

  it('paints each seat its assigned colour', () => {
    const palette = createPalette(true)
    expect(palette.seat('claude', 'x')).toContain('\u001B[96m')
    expect(palette.seat('openai', 'x')).toContain('\u001B[92m')
    expect(palette.seat('kimi', 'x')).toContain('\u001B[95m')
    expect(palette.seat('deepseek', 'x')).toContain('\u001B[93m')
  })

  it('re-opens its colour after a nested reset', () => {
    const palette = createPalette(true)
    const painted = palette.seat('kimi', 'a\u001B[0mb')
    // The trailing `b` must still be magenta, not terminal default.
    expect(painted).toBe('\u001B[95ma\u001B[0m\u001B[95mb\u001B[0m')
  })
})

describe('review parsing', () => {
  it('reads a well-formed vote block', () => {
    const parsed = parseReview('VOTE: kimi\nCONFIDENCE: 0.8\nCRITIQUE: solid reasoning', SEATS)
    expect(parsed.vote).toBe('kimi')
    expect(parsed.confidence).toBe(0.8)
    expect(parsed.critique).toBe('solid reasoning')
  })

  it('resolves a vote given by display name', () => {
    const parsed = parseReview('VOTE: DeepSeek v4\nCONFIDENCE: 0.5', SEATS)
    expect(parsed.vote).toBe('deepseek')
  })

  it('defaults confidence when the seat omits it', () => {
    expect(parseReview('VOTE: claude', SEATS).confidence).toBe(0.5)
  })

  it('rescales a percentage confidence into the unit interval', () => {
    expect(parseReview('VOTE: claude\nCONFIDENCE: 90', SEATS).confidence).toBe(0.9)
  })

  it('recovers a vote from prose when the format is ignored', () => {
    const parsed = parseReview('I think Kimi gave the best answer overall.', SEATS)
    expect(parsed.vote).toBe('kimi')
  })

  it('reports no vote when nothing recognisable appears', () => {
    expect(parseReview('none of these are any good', SEATS).vote).toBeUndefined()
  })
})

/** Build a review row with the fields the tally reads. */
function review(seat: SeatReview['seat'], vote: SeatReview['vote'], confidence: number): SeatReview {
  return { seat, vote, confidence, critique: '', ms: 1 }
}

/** Build a successful draft. */
function draft(seat: SeatReply['seat'], text = 'answer'): SeatReply {
  return { seat, text, ms: 1 }
}

describe('tally', () => {
  const drafts = [draft('claude'), draft('openai'), draft('kimi'), draft('deepseek')]

  it('picks the highest summed confidence', () => {
    const verdict = tally([
      review('claude', 'kimi', 0.9),
      review('openai', 'kimi', 0.8),
      review('kimi', 'claude', 0.6),
      review('deepseek', 'claude', 0.5),
    ], drafts)
    expect(verdict.winner).toBe('kimi')
    // Peer endorsement now decides ahead of raw confidence: Claude and OpenAI
    // both backed Kimi, which is stronger evidence than any self-assessment.
    expect(verdict.method).toBe('peer')
    expect(verdict.peerScores.get('kimi')).toBeCloseTo(1.7)
  })

  it('breaks a confidence tie on vote count', () => {
    const verdict = tally([
      review('claude', 'kimi', 0.5),
      review('openai', 'kimi', 0.5),
      review('kimi', 'deepseek', 1.0),
    ], drafts)
    expect(verdict.scores.get('kimi')).toBe(1)
    expect(verdict.scores.get('deepseek')).toBe(1)
    expect(verdict.winner).toBe('kimi')
    expect(verdict.method).toBe('majority')
    expect(verdict.tied).toBe(false)
  })

  it('flags a tie that vote count cannot break', () => {
    const verdict = tally([
      review('claude', 'kimi', 0.5),
      review('openai', 'deepseek', 0.5),
    ], drafts)
    expect(verdict.tied).toBe(true)
  })

  it('lets a sole surviving draft stand unreviewed', () => {
    const verdict = tally([], [draft('claude'), { seat: 'kimi', text: '', error: 'down', ms: 1 }])
    expect(verdict.winner).toBe('claude')
    expect(verdict.method).toBe('sole-draft')
  })

  it('returns no winner when every seat abstained', () => {
    const verdict = tally([], [{ seat: 'kimi', text: '', error: 'down', ms: 1 }])
    expect(verdict.winner).toBeUndefined()
    expect(verdict.method).toBe('none')
  })

  it('ignores reviews that carry no vote', () => {
    const verdict = tally([review('claude', undefined, 0.9), review('openai', 'kimi', 0.1)], drafts)
    expect(verdict.winner).toBe('kimi')
  })
})

describe('executable candidates', () => {
  it('never offers a batch shim before a real executable', () => {
    if (process.platform !== 'win32') return
    const candidates = executableCandidates('claude')
    const first = candidates[0] ?? ''
    // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), so a
    // shim in first position is what produced EINVAL in the wild.
    expect(first.endsWith('.cmd')).toBe(false)
    expect(first.endsWith('.bat')).toBe(false)
  })

  it('puts .exe ahead of .cmd among bare spellings', () => {
    if (process.platform !== 'win32') return
    const candidates = executableCandidates('somecli-that-does-not-exist')
    expect(candidates.indexOf('somecli-that-does-not-exist.exe'))
      .toBeLessThan(candidates.indexOf('somecli-that-does-not-exist.cmd'))
  })

  it('resolves the real binary for a known npm-installed CLI', () => {
    if (process.platform !== 'win32') return
    const first = executableCandidates('claude')[0] ?? ''
    // Only asserted when the CLI is actually installed on this machine.
    if (!first.includes('claude-code')) return
    expect(first.endsWith('claude.exe')).toBe(true)
  })

  it('passes an explicit extension through unchanged', () => {
    expect(executableCandidates('claude.cmd')).toEqual(['claude.cmd'])
  })
})

describe('seat resolution', () => {
  it('returns shipped defaults when nothing is overridden', () => {
    expect(resolveSeats().map(seat => seat.id)).toEqual(['claude', 'openai', 'kimi', 'deepseek'])
  })

  it('applies a model override without touching other seats', () => {
    const seats = resolveSeats({ kimi: { model: 'moonshotai/kimi-k2-0905' } })
    expect(seats.find(seat => seat.id === 'kimi')?.model).toBe('moonshotai/kimi-k2-0905')
    expect(seats.find(seat => seat.id === 'deepseek')?.model).toBe(DEFAULT_SEATS[3]?.model)
  })

  it('can disable one seat', () => {
    expect(resolveSeats({ openai: { enabled: false } }).find(seat => seat.id === 'openai')?.enabled).toBe(false)
  })
})

describe('report rendering', () => {
  const result = {
    phase: PHASE,
    query: 'why is the sky blue',
    seats: SEATS,
    drafts: [draft('claude', 'Rayleigh scattering.'), { seat: 'openai' as const, text: '', error: 'not installed', ms: 3 }],
    reviews: [review('claude', 'claude', 0.9)],
    verdict: tally([review('claude', 'claude', 0.9)], [draft('claude', 'Rayleigh scattering.')]),
    answer: 'Rayleigh scattering.',
  }

  it('renders plain text with no escapes', () => {
    const text = renderReport(result, createPalette(false))
    expect(text).not.toContain(String.fromCharCode(27))
    expect(text).toContain('why is the sky blue')
    expect(text).toContain('Rayleigh scattering.')
  })

  it('surfaces a failed seat rather than hiding it', () => {
    expect(renderReport(result, createPalette(false))).toContain('failed: not installed')
  })

  it('paints the voted-for seat in its own colour, not the reviewer’s', () => {
    const coloured = renderReport({
      ...result,
      reviews: [review('claude', 'kimi', 0.9)],
    }, createPalette(true))
    // Kimi is magenta; the line must carry magenta even though Claude reviews.
    expect(coloured).toContain('\u001B[95mKimi\u001B[0m')
  })

  it('explains the voting outcome', () => {
    expect(renderReport(result, createPalette(false))).toContain('confidence-weighted vote')
  })
})

describe('extra seats', () => {
  it('appends a configured OpenRouter seat after the shipped four', () => {
    const seats = resolveSeats({}, { grok: { model: 'x-ai/grok-4', name: 'Grok' } })
    expect(seats.map(seat => seat.id)).toEqual(['claude', 'openai', 'kimi', 'deepseek', 'grok'])
    const grok = seats.find(seat => seat.id === 'grok')
    expect(grok?.transport).toBe('openrouter')
    expect(grok?.model).toBe('x-ai/grok-4')
    expect(grok?.name).toBe('Grok')
    expect(grok?.enabled).toBe(true)
  })

  it('falls back to the key when no display name is given', () => {
    const seats = resolveSeats({}, { qwen: { model: 'qwen/qwen3-max' } })
    expect(seats.find(seat => seat.id === 'qwen')?.name).toBe('qwen')
  })

  it('refuses to let an extra seat shadow a shipped id', () => {
    const seats = resolveSeats({}, { kimi: { model: 'someone/else' } })
    expect(seats.filter(seat => seat.id === 'kimi')).toHaveLength(1)
    expect(seats.find(seat => seat.id === 'kimi')?.model).toBe('moonshotai/kimi-k2')
  })

  it('honours a disabled extra seat', () => {
    const seats = resolveSeats({}, { grok: { model: 'x-ai/grok-4', enabled: false } })
    expect(seats.find(seat => seat.id === 'grok')?.enabled).toBe(false)
  })

  it('gives an extra seat a colour distinct from every shipped seat', () => {
    const palette = createPalette(true)
    const extra = palette.seat('grok', 'x')
    for (const builtin of ['claude', 'openai', 'kimi', 'deepseek'] as const) {
      expect(extra).not.toBe(palette.seat(builtin, 'x'))
    }
  })

  it('keeps one colour for a seat across calls', () => {
    const palette = createPalette(true)
    expect(palette.seat('zeta', 'x')).toBe(palette.seat('zeta', 'x'))
  })
})

describe('planner selection', () => {
  it('prefers an OpenRouter seat over a CLI seat', () => {
    expect(choosePlanner(DEFAULT_SEATS, undefined)?.id).toBe('kimi')
  })

  it('honours an explicitly named planner', () => {
    expect(choosePlanner(DEFAULT_SEATS, 'deepseek')?.id).toBe('deepseek')
  })

  it('ignores a named planner that is disabled', () => {
    const seats = resolveSeats({ kimi: { enabled: false } })
    expect(choosePlanner(seats, 'kimi')?.id).toBe('deepseek')
  })

  it('falls back to a CLI seat when no OpenRouter seat is enabled', () => {
    const seats = resolveSeats({ kimi: { enabled: false }, deepseek: { enabled: false } })
    expect(choosePlanner(seats, undefined)?.id).toBe('claude')
  })

  it('returns nothing when the roster is empty', () => {
    expect(choosePlanner([], undefined)).toBeUndefined()
  })
})

describe('plan-phase report', () => {
  const planResult = {
    phase: 'plan' as const,
    plan: 'RESTATEMENT: ...\nAPPROACH: ...',
    planSeat: 'kimi' as const,
    query: 'build a thing',
    seats: SEATS,
    drafts: [],
    reviews: [],
    verdict: tally([], []),
    answer: '',
  }

  it('labels the report as planning only', () => {
    expect(renderReport(planResult, createPalette(false))).toContain('PLANNING ONLY')
  })

  it('names the planning seat and shows the plan', () => {
    const text = renderReport(planResult, createPalette(false))
    expect(text).toContain('PLAN (Kimi)')
    expect(text).toContain('RESTATEMENT')
  })

  it('omits the drafting and voting sections entirely', () => {
    const text = renderReport(planResult, createPalette(false))
    expect(text).not.toContain('INITIAL ANSWERS')
    expect(text).not.toContain('COLLECTIVE ANSWER')
  })

  it('tells the reader how to proceed', () => {
    expect(renderReport(planResult, createPalette(false))).toContain('Re-run with this plan')
  })
})

describe('self-vote discounting', () => {
  const drafts = [draft('claude'), draft('kimi')]

  it('lets a peer-endorsed draft beat a louder self-vote', () => {
    // The exact shape of the failure seen in the wild: each seat votes for
    // itself, and the more confident one wins on raw confidence alone.
    const verdict = tally([
      review('claude', 'claude', 0.65),
      review('kimi', 'kimi', 0.85),
    ], drafts)
    expect(verdict.method).toBe('confidence')
    // Neither has peer support, so confidence still decides — but halved.
    expect(verdict.scores.get('kimi')).toBeCloseTo(0.425)
    expect(verdict.scores.get('claude')).toBeCloseTo(0.325)
  })

  it('prefers the seat another seat actually backed', () => {
    const verdict = tally([
      review('claude', 'kimi', 0.6),
      review('kimi', 'kimi', 0.95),
      review('deepseek', 'deepseek', 0.99),
    ], [draft('claude'), draft('kimi'), draft('deepseek')])
    expect(verdict.winner).toBe('kimi')
    expect(verdict.method).toBe('peer')
    expect(verdict.peerScores.get('kimi')).toBeCloseTo(0.6)
    expect(verdict.peerScores.get('deepseek')).toBeUndefined()
  })

  it('reports a reviewer whose vote was lost', () => {
    const verdict = tally([
      review('kimi', 'kimi', 0.85),
      { seat: 'deepseek', confidence: 0, critique: '', error: 'rate limited', ms: 1 },
    ], drafts)
    expect(verdict.missingVoters).toEqual(['deepseek'])
  })

  it('does not count a failed reviewer as an abstention', () => {
    const verdict = tally([
      { seat: 'claude', confidence: 0, critique: '', error: 'boom', ms: 1 },
      review('kimi', 'claude', 0.7),
    ], drafts)
    expect(verdict.winner).toBe('claude')
    expect(verdict.method).toBe('peer')
  })
})

describe('error description', () => {
  it('never renders a plain object as [object Object]', () => {
    expect(describeError({ status: 429, statusText: 'Too Many Requests' })).toContain('429')
    expect(describeError({ message: 'quota exceeded' })).toBe('quota exceeded')
    expect(describeError({ error: { code: 'x' } })).not.toContain('[object Object]')
    expect(describeError({})).not.toContain('[object Object]')
  })

  it('unwraps an Error and its cause', () => {
    const inner = new Error('socket closed')
    const outer = new Error('request failed', { cause: inner })
    expect(describeError(outer)).toContain('request failed')
    expect(describeError(outer)).toContain('socket closed')
  })

  it('handles a thrown string, null, and undefined', () => {
    expect(describeError('boom')).toBe('boom')
    expect(describeError(null)).toBe('unknown error')
    expect(describeError(undefined)).toBe('unknown error')
  })
})
