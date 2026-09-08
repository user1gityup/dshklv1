import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { unreachableError } from '../src/council.ts'
import { loopbackBackend, probeSeat } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'

/** A CLI seat routed through a local proxy, like the free Claude seat. */
function proxiedSeat(baseUrl: string): SeatConfig {
  return {
    id: 'free-claude',
    name: 'Free Claude',
    transport: 'cli',
    command: 'claude',
    args: ['-p', '{prompt}'],
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'x' },
    enabled: true,
  }
}

describe('loopback backend detection', () => {
  it('finds the port a proxied CLI seat routes through', () => {
    expect(loopbackBackend(proxiedSeat('http://127.0.0.1:8082'))).toEqual({
      host: '127.0.0.1',
      port: 8082,
      origin: 'http://127.0.0.1:8082',
    })
  })

  it('defaults the port from the scheme', () => {
    expect(loopbackBackend(proxiedSeat('http://localhost'))?.port).toBe(80)
  })

  // Probing a remote host would let one slow network drop a working seat.
  it('ignores a remote backend', () => {
    expect(loopbackBackend(proxiedSeat('https://api.anthropic.com'))).toBeUndefined()
  })

  it('ignores a seat with no backend of its own', () => {
    const plain: SeatConfig = { id: 'claude', name: 'Claude', transport: 'cli', command: 'claude', enabled: true }
    expect(loopbackBackend(plain)).toBeUndefined()
  })

  it('ignores an OpenRouter seat', () => {
    const hosted: SeatConfig = { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true }
    expect(loopbackBackend(hosted)).toBeUndefined()
  })
})

describe('seat probe', () => {
  it('passes a seat whose backend is listening', async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    try {
      expect(await probeSeat(proxiedSeat(`http://127.0.0.1:${String(port)}`))).toBeUndefined()
    } finally {
      server.close()
    }
  })

  // The whole point: a refused connect must be the answer, not a 180s retry.
  it('reports a backend that is not listening, fast', async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    const started = Date.now()
    const problem = await probeSeat(proxiedSeat(`http://127.0.0.1:${String(port)}`))
    expect(problem).toContain('not accepting connections')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('passes a seat there is nothing local to probe', async () => {
    expect(await probeSeat(proxiedSeat('https://api.anthropic.com'))).toBeUndefined()
  })
})

describe('unreachable failures', () => {
  it('recognises a refused connection', () => {
    expect(unreachableError('API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)')).toBe(true)
    expect(unreachableError('connect ECONNREFUSED 127.0.0.1:8082')).toBe(true)
  })

  // A model failure says nothing about the backend, so the seat keeps its turn.
  it('leaves an ordinary model failure alone', () => {
    expect(unreachableError('the model returned no text')).toBe(false)
    expect(unreachableError(undefined)).toBe(false)
  })
})
