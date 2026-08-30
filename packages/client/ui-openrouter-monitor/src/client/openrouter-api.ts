/**
 * OpenRouter API data: credits balance and generation usage.
 * Calls OpenRouter's public REST API directly from the browser.
 */

/**
 * Raw credit response from GET https://openrouter.ai/api/v1/credits.
 * The totals are nested under `data`, not at the top level.
 */
export interface OpenRouterCredits {
  data: {
    /** Total credits purchased (USD). */
    total_credits: number
    /** Credits consumed to date (USD). */
    total_usage: number
  }
}

/** A single generation cost row from GET https://openrouter.ai/api/v1/generation */
export interface OpenRouterGeneration {
  /** ISO code, e.g. "deepseek/deepseek-v4-pro" */
  model: string
  /** Total cost in USD. */
  total_cost: number
  /** Number of generations. */
  total_generations: number
  /** ISO timestamp. */
  created_at: string
}

/** Generation usage response. */
export interface OpenRouterGenerationResponse {
  data: OpenRouterGeneration[]
}

/** Parsed balance snapshot for the UI. */
export interface BalanceSnapshot {
  /** Credits remaining (USD). */
  remaining: number
  /** Total purchased (USD). */
  purchased: number
  /** Total used = purchased - remaining. */
  used: number
}

/** Parsed generation data for the UI, grouped by model. */
export interface UsageSnapshot {
  /** Total cost across all models. */
  totalCost: number
  /** Total generation count. */
  totalGenerations: number
  /** Per-model breakdown. */
  models: ModelUsage[]
}

/** One model's cost summary. */
export interface ModelUsage {
  model: string
  /** Display-friendly model name (last segment). */
  label: string
  cost: number
  generations: number
  /** Output tokens, when the source counts tokens rather than dollars. */
  tokens?: number
  /** Prompt tokens billed to this model. */
  tokensIn?: number
  /** Completion tokens billed to this model. */
  tokensOut?: number
}

/** Per-token USD prices for one model, as published by OpenRouter. */
export interface ModelPrice {
  prompt: number
  completion: number
}

const OR_BASE = 'https://openrouter.ai/api/v1'

/**
 * Fetch the public model catalogue and read its per-token prices.
 *
 * This endpoint needs no credential, so per-model spend can be priced from
 * locally recorded token counts without a management key.
 * @param signal - abort signal.
 * @returns model id -> per-token USD price.
 */
export async function fetchModelPricing(signal?: AbortSignal): Promise<Map<string, ModelPrice>> {
  const response = await fetch(`${OR_BASE}/models`, { ...(signal ? { signal } : {}) })
  if (!response.ok) {
    throw new Error(`OpenRouter models: ${response.status} ${response.statusText}`)
  }
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data as Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> : []
  const prices = new Map<string, ModelPrice>()
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const prompt = Number(row.pricing?.prompt)
    const completion = Number(row.pricing?.completion)
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue
    prices.set(row.id, { prompt, completion })
  }
  return prices
}

/**
 * Fetch credit balance from OpenRouter.
 * @param apiKey - the API key.
 * @param signal - abort signal.
 * @returns the balance snapshot.
 */
