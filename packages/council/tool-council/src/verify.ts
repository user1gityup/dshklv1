/**
 * Citation verification.
 *
 * Shared evidence removes a seat's *incentive* to invent a source, but nothing
 * in it checks whether the source a seat actually cited exists. A model that
 * has produced plausible-looking URLs its whole training life will still
 * produce one under pressure, and a fabricated citation is worse than no
 * citation: it reads as diligence.
 *
 * So every draft is audited. URLs that came from the shared evidence are
 * trusted without a second request — the council just retrieved them. Anything
 * else is fetched and must answer. A seat that cites what does not resolve, or
 * that emits tool-call syntax it had no tools to run, is scored down rather
 * than merely annotated: the tally is where a fabrication has to cost
 * something, or it will keep winning on fluency.
 */

import type { SeatId } from './colors.ts'

/** Outcome for one cited URL. */
export type CitationStatus =
  /** Came from the shared evidence block, so already retrieved. */
  | 'evidence'
  /** Fetched successfully just now. */
  | 'reachable'
  /** Fetched and did not answer, or could not be fetched at all. */
  | 'unreachable'
  /** Not checked: over the per-draft budget. */
  | 'unchecked'

/** One cited URL and what became of it. */
export interface Citation {
  readonly url: string
  readonly status: CitationStatus
  /** Why, when the status needs explaining. */
  readonly detail?: string | undefined
}

/** What auditing one draft found. */
export interface DraftAudit {
  readonly seat: SeatId
  readonly citations: readonly Citation[]
  /** Tool-call syntax the seat emitted despite having no tools. */
  readonly fabricatedToolCalls: readonly string[]
  /** Score multiplier penalty in 0..1, applied by the tally. */
  readonly penalty: number
}

/** The subset of the web seam this module needs. */
export interface FetchSeam {
  fetch(
    request: { readonly url: string },
    signal?: AbortSignal,
  ): Promise<{ readonly statusCode: number }>
}

/** URLs fetched per draft. Bounds latency on a draft that cites forty things. */
const MAX_CHECKS = 5
/** Emitting a tool call it could not run is the strongest fabrication signal. */
const FABRICATION_PENALTY = 0.5
/** Each dead citation, up to the cap below. */
const DEAD_CITATION_PENALTY = 0.2
/**
 * Statuses that mean "we were refused", not "this does not exist".
 *
 * Bot protection is extremely common on exactly the domains a good citation
 * points at — package registries, docs sites, news. Treating a refusal as a
 * dead link would penalise seats for citing real sources, which is the
 * opposite of what this check is for.
 */
const BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 405, 429])

/** Never zero a draft outright: a bad citation is not always a bad answer. */
const MAX_PENALTY = 0.9

/**
 * Hosts no web fetch can speak for.
 *
 * A seat asked about the running app cites `http://localhost:3080`, which is
 * a correct reference to the reader's own machine and not a claim about the
 * public web. Fetching it proves nothing either way — the seam runs somewhere
 * else, and a hit would be the host's own port rather than the seat's — so
 * these are reported unchecked and cost nothing in the tally. Measured: two
 * seats were scored down 20% each for citing the very URL the question named.
 */
const UNVERIFIABLE_HOSTS = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0|.*\.local|.*\.localhost)$/i

/**
 * Decide whether a URL is checkable from a general web fetch at all.
 * @param url - the cited URL.
 * @returns true when no fetch result would be evidence either way.
 */
