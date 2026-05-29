import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Equivalent unit coverage for landing/install.sh — the macOS/Linux one-click
// installer. Mirrors the static parse check the install-smoke workflow does for
// install.ps1, but goes further: it sources the script in LIB mode
// (IMCODES_INSTALL_LIB=1 stops it before the imperative install flow) and
// exercises the pure helpers, plus runs the real script with bad args to lock
// the early validation. None of this touches the network or installs anything.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'landing', 'install.sh');
const EXEC_OPTS = { encoding: 'utf8' as const, timeout: 20_000 };

// Source the installer in lib mode and run a snippet against its helpers.
function sourced(snippet: string, env: Record<string, string> = {}): string {
  return execFileSync(
    'bash',
    ['-c', `source "${SCRIPT}"; ${snippet}`],
    { ...EXEC_OPTS, env: { ...process.env, IMCODES_INSTALL_LIB: '1', ...env } },
  ).trim();
}

// Run a snippet in lib mode and return its exit code (0 on success).
function sourcedExit(snippet: string, env: Record<string, string> = {}): number {
  try {
    execFileSync(
      'bash',
      ['-c', `source "${SCRIPT}"; ${snippet}`],
      { ...EXEC_OPTS, stdio: 'pipe', env: { ...process.env, IMCODES_INSTALL_LIB: '1', ...env } },
    );
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

// Execute the real script (NOT lib mode) with the given args. Only ever call
// this with INVALID args — they exit at validation, before any network/install.
function runArgs(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync('bash', [SCRIPT, ...args], { ...EXEC_OPTS, stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return { code: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
}

const SHASUMS = [
  'aaaa1111  node-v24.0.0-linux-x64.tar.gz',
  'bbbb2222  node-v24.0.0-darwin-arm64.tar.gz',
  'cccc3333  node-v24.0.0-darwin-arm64.tar.xz', // same prefix, different ext
].join('\n');

// install.sh is a bash script for Linux/macOS; skip on Windows (its installer
// is install.ps1, covered separately by the install-smoke syntax job).
describe.skipIf(process.platform === 'win32')('landing/install.sh helpers', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'imcodes-install-sh-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('node_shasum_for', () => {
    it('extracts the SHA256 for an exact tarball field match', () => {
      expect(sourced('node_shasum_for "$SH" "node-v24.0.0-darwin-arm64.tar.gz"', { SH: SHASUMS }))
        .toBe('bbbb2222');
      expect(sourced('node_shasum_for "$SH" "node-v24.0.0-linux-x64.tar.gz"', { SH: SHASUMS }))
        .toBe('aaaa1111');
    });

    it('returns nothing when the tarball is absent', () => {
      expect(sourced('node_shasum_for "$SH" "node-v99.9.9-linux-x64.tar.gz"', { SH: SHASUMS }))
        .toBe('');
    });

    it('matches the name as a whole field, not a substring (no false positives)', () => {
      // A substring of a real entry must NOT match — guards against a regex/grep
      // regression that could pick the wrong (or a poisoned) hash.
      expect(sourced('node_shasum_for "$SH" "linux-x64.tar.gz"', { SH: SHASUMS })).toBe('');
      // Different extension with the same prefix resolves to its own hash.
      expect(sourced('node_shasum_for "$SH" "node-v24.0.0-darwin-arm64.tar.xz"', { SH: SHASUMS }))
        .toBe('cccc3333');
    });
  });

  describe('verify_sha256', () => {
    it('succeeds when the file hash matches', () => {
      const f = join(dir, 'good.bin');
      writeFileSync(f, 'hello imcodes');
      const hash = createHash('sha256').update('hello imcodes').digest('hex');
      expect(sourcedExit(`verify_sha256 "${f}" "${hash}"`)).toBe(0);
    });

    it('fails when the file hash does not match', () => {
      const f = join(dir, 'bad.bin');
      writeFileSync(f, 'hello imcodes');
      const wrong = '0'.repeat(64);
      expect(sourcedExit(`verify_sha256 "${f}" "${wrong}"`)).not.toBe(0);
    });
  });

  describe('argument validation (exits before any network/install)', () => {
    it('rejects an invalid --channel', () => {
      const r = runArgs(['--channel', 'bogus']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/channel/i);
    });

    it('rejects a non-numeric --node-major', () => {
      expect(runArgs(['--node-major', 'abc']).code).not.toBe(0);
    });

    it('rejects an invalid --source', () => {
      const r = runArgs(['--source', 'nope']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/source/i);
    });

    it('rejects a root / empty --install-root', () => {
      expect(runArgs(['--install-root', '/']).code).not.toBe(0);
      expect(runArgs(['--install-root', '']).code).not.toBe(0);
    });

    it('rejects an unknown flag', () => {
      const r = runArgs(['--definitely-not-a-flag']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/unknown/i);
    });
  });
});
