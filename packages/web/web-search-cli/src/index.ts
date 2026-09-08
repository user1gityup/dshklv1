/**
 * Web search through an already-authenticated agent CLI.
 *
 * Claude Code and Codex both carry web search inside their subscription. Asking
 * one of them to search costs nothing beyond the plan already being paid for,
 * while a metered search key bills per query against a balance that can run dry
 * independently of everything else — which is exactly what happened here.
 *
 * The CLI is asked for JSON so the citations survive as structured sources
 * rather than being scraped back out of prose. Models comply with a strict
 * schema instruction most of the time, and the parser falls back to harvesting
 * bare URLs when they do not.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { RoutingSearchProvider } from './router.ts'
import { readPolicy } from './traffic.ts'
import type { Route } from './router.ts'
import type { TrafficPolicy } from './traffic.ts'

export { RoutingSearchProvider, byCost } from './router.ts'
export type { CostClass, Route, RouteAttempt } from './router.ts'
export { TrafficDirector, TRAFFIC_POLICIES, readPolicy } from './traffic.ts'
export type { Lane, LaneBlock, LaneStats, TrafficPolicy } from './traffic.ts'

/** One CLI lane's routing. */
export interface LaneOptions {
  /** Stable lane name, shown in diagnostics. */
  name?: string
  /** Executable to run; resolved against PATH, never through a shell. */
  command?: string
  /** Argv template. `{prompt}` is replaced with the search instruction. */
  args?: string[]
  /** Hard cap on one search on this lane, in milliseconds. */
  timeoutMs?: number
  /**
   * Flag that takes a path the CLI should write its final message to.
   *
   * Some CLIs print a banner, an echo of the prompt, and a running trace
   * before the answer. `codex exec` is one: its echoed prompt contains the
   * JSON schema we asked for, so scraping the first `{` to the last `}` out of
   * stdout spans the echo and the answer together and parses as nothing. Given
   * this flag the lane reads the answer from a file instead, and stdout is
   * only a fallback.
   */
  lastMessageFlag?: string
  /**
   * Searches this lane carries comfortably at once. A weight, not a limit —
   * see the traffic director.
   */
  capacity?: number
  /** Whether this lane participates. */
  enabled?: boolean
}

/** Provider configuration. */
export interface Config {
  /** Provider id, unique among registered search providers. */
  id?: string
  /**
   * Also route to OpenRouter when no CLI lane answers. Off by default so this
   * package stays a single-purpose provider unless routing is asked for.
   */
  routeToOpenRouter?: boolean
  /** Environment variable holding the OpenRouter key, when routing to it. */
  openRouterKeyEnv?: string
  /** Model OpenRouter uses for its web plugin. */
  openRouterModel?: string
  /** Executable to run on the first lane; resolved against PATH. */
  command?: string
  /** Argv template for the first lane. `{prompt}` is replaced. */
  args?: string[]
  /** Hard cap on one search, in milliseconds. */
  timeoutMs?: number
  /** Results requested when the caller sets no bound. */
  maxResults?: number
  /**
   * How work is spread across lanes of the same cost class.
   *
   * `balanced` sends each search to the least-loaded lane, which is what makes
   * concurrent lookups finish in parallel instead of queueing behind one
   * binary. `cheapest` keeps the older strict-order behaviour. `fastest`
   * orders by measured latency once lanes have a record.
   */
  trafficPolicy?: TrafficPolicy
  /**
   * CLI lanes, overriding the built-in Claude and Codex pair.
   *
   * A dict rather than an array: a nested array default materialises awkwardly
   * in the settings UI, and keying by lane name is what the diagnostics use
   * anyway.
   */
  lanes?: Record<string, LaneOptions>
}

/**
 * Working directory handed to every CLI lane.
 *
 * An agent CLI discovers project instruction files by walking up from its
 * working directory. Inheriting the host's cwd feeds the lane whatever
 * repository DSH happens to be running in, which costs seconds per call and
 * can steer the answer toward that project's instructions instead of the
 * search. A search lane needs no project context at all.
 */
const LANE_CWD = join(homedir(), '.dsh', 'search-cwd')

/** One lane with every value settled, ready to be turned into a route. */
export interface ResolvedLane {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly capacity: number
  readonly enabled: boolean
  readonly timeoutMs?: number | undefined
  readonly lastMessageFlag?: string | undefined
}

/**
 * The lanes a fresh install routes across.
 *
 * Two subscriptions the user already pays for, each reached through its own
 * authenticated CLI. Both are `included`, so the director spreads across them
 * rather than draining one — which is the whole point: a council round asking
 * for eight lookups runs them two at a time instead of eight in a row.
 */
