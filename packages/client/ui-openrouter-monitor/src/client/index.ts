/**
 * OpenRouter Monitor — sidebar footer action that shows OpenRouter
 * credit balance and per-model usage in a server-monitor-style popover.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the sidebar shell's SlotMap merge ('sidebar.footer.action').
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, en, zh, type MonitorKey } from './locales.ts'
import { OpenRouterMonitor } from './OpenRouterMonitor.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenRouter monitor copy. */
    'openrouter-monitor': MonitorKey
  }
}

/** Required services. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Client plugin body: register the dictionary and the sidebar footer action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-openrouter-monitor: dictionaries')
  ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'openrouter-monitor',
      order: 10,
      locale: NS,
      // Local per-model fold needs the conversation of the open session.
      inject: () => ({ sessions: ctx.sessions }),
    },
    OpenRouterMonitor,
  )
}
