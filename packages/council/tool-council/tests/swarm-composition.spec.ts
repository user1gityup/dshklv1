import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Settings from '@deepseek-ai/dsh-settings-file'
import Web from '@deepseek-ai/dsh-web'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as Council from '../src/index.ts'
import { askSeat } from '../src/seats.ts'
vi.mock('../src/seats.ts', async original => ({ ...await original<typeof import('../src/seats.ts')>(), askSeat: vi.fn() }))
let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

it('runs the economy swarm through the Loader and real tool registry without paid requests', async () => {
  await mkdir('.dsh-build', { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.dsh-build', 'swarm-profile-'))
  vi.stubEnv('SWARM_TEST_KEY', 'test-only')
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { headers: { 'Content-Type': 'application/json' } }))
  vi.mocked(askSeat).mockImplementation(async (seat, prompt) => ({ seat: seat.id, ms: 0,
    text: prompt.startsWith('Break the request') ? JSON.stringify([{ id: 'answer', title: 'write answer', detail: 'Answer 4', dependsOn: [], acceptance: ['Answer is 4'] }])
      : prompt.startsWith('Review this unit') ? 'ACCEPT: yes\nAnswer is 4.'
        : prompt.startsWith('Choose the best') ? 'VOTE: free-a\nCONFIDENCE: 1\nCRITIQUE: correct' : '4',
  }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'sessions' }, { name: 'agents' }, { name: 'prompt' }, { name: 'tools' }, { name: 'web' },
    { name: 'settings', config: { path: join(root, 'settings.json'), watch: false } },
    { name: 'council', config: { autoApprove: true, swarmProfile: 'economy', apiKeyEnv: 'SWARM_TEST_KEY',
      seats: Object.fromEntries(['claude', 'openai', 'kimi', 'deepseek', 'free-claude', 'openrouter-free'].map(id => [id, { enabled: false }])),
      extraSeats: { 'free-a': { model: 'test-a', free: true }, 'free-b': { model: 'test-b', free: true }, paid: { model: 'test-paid' } },
    } },
  ]))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['sessions', Sessions], ['agents', Agents], ['prompt', Prompt], ['tools', Tools], ['settings', Settings], ['web', Web], ['council', Council]])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(name); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const app = ctx
  const session = app.sessions.create(undefined, { meta: { cwd: root } })
  const agent = { id: session.id, session, options: {} } as Agent
  const result = await app.agents.withInitiator(agent, () => app.tools.execute({ agent, signal: new AbortController().signal, callId: CallId('profile'), name: 'swarm', arguments: { query: 'What is 2 + 2?' } }))
  expect(JSON.stringify(result)).toContain('Paid review: ACCEPT: yes')
  expect(JSON.stringify(result.content)).toMatchSnapshot()
}, 30_000)
