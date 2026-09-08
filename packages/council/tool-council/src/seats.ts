/**
 * Seat definitions and the two transports that back them.
 *
 * Some seats are driven by an already-authenticated local CLI, the rest by an
 * OpenAI-compatible HTTP endpoint. The council never handles a CLI seat's
 * credentials: the user authenticated that tool once, and the child process
 * inherits the session. Only a seat calling OpenRouter itself needs a key, and
 * it reads one from the environment rather than accepting it as an argument; a
 * seat pointed at a local proxy needs none, because the proxy holds the key.
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { describeError } from './errors.ts'
import { mkdirSync, statSync } from 'node:fs'
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
   * For `cli`: what replaces the `{prompt}` entry when the prompt is delivered
   * on stdin instead of argv, or omitted when the CLI wants the entry gone.
   *
   * A council prompt grows with the round: the review prompt carries every
   * seat's full draft, and a five-seat round on a researched question passed
   * 32767 characters — the Windows command-line limit — so `spawn` failed with
   * ENAMETOOLONG and all three CLI seats lost their vote at once. Delivering
   * the same text on stdin has no such limit. `codex exec` wants `-` to mean
   * "read the prompt from stdin"; `claude -p` reads stdin whenever no prompt
   * argument follows, so its entry is dropped instead.
   */
  readonly stdinPromptArg?: string | undefined
  /**
   * For `openrouter`: how long the streamed answer may go silent before the
   * seat gives up, overriding {@link DEFAULT_STREAM_IDLE_MS}.
   */
  readonly idleMs?: number | undefined
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
   * For `openrouter`: chat-completions endpoint, overriding OpenRouter's own.
   *
   * The wire format is unchanged — an OpenAI-compatible `/chat/completions`
   * that streams SSE — so only the URL differs. This is what lets a seat run
   * against a local proxy without inventing a third transport: a dozen call
   * sites branch on `transport === 'openrouter'` for prompt shaping, capacity
   * and estimates, and a new transport value would silently miss some.
   */
  readonly baseUrl?: string | undefined
  /**
   * This seat costs nothing per token.
   *
   * Free is not the same as unpriced. An OpenRouter seat whose model carries
   * no price row is of *unknown* cost, and the panel says so; a seat marked
   * free is known to be zero, so it stays out of the metered blend entirely
   * and the swarm sorts it beside the subscription seats rather than after
   * them.
   */
  readonly free?: boolean | undefined
  /**
   * For `cli`: a flag that takes a context file path. When set and a memory
   * digest exists, the flag and path are appended to argv, which is far
   * cheaper than pasting the digest into every prompt.
   */
  readonly contextFileFlag?: string | undefined
  /**
   * For `cli`: working directory for the child, overriding the host's own.
   *
   * An agent CLI discovers project instruction files by walking up from its
   * working directory. Inheriting the host's cwd therefore feeds the seat
   * whatever repository DSH happens to be running in — measured at ~8s per
   * call for `claude -p`, and it changes the answer: a seat handed a project's
   * instructions will sometimes address those instead of the question. Seats
   * do not read files themselves anyway (the host reads them and quotes the
   * text back, resolved against the configured roots), so a neutral directory
   * costs the seat nothing.
   */
  readonly cwd?: string | undefined
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
    cwd: join(homedir(), '.dsh', 'seat-cwd'),
    // 180s is not enough for this seat on a researched round. Measured: the
    // same model on the free proxy took 130s to draft with 30 shared sources,
    // and this seat was killed mid-answer at the run's 180s default, producing
    // nothing. Its ceiling now matches the free seat's rather than the run's.
    timeoutMs: 420_000,
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
    // The transport is `cli` like the paid seat, but the cost is not: the
    // ANTHROPIC_BASE_URL above sends every request to the local proxy, so no
    // subscription quota is spent. Without this flag the swarm reads the
    // transport, calls the seat `included`, and cannot tell it apart from the
    // subscription it exists to spare.
    free: true,
    cwd: join(homedir(), '.dsh', 'seat-cwd'),
    enabled: false,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    transport: 'cli',
    command: 'codex',
    args: ['exec', '{prompt}'],
    // `codex exec -` reads the prompt from stdin.
    stdinPromptArg: '-',
    enabled: true,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    transport: 'openrouter',
    model: 'moonshotai/kimi-k2',
    // A drafting round asks for thousands of output tokens, and a hosted seat
    // pays routing and queueing on top of generation. Measured 2026-09-07: a
    // stage-2 draft was cut off at the run's 180s default while the CLI seats,
    // which carry their own caps, finished the same round in 117-166s. The
    // hosted seats lost their vote for want of a cap of their own.
    timeoutMs: 420_000,
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek v4',
    transport: 'openrouter',
    model: 'deepseek/deepseek-v4-pro',
    timeoutMs: 420_000,
    enabled: true,
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    transport: 'openrouter',
    // The local free-model proxy speaks the same OpenAI-compatible wire
    // format, so only the endpoint differs. It chooses the model itself from
    // a warm pool of zero-priced OpenRouter models and rewrites the `model`
    // field on the way through, which is why this placeholder never reaches
    // anything that would reject it.
    baseUrl: 'http://127.0.0.1:8080/v1/chat/completions',
    model: 'proxy-auto',
    free: true,
    // Same measurement as the other free seat: zero-priced providers retry
    // through capacity refusals before answering, and the run's default cap
    // kills them mid-retry.
    timeoutMs: 420_000,
    // Off by default, for the reason `free-claude` is: it needs a local
    // process running, and a seat that fails on every run of a fresh install
    // is worse than one the user turns on.
    enabled: false,
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
  const spellings = WINDOWS_EXTENSIONS.map(ext => command + ext)
  return real === undefined ? spellings : [real, ...spellings]
}

