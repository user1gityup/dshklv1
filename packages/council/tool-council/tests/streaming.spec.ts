/**
 * The streamed OpenRouter transport.
 *
 * A hosted seat used to be one non-streaming POST, which meant a long answer
 * was an idle socket: measured 2026-09-07, one seat was cut off at the
 * timeout and another died with `fetch failed caused by other side closed`
 * mid-round. A stream keeps bytes moving, and its own idle timer — not the
 * whole-call cap — is what decides a stalled provider.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { askSeat } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'

const KIMI: SeatConfig = {
  id: 'kimi',
  name: 'Kimi',
  transport: 'openrouter',
  model: 'moonshotai/kimi-k2',
  enabled: true,
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Serve `pieces` as a streamed response body, one chunk at a time. */
function streamOf(pieces: readonly string[], gapMs = 0): void {
  globalThis.fetch = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        for (const piece of pieces) {
          if (gapMs > 0) await new Promise(resolve => setTimeout(resolve, gapMs))
          controller.enqueue(encoder.encode(piece))
        }
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof globalThis.fetch
}

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ model: 'moonshotai/kimi-k2', choices: [{ delta }] })}\n\n`
}

describe('streamed hosted seats', () => {
  it('assembles the deltas into one answer', async () => {
    streamOf([
      chunk({ content: 'Electron, ' }),
      chunk({ content: 'because frameless.' }),
      `data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 800, cost: 0.0042 } })}\n\n`,
      'data: [DONE]\n\n',
    ])

    const reply = await askSeat(KIMI, 'question', 'key', undefined, 5_000)

    expect(reply.error).toBeUndefined()
    expect(reply.text).toBe('Electron, because frameless.')
    expect(reply.usage?.costUsd).toBe(0.0042)
    expect(reply.usage?.outputTokens).toBe(800)
  })

  // The keep-alive comments are the point of streaming: bytes on a socket
  // that would otherwise sit idle long enough for something to close it.
  it('ignores keep-alive comments', async () => {
    streamOf([': OPENROUTER PROCESSING\n\n', chunk({ content: 'ok' }), ': OPENROUTER PROCESSING\n\n', 'data: [DONE]\n\n'])

    expect((await askSeat(KIMI, 'q', 'key', undefined, 5_000)).text).toBe('ok')
  })

  // Network chunks do not respect line boundaries.
  it('reassembles an event split across two chunks', async () => {
    const whole = chunk({ content: 'split answer' })
    streamOf([whole.slice(0, 20), whole.slice(20), 'data: [DONE]\n\n'])

    expect((await askSeat(KIMI, 'q', 'key', undefined, 5_000)).text).toBe('split answer')
  })

  // A provider that ignores `stream` answers with a whole message.
  it('accepts a non-streamed message shape', async () => {
    streamOf([`data: ${JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] })}\n\n`, 'data: [DONE]\n\n'])

    expect((await askSeat(KIMI, 'q', 'key', undefined, 5_000)).text).toBe('whole answer')
  })

  it('keeps a reasoning-only answer rather than reporting it empty', async () => {
    streamOf([chunk({ reasoning: 'thinking out loud' }), 'data: [DONE]\n\n'])

    expect((await askSeat(KIMI, 'q', 'key', undefined, 5_000)).text).toBe('thinking out loud')
  })

  it('records the urls the provider says it consulted', async () => {
    streamOf([
      chunk({ content: 'sourced', annotations: [{ url_citation: { url: 'https://example.invalid/a' } }] }),
      'data: [DONE]\n\n',
    ])

    expect((await askSeat(KIMI, 'q', 'key', undefined, 5_000)).citedUrls).toEqual(['https://example.invalid/a'])
  })

  it('gives up on a stream that goes silent, without waiting out the whole cap', async () => {
    streamOf([chunk({ content: 'starts fine' }), chunk({ content: ' then stalls' })], 400)
    const impatient: SeatConfig = { ...KIMI, idleMs: 120 }

    const started = Date.now()
    const reply = await askSeat(impatient, 'q', 'key', undefined, 60_000)

    expect(reply.error).toMatch(/silent|abort/i)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
