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
import { CouncilCallView } from './CouncilCallView.tsx'
import { PipelineControl } from './PipelineControl.tsx'
import { SwarmRoster } from './SwarmRoster.tsx'
import { SwarmToggle } from './SwarmToggle.tsx'

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

  // The spending gate lives on the call that issued the plan, not floating
  // above the composer: an approval control detached from the thing it
  // approves is ambiguous once the message scrolls away.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    {
      name: 'tool.call.toolview',
      key: 'council',
      locale: NS,
      inject: () => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    CouncilCallView,
  ))

  // The swarm gate is the same control on a different call: the report and the
  // Approve button behave identically, and only the settings keys differ, so
  // the view reads which gate a call belongs to off its own marker.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    {
      name: 'tool.call.toolview',
      key: 'swarm',
      locale: NS,
      inject: () => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    CouncilCallView,
  ))

  // Swarm mode gets its own switch: it is a larger commitment than council
  // mode, and burying it inside that one would hide the difference.
  ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'swarm-toggle',
      order: 6,
      locale: NS,
      inject: () => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    SwarmToggle,
  )

  ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'swarm-roster',
      order: 6,
      locale: NS,
      inject: () => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
      }),
    },
    SwarmRoster,
  )

  // The pipeline control sits with the roster because it commits the same
  // seats to a longer run. It carries its own send face: the chain is a tool,
  // and a tool can only be reached by asking for it, so the button says the
  // asking — visibly, above the composer, rather than as a hidden prompt.
  ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'pipeline-control',
      order: 7,
      locale: NS,
      inject: sessionId => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
        // The slot frame hands an id, not a context: `conversation.send` off the
        // ROOT context throws, because a prompt has to be addressed to a session.
        send: async (text: string) => {
          const actx = ctx.sessions.scope(sessionId)
          if (actx === undefined) throw new Error(`ui-council-budget: session "${String(sessionId)}" resolved no scope`)
          await actx.conversation.send(text)
        },
      }),
    },
    PipelineControl,
  )
}
