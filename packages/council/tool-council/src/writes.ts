/**
 * Seats proposing code, each into a tree of its own.
 *
 * `files.ts` gives a seat a way to be shown source it cannot reach. This is
 * the other direction: a way for a seat to produce source without being able
 * to reach anything either. A seat emits `WRITE:` blocks; the host writes them
 * under that seat's own root and nowhere else. An OpenRouter seat has no
 * filesystem and no process, so this is the only sense in which it can own a
 * directory tree at all — and it turns out to be the safer sense, because the
 * seat never holds a handle it could point somewhere unintended.
 *
 * Nothing here touches the real repositories. A proposal is a candidate, and
 * candidates are written side by side so a later round can compare them and
 * pick one. Applying the winner is a separate, human-gated act.
 *
 * Two containment checks run on every proposal, and both must pass. The path
 * must name a location inside a granted source root — so a seat cannot invent
 * a target outside the work — and the destination must land inside that seat's
 * own root, so one seat cannot write over another's candidate.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { resolveWithinRoots } from './files.ts'

/** Newline, spelled out because reports are assembled from arrays. */
const NL = String.fromCharCode(10)

/** Files one seat may propose in a round. */
export const MAX_WRITES_PER_SEAT = 6
/** Characters accepted for one proposed file. */
export const MAX_WRITE_CHARS = 20_000
/** Characters accepted across one seat's whole proposal. */
export const MAX_WRITE_CHARS_TOTAL = 60_000

/** The subset of the filesystem this module needs, so tests need no disk. */
export interface WriteSeam {
  write(path: string, text: string): Promise<void>
}

/** One file a seat proposed. */
export interface ProposedWrite {
  /** Path as the seat wrote it. */
  readonly path: string
  /** Full intended contents of the file. */
  readonly content: string
}

/** One file actually written into a seat's tree. */
export interface WrittenFile {
  /** Path relative to the source root, as shown in reports. */
  readonly label: string
  /** Absolute path inside the seat's own tree. */
  readonly path: string
  /** Characters written. */
  readonly chars: number
}

/** What one seat produced in a proposing round. */
export interface Candidate {
  readonly seat: string
  /** Absolute root this seat's files were written under. */
  readonly root: string
  readonly files: readonly WrittenFile[]
  /** Proposals that were not written, and why. */
  readonly refused: readonly string[]
}

/**
 * The section of a prompt that tells a seat how to propose code.
 *
 * A seat is told plainly that it is writing into its own tree and that nothing
 * it writes reaches the real repository. Without that, a model asked to edit a
 * file it cannot see will either refuse or claim to have edited it.
 * @param roots - absolute source roots whose files may be targeted.
 * @returns the prompt section, or an empty string when nothing may be written.
 */
export function writeRequestSection(roots: readonly string[]): string {
  if (roots.length === 0) return ''
  const listed = roots.map(root => `  ${root}`).join(NL)
  return [
    '',
    'PROPOSING CODE',
    '',
    `Write your version of each file you are changing, at most ${String(MAX_WRITES_PER_SEAT)}, like this:`,
    '',
    'WRITE: <path>',
    '```',
    '<the complete new contents of that file>',
    '```',
    '',
    'Give the whole file, not a diff and not an excerpt: what you write replaces the file.',
    'Paths are relative to one of these directories:',
    listed,
    '',
    'What you write goes into a working tree of your own. It does not reach the real',
    'repository, and no other seat can see or overwrite it. Other seats are answering',
    'the same task separately, and a later round picks one version to be implemented.',
    `A file over ${String(MAX_WRITE_CHARS)} characters is refused rather than truncated, because half a`,
    'file is worse than none. Change only what the task asks for.',
  ].join(NL)
}

/**
 * Pull proposed files out of a seat's reply.
 *
 * A `WRITE:` line must be followed by a fenced block; a bare one is dropped
 * rather than guessed at, because the alternative is writing whatever prose
 * happened to follow it into a source file.
 * @param text - the seat's reply.
 * @param max - most files to accept from this seat.
 * @returns the proposals, in the order the seat gave them.
 */
