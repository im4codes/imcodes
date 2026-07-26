import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPosixUpgradeLayoutRecoveryScript,
  parsePosixUpgradeFailureStatus,
} from '../../src/util/posix-upgrade-layout-recovery.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-layout-'));
  tempDirs.push(dir);
  return dir;
}

function runRecoveryHarness(body: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', `
set -u
log() { :; }
${buildPosixUpgradeLayoutRecoveryScript()}
${body}
`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describePosix('POSIX daemon-upgrade npm layout recovery', () => {
  it('removes only old interrupted .imcodes-* siblings before npm install', () => {
    const root = makeTempDir();
    const current = join(root, 'imcodes');
    const staleA = join(root, '.imcodes-Vuo7WXWs');
    const staleB = join(root, '.imcodes-other');
    const recent = join(root, '.imcodes-active-install');
    mkdirSync(current);
    mkdirSync(join(staleA, 'nested'), { recursive: true });
    mkdirSync(staleB);
    mkdirSync(recent);
    writeFileSync(join(staleA, 'nested', 'leftover'), 'stale');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(staleA, old, old);
    utimesSync(staleB, old, old);

    const result = runRecoveryHarness('cleanup_stale_imcodes_staging_dirs "$ROOT" 1800', { ROOT: root });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleB)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('preserves a recent staging directory that may belong to an active external npm install', () => {
    const root = makeTempDir();
    const active = join(root, '.imcodes-active-install');
    mkdirSync(active);
    writeFileSync(join(active, 'in-progress'), 'active');

    const result = runRecoveryHarness('cleanup_stale_imcodes_staging_dirs "$ROOT" 1800', { ROOT: root });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(active)).toBe(true);
  });

  it.each(['ENOTEMPTY', 'EEXIST'])('classifies %s rename collisions and removes the exact stale destination', (code) => {
    const root = makeTempDir();
    const current = join(root, 'imcodes');
    const stale = join(root, '.imcodes-Vuo7WXWs');
    const output = join(root, 'npm-output.log');
    mkdirSync(current);
    mkdirSync(stale);
    writeFileSync(join(stale, 'leftover'), 'stale');
    writeFileSync(output, [
      `npm error code ${code}`,
      'npm error syscall rename',
      `npm error path ${current}`,
      `npm error dest ${stale}`,
      `npm error ${code}: directory not empty`,
      '',
    ].join('\n'));

    const result = runRecoveryHarness(
      'is_recoverable_layout_output "$OUTPUT" "$ROOT" && recover_stale_layout_from_output "$OUTPUT" "$ROOT"',
      { ROOT: root, OUTPUT: output },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it.each([
    ['EACCES', 'rename'],
    ['E401', 'rename'],
    ['ENOTEMPTY', 'unlink'],
  ])('does not retry or clean a genuine non-layout failure (%s/%s)', (code, syscall) => {
    const root = makeTempDir();
    const current = join(root, 'imcodes');
    const stale = join(root, '.imcodes-Vuo7WXWs');
    const output = join(root, 'npm-output.log');
    mkdirSync(current);
    mkdirSync(stale);
    writeFileSync(join(stale, 'must-stay'), 'data');
    writeFileSync(output, [
      `npm error code ${code}`,
      `npm error syscall ${syscall}`,
      `npm error path ${current}`,
      `npm error dest ${stale}`,
      '',
    ].join('\n'));

    const result = runRecoveryHarness(
      'if is_recoverable_layout_output "$OUTPUT" "$ROOT"; then exit 42; fi',
      { ROOT: root, OUTPUT: output },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it('rejects a rename destination outside the global package root', () => {
    const root = makeTempDir();
    const outsideRoot = makeTempDir();
    const current = join(root, 'imcodes');
    const outside = join(outsideRoot, '.imcodes-Vuo7WXWs');
    const output = join(root, 'npm-output.log');
    mkdirSync(current);
    mkdirSync(outside);
    writeFileSync(output, [
      'npm error code ENOTEMPTY',
      'npm error syscall rename',
      `npm error path ${current}`,
      `npm error dest ${outside}`,
      '',
    ].join('\n'));

    const result = runRecoveryHarness(
      'if is_recoverable_layout_output "$OUTPUT" "$ROOT"; then exit 42; fi',
      { ROOT: root, OUTPUT: output },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('POSIX daemon-upgrade failure marker', () => {
  it('accepts the bounded install-failure status emitted by the detached script', () => {
    expect(parsePosixUpgradeFailureStatus(JSON.stringify({
      state: 'blocked',
      reason: 'install_failed',
      retryReason: 'stale-staging-dir',
      attempts: 3,
      exitCode: 217,
    }))).toEqual({
      state: 'blocked',
      reason: 'install_failed',
      retryReason: 'stale-staging-dir',
      attempts: 3,
      exitCode: 217,
    });
  });

  it('rejects malformed or unbounded failure markers', () => {
    expect(parsePosixUpgradeFailureStatus('not-json')).toBeNull();
    expect(parsePosixUpgradeFailureStatus(JSON.stringify({
      state: 'blocked',
      reason: 'install_failed',
      retryReason: '../../escape',
      attempts: 0,
      exitCode: 999,
    }))).toBeNull();
  });
});
