/**
 * Shared evidence for the drafting round.
 *
 * Only CLI seats carry tools. An OpenRouter seat is a bare chat completion —
 * no search, no fetch, no filesystem — so asked for something specific and
 * current it cannot know, it will often emit tool-call syntax it has no way to
 * execute and then report training data as though it had been verified. The
 * seat is not being dishonest; nothing ever told it the tools were absent.
 *
 * Rather than buy every seat its own metered search, the council runs one
 * search through the harness web seam, whose router prefers a route already
 * paid for by subscription, and hands the same sources to every seat. One
 * search, shared evidence, and no seat needs to invent a citation.
 */

/** One retrieved source. Mirrors the web seam's shape, structurally. */
export interface EvidenceSource {
  readonly url: string
  readonly title?: string | undefined
  readonly snippet?: string | undefined
  readonly publishedAt?: string | undefined
}

/** The subset of the web seam this module needs, so tests need no host. */
export interface SearchSeam {
  search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly content?: string | undefined; readonly sources: readonly EvidenceSource[] }>
}

/** Retrieved evidence, ready to paste into a prompt. */
export interface Evidence {
  /** Prompt-ready block, numbered so seats can cite by index. */
  readonly block: string
  /** Source URLs in citation order, for later verification. */
  readonly urls: readonly string[]
}

/** Sources retrieved per run. Enough to ground an answer, few enough to stay cheap. */
const MAX_RESULTS = 6
/** Snippets are truncated so evidence never crowds out the question itself. */
const SNIPPET_LIMIT = 400

/**
 * Collapse whitespace and cap length, so one verbose source cannot dominate.
 * @param text - raw snippet text.
 * @returns a single-line, length-capped snippet.
 */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SNIPPET_LIMIT ? flat : `${flat.slice(0, SNIPPET_LIMIT)}...`
}

/**
 * Render retrieved sources as a numbered, citable block.
 * @param sources - what the seam returned.
 * @param summary - optional provider-written summary.
 * @returns the prompt block.
 */
function render(sources: readonly EvidenceSource[], summary: string | undefined): string {
  const lines: string[] = [
    'EVIDENCE — retrieved from the web moments ago, for this question.',
    '',
    'This is current and your training data is not. Where the two disagree, the evidence wins.',
    '',
  ]
  if (summary !== undefined && summary.trim() !== '') {
    lines.push(`Summary from the search provider: ${tidy(summary)}`, '')
  }
  sources.forEach((source, index) => {
    const label = source.title === undefined || source.title.trim() === ''
      ? source.url
      : `${source.title.trim()} — ${source.url}`
    lines.push(`[${String(index + 1)}] ${label}`)
    if (source.publishedAt !== undefined && source.publishedAt.trim() !== '') {
      lines.push(`    published: ${source.publishedAt.trim()}`)
    }
    if (source.snippet !== undefined && source.snippet.trim() !== '') {
      lines.push(`    ${tidy(source.snippet)}`)
    }
  })
  lines.push(
    '',
    'Cite these by their number. If the evidence does not settle something, say so plainly rather than filling the gap from memory.',
  )
  return lines.join('\n')
}

/**
 * Run one search and render it as shared evidence.
 *
 * Failure is not fatal: a council that cannot search is still a council, and a
 * seat told plainly that no evidence was retrieved behaves far better than one
 * left to guess whether it has tools. Returns undefined so the caller can say
 * exactly that.
 * @param seam - the web seam, or undefined when the host mounts none.
 * @param query - the user's question.
 * @param signal - cancellation from the run.
 * @returns the evidence, or undefined when nothing could be retrieved.
 */
export async function gatherEvidence(
  seam: SearchSeam | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<Evidence | undefined> {
  if (seam === undefined) return undefined
  let sources: readonly EvidenceSource[]
  let summary: string | undefined
  try {
    const result = await seam.search({ query, maxResults: MAX_RESULTS }, signal)
    sources = result.sources
    summary = result.content
  } catch {
    // An unavailable or ambiguous provider is a degraded run, not a failed one.
    return undefined
  }
  if (sources.length === 0) return undefined
  return { block: render(sources, summary), urls: sources.map(source => source.url) }
}

/** Search queries requested per seat. Bounds one seat from spending the round. */
export const MAX_QUERIES_PER_SEAT = 3
/** Total queries run per council, however many seats asked. */
export const MAX_QUERIES_TOTAL = 8

/**
 * Prompt asking a seat what it wants looked up.
 *
 * Deliberately cheap: a seat answers with query lines, not prose, so this
 * round costs a few hundred tokens and buys searches that are free. The
 * alternative — giving every seat its own metered web plugin — costs roughly
 * 25x per call for the same information.
 * @param query - the user's question.
 * @param plan - the agreed approach, when there is one.
 * @param extra - a further request section, such as the one asking for files.
 *   Empty when the host grants nothing beyond search.
 * @returns the prompt.
 */
export function researchPrompt(query: string, plan: string | undefined, extra = ''): string {
  const approach = plan === undefined || plan === '' ? '' : `

AGREED APPROACH:
${plan}`
  // With a second kind of request in play the reply is no longer "nothing but
  // query lines", and a seat held to that wording drops its file requests to
  // obey it.
  const only = extra === '' ? ' nothing but' : ''
  return `Before answering, say what you would need to look up.

Reply with${only} query lines, at most ${String(MAX_QUERIES_PER_SEAT)}, each starting with SEARCH: and written as you would type it into a search engine.

SEARCH: <query>

Ask only for things a search could settle — current figures, versions, prices, dates, whether a library still exists. Do not ask for opinions or for anything you already know.${extra}

If you need nothing at all, reply with exactly: NONE${approach}

QUESTION:
${query}`
}

/**
 * Pull search requests out of a seat's reply.
 * @param text - the seat's reply.
 * @param max - most queries to accept from this seat.
 * @returns the requested queries, trimmed and deduplicated.
 */
export function parseSearchRequests(text: string, max = MAX_QUERIES_PER_SEAT): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*SEARCH\s*:\s*(.+)$/i.exec(line)
    if (match === null) continue
    const wanted = (match[1] ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (wanted === '' || wanted.length > 300) continue
    const key = wanted.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(wanted)
    if (out.length >= max) break
  }
  return out
}

