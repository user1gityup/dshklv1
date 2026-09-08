// @vitest-environment jsdom
/**
 * The pipeline control's send face must read `conversation` off the session
 * scope with `get`, never through the context proxy.
 *
 * Proxy access resolves the name against the scope's isolate table and threw
 * `cannot get property "conversation" without inject` on every send — with the
 * service declared in this plugin's inject, and with the app booted and the
 * service provided. ui-conversation's own `scopedConversation` uses `get` for
 * the same reason. This test fails the moment someone writes
 * `actx.conversation.send(...)` again: the stub scope throws on that property.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.ts'

/** One registered slot, as the plugin handed it to the registry. */
interface Registration {
  id: string
  inject?: (sessionId: string) => Record<string, unknown>
}

/**
 * Apply the plugin against a context stub and hand back what it registered.
 * @param scoped - what `sessions.scope(id)` resolves to.
 * @returns the pipeline control's registration.
 */
function applyWith(scoped: unknown): Registration {
  const registrations: Registration[] = []
  const ctx = {
    effect: (run: () => unknown) => { run() },
    locale: { register: () => () => {} },
    settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: () => Promise.resolve() }) },
    sessions: { scope: () => scoped },
    slots: {
      register: (options: Registration) => { registrations.push(options) },
      inject: (_name: string, run: () => void) => { run() },
    },
    inject: (_services: string[], run: (scope: unknown) => void) => { run(ctx) },
  } as unknown as ClientContext

  apply(ctx)
  const pipeline = registrations.find(entry => entry.id === 'pipeline-control')
  if (pipeline === undefined) throw new Error('pipeline-control was not registered')
  return pipeline
}

describe('pipeline control send face', () => {
  it('sends through the scope\'s get, not the context proxy', async () => {
    const send = vi.fn(async () => {})
    // A scope that throws on property access, exactly as cordis does for a
    // name its isolate table does not carry.
    const scoped = new Proxy({ get: (name: string) => (name === 'conversation' ? { send } : undefined) }, {
      get: (target, prop) => {
        if (prop === 'get') return Reflect.get(target, prop)
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })

    const face = applyWith(scoped).inject?.('session-1') as { send: (text: string) => Promise<void> }
    await face.send('hello')

    expect(send).toHaveBeenCalledWith('hello')
  })

  it('fails loud when the scope carries no conversation service', async () => {
    const scoped = { get: () => undefined }
    const face = applyWith(scoped).inject?.('session-1') as { send: (text: string) => Promise<void> }

    await expect(face.send('hello')).rejects.toThrow(/conversation service unavailable/)
  })

  it('fails loud when the session resolves no scope', async () => {
    const face = applyWith(undefined).inject?.('session-1') as { send: (text: string) => Promise<void> }

    await expect(face.send('hello')).rejects.toThrow(/resolved no scope/)
  })
})
