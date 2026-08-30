/**
 * Council budget panel, browser half.
 *
 * Registers one sidebar footer action showing what the current council
 * configuration costs and buys, with seat and tool toggles that write through
 * the shared `council` settings namespace.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the sidebar shell's SlotMap merge ('sidebar.footer.action').
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings shell's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, en, zh, type BudgetKey } from './locales.ts'
import { CouncilBudget } from './CouncilBudget.tsx'
import { CouncilToggle } from './CouncilToggle.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Council budget panel copy. */
    'council-budget': BudgetKey
  }
}

/** Required services. */
export const inject = ['slots', 'sessions', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionary and the footer action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-council-budget: dictionaries')
  ctx.slots.register(
    {
      name: 'sidebar.region.action',
      id: 'council-budget',
      order: 1,
      locale: NS,
      // The panel needs live session projections and the council's settings.
      inject: () => ({
        sessions: ctx.sessions,
        // decode narrows the section from unknown: the panel reads named
        // fields, and an un-narrowed scope would make every read a cast.
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    CouncilBudget,
  )

  // A second seat for the one control worth reaching while composing. The
  // panel owns configuration; this owns the switch.
  ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'council-toggle',
      order: 5,
      locale: NS,
      inject: () => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    CouncilToggle,
  )
}
