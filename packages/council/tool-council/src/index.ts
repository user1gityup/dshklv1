/**
 * Multi-agent council tool.
 *
 * Registers one `council` tool that fans a query out to four seats, has them
 * review each other, tallies a confidence-weighted vote, and reports the
 * outcome. The coloured report goes to the console; a plain-text copy is
 * returned as the tool result so the calling model reads the same thing.
 */

// Type-only: pulls the settings service's Context merge (ctx.settings).
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { judgeApproval, planExpired } from './approval.ts'
import { describeError } from './errors.ts'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBalance } from './budget.ts'
import { detectPalette } from './colors.ts'
import { compareCouncil, renderComparison } from './benchmarks.ts'
import { projectCapacity, renderCapacity } from './capacity.ts'
import { estimateRun, fetchModelPricing, parsePlanScale } from './estimate.ts'
import { quotaReading, readClaudeUsage, startOfDay, startOfWeek } from './usage.ts'
import { resolveOpenRouterKey, DEFAULT_KEY_ENV } from './credentials.ts'
import { listPresets, removePreset, renderPresets, savePreset } from './presets.ts'
import type { PresetMap } from './presets.ts'
import { PIPELINE_STAGES, runPipeline, startPipeline } from './pipeline.ts'
import type { PipelineStage, PipelineState } from './pipeline.ts'
import { runCouncil } from './council.ts'
import { runSwarm } from './swarm.ts'
import { diskSeam, parseRoots } from './files.ts'
import { diskWriteSeam } from './writes.ts'
import { runPropose } from './propose.ts'
import type { SubTask } from './decompose.ts'
import { renderMarkdown } from './markdown.ts'
import { renderReport } from './report.ts'
import { DEFAULT_SEATS } from './seats.ts'
import type { SeatConfig } from './seats.ts'

/** Cordis plugin name. */
export const name = 'tool-council'
/**
 * Services required. `settings` carries the UI-writable namespace; the base
 * bundle always mounts a provider, so waiting for it is safe.
 */
export const inject = ['tools', 'settings', 'systemPrompt', 'agents', 'web']

/** Preamble text used while council mode is on. */
const COUNCIL_MODE_PROMPT = `COUNCIL MODE IS ON.

Requests that call for analysis, design, code, or a judgement call go to the \`council\` tool rather than being answered directly. The council replies with a plan and a cost estimate and then stops; show that to the user and wait for approval before calling the tool again with the \`plan\` argument.

Answer directly only for trivial exchanges: acknowledgements, one-word clarifications, and questions about something you just said.`

/** Injected beside each user turn while council mode is on. */
const COUNCIL_MODE_DIRECTIVE = `[council mode] Handle the request above with the \`council\` tool. Call it now with the user's request as the \`query\`. Do not answer from your own knowledge first, and do not ask whether to use the council — the user has already switched it on.

The only exception is a trivial exchange (an acknowledgement, a one-word clarification, or a question about what you just said), which you may answer directly.

WHEN THE COUNCIL RETURNS, TWO RULES ARE ABSOLUTE:

1. Reproduce the \`report\` field VERBATIM, in full, before anything of your own. It already contains every seat's answer under its own coloured marker, the votes, and the collective answer. Do NOT summarise it, shorten it, quote only the winner, or describe what it says. The user reads the report, not your account of it. Dropping a losing seat's contribution destroys the point of running a council.

2. If the report stops at a plan, STOP. Do not call the council again. Do not reword the question and retry. Only the user can approve, using the Approve control; another call cannot approve and cannot improve the plan — it only spends money and replaces the plan they were about to approve.
`

/** Settings namespace this plugin owns; the UI binds the same name. */
export const COUNCIL_NAMESPACE = settingsNamespace('council')

/**
 * When the last real user message arrived. Held in memory, not settings: it is
 * the half of approval the model cannot fake, and a restart should reset it to
 * zero so a stale approval can never survive one.
 */
let lastUserTurnAt = 0

/** One seat's user-facing configuration. */
export interface SeatOverride {
  /** Turn this seat off without removing its configuration. */
  enabled?: boolean
  /** CLI seats: executable name resolved against PATH. */
  command?: string
  /** CLI seats: argv template; `{prompt}` is replaced with the prompt. */
  args?: string[]
  /** OpenRouter seats: model identifier to request. */
  model?: string
}

/** A seat the user adds beyond the four shipped ones. */
export interface ExtraSeat {
  /** Display name shown in the report; the key is used when omitted. */
  name?: string
  /** OpenRouter model identifier. Extra seats are OpenRouter-only. */
  model: string
  /** Turn this seat off without removing it. Defaults to on. */
  enabled?: boolean
}

