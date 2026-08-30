/**
 * ANSI palette for the council report.
 *
 * Colour is a presentation concern only: every helper degrades to the identity
 * function when the sink cannot render escapes, so the same report code writes
 * a TTY, a redirected file, and a CI log without branching.
 */

/**
 * A seat identity. The four shipped seats have fixed colours; any additional
 * seat the user configures is also a valid id and is assigned a colour from
 * the rotation below.
 */
export type SeatId = string

/** The shipped seats, whose colours are fixed by the council specification. */
export type BuiltinSeatId = 'claude' | 'openai' | 'kimi' | 'deepseek'

/** Raw SGR sequences, kept in one place so the palette is auditable. */
const SGR = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  cyan: '\u001B[96m',
  blue: '\u001B[94m',
  brightRed: '\u001B[31m',
  brightBlack: '\u001B[90m',
  brightWhite: '\u001B[37m',
  green: '\u001B[92m',
  magenta: '\u001B[95m',
  yellow: '\u001B[93m',
  white: '\u001B[97m',
  red: '\u001B[91m',
} as const

/** Seat colour assignment fixed by the council specification. */
const SEAT_SGR: Record<BuiltinSeatId, string> = {
  claude: SGR.cyan,
  openai: SGR.green,
  kimi: SGR.magenta,
  deepseek: SGR.yellow,
}

/**
 * Colours handed to user-added seats, in order of first appearance.
 *
 * The four specified colours are excluded so an extra seat can never be
 * mistaken for a shipped one at a glance.
 */
const EXTRA_SGR: readonly string[] = [SGR.blue, SGR.brightRed, SGR.brightBlack, SGR.brightWhite]

/** Assignments handed out this process, so a seat keeps one colour throughout. */
const assigned = new Map<string, string>()

/**
 * Resolve one seat's SGR sequence.
 * @param seat - the seat id.
 * @returns the fixed colour for a shipped seat, or a rotation colour.
 */
function sgrFor(seat: SeatId): string {
  const builtin = (SEAT_SGR as Record<string, string | undefined>)[seat]
  if (builtin !== undefined) return builtin
  const already = assigned.get(seat)
  if (already !== undefined) return already
  const next = EXTRA_SGR[assigned.size % EXTRA_SGR.length] ?? SGR.white
  assigned.set(seat, next)
  return next
}

/** A painter that either wraps text in SGR codes or returns it unchanged. */
export interface Palette {
  /** True when escapes are being emitted. */
  readonly enabled: boolean
  /** Paint text in one seat's colour. */
  seat(seat: SeatId, text: string): string
  /** Paint a seat's name in its colour and bold. */
  seatName(seat: SeatId, text: string): string
  /** Bold white, reserved for the collective answer. */
  headline(text: string): string
  /** Dim, for separators and secondary labels. */
  muted(text: string): string
  /** Red, for seat failures. */
  failure(text: string): string
}

/** Wrap `text` in `codes` and reset, guarding against nested resets. */
function paint(codes: string, text: string): string {
  // A nested reset would drop the outer colour for the remainder of the line.
  const safe = text.split(SGR.reset).join(SGR.reset + codes)
  return `${codes}${safe}${SGR.reset}`
}

/** The no-op palette used whenever colour is unavailable or declined. */
const PLAIN: Palette = {
  enabled: false,
  seat: (_seat, text) => text,
  seatName: (_seat, text) => text,
  headline: text => text,
  muted: text => text,
  failure: text => text,
}

/** Inputs that decide whether escapes are safe to emit. */
export interface ColorSupportInput {
  /** Explicit opt-out, from `--no-color` or the tool argument. */
  readonly noColor?: boolean | undefined
  /** Whether the sink is an interactive terminal. */
  readonly isTty?: boolean | undefined
  /** Process environment, read for the NO_COLOR and FORCE_COLOR conventions. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

/**
 * Decide whether to emit ANSI escapes.
 *
 * Order matters: an explicit request beats the environment, `NO_COLOR` beats a
 * TTY (it exists precisely to override capability detection), and `FORCE_COLOR`
 * beats a non-TTY so piping into a pager still colours.
 * @param input - the explicit flag, TTY state, and environment.
 * @returns true when escapes should be written.
 */
export function supportsColor(input: ColorSupportInput = {}): boolean {
  if (input.noColor === true) return false
  const env = input.env ?? {}
  // https://no-color.org — any non-empty value disables colour.
  if (typeof env['NO_COLOR'] === 'string' && env['NO_COLOR'] !== '') return false
  if (env['TERM'] === 'dumb') return false
  if (typeof env['FORCE_COLOR'] === 'string' && env['FORCE_COLOR'] !== '' && env['FORCE_COLOR'] !== '0') return true
  return input.isTty === true
}

/**
 * Build a palette for the given capability decision.
 * @param enabled - whether escapes should be emitted.
 * @returns a painting palette, or the identity palette when disabled.
 */
export function createPalette(enabled: boolean): Palette {
  if (!enabled) return PLAIN
  return {
    enabled: true,
    seat: (seat, text) => paint(sgrFor(seat), text),
    seatName: (seat, text) => paint(SGR.bold + sgrFor(seat), text),
    headline: text => paint(SGR.bold + SGR.white, text),
    muted: text => paint(SGR.dim, text),
    failure: text => paint(SGR.red, text),
  }
}

/**
 * Build a palette by detecting support from the ambient process.
 * @param input - explicit flag, TTY state, and environment.
 * @returns a palette honouring the detection result.
 */
export function detectPalette(input: ColorSupportInput = {}): Palette {
  return createPalette(supportsColor(input))
}
