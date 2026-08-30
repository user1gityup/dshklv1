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
import { runCouncil } from './council.ts'
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
export const inject = ['tools', 'settings', 'systemPrompt', 'agents']

/** Preamble text used while council mode is on. */
const COUNCIL_MODE_PROMPT = `COUNCIL MODE IS ON.

Requests that call for analysis, design, code, or a judgement call go to the \`council\` tool rather than being answered directly. The council replies with a plan and a cost estimate and then stops; show that to the user and wait for approval before calling the tool again with the \`plan\` argument.

Answer directly only for trivial exchanges: acknowledgements, one-word clarifications, and questions about something you just said.`

/** Injected beside each user turn while council mode is on. */
const COUNCIL_MODE_DIRECTIVE = `[council mode] Handle the request above with the \`council\` tool. Call it now with the user's request as the \`query\`. Do not answer from your own knowledge first, and do not ask whether to use the council — the user has already switched it on.

The only exception is a trivial exchange (an acknowledgement, a one-word clarification, or a question about what you just said), which you may answer directly.

When the council returns, reproduce its full report field VERBATIM in your reply before adding anything of your own. The report is already formatted for the user: it shows each seat's answer under its own coloured marker, then the votes, then the collective answer. Do not summarise it, shorten it, or describe it — paste it in full.`

/** Settings namespace this plugin owns; the UI binds the same name. */
export const COUNCIL_NAMESPACE = settingsNamespace('council')

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
      args: override.args ?? seat.args,
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
    if (live().councilMode !== true) {
      console.info('[council-mode] pre-step: councilMode is OFF at read time')
      return decision
    }
    const messages = decision.messages
    // Only a real user turn is worth escalating. A step entered with no direct
    // user message is the loop continuing its own work — wrapping that in a
    // council would spend eight calls on an intermediate step.
    const hasDirectUser = messages.some(message => message.source.kind === 'user')
    console.info('[council-mode] pre-step: councilMode=on, messages=', messages.length, 'kinds=', messages.map(m => m.source.kind).join(','), 'directUser=', hasDirectUser)
    if (!hasDirectUser) return decision
    const last = messages.at(-1)
    if (last === undefined) return decision
    return {
      kind: 'enter' as const,
      messages: [
        ...messages,
        {
          ...last,
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
      noColor: { type: 'boolean', description: 'Disable ANSI colour in the console report.' },
      sequential: { type: 'boolean', description: 'Run seats one at a time instead of in parallel.' },
    },
    output: {
      schema: COUNCIL_VALUE_SCHEMA,
      // Show every draft, review, and vote in the main window rather than a
      // summary: the point of a council is seeing the disagreement.
      render: (_args: unknown, value: InferValue<typeof COUNCIL_VALUE_SCHEMA>) =>
        [{ type: 'text' as const, text: value.report }],
    },
    async execute(args, exec) {
      const apiKey = resolveOpenRouterKey({ variable: config.apiKeyEnv })
      // An explicit plan means the direction is already settled, so planOnly
      // must not re-gate it; that would make an approved plan unrunnable.
      const hasPlan = typeof args.plan === 'string' && args.plan !== ''
      const planOnly = hasPlan ? false : (args.planOnly ?? config.planOnly ?? true)
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
        onEvent: (event) => {
          // Live line per seat: a full council can run for minutes, and silence
          // is indistinguishable from a hang.
          const cost = event.costUsd === undefined ? '' : ` $${event.costUsd.toFixed(4)}`
          const running = ` (run total $${event.runningCostUsd.toFixed(4)})`
          const status = event.ok ? '' : ' FAILED'
          const line = `  [${event.round}] ${event.name} ${String(event.ms)}ms${cost}${running}${status}`
          process.stdout.write(`${event.ok ? livePalette.seat(event.seat, line) : livePalette.failure(line)}\n`)
        },
        query: args.query,
        seats: active,
        apiKey,
        signal: exec.signal,
        timeoutMs,
        sequential: args.sequential ?? config.sequential,
        ...(hasPlan ? { plan: args.plan } : {}),
        skipPlan: args.skipPlan ?? config.planning === false,
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
      if (result.phase === 'plan' && result.plan !== undefined && result.plan !== '') {
        const [pricing, balance] = await Promise.all([
          fetchModelPricing(exec.signal),
          readBalance(apiKey, exec.signal),
        ])
        const scale = parsePlanScale(result.plan)
        const week = quotaReading(readClaudeUsage(startOfWeek()), config.weeklyClaudeTokens)
        const estimate = estimateRun(active, scale, pricing, [], {
          remainingUsd: balance?.remaining,
          monthlyUsd: config.monthlyBudgetUsd ?? 20,
          monthUsedUsd: balance?.used,
          weeklyClaudeTokens: config.weeklyClaudeTokens,
          weeklyClaudeUsed: week.tokens,
        })
        estimated = { ...result, estimate }
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
        failures,
      }
    },
  }))
}
