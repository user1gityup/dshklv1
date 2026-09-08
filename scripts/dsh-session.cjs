'use strict';
// DSH owns these monitors: no timer survives the DSH child exiting.
//
// The free council seats point at local proxies and fail loudly when nothing
// is listening. This process starts each configured proxy, runs DSH as its
// child, checks the proxies every 30 seconds while that child lives, and stops
// the ones it started when the child goes away.
//
// Recovery is capped. A proxy that will not come back stays down and says so,
// rather than being restarted forever behind a session nobody is watching.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_INTERVAL_MS = 30_000;
const RECOVERY_LIMIT = 3;

/** Proxies this launcher knows about, in the order they are started. */
const PROXIES = [
  {id: 'fcc', label: 'Free Claude', dirEnv: 'FCC_DIR'},
  {id: 'openrouter-free', label: 'OpenRouter Free', dirEnv: 'ORFREE_DIR'},
];

/**
 * A health check with bounded recovery.
 *
 * Reports only on change, so a healthy session stays quiet and a state change
 * is visible in the log without scrolling.
 */
function createMonitor({check, recover, report, alive, limit = RECOVERY_LIMIT, label = 'Proxy'}) {
  let attempts = 0;
  let previous;
  return async function tick() {
    if (!alive()) return;
    let ready = await check();
    if (!alive()) return;
    if (!ready && attempts < limit) {
      report(`${label} unavailable; recovery ${++attempts}/${limit}.`);
      ready = await recover();
    }
    if (!alive()) return;
    const state = ready
      ? `${label} ready.`
      : `${label} unavailable.${attempts >= limit ? ` Automatic recovery stopped after ${limit} attempts.` : ''}`;
    if (state !== previous) report(state);
    previous = state;
    return {ready, recoveryAttempts: attempts, recoveryLimit: limit};
  };
}

function resolveStateDir() {
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  fs.mkdirSync(home, {recursive: true});
  return home;
}

async function main() {
  const stateDir = resolveStateDir();
  const controller = path.join(__dirname, 'proxy-control.ps1');
  const logPath = path.join(stateDir, 'dsh-session.log');
  const report = message => {
    console.log(`[dsh] ${message}`);
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  };

  const dshRoot = process.env.DSH_ROOT;
  const attached = process.argv[2] === '--watch';
  const ownerPid = process.argv[3];
  const ownerStarted = process.argv[4];
  if (attached && (!/^\d+$/.test(ownerPid) || !/^\d+$/.test(ownerStarted))) {
    throw new Error('Watch requires the DSH PID and verified start ticks.');
  }
  if (!attached && !dshRoot) {
    throw new Error('DSH_ROOT is not set. Copy dsh-env.example.cmd to dsh-env.cmd and set it.');
  }

  // Only proxies whose directory was configured take part. An unconfigured
  // proxy is not an error: it means that seat is not in use.
  const active = PROXIES.filter(p => (process.env[p.dirEnv] || '').trim().length > 0);
  if (active.length === 0) report('No local proxies configured; starting DSH alone.');

  const control = (proxy, action) => new Promise(resolve => {
    const ownerArgs = action === 'owner' ? ['-OwnerPid', ownerPid, '-OwnerStarted', ownerStarted] : [];
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', controller,
      '-Proxy', proxy, '-Action', action, ...ownerArgs,
    ], {
      windowsHide: true,
      stdio: ['status', 'owner'].includes(action) ? 'ignore' : 'inherit',
    });
    child.once('error', error => { report(error.message); resolve(false); });
    child.once('exit', code => resolve(code === 0));
  });

  // The owner check is a property of the DSH process, not of any one proxy, so
  // any controller can answer it.
  const ownerAlive = () => control(active[0]?.id ?? 'fcc', 'owner');

  if (attached && !(await ownerAlive())) {
    throw new Error('The requested DSH process is no longer running.');
  }

  for (const proxy of active) await control(proxy.id, 'start');

  const dsh = attached ? null : spawn(
    process.execPath,
    ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', ...process.argv.slice(2)],
    {stdio: 'inherit', cwd: dshRoot},
  );

  let running = true;
  let timer;
  let pending = Promise.resolve();
  let finishing = false;

  const monitors = active.map(proxy => ({
    proxy,
    tick: createMonitor({
      label: proxy.label,
      check: () => control(proxy.id, 'status'),
      recover: () => control(proxy.id, 'restart'),
      report,
      alive: () => running,
    }),
  }));

  async function poll() {
    if (attached && !(await ownerAlive())) {
      running = false;
      setImmediate(() => { void finish(0); });
      return;
    }
    const proxies = {};
    for (const {proxy, tick} of monitors) {
      const status = await tick();
      if (status) proxies[proxy.id] = {label: proxy.label, ...status};
    }
    if (running) {
      fs.writeFileSync(path.join(stateDir, 'dsh-session-status.json'), JSON.stringify({
        monitoring: true,
        checkedAt: new Date().toISOString(),
        monitorPid: process.pid,
        dshPid: attached ? Number(ownerPid) : dsh.pid,
        intervalSeconds: CHECK_INTERVAL_MS / 1000,
        proxies,
      }, null, 2));
    }
    if (running) timer = setTimeout(() => { pending = poll(); }, CHECK_INTERVAL_MS);
  }

  async function finish(code) {
    if (finishing) return;
    finishing = true;
    running = false;
    clearTimeout(timer);
    await pending;
    for (const {proxy} of monitors) await control(proxy.id, 'stop');
    fs.writeFileSync(path.join(stateDir, 'dsh-session-status.json'), JSON.stringify({
      monitoring: false, checkedAt: new Date().toISOString(), monitorPid: process.pid,
    }, null, 2));
    report('DSH exited; health monitoring stopped.');
    process.exit(code);
  }

  dsh?.once('error', error => { report(error.message); void finish(1); });
  dsh?.once('exit', code => { void finish(code ?? 1); });
  // Console signals are delivered to the inherited DSH console as well.
  process.on('SIGINT', () => { dsh?.kill('SIGINT'); void finish(130); });
  process.on('SIGTERM', () => { dsh?.kill(); void finish(143); });

  report(`Health monitor active; checks every ${CHECK_INTERVAL_MS / 1000} seconds${attached ? ` for DSH PID ${ownerPid}` : ''}.`);
  pending = poll();
}

module.exports = {createMonitor};
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