export function parseWriteRequests(text: string, max = MAX_WRITES_PER_SEAT): readonly ProposedWrite[] {
  const out: ProposedWrite[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  let index = 0
  while (index < lines.length && out.length < max) {
    const header = /^\s*WRITE\s*:\s*(.+)$/i.exec(lines[index] ?? '')
    if (header === null) {
      index += 1
      continue
    }
    const path = (header[1] ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim()
    index += 1
    // Skip blank lines between the header and its fence, but nothing else: a
    // paragraph in between means the seat was talking, not proposing.
    while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[index] ?? '')
    if (open === null) continue
    const fence = open[1] ?? '```'
    index += 1
    const body: string[] = []
    let closed = false
    while (index < lines.length) {
      const line = lines[index] ?? ''
      if (new RegExp(`^\\s*${fence[0] ?? '`'}{${String(fence.length)},}\\s*$`).test(line)) {
        closed = true
        index += 1
        break
      }
      body.push(line)
      index += 1
    }
    // An unclosed fence means the reply was cut off mid-file. Writing what
    // arrived would produce a truncated source file that looks complete.
    if (!closed || path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path, content: body.join(NL) })
  }
  return out
}

/**
 * A seam backed by the real filesystem, creating parent directories.
 * @returns a seam writing UTF-8 to disk.
 */
export function diskWriteSeam(): WriteSeam {
  return {
    async write(path: string, text: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
    },
  }
}

/**
 * Write one seat's proposals into that seat's own tree.
 *
 * Both containment checks live here rather than in the caller. A path must
 * name a location inside a granted source root, so a seat cannot target a file
 * outside the work; and the destination must resolve inside the seat's own
 * root, so a proposal cannot escape into another seat's candidate or into the
 * real repository.
 * @param seam - the write seam, or undefined when proposing is switched off.
 * @param seatRoot - absolute directory this seat owns.
 * @param sourceRoots - absolute source roots whose files may be targeted.
 * @param seat - the seat id, for the report.
 * @param proposals - what the seat proposed.
 * @returns what was written and what was refused.
 */
export async function applyWrites(
  seam: WriteSeam | undefined,
  seatRoot: string,
  sourceRoots: readonly string[],
  seat: string,
  proposals: readonly ProposedWrite[],
): Promise<Candidate> {
  const root = resolve(seatRoot)
  const files: WrittenFile[] = []
  const refused: string[] = []
  if (seam === undefined || sourceRoots.length === 0) {
    return { seat, root, files, refused: proposals.map(one => `${one.path} — proposing is switched off`) }
  }
  let budget = MAX_WRITE_CHARS_TOTAL
  for (const proposal of proposals) {
    const target = resolveWithinRoots(proposal.path, sourceRoots)
    if (target === undefined) {
      refused.push(`${proposal.path} — does not name a file inside the directories this run covers`)
      continue
    }
    if (proposal.content.length > MAX_WRITE_CHARS) {
      refused.push(
        `${target.label} — ${String(proposal.content.length)} characters, over the ${String(MAX_WRITE_CHARS)} limit`,
      )
      continue
    }
    if (proposal.content.length > budget) {
      refused.push(`${target.label} — this seat's proposal was already at its size limit`)
      continue
    }
    const destination = resolve(root, target.label)
    const inside = relative(root, destination)
    // Belt and braces: the label came from a checked path, but the file that
    // writes to disk is the wrong place to assume that held.
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      refused.push(`${target.label} — resolved outside this seat's own tree`)
      continue
    }
    try {
      await seam.write(destination, proposal.content)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      refused.push(`${target.label} — could not be written (${reason})`)
      continue
    }
    budget -= proposal.content.length
    files.push({ label: target.label, path: destination, chars: proposal.content.length })
  }
  return { seat, root, files, refused }
}

/**
 * Render what each seat proposed, for the report shown at the selection round.
 * @param candidates - one per seat that proposed.
 * @returns a markdown summary.
 */
export function renderCandidates(candidates: readonly Candidate[]): string {
  const lines: string[] = []
  for (const candidate of candidates) {
    const total = candidate.files.reduce((sum, file) => sum + file.chars, 0)
    lines.push(`**${candidate.seat}** — ${String(candidate.files.length)} file(s), ${String(total)} characters`)
    for (const file of candidate.files) {
      lines.push(`  - ${file.label} (${String(file.chars)} chars)`)
    }
    for (const note of candidate.refused) {
      lines.push(`  - not written: ${note}`)
    }
    lines.push('')
  }
  return lines.join(NL)
}
