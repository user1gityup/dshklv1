/** Package-owned invariant companion for the council tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-council'

/** Cordis companion plugin name. */
export const name = 'tool-council-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the council owns no durable state between calls. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