/**
 * Make sure a seat's working directory exists.
 * @param dir - the configured directory.
 * @returns the same directory, or the host's cwd when it cannot be created.
 */
function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    // Falling back to the host's cwd loses the isolation but still runs, which
    // is the right trade for a seat that would otherwise fail outright.
    return process.cwd()
  }
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
  cwd: string | undefined,
  input?: string | undefined,
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
        // The child gets NO stdin. Node's default is an open pipe nobody ever
        // writes to, and an agent CLI that accepts a piped prompt reads it:
        // `codex exec` prints "Reading additional input from stdin..." and
        // blocks forever, so the seat produced no output and died at the
        // timeout with the run looking merely slow. Closing stdin turns that
        // into the EOF the CLI is waiting for. `claude -p` never waited on
        // stdin, which is why only one seat ever showed the symptom.
        //
        // The exception is a prompt too long for argv: then stdin IS the
        // delivery channel, and it is written and closed immediately below, so
        // the CLI still sees an EOF rather than an open pipe nobody feeds.
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // Only when the seat asked for one; otherwise inherit the host's cwd.
        // Created on demand: spawn throws ENOENT for a missing cwd, and a seat
        // must not depend on a directory someone remembered to make.
        ...cwd === undefined ? {} : { cwd: ensureDir(cwd) },
        // Layered over the parent environment rather than replacing it: the
        // child still needs PATH and the rest of it to start at all.
        ...env === undefined ? {} : { env: { ...process.env, ...env } },
      })
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, spawnError: describeError(error) })
      return
    }
    if (input !== undefined) {
      // A child that exits before reading it all makes this write fail. That is
      // the child's story to tell through its exit code and stderr, not a
      // reason to crash the host on an unhandled EPIPE.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
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
 * Longest command line to hand the platform before moving the prompt to stdin.
 *
 * Windows caps a command line at 32767 UTF-16 units for the whole line —
 * executable path, quoting, and every argument — and `spawn` fails with
 * ENAMETOOLONG rather than truncating. POSIX caps a SINGLE argument at
 * MAX_ARG_STRLEN, 128 KiB. Both limits are cut well short here: the cost of
 * switching early is nothing, and the cost of guessing high is a whole round
 * of seats failing at once.
 */
const ARGV_LIMIT = process.platform === 'win32' ? 24_000 : 96_000

/**
 * Measure a command line the way the platform will.
 * @param command - the executable, as spawned.
 * @param args - fully-formed argv.
 * @returns character length including per-argument quoting and separators.
 */
function commandLineLength(command: string, args: readonly string[]): number {
  // +3 per argument: two quotes and a separating space, which is what argv
  // joining costs on Windows and a safe overestimate everywhere else.
  return args.reduce((total, arg) => total + arg.length + 3, command.length)
}

/**
 * Rewrite an argv template for a prompt that travels on stdin instead.
 * @param template - the seat's argv template, containing `{prompt}`.
 * @param stdinPromptArg - what the CLI wants in place of the prompt, if anything.
 * @returns argv with the prompt entry replaced or removed.
 */
function stdinArgv(
  template: readonly string[],
  stdinPromptArg: string | undefined,
): readonly string[] {
  const out: string[] = []
  for (const entry of template) {
    if (entry !== '{prompt}') {
      out.push(entry)
      continue
    }
    if (stdinPromptArg !== undefined) out.push(stdinPromptArg)
  }
  return out
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
  const tail = contextFile !== undefined && seat.contextFileFlag !== undefined
    ? [seat.contextFileFlag, contextFile]
    : []
  const args = [...base, ...tail]
  // A prompt that would blow the platform's command-line limit goes on stdin
  // instead. Reviews are where this bites: that prompt carries every seat's
  // full draft, so the round that most needs its votes is the one that loses
  // them.
  const overLimit = commandLineLength(command, args) > ARGV_LIMIT
  const argv = overLimit ? [...stdinArgv(template, seat.stdinPromptArg), ...tail] : args
  const input = overLimit ? prompt : undefined
  let lastError = 'not found'
  for (const candidate of executableCandidates(command)) {
    const result = await runOnce(candidate, argv, signal, timeoutMs, seat.env, seat.cwd, input)
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
  // A seat pointed at a local proxy authenticates to that proxy, and the proxy
  // holds the upstream key itself. Demanding a key here would make the free
  // seat unusable on a machine that has no OpenRouter key at all — which is
  // the case it exists for.
  const endpoint = seat.baseUrl ?? OPENROUTER_URL
  if (endpoint === OPENROUTER_URL && (apiKey === undefined || apiKey === '')) {
    return { seat: seat.id, text: '', error: 'no OpenRouter API key available', ms: 0 }
  }
  const model = seat.model
  if (model === undefined || model === '') {
    return { seat: seat.id, text: '', error: 'no model configured', ms: 0 }
  }
  // Two independent limits, because a long answer and a dead connection fail
  // differently. `timeoutMs` bounds the whole call; the idle timer bounds the
  // gap between tokens, which is what actually distinguishes a model still
  // writing from a socket nobody is on any more.
  const overall = AbortSignal.timeout(timeoutMs)
  const stall = new AbortController()
  const composite = AbortSignal.any(signal === undefined ? [overall, stall.signal] : [signal, overall, stall.signal])
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...apiKey === undefined || apiKey === '' ? {} : { 'Authorization': `Bearer ${apiKey}` },
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Streamed, not because the text is shown as it arrives — the council
        // reports whole answers — but because a single non-streaming POST that
        // takes minutes is a connection sitting idle, and something between
        // here and the provider closes it: measured as
        // `fetch failed caused by other side closed`. A stream carries bytes
        // the whole time, so nothing along the path judges it dead.
        stream: true,
        stream_options: { include_usage: true },
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
    // `stream: true` is a request, not a guarantee: a proxy or a provider that
    // ignores it answers with one whole JSON body, and reading that as an
    // event stream would find no events and report an empty answer.
    const streamed = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    const stream = streamed
      ? await readSseStream(response, stall, seat.idleMs ?? DEFAULT_STREAM_IDLE_MS)
      : await readWholeBody(response)
    const usage: SeatUsage = { ...stream.usage, model: stream.model ?? model }
    // Reasoning-only replies (empty content, non-empty reasoning) still carry
    // an answer worth reporting rather than discarding as blank.
    const text = (stream.content || stream.reasoning).trim()
    if (text === '') {
      return { seat: seat.id, text: '', error: 'empty response', ms: Date.now() - started, usage }
    }
    return {
      seat: seat.id,
      text,
      ms: Date.now() - started,
      usage,
      ...stream.cited.length === 0 ? {} : { citedUrls: stream.cited },
    }
  } catch (error) {
    return { seat: seat.id, text: '', error: describeError(error), ms: Date.now() - started }
  }
}

/**
 * How long a reachability probe waits before calling a backend dead.
 *
 * A loopback TCP connect either answers immediately or is refused
 * immediately; anything slower than this is a port that will not serve a
 * council round either.
 */
export const PROBE_TIMEOUT_MS = 1500

/** A loopback backend a CLI seat is pointed at. */
export interface SeatBackend {
  readonly host: string
  readonly port: number
  /** Origin as written, for the failure message. */
  readonly origin: string
}

/**
 * The local backend a CLI seat routes through, when it routes through one.
 *
 * Only loopback addresses are returned. A probe exists to catch a proxy the
 * user forgot to start, which is always local; probing a remote host would
 * turn a slow network into a seat the council silently drops.
 * @param seat - the seat's resolved routing.
 * @returns the backend to probe, or undefined when there is nothing local to probe.
 */
export function loopbackBackend(seat: SeatConfig): SeatBackend | undefined {
  // A hosted seat pointed at a local proxy is as exposed to that proxy being
  // down as a CLI seat is, and fails the same slow way: the request sits until
  // the per-seat cap instead of being refused in a millisecond.
  if (seat.baseUrl !== undefined) return loopbackOf(seat.baseUrl)
  if (seat.transport !== 'cli') return undefined
  const env = seat.env
  if (env === undefined) return undefined
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('BASE_URL')) continue
    const backend = loopbackOf(value)
    if (backend === undefined) continue
    return backend
  }
  return undefined
}