function unverifiable(url: string): boolean {
  try {
    return UNVERIFIABLE_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Tell a broken seam apart from a broken link.
 *
 * The web seam reports its own failures with a `WEB_PROVIDER_*` code, and every
 * one of them means the check never happened. Routing on the code rather than
 * the message is what keeps this from turning into string matching the moment
 * the wording changes.
 * @param error - whatever the seam threw.
 * @returns true when the seam, not the URL, is the reason for the failure.
 */
function seamUnusable(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('WEB_PROVIDER_')
}

/**
 * Tool-call shapes models emit when they believe they have tools.
 * Deliberately narrow: prose *about* searching is not a fabricated call, so
 * these all require syntax a model would only produce to invoke something.
 */
const TOOL_CALL_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: '<tool>', re: /<tool>[\s\S]{0,80}?<\/tool>/gi },
  { label: '<tool_call>', re: /<tool_call>/gi },
  { label: '<function_calls>', re: /<function_calls>/gi },
  { label: '<invoke>', re: /<invoke\s+name=/gi },
  { label: 'web_search(...)', re: /\bweb_search\s*\(/gi },
  { label: 'search(...)', re: /\bsearch_web\s*\(/gi },
  { label: '```tool', re: /```tool\b/gi },
]

/**
 * Pull http(s) URLs out of prose, trimming trailing punctuation and markdown.
 * @param text - the draft.
 * @returns unique URLs in first-seen order.
 */
export function extractUrls(text: string): readonly string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]}]+/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of found) {
    // Sentence punctuation clings to a URL at the end of a line.
    const url = raw.replace(/[.,;:!?]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Find tool-call syntax a tool-less seat could not have executed.
 * @param text - the draft.
 * @returns the distinct shapes found.
 */
export function detectFabricatedToolCalls(text: string): readonly string[] {
  const hits = new Set<string>()
  for (const { label, re } of TOOL_CALL_PATTERNS) {
    // Each pattern carries /g, so reset before reuse across drafts.
    re.lastIndex = 0
    if (re.test(text)) hits.add(label)
  }
  return [...hits]
}

/**
 * Compare two URLs ignoring scheme, `www.`, trailing slash, and case of host.
 * @param url - the URL to normalise.
 * @returns a comparable key, or the input when it will not parse.
 */
function key(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./i, '').toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${host}${path}${parsed.search}`
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Turn an audit's findings into a score multiplier penalty.
 * @param citations - the audited citations.
 * @param fabricated - tool-call shapes found.
 * @returns a penalty in 0..MAX_PENALTY.
 */
export function penaltyFor(
  citations: readonly Citation[],
  fabricated: readonly string[],
): number {
  let penalty = fabricated.length > 0 ? FABRICATION_PENALTY : 0
  const dead = citations.filter(citation => citation.status === 'unreachable').length
  penalty += dead * DEAD_CITATION_PENALTY
  return Math.min(MAX_PENALTY, penalty)
}

/**
 * Audit one draft's citations and tool-call syntax.
 *
 * Never throws: a verification failure must not take down a run that otherwise
 * produced good answers. A URL that cannot be checked is reported as such
 * rather than assumed good or assumed bad.
 * @param seat - whose draft this is.
 * @param text - the draft.
 * @param evidenceUrls - URLs already retrieved as shared evidence.
 * @param seam - the fetch seam, or undefined to skip network checks.
 * @param signal - cancellation from the run.
 * @returns what the audit found.
 */
export async function auditDraft(
  seat: SeatId,
  text: string,
  evidenceUrls: readonly string[],
  seam: FetchSeam | undefined,
  signal?: AbortSignal,
): Promise<DraftAudit> {
  const trusted = new Set(evidenceUrls.map(key))
  const urls = extractUrls(text)
  const citations: Citation[] = []
  let checks = 0

  for (const url of urls) {
    if (trusted.has(key(url))) {
      citations.push({ url, status: 'evidence' })
      continue
    }
    if (unverifiable(url)) {
      citations.push({ url, status: 'unchecked', detail: 'local address, not checkable from here' })
      continue
    }
    if (seam === undefined || checks >= MAX_CHECKS) {
      citations.push({ url, status: 'unchecked', detail: seam === undefined ? 'no fetch provider' : 'over the per-draft check budget' })
      continue
    }
    checks += 1
    try {
      const result = await seam.fetch({ url }, signal)
      if (result.statusCode >= 200 && result.statusCode < 400) {
        citations.push({ url, status: 'reachable' })
      } else if (BLOCKED_STATUSES.has(result.statusCode)) {
        // The page exists; the site simply refused a non-browser request.
        // npmjs.com answers 403 to plain fetches, so penalising this would
        // punish a seat for citing a real and appropriate source.
        citations.push({
          url,
          status: 'unchecked',
          detail: `site refused automated access (HTTP ${String(result.statusCode)})`,
        })
      } else {
        citations.push({ url, status: 'unreachable', detail: `HTTP ${String(result.statusCode)}` })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'fetch failed'
      // A seam with no provider behind it fails every URL identically. That is
      // this host's configuration, not the seat's citation, and scoring it as
      // a dead link would penalise every seat that cited anything on a machine
      // where no web provider is registered.
      if (seamUnusable(error)) {
        citations.push({ url, status: 'unchecked', detail: detail.slice(0, 120) })
      } else {
        citations.push({ url, status: 'unreachable', detail: detail.slice(0, 120) })
      }
    }
  }

  const fabricatedToolCalls = detectFabricatedToolCalls(text)
  return { seat, citations, fabricatedToolCalls, penalty: penaltyFor(citations, fabricatedToolCalls) }
}
