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
// Type-only: pulls the conversation service's Context merge (ctx.conversation),
// which the pipeline control's send face reaches through a session scope.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, en, zh, type BudgetKey } from './locales.ts'
import { CouncilBudget } from './CouncilBudget.tsx'
import { CouncilToggle } from './CouncilToggle.tsx'
import { CouncilCallView } from './CouncilCallView.tsx'
import { GateStrip } from './GateStrip.tsx'
import { PipelineControl } from './PipelineControl.tsx'
import { SwarmRoster } from './SwarmRoster.tsx'
import { SwarmToggle } from './SwarmToggle.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Council budget panel copy. */
    'council-budget': BudgetKey
  }
}

/**
 * Required services.
 *
 * `conversation` is here because the pipeline control sends its own prompt.
 * Cordis refuses a property read on a service this plugin never declared —
 * `cannot get property "conversation" without inject` — and that refusal
 * happens inside the send, so the panel's Run button appeared to do nothing at
 * all. Declaring it is what makes the send reachable; the visible failure line
 * in PipelineControl is what made the cause findable.
 */
export const inject = ['slots', 'sessions', 'locale', 'settingsScope', 'conversation']

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

  // The pipeline control is pinned to the top of the column, not docked above
  // the composer. A run outlives the messages it produces — it holds, counts
  // down and self-restarts across a whole conversation — so its control has to
  // stay in one findable place while the transcript grows underneath it. The
  // dock could not do that: it rides the hero to mid-column on a blank session
  // and sinks to the floor once messages arrive. It carries its own send face:
  // the chain is a tool, and a tool can only be reached by asking for it, so
  // the button says the asking — visibly, rather than as a hidden prompt.
  ctx.slots.register(
    {
      name: 'conversation.column.top',
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
        //
        // The service is read with the session scope's own `get`, not through
        // the context proxy. Proxy access resolves the name against the
        // scope's isolate table and threw `cannot get property "conversation"
        // without inject` from inside every send — declaring the service in
        // this plugin's `inject` did not change that, because the miss is in
        // the isolate mapping, not in the declaration. `get` reads the impl
        // off the rebound context directly, which is what ui-conversation's
        // own `scopedConversation` does for the same reason.
        send: async (text: string) => {
          const actx = ctx.sessions.scope(sessionId)
          if (actx === undefined) throw new Error(`ui-council-budget: session "${String(sessionId)}" resolved no scope`)
          const conversation = actx.get('conversation')
          if (conversation === undefined) {
            throw new Error('ui-council-budget: conversation service unavailable through the session scope')
          }
          await conversation.send(text)
        },
      }),
    },
    PipelineControl,
  )

  // The gate strip sits directly above the pipeline control, on the same
  // reasoning: a run's Approve button is rendered on the call that issued the
  // plan, which is thousands of words up the transcript by the time the report
  // has finished. The strip is the pointer to it — what is waiting, how long
  // is left, and the same two actions — in the one place that does not scroll
  // away. It renders nothing while no gate is open.
  ctx.slots.register(
    {
      name: 'conversation.column.top',
      id: 'council-gate-strip',
      order: 6,
      locale: NS,
      inject: sessionId => ({
        settings: ctx.settingsScope.bind<Record<string, unknown>>({
          namespace: 'council',
          decode: section =>
            typeof section === 'object' && section !== null ? section as Record<string, unknown> : {},
        }),
        // Same session-scoped read as the pipeline control above: the root
        // context's `conversation` throws, because a prompt has to be
        // addressed to a session.
        send: async (text: string) => {
          const actx = ctx.sessions.scope(sessionId)
          if (actx === undefined) throw new Error(`ui-council-budget: session "${String(sessionId)}" resolved no scope`)
          const conversation = actx.get('conversation')
          if (conversation === undefined) {
            throw new Error('ui-council-budget: conversation service unavailable through the session scope')
          }
          await conversation.send(text)
        },
      }),
    },
    GateStrip,
  )
}