/** Council routing configuration. */
export interface Config {
  /** Master switch. Set false to register no tool at all. */
  enabled?: boolean
  /** Per-seat overrides for the four shipped seats, keyed by seat id. */
  seats?: Record<string, SeatOverride>
  /** Additional OpenRouter seats, keyed by a new seat id. */
  extraSeats?: Record<string, ExtraSeat>
  /** Environment variable holding the OpenRouter key. */
  apiKeyEnv?: string
  /** Hard cap per seat call, in milliseconds. */
  timeoutMs?: number
  /** Run seats one at a time instead of in parallel. */
  sequential?: boolean
  /** Never emit ANSI escapes, whatever the terminal reports. */
  noColor?: boolean
  /**
   * Run a cheap planning round before drafting. On by default: one small call
   * that settles direction is far cheaper than N large ones aimed wrongly.
   */
  planning?: boolean
  /**
   * Stop after planning and return the plan for review. On by default, so the
   * expensive rounds never run without a look at the direction first.
   */
  planOnly?: boolean
  /** Seat that writes the plan. Defaults to the first OpenRouter seat. */
  plannerSeat?: string
  /**
   * When on, the agent is instructed to route every substantive request
   * through the council rather than answering alone.
   */
  councilMode?: boolean
  /**
   * Plan the council issued and is holding at the approval gate. Flat scalars
   * on purpose: a nested object schema gets an empty default materialised into
   * it at load, and its required fields then fail validation before boot.
   */
  pendingPlanId?: string
  /** The question that plan answers, shown on the Approve control. */
  pendingPlanQuery?: string
  /** The plan text itself, run verbatim once approved. */
  pendingPlanText?: string
  /** When the plan was issued, so a stale approval can be rejected. */
  pendingPlanIssuedAt?: number
  /**
   * Plan id a human approved, written only by the Approve control. The model
   * has no settings-writing tool, so this field cannot be forged by it.
   */
  approvedPlanId?: string
  /** When the Approve control was pressed. */
  approvedAt?: number
  /**
   * The swarm's half of the same gate, kept in its own slots.
   *
   * A council approval must not authorise a swarm run: they cost differently
   * and do different things. Sharing one set of slots would mean approving a
   * debate and getting a graph of workers.
   */
  pendingSwarmId?: string
  /** The request that graph serves, shown on the Approve control. */
  pendingSwarmQuery?: string
  /**
   * The approved graph itself, as JSON, run verbatim once approved.
   *
   * Stored rather than re-derived: decomposing again would produce a different
   * graph from the one the user read, so the approval would carry work nobody
   * saw. It also means approval costs nothing — the planning call was paid for
   * before the gate.
   */
  pendingSwarmTasks?: string
  /** When the graph was issued, so a stale approval can be rejected. */
  pendingSwarmIssuedAt?: number
  /** Graph id a human approved, written only by the Approve control. */
  approvedSwarmId?: string
  /** When the swarm's Approve control was pressed. */
  approvedSwarmAt?: number
  /**
   * The proposing round's half of the same gate, in its own slots again.
   *
   * A proposing round spends a long writing call per seat plus a vote per
   * seat, so it is the most expensive of the three and must be approved on its
   * own terms rather than inheriting either of the others.
   */
  /**
   * The council -> swarm -> council chain, as it survives between calls.
   *
   * The stage is durable state rather than something the model remembers, so
   * a chain that gets interrupted resumes where it stood. These slots hold no
   * approval of their own: each stage still passes its own tool's gate.
   */
  /**
   * Named, pre-written runs. A preset is the whole request already agreed, so
   * firing one takes a click rather than typing the prompt again — and the
   * wording is reviewed once, in settings, rather than retyped differently
   * each time. Keyed by id, a dict for the same reason `swarmRoster` is: a
   * bare object schema materialises an empty default and then fails its own
   * required fields at boot.
   */
  pipelinePresets?: Record<string, {
    name?: string
    query?: string
    /** Advance the chain without waiting to be asked between stages. */
    autoAdvance?: boolean
  }>
  /** Set while a run should advance itself; written by the control that fired a preset. */
  pipelineAuto?: boolean
  pipelineId?: string
  /** The request the whole chain serves, in the user's own words. */
  pipelineQuery?: string
  /** Which stage the next call runs. */
  pipelineStage?: string
  /** The approach the council agreed, carried into the decomposition. */
  pipelinePlan?: string
  /** The approved graph, as JSON, so a resumed run needs no new planning call. */
  pipelineTasks?: string
  /** What the workers reported, as JSON, carried into the review. */
  pipelineUnits?: string
  /** Wording of the exhaustion that parked the run, empty when it is running. */
  pipelineHoldDetail?: string
  /** Seat whose allowance ran out. */
  pipelineHoldSeat?: string
  /** Epoch ms the hold ends at; 0 when there is no hold. */
  pipelineHoldResumeAt?: number
  /** Whether that time was stated by the provider or defaulted here. */
  pipelineHoldSource?: string
  pendingProposeId?: string
  /** The change the seats would each write, shown on the Approve control. */
  pendingProposeTask?: string
  /** Run id, so the approved run writes where the plan said it would. */
  pendingProposeRunId?: string
  /** When the round was issued, so a stale approval can be rejected. */
  pendingProposeIssuedAt?: number
  /** Round id a human approved, written only by the Approve control. */
  approvedProposeId?: string
  /** When the proposing round's Approve control was pressed. */
  approvedProposeAt?: number
  /**
   * Directory under which each seat's own tree is created, one per run and
   * seat. Defaults to `swarm-work` beside the other DSH state.
   */
  workRoot?: string
  /**
   * Skip the per-run approval gate. Off by default, and only a person can set
   * it: the model has no settings-writing tool, so it cannot grant itself
   * standing permission to spend.
   */
  autoApprove?: boolean
  /**
   * Route approved work to a swarm of workers instead of answering in one
   * agent. Off by default: a swarm writes files and runs commands.
   */
  /**
   * How the plan is produced. Defaults to `council`: the plan is the decision
   * every later round inherits, so it should not rest on one seat.
   */
  /**
   * Web results each hosted seat may request per call. Zero leaves them
   * offline. OpenRouter bills per result, so this is a spending dial.
   */
  /**
   * Let seats request their own searches, run through the web seam on their
   * behalf. On by default: the searches go through a subscription route, so
   * this is the cheap way to give every seat live information.
   */
  seatResearch?: boolean
  /**
   * Directories whose files seats may ask to be shown, comma-separated.
   *
   * A seat never reads for itself: it names a path in the research round and
   * the host reads it, only inside these roots. Empty — the default — means no
   * seat is told it can ask, so nothing is readable until a person says which
   * directories. One flat string rather than an array because a nested
   * schemastery default materialises an empty object and fails at boot.
   */
  fileRoots?: string
  webMaxResults?: number
  planMode?: 'single' | 'council'
  swarmMode?: boolean
  /**
   * Per-provider swarm roster, keyed by subagent provider name. A dict of
   * objects rather than a bare object: a top-level object schema gets an empty
   * default materialised into it and fails its own required fields at boot.
   */
  swarmRoster?: Record<string, {
    enabled?: boolean
    kinds?: string[]
    maxConcurrent?: number
  }>
  /** Refuse to start when remaining OpenRouter credit falls below this. */
  minBalanceUsd?: number
  /** Monthly OpenRouter spend target used for pace warnings. */
  monthlyBudgetUsd?: number
  /** Weekly Claude token allowance the estimator measures against. */
  weeklyClaudeTokens?: number
  /** Daily Claude token allowance shown in the budget panel. */
  dailyClaudeTokens?: number
  /**
   * Monthly price of one subscription seat, in USD. A subscription's cost per
   * token is knowable: its price divided by the tokens it actually produces.
   */
  subscriptionUsdPerSeat?: number
  /**
   * Output tokens the CLI seats produced over the last seven days, measured
   * from their local logs. Written by this plugin so the browser panel — which
   * cannot read those logs — can price subscription seats.
   */
  observedCliTokensPerWeek?: number
  /**
   * Shared-memory digest handed to every seat. Defaults to the agent-memory
   * plugin's digest; set false to run the council without shared memory.
   */
  memoryDigest?: string | false
}

/** Loader schema for the council tool. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  extraSeats: z.dict(z.object({
    name: z.string(),
    model: z.string().required(),
    enabled: z.boolean().default(true),
  })).default({}),
  seats: z.dict(z.object({
    enabled: z.boolean(),
    command: z.string(),
    args: z.array(z.string()),
    model: z.string(),
  })).default({}),
  apiKeyEnv: z.string().default(DEFAULT_KEY_ENV),
  timeoutMs: z.natural().default(180_000),
  sequential: z.boolean().default(false),
  noColor: z.boolean().default(false),
  planning: z.boolean().default(true),
  planOnly: z.boolean().default(true),
  plannerSeat: z.string(),
  councilMode: z.boolean().default(false),
  pendingPlanId: z.string(),
  pendingPlanQuery: z.string(),
  pendingPlanText: z.string(),
  pendingPlanIssuedAt: z.number(),
  approvedPlanId: z.string(),
  approvedAt: z.number(),
  pendingSwarmId: z.string(),
  pendingSwarmQuery: z.string(),
  pendingSwarmTasks: z.string(),
  pendingSwarmIssuedAt: z.number(),
  approvedSwarmId: z.string(),
  approvedSwarmAt: z.number(),
  pipelinePresets: z.dict(z.object({
    name: z.string(),
    query: z.string(),
    autoAdvance: z.boolean(),
  })).default({}),
  pipelineAuto: z.boolean().default(false),
  pipelineId: z.string(),
  pipelineQuery: z.string(),
  pipelineStage: z.string(),
  pipelinePlan: z.string(),
  pipelineTasks: z.string(),
  pipelineUnits: z.string(),
  pipelineHoldDetail: z.string(),
  pipelineHoldSeat: z.string(),
  pipelineHoldResumeAt: z.number(),
  pipelineHoldSource: z.string(),
  pendingProposeId: z.string(),
  pendingProposeTask: z.string(),
  pendingProposeRunId: z.string(),
  pendingProposeIssuedAt: z.number(),
  approvedProposeId: z.string(),
  approvedProposeAt: z.number(),
  workRoot: z.string(),
  autoApprove: z.boolean().default(false),
  seatResearch: z.boolean().default(true),
  fileRoots: z.string(),
  webMaxResults: z.natural().default(0),
  planMode: z.union([z.const('single'), z.const('council')]).default('council'),
  swarmMode: z.boolean().default(false),
  swarmRoster: z.dict(z.object({
    enabled: z.boolean(),
    kinds: z.array(z.string()),
    maxConcurrent: z.number(),
  })).default({}),
  minBalanceUsd: z.number().default(0.5),
  monthlyBudgetUsd: z.number().default(20),
  weeklyClaudeTokens: z.number(),
  dailyClaudeTokens: z.number(),
  subscriptionUsdPerSeat: z.number().default(20),
  observedCliTokensPerWeek: z.number(),
  memoryDigest: z.union([z.string(), z.const(false)]),
})

/** Tool result value, kept flat so the model can read it without unwrapping. */
const COUNCIL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    phase: { type: 'string', required: true },
    plan: { type: 'string' },
    answer: { type: 'string', required: true },
    winner: { type: 'string' },
    method: { type: 'string', required: true },
    tied: { type: 'boolean', required: true },
    report: { type: 'string', required: true },
    failures: { type: 'array', required: true, items: { type: 'string' } },
    /**
     * Plan this call issued, when it stopped at the gate. The Approve control
     * renders on the call that proposed the plan, so it needs to know which
     * plan that was rather than guessing from whatever is current.
     */
    planId: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec


/** What one swarm call reports back. */
const SWARM_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    phase: { type: 'string', required: true },
    report: { type: 'string', required: true },
    units: { type: 'integer', required: true },
    ran: { type: 'integer', required: true },
    failures: { type: 'array', required: true, items: { type: 'string' } },
    /** Graph this call issued, when it stopped at the gate. */
    planId: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** What one pipeline call reports back. */
const PIPELINE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    stage: { type: 'string', required: true },
    phase: { type: 'string', required: true },
    report: { type: 'string', required: true },
    /** Epoch ms the run resumes at, when it is held on a spent allowance. */
    resumeAt: { type: 'integer' },
  },
} as const satisfies ValueSchemaSpec

