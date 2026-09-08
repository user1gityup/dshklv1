import { describe, expect, it } from 'vitest'
import { acceptedPieces, mergePlan } from '../src/merge.ts'
import type { SeatReply, SeatConfig } from '../src/seats.ts'

const reply = (seat: string, text: string): SeatReply => ({ seat, text, ms: 1 })
const drafts = [reply('winner', 'Keep the winning approach.'), reply('rival', 'Add a rollback test.')]
const nomination = JSON.stringify([{ source: 'rival', quote: 'Add a rollback test.' }])
const seats: SeatConfig[] = ['winner', 'rival', 'third'].map(id => ({ id, name: id, transport: 'openrouter', enabled: true }))

describe('plan merging', () => {
  it('requires distinct supporters and exact attributed source text', () => {
    expect(acceptedPieces([reply('a', nomination), reply('a', nomination)], drafts, 'winner')).toEqual([])
    expect(acceptedPieces([reply('a', nomination), reply('b', nomination)], drafts, 'winner')).toEqual([
      { source: 'rival', quote: 'Add a rollback test.', supporters: ['a', 'b'] },
    ])
    for (const text of ['invalid', '{}', '[null]', '[{"source":"missing","quote":"Add a rollback test."}]', '[{"source":"rival","quote":"invented"}]']) {
      expect(acceptedPieces([reply('a', text), reply('b', text)], drafts, 'winner')).toEqual([])
    }
  })

  it('asks every seat to nominate but only the winner to integrate', async () => {
    const calls: string[] = []
    const result = await mergePlan('request', drafts[0]!, drafts, seats, async (seat) => {
      calls.push(seat.id)
      return reply(seat.id, calls.length <= 3 ? nomination : 'Keep the winning approach. Add a rollback test (rival).')
    }, true)
    expect(calls).toEqual(['winner', 'rival', 'third', 'winner'])
    expect(result.plan).toContain('(rival)')
    expect(result.accepted[0]?.supporters).toEqual(['winner', 'rival', 'third'])
  })

  it('retains the voted plan when nominations fail or integration is empty', async () => {
    let calls = 0
    const unchanged = await mergePlan('request', drafts[0]!, drafts, seats, async seat => reply(seat.id, '[]'))
    expect(unchanged.plan).toBe(drafts[0]?.text)
    expect(unchanged.integration).toBeUndefined()
    const failed = await mergePlan('request', drafts[0]!, drafts, seats, async seat => reply(seat.id, ++calls <= 3 ? nomination : ' '), true)
    expect(failed.plan).toBe(drafts[0]?.text)
  })
})