export const DEFAULT_LANES: readonly ResolvedLane[] = [
  {
    name: 'claude-cli',
    command: 'claude',
    // Print mode grants no tool permissions by default; without this the CLI
    // returns an empty result set rather than searching.
    args: ['--allowedTools', 'WebSearch,WebFetch', '-p', '{prompt}'],
    capacity: 1,
    enabled: true,
  },
  {
    name: 'codex-cli',
    command: 'codex',
    // `tools.web_search` is off by default in `codex exec`; without it the
    // model answers from training data and cites nothing. `--ephemeral` keeps
    // a search from leaving a session file behind, and
    // `--skip-git-repo-check` is required because the lane's neutral working
    // directory is deliberately not a repository.
    args: [
      'exec',
      '-c', 'tools.web_search=true',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '{prompt}',
    ],
    capacity: 1,
    enabled: true,
  },
]

/** The flag each known CLI uses to write its final message to a file. */
const LAST_MESSAGE_FLAGS: Readonly<Record<string, string>> = {
  codex: '--output-last-message',
}

/** Loader schema. */
export const Config: z<Config> = z.object({
  id: z.string().default('claude-cli'),
  routeToOpenRouter: z.boolean().default(false),
  openRouterKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  openRouterModel: z.string().default('deepseek/deepseek-v4-flash'),
  command: z.string().default('claude'),
  args: z.array(z.string()).default(['--allowedTools', 'WebSearch,WebFetch', '-p', '{prompt}']),
  timeoutMs: z.natural().default(120_000),
  maxResults: z.natural().default(5),
  trafficPolicy: z.union([z.const('balanced'), z.const('cheapest'), z.const('fastest')]).default('balanced'),
  lanes: z.dict(z.object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    timeoutMs: z.natural(),
    lastMessageFlag: z.string(),
    capacity: z.natural(),
    enabled: z.boolean(),
  })),
})

/** Cordis plugin name. */
export const name = 'web-search-cli'
/** The web capability registry. */
export const inject = ['web']

/**
 * Windows spellings to try, most preferred first.
 *
 * `.exe` leads deliberately. Node's fix for CVE-2024-27980 refuses to spawn a
 * `.cmd` or `.bat` with `shell: false` and throws EINVAL, so a batch shim is
 * unusable on the safe spawn path. A real executable has no such restriction,
 * and npm-installed agent CLIs ship one beside their shims.
 */
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat', ''] as const


/**
 * Well-known real executables for agent CLIs installed through npm.
 *
 * npm puts `name`, `name.cmd`, and `name.ps1` on PATH but leaves the actual
 * binary inside the package. The shim cannot be spawned without a shell on
 * modern Node, so the binary is what we want — and it is findable, because npm
 * installs to a known layout.
 */
const NPM_BIN_PATHS: Readonly<Record<string, readonly string[]>> = {
  claude: ['@anthropic-ai/claude-code/bin/claude.exe'],
  // Codex moved its native binary into a per-platform sub-package; `bin/` now
  // holds only a JS wrapper. The old path stays last so an older install still
  // resolves.
  codex: [
    '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    '@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe',
    '@openai/codex/bin/codex.exe',
  ],
}

/** Directories npm uses for global packages on this platform. */
function npmRoots(): readonly string[] {
  const roots: string[] = []
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') roots.push(join(appData, 'npm', 'node_modules'))
  const prefix = process.env['npm_config_prefix']
  if (typeof prefix === 'string' && prefix !== '') roots.push(join(prefix, 'node_modules'))
  roots.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'))
  return roots
}

/**
 * Resolve a bare CLI name to a real executable when one can be found.
 *
 * Returns the input unchanged off Windows, or when nothing is known about the
 * name — the PATH candidates still get their turn.
 * @param command - the configured command name.
 * @returns an absolute path to a real executable, or undefined.
 */
export function resolveRealExecutable(command: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (command.includes('/') || command.includes('\\')) return undefined
  const relatives = NPM_BIN_PATHS[command.replace(/\.(cmd|exe|bat|ps1)$/i, '')]
  if (relatives === undefined) return undefined
  for (const root of npmRoots()) {
    for (const relative of relatives) {
      const candidate = join(root, ...relative.split('/'))
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not installed at this root; try the next.
      }
    }
  }
  return undefined
}

