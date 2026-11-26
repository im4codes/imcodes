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
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', isoInstallRoot, '--skip-opencode'],
        { ...EXEC_OPTS, env: isolatedEnv },
      );
      expect(stdout).toContain('downloading imcodes@2026.11.9999 from R2 (master)');
      expect(stdout).toContain('imcodes installed  2026.11.9999');
      expect(stdout).toContain('OpenCode CLI: skipped');
      expect(execFileSync(join(isoPrefix, 'bin', 'imcodes'), ['--version'], { encoding: 'utf8', env: isolatedEnv }).trim()).toBe('2026.11.9999');
      expect(readdirSync(tmpScope).filter((n) => n.startsWith('imcodes-r2-'))).toEqual([]);

      // Fallback scenario: tamper expected sha256 -> install.sh must clean R2 temp dir and fall back to npm install -g imcodes@latest
      // and also install opencode-ai cleanly via the same mirror/direct registry without failing.
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
if [[ "$*" == *"opencode-ai"* ]]; then
  printf '#!/usr/bin/env bash\necho "1.19.6"\n' > "${isoPrefix}/bin/opencode"
  chmod +x "${isoPrefix}/bin/opencode"
fi
exit 0
`,
        { mode: 0o755 },
      );
      const pathWithoutOpencode = (process.env.PATH ?? '')
        .split(':')
        .filter((d) => d && !existsSync(join(d, 'opencode')))
        .join(':');

      const fallbackOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', isoInstallRoot],
        {
          ...EXEC_OPTS,
          env: {
            ...isolatedEnv,
            PATH: `${shimBin}:${npmShimBin}:${isoPrefix}/bin:${pathWithoutOpencode}`,
          },
        },
      );
      expect(fallbackOut).toContain('falling back to npm');
      expect(fallbackOut).toContain('OpenCode CLI: ready');
      const loggedNpm = execFileSync('cat', [fallbackLog], { encoding: 'utf8' });
      expect(loggedNpm).toContain('install -g imcodes@latest --no-fund --no-audit --registry https://registry.npmjs.org/');
      expect(loggedNpm).toContain('install -g opencode-ai --no-fund --no-audit --registry https://registry.npmjs.org/');
      expect(readdirSync(tmpScope).filter((n) => n.startsWith('imcodes-r2-'))).toEqual([]);
      // Ensure ~/.npmrc was NOT mutated to point at a registry
      expect(execFileSync('cat', [isolatedNpmRc], { encoding: 'utf8' })).toBe(`prefix=${isoPrefix}\n`);
    });

    it('auto-installs opencode-ai offline via helper, respects skip/existing detection, and stays non-blocking on npm failure', () => {
      const ocRoot = mkdtempSync(join(dir, 'oc-case-'));
      const cleanPath = (process.env.PATH ?? '')
        .split(':')
        .filter((d) => d && !existsSync(join(d, 'opencode')))
        .join(':');

      // 1) --skip-opencode flag & IMCODES_SKIP_OPENCODE=1 skip without invoking npm
      const skipNpmMarker = join(ocRoot, 'skip-npm-called');
      const skipBinDir = join(ocRoot, 'bin with spaces');
      mkdirSync(skipBinDir, { recursive: true });
      const stubNpmSpace = join(skipBinDir, 'npm');
      writeFileSync(
        stubNpmSpace,
        `#!/usr/bin/env bash\ntouch "${skipNpmMarker}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const skipHome = join(ocRoot, 'home with spaces');
      mkdirSync(skipHome, { recursive: true });

      const envSkipOut = sourced(
        `try_install_opencode_cli "${stubNpmSpace}" "https://mirrors.cloud.tencent.com/npm/"; echo "STATUS=$OPENCODE_STATUS"`,
        { HOME: skipHome, PATH: `${skipBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '1' },
      );
      expect(envSkipOut).toContain('STATUS=skipped');
      expect(existsSync(skipNpmMarker)).toBe(false);

      const flagSkipOut = sourced(
        `SKIP_OPENCODE=1; try_install_opencode_cli "${stubNpmSpace}" "https://registry.npmjs.org/"; echo "STATUS=$OPENCODE_STATUS"`,
        { HOME: skipHome, PATH: `${skipBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(flagSkipOut).toContain('STATUS=skipped');
      expect(existsSync(skipNpmMarker)).toBe(false);

      // 2a) Existing `opencode` on PATH skips npm
      const pathOcDir = join(ocRoot, 'path-oc-bin');
      mkdirSync(pathOcDir, { recursive: true });
      writeFileSync(join(pathOcDir, 'opencode'), '#!/usr/bin/env bash\necho "1.19.6"\n', { mode: 0o755 });
      const pathExistOut = sourced(
        `try_install_opencode_cli "${stubNpmSpace}" "https://registry.npmjs.org/"; echo "STATUS=$OPENCODE_STATUS"`,
        { HOME: skipHome, PATH: `${pathOcDir}:${skipBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(pathExistOut).toContain('STATUS=existing');
      expect(pathExistOut).toContain('1.19.6');
      expect(existsSync(skipNpmMarker)).toBe(false);

      // 2b) Existing `~/.opencode/bin/opencode` (NOT initially on PATH) skips npm AND exposes dir on running PATH + OPENCODE_PATH_DIR (without overwriting PATH_DIR)
      const dotOcHome = join(ocRoot, 'dot-oc-home');
      mkdirSync(join(dotOcHome, '.opencode', 'bin'), { recursive: true });
      writeFileSync(join(dotOcHome, '.opencode', 'bin', 'opencode'), '#!/usr/bin/env bash\necho "1.18.0"\n', { mode: 0o755 });
      const dotExistOut = sourced(
        `PATH_DIR="/tmp/existing-node-bin"; try_install_opencode_cli "${stubNpmSpace}" "https://registry.npmjs.org/"; RESOLVED="$(command -v opencode 2>/dev/null || true)"; echo "STATUS=$OPENCODE_STATUS RESOLVED=$RESOLVED PATH_DIR=$PATH_DIR OPENCODE_PATH_DIR=$OPENCODE_PATH_DIR"`,
        { HOME: dotOcHome, PATH: `${skipBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(dotExistOut).toContain('STATUS=existing');
      expect(dotExistOut).toContain('1.18.0');
      expect(dotExistOut).toContain(`RESOLVED=${join(dotOcHome, '.opencode', 'bin', 'opencode')}`);
      expect(dotExistOut).toContain('PATH_DIR=/tmp/existing-node-bin');
      expect(dotExistOut).toContain(`OPENCODE_PATH_DIR=${join(dotOcHome, '.opencode', 'bin')}`);
      expect(existsSync(skipNpmMarker)).toBe(false);

      // 2c) Full E2E with existing `~/.opencode/bin/opencode` (not on PATH) + non-writable global npm root:
      // ~/.profile must persist BOTH `# >>> IM.codes installer >>>` (npm-global/bin) AND `# >>> IM.codes OpenCode CLI >>>` (~/.opencode/bin)
      const dotE2eRoot = mkdtempSync(join(dir, 'dot-oc-e2e-'));
      const dotE2eHome = join(dotE2eRoot, 'home');
      const dotE2ePrefix = join(dotE2eRoot, 'install-root', 'npm-global');
      const dotE2eReadonlyRoot = join(dotE2eRoot, 'readonly-global-root');
      const dotE2eShim = join(dotE2eRoot, 'shim');
      mkdirSync(join(dotE2eHome, '.opencode', 'bin'), { recursive: true });
      mkdirSync(dotE2eReadonlyRoot, { recursive: true, mode: 0o555 });
      mkdirSync(dotE2eShim, { recursive: true });
      writeFileSync(join(dotE2eHome, '.opencode', 'bin', 'opencode'), '#!/usr/bin/env bash\necho "1.18.0"\n', { mode: 0o755 });
      writeFileSync(
        join(dotE2eShim, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "root" ]; then echo "${dotE2eReadonlyRoot}"; exit 0; fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "set" ] && [ "\${3:-}" = "prefix" ]; then
  mkdir -p "\${4}/bin"
  printf '#!/usr/bin/env bash\\necho "2026.11.9999"\\n' > "\${4}/bin/imcodes"
  chmod +x "\${4}/bin/imcodes"
  exit 0
fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const dotE2eOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', join(dotE2eRoot, 'install-root')],
        {
          ...EXEC_OPTS,
          env: {
            PATH: `${dotE2eShim}:${cleanPath}`,
            HOME: dotE2eHome,
            TMPDIR: dotE2eRoot,
            IMCODES_USE_R2: 'false',
          },
        },
      );
      expect(dotE2eOut).toContain('OpenCode CLI: ready');
      const profileSrc = execFileSync('cat', [join(dotE2eHome, '.profile')], { encoding: 'utf8' });
      expect(profileSrc).toContain('# >>> IM.codes installer >>>');
      expect(profileSrc).toContain(`${dotE2ePrefix}/bin`);
      expect(profileSrc).toContain('# >>> IM.codes OpenCode CLI >>>');
      expect(profileSrc).toContain(`${dotE2eHome}/.opencode/bin`);
      const freshShellOut = execFileSync(
        'bash',
        ['-c', `PATH="/usr/bin:/bin"; source "${join(dotE2eHome, '.profile')}"; echo "IM=$(command -v imcodes) OC=$(command -v opencode)"`],
        { ...EXEC_OPTS, env: { HOME: dotE2eHome, PATH: '/usr/bin:/bin' } },
      ).trim();
      expect(freshShellOut).toContain(`IM=${join(dotE2ePrefix, 'bin', 'imcodes')}`);
      expect(freshShellOut).toContain(`OC=${join(dotE2eHome, '.opencode', 'bin', 'opencode')}`);

      // 2d) Re-install counterexample: existing .profile holds `# >>> IM.codes installer >>>` with old imcodes/npm bin already sourced on PATH
      // (so PATH_DIR=""), plus newly discovered ~/.opencode/bin/opencode -> must KEEP `# >>> IM.codes installer >>>` untouched and add `# >>> IM.codes OpenCode CLI >>>`.
      const reinstRoot = mkdtempSync(join(dir, 'reinst-'));
      const reinstHome = join(reinstRoot, 'home');
      const reinstOldBin = join(reinstRoot, 'old-imcodes-bin');
      const reinstGlobalRoot = join(reinstRoot, 'writable-global-root');
      const reinstProfile = join(reinstHome, '.profile');
      mkdirSync(join(reinstHome, '.opencode', 'bin'), { recursive: true });
      mkdirSync(reinstOldBin, { recursive: true });
      mkdirSync(reinstGlobalRoot, { recursive: true });
      writeFileSync(join(reinstHome, '.opencode', 'bin', 'opencode'), '#!/usr/bin/env bash\necho "1.19.6"\n', { mode: 0o755 });
      writeFileSync(join(reinstOldBin, 'imcodes'), '#!/usr/bin/env bash\necho "2026.11.9999"\n', { mode: 0o755 });
      writeFileSync(
        join(reinstOldBin, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "root" ]; then echo "${reinstGlobalRoot}"; exit 0; fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const initialProfile = [
        '# user line before',
        '# >>> IM.codes installer >>>',
        `export PATH='${reinstOldBin}':"$PATH"`,
        '# <<< IM.codes installer <<<',
        '',
      ].join('\n');
      writeFileSync(reinstProfile, initialProfile);
      const reinstOut = execFileSync(
        'bash',
        ['-c', `PATH="${cleanPath}"; source "${reinstProfile}"; bash "${SCRIPT}" --channel latest --source direct --install-root "${join(reinstRoot, 'ir')}"`],
        {
          ...EXEC_OPTS,
          env: {
            PATH: cleanPath,
            HOME: reinstHome,
            TMPDIR: reinstRoot,
            IMCODES_USE_R2: 'false',
          },
        },
      );
      expect(reinstOut).toContain('OpenCode CLI: ready');
      const reinstProfileAfter = execFileSync('cat', [reinstProfile], { encoding: 'utf8' });
      expect(reinstProfileAfter).toContain(`export PATH='${reinstOldBin}':"$PATH"`);
      expect(reinstProfileAfter).toContain('# >>> IM.codes OpenCode CLI >>>');
      expect(reinstProfileAfter).toContain(`${reinstHome}/.opencode/bin`);
      const reinstFreshShell = execFileSync(
        'bash',
        ['-c', `PATH="/usr/bin:/bin"; source "${reinstProfile}"; echo "IM=$(command -v imcodes) OC=$(command -v opencode)"`],
        { ...EXEC_OPTS, env: { HOME: reinstHome, PATH: '/usr/bin:/bin' } },
      ).trim();
      expect(reinstFreshShell).toContain(`IM=${join(reinstOldBin, 'imcodes')}`);
      expect(reinstFreshShell).toContain(`OC=${join(reinstHome, '.opencode', 'bin', 'opencode')}`);

      // 2e) Read-only ~/.profile counterexample: optional OpenCode PATH persistence failure MUST remain non-blocking (exit 0 + Done printed + file untouched)
      const roRoot = mkdtempSync(join(dir, 'ro-profile-'));
      const roHome = join(roRoot, 'home');
      const roBin = join(roRoot, 'old-bin');
      const roGlobalRoot = join(roRoot, 'writable-root');
      const roProfile = join(roHome, '.profile');
      mkdirSync(join(roHome, '.opencode', 'bin'), { recursive: true });
      mkdirSync(roBin, { recursive: true });
      mkdirSync(roGlobalRoot, { recursive: true });
      writeFileSync(join(roHome, '.opencode', 'bin', 'opencode'), '#!/usr/bin/env bash\necho "1.19.6"\n', { mode: 0o755 });
      writeFileSync(join(roBin, 'imcodes'), '#!/usr/bin/env bash\necho "2026.11.9999"\n', { mode: 0o755 });
      writeFileSync(
        join(roBin, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "root" ]; then echo "${roGlobalRoot}"; exit 0; fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const roContent = `# existing readonly profile\n# >>> IM.codes installer >>>\nexport PATH='${roBin}':"$PATH"\n# <<< IM.codes installer <<<\n`;
      writeFileSync(roProfile, roContent, { mode: 0o444 });
      const roOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', join(roRoot, 'ir')],
        {
          ...EXEC_OPTS,
          env: {
            PATH: `${roBin}:${cleanPath}`,
            HOME: roHome,
            TMPDIR: roRoot,
            IMCODES_USE_R2: 'false',
          },
        },
      );
      expect(roOut).toContain('WARNING: could not persist OpenCode PATH');
      expect(roOut).toContain('imcodes installed  2026.11.9999');
      expect(roOut).toContain('OpenCode CLI: installed; add its bin directory to PATH for shells whose startup file could not be updated');
      expect(roOut).not.toContain('OpenCode CLI: ready');
      expect(execFileSync('cat', [roProfile], { encoding: 'utf8' })).toBe(roContent);

      // Fresh shell sourcing read-only .profile finds imcodes ONLY (not opencode) until applying the printed export command
      const roFreshBefore = execFileSync(
        'bash',
        ['-c', `PATH="/usr/bin:/bin"; source "${roProfile}"; echo "IM=$(command -v imcodes 2>/dev/null || echo none) OC=$(command -v opencode 2>/dev/null || echo none)"`],
        { ...EXEC_OPTS, env: { HOME: roHome, PATH: '/usr/bin:/bin' } },
      ).trim();
      expect(roFreshBefore).toBe(`IM=${join(roBin, 'imcodes')} OC=none`);

      const exportMatch = roOut.match(/export PATH='([^']+)':"\$PATH"/);
      expect(exportMatch?.[1]).toBe(join(roHome, '.opencode', 'bin'));
      const roFreshAfter = execFileSync(
        'bash',
        ['-c', `PATH="/usr/bin:/bin"; source "${roProfile}"; ${exportMatch![0]}; echo "IM=$(command -v imcodes) OC=$(command -v opencode)"`],
        { ...EXEC_OPTS, env: { HOME: roHome, PATH: '/usr/bin:/bin' } },
      ).trim();
      expect(roFreshAfter).toBe(`IM=${join(roBin, 'imcodes')} OC=${join(roHome, '.opencode', 'bin', 'opencode')}`);

      // 3) Missing `opencode` invokes npm with mirror registry & handles spaces in HOME / npm_bin
      const okLog = join(ocRoot, 'ok-npm.log');
      const okBinDir = join(ocRoot, 'ok bin');
      mkdirSync(okBinDir, { recursive: true });
      const okNpm = join(okBinDir, 'npm');
      writeFileSync(
        okNpm,
        `#!/usr/bin/env bash
echo "$@" > "${okLog}"
printf '#!/usr/bin/env bash\necho "1.19.6"\n' > "${okBinDir}/opencode"
chmod +x "${okBinDir}/opencode"
`,
        { mode: 0o755 },
      );
      const installOut = sourced(
        `try_install_opencode_cli "${okNpm}" "https://mirrors.cloud.tencent.com/npm/"; echo "STATUS=$OPENCODE_STATUS"`,
        { HOME: skipHome, PATH: `${okBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(installOut).toContain('STATUS=installed');
      expect(installOut).toContain('opencode CLI installed (1.19.6)');
      expect(execFileSync('cat', [okLog], { encoding: 'utf8' }).trim()).toBe(
        'install -g opencode-ai --no-fund --no-audit --registry https://mirrors.cloud.tencent.com/npm/',
      );

      // 3b) npm installs opencode into custom `npm prefix -g` NOT yet on PATH -> resolves via prefix -g/bin & persists PATH_DIR
      const prefRoot = mkdtempSync(join(dir, 'oc-prefix-'));
      const prefGlobal = join(prefRoot, 'custom-global');
      const prefBinOnly = join(prefRoot, 'npm-only');
      mkdirSync(join(prefGlobal, 'bin'), { recursive: true });
      mkdirSync(prefBinOnly, { recursive: true });
      writeFileSync(
        join(prefBinOnly, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "prefix" ] && [ "\${2:-}" = "-g" ]; then echo "${prefGlobal}"; exit 0; fi
printf '#!/usr/bin/env bash\\necho "1.19.7"\\n' > "${prefGlobal}/bin/opencode"
chmod +x "${prefGlobal}/bin/opencode"
`,
        { mode: 0o755 },
      );
      const prefOut = sourced(
        `PATH_DIR=""; OPENCODE_PATH_DIR=""; try_install_opencode_cli "${join(prefBinOnly, 'npm')}" "https://registry.npmjs.org/"; echo "STATUS=$OPENCODE_STATUS RESOLVED=$(command -v opencode) OPENCODE_PATH_DIR=$OPENCODE_PATH_DIR"`,
        { HOME: skipHome, PATH: `${prefBinOnly}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(prefOut).toContain('STATUS=installed');
      expect(prefOut).toContain(`RESOLVED=${join(prefGlobal, 'bin', 'opencode')}`);
      expect(prefOut).toContain(`OPENCODE_PATH_DIR=${join(prefGlobal, 'bin')}`);

      // 3c) Counterexample: npm exits 0 WITHOUT creating an opencode binary on PATH or prefix/bin -> must NOT report ready!
      const fakeOkDir = join(ocRoot, 'fake-ok-bin');
      mkdirSync(fakeOkDir, { recursive: true });
      const fakeOkNpm = join(fakeOkDir, 'npm');
      writeFileSync(
        fakeOkNpm,
        `#!/usr/bin/env bash
if [ "\${1:-}" = "prefix" ] && [ "\${2:-}" = "-g" ]; then echo "${join(ocRoot, 'empty-prefix')}"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      const unverifiedOut = sourced(
        `try_install_opencode_cli "${fakeOkNpm}" "https://registry.npmjs.org/"; echo "STATUS=$OPENCODE_STATUS RESOLVED=$(command -v opencode 2>/dev/null || echo none)"`,
        { HOME: skipHome, PATH: `${fakeOkDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(unverifiedOut).toContain('STATUS=unverified');
      expect(unverifiedOut).toContain('RESOLVED=none');
      expect(unverifiedOut).toContain('was not found on PATH');

      // Also verify full E2E with fake-ok npm exiting 0 without binary does NOT print "OpenCode CLI: ready"
      const fakeE2eRoot = mkdtempSync(join(dir, 'fake-ok-e2e-'));
      const fakeE2eHome = join(fakeE2eRoot, 'home');
      const fakeE2ePrefix = join(fakeE2eRoot, 'prefix');
      const fakeE2eShim = join(fakeE2eRoot, 'shim');
      mkdirSync(fakeE2eHome, { recursive: true });
      mkdirSync(join(fakeE2ePrefix, 'lib', 'node_modules'), { recursive: true });
      mkdirSync(fakeE2eShim, { recursive: true });
      writeFileSync(join(fakeE2eHome, '.npmrc'), `prefix=${fakeE2ePrefix}\n`);
      writeFileSync(
        join(fakeE2eShim, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "root" ]; then echo "${fakeE2ePrefix}/lib/node_modules"; exit 0; fi
if [ "\${1:-}" = "prefix" ]; then echo "${fakeE2ePrefix}"; exit 0; fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
exit 0
`,
        { mode: 0o755 },
      );
      writeFileSync(join(fakeE2eShim, 'imcodes'), '#!/usr/bin/env bash\necho "2026.11.9999"\n', { mode: 0o755 });
      const fakeE2eOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', join(fakeE2eRoot, 'ir')],
        {
          ...EXEC_OPTS,
          env: {
            PATH: `${fakeE2eShim}:${cleanPath}`,
            HOME: fakeE2eHome,
            TMPDIR: fakeE2eRoot,
            IMCODES_USE_R2: 'false',
          },
        },
      );
      expect(fakeE2eOut).toContain('imcodes installed  2026.11.9999');
      expect(fakeE2eOut).not.toContain('OpenCode CLI: ready');
      expect(fakeE2eOut).toContain("was not found on PATH");

      // 4) Non-blocking under `set -euo pipefail` when npm install fails
      const failBinDir = join(ocRoot, 'fail-bin');
      mkdirSync(failBinDir, { recursive: true });
      const failNpm = join(failBinDir, 'npm');
      writeFileSync(failNpm, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
      const failHome = join(ocRoot, 'fail-home');
      mkdirSync(failHome, { recursive: true });
      const failOut = sourced(
        `set -euo pipefail; try_install_opencode_cli "${failNpm}" "https://registry.npmjs.org/"; echo "AFTER=$? STATUS=$OPENCODE_STATUS"`,
        { HOME: failHome, PATH: `${failBinDir}:${cleanPath}`, IMCODES_SKIP_OPENCODE: '' },
      );
      expect(failOut).toContain('WARNING: OpenCode CLI install failed (non-blocking)');
      expect(failOut).toContain('AFTER=0 STATUS=failed');

      // 5) Full script failure non-blocking test (E2E R2 succeeds, opencode npm fails -> install.sh exits 0!)
      const e2eFailRoot = mkdtempSync(join(dir, 'e2e-oc-fail-'));
      const e2eFailHome = join(e2eFailRoot, 'home with space');
      const e2eFailPrefix = join(e2eFailRoot, 'prefix');
      const e2eFailInstallRoot = join(e2eFailRoot, 'install-root');
      const e2eFailShim = join(e2eFailRoot, 'shim');
      mkdirSync(e2eFailHome, { recursive: true });
      mkdirSync(join(e2eFailPrefix, 'lib', 'node_modules'), { recursive: true });
      mkdirSync(join(e2eFailPrefix, 'bin'), { recursive: true });
      mkdirSync(e2eFailInstallRoot, { recursive: true });
      mkdirSync(e2eFailShim, { recursive: true });
      const e2eNpmRc = join(e2eFailHome, '.npmrc');
      writeFileSync(e2eNpmRc, `prefix=${e2eFailPrefix}\n`);
      writeFileSync(
        join(e2eFailShim, 'npm'),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "root" ]; then echo "${e2eFailPrefix}/lib/node_modules"; exit 0; fi
if [ "\${1:-}" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi
if [[ "$*" == *"opencode-ai"* ]]; then exit 1; fi
echo "installed-fake-imcodes"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(e2eFailShim, 'imcodes'),
        '#!/usr/bin/env bash\necho "2026.11.9999"\n',
        { mode: 0o755 },
      );
      const e2eFailOut = execFileSync(
        'bash',
        [SCRIPT, '--channel', 'latest', '--source', 'direct', '--install-root', e2eFailInstallRoot],
        {
          ...EXEC_OPTS,
          env: {
            PATH: `${e2eFailShim}:${cleanPath}`,
            HOME: e2eFailHome,
            TMPDIR: e2eFailRoot,
            IMCODES_USE_R2: 'false',
          },
        },
      );
      expect(e2eFailOut).toContain('imcodes installed  2026.11.9999');
      expect(e2eFailOut).toContain('WARNING: OpenCode CLI install failed (non-blocking)');
      expect(e2eFailOut).toContain('OpenCode CLI: not installed');
    });

    it('passes bash syntax check on install.sh and init.sh, and locks install.ps1 OpenCode parity contracts', () => {
      const initScript = join(HERE, '..', '..', 'landing', 'init.sh');
      const ps1Script = join(HERE, '..', '..', 'landing', 'install.ps1');
      execFileSync('bash', ['-n', SCRIPT, initScript], { encoding: 'utf8' });
      const initSrc = execFileSync('cat', [initScript], { encoding: 'utf8' });
      expect(initSrc).toContain('try_install_from_r2');
      expect(initSrc).toContain('parse_daemon_r2_manifest');
      expect(initSrc).toContain('npm install -g --no-fund --no-audit --registry "$NPM_REGISTRY" "imcodes@$CHANNEL"');

      // Static contract checks matching install-smoke.yml / PS 5.1+ parity
      const ps1 = execFileSync('cat', [ps1Script], { encoding: 'utf8' });
      expect(ps1).toContain('[switch]$SkipOpenCode');
      expect(ps1).toContain('IMCODES_SKIP_OPENCODE');
      expect(ps1).toContain("'.opencode\\bin'");
      expect(ps1).toContain("'opencode.exe'");
      expect(ps1).toContain('Add-UserPathEntry');
      expect(ps1).toContain('& $npmExe install -g opencode-ai --no-fund --no-audit --registry $npmRegistry');
      expect(ps1).toContain('$npmExe prefix -g');
      expect(ps1).toContain("was not found on PATH");
      expect(ps1).toContain('WARNING: OpenCode CLI install');
      expect(ps1).toContain('OpenCode CLI: ready');
      // Guard against PS runtime & 5.1 hazards: `return try { ... }` (runtime failure!) and PS 7-only operators
      expect(ps1).not.toMatch(/\breturn\s+try\b/i);
      expect(ps1).not.toMatch(/\s\?\?\s|\s&&\s|\s\|\|\s/);
    });
  });

  const pwshPath = (() => {
    try {
      return execFileSync('bash', ['-c', 'command -v pwsh || true'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

  describe.skipIf(!pwshPath)('landing/install.ps1 runtime OpenCode tests (pwsh)', () => {
    it('parses install.ps1 cleanly and handles existing binaries, broken --version, PATH additions, fake-ok, and npm failure without aborting', () => {
      const ps1Script = join(HERE, '..', '..', 'landing', 'install.ps1');
      const ps1Src = execFileSync('cat', [ps1Script], { encoding: 'utf8' });
      const addPathMatch = ps1Src.match(/function Add-UserPathEntry[\s\S]*?\n\}/);
      const ocBlockMatch = ps1Src.match(/# ── OpenCode CLI[\s\S]*?# ── Done[\s\S]*?Write-Host "  Next steps:"/);
      expect(addPathMatch?.[0]).toBeTruthy();
      expect(ocBlockMatch?.[0]).toBeTruthy();

      const psRoot = mkdtempSync(join(dir, 'pwsh-oc-'));
      const harness = join(psRoot, 'harness.ps1');
      // Full-file AST parse check + runtime scenarios exercising the exact extracted Add-UserPathEntry & OpenCode/Done blocks
      writeFileSync(
        harness,
        `
$ErrorActionPreference = 'Stop'
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('${ps1Script}', [ref]$null, [ref]$errors) | Out-Null
if ($errors -and $errors.Count -gt 0) { throw "Parse errors: $($errors[0].Message)" }

function Write-Step($m) { Write-Host "==> $m" }
function Write-Ok($m)   { Write-Host "    $m" }
function Write-Note($m) { Write-Host "    $m" }
${addPathMatch![0]}

function Run-OcScenario([string]$CaseDir, [string]$Mode) {
  $origPath = $env:Path
  $origProfile = $env:USERPROFILE
  $origSkip = $env:IMCODES_SKIP_OPENCODE
  try {
    $env:USERPROFILE = Join-Path $CaseDir 'home'
    $env:IMCODES_SKIP_OPENCODE = ''
    $binDir = Join-Path $CaseDir 'bin'
    $null = New-Item -ItemType Directory -Force -Path $env:USERPROFILE, $binDir
    $npmLog = Join-Path $CaseDir 'npm.log'
    $script:LastPrefix = ''
    $npmExe = Join-Path $CaseDir 'fake-npm.ps1'
    if ($Mode -eq 'fail-npm') {
      Set-Content $npmExe 'param([Parameter(ValueFromRemainingArguments=$true)]$a) "npm $($a -join \" \")" | Add-Content "' + $npmLog + '"; $global:LASTEXITCODE = 2'
    } elseif ($Mode -eq 'fake-ok') {
      Set-Content $npmExe 'param([Parameter(ValueFromRemainingArguments=$true)]$a) if ($a[0] -eq "prefix") { Write-Output "' + (Join-Path $CaseDir 'empty-pref') + '" }; $global:LASTEXITCODE = 0'
    } else {
      Set-Content $npmExe 'param([Parameter(ValueFromRemainingArguments=$true)]$a) "npm $($a -join \" \")" | Add-Content "' + $npmLog + '"; $global:LASTEXITCODE = 0'
    }
    if ($Mode -eq 'path-bad-ver') {
      $ocName = if ($IsWindows -or -not $PSVersionTable.Platform -or $PSVersionTable.Platform -eq 'Win32NT') { 'opencode.cmd' } else { 'opencode' }
      $oc = Join-Path $binDir $ocName
      if ($ocName -eq 'opencode.cmd') {
        Set-Content $oc "@echo off\`r\`nexit /b 1"
      } else {
        Set-Content $oc "#!/usr/bin/env bash\`nexit 1"
        chmod +x $oc
      }
    }
    $sep = [System.IO.Path]::PathSeparator
    $env:Path = @($binDir, '/usr/bin', '/bin') -join $sep
    $npmRegistry = 'https://registry.npmjs.org/'
    $skipOpenCodeEffective = $false
    ${ocBlockMatch![0]}
    Write-Output "MODE=$Mode STATUS=$openCodeStatus RESOLVED=$($(Get-Command opencode -ErrorAction SilentlyContinue | ForEach-Object Source) -join '')"
  } finally {
    $env:Path = $origPath
    $env:USERPROFILE = $origProfile
    $env:IMCODES_SKIP_OPENCODE = $origSkip
  }
}

Write-Output (Run-OcScenario (Join-Path '${psRoot}' 'c1') 'path-bad-ver')
Write-Output (Run-OcScenario (Join-Path '${psRoot}' 'c2') 'fail-npm')
Write-Output (Run-OcScenario (Join-Path '${psRoot}' 'c3') 'fake-ok')
`,
      );
      const out = execFileSync(pwshPath, ['-NoProfile', '-NonInteractive', '-File', harness], {
        ...EXEC_OPTS,
      });
      expect(out).toContain('MODE=path-bad-ver STATUS=existing');
      expect(out).toContain('MODE=fail-npm STATUS=failed');
      expect(out).toContain('MODE=fake-ok STATUS=unverified');
    });
  });
});
