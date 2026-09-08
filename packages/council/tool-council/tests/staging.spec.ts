import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Fs from '@deepseek-ai/dsh-fs-sandbox'
import { parseStagingFiles, registerStaging, sandboxWriteSeam } from '../src/staging.ts'

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

async function load() {
  await mkdir('.dsh-build', { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.dsh-build', 'staging-check-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- name: sessions', '- name: agents', '- name: prompt', '- name: tools',
    '- name: policy', '  config:', '    requireWriteConfirmation: true', '    confinedOnly: true',
    '- name: fs', `  config: { cwd: ${JSON.stringify(workspace)} }`,
    '- name: staging', '',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['agents', AgentRegistry], ['prompt', SystemPrompt], ['tools', Tools], ['policy', Policy], ['fs', Fs],
    ['staging', { name: 'staging-test-entry', inject: ['tools', 'agents', 'fs', 'sandboxPolicy'], apply: registerStaging }],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`Unexpected module ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const session = ctx.sessions.create(undefined, { meta: { cwd: workspace } })
  const agent = { id: session.id, session, options: {} } as Agent
  return { app: ctx, workspace, agent }
}

describe('API work staging', () => {
  it.each(['../escape.py', '/absolute.py', 'C:/escape.py', 'a\\b.py', 'x:stream', 'a/../b', 'NUL', 'a.'])('rejects %s before writing', (path) => {
    expect(() => parseStagingFiles(JSON.stringify({ [path]: 'code' }))).toThrow('Invalid staging')
  })
  it('rejects duplicate spellings and non-text payloads', () => {
    expect(() => parseStagingFiles('{"a.py":"x","A.py":"y"}')).toThrow('Duplicate')
    expect(() => parseStagingFiles('{"a.py":4}')).toThrow('Invalid')
    expect(parseStagingFiles('{"src/a.py":"print(1)"}')).toEqual([['src/a.py', 'print(1)']])
  })
  it('boots the real Loader, gates the tool, stages without CLI calls, and refuses outside writes', async () => {
    const { app, workspace, agent } = await load()
    let n = 0
    const invoke = () => app.agents.withInitiator(agent, () => app.tools.execute({
      agent, signal: new AbortController().signal, callId: CallId(`stage-${++n}`), name: 'stage_work',
      arguments: { files_json: '{"src/app.py":"print(1)"}' },
    }))
    const denied = await invoke()
    expect(JSON.stringify(denied)).toContain('go before staging')
    expect(existsSync(join(workspace, '.dsh-staging'))).toBe(false)
    app.sandboxPolicy.approveWorkspaceWrites(agent.session)
    expect(JSON.stringify(await invoke())).toContain('go before staging')
    const human = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await agentEvents(app, agent).waterfall('agent/pre-step', {
      messages: [human], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [human] }))
    const result = await invoke()
    expect(JSON.stringify(result)).toContain('Staged 1 file')
    expect(JSON.stringify(result.content)
      .replaceAll(JSON.stringify(root).slice(1, -1), '<ROOT>')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<BATCH>')
      .replaceAll('\\\\', '/')).toMatchSnapshot()
    const { readdir } = await import('node:fs/promises')
    const batches = await readdir(join(workspace, '.dsh-staging'))
    expect(batches).toHaveLength(1)
    expect(await readFile(join(workspace, '.dsh-staging', batches[0]!, 'src/app.py'), 'utf8')).toBe('print(1)')
    const outside = join(root!, 'outside.py')
    await expect(sandboxWriteSeam(app.fs, app.sandboxPolicy, agent.session).write(outside, 'bad')).rejects.toThrow('inside the session workspace')
    expect(existsSync(outside)).toBe(false)
    app.sandboxPolicy.revokeWorkspaceWrites(agent.session)
    expect(JSON.stringify(await invoke())).toContain('go before staging')
    const stagingEntry = [...app.loader.entries()].find(entry => entry.options.name === 'staging')
    await stagingEntry?.fiber?.dispose()
    expect(JSON.stringify(await invoke())).not.toContain('Staged 1 file')
  }, 30_000)
})
