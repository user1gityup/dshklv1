/**
 * Turning a council decision into an executable task graph.
 *
 * The council settles *what to do*; a swarm needs *who does which part, in
 * what order*. That translation is its own step, deliberately separate from
 * both: the council's output is prose, and the team's task board wants named
 * units with dependencies. Nothing may execute straight off a winning draft.
 *
 * Two modes, chosen per run rather than configured once, because the right
 * one depends on the job:
 *
 *  - `single` — one seat parses the agreed answer. Cheap, and usually enough,
 *    since the council has already agreed the approach.
 *  - `council` — every seat proposes a decomposition and they vote. Costs a
 *    full extra round; worth it when the split itself is the hard part.
 */

/** One unit of parallelisable work. */
export interface SubTask {
  /** Stable lower-kebab-case identifier, referenced by dependants. */
  readonly id: string
  /** One-line statement of the unit. */
  readonly title: string
  /** Everything a teammate needs to do it without further context. */
  readonly detail: string
  /** Ids that must finish first. Empty means it can start immediately. */
  readonly dependsOn: readonly string[]
  /** Subagent provider suggested for this unit, when one is a better fit. */
  readonly provider?: string | undefined
  readonly tier?: 'ui' | 'general' | undefined
  readonly acceptance?: readonly string[] | undefined
  readonly files?: readonly string[] | undefined
}

/** How the decomposition is produced. */
export type DecomposeMode = 'single' | 'council'

/** A parsed decomposition and anything wrong with it. */
export interface Decomposition {
  readonly tasks: readonly SubTask[]
  /** Problems that make the graph unsafe to execute. Empty means usable. */
  readonly problems: readonly string[]
}

/** Ceiling on units of work in one decomposition. */
const MAX_TASKS = 32

/**
 * Prompt asking for a decomposition of an already-agreed answer.
 * @param query - the original question.
 * @param answer - the answer the council settled on.
 * @param providers - provider names a teammate may run on.
 * @returns the prompt.
 */
export function decomposePrompt(
  query: string,
  answer: string,
  providers: readonly string[],
): string {
  return `An approach has been agreed. Break it into units of work that can run in parallel.

${shape(providers)}

ORIGINAL REQUEST:
${query}

AGREED APPROACH:
${answer}`
}

/**
 * Prompt asking for a decomposition of a request no council has discussed.
 *
 * The council path decomposes an answer the seats already agreed on. This one
 * has no such answer: the user asked for work directly and wants it split and
 * run. The split therefore has to be read out of the request itself, which is
 * why the prompt says so rather than leaving the model to infer an approach
 * and quietly decompose something nobody asked for.
 * @param query - what the user asked for.
 * @param providers - worker names a unit may name.
 * @returns the prompt.
 */
export function directDecomposePrompt(
  query: string,
  providers: readonly string[],
  profile?: 'economy' | 'fastest',
): string {
  return `Break the request below into units of work that can run in parallel.

No approach has been agreed and no plan exists yet. Read the request as it
stands and split the work it actually asks for. Do not invent scope it does
not ask for, and do not answer it here — this step only divides it up.

${shape(providers)}
${profile === undefined ? '' : `\nAlso include acceptance (nonempty array of verifiable conditions), files (array of target paths), and tier (ui or general) on every unit. ${profile === 'economy' ? 'Use few large, tightly specified units. Each unit will be contested by free workers and reviewed by paid seats.' : 'Maximize independent wave width. Each unit gets one paid worker. Identify UI units explicitly.'}`}

REQUEST:
${query}`
}

/**
 * The reply shape and the rules, shared by both decomposition prompts.
 *
 * One copy because the two prompts differ only in what they are decomposing:
 * a wording fix applied to one and not the other is the kind of drift that
 * shows up as a graph that parses from the council path and not the direct
 * one.
 * @param providers - worker names a unit may name.
 * @returns the shared section of the prompt.
 */
function shape(providers: readonly string[]): string {
  const list = providers.length === 0 ? '(none registered)' : providers.join(', ')
  return `Reply with ONE fenced json block and nothing else. It must be an array of objects with exactly these fields:
  id        lower-kebab-case, unique, stable
  title     one line
  detail    everything the worker needs, assuming it has NOT read this conversation
  dependsOn array of ids that must finish first; [] when it can start immediately
  provider  optional; one of: ${list}

Rules that matter more than completeness:
- Units that can run at the same time MUST NOT depend on each other.
- Two units must never edit the same file. Split by file or by layer, not by task type.
- A graph where every unit depends on another is broken: something must be startable.
- Prefer fewer, larger units over many tiny ones.
- At most ${String(MAX_TASKS)} units.`
}

/**
 * Pull the first JSON array out of a reply, tolerating surrounding prose.
 * @param text - the model's reply.
 * @returns the raw parsed value, or undefined when none is found.
 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Coerce one raw entry into a SubTask.
 * @param raw - one array element from the model's reply.
 * @returns the task, or undefined when it lacks an id or title.
 */