/**
 * Read a loopback backend out of one configured URL.
 * @param value - the URL as written.
 * @returns the backend to probe, or undefined when it is not a loopback address.
 */
function loopbackOf(value: string): SeatBackend | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') return undefined
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!Number.isInteger(port) || port <= 0) return undefined
  return { host: host === '[::1]' ? '::1' : host, port, origin: `${url.protocol}//${url.host}` }
}

/**
 * Check that a seat's local backend is listening before the round pays for it.
 *
 * A CLI agent does not fail fast on a dead backend: measured against a stopped
 * proxy, `claude -p` retried a refused connection for 180s before returning an
 * error, and because a round waits for every seat, that one dead seat set the
 * wall time for the whole round — twice, once per round. A connect that is
 * refused in a millisecond says the same thing.
 * @param seat - the seat to probe.
 * @param timeoutMs - how long to wait for the connect.
 * @returns undefined when the seat is usable, else why it is not.
 */
export async function probeSeat(seat: SeatConfig, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const backend = loopbackBackend(seat)
  if (backend === undefined) return undefined
  return await new Promise<string | undefined>((resolve) => {
    const socket = connect({ host: backend.host, port: backend.port })
    let settled = false
    const finish = (reason: string | undefined): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reason)
    }
    socket.setTimeout(timeoutMs, () => {
      finish(`${backend.origin} did not answer within ${String(timeoutMs)}ms`)
    })
    socket.once('connect', () => {
      finish(undefined)
    })
    socket.once('error', (error) => {
      finish(`${backend.origin} is not accepting connections (${describeError(error)})`)
    })
  })
}