/** What one preset write reports back. */
const PRESET_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    saved: { type: 'boolean', required: true },
    id: { type: 'string', required: true },
    report: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** What one proposing round reports back. */
const PROPOSE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', required: true },
    phase: { type: 'string', required: true },
    report: { type: 'string', required: true },
    candidates: { type: 'integer', required: true },
    /** Seat whose version was selected, when the vote settled. */
    winner: { type: 'string' },
    /** Round this call issued, when it stopped at the gate. */
    planId: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** Capacity projection result. */
const CAPACITY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hostedTokensPerMonth: { type: 'integer', required: true },
    totalTokensPerMonth: { type: 'integer', required: true },
    observedTokensPerMonth: { type: 'integer', required: true },
    multiple: { type: 'number', required: true },
    councilRunsPerMonth: { type: 'integer', required: true },
    report: { type: 'string', required: true },
    caveats: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const satisfies ValueSchemaSpec

/**
 * Wrap a value schema as a JSON-rendered tool output.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by defineTool.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/**
 * Merge configured overrides onto the shipped seat defaults.
 * @param overrides - per-seat configuration keyed by seat id.
 * @returns the resolved roster in council order.
 */
export function resolveSeats(
  overrides: Record<string, SeatOverride> = {},
  extras: Record<string, ExtraSeat> = {},
): readonly SeatConfig[] {
  const builtin = DEFAULT_SEATS.map((seat) => {
    const override = overrides[seat.id]
    if (override === undefined) return seat
    return {
      ...seat,
      enabled: override.enabled ?? seat.enabled,
      command: override.command ?? seat.command,
      // An empty array is the schema's materialised default, not a caller
      // asking for an argument-less command. Treat it as unset, or a seat
      // toggled in the UI would spawn its command with no prompt at all.
      args: override.args !== undefined && override.args.length > 0 ? override.args : seat.args,
      model: override.model ?? seat.model,
    }
  })
  // An extra seat may not shadow a shipped id: the report keys colour and vote
  // resolution off the id, so a duplicate would make two rows indistinguishable.
  const taken = new Set(builtin.map(seat => seat.id))
  const added: SeatConfig[] = []
  for (const [id, extra] of Object.entries(extras)) {
    if (taken.has(id)) continue
    taken.add(id)
    added.push({
      id,
      name: extra.name ?? id,
      transport: 'openrouter',
      model: extra.model,
      enabled: extra.enabled ?? true,
    })
  }
  return [...builtin, ...added]
}

/**
 * Register the council tool.
 * @param ctx - the Cordis context supplying the tool registry.
 * @param config - routing configuration.
 */
/** Default digest path, matching the agent-memory plugin's own default. */
function defaultDigestPath(): string {
  const home = process.env['DSH_HOME']
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'memory', 'digest.md')
}

/**
 * Where seat trees are created when no root is configured.
 * @returns the default work root, beside the rest of the DSH state.
 */
function defaultWorkRoot(): string {
  const home = process.env['DSH_HOME']
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'swarm-work')
}

/**
 * Resolve the shared-memory payload for one run.
 *
 * CLI seats take the path; hosted seats take the text. Both come from one
 * file, so every seat sees identical memory.
 * @param setting - configured path, or false to disable.
 * @returns the payload, or undefined when memory is off or absent.
 */
export function resolveMemory(
  setting: string | false | undefined,
): { file?: string | undefined; text?: string | undefined } | undefined {
  if (setting === false) return undefined
  const path = setting ?? defaultDigestPath()
  if (!existsSync(path)) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // An empty digest is worse than none: it spends prompt tokens saying nothing.
  if (text.trim() === '' || /_No memories recorded yet\._/.test(text)) return { file: path }
  return { file: path, text }
}