/**
 * Candidate spellings for an executable, most preferred first.
 *
 * A `.cmd` shim cannot be spawned without a shell on modern Node, and running
 * one through a shell would re-parse the prompt as a command line. Preferring
 * the real `.exe` avoids both problems.
 * @param command - the bare executable name.
 * @returns ordered candidates for this platform.
 */
export function executableCandidates(command: string): readonly string[] {
  if (process.platform !== 'win32') return [command]
  if (/\.(cmd|exe|bat|ps1|com)$/i.test(command)) return [command]
  const real = resolveRealExecutable(command)
  const spellings = WINDOWS_EXTENSIONS.map(extension => command + extension)
  return real === undefined ? spellings : [real, ...spellings]
}

/** The instruction handed to the CLI. */
function searchPrompt(query: string, maxResults: number): string {
  return `Search the web for the query below and report what you find.

Reply with ONLY a JSON object, no prose before or after, in exactly this shape:
{"summary": "<two or three sentences>", "sources": [{"url": "...", "title": "...", "snippet": "..."}]}

Return at most ${String(maxResults)} sources. Every source must be a page you actually consulted.

Query: ${query}`
}

/** Result of one child-process run. */
interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly spawnError?: string | undefined
}

/**
 * Make sure a lane's working directory exists.
 * @param dir - the configured directory.
 * @returns the same directory, or the host's cwd when it cannot be created.
 */
function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return process.cwd()
  }
}

/** Run one command without a shell, capturing its output. */
function runOnce(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
  cwd?: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let child
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        // The child gets NO stdin. Node's default is an open pipe nobody ever
        // writes to, and an agent CLI that accepts a piped prompt reads it:
        // `codex exec` prints "Reading additional input from stdin..." and
        // blocks until the timeout, so the lane looked merely slow rather than
        // misconfigured. Closing stdin is the EOF it is waiting for.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Created on demand: spawn throws ENOENT for a missing cwd, and a lane
        // must not depend on a directory someone remembered to make.
        ...cwd === undefined ? {} : { cwd: ensureDir(cwd) },
        // Layered over the parent environment rather than replacing it: the
        // child still needs PATH and the rest of it to start at all.
        ...env === undefined ? {} : { env: { ...process.env, ...env } },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      resolve({ stdout: '', stderr: '', code: null, spawnError: message })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ stdout, stderr, code: null, spawnError: `timed out after ${String(timeoutMs)}ms` })
    }, timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ stdout, stderr, code: null, spawnError: 'aborted' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => { finish({ stdout, stderr, code: null, spawnError: error.message }) })
    child.on('close', (code) => { finish({ stdout, stderr, code }) })
  })
}

/**
 * Parse the CLI's reply into a search result.
 *
 * Tolerant in three stages: a clean JSON object, a JSON object embedded in
 * prose, then bare URLs. A model that ignores the schema still yields usable
 * citations rather than an error.
 * @param text - raw stdout from the CLI.
 * @param maxResults - upper bound on returned sources.
 * @returns the parsed answer and citations.
 */
export function parseSearchReply(text: string, maxResults: number): WebSearchResult {
  const trimmed = text.trim()

  const fromJson = (candidate: string): WebSearchResult | undefined => {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { summary?: unknown; sources?: unknown }
    if (!Array.isArray(record.sources)) return undefined
    const sources: WebSearchSource[] = []
    for (const entry of record.sources) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as { url?: unknown; title?: unknown; snippet?: unknown }
      if (typeof row.url !== 'string' || row.url === '') continue
      sources.push({
        url: row.url,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(typeof row.snippet === 'string' ? { snippet: row.snippet } : {}),
      })
    }
    const summary = typeof record.summary === 'string' ? record.summary : undefined
    return {
      ...(summary === undefined || summary === '' ? {} : { content: summary }),
      sources: sources.slice(0, maxResults),
      truncated: sources.length > maxResults,
    }
  }

  const direct = fromJson(trimmed)
  if (direct !== undefined) return direct

  // A model that wrapped the JSON in prose or a fence still carries one object.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const embedded = fromJson(trimmed.slice(first, last + 1))
    if (embedded !== undefined) return embedded
  }

  // Last resort: harvest bare URLs so the search still cites something.
  const urls = [...new Set(trimmed.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [])]
  return {
    ...(trimmed === '' ? {} : { content: trimmed.slice(0, 4000) }),
    sources: urls.slice(0, maxResults).map(url => ({ url })),
    truncated: urls.length > maxResults,
  }
}

