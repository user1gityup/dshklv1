/**
 * Saved runs, and the narrow door a model may use to write one.
 *
 * Settings are deliberately the one channel no model-facing tool reaches: that
 * is what makes the approval gate mean anything, since a model that could
 * write `approvedPlanId` could approve its own spending. Presets are the one
 * exception worth making, because a preset is only a piece of TEXT the user
 * will later choose to press — it authorises nothing and spends nothing on its
 * own. So the door is cut to exactly that shape here: this module produces a
 * new `pipelinePresets` map and nothing else, and the tool that uses it writes
 * that one key. No approval slot is reachable from this path even by mistake.
 *
 * The id carries the naming convention (`area/name`) rather than a separate
 * field, because a list is only scannable when its order means something, and
 * sorting by id is the cheapest order that groups an area's runs together.
 */

/** One saved run. */
export interface PresetEntry {
  /** The button label. */
  readonly name: string
  /** The whole request, written out once. */
  readonly query: string
  /** Advance the chain between stages without being asked. */
  readonly autoAdvance?: boolean | undefined
}

/** Presets as settings hold them, keyed by `area/name`. */
export type PresetMap = Readonly<Record<string, PresetEntry>>

/** `area/name`, both lowercase kebab. Anything else sorts and reads badly. */
export const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9-]{0,47}$/

/**
 * The longest request a preset may carry; past this it belongs in a file.
 *
 * Raised from 32k after a real prompt came in at 38k: the whole point of a
 * saved run is that the request is already written out, so a ceiling that a
 * genuine one overshoots turns every long prompt into a negotiation. 64k still
 * sits far below anything that would bloat settings.yaml, and a request past
 * it is long enough that a file reference reads better than an inlined wall.
 */
export const MAX_QUERY = 64_000

/**
 * Why this id is not usable, or undefined when it is.
 *
 * The rules are the convention, enforced rather than documented: a preset with
 * no area lands in a flat list nobody can scan, and one with capitals or spaces
 * sorts unpredictably next to its neighbours.
 * @param id - the proposed id.
 * @returns the problem, or undefined.
 */
export function presetIdProblem(id: string): string | undefined {
  if (id.trim() !== id) return 'the id has leading or trailing whitespace'
  if (!id.includes('/')) return `\`${id}\` has no area: ids are \`area/name\`, such as \`dsh/gate-audit\``
  if (id.split('/').length > 2) return `\`${id}\` has more than one \`/\`: ids are exactly \`area/name\``
  if (!PRESET_ID.test(id)) {
    return `\`${id}\` is not \`area/name\` in lowercase kebab — letters, digits and hyphens only`
  }
  return undefined
}

/** What a save attempt produced. */
export interface PresetWrite {
  /** The map to persist; unchanged from the input when there is a problem. */
  readonly presets: PresetMap
  /** Why nothing was written. */
  readonly problem?: string | undefined
  /** True when an existing preset was replaced rather than added. */
  readonly replaced?: boolean | undefined
}

/**
 * Add or replace one preset, returning a whole new map.
 *
 * Refusing to overwrite unless asked is the point: a saved run is a thing the
 * user presses without reading, so silently changing what a familiar button
 * does is worse than failing to save.
 * @param existing - the presets as they stand.
 * @param id - `area/name`.
 * @param entry - the preset to store.
 * @param replace - permission to overwrite an id already in use.
 * @returns the new map, or the old one with a problem.
 */
export function savePreset(
  existing: PresetMap,
  id: string,
  entry: PresetEntry,
  replace = false,
): PresetWrite {
  const idProblem = presetIdProblem(id)
  if (idProblem !== undefined) return { presets: existing, problem: idProblem }

  const query = entry.query.trim()
  if (query === '') return { presets: existing, problem: 'the preset has no request to run' }
  if (query.length > MAX_QUERY) {
    return {
      presets: existing,
      problem: `the request is ${String(query.length)} characters; presets hold at most ${String(MAX_QUERY)}`,
    }
  }

  const name = entry.name.trim()
  const held = existing[id]
  if (held !== undefined && !replace) {
    return {
      presets: existing,
      problem: `\`${id}\` already exists ("${held.name}"). Pass replace to overwrite it, or choose another name.`,
    }
  }

  return {
    presets: {
      ...existing,
      [id]: {
        // A missing label falls back to the id's own name half, so a preset is
        // never a blank button.
        name: name === '' ? (id.split('/')[1] ?? id) : name,
        query,
        ...(entry.autoAdvance === undefined ? {} : { autoAdvance: entry.autoAdvance }),
      },
    },
    ...(held === undefined ? {} : { replaced: true }),
  }
}

/**
 * Remove one preset.
 * @param existing - the presets as they stand.
 * @param id - the preset to remove.
 * @returns the new map, or the old one with a problem.
 */
export function removePreset(existing: PresetMap, id: string): PresetWrite {
  if (existing[id] === undefined) {
    return { presets: existing, problem: `no preset is saved as \`${id}\`` }
  }
  const next: Record<string, PresetEntry> = { ...existing }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is a settings id, not a property name.
  delete next[id]
  return { presets: next }
}

/**
 * The saved runs, in the order the panel shows them.
 * @param presets - the map from settings.
 * @returns id/entry pairs sorted by id, so areas group themselves.
 */
export function listPresets(presets: PresetMap): readonly (readonly [string, PresetEntry])[] {
  return Object.entries(presets).sort(([a], [b]) => a.localeCompare(b))
}

/**
 * The saved runs as a report, grouped by area.
 * @param presets - the map from settings.
 * @returns markdown.
 */
export function renderPresets(presets: PresetMap): string {
  const rows = listPresets(presets)
  if (rows.length === 0) return '_No saved runs yet._'
  const lines: string[] = []
  let area = ''
  for (const [id, entry] of rows) {
    const here = id.split('/')[0] ?? ''
    if (here !== area) {
      area = here
      lines.push(`**${area}**`)
    }
    const auto = entry.autoAdvance === true ? ' · advances itself' : ''
    lines.push(`- \`${id}\` — ${entry.name}${auto}`)
  }
  return lines.join('\n')
}
