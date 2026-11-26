import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

    it('does not fail under pipefail when a match precedes a large manifest tail', () => {
      const command = [
        'payload=$( {',
        'printf "aaaa1111  node-v24.0.0-linux-x64.tar.gz\\n";',
        'head -c 1048576 /dev/zero | tr "\\0" x;',
        'printf "  filler.tar.gz\\n";',
        '} );',
        'node_shasum_for "$payload" "node-v24.0.0-linux-x64.tar.gz"',
      ].join(' ');
      expect(sourced(command)).toBe('aaaa1111');
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

  describe('R2 primary + npm fallback helpers', () => {
    it('maps installer channels to R2 channel directories', () => {
      expect(sourced('r2_channel_for_channel latest')).toBe('master');
      expect(sourced('r2_channel_for_channel dev')).toBe('dev');
      expect(sourcedExit('r2_channel_for_channel nightly')).not.toBe(0);
    });

    it('validates latest.json schema and rejects bad channels or malformed hashes', () => {
      const sha = 'a'.repeat(64);
      const valid = JSON.stringify({
        version: '2026.11.7090',
        channel: 'master',
        filename: 'imcodes-latest.tgz',
        sha256: sha,
        sizeBytes: 1234,
      });
      expect(sourced(`printf '%s' "$M" | parse_daemon_r2_manifest master`, { M: valid }))
        .toBe(`2026.11.7090\t${sha}\t1234`);
      expect(sourcedExit(`printf '%s' "$M" | parse_daemon_r2_manifest dev`, { M: valid })).not.toBe(0);
      expect(sourcedExit(`printf '{"channel":"master","filename":"imcodes-latest.tgz","version":"1.0.0","sha256":"bad","sizeBytes":10}' | parse_daemon_r2_manifest master`))
        .not.toBe(0);
    });

    it('try_install_from_r2 verifies SHA-256 + size, installs local tarball, and leaves zero temp leftovers', () => {
      const caseDir = mkdtempSync(join(dir, 'r2-ok-'));
      const payloadPath = join(caseDir, 'fixture.tgz');
      const payload = Buffer.from('fake-tarball-content');
      writeFileSync(payloadPath, payload);
      const sha = createHash('sha256').update(payload).digest('hex');
      const npmLog = join(caseDir, 'npm.log');
      const stubNpm = join(caseDir, 'npm');
      writeFileSync(stubNpm, `#!/usr/bin/env bash\necho "$@" > "${npmLog}"\n`, { mode: 0o755 });
      const manifest = JSON.stringify({
        version: '2026.11.7090',
        channel: 'master',
        filename: 'imcodes-latest.tgz',
        sha256: sha,
        sizeBytes: payload.length,
      });

      const tmpScope = join(caseDir, 'tmp');
      mkdirSync(tmpScope, { recursive: true });
      const exitCode = sourcedExit(
        [
          'ok() { :; }',
          `fetch_stdout() { printf '%s' "$MANIFEST"; }`,
          `fetch_file() { cp "${payloadPath}" "$2"; }`,
          `try_install_from_r2 latest "${stubNpm}" "https://registry.npmjs.org/"`,
        ].join('; '),
        { MANIFEST: manifest, TMPDIR: tmpScope },
      );
      expect(exitCode).toBe(0);
      expect(readdirSync(tmpScope)).toEqual([]);
      const logged = execFileSync('cat', [npmLog], { encoding: 'utf8' });
      expect(logged).toContain('install -g ');
      expect(logged).toContain('imcodes-latest.tgz --no-fund --no-audit --registry https://registry.npmjs.org/');
    });

    it('try_install_from_r2 cleans temp dir and returns non-zero on SHA-256 mismatch or opt-out', () => {
      const caseDir = mkdtempSync(join(dir, 'r2-fail-'));
      const payloadPath = join(caseDir, 'bad.tgz');
      writeFileSync(payloadPath, 'corrupted-bytes');
      const npmMarker = join(caseDir, 'npm-called');
      const stubNpm = join(caseDir, 'npm');
      writeFileSync(stubNpm, `#!/usr/bin/env bash\ntouch "${npmMarker}"\n`, { mode: 0o755 });
      const manifest = JSON.stringify({
        version: '2026.11.7090',
        channel: 'dev',
        filename: 'imcodes-latest.tgz',
        sha256: 'f'.repeat(64),
        sizeBytes: 'corrupted-bytes'.length,
      });

      const tmpScope = join(caseDir, 'tmp');
      mkdirSync(tmpScope, { recursive: true });
      const badExit = sourcedExit(
        [
          'ok() { :; }',
          `fetch_stdout() { printf '%s' "$MANIFEST"; }`,
          `fetch_file() { cp "${payloadPath}" "$2"; }`,
          `try_install_from_r2 dev "${stubNpm}" "https://registry.npmjs.org/"`,
        ].join('; '),
        { MANIFEST: manifest, TMPDIR: tmpScope },
      );
      expect(badExit).not.toBe(0);
      expect(existsSync(npmMarker)).toBe(false);
      expect(readdirSync(tmpScope)).toEqual([]);

      expect(sourcedExit(`try_install_from_r2 latest "${stubNpm}" "https://registry.npmjs.org/"`, { IMCODES_USE_R2: 'false' })).not.toBe(0);
      expect(sourcedExit(`try_install_from_r2 latest "${stubNpm}" "https://registry.npmjs.org/"`, { IMCODES_R2_BASE_URL: 'http://insecure.local' })).not.toBe(0);
    });
  });

  describe('real isolated E2E execution of landing/install.sh with a packed tarball', () => {
    it('installs a real packed imcodes tarball via R2 primary into an isolated HOME + prefix and falls back on SHA-256 mismatch', () => {
      const e2eRoot = mkdtempSync(join(dir, 'e2e-'));
      const pkgSrc = join(e2eRoot, 'pkg-src');
      const packDest = join(e2eRoot, 'pack-dest');
      mkdirSync(join(pkgSrc, 'bin'), { recursive: true });
      mkdirSync(packDest, { recursive: true });
      writeFileSync(join(pkgSrc, 'package.json'), JSON.stringify({
        name: 'imcodes',
        version: '2026.11.9999',
        bin: { imcodes: 'bin/imcodes.js' },
      }));
      writeFileSync(join(pkgSrc, 'bin', 'imcodes.js'), '#!/usr/bin/env node\nconsole.log("2026.11.9999");\n', { mode: 0o755 });
      execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: pkgSrc, stdio: 'pipe' });
      const packedName = readdirSync(packDest).find((f) => f.endsWith('.tgz'));
      expect(packedName).toBeTruthy();
      const packedTgz = join(packDest, packedName!);
      const tgzBytes = execFileSync('cat', [packedTgz]);
      const tgzSha = createHash('sha256').update(tgzBytes).digest('hex');

      const isoHome = join(e2eRoot, 'iso-home');
      const isoInstallRoot = join(e2eRoot, 'iso-install-root');
      const isoPrefix = join(e2eRoot, 'iso-npm-prefix');
      const tmpScope = join(e2eRoot, 'tmp');
      const shimBin = join(e2eRoot, 'shim-bin');
      mkdirSync(isoHome, { recursive: true });
      mkdirSync(isoInstallRoot, { recursive: true });
      mkdirSync(join(isoPrefix, 'lib', 'node_modules'), { recursive: true });
      mkdirSync(join(isoPrefix, 'bin'), { recursive: true });
      mkdirSync(tmpScope, { recursive: true });
      mkdirSync(shimBin, { recursive: true });
      writeFileSync(join(isoHome, '.npmrc'), `prefix=${isoPrefix}\n`);

      const manifestFile = join(e2eRoot, 'latest.json');
      writeFileSync(manifestFile, JSON.stringify({
        version: '2026.11.9999',
        channel: 'master',
        filename: 'imcodes-latest.tgz',
        sha256: tgzSha,
        sizeBytes: tgzBytes.length,
      }));

      // Isolated curl shim: serves local R2 manifest/tarball and blocks any external network call.
      writeFileSync(
        join(shimBin, 'curl'),
        `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -m|-w|-X) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *latest.json)
    cat "${manifestFile}"
    ;;
  *imcodes-latest.tgz)
    if [ -n "$out" ]; then cp "${packedTgz}" "$out"; else cat "${packedTgz}"; fi
    ;;
  *)
    echo "unexpected curl URL in isolated E2E test: $url" >&2
    exit 22
    ;;
esac
`,
        { mode: 0o755 },
      );

      // Strip all inherited npm_* / npm_config_* / NPM_CONFIG_* env vars (npx exports
      // lowercase npm_config_prefix=/opt/homebrew which overrides NPM_CONFIG_PREFIX).
      const cleanBaseEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower.startsWith('npm_') || lower.startsWith('npm_config_')) continue;
        cleanBaseEnv[k] = v;
      }
      const isolatedNpmRc = join(isoHome, '.npmrc');
      const isolatedGlobalNpmRc = join(isoHome, '.npmrc.global');
      writeFileSync(isolatedNpmRc, `prefix=${isoPrefix}\n`);
      writeFileSync(isolatedGlobalNpmRc, `prefix=${isoPrefix}\n`);

      const isolatedEnv: Record<string, string> = {
        ...cleanBaseEnv,
        HOME: isoHome,
        TMPDIR: tmpScope,
        NPM_CONFIG_PREFIX: isoPrefix,
        NPM_CONFIG_USERCONFIG: isolatedNpmRc,
        NPM_CONFIG_GLOBALCONFIG: isolatedGlobalNpmRc,
        PATH: `${shimBin}:${isoPrefix}/bin:${process.env.PATH ?? ''}`,
      };

      // Hard safety preflight: abort BEFORE running install.sh if npm root -g resolves outside e2eRoot.
      const resolvedGlobalRoot = realpathSync(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env: isolatedEnv }).trim());
      const expectedGlobalRoot = realpathSync(join(isoPrefix, 'lib', 'node_modules'));
      if (resolvedGlobalRoot !== expectedGlobalRoot) {
        throw new Error(`Refusing E2E run: isolated npm root -g resolved to ${resolvedGlobalRoot} instead of ${expectedGlobalRoot}`);
      }

      const stdout = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', isoInstallRoot],
        { ...EXEC_OPTS, env: isolatedEnv },
      );
      expect(stdout).toContain('downloading imcodes@2026.11.9999 from R2 (master)');
      expect(stdout).toContain('imcodes installed  2026.11.9999');
      expect(execFileSync(join(isoPrefix, 'bin', 'imcodes'), ['--version'], { encoding: 'utf8', env: isolatedEnv }).trim()).toBe('2026.11.9999');
      expect(readdirSync(tmpScope).filter((n) => n.startsWith('imcodes-r2-'))).toEqual([]);

      // Fallback scenario: tamper expected sha256 -> install.sh must clean R2 temp dir and fall back to npm install -g imcodes@latest
      writeFileSync(manifestFile, JSON.stringify({
        version: '2026.11.9999',
        channel: 'master',
        filename: 'imcodes-latest.tgz',
        sha256: '0'.repeat(64),
        sizeBytes: tgzBytes.length,
      }));
      const npmShimBin = join(e2eRoot, 'npm-shim-bin');
      const fallbackLog = join(e2eRoot, 'fallback-npm.log');
      mkdirSync(npmShimBin, { recursive: true });
      writeFileSync(
        join(npmShimBin, 'npm'),
        `#!/usr/bin/env bash
echo "$@" >> "${fallbackLog}"
if [ "\${1:-}" = "root" ]; then echo "${isoPrefix}/lib/node_modules"; exit 0; fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const fallbackOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', isoInstallRoot],
        {
          ...EXEC_OPTS,
          env: {
            ...isolatedEnv,
            PATH: `${shimBin}:${npmShimBin}:${isoPrefix}/bin:${process.env.PATH ?? ''}`,
          },
        },
      );
      expect(fallbackOut).toContain('falling back to npm');
      const loggedNpm = execFileSync('cat', [fallbackLog], { encoding: 'utf8' });
      expect(loggedNpm).toContain('install -g imcodes@latest --no-fund --no-audit --registry https://registry.npmjs.org/');
      expect(readdirSync(tmpScope).filter((n) => n.startsWith('imcodes-r2-'))).toEqual([]);
    });

    it('passes bash syntax check on install.sh and init.sh and validates init.sh R2 helpers', () => {
      const initScript = join(HERE, '..', '..', 'landing', 'init.sh');
      execFileSync('bash', ['-n', SCRIPT, initScript], { encoding: 'utf8' });
      const initSrc = execFileSync('cat', [initScript], { encoding: 'utf8' });
      expect(initSrc).toContain('try_install_from_r2');
      expect(initSrc).toContain('parse_daemon_r2_manifest');
      expect(initSrc).toContain('npm install -g --no-fund --no-audit --registry "$NPM_REGISTRY" "imcodes@$CHANNEL"');
    });
  });
});
