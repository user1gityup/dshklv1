/**
 * Claude quota panel, browser half.
 *
 * Registers one sidebar action showing the session and weekly quota the
 * `claude-quota` namespace carries. Order 0 puts it directly above the council
 * budget panel (order 1): the two answer different questions — what a council
 * run will cost, and how much subscription allowance is left to run it on —
 * and reading them together is the point of the placement.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the sidebar shell's SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings shell's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, en, zh, type QuotaKey } from './locales.ts'
import { ClaudeQuota } from './ClaudeQuota.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Claude quota panel copy. */
    'claude-quota': QuotaKey
  }
}

/** Required services. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionary and the sidebar action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-claude-quota: dictionaries')
  ctx.slots.register(
    {
      name: 'sidebar.region.action',
      // Above the council budget, which registers at order 1.
      id: 'claude-quota',
      order: 0,
      locale: NS,
      inject: () => ({
        // decode narrows the section from unknown: the panel reads named
        // fields, and an un-narrowed scope would make every read a cast.
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'claude-quota',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    ClaudeQuota,
  )
}