export async function fetchCredits(
  apiKey: string,
  signal?: AbortSignal,
): Promise<BalanceSnapshot> {
  const response = await fetch(`${OR_BASE}/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`OpenRouter credits: ${response.status} ${response.statusText}`)
  }
  const body = await response.json() as OpenRouterCredits
  const totals = body.data
  if (!totals || typeof totals.total_credits !== 'number' || typeof totals.total_usage !== 'number') {
    throw new Error('OpenRouter credits: unexpected response shape')
  }
  return {
    remaining: totals.total_credits - totals.total_usage,
    purchased: totals.total_credits,
    used: totals.total_usage,
  }
}

/**
 * One row of the account activity feed. Field names are read defensively:
 * OpenRouter has shipped more than one spelling for the model and cost keys.
 */
interface ActivityRow {
  [field: string]: unknown
}

/** Field spellings OpenRouter has used for the model identity on an activity row. */
const MODEL_FIELDS = ['model', 'model_permaslug', 'model_slug', 'endpoint_model', 'name'] as const
/** Field spellings for the money spent on an activity row. */
const COST_FIELDS = ['usage', 'cost', 'total_cost', 'spend', 'amount', 'usage_amount', 'byok_usage_inference'] as const
/** Field spellings for the call count on an activity row. */
const COUNT_FIELDS = ['requests', 'generations', 'total_generations', 'count', 'num_requests'] as const

/**
 * Read the first field present with the wanted primitive type.
 * @param row - one activity row.
 * @param fields - candidate field names, most likely first.
 * @param kind - 'string' or 'number'.
 * @returns the value, or undefined when no candidate matches.
 */
function pick(row: ActivityRow, fields: readonly string[], kind: 'string' | 'number'): string | number | undefined {
  for (const field of fields) {
    const value = row[field]
    if (kind === 'string' && typeof value === 'string' && value.length > 0) return value
    if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      // Some rows carry decimal strings rather than numbers.
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
    }
  }
  return undefined
}

/**
 * Fetch per-model activity for the account.
 *
 * Requires a MANAGEMENT (provisioning) key — an ordinary inference key is
 * refused with 403 "Only management keys can fetch activity for an account".
 * @param managementKey - an OpenRouter management key.
 * @param signal - abort signal.
 * @returns the usage snapshot, aggregated per model.
 */
export async function fetchActivity(
  managementKey: string,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const response = await fetch(`${OR_BASE}/activity`, {
    headers: { Authorization: `Bearer ${managementKey}` },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    console.info('[openrouter-monitor] activity HTTP', response.status, response.statusText)
    throw new Error(`OpenRouter activity: ${response.status} ${response.statusText}`)
  }
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data as ActivityRow[] : []
  if (rows[0]) {
    // One-shot shape dump: the activity payload has changed spelling before,
    // and a silent $0 is indistinguishable from a genuinely idle account.
    console.info('[openrouter-monitor] activity row fields:', Object.keys(rows[0]), rows[0])
  } else {
    console.info('[openrouter-monitor] activity returned no rows:', body)
  }

  // One account can bill the same model across several days and endpoints, so
  // fold rows to one entry per model before ranking them.
  const byModel = new Map<string, { cost: number; generations: number }>()
  for (const row of rows) {
    const model = pick(row, MODEL_FIELDS, 'string')
    if (typeof model !== 'string') continue
    const cost = pick(row, COST_FIELDS, 'number')
    const calls = pick(row, COUNT_FIELDS, 'number')
    const prev = byModel.get(model) ?? { cost: 0, generations: 0 }
    byModel.set(model, {
      cost: prev.cost + (typeof cost === 'number' ? cost : 0),
      generations: prev.generations + (typeof calls === 'number' ? calls : 0),
    })
  }

  const models: ModelUsage[] = [...byModel.entries()].map(([model, agg]) => ({
    model,
    label: model.split('/').pop() ?? model,
    cost: agg.cost,
    generations: agg.generations,
  }))
  models.sort((a, b) => b.cost - a.cost)
  return {
    totalCost: models.reduce((sum, m) => sum + m.cost, 0),
    totalGenerations: models.reduce((sum, m) => sum + m.generations, 0),
    models,
  }
}

/**
 * Fetch generation usage from OpenRouter.
 * @param apiKey - the API key.
 * @param signal - abort signal.
 * @returns the usage snapshot.
 */
export async function fetchUsage(
  apiKey: string,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  // OpenRouter's generation endpoint returns per-model generation costs.
  // Parameter: ?group_by=model&order_by=cost
  const url = `${OR_BASE}/generation?group_by=model&order_by=cost`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`OpenRouter generations: ${response.status} ${response.statusText}`)
  }
  const body = await response.json() as OpenRouterGenerationResponse
  const models: ModelUsage[] = []
  let totalCost = 0
  let totalGenerations = 0
  for (const gen of body.data) {
    const label = gen.model.split('/').pop() ?? gen.model
    models.push({
      model: gen.model,
      label,
      cost: gen.total_cost,
      generations: gen.total_generations,
    })
    totalCost += gen.total_cost
    totalGenerations += gen.total_generations
  }
  // Sort by cost descending.
  models.sort((a, b) => b.cost - a.cost)
  return { totalCost, totalGenerations, models }
}
