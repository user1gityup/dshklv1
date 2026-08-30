/** Package-owned invariant companion for cross-session agent memory. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-memory'

/** Cordis companion plugin name. */
export const name = 'agent-memory-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the storage domain owns durability relations. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
