/** Package-owned invariant companion for the council budget panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-council-budget'

/** Cordis companion plugin name. */
export const name = 'ui-council-budget-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the panel owns no durable state of its own. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
