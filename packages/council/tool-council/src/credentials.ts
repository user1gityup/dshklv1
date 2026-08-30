/**
 * OpenRouter key resolution.
 *
 * The harness deliberately never materialises its managed credential document
 * into `process.env`, so a plugin that only reads the environment finds nothing
 * for a key the user entered through the UI. This resolver therefore checks the
 * environment first, then the managed document, matching the harness's own
 * documented precedence.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Environment variable the OpenRouter provider conventionally uses. */
export const DEFAULT_KEY_ENV = 'OPENROUTER_API_KEY'

/** Inputs for key resolution, injectable so tests never touch a real home. */
export interface KeyLookup {
  /** Environment to consult first. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Variable name holding the key. */
  readonly variable?: string | undefined
  /** Harness home; defaults to `$DSH_HOME` then `~/.dsh`. */
  readonly home?: string | undefined
}

/** Resolve the harness home the same way the launcher does. */
function resolveHome(env: Readonly<Record<string, string | undefined>>, explicit: string | undefined): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Read one credential reference out of the managed document.
 *
 * The document is small, flat YAML (`refs:` mapping names to values), so a
 * line scan is both sufficient and avoids taking a YAML dependency for one
 * lookup. Anything unparseable yields `undefined` rather than throwing: a
 * missing key is a reportable seat failure, not a crash.
 * @param path - absolute path to `.credentials.yaml`.
 * @param variable - reference name to read.
 * @returns the value, or `undefined` when absent or unreadable.
 */
function readManagedCredential(path: string, variable: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    if (match[1] !== variable) continue
    const raw = (match[2] ?? '').trim()
    if (raw === '') return undefined
    // Strip one matched pair of surrounding quotes, if present.
    const unquoted = /^(['"])(.*)\1$/.exec(raw)
    return unquoted === null ? raw : unquoted[2]
  }
  return undefined
}

/**
 * Resolve the OpenRouter key from the environment, then the managed document.
 * @param lookup - environment, variable name, and home overrides.
 * @returns the key, or `undefined` when no source supplies one.
 */
export function resolveOpenRouterKey(lookup: KeyLookup = {}): string | undefined {
  const env = lookup.env ?? process.env
  const variable = lookup.variable ?? DEFAULT_KEY_ENV
  const fromEnv = env[variable]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const home = resolveHome(env, lookup.home)
  return readManagedCredential(join(home, '.credentials.yaml'), variable)
}