/** One seat's requested queries. */
export interface SeatQueries {
  readonly seat: string
  readonly queries: readonly string[]
}

/**
 * Run every requested query through the seam and render one shared block.
 *
 * All searches go through the same seam the council already uses, whose router
 * prefers a route already paid for by subscription — so a seat asking for
 * three lookups costs nothing beyond the tokens it used to ask.
 * @param seam - the web seam, or undefined when the host mounts none.
 * @param requests - what each seat asked for.
 * @param signal - cancellation from the run.
 * @returns the evidence, or undefined when nothing could be retrieved.
 */
export async function gatherRequested(
  seam: SearchSeam | undefined,
  requests: readonly SeatQueries[],
  signal?: AbortSignal,
): Promise<Evidence | undefined> {
  if (seam === undefined) return undefined

  // Deduplicate across seats: two seats asking the same thing is one search.
  const asked = new Map<string, string[]>()
  for (const request of requests) {
    for (const wanted of request.queries) {
      const key = wanted.toLowerCase()
      const owners = asked.get(key)
      if (owners === undefined) asked.set(key, [request.seat])
      else if (!owners.includes(request.seat)) owners.push(request.seat)
    }
  }
  const queries = [...asked.keys()].slice(0, MAX_QUERIES_TOTAL)
  if (queries.length === 0) return undefined

  const blocks: string[] = []
  const urls: string[] = []
  for (const wanted of queries) {
    let sources: readonly EvidenceSource[] = []
    let summary: string | undefined
    try {
      const result = await seam.search({ query: wanted, maxResults: 4 }, signal)
      sources = result.sources
      summary = result.content
    } catch {
      // One failed query must not lose the answers to the others.
      continue
    }
    if (sources.length === 0) continue
    const owners = asked.get(wanted) ?? []
    blocks.push(renderQuery(wanted, owners, sources, summary, urls.length))
    for (const source of sources) urls.push(source.url)
  }
  if (blocks.length === 0) return undefined

  const head = [
    'EVIDENCE — retrieved from the web moments ago, in answer to what the council asked for.',
    '',
    'This is current and your training data is not. Where the two disagree, the evidence wins.',
    '',
  ].join(String.fromCharCode(10))
  const tail = [
    '',
    'Cite these by their number. If the evidence does not settle something, say so plainly rather than filling the gap from memory.',
  ].join(String.fromCharCode(10))
  const joined = blocks.join(String.fromCharCode(10) + String.fromCharCode(10))
  return { block: `${head}${joined}${tail}`, urls }
}

/**
 * Render one query's results, naming who asked for it.
 * @param wanted - the query.
 * @param owners - seats that asked for it.
 * @param sources - what came back.
 * @param summary - optional provider summary.
 * @param offset - running citation number.
 * @returns the rendered section.
 */
function renderQuery(
  wanted: string,
  owners: readonly string[],
  sources: readonly EvidenceSource[],
  summary: string | undefined,
  offset: number,
): string {
  const who = owners.length === 0 ? '' : ` (asked by ${owners.join(', ')})`
  const lines: string[] = [`QUERY: ${wanted}${who}`]
  if (summary !== undefined && summary.trim() !== '') {
    lines.push(`  summary: ${tidy(summary)}`)
  }
  sources.forEach((source, index) => {
    const label = source.title === undefined || source.title.trim() === ''
      ? source.url
      : `${source.title.trim()} — ${source.url}`
    lines.push(`  [${String(offset + index + 1)}] ${label}`)
    if (source.snippet !== undefined && source.snippet.trim() !== '') {
      lines.push(`      ${tidy(source.snippet)}`)
    }
  })
  return lines.join(String.fromCharCode(10))
}
