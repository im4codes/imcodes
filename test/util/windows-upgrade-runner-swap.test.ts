/**
 * The Windows upgrade runner's staged swap, driven end to end with a fake npm and a fake package whose daemon
 * really runs: stage -> verify -> stop the daemon -> switch (with bounded rename retries) -> relaunch ->
 * health check -> roll back on failure.
 *
 * Runs on every platform (the swap is plain rename + process handling; `IMCODES_INSTALL_LAYOUT=windows`
 * gives a POSIX host npm's Windows global layout), and the same file is the Windows acceptance run on a
 * real Windows machine, where the locks and the tree kill are real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(__dirname, '..', '..', 'src', 'util', 'windows-upgrade-runner.mjs');
const OLD_VERSION = '1.0.0';
const NEW_VERSION = '2.0.0';
const isWindows = process.platform === 'win32';

/** The fake package: `--version`, `repair-watchdog` (starts the daemon unless the package is marked UNHEALTHY). */
const INDEX_JS = `
const fs = require('fs'), path = require('path'), cp = require('child_process');
const pkgDir = path.resolve(__dirname, '..', '..');
const version = require(path.join(pkgDir, 'package.json')).version;
if (process.argv[2] === '--version') { console.log(version); process.exit(0); }
if (process.argv[2] === 'repair-watchdog') {
  if (fs.existsSync(path.join(pkgDir, 'UNHEALTHY'))) process.exit(0);
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  process.exit(0);
}
process.exit(0);
`;

/** The fake daemon waits for upgrade.lock to go (as the real watchdog does), then records its pid and version. */
const DAEMON_JS = `
const fs = require('fs'), path = require('path');
const home = process.env.IMCODES_HOME;
const lock = path.join(home, 'upgrade.lock');
const version = require('../../package.json').version;
const started = Date.now();
const tick = () => {
  if (fs.existsSync(lock) && Date.now() - started < 60000) return setTimeout(tick, 100);
  fs.writeFileSync(path.join(home, 'daemon.pid'), String(process.pid));
  fs.writeFileSync(path.join(home, 'daemon.version'), version);
  setInterval(() => {}, 1000);
};
tick();
`;

/** Writes a package into <prefix>/node_modules/imcodes plus the shims in the prefix root, as npm does. */
const WRITER_CJS = `
const fs = require('fs'), path = require('path');
exports.writePackage = function (prefix, version, unhealthy) {
  const dir = path.join(prefix, 'node_modules', 'imcodes');
  fs.mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'imcodes', version, bin: { imcodes: 'dist/src/index.js' } }));
  fs.writeFileSync(path.join(dir, 'dist', 'src', 'index.js'), ${JSON.stringify(INDEX_JS)});
  fs.writeFileSync(path.join(dir, 'dist', 'src', 'daemon.js'), ${JSON.stringify(DAEMON_JS)});
  if (unhealthy) fs.writeFileSync(path.join(dir, 'UNHEALTHY'), '1');
  const entry = '"' + process.execPath + '" "%~dp0node_modules\\\\imcodes\\\\dist\\\\src\\\\index.js" %*';
  fs.writeFileSync(path.join(prefix, 'imcodes.cmd'), '@echo off\\r\\n' + entry + '\\r\\n');
  fs.writeFileSync(path.join(prefix, 'imcodes'), '#!/bin/sh\\nexec "' + process.execPath + '" "$(dirname "$0")/node_modules/imcodes/dist/src/index.js" "$@"\\n', { mode: 0o755 });
};
`;

const NPM_CLI_JS = `
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'view') process.exit(1);
if (args[0] === 'install') {
  if (process.env.FAKE_NPM_FAIL === '1') { console.error('npm error code ETIMEDOUT'); process.exit(1); }
  const prefix = args[args.indexOf('--prefix') + 1];
  const spec = args[args.length - 1];
  const version = process.env.FAKE_NPM_VERSION || spec.slice(spec.lastIndexOf('@') + 1);
  require('./writer.cjs').writePackage(prefix, version, process.env.FAKE_NPM_UNHEALTHY === '1');
  console.log('added 1 package');
  process.exit(0);
}
console.error('unhandled fake npm command: ' + args.join(' '));
process.exit(99);
`;

interface World {
  root: string;
  prefix: string;
  stateDir: string;
  scriptDir: string;
  npmCmd: string;
  logFile: string;
  daemons: number[];
}

let world: World;
const require_ = createRequire(import.meta.url);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function sleep(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)); }

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

function daemonPid(): number | null {
  try { return Number.parseInt(readFileSync(join(world.stateDir, 'daemon.pid'), 'utf8').trim(), 10) || null; } catch { return null; }
}

function daemonVersion(): string | null {
  try { return readFileSync(join(world.stateDir, 'daemon.version'), 'utf8').trim(); } catch { return null; }
}

function liveVersion(): string {
  return JSON.parse(readFileSync(join(world.prefix, 'node_modules', 'imcodes', 'package.json'), 'utf8')).version;
}