export function apply(ctx: Context, config: Config = {}): void {
  // A disabled council registers nothing, so the tool never reaches a model's
  // tool list — cheaper and less confusing than a tool that always refuses.
  if (config.enabled === false) return
  const timeoutMs = config.timeoutMs ?? 180_000

  // Settings are read per call rather than captured here, so a toggle flipped
  // in the UI takes effect on the next invocation without a restart.
  ctx.settings?.register(COUNCIL_NAMESPACE, Config as never, { base: config as never })
  const live = (): Config => {
    const stored = ctx.settings?.get(COUNCIL_NAMESPACE) as Config | undefined
    return stored ?? config
  }
  const currentSeats = (): readonly SeatConfig[] => {
    const now = live()
    return resolveSeats(now.seats, now.extraSeats)
  }
  const seats = currentSeats()

  // Council mode is enforced per step, not through the system prompt. A prompt
  // section sits far from the user's message and competes with everything else
  // in the preamble; an instruction folded into the entering batch arrives
  // immediately after the request it governs, which models follow far more
  // reliably. It is still an instruction — nothing in this seam can force a
  // tool call — but it is the strongest lever the harness exposes.
  ctx.systemPrompt.section({
    name: 'council:mode',
    order: 120,
    text: () => (live().councilMode === true ? COUNCIL_MODE_PROMPT : ''),
  })

  ctx.on('agent/pre-step', async ({ signal: _signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // Stamp every user turn, council mode or not: the approval gate reads this
    // to confirm a person spoke after pressing Approve.
    if (decision.messages.some(message => message.source.kind === 'user')) {
      lastUserTurnAt = Date.now()
    }
    if (live().councilMode !== true) return decision
    const messages = decision.messages
    // Only a real user turn is worth escalating. A step entered with no direct
    // user message is the loop continuing its own work — wrapping that in a
    // council would spend eight calls on an intermediate step.
    const hasDirectUser = messages.some(message => message.source.kind === 'user')
    if (!hasDirectUser) return decision
    const last = messages.at(-1)
    if (last === undefined) return decision
    return {
      kind: 'enter' as const,
      messages: [
        ...messages,
        {
          ...last,
          // A fresh id, or this shares one with the message it was cloned from.
          // Two messages under one id make the conversation assembler see two
          // starts for a single context, and the whole history fails to load.
          id: randomUUID() as typeof last.id,
          content: [{ type: 'text' as const, text: COUNCIL_MODE_DIRECTIVE }],
        },
      ],
    }
  }, { prepend: true })

  // Publish measured CLI-seat usage so the browser panel can price a
  // subscription seat. Only a material change is written: the settings
  // document is user-visible, and churning it on every boot would be noise.
  void (async () => {
    const week = readClaudeUsage(startOfWeek())
    const measured = week.outputTokens
    if (measured <= 0) return
    const known = live().observedCliTokensPerWeek
    if (known !== undefined && Math.abs(measured - known) / Math.max(1, known) < 0.05) return
    try {
      await ctx.settings?.update(COUNCIL_NAMESPACE, { observedCliTokensPerWeek: measured })
    } catch {
      // A read-only settings provider is a supported deployment; the panel
      // simply falls back to treating subscription seats as unpriced.
    }
  })()

  ctx.tools.register(defineTool({
    name: 'council_capacity',
    description:
      'Project how much work a monthly configuration buys: OpenRouter budget plus subscription seats, calibrated against the work already done in this environment. An estimate, not a quote.',
    parameters: {
      openRouterUsd: { type: 'number', description: 'OpenRouter budget per month. Defaults to the configured monthly target.' },
      subscriptionSeats: { type: 'integer', description: 'Number of subscription CLI seats, e.g. 2 for Claude plus Codex.' },
      subscriptionTokensPerMonth: {
        type: 'integer',
        description: 'Output tokens one subscription seat can produce per month. Supply this if you know your plan limits; it is not discoverable from any CLI.',
      },
      observationDays: { type: 'integer', description: 'How many days of local history to calibrate against. Defaults to 7.' },
    },
    output: jsonOutput(CAPACITY_VALUE_SCHEMA),
    async execute(args, exec) {
      const days = args.observationDays ?? 7
      const since = startOfDay() - (days - 1) * 24 * 60 * 60 * 1000
      const observedUsage = readClaudeUsage(since)
      const pricing = await fetchModelPricing(exec.signal)
      const configuration = {
        openRouterUsd: args.openRouterUsd ?? config.monthlyBudgetUsd ?? 20,
        subscriptionSeats: args.subscriptionSeats ?? seats.filter(seat => seat.enabled && seat.transport === 'cli').length,
        ...(args.subscriptionTokensPerMonth === undefined ? {} : { subscriptionTokensPerMonth: args.subscriptionTokensPerMonth }),
      }
      const capacity = projectCapacity(configuration, seats, pricing, {
        outputTokens: observedUsage.outputTokens,
        days,
        messages: observedUsage.messages,
      })
      const lines = [...renderCapacity(capacity, configuration)]
      // Published benchmarks answer the questions token maths cannot: how good,
      // how fast, and what the same work costs metered.
      const comparison = compareCouncil(
        seats.filter(seat => seat.enabled).map(seat => seat.id),
        id => seats.find(seat => seat.id === id)?.transport === 'openrouter',
      )
      if (comparison !== undefined) lines.push('', ...renderComparison(comparison))
      const palette = detectPalette({
        noColor: config.noColor === true,
        isTty: process.stdout.isTTY === true,
        env: process.env,
      })
      process.stdout.write(`${lines.map(line => palette.muted(line)).join('\n')}\n`)
      return {
        hostedTokensPerMonth: Math.round(capacity.hostedTokensPerMonth),
        totalTokensPerMonth: Math.round(capacity.totalTokensPerMonth),
        observedTokensPerMonth: Math.round(capacity.observedTokensPerMonth),
        multiple: capacity.multiple,
        councilRunsPerMonth: Math.round(capacity.councilRunsPerMonth),
        report: lines.join('\n'),
        caveats: [...capacity.caveats],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'council',
    description:
      'Ask a multi-model council (Claude, OpenAI, Kimi, DeepSeek) to answer a question, review each other, and vote on the best answer. The `report` field is a complete, formatted, user-facing document showing every seat answer, every vote, and the collective answer — reproduce it verbatim in your reply rather than summarising it.',
    parameters: {
      query: { type: 'string', required: true, description: 'The question to put to the council.' },
      plan: {
        type: 'string',
        description: 'An approved plan. Supplying it skips the planning round and runs the full council against this direction.',
      },
      planOnly: {
        type: 'boolean',
        description: 'Stop after the planning round and return the plan without spending the drafting and review rounds.',
      },
      skipPlan: { type: 'boolean', description: 'Skip planning and go straight to drafting.' },
      planMode: {
        type: 'string',
        enum: ['single', 'council'],
        description: 'single: one seat writes the plan. council: every seat proposes one and the council votes. Defaults to the configured mode.',
      },
      noColor: { type: 'boolean', description: 'Disable ANSI colour in the console report.' },
      sequential: { type: 'boolean', description: 'Run seats one at a time instead of in parallel.' },
    },
    output: {
      schema: COUNCIL_VALUE_SCHEMA,
      // Show every draft, review, and vote in the main window rather than a
      // summary: the point of a council is seeing the disagreement.
      render: (_args: unknown, value: InferValue<typeof COUNCIL_VALUE_SCHEMA>) => {
        // The client's tool view needs to know WHICH plan this call issued, so
        // the Approve control binds to this call rather than to whatever plan
        // happens to be current. The result node carries only rendered content
        // and a closed union of card shapes — there is no structured payload
        // to put it in — so it travels as a marker the view parses and strips.
        const marker = value.planId === undefined || value.planId === ''
          ? ''
          : `${String.fromCharCode(10)}${String.fromCharCode(10)}<!--council-plan:${value.planId}-->`
        return [{ type: 'text' as const, text: `${value.report}${marker}` }]
      },
    },
    async execute(args, exec) {
      const apiKey = resolveOpenRouterKey({ variable: config.apiKeyEnv })
      // A `plan` argument is NOT evidence of approval: the model is the caller
      // and can write one itself, which is exactly how an unapproved run got
      // through before. Approval is judged only from state the model cannot
      // write — the Approve button, and a user turn after it.
      const settingsNow = live()
      const approval = judgeApproval({
        pendingPlan: settingsNow.pendingPlanId === undefined || settingsNow.pendingPlanId === '' ? undefined : {
          id: settingsNow.pendingPlanId,
          query: settingsNow.pendingPlanQuery ?? '',
          issuedAt: settingsNow.pendingPlanIssuedAt ?? 0,
        },
        approvedPlanId: settingsNow.approvedPlanId,
        approvedAt: settingsNow.approvedAt,
        lastUserTurnAt,
      })
      // Stop at the gate unless approval is complete. Every caller-supplied
      // flag that could weaken the gate is ignored while unapproved: the model
      // reached for `planOnly`, then for `skipPlan`, and would reach for the
      // next one. Only the approval decides.
      // A plan is already held and unapproved: return it rather than running
      // another planning round. Without this, a model that re-calls the tool
      // with a reworded query pays for a fresh plan every time and resets the
      // gate, so the run can never reach drafting no matter how many rounds
      // are bought.
      const heldId = settingsNow.pendingPlanId
      const heldUnapproved = heldId !== undefined && heldId !== ''
        && settingsNow.approvedPlanId !== heldId
        && settingsNow.autoApprove !== true
        && !planExpired(
          { id: heldId, query: settingsNow.pendingPlanQuery ?? '', issuedAt: settingsNow.pendingPlanIssuedAt ?? 0 },
          Date.now(),
        )
      if (heldUnapproved) {
        const waiting = [
          '## Council — plan already waiting',
          '',
          '> **!** A plan is already held at the approval gate. Nothing new was run and nothing was spent.',
          '',
          `**Question:** ${settingsNow.pendingPlanQuery ?? '(unknown)'}`,
          '',
          settingsNow.pendingPlanText ?? '',
          '',
          '_Press **Approve** below the composer, then send any message. Calling the council again only re-plans; it cannot approve._',
        ].join(String.fromCharCode(10))
        return {
          report: waiting,
          phase: 'plan',
          query: settingsNow.pendingPlanQuery ?? args.query,
          answer: '',
          method: 'none',
          tied: false,
          failures: [],
          ...(heldId === undefined ? {} : { planId: heldId }),
          ...(settingsNow.pendingPlanText === undefined || settingsNow.pendingPlanText === ''
            ? {}
            : { plan: settingsNow.pendingPlanText }),
        }
      }

      // Auto-approve is standing permission from the user, so the run does
      // not stop at the gate. It still plans first: the plan is what makes the
      // estimate meaningful, and it costs one cheap call.
      const autoApproved = settingsNow.autoApprove === true
      const planOnly = autoApproved ? false : !approval.allowed
      const skipPlan = (autoApproved || approval.allowed)
        ? (args.skipPlan ?? config.planning === false)
        : false
      const wantsPlainEarly = args.noColor === true || config.noColor === true
      const livePalette = detectPalette({
        noColor: wantsPlainEarly,
        isTty: process.stdout.isTTY === true,
        env: process.env,
      })
      const memory = resolveMemory(live().memoryDigest)
      const active = currentSeats()
      const result = await runCouncil({
        memory,
        // Tool-less seats get one shared search instead of each inventing
        // citations. The seam's router prefers a subscription route, so this
        // is normally free.
        web: ctx.web,
        onEvent: (event) => {
          // Live line per seat: a full council can run for minutes, and silence
          // is indistinguishable from a hang.
          const cost = event.costUsd === undefined ? '' : ` $${event.costUsd.toFixed(4)}`
          const running = ` (run total $${event.runningCostUsd.toFixed(4)})`
          const status = event.ok ? '' : ' FAILED'
          const line = `  [${event.round}] ${event.name} ${String(event.ms)}ms${cost}${running}${status}`
          process.stdout.write(`${event.ok ? livePalette.seat(event.seat, line) : livePalette.failure(line)}\n`)
        },
        // Once approved, run the question the plan was written for. The
        // follow-up turn that satisfies the verbal factor is usually just
        // "go", and passing that as the query would answer the wrong thing.
        query: !autoApproved && approval.allowed && settingsNow.pendingPlanQuery !== undefined && settingsNow.pendingPlanQuery !== ''
          ? settingsNow.pendingPlanQuery
          : args.query,
        seats: active,
        apiKey,
        signal: exec.signal,
        timeoutMs,
        sequential: args.sequential ?? config.sequential,
        // The approved plan comes from stored state, not from the caller's
        // argument. A model-supplied plan is discarded outright.
        ...(!autoApproved && approval.allowed && settingsNow.pendingPlanText !== undefined
          ? { plan: settingsNow.pendingPlanText }
          : {}),
        skipPlan,
        planMode: args.planMode ?? config.planMode ?? 'council',
        webMaxResults: config.webMaxResults ?? 0,
        seatResearch: config.seatResearch !== false,
        // A seat with no filesystem asks for a path and is handed the text.
        // The roots are the whole of the permission: no root configured, and
        // no seat is even told it may ask.
        files: diskSeam(),
        fileRoots: parseRoots(config.fileRoots),
        planOnly,
        budget: {
          minBalanceUsd: config.minBalanceUsd ?? 0.5,
          monthlyUsd: config.monthlyBudgetUsd ?? 20,
        },
        ...(config.plannerSeat === undefined ? {} : { plannerSeat: config.plannerSeat }),
      })

      // The estimate is only meaningful at the planning gate: past that point
      // the money is already committed.
      let estimated = result
      // Issue the plan for approval, or retire the approval that was just
      // spent. Both write settings, the one channel the model cannot reach.
      let issueProblem: string | undefined
      let issuedPlanId: string | undefined
      if (result.phase === 'plan' && !autoApproved) {
        const issuedId = randomUUID()
        issuedPlanId = issuedId
        // The Approve control is driven entirely by this write. If it fails,
        // or the settings service is absent, the button never appears and the
        // run is stuck with no way forward — so the failure is surfaced in the
        // report rather than swallowed by an optional chain.
        if (ctx.settings === undefined) {
          issueProblem = 'the settings service is unavailable, so no Approve control can be shown'
        } else {
          try {
            await ctx.settings.update(COUNCIL_NAMESPACE, {
              pendingPlanId: issuedId,
              pendingPlanQuery: args.query,
              pendingPlanText: result.plan ?? '',
              pendingPlanIssuedAt: Date.now(),
              // A newly issued plan voids any earlier approval outright.
              approvedPlanId: '',
              approvedAt: 0,
            } as never)
            const check = live().pendingPlanId
            if (check !== issuedId) {
              issueProblem = `the plan was written but did not take effect (settings hold ${check ?? 'nothing'})`
            }
          } catch (error) {
            issueProblem = `the plan could not be recorded: ${describeError(error)}`
          }
        }
      } else {
        // The run happened; the approval must not be reusable for the next one.
        // Retire with empty sentinels, not `undefined`: a settings update
        // treats undefined as "leave unchanged", so the spent approval
        // survived and the NEXT council run needed no approval at all.
        // Every run must be approved on its own.
        await ctx.settings?.update(COUNCIL_NAMESPACE, {
          pendingPlanId: '',
          pendingPlanQuery: '',
          pendingPlanText: '',
          pendingPlanIssuedAt: 0,
          approvedPlanId: '',
          approvedAt: 0,
        } as never)
      }

      // The estimate is most useful precisely when planning went wrong, so it
      // is attached whenever the run stopped at the gate — plan or no plan.
      if (result.phase === 'plan') {
        const [pricing, balance] = await Promise.all([
          fetchModelPricing(exec.signal),
          readBalance(apiKey, exec.signal),
        ])
        // With no plan to size the job, fall back to the estimator's own default.
        const scale = parsePlanScale(result.plan ?? '')
        const week = quotaReading(readClaudeUsage(startOfWeek()), config.weeklyClaudeTokens)
        const estimate = estimateRun(active, scale, pricing, [], {
          remainingUsd: balance?.remaining,
          monthlyUsd: config.monthlyBudgetUsd ?? 20,
          monthUsedUsd: balance?.used,
          weeklyClaudeTokens: config.weeklyClaudeTokens,
          weeklyClaudeUsed: week.tokens,
        })
        estimated = { ...result, estimate, approval, ...issueProblem === undefined ? {} : { issueProblem } }
      }

      const wantsPlain = args.noColor === true || config.noColor === true
      const consolePalette = detectPalette({
        noColor: wantsPlain,
        isTty: process.stdout.isTTY === true,
        env: process.env,
      })
      // The console gets colour when the terminal supports it; the model always
      // gets the plain rendering, since escapes are noise in a transcript.
      process.stdout.write(`${renderReport(estimated, consolePalette)}\n`)
      // Two sinks, two formats: ANSI to the console, markdown to the chat.
      const plain = renderMarkdown(estimated)

      const failures = [
        ...result.drafts.filter(draft => draft.error !== undefined)
          .map(draft => `${draft.seat} draft: ${String(draft.error)}`),
        ...result.reviews.filter(review => review.error !== undefined)
          .map(review => `${review.seat} review: ${String(review.error)}`),
      ]

      return {
        query: result.query,
        phase: result.phase,
        ...(result.plan === undefined ? {} : { plan: result.plan }),
        answer: result.answer,
        ...(result.verdict.winner === undefined ? {} : { winner: result.verdict.winner }),
        method: result.verdict.method,
        tied: result.verdict.tied,
        report: plain,
        ...(issuedPlanId === undefined ? {} : { planId: issuedPlanId }),
        failures,
      }
    },
  }))

  // -- swarm: run a request across the seats, without a council first --
  //
  // Same two-factor gate as the council, on its own settings slots: pressing
  // Approve on a council plan must not authorise a graph of workers. The graph
  // is decomposed and priced before the gate and stored verbatim, so approving
  // runs the graph the user actually read.
  ctx.tools.register(defineTool({
    name: 'swarm',
    description:
      'Split a request into units of work and run them across the configured seats, in dependency waves. '
      + 'Decomposes and prices the work, then STOPS for approval; it never runs units on its first call. '
      + 'Use when the user knows what they want done and wants it divided rather than debated.',
    parameters: {
      query: { type: 'string', required: true, description: 'The work to split, in the user own terms.' },
      sequential: { type: 'boolean', description: 'Run units one at a time instead of a wave at a time.' },
    },
    output: {
      schema: SWARM_VALUE_SCHEMA,
      render: (_args: unknown, value: InferValue<typeof SWARM_VALUE_SCHEMA>) => {
        // Same marker mechanism as the council: a tool result node carries no
        // structured payload, so the id the Approve control binds to travels
        // inside the text and the view strips it.
        const marker = value.planId === undefined || value.planId === ''
          ? ''
          : `${String.fromCharCode(10)}${String.fromCharCode(10)}<!--swarm-plan:${value.planId}-->`
        return [{ type: 'text' as const, text: `${value.report}${marker}` }]
      },
    },
    async execute(args, exec) {
      const apiKey = resolveOpenRouterKey({ variable: config.apiKeyEnv })
      const settingsNow = live()
      const approval = judgeApproval({
        pendingPlan: settingsNow.pendingSwarmId === undefined || settingsNow.pendingSwarmId === '' ? undefined : {
          id: settingsNow.pendingSwarmId,
          query: settingsNow.pendingSwarmQuery ?? '',
          issuedAt: settingsNow.pendingSwarmIssuedAt ?? 0,
        },
        approvedPlanId: settingsNow.approvedSwarmId,
        approvedAt: settingsNow.approvedSwarmAt,
        lastUserTurnAt,
      })
      const autoApproved = settingsNow.autoApprove === true

      // A graph is already held and unapproved: show it again rather than
      // decomposing a second time. Re-planning here would spend another call
      // and reset the gate, so the run could never reach execution however
      // many times the model called back.
      const heldId = settingsNow.pendingSwarmId
      const heldUnapproved = heldId !== undefined && heldId !== ''
        && settingsNow.approvedSwarmId !== heldId
        && !autoApproved
        && !planExpired(
          { id: heldId, query: settingsNow.pendingSwarmQuery ?? '', issuedAt: settingsNow.pendingSwarmIssuedAt ?? 0 },
          Date.now(),
        )
      if (heldUnapproved) {
        return {
          query: settingsNow.pendingSwarmQuery ?? args.query,
          phase: 'plan',
          units: 0,
          ran: 0,
          failures: [],
          planId: heldId,
          report: [
            '## Swarm - plan already waiting',
            '',
            '> **!** A graph is already held at the approval gate. Nothing new was run and nothing was spent.',
            '',
            `**Request:** ${settingsNow.pendingSwarmQuery ?? '(unknown)'}`,
            '',
            '_Press **Approve** below, then send any message. Calling the swarm again only re-plans; it cannot approve._',
          ].join(String.fromCharCode(10)),
        }
      }

      const approved = autoApproved || approval.allowed
      // An approved run uses the stored graph, never a fresh decomposition:
      // the approval was given for what the user read, not for whatever a
      // second planning call would return.
      const storedTasks = approved ? readStoredTasks(settingsNow.pendingSwarmTasks) : undefined
      const pricing = await fetchModelPricing(exec.signal)
      const result = await runSwarm({
        // Once approved, run the request the graph was written for. The turn
        // that satisfies the verbal factor is usually just "go".
        query: approved && settingsNow.pendingSwarmQuery !== undefined && settingsNow.pendingSwarmQuery !== ''
          ? settingsNow.pendingSwarmQuery
          : args.query,
        seats: currentSeats(),
        overrides: config.swarmRoster ?? {},
        approved,
        apiKey,
        pricing,
        timeoutMs,
        signal: exec.signal,
        sequential: args.sequential ?? config.sequential,
        memory: resolveMemory(live().memoryDigest),
        webMaxResults: config.webMaxResults ?? 0,
        files: diskSeam(),
        fileRoots: parseRoots(config.fileRoots),
        ...(config.plannerSeat === undefined ? {} : { planner: config.plannerSeat }),
        ...(storedTasks === undefined ? {} : { tasks: storedTasks }),
      })

      // Issue the graph for approval, or retire the approval just spent. Both
      // write settings, the one channel the model cannot reach.
      let issuedPlanId: string | undefined
      let issueProblem: string | undefined
      if (result.phase === 'plan' && !autoApproved) {
        const issuedId = randomUUID()
        issuedPlanId = issuedId
        if (ctx.settings === undefined) {
          issueProblem = 'the settings service is unavailable, so no Approve control can be shown'
        } else {
          try {
            await ctx.settings.update(COUNCIL_NAMESPACE, {
              pendingSwarmId: issuedId,
              pendingSwarmQuery: result.query,
              pendingSwarmTasks: JSON.stringify(result.tasks),
              pendingSwarmIssuedAt: Date.now(),
              // A newly issued graph voids any earlier approval outright.
              approvedSwarmId: '',
              approvedSwarmAt: 0,
            } as never)
            const check = live().pendingSwarmId
            if (check !== issuedId) {
              issueProblem = `the graph was written but did not take effect (settings hold ${check ?? 'nothing'})`
            }
          } catch (error) {
            issueProblem = `the graph could not be recorded: ${describeError(error)}`
          }
        }
      } else if (result.phase === 'full') {
        // Retire with empty sentinels, not `undefined`: a settings update
        // treats undefined as "leave unchanged", so a spent approval would
        // survive and the next run would need no approval at all.
        await ctx.settings?.update(COUNCIL_NAMESPACE, {
          pendingSwarmId: '',
          pendingSwarmQuery: '',
          pendingSwarmTasks: '',
          pendingSwarmIssuedAt: 0,
          approvedSwarmId: '',
          approvedSwarmAt: 0,
        } as never)
      }

      const report = issueProblem === undefined
        ? result.report
        : `${result.report}${String.fromCharCode(10)}${String.fromCharCode(10)}> **!** ${issueProblem}`
      process.stdout.write(`${report}${String.fromCharCode(10)}`)

      return {
        query: result.query,
        phase: result.phase,
        report,
        units: result.tasks.length,
        ran: result.results.filter(unit => unit.error === undefined).length,
        failures: result.results
          .filter(unit => unit.error !== undefined)
          .map(unit => `${unit.seat} ${unit.task.id}: ${String(unit.error)}`),
        ...(issuedPlanId === undefined ? {} : { planId: issuedPlanId }),
      }
    },
  }))

  /**
   * The subscription's session usage, as the status line last cached it.
   *
   * Read from the shared cache file rather than by calling `/usage`: a live
   * call costs a request against the very quota it reports, which is the last
   * thing a run parked ON that quota should spend. Absent or unreadable is a
   * normal answer — the hold then simply waits out its own clock.
   * @returns percent of the session window used, when it is known.
   */
  const statuslineSessionPercent = (): number | undefined => {
    try {
      const path = join(homedir(), '.claude', 'statusline', 'usage-cache.json')
      if (!existsSync(path)) return undefined
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof raw !== 'object' || raw === null) return undefined
      const value = (raw as Record<string, unknown>)['sessionPercent']
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  // -- pipeline: council, then swarm, then council again, as one run --
  //
  // The three tools already chain by hand; what they cannot do by hand is
  // REMEMBER. Nothing carries the agreed approach into the decomposition or
  // the units' output into the review, and a model that forgets stage two
  // simply skips it. Here the stage is durable state, so the chain is a
  // property of the run rather than of the model's attention.
  //
  // One call advances one stage, and each stage still passes its OWN tool's
  // gate: this tool adds no approval of its own and can bypass none. A spent
  // subscription parks the run instead of failing it - see quota-hold.ts.
  ctx.tools.register(defineTool({
    name: 'pipeline',
    description:
      'Run a request through the whole chain: the council agrees the approach, the swarm splits and runs it, '
      + 'then the council reviews what came back. Advances ONE stage per call and stops at each stage\'s own gate. '
      + 'Call it again to continue; it resumes where it stood, including after a quota hold.',
    parameters: {
      query: { type: 'string', description: 'The work, in the user\'s own words. Omit to continue the run already in progress.' },
      restart: { type: 'boolean', description: 'Abandon the run in progress and start a new one at the council stage.' },
    },
    output: {
      schema: PIPELINE_VALUE_SCHEMA,
      render: (_args: unknown, value: InferValue<typeof PIPELINE_VALUE_SCHEMA>) =>
        [{ type: 'text' as const, text: value.report }],
    },
    async execute(args, exec) {
      const apiKey = resolveOpenRouterKey({ variable: config.apiKeyEnv })
      const settingsNow = live()
      const running = settingsNow.pipelineId !== undefined && settingsNow.pipelineId !== ''
      const storedTasks = readStoredTasks(settingsNow.pipelineTasks)
      const storedStage = settingsNow.pipelineStage ?? ''
      const heldAt = settingsNow.pipelineHoldResumeAt ?? 0

      const state: PipelineState = running && args.restart !== true
        ? {
          id: settingsNow.pipelineId ?? '',
          query: settingsNow.pipelineQuery ?? args.query ?? '',
          stage: (PIPELINE_STAGES as readonly string[]).includes(storedStage)
            ? (storedStage as PipelineStage)
            : 'council',
          ...(settingsNow.pipelinePlan === undefined || settingsNow.pipelinePlan === ''
            ? {}
            : { plan: settingsNow.pipelinePlan }),
          ...(storedTasks === undefined ? {} : { tasks: storedTasks }),
          ...(heldAt === 0
            ? {}
            : {
              hold: {
                detail: settingsNow.pipelineHoldDetail ?? '',
                resumeAt: heldAt,
                source: settingsNow.pipelineHoldSource === 'stated' ? ('stated' as const) : ('default' as const),
                ...(settingsNow.pipelineHoldSeat === undefined || settingsNow.pipelineHoldSeat === ''
                  ? {}
                  : { seat: settingsNow.pipelineHoldSeat }),
              },
            }),
        }
        : startPipeline(randomUUID(), args.query ?? settingsNow.pipelineQuery ?? '')

      if (state.query === '') {
        return {
          query: '',
          stage: state.stage,
          phase: 'blocked',
          report: '## Pipeline\n\nNo request to run. Call it with `query` set to the work you want carried through the chain.',
        }
      }

      const pricing = await fetchModelPricing(exec.signal)
      const seatsNow = currentSeats()

      // Each stage is judged by the gate of the tool that actually spends, so
      // this tool can neither add an approval nor stand in for one.
      const councilApproved = (): boolean => settingsNow.autoApprove === true || judgeApproval({
        pendingPlan: settingsNow.pendingPlanId === undefined || settingsNow.pendingPlanId === '' ? undefined : {
          id: settingsNow.pendingPlanId,
          query: settingsNow.pendingPlanQuery ?? '',
          issuedAt: settingsNow.pendingPlanIssuedAt ?? 0,
        },
        approvedPlanId: settingsNow.approvedPlanId,
        approvedAt: settingsNow.approvedAt,
        lastUserTurnAt,
      }).allowed

      const swarmApproved = (): boolean => settingsNow.autoApprove === true || judgeApproval({
        pendingPlan: settingsNow.pendingSwarmId === undefined || settingsNow.pendingSwarmId === '' ? undefined : {
          id: settingsNow.pendingSwarmId,
          query: settingsNow.pendingSwarmQuery ?? '',
          issuedAt: settingsNow.pendingSwarmIssuedAt ?? 0,
        },
        approvedPlanId: settingsNow.approvedSwarmId,
        approvedAt: settingsNow.approvedSwarmAt,
        lastUserTurnAt,
      }).allowed

      const result = await runPipeline({
        state,
        sessionPercent: statuslineSessionPercent(),
        async runStage(stage, input) {
          if (stage === 'swarm') {
            const approved = swarmApproved()
            const swarm = await runSwarm({
              query: input.plan === undefined || input.plan === ''
                ? input.query
                : `${input.query}${String.fromCharCode(10)}${String.fromCharCode(10)}AGREED APPROACH (from the council):${String.fromCharCode(10)}${input.plan}`,
              seats: seatsNow,
              overrides: config.swarmRoster ?? {},
              approved,
              apiKey,
              pricing,
              timeoutMs,
              signal: exec.signal,
              sequential: config.sequential,
              memory: resolveMemory(live().memoryDigest),
              webMaxResults: config.webMaxResults ?? 0,
              files: diskSeam(),
              fileRoots: parseRoots(config.fileRoots),
              ...(config.plannerSeat === undefined ? {} : { planner: config.plannerSeat }),
              ...(input.tasks === undefined || !approved ? {} : { tasks: input.tasks }),
            })
            if (swarm.phase === 'plan' && settingsNow.autoApprove !== true) {
              await ctx.settings?.update(COUNCIL_NAMESPACE, {
                pendingSwarmId: randomUUID(),
                pendingSwarmQuery: swarm.query,
                pendingSwarmTasks: JSON.stringify(swarm.tasks),
                pendingSwarmIssuedAt: Date.now(),
                approvedSwarmId: '',
                approvedSwarmAt: 0,
              } as never)
            }
            // Retire with empty sentinels, never `undefined`: a settings update
            // leaves undefined keys unchanged, so a spent approval must not carry
            // the next stage. Stage two approved a graph of workers; stage three
            // is a council review, and it has to be asked for separately.
            if (swarm.phase === 'full') {
              await ctx.settings?.update(COUNCIL_NAMESPACE, {
                pendingSwarmId: '',
                pendingSwarmQuery: '',
                pendingSwarmTasks: '',
                pendingSwarmIssuedAt: 0,
                approvedSwarmId: '',
                approvedSwarmAt: 0,
              } as never)
            }
            return {
              report: swarm.report,
              complete: swarm.phase === 'full',
              tasks: swarm.tasks,
              units: swarm.results,
              failures: swarm.results
                .filter(unit => unit.error !== undefined)
                .map(unit => ({ seat: unit.seat, error: String(unit.error) })),
              ...(swarm.phase === 'blocked' ? { problems: swarm.problems } : {}),
            }
          }

          // Both council stages run the same tool; only the question differs.
          const approved = councilApproved()
          const question = stage === 'review'
            ? [
              'Review the work below against the original request. Say what is missing, wrong, or unfinished.',
              '',
              `ORIGINAL REQUEST: ${input.query}`,
              '',
              ...(input.units ?? []).map(unit => [
                `### ${unit.task.title} (${unit.seat})`,
                unit.error === undefined ? unit.text : `FAILED: ${unit.error}`,
              ].join(String.fromCharCode(10))),
            ].join(String.fromCharCode(10))
            : input.query
          const council = await runCouncil({
            query: question,
            seats: seatsNow,
            apiKey,
            timeoutMs,
            signal: exec.signal,
            sequential: config.sequential,
            planMode: config.planMode ?? 'council',
            planOnly: !approved,
            memory: resolveMemory(live().memoryDigest),
            webMaxResults: config.webMaxResults ?? 0,
            seatResearch: config.seatResearch !== false,
            files: diskSeam(),
            fileRoots: parseRoots(config.fileRoots),
            ...(config.plannerSeat === undefined ? {} : { plannerSeat: config.plannerSeat }),
            ...(approved && settingsNow.pendingPlanText !== undefined && settingsNow.pendingPlanText !== ''
              ? { plan: settingsNow.pendingPlanText }
              : {}),
          })
          if (council.phase === 'plan' && settingsNow.autoApprove !== true) {
            await ctx.settings?.update(COUNCIL_NAMESPACE, {
              pendingPlanId: randomUUID(),
              pendingPlanQuery: question,
              pendingPlanText: council.plan ?? '',
              pendingPlanIssuedAt: Date.now(),
              approvedPlanId: '',
              approvedAt: 0,
            } as never)
          }
          // Same retirement on the council side: the approval that let stage one
          // draft must not still be standing when stage three asks to review.
          if (council.phase === 'full') {
            await ctx.settings?.update(COUNCIL_NAMESPACE, {
              pendingPlanId: '',
              pendingPlanQuery: '',
              pendingPlanText: '',
              pendingPlanIssuedAt: 0,
              approvedPlanId: '',
              approvedAt: 0,
            } as never)
          }
          return {
            report: renderMarkdown(council),
            complete: council.phase === 'full',
            ...(council.plan === undefined ? {} : { plan: council.plan }),
            failures: [
              ...(council.planFailures ?? []).map(failure => ({ seat: failure.seat, error: failure.error })),
              ...council.drafts
                .filter(draft => draft.error !== undefined)
                .map(draft => ({ seat: draft.seat, error: String(draft.error) })),
            ],
          }
        },
      })

      // The run IS the settings: every call writes it back, the hold included.
      // That is what lets a resumed session pick the same stage up rather than
      // start a chain the user already paid for.
      await ctx.settings?.update(COUNCIL_NAMESPACE, {
        pipelineId: result.phase === 'done' ? '' : result.state.id,
        pipelineQuery: result.phase === 'done' ? '' : result.state.query,
        pipelineStage: result.state.stage,
        pipelinePlan: result.state.plan ?? '',
        pipelineTasks: result.state.tasks === undefined ? '' : JSON.stringify(result.state.tasks),
        pipelineUnits: result.state.units === undefined ? '' : JSON.stringify(result.state.units),
        pipelineHoldDetail: result.state.hold?.detail ?? '',
        pipelineHoldSeat: result.state.hold?.seat ?? '',
        pipelineHoldResumeAt: result.state.hold?.resumeAt ?? 0,
        pipelineHoldSource: result.state.hold?.source ?? '',
      } as never)

      process.stdout.write(`${result.report}${String.fromCharCode(10)}`)
      return {
        query: result.state.query,
        stage: result.state.stage,
        phase: result.phase,
        report: result.report,
        ...(result.state.hold === undefined ? {} : { resumeAt: result.state.hold.resumeAt }),
      }
    },
  }))

  // -- save_pipeline_preset: the one settings key a model may write --
  //
  // Settings are otherwise closed to model-facing tools, and that closure is
  // what makes the approval gate mean anything: a model that could write
  // `approvedPlanId` could approve its own spending. A preset is the one thing
  // worth an exception, because it is only TEXT the user later chooses to
  // press — it authorises nothing and spends nothing on its own.
  //
  // The door is cut to that shape: presets.ts returns a new preset map and
  // nothing else, and this writes exactly `pipelinePresets`. No approval slot
  // is reachable from here, by design rather than by care.
  ctx.tools.register(defineTool({
    name: 'save_pipeline_preset',
    description:
      'Save a named, reusable pipeline run so the user can fire it from a button instead of retyping it. '
      + 'Ids are `area/name` in lowercase kebab, such as `dsh/gate-audit`. '
      + 'Saves the request only: it starts nothing, spends nothing, and approves nothing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Preset id, `area/name` in lowercase kebab.' },
      query: { type: 'string', description: 'The whole request the run should carry. Required unless removing.' },
      name: { type: 'string', description: 'Button label. Defaults to the name half of the id.' },
      autoAdvance: { type: 'boolean', description: 'Advance between stages without being asked. Approval gates still apply.' },
      replace: { type: 'boolean', description: 'Permission to overwrite an id already in use.' },
      remove: { type: 'boolean', description: 'Delete this preset instead of saving one.' },
    },
    output: {
      schema: PRESET_VALUE_SCHEMA,
      render: (_args: unknown, value: InferValue<typeof PRESET_VALUE_SCHEMA>) =>
        [{ type: 'text' as const, text: value.report }],
    },
    async execute(args) {
      const held = (live().pipelinePresets ?? {}) as PresetMap
      const write = args.remove === true
        ? removePreset(held, args.id)
        : savePreset(
          held,
          args.id,
          { name: args.name ?? '', query: args.query ?? '', ...(args.autoAdvance === undefined ? {} : { autoAdvance: args.autoAdvance }) },
          args.replace === true,
        )

      if (write.problem !== undefined) {
        return {
          saved: false,
          id: args.id,
          report: [
            '## Preset not saved',
            '',
            `> **!** ${write.problem}`,
            '',
            renderPresets(held),
          ].join(String.fromCharCode(10)),
        }
      }

      if (ctx.settings === undefined) {
        return {
          saved: false,
          id: args.id,
          report: '## Preset not saved\n\n> **!** the settings service is unavailable, so nothing could be written.',
        }
      }

      await ctx.settings.update(COUNCIL_NAMESPACE, { pipelinePresets: write.presets } as never)
      // Read back rather than trust the write: a settings update that did not
      // take effect would otherwise be reported as a button the user does not
      // have.
      const after = (live().pipelinePresets ?? {}) as PresetMap
      const landed = args.remove === true ? after[args.id] === undefined : after[args.id] !== undefined
      if (!landed) {
        return {
          saved: false,
          id: args.id,
          report: `## Preset not saved\n\n> **!** the write did not take effect; settings hold ${String(listPresets(after).length)} preset(s).`,
        }
      }

      const what = args.remove === true
        ? `Removed \`${args.id}\`.`
        : `${write.replaced === true ? 'Replaced' : 'Saved'} \`${args.id}\`. Reload DSH and it appears under **Saved runs**.`
      return {
        saved: true,
        id: args.id,
        report: ['## Saved runs', '', what, '', renderPresets(after)].join(String.fromCharCode(10)),
      }
    },
  }))

  // -- propose: every seat writes the change, then the council picks one --
  //
  // Its own gate again. This is the most expensive of the three tools — a long
  // writing call per seat, then a vote per seat — and it is the only one whose
  // output is code, so approving a council debate or a swarm graph must not
  // authorise it.
  ctx.tools.register(defineTool({
    name: 'propose',
    description:
      'Have every configured seat independently write its own version of the same code change, each into its own '
      + 'working tree, then hold a council vote on which version should be implemented. Nothing is written to the '
      + 'real repositories. STOPS for approval; it never writes on its first call.',
    parameters: {
      task: { type: 'string', required: true, description: 'The change to implement, in the user own terms.' },
      sequential: { type: 'boolean', description: 'Ask seats one at a time instead of together.' },
    },
    output: {
      schema: PROPOSE_VALUE_SCHEMA,
      render: (_args: unknown, value: InferValue<typeof PROPOSE_VALUE_SCHEMA>) => {
        const marker = value.planId === undefined || value.planId === ''
          ? ''
          : `${String.fromCharCode(10)}${String.fromCharCode(10)}<!--propose-plan:${value.planId}-->`
        return [{ type: 'text' as const, text: `${value.report}${marker}` }]
      },
    },
    async execute(args, exec) {
      const apiKey = resolveOpenRouterKey({ variable: config.apiKeyEnv })
      const settingsNow = live()
      const approval = judgeApproval({
        pendingPlan: settingsNow.pendingProposeId === undefined || settingsNow.pendingProposeId === '' ? undefined : {
          id: settingsNow.pendingProposeId,
          query: settingsNow.pendingProposeTask ?? '',
          issuedAt: settingsNow.pendingProposeIssuedAt ?? 0,
        },
        approvedPlanId: settingsNow.approvedProposeId,
        approvedAt: settingsNow.approvedProposeAt,
        lastUserTurnAt,
      })
      const autoApproved = settingsNow.autoApprove === true

      // A round already held and unapproved is shown again rather than
      // re-issued, so calling back cannot reset the gate indefinitely.
      const heldId = settingsNow.pendingProposeId
      const heldUnapproved = heldId !== undefined && heldId !== ''
        && settingsNow.approvedProposeId !== heldId
        && !autoApproved
        && !planExpired(
          { id: heldId, query: settingsNow.pendingProposeTask ?? '', issuedAt: settingsNow.pendingProposeIssuedAt ?? 0 },
          Date.now(),
        )
      if (heldUnapproved) {
        return {
          task: settingsNow.pendingProposeTask ?? args.task,
          phase: 'plan',
          candidates: 0,
          planId: heldId,
          report: [
            '## Proposing round - already waiting',
            '',
            '> **!** A round is already held at the approval gate. Nothing was run and nothing was spent.',
            '',
            `**Change:** ${settingsNow.pendingProposeTask ?? '(unknown)'}`,
            '',
            '_Press **Approve** below, then send any message._',
          ].join(String.fromCharCode(10)),
        }
      }

      const approved = autoApproved || approval.allowed
      const result = await runPropose({
        // Once approved, write the change the round was issued for.
        task: approved && settingsNow.pendingProposeTask !== undefined && settingsNow.pendingProposeTask !== ''
          ? settingsNow.pendingProposeTask
          : args.task,
        seats: currentSeats(),
        fileRoots: parseRoots(config.fileRoots),
        workRoot: config.workRoot === undefined || config.workRoot === '' ? defaultWorkRoot() : config.workRoot,
        approved,
        files: diskSeam(),
        writes: diskWriteSeam(),
        apiKey,
        signal: exec.signal,
        timeoutMs,
        sequential: args.sequential ?? config.sequential,
        memory: resolveMemory(live().memoryDigest),
        webMaxResults: config.webMaxResults ?? 0,
        // An approved run writes where the plan said it would, so the report
        // the user read names the directories the files actually land in.
        ...(approved && settingsNow.pendingProposeRunId !== undefined && settingsNow.pendingProposeRunId !== ''
          ? { runId: settingsNow.pendingProposeRunId }
          : {}),
      })

      let issuedPlanId: string | undefined
      let issueProblem: string | undefined
      if (result.phase === 'plan' && !autoApproved) {
        const issuedId = randomUUID()
        issuedPlanId = issuedId
        if (ctx.settings === undefined) {
          issueProblem = 'the settings service is unavailable, so no Approve control can be shown'
        } else {
          try {
            await ctx.settings.update(COUNCIL_NAMESPACE, {
              pendingProposeId: issuedId,
              pendingProposeTask: result.task,
              pendingProposeRunId: result.runId,
              pendingProposeIssuedAt: Date.now(),
              approvedProposeId: '',
              approvedProposeAt: 0,
            } as never)
            const check = live().pendingProposeId
            if (check !== issuedId) {
              issueProblem = `the round was written but did not take effect (settings hold ${check ?? 'nothing'})`
            }
          } catch (error) {
            issueProblem = error instanceof Error ? error.message : String(error)
          }
        }
      } else if (approval.allowed && !autoApproved && ctx.settings !== undefined) {
        // Retire the approval just spent, so it cannot authorise a second run.
        try {
          await ctx.settings.update(COUNCIL_NAMESPACE, {
            pendingProposeId: '',
            pendingProposeTask: '',
            pendingProposeRunId: '',
            pendingProposeIssuedAt: 0,
            approvedProposeId: '',
            approvedProposeAt: 0,
          } as never)
        } catch {
          // A retirement that fails leaves a spent approval in place. The gate
          // still requires a later user turn, so it cannot fire unattended.
        }
      }

      const report = issueProblem === undefined
        ? result.report
        : `${result.report}${String.fromCharCode(10)}${String.fromCharCode(10)}> **!** ${issueProblem}`
      process.stdout.write(`${report}${String.fromCharCode(10)}`)

      return {
        task: result.task,
        phase: result.phase,
        report,
        candidates: result.candidates.length,
        ...(result.selection?.winner === undefined ? {} : { winner: result.selection.winner }),
        ...(issuedPlanId === undefined ? {} : { planId: issuedPlanId }),
      }
    },
  }))
}

/**
 * Read a stored task graph back, treating anything unreadable as absent.
 *
 * The graph crosses a durable file boundary, so it is parsed rather than
 * trusted. An unreadable graph means the run decomposes again and stops at the
 * gate for the user to re-approve, which is the safe direction: the
 * alternative is running a half-parsed graph nobody approved.
 * @param raw - the stored JSON, when there is any.
 * @returns the graph, or undefined when there is none to run.
 */
function readStoredTasks(raw: string | undefined): readonly SubTask[] | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed stored JSON. The only writer is the issue path above, so a bad
    // value means the settings file was edited or truncated outside the harness.
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  const tasks = parsed.filter((entry): entry is SubTask =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as { id?: unknown }).id === 'string'
    && typeof (entry as { title?: unknown }).title === 'string'
    && Array.isArray((entry as { dependsOn?: unknown }).dependsOn))
  return tasks.length === parsed.length ? tasks : undefined
}
