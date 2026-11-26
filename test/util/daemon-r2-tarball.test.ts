import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DAEMON_R2_BASE_URL,
  daemonR2ManifestUrl,
  daemonR2TarballUrl,
  parseDaemonR2Manifest,
  resolveDaemonR2BaseUrl,
  resolveDaemonR2Channel,
} from '../../shared/daemon-r2-package.js';
import {
  isLocalTarballPkgSpec,
  resolveAndDownloadDaemonR2Tarball,
  resolveDaemonR2LatestVersion,
} from '../../src/util/daemon-r2-tarball.js';
import { buildPosixUpgradeScript } from '../../src/util/posix-upgrade-script.js';
import { buildWindowsUpgradeRunnerVbs } from '../../src/util/windows-upgrade-script.js';
import { runDetachedPosixUpgrade } from '../../src/cli/upgrade-detached.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'imcodes-r2-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('shared/daemon-r2-package', () => {
  it('routes dev and master channels accurately across target, channel, and current versions', () => {
    expect(resolveDaemonR2Channel({ targetVersion: '2026.11.7090-dev.1' })).toBe('dev');
    expect(resolveDaemonR2Channel({ targetVersion: '2026.11.7090' })).toBe('master');
    expect(resolveDaemonR2Channel({ channel: 'dev', targetVersion: 'latest' })).toBe('dev');
    expect(resolveDaemonR2Channel({ channel: 'master', targetVersion: 'latest' })).toBe('master');
    expect(resolveDaemonR2Channel({ targetVersion: 'latest', currentVersion: '2026.11.7090-dev.2' })).toBe('dev');
    expect(resolveDaemonR2Channel({ targetVersion: 'latest', currentVersion: '2026.11.7090' })).toBe('master');
  });

  it('resolves base URL with opt-out flags, HTTPS enforcement, and URL builder', () => {
    expect(resolveDaemonR2BaseUrl({})).toBe(DEFAULT_DAEMON_R2_BASE_URL);
    expect(resolveDaemonR2BaseUrl({ USE_R2_ARTIFACT: 'false' })).toBeNull();
    expect(resolveDaemonR2BaseUrl({ IMCODES_USE_R2: 'FALSE' })).toBeNull();
    expect(resolveDaemonR2BaseUrl({ CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.example.com/r2/' }))
      .toBe('https://cdn.example.com/r2');
    expect(resolveDaemonR2BaseUrl({ CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'http://cdn.example.com' })).toBeNull();
    expect(resolveDaemonR2BaseUrl({ CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://user:pass@cdn.example.com' })).toBeNull();
    expect(resolveDaemonR2BaseUrl({ CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.example.com?q=1' })).toBeNull();

    expect(daemonR2ManifestUrl('https://dl.im.codes/', 'master', '/team-a/')).toBe('https://dl.im.codes/team-a/master/npm/latest.json');
    expect(daemonR2TarballUrl('https://dl.im.codes', 'dev', 'bad/../prefix')).toBeNull();
  });

  it('validates manifest schema strictly', () => {
    const sha = 'a'.repeat(64);
    expect(parseDaemonR2Manifest({
      version: '2026.11.7090',
      channel: 'master',
      filename: 'imcodes-latest.tgz',
      sha256: sha,
      sizeBytes: 1234,
      unpackedSizeBytes: 5678,
    })).toEqual({
      version: '2026.11.7090',
      channel: 'master',
      filename: 'imcodes-latest.tgz',
      sha256: sha,
      sizeBytes: 1234,
      unpackedSizeBytes: 5678,
    });
    expect(parseDaemonR2Manifest({ version: '1.0.0', channel: 'master', filename: 'other.tgz', sha256: sha, sizeBytes: 10 })).toBeNull();
    expect(parseDaemonR2Manifest({ version: '1.0.0', channel: 'master', filename: 'imcodes-latest.tgz', sha256: 'xyz', sizeBytes: 10 })).toBeNull();
    expect(parseDaemonR2Manifest({ version: '1.0.0', channel: 'master', filename: 'imcodes-latest.tgz', sha256: sha, sizeBytes: 0 })).toBeNull();
  });
});

describe('src/util/daemon-r2-tarball', () => {
  it('recognizes local tarball specs cleanly', () => {
    expect(isLocalTarballPkgSpec('/tmp/imcodes-r2.tgz')).toBe(true);
    expect(isLocalTarballPkgSpec('/tmp/imcodes-r2.tar.gz')).toBe(true);
    expect(isLocalTarballPkgSpec('imcodes@latest')).toBe(false);
    expect(isLocalTarballPkgSpec('imcodes@2026.11.7090')).toBe(false);
  });

  it('resolves pinned version from R2 when matching and rejects mismatch to allow npm fallback', async () => {
    const sha = 'b'.repeat(64);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      version: '2026.11.7090',
      channel: 'master',
      filename: 'imcodes-latest.tgz',
      sha256: sha,
      sizeBytes: 42,
    }), { status: 200 }));

    const match = await resolveDaemonR2LatestVersion({
      targetVersion: '2026.11.7090',
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: {},
    });
    expect(match).toMatchObject({ ok: true, channel: 'master', version: '2026.11.7090' });

    const mismatch = await resolveDaemonR2LatestVersion({
      targetVersion: '2026.10.100',
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: {},
    });
    expect(mismatch).toEqual({ ok: false, reason: 'version_mismatch' });
  });

  it('downloads and verifies SHA-256 + sizeBytes across HTTPS redirects', async () => {
    const payload = Buffer.from('verified-tarball-bytes');
    const sha = createHash('sha256').update(payload).digest('hex');
    const destDir = makeTempDir();
    const seenUrls: string[] = [];

    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url);
      seenUrls.push(target);
      if (target.endsWith('/dev/npm/latest.json')) {
        return new Response(JSON.stringify({
          version: '2026.11.7090-dev.1',
          channel: 'dev',
          filename: 'imcodes-latest.tgz',
          sha256: sha,
          sizeBytes: payload.length,
          unpackedSizeBytes: payload.length * 4,
        }), { status: 200 });
      }
      if (target === 'https://dl.im.codes/dev/npm/imcodes-latest.tgz') {
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { location: 'https://r2-edge.example.com/blob.tgz' } });
      }
      if (target === 'https://r2-edge.example.com/blob.tgz') {
        expect(init?.headers).toBeUndefined();
        return new Response(payload, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const res = await resolveAndDownloadDaemonR2Tarball({
      targetVersion: 'dev',
      destDir,
      fetchImpl,
      env: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.version).toBe('2026.11.7090-dev.1');
      expect(res.expectedBytes).toBe(payload.length * 4);
      expect(readFileSync(res.tarballPath)).toEqual(payload);
    }
    expect(seenUrls).toEqual([
      'https://dl.im.codes/dev/npm/latest.json',
      'https://dl.im.codes/dev/npm/imcodes-latest.tgz',
      'https://r2-edge.example.com/blob.tgz',
    ]);
  });

  it('rejects tampered SHA-256, size mismatches, and HTTP redirect downgrades without writing tarball', async () => {
    const payload = Buffer.from('good-tarball');
    const sha = createHash('sha256').update(payload).digest('hex');
    const destDir = makeTempDir();

    const tamperedFetch: typeof fetch = async (url) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '2026.11.7090',
          channel: 'master',
          filename: 'imcodes-latest.tgz',
          sha256: sha,
          sizeBytes: payload.length,
        }), { status: 200 });
      }
      return new Response(Buffer.from('bad!-tarball'), { status: 200 });
    };
    const badSha = await resolveAndDownloadDaemonR2Tarball({ targetVersion: 'latest', destDir, fetchImpl: tamperedFetch, env: {} });
    expect(badSha).toEqual({ ok: false, reason: 'tarball_sha256_mismatch' });
    expect(existsSync(join(destDir, 'imcodes-r2.tgz'))).toBe(false);

    const downgradeFetch: typeof fetch = async (url) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '2026.11.7090',
          channel: 'master',
          filename: 'imcodes-latest.tgz',
          sha256: sha,
          sizeBytes: payload.length,
        }), { status: 200 });
      }
      return new Response(null, { status: 302, headers: { location: 'http://insecure.example.com/file.tgz' } });
    };
    const downgrade = await resolveAndDownloadDaemonR2Tarball({ targetVersion: 'latest', destDir, fetchImpl: downgradeFetch, env: {} });
    expect(downgrade.ok).toBe(false);
    if (!downgrade.ok) expect(downgrade.reason).toContain('refused non-HTTPS');
    expect(existsSync(join(destDir, 'imcodes-r2.tgz'))).toBe(false);
  });
});

