/**
 * Seat definitions and the two transports that back them.
 *
 * Two seats are driven by an already-authenticated local CLI, and two by the
 * OpenRouter HTTP API. The council never handles a CLI seat's credentials: the
 * user authenticated that tool once, and the child process inherits the
 * session. Only the OpenRouter transport needs a key, and it reads one from the
 * environment rather than accepting it as an argument.
 */

import { spawn } from 'node:child_process'
import { describeError } from './errors.ts'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SeatId } from './colors.ts'

/** How a seat reaches its model. */
export type SeatTransport = 'cli' | 'openrouter'

/** One seat's resolved routing. */
export interface SeatConfig {
  /** Stable seat identity, also the colour key. */
  readonly id: SeatId
  /** Human-facing name used in the report and in vote text. */
  readonly name: string
  /** Which transport carries this seat. */
  readonly transport: SeatTransport
  /**
   * For `cli`: the executable to run. For `openrouter`: unused.
   * Resolved against PATH by the platform, never through a shell.
   */
  readonly command?: string | undefined
  /**
   * For `cli`: argv template. The literal token `{prompt}` is replaced by the
   * prompt; every other entry is passed through verbatim. Keeping the prompt a
   * distinct argv entry is what makes shell-free spawning safe.
   */
  readonly args?: readonly string[] | undefined
  /**
   * Seat-specific hard cap, overriding the run's timeout.
   *
   * One global timeout cannot serve a paid seat and a free one equally: a
   * free-tier provider retries through 529s and is legitimately slower, so a
   * limit set for a fast seat kills a slow one mid-answer while a limit set
   * for the slow one lets a hung fast seat stall the round.
   */
  readonly timeoutMs?: number | undefined
  /**
   * For `cli`: environment layered over the parent process environment.
   *
   * This is what lets one CLI serve as two independent seats: a seat can point
   * at a different backend and keep its own config directory, so it shares
   * neither credentials nor session state with a seat running on the user's
   * own subscription.
   */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** For `openrouter`: the model identifier to request. */
  readonly model?: string | undefined
  /**
   * For `cli`: a flag that takes a context file path. When set and a memory
   * digest exists, the flag and path are appended to argv, which is far
   * cheaper than pasting the digest into every prompt.
   */
  readonly contextFileFlag?: string | undefined
  /** Whether this seat participates. */
  readonly enabled: boolean
}

/**
 * What a provider reported about one call's consumption.
 *
 * Only metered transports populate this. A CLI seat bills a separate
 * subscription that this process cannot observe, so its usage stays undefined
 * rather than being guessed — an invented number would corrupt any budget
 * built on this history.
 */
export interface SeatUsage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  /** Cost in USD, as reported by the provider. */
  readonly costUsd?: number | undefined
  /** Model that actually served the request. */
  readonly model?: string | undefined
}

/** A seat's answer, or the reason it produced none. */
export interface SeatReply {
  /** URLs the provider reports this seat actually consulted, when it searched. */
  readonly citedUrls?: readonly string[] | undefined
  readonly seat: SeatId
  /** Model text, empty when `error` is set. */
  readonly text: string
  /** Failure description; `undefined` on success. */
  readonly error?: string | undefined
  /** Wall time spent on the call. */
  readonly ms: number
  /** Provider-reported consumption, when the transport reports any. */
  readonly usage?: SeatUsage | undefined
}

/** Defaults chosen so a fresh install runs without configuration. */
export const DEFAULT_SEATS: readonly SeatConfig[] = [
  {
    id: 'claude',
    name: 'Claude',
    transport: 'cli',
    command: 'claude',
    // `-p` is Claude Code's non-interactive print mode.
    // Print mode grants no tool permissions by default, so a bare `-p` seat
    // cannot search, read, or run anything. The allowlist is explicit rather
    // than --dangerously-skip-permissions: this seat should read and search,
    // not write to the workspace.
    args: ['--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep', '-p', '{prompt}'],
    contextFileFlag: '--append-system-prompt-file',
    enabled: true,
  },
  {
    id: 'free-claude',
    name: 'Free Claude',
    transport: 'cli',
    command: 'claude',
    // The same binary as the `claude` seat, deliberately run as a DIFFERENT
    // instance of itself. Two things make it separate rather than a duplicate:
    //
    //  - ANTHROPIC_BASE_URL points at a local Free Claude Code proxy, so the
    //    request never reaches Anthropic and never draws on the subscription.
    //  - CLAUDE_CONFIG_DIR gives it its own config, credentials, and session
    //    state. Without this the two seats would share ~/.claude, and the free
    //    seat could silently fall back to the logged-in subscription — the
    //    exact outcome it exists to avoid.
    //
    // Off by default: it needs the proxy running, and a seat that fails on
    // every run of a fresh install is worse than one the user turns on.
    args: ['--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep', '-p', '{prompt}'],
    contextFileFlag: '--append-system-prompt-file',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8082',
      ANTHROPIC_AUTH_TOKEN: 'freecc',
      CLAUDE_CONFIG_DIR: join(homedir(), '.dsh', 'free-claude-home'),
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_FEEDBACK_COMMAND: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    // Free-tier providers retry through 529s before answering. Measured: a
    // council-sized prompt spent 84s being refused capacity before giving up,
    // and the run's 180s default killed it mid-retry. This buys it the room to
    // fall through to another provider rather than fail the round.
    timeoutMs: 420_000,
    enabled: false,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    transport: 'cli',
    command: 'codex',
    args: ['exec', '{prompt}'],
    enabled: true,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    transport: 'openrouter',
    model: 'moonshotai/kimi-k2',
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek v4',
    transport: 'openrouter',
    model: 'deepseek/deepseek-v4-pro',
    enabled: true,
  },
]

