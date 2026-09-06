/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-claude-quota`.
 * @module @deepseek-ai/dsh-client-ui-claude-quota/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-claude-quota'

/** Cordis companion plugin name. */
export const name = 'client-ui-claude-quota-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a read-only projection of the
 * `claude-quota` settings namespace onto one sidebar slot entry. It emits no
 * cordis events, and its single write is one scalar field the host half acts
 * on; the slot registration proves disposal through the HMR-safety spec.
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
