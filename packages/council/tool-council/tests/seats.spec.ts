import { describe, expect, it } from 'vitest'
import { DEFAULT_SEATS, askCliSeat } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'

/**
 * A child that reports exactly how it was invoked: the argv it received and
 * everything that arrived on stdin. Both halves are needed, because the bug
 * this covers is a prompt silently changing channel.
 */
const REPORTER = `
const chunks = []
let done = false
const report = () => {
  if (done) return
  done = true
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(1),
    stdin: Buffer.concat(chunks).toString('utf8'),
  }))
}
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', report)
process.stdin.on('error', report)
setTimeout(report, 2000)
`

/** A CLI seat backed by the reporter script above. */
function reporterSeat(overrides: Partial<SeatConfig> = {}): SeatConfig {
  return {
    id: 'claude',
    name: 'Reporter',
    transport: 'cli',
    command: process.execPath,
    args: ['-e', REPORTER, 'flag', '{prompt}'],
    enabled: true,
    ...overrides,
  }
}

/** Run a seat and parse what the child reported. */
async function invoke(seat: SeatConfig, prompt: string): Promise<{ args: string[]; stdin: string }> {
  const reply = await askCliSeat(seat, prompt, undefined, 30_000)
  expect(reply.error).toBeUndefined()
  return JSON.parse(reply.text) as { args: string[]; stdin: string }
}

// Over both platform caps (24000 on Windows, 96000 elsewhere), so the switch
// happens wherever this suite runs.
const HUGE = 'x'.repeat(120_000)

describe('askCliSeat prompt delivery', () => {
  it('passes a normal prompt as argv and leaves stdin closed', async () => {
    const seen = await invoke(reporterSeat(), 'a short question')
    expect(seen.args).toEqual(['flag', 'a short question'])
    expect(seen.stdin).toBe('')
  })

  it('moves a prompt too long for the command line onto stdin', async () => {
    // The regression: a five-seat review prompt carries every draft, passed
    // 32767 characters, and spawn failed with ENAMETOOLONG for all three CLI
    // seats at once.
    const seen = await invoke(reporterSeat(), HUGE)
    expect(seen.args).toEqual(['flag'])
    expect(seen.stdin).toBe(HUGE)
  })

  it('substitutes the CLI\'s own stdin token when it has one', async () => {
    const seen = await invoke(reporterSeat({ stdinPromptArg: '-' }), HUGE)
    expect(seen.args).toEqual(['flag', '-'])
    expect(seen.stdin).toBe(HUGE)
  })

  it('keeps the context-file flag when the prompt moves to stdin', async () => {
    const seat = reporterSeat({ contextFileFlag: '--context' })
    const reply = await askCliSeat(seat, HUGE, undefined, 30_000, 'C:/digest.md')
    const seen = JSON.parse(reply.text) as { args: string[]; stdin: string }
    expect(seen.args).toEqual(['flag', '--context', 'C:/digest.md'])
    expect(seen.stdin).toBe(HUGE)
  })
})

describe('shipped seat defaults', () => {
  it('gives codex the stdin token it needs and claude none', () => {
    const codex = DEFAULT_SEATS.find(seat => seat.id === 'openai')
    const claude = DEFAULT_SEATS.find(seat => seat.id === 'claude')
    // `codex exec -` reads the prompt from stdin; `claude -p` reads it when no
    // prompt argument follows, so an added token would be read as a prompt.
    expect(codex?.stdinPromptArg).toBe('-')
    expect(claude?.stdinPromptArg).toBeUndefined()
  })

  it('gives the claude seat room to finish a researched round', () => {
    // It was killed at the run's 180s default with nothing to show.
    const claude = DEFAULT_SEATS.find(seat => seat.id === 'claude')
    expect(claude?.timeoutMs).toBeGreaterThanOrEqual(300_000)
  })
})