/**
 * Windows spellings to try, most preferred first.
 *
 * `.exe` leads deliberately. Node's fix for CVE-2024-27980 refuses to spawn a
 * `.cmd` or `.bat` with `shell: false` and throws EINVAL, so a batch shim is
 * unusable on the safe spawn path. A real executable has no such restriction,
 * and npm-installed agent CLIs ship one beside their shims.
 */
/**
 * Output cap sent with every OpenRouter request.
 *
 * Omitting `max_tokens` makes OpenRouter ask for the model's entire context
 * window. A provider whose real ceiling is lower than the advertised context
 * then rejects the call outright: Novita serves Kimi K2 with a 98304 cap
 * against a 100352 context, so every uncapped request 400s before the model
 * ever sees the prompt. An explicit cap is the difference between a seat that
 * answers and a seat that never does.
 *
 * Set generously — no realistic council draft approaches this.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000

/**
 * Web results requested per seat when live search is on.
 *
 * OpenRouter bills the web plugin per result, so this is a cost dial, not a
 * quality dial past the first few: five gives a seat enough to check a claim
 * without turning every draft into a research bill.
 */
export const DEFAULT_WEB_MAX_RESULTS = 5

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
  codex: ['@openai/codex/bin/codex.exe'],
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
  const spellings = WINDOWS_EXTENSIONS.map(ext => command + ext)
  return real === undefined ? spellings : [real, ...spellings]
}

/** Result of one child-process run. */
interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly spawnError?: string | undefined
}

/**
 * Run one command without a shell, capturing its output.
 * @param command - executable name or path.
 * @param args - fully-formed argv, already substituted.
 * @param signal - abort signal from the tool execution.
 * @param timeoutMs - hard cap on the child's lifetime.
 * @returns captured streams and exit status.
 */
function runOnce(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env: Readonly<Record<string, string>> | undefined,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    // `shell: false` is the security boundary: the prompt is argv data, never
    // a fragment of a command line the shell would re-parse.
    //
    // spawn throws SYNCHRONOUSLY for a batch shim on Windows (EINVAL, from the
    // CVE-2024-27980 fix), so this cannot rely on the 'error' event alone.
    let child
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        // Layered over the parent environment rather than replacing it: the
        // child still needs PATH and the rest of it to start at all.
        ...env === undefined ? {} : { env: { ...process.env, ...env } },
      })
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, spawnError: describeError(error) })
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
      finish({ stdout, stderr, code: null, spawnError: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ stdout, stderr, code: null, spawnError: 'aborted' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      finish({ stdout, stderr, code: null, spawnError: error.message })
    })
    child.on('close', (code) => { finish({ stdout, stderr, code }) })
  })
}

/**
 * Ask a CLI-backed seat, trying each platform candidate until one starts.
 *
 * A missing executable is reported as a seat failure rather than thrown: one
 * uninstalled CLI must not collapse the whole council.
 * @param seat - the seat's resolved routing.
 * @param prompt - the full prompt text.
 * @param signal - abort signal from the tool execution.
 * @param timeoutMs - hard cap per seat.
 * @returns the seat's reply or its failure.
 */
