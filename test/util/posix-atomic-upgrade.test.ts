/**
 * The Linux/macOS upgrade is staged and switched, never done in place
 * (tsk_cd_upgrade_atomic_install; incident: an `imcodes upgrade` whose SSH session
 * ended mid `npm install -g` left 215 with a half-replaced package and a daemon
 * that could not start).
 *
 * These tests run the REAL generated upgrade.sh and the REAL staged-package-install.mjs
 * against a fake npm (a node script that builds a package tree under `--prefix`,
 * with injectable failures and delays) and a fake service restart, in a scratch
 * prefix laid out like an nvm one. Nothing here touches a real install, daemon
 * or ~/.imcodes.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { START_NEW_DAEMON, createFixture, destroyFixture, startDaemon as startDaemonIn, treeHash, writePackage, type Fixture } from '../helpers/posix-upgrade-fixture.js';
import { buildPosixUpgradeScript, resolveStagedInstallerPath } from '../../src/util/posix-upgrade-script.js';
import { parsePosixUpgradeFailureStatus, POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE } from '../../src/util/posix-upgrade-layout-recovery.js';

let fixture: Fixture;
const children: ChildProcess[] = [];

function liveVersion(): string {
  return JSON.parse(readFileSync(join(fixture.livePackage, 'package.json'), 'utf8')).version as string;
}

const startDaemon = () => startDaemonIn(fixture, children);

interface RunOptions {
  pkg?: string; target?: string; current?: string; restartCmd?: string; env?: Record<string, string>;
  oldDaemonPid?: number | null; timing?: { settleSec?: number; healthFirstWaitSec?: number; healthExtendedWaitSec?: number };
}

function prepareScript(options: RunOptions = {}): { script: string; env: NodeJS.ProcessEnv; logFile: string } {
  const target = options.target ?? '2.0.0';
  // A fresh scratch dir per run: the script schedules its own cleanup of it.
  fixture.scriptDir = mkdtempSync(join(fixture.root, 'scratch', 'run-'));
  const logFile = join(fixture.scriptDir, 'upgrade.log');
  const installer = join(fixture.scriptDir, 'staged-package-install.mjs');
  copyFileSync(resolveStagedInstallerPath(), installer);
  const scriptPath = join(fixture.scriptDir, 'upgrade.sh');
  writeFileSync(scriptPath, buildPosixUpgradeScript({
    logFile, scriptDir: fixture.scriptDir, statusFile: join(fixture.scriptDir, 'upgrade-status.json'), registryArg: '',
    pkgSpec: options.pkg ?? `imcodes@${target}`, targetVer: target, currentVer: options.current ?? '1.0.0',
    oldDaemonPid: options.oldDaemonPid === undefined ? null : options.oldDaemonPid,
    nodeBin: join(fixture.nodeDir, 'node'), nodeDir: fixture.nodeDir, stateDir: fixture.stateDir,
    restartCmd: options.restartCmd ?? START_NEW_DAEMON(fixture.stateDir), cleanupAfterSec: 1,
    atomicInstallerPath: installer, skipLaunchChain: true,
    timing: { settleSec: 0, healthFirstWaitSec: 3, healthExtendedWaitSec: 3, ...(options.timing ?? {}) },
  }), { mode: 0o755 });
  return {
    script: scriptPath,
    logFile,
    env: { ...process.env, HOME: fixture.home, FAKE_PREFIX: fixture.prefix, ...(options.env ?? {}) },
  };
}

function runScript(options: RunOptions = {}): Promise<{ code: number | null; log: string; result: string }> {
  const { script, env, logFile } = prepareScript(options);
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script], { env, stdio: 'ignore' });
    children.push(child);
    child.on('exit', (code) => resolve({ code, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '', result: readResult() }));
  });
}

function readResult(): string {
  const file = join(fixture.scriptDir, 'upgrade-result');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

const leftovers = () => [
  ...readdirSync(fixture.globalRoot).filter((name) => name.startsWith('.imcodes-')),
  ...readdirSync(join(fixture.prefix, 'lib')).filter((name) => name.startsWith('.imcodes-')),
];

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  destroyFixture(fixture, children);
});

const entryVersion = () => spawnSync(process.execPath, [join(fixture.livePackage, 'dist', 'src', 'index.js'), '--version'], { encoding: 'utf8' }).stdout.trim();

describe('staged upgrade: the happy path', () => {
  it('installs into a sibling stage, verifies, switches, restarts, and leaves one complete package behind', async () => {
    const oldPid = startDaemon();
    const { code, log, result } = await runScript({ oldDaemonPid: oldPid });
    expect(code).toBe(0);
    expect(result).toBe('ok');
    expect(liveVersion()).toBe('2.0.0');
    expect(entryVersion()).toBe('2.0.0');
    expect(log).toContain('staged install succeeded');
    expect(log).toContain('verified');
    expect(log).toContain('switched');
    expect(log).toContain('new daemon healthy');
    expect(log).toContain('committed');
    // Exactly one package, no stage, no old copy, no failed copy.
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(fixture.root, 'state', 'last-upgrade-at'))).toBe(true);
    // The bin link still resolves to the (new) package.
    expect(realpathSync(join(fixture.binDir, 'imcodes'))).toBe(join(fixture.livePackage, 'dist', 'src', 'index.js'));
    expect(Number(readFileSync(join(fixture.stateDir, 'daemon.pid'), 'utf8'))).not.toBe(oldPid);
  }, 60_000);

  it('works for a `latest` spec and a prefix under ~/.nvm (the 215 layout)', async () => {
    startDaemon();
    const { result } = await runScript({ pkg: 'imcodes@2.5.0', target: 'latest', env: { FAKE_NPM_MODE: 'ok' } });
    // `latest` with the fake registry resolves to the spec's own version; the guard compares it with 1.0.0.
    expect(result).toBe('ok');
    expect(liveVersion()).toBe('2.5.0');
  }, 60_000);
});

describe('an interrupted or failed install never leaves a half-state', () => {
  it('npm failing halfway through (injected): the old package is byte-identical, no stage is left, the failure is named in the log and the status marker', async () => {
    startDaemon();
    const before = treeHash(fixture.livePackage);
    const { code, log, result } = await runScript({ env: { FAKE_NPM_MODE: 'fail-mid' }, timing: {} });
    expect(code).toBe(POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE);
    expect(result).toBe('failed');
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(liveVersion()).toBe('1.0.0');
    expect(entryVersion()).toBe('1.0.0');
    expect(leftovers()).toEqual([]);
    expect(log).toContain('npm install into the staging prefix failed');
    expect(log).toContain('injected failure halfway through the install');
    expect(log).toContain('install FAILED');
    const status = parsePosixUpgradeFailureStatus(readFileSync(join(fixture.scriptDir, 'upgrade-status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'blocked' });
    // The daemon that was running is still the same process, still running.
    expect(() => process.kill(Number(readFileSync(join(fixture.stateDir, 'daemon.pid'), 'utf8')), 0)).not.toThrow();
  }, 120_000);

  it.each([
    ['a package that prints the wrong version', 'wrong-version'],
    ['a package whose entry script crashes', 'broken-entry'],
    ['a package with no entry script', 'missing-entry'],
  ])('%s fails verification BEFORE the switch: the old package is untouched', async (_name, mode) => {
    startDaemon();
    const before = treeHash(fixture.livePackage);
    const { code, log, result } = await runScript({ env: { FAKE_NPM_MODE: mode } });
    expect(code).toBe(POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE);
    expect(result).toBe('failed');
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(leftovers()).toEqual([]);
    expect(log).toContain('FAILED verification');
    expect(log).not.toContain('[step 3.4] switching');
  }, 60_000);

  it('KILLING THE CALLER mid-install (the SSH-drop case): the detached script still finishes the upgrade', async () => {
    startDaemon();
    const started = join(fixture.root, 'npm-started');
    const { script, env } = prepareScript({ env: { FAKE_STARTED_FILE: started, FAKE_INSTALL_DELAY_MS: '2500' } });
    // "The CLI": a process that starts the script detached, exactly as launchPosixUpgrade does, and is then killed.
    const caller = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn('/bin/bash', [${JSON.stringify(script)}], { detached: true, stdio: 'ignore' });
      child.unref();
      setInterval(() => {}, 1000);
    `], { env, stdio: 'ignore' });
    children.push(caller);
    const deadline = Date.now() + 20_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(started)).toBe(true); // npm is mid-install
    caller.kill('SIGKILL');
    const killedAt = Date.now();
    while (readResult() === '' && Date.now() - killedAt < 40_000) await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readResult()).toBe('ok');
    expect(liveVersion()).toBe('2.0.0');
    expect(entryVersion()).toBe('2.0.0');
    expect(leftovers()).toEqual([]);
  }, 90_000);

  it('the script itself SIGKILLed mid-install (power-loss-like): the live package is untouched, and the next run recovers and upgrades', async () => {
    startDaemon();
    const started = join(fixture.root, 'npm-started');
    const before = treeHash(fixture.livePackage);
    const { script, env } = prepareScript({ env: { FAKE_STARTED_FILE: started, FAKE_INSTALL_DELAY_MS: '5000' } });
    const first = spawn('/bin/bash', [script], { env, detached: true, stdio: 'ignore' });
    children.push(first);
    const deadline = Date.now() + 20_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    process.kill(-first.pid!, 'SIGKILL'); // the whole group: script, helper, npm
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(entryVersion()).toBe('1.0.0');
    expect(readdirSync(join(fixture.prefix, 'lib')).some((name) => name.startsWith('.imcodes-stage.'))).toBe(true); // the orphaned stage

    rmSync(join(fixture.scriptDir, 'upgrade-result'), { force: true });
    const { result } = await runScript(); // its lock is stale (owner dead) and it runs clean
    expect(result).toBe('ok');
    expect(liveVersion()).toBe('2.0.0');
  }, 120_000);
});

describe('refusals happen before anything changes', () => {
  it('a prefix the user cannot write fails clearly with nothing half-installed', async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    startDaemon();
    const before = treeHash(fixture.livePackage);
    chmodSync(fixture.globalRoot, 0o555);
    const { code, log, result } = await runScript();
    chmodSync(fixture.globalRoot, 0o755);
    expect(code).toBe(POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE);
    expect(result).toBe('failed');
    expect(log).toContain('is not writable by this user');
    expect(log).toContain('nothing was changed');
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(parsePosixUpgradeFailureStatus(readFileSync(join(fixture.scriptDir, 'upgrade-status.json'), 'utf8'))?.retryReason).toBe('prefix-not-writable');
  }, 60_000);

  it('not enough free disk (need 2x the package) fails before the download, nothing changed', async () => {
    startDaemon();
    const before = treeHash(fixture.livePackage);
    const { code, log, result } = await runScript({ env: { FAKE_UNPACKED: String(10 ** 15) } });
    expect(code).toBe(POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE);
    expect(result).toBe('failed');
    expect(log).toMatch(/not enough free disk .* \(2x the package\)/);
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(leftovers()).toEqual([]);
    expect(parsePosixUpgradeFailureStatus(readFileSync(join(fixture.scriptDir, 'upgrade-status.json'), 'utf8'))?.retryReason).toBe('low-disk');
  }, 60_000);

  it('single-flight: a second upgrade while one holds the lock exits without touching npm or the package', async () => {
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(holder);
    const lock = join(fixture.stateDir, 'upgrade.lock.d');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(holder.pid));
    writeFileSync(join(lock, 'started'), String(Math.floor(Date.now() / 1000)));
    const before = treeHash(fixture.livePackage);
    const { code, log, result } = await runScript();
    expect(code).toBe(0);
    expect(result).toBe('skipped');
    expect(log).toContain('another upgrade is already running');
    expect(treeHash(fixture.livePackage)).toBe(before);
  }, 60_000);

  it('refuses to downgrade: the staged older package is dropped, the live one kept', async () => {
    startDaemon();
    const before = treeHash(fixture.livePackage);
    const { result, log } = await runScript({ pkg: 'imcodes@0.5.0', target: 'latest', current: '1.0.0' });
    expect(result).toBe('refused');
    expect(log).toContain('refusing to downgrade');
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('the same version with a sound live package is a no-op (no switch); with a broken live package it is repaired by switching', async () => {
    startDaemon();
    const sound = await runScript({ pkg: 'imcodes@1.0.0', target: '1.0.0', current: '1.0.0' });
    expect(sound.result).toBe('noop');
    expect(sound.log).not.toContain('[step 3.4] switching');
    expect(leftovers()).toEqual([]);

    rmSync(join(fixture.livePackage, 'dist', 'src', 'index.js')); // a half-replaced live package
    rmSync(join(fixture.scriptDir, 'upgrade-result'), { force: true });
    const repaired = await runScript({ pkg: 'imcodes@1.0.0', target: '1.0.0', current: '1.0.0' });
    expect(repaired.log).toContain('the live package does not verify');
    expect(repaired.result).toBe('ok');
    expect(entryVersion()).toBe('1.0.0');
  }, 120_000);
});

describe('rollback when the new package cannot bring the daemon back', () => {
  it('a daemon that was running and does not return is rolled back to the previous package, which is restarted', async () => {
    const oldPid = startDaemon();
    const flag = join(fixture.root, 'restarted-once');
    // First restart: the old daemon dies and nothing replaces it (the new package crash-loops).
    // Second restart (after the rollback): it comes back.
    const restartCmd = `if [ -f "${flag}" ]; then ${START_NEW_DAEMON(fixture.stateDir)}
else kill "$(cat "${fixture.stateDir}/daemon.pid")" 2>/dev/null; rm -f "${fixture.stateDir}/daemon.pid"; touch "${flag}"; fi`;
    const before = treeHash(fixture.livePackage);
    const { code, log, result } = await runScript({ restartCmd, oldDaemonPid: oldPid });
    expect(result).toBe('rolled_back');
    expect(code).toBe(POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE); // reported as a blocked upgrade
    expect(log).toContain('ROLLBACK');
    expect(log).toContain('rolled back');
    expect(log).toContain('previous version is running again');
    expect(liveVersion()).toBe('1.0.0');
    expect(entryVersion()).toBe('1.0.0');
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(() => process.kill(Number(readFileSync(join(fixture.stateDir, 'daemon.pid'), 'utf8')), 0)).not.toThrow();
    expect(parsePosixUpgradeFailureStatus(readFileSync(join(fixture.scriptDir, 'upgrade-status.json'), 'utf8'))?.retryReason).toBe('new-version-unhealthy');
  }, 120_000);

  it('a machine with no daemon running is not rolled back for lacking one (nothing was expected of the restart)', async () => {
    const { result, log } = await runScript({ restartCmd: 'true' });
    expect(result).toBe('ok');
    expect(log).not.toContain('ROLLBACK');
    expect(liveVersion()).toBe('2.0.0');
  }, 60_000);
});

describe('staged-package-install.mjs', () => {
  const helper = () => resolveStagedInstallerPath();
  const run = (...args: string[]) => spawnSync(process.execPath, [helper(), ...args], { encoding: 'utf8' });

  it('switch then rollback restores the previous package exactly, including its bin link', () => {
    const stage = join(fixture.prefix, 'lib', '.imcodes-stage.t1');
    writePackage(join(stage, 'lib', 'node_modules', 'imcodes'), '3.0.0');
    const before = treeHash(fixture.livePackage);
    const common = ['--global-root', fixture.globalRoot, '--tag', 't1', '--bin-dir', fixture.binDir];
    expect(run('switch', ...common, '--stage-prefix', stage).status).toBe(0);
    expect(liveVersion()).toBe('3.0.0');
    expect(existsSync(join(fixture.globalRoot, '.imcodes-old.t1'))).toBe(true);
    expect(run('rollback', ...common).status).toBe(0);
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(realpathSync(join(fixture.binDir, 'imcodes'))).toBe(join(fixture.livePackage, 'dist', 'src', 'index.js'));
  });

  it('recover heals a switch interrupted between its two renames (live missing, old copy present)', () => {
    const before = treeHash(fixture.livePackage);
    // Exactly the window: the live package has been renamed away and the staged one is not in place yet.
    const old = join(fixture.globalRoot, '.imcodes-old.crashed');
    rmSync(old, { recursive: true, force: true });
    const { renameSync } = require('node:fs') as typeof import('node:fs');
    renameSync(fixture.livePackage, old);
    expect(existsSync(fixture.livePackage)).toBe(false);
    const result = run('recover', '--global-root', fixture.globalRoot, '--bin-dir', fixture.binDir);
    expect(result.status).toBe(0);
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(realpathSync(join(fixture.binDir, 'imcodes'))).toBe(join(fixture.livePackage, 'dist', 'src', 'index.js'));
  });

  it('recover removes the stage and old copies of a dead upgrade at once, and leaves those of a live one alone', () => {
    const lib = join(fixture.prefix, 'lib');
    const live = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(live);
    const dead = spawnSync('true').pid; // exited: its pid is gone
    mkdirSync(join(lib, `.imcodes-stage.${dead}`), { recursive: true });
    mkdirSync(join(fixture.globalRoot, `.imcodes-old.${dead}`), { recursive: true });
    mkdirSync(join(lib, `.imcodes-stage.${live.pid}`), { recursive: true });
    const result = run('recover', '--global-root', fixture.globalRoot, '--bin-dir', fixture.binDir);
    expect(result.status).toBe(0);
    expect(existsSync(join(lib, `.imcodes-stage.${dead}`))).toBe(false);
    expect(existsSync(join(fixture.globalRoot, `.imcodes-old.${dead}`))).toBe(false);
    expect(existsSync(join(lib, `.imcodes-stage.${live.pid}`))).toBe(true);
  });

  it('a switch whose second rename fails puts the previous package back (nothing staged to move)', () => {
    const before = treeHash(fixture.livePackage);
    const result = run('switch', '--global-root', fixture.globalRoot, '--tag', 'nostage', '--stage-prefix', join(fixture.prefix, 'lib', '.imcodes-stage.missing'));
    expect(result.status).toBe(75);
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  it('verify rejects a package whose declared bin is missing', () => {
    const dir = join(fixture.root, 'pkg');
    writePackage(dir, '1.2.3');
    rmSync(join(dir, 'dist', 'src', 'index.js'));
    const result = run('verify', '--pkg-dir', dir, '--target', '1.2.3');
    expect(result.status).toBe(75);
    expect(result.stdout).toContain('is missing');
  });

  it('still runs when invoked through a symlinked path (macOS /var vs /private/var): a helper that silently did nothing and exited 0 looked like a successful install', () => {
    const linkDir = join(fixture.root, 'linked');
    symlinkSync(fixture.scriptDir, linkDir);
    const copy = join(fixture.scriptDir, 'staged-package-install.mjs');
    copyFileSync(helper(), copy);
    const viaLink = spawnSync(process.execPath, [join(linkDir, 'staged-package-install.mjs'), 'verify', '--pkg-dir', join(fixture.root, 'nope')], { encoding: 'utf8' });
    expect(viaLink.status).toBe(75); // it ran, and failed as it should -- not a silent 0
    expect(viaLink.stdout).toContain('is not a directory');
  });

  it('installs with the flags the in-place upgrade always used, but into a --prefix stage and never `-g` on the live prefix', () => {
    const source = readFileSync(helper(), 'utf8');
    expect(source).toContain("['install', '-g', '--ignore-scripts', '--prefer-online', ...registryArgs(args), '--prefix', stagePrefix, pkgSpec]");
    // --prefer-online revalidates cached metadata; a cache wipe would redownload the whole dependency graph.
    expect(source).not.toMatch(/cache['"], ?['"]clean/);
  });

  describe('Windows layout and locked renames (the runner\'s use)', () => {
    const windowsEnv = (extra: Record<string, string> = {}) => ({ ...process.env, IMCODES_INSTALL_LAYOUT: 'windows', ...extra });
    const runWin = (extra: Record<string, string>, ...args: string[]) =>
      spawnSync(process.execPath, [helper(), ...args], { encoding: 'utf8', env: windowsEnv(extra) });

    it('switch finds the staged package at <stage>/node_modules/imcodes under the windows layout', () => {
      const stage = join(fixture.prefix, '.imcodes-stage.win1');
      writePackage(join(stage, 'node_modules', 'imcodes'), '3.0.0');
      const result = runWin({}, 'switch', '--global-root', fixture.globalRoot, '--tag', 'win1', '--stage-prefix', stage);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(liveVersion()).toBe('3.0.0');
    });

    it('a rename that stays locked past the retry budget exits 78 with the live package exactly as it was', () => {
      const stage = join(fixture.prefix, '.imcodes-stage.win2');
      writePackage(join(stage, 'node_modules', 'imcodes'), '3.0.0');
      const before = treeHash(fixture.livePackage);
      const started = Date.now();
      const result = runWin({ IMCODES_TEST_RENAME_FAIL_FOREVER: '1', IMCODES_RENAME_RETRY_MS: '700' }, 'switch', '--global-root', fixture.globalRoot, '--tag', 'win2', '--stage-prefix', stage);
      expect(result.status, result.stdout + result.stderr).toBe(78);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(treeHash(fixture.livePackage)).toBe(before);
      expect(leftovers()).toEqual([]);
    });

    it('a rename blocked twice then free succeeds inside the budget', () => {
      const stage = join(fixture.prefix, '.imcodes-stage.win3');
      writePackage(join(stage, 'node_modules', 'imcodes'), '3.0.0');
      const result = runWin({ IMCODES_TEST_RENAME_FAIL_COUNT: '2', IMCODES_RENAME_RETRY_MS: '15000' }, 'switch', '--global-root', fixture.globalRoot, '--tag', 'win3', '--stage-prefix', stage);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/succeeded on attempt/);
      expect(liveVersion()).toBe('3.0.0');
    });

    it('clean removes a tree under a path with spaces and non-ASCII names and proves it is gone (Node 24 rmSync keeps such paths on Windows)', () => {
      const tree = join(fixture.prefix, '.imcodes-stage.测试 dir', '前缀', 'node_modules', 'imcodes');
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, 'package.json'), '{}');
      const result = runWin({}, 'clean', '--path', join(fixture.prefix, '.imcodes-stage.测试 dir'));
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(join(fixture.prefix, '.imcodes-stage.测试 dir'))).toBe(false);
    });

    it('preflight: ok on a writable root, 77 on too little disk, 75 when the root does not exist', () => {
      const ok = runWin({}, 'preflight', '--global-root', fixture.globalRoot, '--pkg', 'imcodes@2.0.0', '--expected-bytes', '1000');
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      const tooBig = runWin({}, 'preflight', '--global-root', fixture.globalRoot, '--pkg', 'imcodes@2.0.0', '--expected-bytes', String(2 ** 60));
      expect(tooBig.status).toBe(77);
      const missing = runWin({}, 'preflight', '--global-root', join(fixture.prefix, 'nope'), '--pkg', 'imcodes@2.0.0', '--expected-bytes', '1000');
      expect(missing.status).toBe(75);
      expect(existsSync(join(fixture.globalRoot, `.imcodes-probe.${process.pid}`))).toBe(false);
    });
  });

  it('refuses an unknown command and missing arguments with a usage exit, never an install', () => {
    expect(run('bogus').status).toBe(2);
    expect(run('stage').status).toBe(2);
  });
});
