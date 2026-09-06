/**
 * Shared file evidence for the drafting round.
 *
 * An OpenRouter seat is a bare chat completion — no search, no fetch, no
 * filesystem. `evidence.ts` already solves that for the web: the seat says
 * what it wants looked up, a privileged route fulfils the request, and one
 * shared block goes to every seat. The seat never touches the network.
 *
 * This module is the same trade for local files. A seat names a path; it does
 * not get a filesystem handle, a directory listing, or a glob. The host reads
 * the file, and only inside roots the user configured. So a seat can ask for
 * `lib/auth.js` and be given it, and can ask for `~/.ssh/id_rsa` and be told
 * no, and the difference is decided here rather than by the seat's manners.
 *
 * Two caps matter more than they look. A file's content rides in every seat's
 * prompt for the rest of the run, so an unbounded read is not one expensive
 * call, it is a surcharge on all of them — hence the per-file and per-run
 * character limits, and hence truncation being marked rather than silent.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Newline, spelled out because the block is assembled from arrays. */
const NL = String.fromCharCode(10)

/** Paths one seat may request. Bounds one seat from filling the round. */
export const MAX_READS_PER_SEAT = 3
/** Files read per run, however many seats asked. */
export const MAX_READS_TOTAL = 8
/** Characters kept from one file, before truncation is marked. */
export const MAX_FILE_CHARS = 6_000
/** Characters kept across the whole block, so the prompt cannot be flooded. */
export const MAX_TOTAL_CHARS = 40_000
/** Longest path string accepted, so a request cannot be an essay. */
const MAX_PATH_LENGTH = 300

/**
 * The subset of the filesystem this module needs, so tests need no disk.
 *
 * A seam takes a path already resolved and already checked against the roots.
 * Keeping the allowlist out here would put the security decision in whatever
 * the host happened to pass, which is exactly where it should not live.
 */
export interface FileSeam {
  read(path: string, signal?: AbortSignal): Promise<string>
}

/** A file that was read, ready to render. */
interface LoadedFile {
  /** Path as shown to the seats — relative to its root. */
  readonly label: string
  /** Seats that asked for it. */
  readonly askedBy: readonly string[]
  /** Content, already capped. */
  readonly text: string
  /** Characters the file actually had, when more than were kept. */
  readonly fullLength?: number | undefined
}

/** Retrieved file evidence, ready to paste into a prompt. */
export interface FileEvidence {
  /** Prompt-ready block, numbered so seats can cite by index. */
  readonly block: string
  /** Paths included, in citation order, for later verification. */
  readonly paths: readonly string[]
  /** Requests that were refused, and why. Shown to the seats. */
  readonly refused: readonly string[]
}

/** One seat's requested paths. */
export interface SeatPaths {
  readonly seat: string
  readonly paths: readonly string[]
}

/**
 * Split a configured root list into absolute roots.
 *
 * Roots arrive as one comma-separated string rather than an array because a
 * nested schemastery default materialises an empty object and fails its own
 * required fields before any code runs.
 * @param setting - the configured value, comma-separated.
 * @returns absolute roots, empty when nothing is configured.
 */
export function parseRoots(setting: string | undefined): readonly string[] {
  if (setting === undefined || setting.trim() === '') return []
  const out: string[] = []
  for (const piece of setting.split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const absolute = resolve(trimmed)
    if (!out.includes(absolute)) out.push(absolute)
  }
  return out
}

/**
 * The section of the research prompt that asks for files.
 *
 * Returns an empty string when no root is configured, so a host that has not
 * opted in never tells seats about a capability they do not have — a seat told
 * it may read files and then refused every time will start inventing content.
 * @param roots - absolute roots the seats may read inside.
 * @returns the prompt section, or an empty string.
 */
export function readRequestSection(roots: readonly string[]): string {
  if (roots.length === 0) return ''
  const listed = roots.map(root => `  ${root}`).join(NL)
  return [
    '',
    `You may also ask to be shown source files, at most ${String(MAX_READS_PER_SEAT)}, each on its own line:`,
    '',
    'READ: <path>',
    '',
    'You have no filesystem access yourself. Someone else reads the file and hands you the text,',
    'and only inside these directories:',
    listed,
    '',
    'Give a path relative to one of those directories. Ask only for a file you actually need to see',
    'to answer well; each one is quoted back to every seat for the rest of the run. Files over '
    + `${String(MAX_FILE_CHARS)} characters are truncated, and the cut is marked.`,
  ].join(NL)
}

/**
 * Pull file requests out of a seat's reply.
 * @param text - the seat's reply.
 * @param max - most paths to accept from this seat.
 * @returns the requested paths, trimmed and deduplicated.
 */
export function parseReadRequests(text: string, max = MAX_READS_PER_SEAT): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*READ\s*:\s*(.+)$/i.exec(line)
    if (match === null) continue
    const wanted = (match[1] ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim()
    if (wanted === '' || wanted.length > MAX_PATH_LENGTH) continue
    const key = wanted.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(wanted)
    if (out.length >= max) break
  }
  return out
}

/** Where a requested path landed. */
interface Resolved {
  /** Absolute path to read. */
  readonly path: string
  /** Path as shown to seats, relative to its root. */
  readonly label: string
}