function toTask(raw: unknown): SubTask | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const id = typeof row['id'] === 'string' ? row['id'].trim() : ''
  const title = typeof row['title'] === 'string' ? row['title'].trim() : ''
  if (id === '' || title === '') return undefined
  const detail = typeof row['detail'] === 'string' ? row['detail'].trim() : ''
  const depends = Array.isArray(row['dependsOn'])
    ? row['dependsOn'].filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim())
    : []
  const rawProvider = row['provider']
  const provider = typeof rawProvider === 'string' && rawProvider.trim() !== ''
    ? rawProvider.trim()
    : undefined
  const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(entry => typeof entry === 'string') ? (value as string[]).map(entry => entry.trim()).filter(Boolean) : undefined
  return { id, title, detail, dependsOn: depends, ...provider === undefined ? {} : { provider },
    ...(row['tier'] === 'ui' || row['tier'] === 'general' ? { tier: row['tier'] } : {}),
    ...(strings(row['acceptance']) === undefined ? {} : { acceptance: strings(row['acceptance']) }),
    ...(strings(row['files']) === undefined ? {} : { files: strings(row['files']) }),
  }
}

/**
 * Check a task graph for the faults that make it unsafe to run.
 *
 * Reported rather than thrown: a partly-wrong decomposition is worth showing
 * to the user alongside what is wrong with it, so they can reject it knowingly
 * instead of watching a swarm deadlock.
 * @param tasks - the parsed units.
 * @returns human-readable problems; empty when the graph is executable.
 */
export function validateGraph(tasks: readonly SubTask[], profile?: 'economy' | 'fastest'): readonly string[] {
  const problems: string[] = []
  if (tasks.length === 0) return ['no units of work were produced']
  if (tasks.length > MAX_TASKS) {
    problems.push(`${String(tasks.length)} units exceeds the ${String(MAX_TASKS)} unit ceiling`)
  }

  const ids = new Set<string>()
  const owners = new Map<string, string>()
  for (const task of tasks) {
    if (profile === 'economy' && (task.acceptance === undefined || task.acceptance.length === 0 || task.acceptance.some(entry => entry.trim() === ''))) problems.push(`unit "${task.id}" needs acceptance conditions for economy mode`)
    if (ids.has(task.id)) problems.push(`duplicate unit id "${task.id}"`)
    ids.add(task.id)
    if (profile !== undefined) for (const file of task.files ?? []) {
      const owner = owners.get(file)
      if (owner !== undefined && owner !== task.id) problems.push(`units "${owner}" and "${task.id}" both target ${file}`)
      owners.set(file, task.id)
    }
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) problems.push(`unit "${task.id}" depends on itself`)
      else if (!ids.has(dep)) problems.push(`unit "${task.id}" depends on "${dep}", which does not exist`)
    }
  }
  if (!tasks.some(task => task.dependsOn.length === 0)) {
    problems.push('every unit depends on another, so nothing can start')
  }

  // Cycle detection by repeated removal of satisfiable units: whatever cannot
  // be removed is in, or behind, a cycle.
  const remaining = new Map(tasks.map(task => [task.id, [...task.dependsOn]]))
  let progressed = true
  while (progressed && remaining.size > 0) {
    progressed = false
    for (const [id, deps] of [...remaining]) {
      if (deps.every(dep => !remaining.has(dep))) {
        remaining.delete(id)
        progressed = true
      }
    }
  }
  if (remaining.size > 0) {
    problems.push(`circular dependency among: ${[...remaining.keys()].join(', ')}`)
  }
  return problems
}

/**
 * Parse a decomposition reply into a validated task graph.
 * @param text - the model's reply.
 * @returns the tasks and any problems found.
 */
export function parseDecomposition(text: string): Decomposition {
  const raw = extractJson(text)
  if (!Array.isArray(raw)) {
    return { tasks: [], problems: ['the reply contained no readable json array of units'] }
  }
  const tasks: SubTask[] = []
  let dropped = 0
  for (const entry of raw) {
    const task = toTask(entry)
    if (task === undefined) dropped += 1
    else tasks.push(task)
  }
  const problems = [...validateGraph(tasks)]
  if (dropped > 0) {
    problems.push(`${String(dropped)} ${dropped === 1 ? 'entry was' : 'entries were'} missing an id or title and were discarded`)
  }
  return { tasks, problems }
}

/**
 * Group units into waves that may run concurrently.
 * @param tasks - a validated task graph.
 * @returns waves, each safe to run in parallel, in execution order.
 */
export function executionWaves(tasks: readonly SubTask[]): readonly (readonly SubTask[])[] {
  const waves: SubTask[][] = []
  const done = new Set<string>()
  const left = new Map(tasks.map(task => [task.id, task]))
  while (left.size > 0) {
    const ready = [...left.values()].filter(task => task.dependsOn.every(dep => done.has(dep)))
    // A validated graph cannot stall; guard anyway rather than spin forever.
    if (ready.length === 0) break
    waves.push(ready)
    for (const task of ready) {
      done.add(task.id)
      left.delete(task.id)
    }
  }
  return waves
}
