/** API-authored code staged through the DSH filesystem, without starting a CLI seat. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { WriteSeam } from './writes.ts'

/**
 * Route proposal writes through the active session's sandbox on every file.
 * @param fs - mounted confined filesystem.
 * @param policy - deployment policy and write gate.
 * @param session - session owning this batch, captured before asynchronous work.
 * @returns a writer that never grants itself broader access.
 */
export function sandboxWriteSeam(fs: FileSystem, policy: SandboxPolicyService, session: Session): WriteSeam {
  return {
    async write(path, text) {
      const access = policy.resolve({ session })
      if (access.mode !== 'workspace-write' || fs.sandboxMode === undefined || fs.sandboxMode === 'danger-full-access') {
        throw new Error('Staging requires a confined filesystem and workspace-write approval followed by go in this session.')
      }
      const target = await fs.resolve(path, { cwd: access.workspaceRoot })
      if (!fs.contains(await fs.resolve(access.workspaceRoot), target)) throw new Error('Staged files must remain inside the session workspace.')
      await fs.writeText(target, text, undefined, undefined, policy.resolve({ session }))
    },
  }
}

/**
 * Validate a complete staging batch before creating any file.
 * @param json - object mapping portable relative file paths to full contents.
 * @returns validated file entries.
 */
export function parseStagingFiles(json: string): [string, string][] {
  if (json.length > 1_000_000) throw new Error('Stage at most 1,000,000 characters per batch.')
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('files_json must be an object mapping relative paths to text.')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 100) throw new Error('Stage between 1 and 100 files per batch.')
  const seen = new Set<string>()
  return entries.map(([path, content]) => {
    if (typeof content !== 'string' || path === '' || path.includes('\\')
      || path.split('/').some(part => part === '' || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part)
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`Invalid staging file: ${path}. Use relative paths with / separators and text contents.`)
    }
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate staging path: ${path}`)
    seen.add(path.toLowerCase())
    return [path, content]
  })
}

/**
 * Register the no-CLI route for API agents to leave code for later implementation.
 * @param ctx - context with tool registry, agents, filesystem and sandbox policy.
 */
export function registerStaging(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'stage_work',
    description: 'Save code already produced by API agents for later review or implementation, even when CLI seats are unavailable. Requires workspace-write approval and then exactly go in this session. Writes a fresh batch under .dsh-staging in the session workspace; never applies it to another repository or starts another agent.',
    parameters: {
      files_json: { type: 'string', required: true, description: 'JSON object mapping relative paths such as src/app.py to complete UTF-8 file contents. Maximum 100 files and 1,000,000 characters.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const session = ctx.agents.requireInitiator().session
      const access = ctx.sandboxPolicy.resolve({ session })
      if (access.mode !== 'workspace-write') throw new Error('Select workspace-write in this session\'s permission control, then send exactly go before staging code.')
      const entries = parseStagingFiles(args.files_json)
      const root = join(access.workspaceRoot, '.dsh-staging', randomUUID())
      const writer = sandboxWriteSeam(ctx.fs, ctx.sandboxPolicy, session)
      const written: string[] = []
      try {
        for (const [path, content] of entries) {
          const destination = join(root, path)
          await writer.write(destination, content)
          written.push(destination)
        }
      } catch (error) {
        throw new Error(`Staging stopped after ${written.length} file(s) in ${root}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { report: `Staged ${written.length} file(s) for later review. No CLI seat was started and no destination repository was updated.\n\n${written.map(path => `- ${path}`).join('\n')}` }
    },
  }))
}
