// Proves the council's seats actually work, end to end.
//
// Four things, each of which has broken at least once:
//
//   build   - the COMPILED artifact exists, not just the source
//   resolve - every CLI seat's binary is findable from its bare name
//   proxies - each configured local proxy is ready, not merely listening
//   answer  - each CLI seat replies to a real prompt inside its own timeout
//
// By default it asks only the seats that cost nothing at all. Pass `--paid` to
// include the subscription CLI seats as well: those bill no money, but they do
// draw on a finite monthly allowance, and a check that quietly spends it is not
// one you would run twice. OpenRouter seats are reported and never called.
//
// Run it from the DSH checkout, with DSH_ROOT set:
//
//   node --import tsx/esm <this repo>/scripts/verify-seats.mjs [--paid]
//
// scripts/verify-seats.cmd does that for you.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)

const DSH_ROOT = process.env.DSH_ROOT
if (!DSH_ROOT) {
  console.error('DSH_ROOT is not set. Copy scripts/dsh-env.example.cmd to dsh-env.cmd, or set it in the environment.')
  process.exit(2)
}

// Prefer the plugin as installed into the harness; fall back to this
// checkout, so the script is useful before the copy step has been done.
const INSTALLED = join(DSH_ROOT, 'packages/council/tool-council')
const PLUGIN = existsSync(INSTALLED) ? INSTALLED : join(REPO, 'packages/council/tool-council')
const SEATS_SRC = join(PLUGIN, 'src/seats.ts')
const COMPILED = join(PLUGIN, 'lib/index.js')

/** Proxies the launcher knows about, and the seats that depend on them. */
const PROXIES = [
  { id: 'fcc', label: 'Free Claude', dirEnv: 'FCC_DIR', port: 8082 },
  { id: 'openrouter-free', label: 'OpenRouter Free', dirEnv: 'ORFREE_DIR', port: 8080 },
]

const results = []

/**
 * Record one check.
 * @param name - what is being asserted.
 * @param ok - whether it held.
 * @param detail - evidence, shown either way.
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` - ${detail}`}`)
}

console.log('\n=== 1. compiled artifact ===')
const compiled = existsSync(COMPILED) ? readFileSync(COMPILED, 'utf8') : ''
check('lib/index.js exists', compiled !== '', compiled === '' ? `not found at ${COMPILED}; run pnpm build` : `${PLUGIN}`)
if (compiled !== '') {
  check(
    'stdin is closed or conditional for CLI seats',
    /stdio:\s*\[\s*(?:"ignore"|[^,\]]*\?\s*"ignore"\s*:\s*"pipe")/.test(compiled),
    'an unconditional open stdin pipe deadlocks `codex exec` until the timeout',
  )
  check(
    'an unreachable proxy is skipped, not waited on',
    compiled.includes('not accepting connections'),
    'a stopped local proxy otherwise costs each round its full retry window',
  )
}

console.log('\n=== 2. seat definitions ===')
const { askCliSeat, resolveRealExecutable, DEFAULT_SEATS } = await import(pathToFileURL(SEATS_SRC).href)
const cliSeats = DEFAULT_SEATS.filter(seat => seat.transport === 'cli')
const hostedSeats = DEFAULT_SEATS.filter(seat => seat.transport !== 'cli')
check('seat table loads', DEFAULT_SEATS.length > 0, `${cliSeats.length} CLI, ${hostedSeats.length} hosted`)
check(
  'no machine-specific path pinned in any seat',
  DEFAULT_SEATS.every(seat => seat.command === undefined || !/[\\/]/.test(seat.command)),
  'resolution is code-side, so a CLI update cannot stale it',
)

console.log('\n=== 3. binary resolution ===')
const resolvable = new Map()
for (const seat of cliSeats) {
  const resolved = resolveRealExecutable(seat.command)
  const ok = typeof resolved === 'string' && existsSync(resolved)
  resolvable.set(seat.id, ok)
  check(`${seat.id}: \`${seat.command}\` resolves`, ok, resolved ?? 'not found on PATH - that seat will drop out')
}

console.log('\n=== 4. local proxies ===')

/** True when something is listening on a port. */
function portOpen(port) {
  const probe = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',${port}); $c.Close(); exit 0 } catch { exit 1 }`,
  ], { encoding: 'utf8' })
  return probe.status === 0
}

/** Ask the launcher's controller whether a proxy is ready, starting it if not. */
function proxyReady(proxy) {
  const run = action => spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'proxy-control.ps1'),
    '-Proxy', proxy.id, '-Action', action,
  ], { encoding: 'utf8' })
  if (run('status').status === 0) return true
  console.log(`  ${proxy.label} not ready, starting it the way the launcher does...`)
  return run('start').status === 0
}

const proxyOk = new Map()
for (const proxy of PROXIES) {
  if (!process.env[proxy.dirEnv]) {
    console.log(`  [skip] ${proxy.label} - ${proxy.dirEnv} unset, so its seat is not in use`)
    proxyOk.set(proxy.id, false)
    continue
  }
  const ready = proxyReady(proxy)
  proxyOk.set(proxy.id, ready)
  check(`${proxy.label} ready on ${proxy.port}`, ready, ready ? undefined : 'health or model catalogue failed')
  if (!ready && portOpen(proxy.port)) {
    console.log(`         (port ${proxy.port} is open, so something else is holding it)`)
  }
}

console.log('\n=== 5. seats answer ===')

/**
 * Ask one CLI seat for a fixed word and time it.
 * @param seat - the seat definition.
 */
async function seatAnswers(seat) {
  const cap = seat.timeoutMs ?? 180_000
  const started = Date.now()
  const reply = await askCliSeat({ ...seat, enabled: true }, 'Reply with the single word: ready', undefined, cap)
  const seconds = Math.round((Date.now() - started) / 100) / 10
  const answered = reply.error === undefined && /ready/i.test(reply.text)
  check(
    `${seat.id} answers`,
    answered,
    reply.error === undefined ? `${seconds}s` : `${seconds}s - ${reply.error.slice(0, 160)}`,
  )
}

const includePaid = process.argv.includes('--paid')
if (!includePaid) console.log('  (free seats only; pass --paid to include the subscription seats)')

for (const seat of cliSeats) {
  if (resolvable.get(seat.id) !== true) {
    console.log(`  [skip] ${seat.id} - its binary did not resolve`)
    continue
  }
  if (seat.free !== true && !includePaid) {
    console.log(`  [skip] ${seat.id} - subscription seat, and --paid was not given`)
    continue
  }
  // A seat pointed at a proxy is only worth asking when that proxy is up;
  // otherwise the failure says nothing about the seat.
  const viaProxy = PROXIES.find(p => JSON.stringify(seat.env ?? {}).includes(String(p.port)))
  if (viaProxy && proxyOk.get(viaProxy.id) !== true) {
    console.log(`  [skip] ${seat.id} - ${viaProxy.label} is not ready`)
    continue
  }
  await seatAnswers(seat)
}

if (hostedSeats.length > 0) {
  const metered = hostedSeats.filter(s => s.free !== true).map(s => s.id)
  const free = hostedSeats.filter(s => s.free === true).map(s => s.id)
  if (metered.length) console.log(`\n  (${metered.join(', ')} are metered seats and are not called here - they cost money.)`)
  if (free.length) console.log(`  (${free.join(', ')} runs over HTTP rather than a CLI; its proxy was checked in step 4.)`)
}

const failed = results.filter(entry => !entry.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail === undefined ? '' : ` (${entry.detail})`}`)
}
process.exit(failed.length === 0 ? 0 : 1)
