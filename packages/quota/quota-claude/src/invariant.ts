/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-quota-claude`.
 * @module @deepseek-ai/dsh-quota-claude/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-quota-claude'

/** Cordis companion plugin name. */
export const name = 'quota-claude-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package emits no cordis events and owns no
 * cross-plugin mutable state. Its only durable writes are scalar fields in the
 * `claude-quota` settings namespace, whose revision fencing, schema resolution
 * and change notification belong to the settings provider; its one subscription
 * is a `SettingsScope.watch` registered through `ctx.effect`, which proves
 * disposal through the HMR-safety spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