/**
 * How long a stream may go silent before it is judged dead.
 *
 * Generation itself never pauses this long: a model that has stopped emitting
 * for a minute and a half has been cut off somewhere upstream, and waiting out
 * the whole per-seat cap only delays the round for an answer that is not
 * coming.
 */
export const DEFAULT_STREAM_IDLE_MS = 90_000

/** What one streamed completion produced. */
interface StreamedReply {
  readonly content: string
  readonly reasoning: string
  readonly cited: readonly string[]
  readonly usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined }
  readonly model?: string | undefined
}

/** Read a number, or nothing when the field is missing or not finite. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** One streamed chunk's shape, as far as this reader cares. */
interface SseChunk {
  model?: unknown
  choices?: readonly {
    delta?: { content?: unknown; reasoning?: unknown; annotations?: unknown }
    message?: { content?: unknown; reasoning?: unknown; annotations?: unknown }
  }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
}

/** Collect `url_citation` urls out of a delta's annotations. */
function citationsOf(annotations: unknown, into: string[]): void {
  if (!Array.isArray(annotations)) return
  for (const entry of annotations) {
    const citation = (entry as { url_citation?: { url?: unknown } }).url_citation
    if (typeof citation?.url === 'string') into.push(citation.url)
  }
}

/**
 * Read a completion that arrived as one JSON body rather than a stream.
 * @param response - the non-streaming response.
 * @returns the same shape the stream reader produces.
 */