export async function askCliSeat(
  seat: SeatConfig,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  contextFile?: string | undefined,
): Promise<SeatReply> {
  const started = Date.now()
  const command = seat.command
  if (command === undefined || command === '') {
    return { seat: seat.id, text: '', error: 'no command configured', ms: 0 }
  }
  const template = seat.args ?? ['{prompt}']
  const base = template.map(entry => (entry === '{prompt}' ? prompt : entry))
  // A CLI that can read a context file gets one; the digest never enters the
  // prompt for those seats, so shared memory costs no prompt construction.
  const args = contextFile !== undefined && seat.contextFileFlag !== undefined
    ? [...base, seat.contextFileFlag, contextFile]
    : base
  let lastError = 'not found'
  for (const candidate of executableCandidates(command)) {
    const result = await runOnce(candidate, args, signal, timeoutMs, seat.env)
    // ENOENT means this spelling does not exist; try the next candidate.
    // EINVAL is Node refusing to spawn a batch shim without a shell; treat it
    // as "wrong spelling" so the next candidate gets a turn.
    if (result.spawnError !== undefined && /ENOENT|EINVAL|not recognized|cannot find/i.test(result.spawnError)) {
      lastError = `${command}: not installed or not on PATH`
      continue
    }
    const ms = Date.now() - started
    if (result.spawnError !== undefined) {
      return { seat: seat.id, text: result.stdout.trim(), error: result.spawnError, ms }
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`
      return { seat: seat.id, text: result.stdout.trim(), error: detail.slice(0, 500), ms }
    }
    return { seat: seat.id, text: result.stdout.trim(), ms }
  }
  return { seat: seat.id, text: '', error: lastError, ms: Date.now() - started }
}

/** OpenRouter chat-completions endpoint. */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Ask an OpenRouter-backed seat.
 * @param seat - the seat's resolved routing.
 * @param prompt - the full prompt text.
 * @param apiKey - OpenRouter key resolved by the caller.
 * @param signal - abort signal from the tool execution.
 * @param timeoutMs - hard cap per seat.
 * @returns the seat's reply or its failure.
 */
export async function askOpenRouterSeat(
  seat: SeatConfig,
  prompt: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
  webMaxResults?: number | undefined,
): Promise<SeatReply> {
  const started = Date.now()
  if (apiKey === undefined || apiKey === '') {
    return { seat: seat.id, text: '', error: 'no OpenRouter API key available', ms: 0 }
  }
  const model = seat.model
  if (model === undefined || model === '') {
    return { seat: seat.id, text: '', error: 'no model configured', ms: 0 }
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        // Live search, when the caller asks for it. This is what lets a
        // hosted seat check a current fact instead of answering from training
        // data — the gap that shared evidence and citation auditing exist to
        // work around. OpenRouter bills per result, so it is opt-in.
        ...webMaxResults === undefined || webMaxResults <= 0
          ? {}
          : { plugins: [{ id: 'web', max_results: webMaxResults }] },
      }),
      signal: composite,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        seat: seat.id,
        text: '',
        error: `HTTP ${String(response.status)} ${response.statusText} ${body.slice(0, 300)}`.trim(),
        ms: Date.now() - started,
      }
    }
    const body = await response.json() as {
      model?: unknown
      choices?: readonly { message?: { content?: unknown; reasoning?: unknown; annotations?: unknown } }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
    }
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const usage: SeatUsage = {
      inputTokens: num(body.usage?.prompt_tokens),
      outputTokens: num(body.usage?.completion_tokens),
      // OpenRouter returns the charged amount per request; this is the only
      // trustworthy cost figure available, so it is recorded verbatim.
      costUsd: num(body.usage?.cost),
      model: typeof body.model === 'string' ? body.model : model,
    }
    const first = body.choices?.[0]?.message
    const content = typeof first?.content === 'string' ? first.content : ''
    // Reasoning-only replies (empty content, non-empty reasoning) still carry
    // an answer worth reporting rather than discarding as blank.
    const reasoning = typeof first?.reasoning === 'string' ? first.reasoning : ''
    const text = (content || reasoning).trim()
    if (text === '') {
      return { seat: seat.id, text: '', error: 'empty response', ms: Date.now() - started, usage }
    }
    // Surface what the seat actually consulted. A seat that searched and a
    // seat that recalled look identical in the text; the citations are the
    // only way the audit can tell them apart.
    const cited: string[] = []
    const annotations = (first as { annotations?: unknown } | undefined)?.annotations
    if (Array.isArray(annotations)) {
      for (const entry of annotations) {
        const citation = (entry as { url_citation?: { url?: unknown } }).url_citation
        if (typeof citation?.url === 'string') cited.push(citation.url)
      }
    }
    return {
      seat: seat.id,
      text,
      ms: Date.now() - started,
      usage,
      ...cited.length === 0 ? {} : { citedUrls: cited },
    }
  } catch (error) {
    return { seat: seat.id, text: '', error: describeError(error), ms: Date.now() - started }
  }
}

/**
 * Ask one seat over whichever transport it declares.
 * @param seat - the seat's resolved routing.
 * @param prompt - the full prompt text.
 * @param apiKey - OpenRouter key, used only by OpenRouter seats.
 * @param signal - abort signal from the tool execution.
 * @param timeoutMs - hard cap per seat.
 * @returns the seat's reply or its failure.
 */
export function askSeat(
  seat: SeatConfig,
  prompt: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  memory?: { file?: string | undefined; text?: string | undefined } | undefined,
  webMaxResults?: number | undefined,
): Promise<SeatReply> {
  // A seat's own cap wins over the run's, in both directions.
  const cap = seat.timeoutMs ?? timeoutMs
  if (seat.transport === 'cli') {
    return askCliSeat(seat, prompt, signal, cap, memory?.file)
  }
  // An OpenRouter seat has no filesystem, so shared memory has to ride in the
  // prompt. That is the cost of including a hosted model in the council.
  const withMemory = memory?.text === undefined || memory.text === ''
    ? prompt
    : `${memory.text}\n\n---\n\n${prompt}`
  return askOpenRouterSeat(seat, withMemory, apiKey, signal, cap, undefined, webMaxResults)
}