/**
 * Resolve a requested path inside the configured roots.
 *
 * The check is on the resolved absolute path, not on the text of the request,
 * because `a/../../b` and `b` are the same file and only one of them looks
 * suspicious. A path that resolves outside every root is refused, and so is an
 * absolute path that happens to point outside — naming a root explicitly is
 * allowed, escaping one is not.
 * @param request - the path as the seat wrote it.
 * @param roots - absolute roots.
 * @returns the resolved path and its label, or undefined when out of bounds.
 */
export function resolveWithinRoots(
  request: string,
  roots: readonly string[],
): Resolved | undefined {
  if (request.includes('\0')) return undefined
  for (const root of roots) {
    const candidate = isAbsolute(request) ? resolve(request) : resolve(root, request)
    const rel = relative(root, candidate)
    // `relative` returns '' for the root itself and a '..'-leading path for
    // anything above it. Both are outside what was granted.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    return { path: candidate, label: rel.split(sep).join('/') }
  }
  return undefined
}

/**
 * A seam backed by the real filesystem.
 * @returns a seam reading UTF-8 from disk.
 */
export function diskSeam(): FileSeam {
  return {
    async read(path: string, signal?: AbortSignal): Promise<string> {
      return readFile(path, { encoding: 'utf8', ...signal === undefined ? {} : { signal } })
    },
  }
}

/**
 * Read every requested file the roots allow, and render one shared block.
 *
 * Refusals are reported rather than dropped. A seat whose request silently
 * vanished will assume the file was empty or that it was not listening; told
 * plainly that the path was outside the granted roots, it asks for a different
 * one or says what it could not check.
 * @param seam - the file seam, or undefined when reading is switched off.
 * @param roots - absolute roots the seats may read inside.
 * @param requests - what each seat asked for.
 * @param signal - cancellation from the run.
 * @returns the evidence, or undefined when nothing could be read.
 */
export async function gatherFiles(
  seam: FileSeam | undefined,
  roots: readonly string[],
  requests: readonly SeatPaths[],
  signal?: AbortSignal,
): Promise<FileEvidence | undefined> {
  if (seam === undefined || roots.length === 0) return undefined

  // Deduplicate across seats on the resolved path: two seats asking for the
  // same file, one relatively and one absolutely, is one read.
  const wanted = new Map<string, { readonly label: string; readonly askedBy: string[] }>()
  const refused: string[] = []
  for (const request of requests) {
    for (const raw of request.paths) {
      const resolved = resolveWithinRoots(raw, roots)
      if (resolved === undefined) {
        const note = `${raw} — outside the directories this run may read (asked by ${request.seat})`
        if (!refused.includes(note)) refused.push(note)
        continue
      }
      const existing = wanted.get(resolved.path)
      if (existing === undefined) {
        wanted.set(resolved.path, { label: resolved.label, askedBy: [request.seat] })
      } else if (!existing.askedBy.includes(request.seat)) {
        existing.askedBy.push(request.seat)
      }
    }
  }

  const loaded: LoadedFile[] = []
  let budget = MAX_TOTAL_CHARS
  for (const [path, meta] of [...wanted.entries()].slice(0, MAX_READS_TOTAL)) {
    if (budget <= 0) {
      refused.push(`${meta.label} — the shared block was already full`)
      continue
    }
    let text: string
    try {
      text = await seam.read(path, signal)
    } catch (error) {
      // One unreadable file must not lose the others.
      const reason = error instanceof Error ? error.message : String(error)
      refused.push(`${meta.label} — could not be read (${reason})`)
      continue
    }
    if (text.includes('\0')) {
      refused.push(`${meta.label} — not a text file`)
      continue
    }
    const cap = Math.min(MAX_FILE_CHARS, budget)
    const kept = text.length <= cap ? text : text.slice(0, cap)
    budget -= kept.length
    loaded.push({
      label: meta.label,
      askedBy: meta.askedBy,
      text: kept,
      ...kept.length === text.length ? {} : { fullLength: text.length },
    })
  }

  if (loaded.length === 0 && refused.length === 0) return undefined
  return {
    block: render(loaded, refused),
    paths: loaded.map(file => file.label),
    refused,
  }
}

/**
 * Render loaded files as a numbered, citable block.
 * @param files - what was read.
 * @param refused - requests that were not served, and why.
 * @returns the prompt block.
 */
function render(files: readonly LoadedFile[], refused: readonly string[]): string {
  const lines: string[] = [
    'FILES — read from disk moments ago, in answer to what the council asked for.',
    '',
    'This is the real current source. Where it disagrees with what you recall, the file wins.',
    'You are seeing only what was asked for; do not assume a file you were not shown does not exist.',
    '',
  ]
  files.forEach((file, index) => {
    const who = file.askedBy.length === 0 ? '' : ` (asked by ${file.askedBy.join(', ')})`
    lines.push(`[F${String(index + 1)}] ${file.label}${who}`)
    if (file.fullLength !== undefined) {
      lines.push(
        `    truncated: showing ${String(file.text.length)} of ${String(file.fullLength)} characters`,
      )
    }
    lines.push('```', file.text, '```', '')
  })
  if (refused.length > 0) {
    lines.push('NOT SHOWN:')
    for (const note of refused) lines.push(`  - ${note}`)
    lines.push('')
  }
  lines.push('Cite these by their F-number. If a file you needed is not here, say so rather than guessing at its contents.')
  return lines.join(NL)
}
