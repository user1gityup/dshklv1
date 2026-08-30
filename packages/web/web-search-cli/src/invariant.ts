/** Package-owned invariant companion for the CLI-backed search provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-cli'

/** Cordis companion plugin name. */
export const name = 'web-search-cli-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: each search is one short-lived child process. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
