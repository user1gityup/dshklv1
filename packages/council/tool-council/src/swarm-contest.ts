import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SubTask } from './decompose.ts'
import type { Worker, WorkKind } from './roster.ts'
import { inferKind } from './roster.ts'
import type { SeatConfig, SeatReply } from './seats.ts'
import { askSeat } from './seats.ts'
import { parseReview, tally } from './council.ts'
import { unitPrompt } from './swarm.ts'
import type { SwarmRunOptions, SwarmUnitResult } from './swarm.ts'
import { applyWrites, parseWriteRequests, writeRequestSection } from './writes.ts'
import type { Candidate } from './writes.ts'
import { gatherFiles, parseReadRequests } from './files.ts'

/** Every run/unit/seat gets a separate root, including retries of the same unit. */
export function unitCandidateRoot(root: string, run: string, unit: string, seat: string): string {
  const segment = (part: string): string => encodeURIComponent(part).replaceAll('.', '%2E')
  return resolve(root, segment(run), segment(unit), segment(seat))
}

/** Contest a unit and require an explicit paid review before downstream work sees it. */
export async function runUnitContest(
  options: SwarmRunOptions,
  task: SubTask,
  done: readonly SwarmUnitResult[],
  workers: readonly Worker[],
  assigned: SeatConfig,
): Promise<SwarmUnitResult> {
  const takes = (seat: SeatConfig, kind: WorkKind): boolean =>
    workers.some(worker => worker.provider === seat.id
      && (worker.kinds.includes('any') || worker.kinds.includes(kind)))
  const eligible = options.seats.filter(seat => takes(seat, inferKind(task)))
  const paid = eligible.filter(seat => seat.free !== true)
  const reviewers = options.seats.filter(seat => seat.free !== true && takes(seat, 'review'))
  const reviewer = reviewers.find(seat => seat.id !== assigned.id) ?? reviewers[0]
  const candidates: Candidate[] = []
  let elapsed = 0
  const fail = (error: string): SwarmUnitResult => ({ task, seat: '', text: '', error, ms: elapsed, candidates })
  if (reviewer === undefined) return fail('This mode requires an enabled paid reviewer.')
  const proposers = options.profile === 'economy' ? eligible.filter(seat => seat.free === true) : [assigned]
  if (options.profile === 'economy' && proposers.length < 2) return fail('Economy requires at least two eligible free seats for each unit.')
  const roots = options.fileRoots ?? []
  // Bound once, so the write path below is reached only with both halves in
  // hand. A unit that names no files stages nothing and leaves this undefined.
  const needsFiles = (task.files?.length ?? 0) > 0
  const staging = needsFiles && options.writes !== undefined && options.workRoot !== undefined && roots.length > 0
    ? { writes: options.writes, workRoot: options.workRoot }
    : undefined
  if (needsFiles && staging === undefined) {
    return fail('Candidate files require approved workspace staging and source roots.')
  }
  const run = randomUUID()
  const ask = async (seat: SeatConfig, prompt: string) => {
    const reply = await askSeat(seat, prompt, options.apiKey, options.signal, options.timeoutMs, options.memory, options.webMaxResults)
    elapsed += reply.ms
    return reply
  }
  const produce = async (seat: SeatConfig): Promise<SeatReply> => {
    const prompt = (files = '') => unitPrompt(options.query, task, done, options.files === undefined ? [] : roots, files)
      + ((task.files?.length ?? 0) === 0 ? '' : writeRequestSection(roots))
    let reply = await ask(seat, prompt())
    if (reply.error !== undefined) return reply
    const wanted = parseReadRequests(reply.text)
    if (wanted.length > 0 && options.files !== undefined) {
      const evidence = await gatherFiles(options.files, roots, [{ seat: seat.id, paths: wanted }], options.signal)
      if (evidence !== undefined) reply = await ask(seat, prompt(evidence.block))
    }
    if (reply.error !== undefined || staging === undefined) return reply
    const proposed = parseWriteRequests(reply.text)
    const allowed = new Set(task.files)
    if (proposed.some(file => !allowed.has(file.path))) {
      return { ...reply, error: 'Candidate wrote a file outside its unit target list.' }
    }
    const candidate = await applyWrites(staging.writes,
      unitCandidateRoot(staging.workRoot, run, task.id, seat.id), roots, seat.id, proposed)
    candidates.push(candidate)
    if (candidate.refused.length > 0 || candidate.files.length === 0) {
      return { ...reply, error: `Candidate files missing or refused: ${candidate.refused.join('; ')}` }
    }
    return reply
  }
  const drafts: SeatReply[] = []
  if (options.sequential === true) {
    for (const seat of proposers) drafts.push(await produce(seat))
  } else drafts.push(...await Promise.all(proposers.map(produce)))
  const usable = drafts.filter(reply => reply.error === undefined && reply.text.trim() !== '')
  let chosen: SeatReply | undefined = usable[0]
  if (options.profile === 'economy' && usable.length > 1) {
    const prompt = `Choose the best complete artifact for this unit against its acceptance conditions. Do not favor cost or model name.\n${unitPrompt(options.query, task, done)}\n${usable.map(reply => `CANDIDATE ${reply.seat}:\n${reply.text}`).join('\n\n')}\nReply with VOTE: <seat id>\nCONFIDENCE: <0..1>\nCRITIQUE: <reasons>`
    const votes = await Promise.all(proposers.map(async (seat) => {
      const reply = await ask(seat, prompt)
      return {
        seat: seat.id,
        ms: reply.ms,
        ...parseReview(reply.text, proposers),
        ...(reply.error === undefined ? {} : { error: reply.error }),
      }
    }))
    const verdict = tally(votes, usable)
    chosen = usable.find(reply => reply.seat === verdict.winner)
  }
  const review = async (candidate: SeatReply) => await ask(reviewer,
    `Review this unit artifact against every acceptance condition. Do not claim tests ran unless evidence is provided. First line must be ACCEPT: yes only if the artifact satisfies all conditions; otherwise ACCEPT: no. Explain defects and any unverified conditions.\n${unitPrompt(options.query, task, done)}\nARTIFACT (${candidate.seat}):\n${candidate.text}`)
  let checked = chosen === undefined ? undefined : await review(chosen)
  const accepted = () => checked !== undefined && checked.error === undefined && /^ACCEPT:\s*yes\s*$/im.test(checked.text.split(/\r?\n/)[0] ?? '')
  if (!accepted() && options.profile === 'economy' && !options.signal?.aborted) {
    const fallback = paid.find(seat => seat.id !== reviewer.id) ?? paid[0]
    if (fallback !== undefined) {
      chosen = await produce(fallback)
      checked = chosen.error === undefined && chosen.text.trim() !== '' ? await review(chosen) : undefined
    }
  }
  // `accepted()` already implies a review exists; saying so again is what lets
  // the compiler see it, since the check lives behind a closure.
  if (chosen === undefined || checked === undefined || !accepted()) {
    return fail(`Unit did not pass paid review; escalation cap reached. ${checked?.error ?? checked?.text ?? chosen?.error ?? 'No usable candidate.'}`)
  }
  return { task, seat: chosen.seat, text: chosen.text, ms: elapsed, candidates, review: checked.text }
}