/** A world with `imcodes@OLD_VERSION` installed and its daemon running. A prefix with spaces and non-ASCII on purpose. */
async function createWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'imcodes swap 测试-'));
  const npmDir = join(root, 'nodejs');
  mkdirSync(join(npmDir, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(npmDir, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n');
  writeFileSync(join(npmDir, 'node_modules', 'npm', 'bin', 'writer.cjs'), WRITER_CJS);
  writeFileSync(join(npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), NPM_CLI_JS);
  const prefix = join(root, 'npm 前缀', 'global');
  const stateDir = join(root, 'home', '.imcodes');
  const scriptDir = join(root, 'tmp run');
  for (const dir of [prefix, stateDir, scriptDir]) mkdirSync(dir, { recursive: true });
  require_(join(npmDir, 'node_modules', 'npm', 'bin', 'writer.cjs')).writePackage(prefix, OLD_VERSION, false);
  const created: World = { root, prefix, stateDir, scriptDir, npmCmd: join(npmDir, 'npm.cmd'), logFile: join(scriptDir, 'upgrade.log'), daemons: [] };
  world = created;
  // Launched through a short-lived parent, as the watchdog launches the real daemon: a daemon that is a direct
  // child of this test would stay a zombie after the runner kills it and look alive.
  spawnSync(process.execPath, ['-e', `require('child_process').spawn(process.execPath, [${JSON.stringify(join(prefix, 'node_modules', 'imcodes', 'dist', 'src', 'daemon.js'))}], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`], {
    env: { ...process.env, IMCODES_HOME: stateDir }, windowsHide: true,
  });
  await waitFor(() => daemonPid() !== null, 10_000, 'the initial daemon');
  created.daemons.push(daemonPid()!);
  return created;
}

function runUpgrade(extraEnv: Record<string, string> = {}, target = NEW_VERSION): { status: number | null; log: string } {
  const result = spawnSync(process.execPath, [
    RUNNER, world.logFile, world.npmCmd, `imcodes@${target}`, target, world.scriptDir, '-', OLD_VERSION, world.prefix,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240_000,
    env: {
      ...process.env,
      IMCODES_HOME: world.stateDir,
      IMCODES_DEFAULT_HOME: join(world.root, 'not-the-default-home'),
      IMCODES_INSTALL_LAYOUT: 'windows',
      IMCODES_RENAME_RETRY_MS: '1500',
      IMCODES_UPGRADE_HEALTH_MS: '2500',
      IMCODES_UPGRADE_HEALTH_EXTENDED_MS: '2500',
      ...extraEnv,
    },
  });
  return { status: result.status, log: existsSync(world.logFile) ? readFileSync(world.logFile, 'utf8') : '' };
}

function leftovers(): string[] {
  const names = [...readdirSync(world.prefix), ...readdirSync(join(world.prefix, 'node_modules'))];
  return names.filter((name) => /^\.imcodes-(stage|old|failed)\./.test(name));
}

beforeEach(async () => { await createWorld(); });

afterEach(() => {
  for (const pid of new Set([...world.daemons, daemonPid() ?? 0])) {
    if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('windows upgrade runner: staged swap', { timeout: 240_000 }, () => {
  it('clean swap: new version live, new daemon healthy on it, old daemon gone, nothing left behind', async () => {
    const oldPid = daemonPid()!;
    const { status, log } = runUpgrade();
    expect(status, log).toBe(0);
    expect(liveVersion()).toBe(NEW_VERSION);
    await waitFor(() => daemonVersion() === NEW_VERSION && daemonPid() !== oldPid, 10_000, 'the new daemon');
    expect(alive(daemonPid()!)).toBe(true);
    world.daemons.push(daemonPid()!);
    expect(alive(oldPid)).toBe(false);
    expect(existsSync(join(world.stateDir, 'upgrade.lock'))).toBe(false);
    expect(log).toMatch(/health check PASSED/);
    expect(log).toMatch(/\[trace\] step=9 post-switch exit=0/);
    expect(log.indexOf('[trace] step=3 post-npm-install')).toBeLessThan(log.indexOf('stopping old daemon'));
    expect(log.indexOf('[trace] step=4 post-version-check')).toBeLessThan(log.indexOf('stopping old daemon'));
    expect(leftovers()).toEqual([]);
  });

  it('npm fails: the old package and the old daemon are untouched, nothing staged remains', () => {
    const oldPid = daemonPid()!;
    const { status, log } = runUpgrade({ FAKE_NPM_FAIL: '1' });
    expect(status, log).toBe(0);
    expect(log).toContain('install FAILED');
    expect(log).not.toContain('stopping old daemon');
    expect(liveVersion()).toBe(OLD_VERSION);
    expect(daemonPid()).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    expect(existsSync(join(world.stateDir, 'upgrade.lock'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a staged package that fails verification (wrong version) is never switched in', () => {
    const oldPid = daemonPid()!;
    const { log } = runUpgrade({ FAKE_NPM_VERSION: '3.0.0' });
    expect(log).toMatch(/FAILED verification/);
    expect(log).not.toContain('stopping old daemon');
    expect(liveVersion()).toBe(OLD_VERSION);
    expect(alive(oldPid)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('rename stays locked after the daemon stopped: the old package stays live and the old daemon is restarted and healthy', async () => {
    const oldPid = daemonPid()!;
    const { status, log } = runUpgrade({ IMCODES_TEST_RENAME_FAIL_FOREVER: '1' });
    expect(status, log).toBe(0);
    expect(log).toContain('stopping old daemon');
    expect(log).toMatch(/switch FAILED \[exit 78\]/);
    expect(liveVersion()).toBe(OLD_VERSION);
    await waitFor(() => daemonPid() !== oldPid && alive(daemonPid() ?? 0), 10_000, 'the old version to come back');
    world.daemons.push(daemonPid()!);
    expect(daemonVersion()).toBe(OLD_VERSION);
    expect(alive(oldPid)).toBe(false);
    expect(log).toMatch(/previous version is running again/);
    expect(existsSync(join(world.stateDir, 'upgrade.lock'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a lock that clears within the retry budget is waited out and the swap completes', async () => {
    const { status, log } = runUpgrade({ IMCODES_TEST_RENAME_FAIL_COUNT: '2', IMCODES_RENAME_RETRY_MS: '20000' });
    expect(status, log).toBe(0);
    expect(log).toMatch(/blocked \(EPERM\); retrying with backoff/);
    expect(liveVersion()).toBe(NEW_VERSION);
    await waitFor(() => daemonVersion() === NEW_VERSION, 10_000, 'the new daemon');
    world.daemons.push(daemonPid()!);
  });

  it('the new package installs but its daemon never comes up: rolled back, old daemon restarted and healthy', async () => {
    const oldPid = daemonPid()!;
    const { status, log } = runUpgrade({ FAKE_NPM_UNHEALTHY: '1' });
    expect(status, log).toBe(0);
    expect(log).toMatch(/health check FAILED/);
    expect(log).toMatch(/ROLLBACK: the daemon did not come back on the new package/);
    expect(liveVersion()).toBe(OLD_VERSION);
    await waitFor(() => daemonPid() !== oldPid && alive(daemonPid() ?? 0), 10_000, 'the old version to come back');
    world.daemons.push(daemonPid()!);
    expect(daemonVersion()).toBe(OLD_VERSION);
    expect(log).toMatch(/previous version is running again/);
    expect(existsSync(join(world.stateDir, 'upgrade.lock'))).toBe(false);
  });

  it('sweeps stage/old/failed leftovers of dead upgrades on the next run', () => {
    const deadPid = 2_147_000_000;
    const stale = [
      join(world.prefix, `.imcodes-stage.${deadPid}`),
      join(world.prefix, 'node_modules', `.imcodes-old.${deadPid}`),
      join(world.prefix, 'node_modules', `.imcodes-failed.${deadPid}`),
    ];
    for (const dir of stale) { mkdirSync(join(dir, 'x'), { recursive: true }); writeFileSync(join(dir, 'x', 'f'), 'orphan'); }
    const { log } = runUpgrade({ FAKE_NPM_FAIL: '1' });
    for (const dir of stale) expect(existsSync(dir), `${dir} should be swept\n${log}`).toBe(false);
    expect(liveVersion()).toBe(OLD_VERSION);
  });

  it('heals an interrupted switch (live package missing, old one parked) before doing anything else', () => {
    const live = join(world.prefix, 'node_modules', 'imcodes');
    const parked = join(world.prefix, 'node_modules', '.imcodes-old.2147000000');
    require_('node:fs').renameSync(live, parked);
    const { log } = runUpgrade({ FAKE_NPM_FAIL: '1' });
    expect(log).toMatch(/recovered an interrupted switch/);
    expect(liveVersion()).toBe(OLD_VERSION);
  });

  it.skipIf(!isWindows)('a file held open inside the live package makes the rename fail: bounded, rolled back, old daemon restarted', async () => {
    const oldPid = daemonPid()!;
    // Hold a file open without FILE_SHARE_DELETE, like a loaded native addon: a real Windows lock.
    const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open('${join(world.prefix, 'node_modules', 'imcodes', 'package.json').replaceAll("'", "''")}', 'Open', 'Read', 'Read'); Start-Sleep -Seconds 120`], { stdio: 'ignore', windowsHide: true });
    await sleep(3_000);
    try {
      const started = Date.now();
      const { log } = runUpgrade({ IMCODES_RENAME_RETRY_MS: '8000' });
      expect(Date.now() - started).toBeLessThan(120_000);
      expect(log).toMatch(/stayed locked|switch FAILED/);
      expect(liveVersion()).toBe(OLD_VERSION);
      await waitFor(() => daemonPid() !== oldPid && alive(daemonPid() ?? 0), 15_000, 'the old version to come back');
      world.daemons.push(daemonPid()!);
    } finally {
      try { holder.kill(); } catch { /* gone */ }
    }
  });
});