/** Extras a lane may declare beyond the command line itself. */
export interface CliSearchOptions {
  /** Flag taking a path the CLI writes its final message to. */
  readonly lastMessageFlag?: string | undefined
  /** Working directory for the child, so it discovers no project context. */
  readonly cwd?: string | undefined
  /** Environment layered over the parent process environment. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/**
 * Read a CLI's final message from the file it was told to write.
 *
 * Returns undefined when the file is missing or empty, so the caller falls
 * back to stdout rather than treating a silent CLI as an empty answer.
 * @param path - the file the CLI was given, when it was given one.
 * @returns the message, or undefined.
 */
function readLastMessage(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Search performed by an already-authenticated agent CLI. */
export class CliSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly command: string
  private readonly args: readonly string[]
  private readonly timeoutMs: number
  private readonly maxResults: number
  private readonly options: CliSearchOptions

  constructor(
    id: string,
    command: string,
    args: readonly string[],
    timeoutMs: number,
    maxResults: number,
    options: CliSearchOptions = {},
  ) {
    this.id = id
    this.command = command
    this.args = args
    this.timeoutMs = timeoutMs
    this.maxResults = maxResults
    this.options = options
  }

  /**
   * Whether a command is configured.
   *
   * Deliberately not a probe: the seam calls this on every search, and neither
   * "installed" nor "logged in" can be established without spawning a process.
   * A CLI that is present but unauthenticated surfaces as a search failure with
   * the CLI's own message, which is more useful than a silent unavailability.
   * @returns true when a command is configured.
   */
  available(): boolean {
    return this.command !== ''
  }

  /**
   * Run one search by asking the CLI.
   * @param request - the query and result bound.
   * @param signal - cancellation from the tool execution.
   * @returns the answer and its citations.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const max = request.maxResults ?? this.maxResults
    const prompt = searchPrompt(request.query, max)
    const base = this.args.map(entry => (entry === '{prompt}' ? prompt : entry))

    // A CLI that can write its final message to a file gets a private one, so
    // its banner and its echo of the prompt never reach the parser.
    const flag = this.options.lastMessageFlag
    const scratch = flag === undefined ? undefined : mkdtempSync(join(tmpdir(), 'dsh-search-'))
    const replyFile = scratch === undefined ? undefined : join(scratch, 'reply.txt')
    const argv = flag === undefined || replyFile === undefined ? base : [...base, flag, replyFile]

    try {
      const lastError = `${this.command}: not installed or not on PATH`
      for (const candidate of executableCandidates(this.command)) {
        const result = await runOnce(candidate, argv, signal, this.timeoutMs, this.options.env, this.options.cwd)
        // EINVAL is Node refusing to spawn a batch shim without a shell; treat
        // it as "wrong spelling" so the next candidate gets a turn.
        if (result.spawnError !== undefined && /ENOENT|EINVAL|not recognized|cannot find/i.test(result.spawnError)) {
          continue
        }
        if (result.spawnError !== undefined) throw new Error(`web-search-cli: ${result.spawnError}`)
        if (result.code !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`
          throw new Error(`web-search-cli: ${detail.slice(0, 300)}`)
        }
        return parseSearchReply(readLastMessage(replyFile) ?? result.stdout, max)
      }
      throw new Error(`web-search-cli: ${lastError}`)
    } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    }
  }
}

/** Search through OpenRouter's web plugin, used as the metered route. */
class OpenRouterRoute implements WebSearchProvider {
  readonly id = 'openrouter'
  private readonly key: () => string | undefined
  private readonly model: string

  constructor(key: () => string | undefined, model: string) {
    this.key = key
    this.model = model
  }

  /** @returns true when a key is configured. */
  available(): boolean {
    const key = this.key()
    return typeof key === 'string' && key !== ''
  }

  /**
   * Run one search through OpenRouter's web plugin.
   * @param request - the query and result bound.
   * @param signal - cancellation from the tool execution.
   * @returns the answer and its citations.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const key = this.key()
    if (key === undefined || key === '') throw new Error('openrouter: no API key')
    const max = request.maxResults ?? 5
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: `Search the web and summarise what you find, citing pages.\n\nQuery: ${request.query}` }],
        plugins: [{ id: 'web', max_results: max }],
      }),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`openrouter: HTTP ${String(response.status)} ${body.slice(0, 160)}`.trim())
    }
    const body = await response.json() as { choices?: readonly { message?: { content?: unknown; annotations?: unknown } }[] }
    const message = body.choices?.[0]?.message
    const content = typeof message?.content === 'string' ? message.content : undefined
    const sources: WebSearchSource[] = []
    const annotations = message?.annotations
    if (Array.isArray(annotations)) {
      for (const entry of annotations) {
        const citation = (entry as { url_citation?: { url?: unknown; title?: unknown; content?: unknown } }).url_citation
        if (typeof citation?.url !== 'string') continue
        sources.push({
          url: citation.url,
          ...(typeof citation.title === 'string' ? { title: citation.title } : {}),
          ...(typeof citation.content === 'string' ? { snippet: citation.content } : {}),
        })
      }
    }
    return {
      ...(content === undefined || content === '' ? {} : { content }),
      sources: sources.slice(0, max),
      truncated: sources.length > max,
    }
  }
}

/** Read the OpenRouter balance, so a dry account is skipped before spending. */
async function openRouterBalance(key: () => string | undefined): Promise<number | undefined> {
  const value = key()
  if (value === undefined || value === '') return undefined
  try {
    const response = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${value}` },
    })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } }
    const purchased = body.data?.total_credits
    const used = body.data?.total_usage
    if (typeof purchased !== 'number' || typeof used !== 'number') return undefined
    return purchased - used
  } catch {
    return undefined
  }
}

/**
 * Resolve the configured CLI lanes.
 *
 * With nothing configured this is the built-in Claude and Codex pair, with the
 * first lane's command and argv still honouring the older top-level `command`
 * and `args` settings. A `lanes` dict replaces the pair outright.
 * @param config - the plugin configuration.
 * @returns the lanes to route across, in declaration order.
 */
export function resolveLanes(config: Config): readonly Route[] {
  const configured: readonly ResolvedLane[] = config.lanes === undefined || Object.keys(config.lanes).length === 0
    ? DEFAULT_LANES.map((lane, index) => (
      // The first lane keeps answering to the older flat settings, so an
      // existing install that pinned a command does not silently change CLI.
      index !== 0
        ? lane
        : {
          ...lane,
          ...config.command === undefined ? {} : { command: config.command },
          ...config.args === undefined ? {} : { args: config.args },
        }
    ))
    : Object.entries(config.lanes).map(([key, lane]) => ({
      name: lane.name ?? key,
      command: lane.command ?? key,
      args: lane.args ?? ['{prompt}'],
      capacity: lane.capacity ?? 1,
      enabled: lane.enabled !== false,
      ...lane.timeoutMs === undefined ? {} : { timeoutMs: lane.timeoutMs },
      ...lane.lastMessageFlag === undefined ? {} : { lastMessageFlag: lane.lastMessageFlag },
    }))

  const routes: Route[] = []
  for (const lane of configured) {
    if (!lane.enabled) continue
    const bare = lane.command.replace(/\.(cmd|exe|bat|ps1)$/i, '')
    const lastMessageFlag = lane.lastMessageFlag ?? LAST_MESSAGE_FLAGS[bare]
    routes.push({
      name: lane.name,
      cost: 'included',
      capacity: lane.capacity,
      provider: new CliSearchProvider(
        lane.name,
        lane.command,
        lane.args,
        lane.timeoutMs ?? config.timeoutMs ?? 120_000,
        config.maxResults ?? 5,
        {
          cwd: LANE_CWD,
          ...lastMessageFlag === undefined ? {} : { lastMessageFlag },
        },
      ),
    })
  }
  return routes
}

/**
 * Register the search provider.
 *
 * Always ONE registration: the seam refuses to choose between two usable
 * providers, so neither fallback nor load spreading can be expressed as
 * several registrations. The routing provider owns every lane and the traffic
 * director decides between them.
 * @param ctx - host context carrying the web capability registry.
 * @param config - lanes, traffic policy, limits, and metered routing.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const lanes = [...resolveLanes(config)]

  if (config.routeToOpenRouter === true) {
    const variable = config.openRouterKeyEnv ?? 'OPENROUTER_API_KEY'
    const key = (): string | undefined => {
      const fromEnv = process.env[variable]
      return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
    }
    lanes.push({
      name: 'openrouter',
      cost: 'metered',
      provider: new OpenRouterRoute(key, config.openRouterModel ?? 'deepseek/deepseek-v4-flash'),
      balanceUsd: () => openRouterBalance(key),
    })
  }

  // A single CLI lane and no metered route is the degenerate case: routing it
  // would only add a layer, so register the provider itself.
  const only = lanes[0]
  if (lanes.length === 1 && only !== undefined) {
    ctx.web.registerSearchProvider(only.provider)
    return
  }
  ctx.web.registerSearchProvider(
    new RoutingSearchProvider(config.id ?? 'router', lanes, readPolicy(config.trafficPolicy)),
  )
}
