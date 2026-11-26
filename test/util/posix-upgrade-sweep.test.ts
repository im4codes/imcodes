/**
 * The POSIX daemon-upgrade script no longer leaves a `sleep 86400 && rm -rf` process behind per attempt (26 piled up on a Mac whose
 * install kept failing and retrying). Old attempts' directories are removed by the NEXT attempt instead. These tests run the REAL
 * generated functions in /bin/sh against scratch directories.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPosixUpgradeScript } from '../../src/util/posix-upgrade-script.js';

const HOUR = 3600;
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-sweep-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function script(scriptDir: string): string {
  return buildPosixUpgradeScript({
    logFile: join(scriptDir, 'upgrade.log'), scriptDir, statusFile: join(scriptDir, 'upgrade-status.json'), registryArg: '',
    pkgSpec: 'imcodes@2.0.0', targetVer: '2.0.0', currentVer: '1.0.0', oldDaemonPid: null, restartCmd: 'true',
    cleanupAfterSec: 24 * HOUR, stateDir: join(root, 'state'), nodeBin: '/usr/bin/node', nodeDir: '/usr/bin',
    atomicInstallerPath: join(scriptDir, 'staged-package-install.mjs'),
  });
}

function makeAttempt(name: string, ageHours: number, withScript = true): string {
  const dir = join(root, name);
  mkdirSync(dir);
  if (withScript) writeFileSync(join(dir, 'upgrade.sh'), '#!/bin/bash\n');
  writeFileSync(join(dir, 'upgrade.log'), 'log\n');
  const when = new Date(Date.now() - ageHours * HOUR * 1000);
  utimesSync(dir, when, when);
  return dir;
}

/** Runs the generated sweep function (and only it) as attempt `current`. */
function sweep(current: string): { status: number | null; log: string } {
  const text = script(current);
  const start = text.indexOf('sweep_old_upgrade_dirs() {');
  const end = text.indexOf('\nschedule_self_cleanup()');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = text.slice(start, end);
  const logFile = join(root, 'sweep.log');
  const run = spawnSync('/bin/sh', ['-c', `LOG="$1"; SCRIPT_DIR="$2"; CLEANUP_AFTER_SEC=$3
log() { echo "$*" >> "$LOG"; }
${body}
sweep_old_upgrade_dirs`, 'sh', logFile, current, String(24 * HOUR)], { encoding: 'utf8' });
  return { status: run.status, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

describe('the POSIX upgrade script leaves no timer process behind', () => {
  it('has no background sleeper on any platform, and keeps the Linux user-unit path', () => {
    const text = script(join(root, 'imcodes-upgrade-current'));
    expect(text).not.toMatch(/\bsleep "\$CLEANUP_AFTER_SEC"\s*&&/);
    expect(text).not.toMatch(/\)\s*>\/dev\/null 2>&1 &\s*\n\s*log "\[cleanup\] scheduled via background sleeper"/);
    expect(text).toContain('systemd-run --user --unit="$CLEANUP_UNIT"');
    expect(text).toContain('skipped background sleeper on Linux to avoid leaking into imcodes.service cgroup');
  });

  it('removes only old, ours-looking attempt directories of the same parent, and never the current one', () => {
    const oldA = makeAttempt('imcodes-upgrade-aaaa', 30);
    const oldB = makeAttempt('imcodes-upgrade-bbbb', 25);
    const young = makeAttempt('imcodes-upgrade-young', 2);
    const noScript = makeAttempt('imcodes-upgrade-noscript', 40, false);
    const foreignName = makeAttempt('other-upgrade-old', 40);
    const current = makeAttempt('imcodes-upgrade-current', 48);
    const outside = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-sweep-outside-'));
    try {
      writeFileSync(join(outside, 'upgrade.sh'), 'x');
      symlinkSync(outside, join(root, 'imcodes-upgrade-link'));
      const result = sweep(current);
      expect(result.status).toBe(0);
      expect(existsSync(oldA)).toBe(false);
      expect(existsSync(oldB)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(noScript)).toBe(true);
      expect(existsSync(foreignName)).toBe(true);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(join(outside, 'upgrade.sh'))).toBe(true);
      expect(result.log).toContain('removed old upgrade directory: imcodes-upgrade-aaaa');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes at most 64 directories per run', () => {
    const current = makeAttempt('imcodes-upgrade-current', 1);
    const names = Array.from({ length: 70 }, (_, index) => `imcodes-upgrade-old${String(index).padStart(3, '0')}`);
    for (const name of names) makeAttempt(name, 30);
    expect(sweep(current).status).toBe(0);
    const left = names.filter((name) => existsSync(join(root, name)));
    expect(left.length).toBe(6);
    expect(sweep(current).status).toBe(0);
    expect(names.filter((name) => existsSync(join(root, name)))).toEqual([]);
  });

  it('does nothing when the current script directory is not an attempt directory of ours', () => {
    const odd = makeAttempt('scratch-run', 1);
    const old = makeAttempt('imcodes-upgrade-old', 30);
    expect(sweep(odd).status).toBe(0);
    expect(existsSync(old)).toBe(true);
  });
});