async function readWholeBody(response: Response): Promise<StreamedReply> {
  const body = await response.json() as SseChunk
  const choice = body.choices?.[0]
  const part = choice?.message ?? choice?.delta
  const cited: string[] = []
  citationsOf(part?.annotations, cited)
  return {
    content: typeof part?.content === 'string' ? part.content : '',
    reasoning: typeof part?.reasoning === 'string' ? part.reasoning : '',
    cited,
    usage: {
      inputTokens: finite(body.usage?.prompt_tokens),
      outputTokens: finite(body.usage?.completion_tokens),
      costUsd: finite(body.usage?.cost),
    },
    ...typeof body.model === 'string' ? { model: body.model } : {},
  }
}

/**
 * Assemble one streamed completion.
 *
 * OpenRouter's stream is server-sent events: `data:` lines carrying chunks, a
 * final `data: [DONE]`, and `:` comment lines it sends purely to keep the
 * connection warm while a provider is still thinking. The comments are the
 * reason this is worth doing — they are bytes on an otherwise silent socket.
 * @param response - the streaming response.
 * @param stall - aborted when the stream goes silent for too long.
 * @param idleMs - how long silence is tolerated.
 * @returns the assembled text, citations and usage.
 */
async function readSseStream(response: Response, stall: AbortController, idleMs: number): Promise<StreamedReply> {
  const body = response.body
  if (body === null) throw new Error('the provider returned no response body')
  let content = ''
  let reasoning = ''
  let model: string | undefined
  let usage: StreamedReply['usage'] = {}
  const cited: string[] = []
  let buffer = ''
  // The idle timer aborts the fetch, which kills a real socket — but a body
  // already handed over is not interrupted by that alone, so the read is also
  // raced against the same signal. Both matter: the abort frees the
  // connection, the race frees this loop.
  const stalled = new Promise<never>((_resolve, reject) => {
    stall.signal.addEventListener('abort', () => {
      reject(stall.signal.reason instanceof Error ? stall.signal.reason : new Error('the stream stalled'))
    }, { once: true })
  })
  const reader = body.getReader()
  let idle = setTimeout(() => {
    stall.abort(new Error(`the stream went silent for ${String(idleMs)}ms`))
  }, idleMs)
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stalled])
      clearTimeout(idle)
      if (next.done) break
      idle = setTimeout(() => {
        stall.abort(new Error(`the stream went silent for ${String(idleMs)}ms`))
      }, idleMs)
      buffer += decoder.decode(next.value, { stream: true })
      // A network chunk boundary is not a line boundary: keep the tail until
      // its newline arrives, or a split `data:` line is dropped unparsed.
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        // `:` is a comment — the keep-alive. Nothing to parse, and its arrival
        // has already reset the idle timer above.
        if (trimmed === '' || trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice('data:'.length).trim()
        if (payload === '[DONE]') continue
        let parsed: SseChunk
        try {
          parsed = JSON.parse(payload) as SseChunk
        } catch {
          continue
        }
        if (typeof parsed.model === 'string') model = parsed.model
        if (parsed.usage !== undefined) {
          usage = {
            inputTokens: finite(parsed.usage.prompt_tokens),
            outputTokens: finite(parsed.usage.completion_tokens),
            // OpenRouter reports the charged amount on the final chunk; it is
            // the only trustworthy cost figure available, recorded verbatim.
            costUsd: finite(parsed.usage.cost),
          }
        }
        const choice = parsed.choices?.[0]
        // A provider that ignores `stream` answers with a whole message
        // instead of deltas; take either rather than returning empty.
        const part = choice?.delta ?? choice?.message
        if (typeof part?.content === 'string') content += part.content
        if (typeof part?.reasoning === 'string') reasoning += part.reasoning
        citationsOf(part?.annotations, cited)
      }
    }
  } finally {
    clearTimeout(idle)
    await reader.cancel().catch(() => undefined)
  }
  return { content, reasoning, cited, usage, ...model === undefined ? {} : { model } }
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