describe('local tarball upgrade runners (no npm view + fallbackPkgSpec)', () => {
  it('staged-package-install.mjs skips npm view for local .tgz specs', () => {
    const dir = makeTempDir();
    const binDir = join(dir, 'bin');
    const globalRoot = join(dir, 'prefix', 'lib', 'node_modules');
    const stagePrefix = join(dir, 'stage-prefix');
    const npmArgsLog = join(dir, 'npm-calls.log');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(globalRoot, 'imcodes'), { recursive: true });
    writeFileSync(join(globalRoot, 'imcodes', 'package.json'), JSON.stringify({ name: 'imcodes', version: '1.0.0' }));
    const tgzPath = join(dir, 'imcodes-r2.tgz');
    writeFileSync(tgzPath, 'fake-tgz');

    const fakeNpm = join(binDir, 'npm');
    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${npmArgsLog}"
if [ "\${1:-}" = "view" ]; then
  echo "npm view must not be called for local tgz" >&2
  exit 99
fi
if [ "\${1:-}" = "install" ]; then
  stage_prefix=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--prefix" ]; then stage_prefix="$arg"; break; fi
    prev="$arg"
  done
  mkdir -p "$stage_prefix/lib/node_modules/imcodes" "$stage_prefix/bin"
  echo '{"name":"imcodes","version":"2.0.0"}' > "$stage_prefix/lib/node_modules/imcodes/package.json"
  exit 0
fi
exit 0
`,
    );
    chmodSync(fakeNpm, 0o755);

    const installer = join(process.cwd(), 'src', 'util', 'staged-package-install.mjs');
    const out = execFileSync(
      process.execPath,
      [installer, 'stage', '--global-root', globalRoot, '--stage-prefix', stagePrefix, '--pkg', tgzPath, '--expected-bytes', '4096'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` } },
    );
    expect(out).toContain('staged install complete');
    expect(existsSync(join(stagePrefix, 'lib', 'node_modules', 'imcodes', 'package.json'))).toBe(true);
    const logged = readFileSync(npmArgsLog, 'utf8');
    expect(logged).toContain(`install -g --ignore-scripts --prefer-online --prefix ${stagePrefix} ${tgzPath}`);
    expect(logged).not.toContain('view ');
  });

  it('buildPosixUpgradeScript guards npm view with is_local_tarball and wires FALLBACK_PKG_SPEC', () => {
    const script = buildPosixUpgradeScript({
      logFile: '/tmp/u.log',
      scriptDir: '/tmp/u',
      statusFile: '/tmp/u.json',
      registryArg: '',
      pkgSpec: '/tmp/u/imcodes-r2.tgz',
      fallbackPkgSpec: 'imcodes@2.0.0',
      expectedBytes: 4096,
      targetVer: '2.0.0',
      currentVer: '1.0.0',
      oldDaemonPid: null,
      nodeBin: '/usr/local/bin/node',
      nodeDir: '/usr/local/bin',
      stateDir: '/tmp/state',
      restartCmd: 'true',
      cleanupAfterSec: 300,
      atomicInstallerPath: '/tmp/staged-package-install.mjs',
    });
    expect(script).toContain('is_local_tarball()');
    expect(script).toContain("FALLBACK_PKG_SPEC='imcodes@2.0.0'");
    expect(script).toContain('if is_local_tarball; then');
    expect(script).toContain('local tarball install failed (exit $INSTALL_RC) — falling back to npm package $FALLBACK_PKG_SPEC');
  });

  it('runDetachedPosixUpgrade downloads R2 tarball via seam and passes fallbackPkgSpec + expectedBytes to launch', async () => {
    const dir = makeTempDir();
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const fakeTarball = join(dir, 'imcodes-r2.tgz');
    writeFileSync(fakeTarball, 'tgz');

    const captured: Array<Record<string, unknown>> = [];
    const code = await runDetachedPosixUpgrade(
      {
        pkgSpec: 'imcodes@2.0.0',
        targetVer: '2.0.0',
        registry: null,
        currentVer: '1.0.0',
        platform: 'linux',
        stateDir,
        home: dir,
      },
      {
        resolveR2: async () => ({
          ok: true,
          tarballPath: fakeTarball,
          channel: 'master',
          version: '2.0.0',
          expectedBytes: 8192,
          manifest: {
            version: '2.0.0',
            channel: 'master',
            filename: 'imcodes-latest.tgz',
            sha256: 'c'.repeat(64),
            sizeBytes: 3,
            unpackedSizeBytes: 8192,
          },
        }),
        launch: (params) => {
          captured.push(params as unknown as Record<string, unknown>);
          const logFile = join(dir, 'upgrade.log');
          const resultFile = join(dir, 'upgrade-result');
          writeFileSync(logFile, 'Upgrade complete\n');
          writeFileSync(resultFile, 'ok');
          return {
            scriptDir: dir,
            logFile,
            statusFile: join(dir, 'status.json'),
            resultFile,
            scriptPath: join(dir, 'upgrade.sh'),
            child: { unref: () => {}, on: () => {} } as never,
          };
        },
        write: () => {},
        pollMs: 10,
      },
    );

    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      pkgSpec: fakeTarball,
      fallbackPkgSpec: 'imcodes@2.0.0',
      expectedBytes: 8192,
      targetVer: '2.0.0',
    });
  });

  it('windows-upgrade-runner.mjs and buildWindowsUpgradeRunnerVbs preserve argv[10..11] and local tarball fallback', () => {
    const vbs = buildWindowsUpgradeRunnerVbs({
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      runnerPath: 'C:\\Temp\\upgrade.mjs',
      args: ['C:\\Temp\\u.log', 'npm.cmd', 'C:\\Temp\\imcodes-r2.tgz', '2.0.0', 'C:\\Temp', '-', '1.0.0', 'C:\\npm', 'imcodes@2.0.0', '4096'],
    });
    expect(vbs).toContain('""C:\\Temp\\imcodes-r2.tgz""');
    expect(vbs).toContain('""imcodes@2.0.0""');
    expect(vbs).toContain('""4096""');

    const runnerSrc = readFileSync(join(process.cwd(), 'src', 'util', 'windows-upgrade-runner.mjs'), 'utf8');
    expect(runnerSrc).toContain('FALLBACK_PKG_SPEC = process.argv[10]');
    expect(runnerSrc).toContain('EXPECTED_BYTES_ARG = process.argv[11]');
    expect(runnerSrc).toContain('const isLocalTarball = (spec) =>');
    expect(runnerSrc).toContain('falling back to npm');
  });

  it('landing/install.ps1 includes R2 primary manifest + SHA-256 verification and npm fallback', () => {
    const ps1 = readFileSync(join(process.cwd(), 'landing', 'install.ps1'), 'utf8');
    expect(ps1).toContain("$r2Channel = switch ($Channel) { 'dev' { 'dev' } 'latest' { 'master' } default { '' } }");
    expect(ps1).toContain('imcodes-latest.tgz');
    expect(ps1).toContain('Get-FileHash -LiteralPath $r2Tgz -Algorithm SHA256');
    expect(ps1).toContain('Remove-Item -LiteralPath $r2Tmp -Recurse -Force -ErrorAction SilentlyContinue');
    expect(ps1).toContain('& $npmExe install -g "imcodes@$Channel" --no-fund --no-audit --registry $npmRegistry');
  });

  it('ci.yml Sync npm tarball to R2 (optional) continues to npm publish when aws s3 sync fails, sets no-cache, and isolates npm/* from controlled-node sync', () => {
    const ciYml = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const syncStepMatch = ciYml.match(
      /- name: Sync npm tarball to R2 \(optional\)[\s\S]*?run: \|\n([\s\S]*?)\n\s*- name: Publish \(skip if version already on npm\)/,
    );
    expect(syncStepMatch).toBeTruthy();
    const runBlock = syncStepMatch![1]
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n');

    expect(runBlock).toContain('AWS_REQUEST_CHECKSUM_CALCULATION="when_required"');
    expect(runBlock).toContain('AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"');
    expect(runBlock).toContain('aws configure set default.s3.multipart_threshold 100MB');
    expect(runBlock).toContain('aws configure set default.s3.multipart_chunksize 64MB');
    expect(runBlock).toContain('aws configure set default.s3.max_concurrent_requests 4');
    expect(runBlock).toContain('--cache-control "no-cache, max-age=0, must-revalidate"');
    expect(runBlock).toContain('for attempt in 1 2 3');
    expect(runBlock).toContain('::warning::R2 npm sync failed; continuing with npm publish');
    expect(ciYml).toContain('node scripts/publish-controlled-node-r2.mjs');
    const publishScript = readFileSync(join(process.cwd(), 'scripts', 'publish-controlled-node-r2.mjs'), 'utf8');
    expect(publishScript).toContain("'--delimiter'");
    expect(publishScript).toContain("rel.includes('/')");

    const workDir = makeTempDir('imcodes-ci-r2-');
    const runnerTemp = join(workDir, 'runner-temp');
    const binDir = join(workDir, 'bin');
    const awsLog = join(workDir, 'aws-calls.log');
    const stateFile = join(workDir, 'aws-attempts');
    mkdirSync(runnerTemp, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(runnerTemp, 'imcodes-2026.11.7090.tgz'), 'fake-ci-tgz');

    const fakeAws = join(binDir, 'aws');
    writeFileSync(
      fakeAws,
      `#!/usr/bin/env bash
echo "$*" >> "${awsLog}"
if [ "$1" = "configure" ]; then
  exit 0
fi
if [ -n "\${FAIL_UNTIL_ATTEMPT:-}" ]; then
  count=0
  if [ -f "${stateFile}" ]; then
    count=$(cat "${stateFile}")
  fi
  count=$((count + 1))
  printf '%s' "$count" > "${stateFile}"
  if [ "$count" -le "$FAIL_UNTIL_ATTEMPT" ]; then
    echo "An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation" >&2
    exit 255
  fi
  exit 0
fi
exit 255
`,
      { mode: 0o755 },
    );

    const out = execFileSync('bash', ['-c', runBlock], {
      cwd: workDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        R2_ACCOUNT_ID: 'acct123',
        R2_BUCKET: 'bucket123',
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret123',
        R2_PREFIX: '',
        NPM_VERSION: '2026.11.7090',
        GITHUB_REF: 'refs/heads/master',
        R2_SYNC_RETRY_DELAY_SECONDS: '0',
      },
    });

    expect(out).toContain('::warning::R2 npm sync failed; continuing with npm publish');
    const failLogLines = readFileSync(awsLog, 'utf8').trim().split('\n');
    expect(failLogLines).toContain('configure set default.s3.multipart_threshold 100MB');
    expect(failLogLines).toContain('configure set default.s3.multipart_chunksize 64MB');
    expect(failLogLines).toContain('configure set default.s3.max_concurrent_requests 4');
    expect(failLogLines.filter((line) => line.includes('s3 sync dist-npm-r2 s3://bucket123/master/npm --delete'))).toHaveLength(3);
    const generatedManifest = JSON.parse(readFileSync(join(workDir, 'dist-npm-r2', 'latest.json'), 'utf8'));
    expect(generatedManifest).toMatchObject({
      version: '2026.11.7090',
      channel: 'master',
      filename: 'imcodes-latest.tgz',
      sizeBytes: 'fake-ci-tgz'.length,
    });

    writeFileSync(awsLog, '');
    const retryOut = execFileSync('bash', ['-c', runBlock], {
      cwd: workDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        R2_ACCOUNT_ID: 'acct123',
        R2_BUCKET: 'bucket123',
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret123',
        R2_PREFIX: '',
        NPM_VERSION: '2026.11.7090',
        GITHUB_REF: 'refs/heads/master',
        R2_SYNC_RETRY_DELAY_SECONDS: '0',
        FAIL_UNTIL_ATTEMPT: '1',
      },
    });

    expect(retryOut).not.toContain('::warning::R2 npm sync failed');
    const retrySyncLines = readFileSync(awsLog, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('s3 sync dist-npm-r2 s3://bucket123/master/npm --delete'));
    expect(retrySyncLines).toHaveLength(2);
  });
});
