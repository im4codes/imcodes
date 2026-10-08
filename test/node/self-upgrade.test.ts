import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROLLED_NODE_UPGRADE_HEALTH } from '../../shared/controlled-node-service.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeComputerUseHelperFilename,
  isControlledNodeArtifactCompatibleWithRuntime,
  normalizeControlledNodeArtifactPair,
} from '../../shared/controlled-node-artifacts.js';
import {
  buildPosixControlledNodeUpgradeScript,
  buildWindowsControlledNodeUpgradeScript,
  CONTROLLED_NODE_UPGRADE_ABSOLUTE_TTL_MS,
  CONTROLLED_NODE_UPGRADE_DIR_PREFIX,
  CONTROLLED_NODE_UPGRADE_MIN_FREE_BYTES,
  CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER,
  CONTROLLED_NODE_UPGRADE_PROGRESS_FILE,
  CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS,
  controlledNodeArtifactTarget,
  controlledNodeArtifactUpgradeUrl,
  downloadControlledNodeExecutable,
  downloadControlledNodeLinuxRemoteDesktopWorker,
  downloadControlledNodeRemoteDesktopWorker,
  refreshControlledNodeRemoteDesktopWorker,
  scheduleLinuxControlledNodeUpgrade,
  scheduleWindowsControlledNodeUpgrade,
  scavengeStaleControlledNodeUpgradeDirs,
  scavengeStaleControlledNodeUpgradePass,
  startControlledNodeUpgradeScavenger,
  activeControlledNodeUpgradeDirsForTests,
  CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS,
  startControlledNodeSelfUpgrade,
  windowsControlledNodeUpgradeTaskXml,
  withArtifactDownloadRetries,
} from '../../src/node/self-upgrade.js';
import {
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR,
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
} from '../../shared/remote-desktop-worker.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';

const dirs: string[] = [];
const WINDOWS_SIGNER_SHA256 = 'c'.repeat(64);
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const credential = {
  serverUrl: 'https://im.example',
  serverId: 'srv-1',
  token: 'secret-token',
  nodeRole: NODE_ROLE.CONTROLLED,
} as const;

async function holdWindowsFileLock(
  filePath: string,
  directory: string,
  durationMs: number,
): Promise<ReturnType<typeof spawn>> {
  const scriptPath = join(directory, `hold-lock-${durationMs}.ps1`);
  const readyPath = join(directory, `lock-ready-${durationMs}`);
  const quotedFile = filePath.replaceAll("'", "''");
  const quotedReady = readyPath.replaceAll("'", "''");
  await writeFile(scriptPath, [
    "$ErrorActionPreference = 'Stop'",
    `$handle = [IO.File]::Open('${quotedFile}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`,
    'try {',
    `  Set-Content -LiteralPath '${quotedReady}' -Value 'ready' -Encoding ascii`,
    `  [Threading.Thread]::Sleep(${durationMs})`,
    '} finally {',
    '  $handle.Dispose()',
    '}',
  ].join('\r\n'));
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
  ], { stdio: 'ignore', windowsHide: true });
  const readyDeadline = Date.now() + 5_000;
  while (!(await readFile(readyPath).then(() => true, () => false))) {
    if (Date.now() >= readyDeadline) {
      if (child.exitCode === null) child.kill();
      throw new Error('Windows replacement lock holder did not become ready');
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 25));
  }
  return child;
}

function createWindowsUpgradeFetch(version = '2026.7.1'): typeof fetch {
  const main = Buffer.from('signed controlled node');
  const worker = Buffer.from('signed remote desktop worker');
  const virtualDisplay = Buffer.from('signed virtual display');
  const workerManifest = Buffer.from(JSON.stringify({
    manifestVersion: 2,
    workerVersion: version,
    protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
    ipcVersion: 1,
    os: 'win32',
    arch: 'x64',
    fileName: REMOTE_DESKTOP_WORKER_FILENAME,
    size: worker.length,
    sha256: createHash('sha256').update(worker).digest('hex'),
    authenticodeSignerSha256: WINDOWS_SIGNER_SHA256,
    libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
    virtualDisplay: {
      archiveFileName: 'imcodes-virtual-display.zip',
      packageManifestFileName: 'imcodes-virtual-display.manifest.json',
      size: virtualDisplay.length,
      sha256: createHash('sha256').update(virtualDisplay).digest('hex'),
    },
    toolchain: {
      msvc: '14.44',
      windowsSdk: '10.0.26100.0',
      cmake: 'not-used-gn',
      ninja: '1.13.1',
      depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
    },
  }));
  return (async (url: string) => {
    if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
    const isManifest = url.includes('asset=remote-desktop-worker-manifest');
    const isVirtualDisplay = url.includes('asset=remote-desktop-virtual-display');
    const isWorker = url.includes('asset=remote-desktop-worker');
    const body = isManifest ? workerManifest : isVirtualDisplay ? virtualDisplay : isWorker ? worker : main;
    return new Response(body, {
      status: 200,
      headers: {
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
        [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isManifest
          ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
          : isVirtualDisplay ? 'imcodes-virtual-display.zip' : isWorker ? REMOTE_DESKTOP_WORKER_FILENAME : 'imcodes-node.exe',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
        ...(!isManifest && !isVirtualDisplay && !isWorker
          ? { [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256 }
          : {}),
      },
    });
  }) as unknown as typeof fetch;
}

async function createOwnedUpgradeDir(input: {
  root: string;
  suffix: string;
  createdAt: number;
  pid?: number;
  marker?: boolean;
  bom?: boolean;
}): Promise<string> {
  const path = join(input.root, `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}${input.suffix}`);
  await mkdir(path);
  if (input.marker !== false) {
    await writeFile(join(path, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), `${input.bom ? '\ufeff' : ''}${JSON.stringify({
      schemaVersion: 1,
      product: 'imcodes-controlled-node-upgrade',
      directoryName: `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}${input.suffix}`,
      ownerToken: '12345678-1234-4123-8123-123456789abc',
      createdAt: input.createdAt,
      pid: input.pid ?? 999_999,
    })}\n`);
  }
  const timestamp = new Date(input.createdAt);
  if (input.marker !== false) await utimes(join(path, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), timestamp, timestamp);
  await utimes(path, timestamp, timestamp);
  return path;
}

/**
 * Service-manager and sleep stubs for tests that execute the generated POSIX upgrade
 * script: the "new node" is the running test process, and it publishes its lease the
 * moment the script asks the service manager about it, so the health wait ends at once.
 */
async function installHealthyServiceStubs(binDir: string, leasePath: string): Promise<void> {
  const lease = `printf '{"version":1,"pid":${process.pid},"updatedAt":%s}\\n' "$(( ($(date +%s) + 1) * 1000 ))" > '${leasePath}'`;
  const log = 'printf "%s\\n" "$*" >> "${IMCODES_UPGRADE_TEST_LOG:-/dev/null}"';
  await writeFile(join(binDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(binDir, 'systemctl'), [
    '#!/bin/sh', log,
    `if [ "$1" = show ]; then ${lease}; case "$3" in MainPID) echo MainPID=${process.pid};; NRestarts) echo NRestarts=0;; esac; fi`,
    'exit 0', '',
  ].join('\n'), { mode: 0o755 });
  await writeFile(join(binDir, 'launchctl'), [
    '#!/bin/sh', log,
    `if [ "$1" = print ]; then ${lease}; printf '\\tpid = ${process.pid}\\n'; fi`,
    'exit 0', '',
  ].join('\n'), { mode: 0o755 });
}

describe('controlled-node self-upgrade', () => {
  it('refreshes an independently published Linux worker and rejects same, older, and unknown targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-worker-refresh-test-'));
    dirs.push(root);
    const workerRoot = join(root, 'remote-desktop-worker', 'linux-x64');
    await mkdir(workerRoot, { recursive: true });
    const workerFile = join(workerRoot, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
    const writeRelease = async (dir: string, version: string, contents: string) => {
      const executable = join(dir, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
      const bytes = Buffer.from(contents);
      await writeFile(executable, bytes, { mode: 0o755 });
      await writeFile(`${executable}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`, JSON.stringify({
        schemaVersion: 1,
        artifact: {
          fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
          os: 'linux',
          arch: 'x64',
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        build: { source: 'ci', version },
      }));
      return {
        workerDir: dir,
        artifactPath: executable,
        manifestPath: `${executable}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    };
    await writeRelease(workerRoot, '2026.9.5113-dev.5644', 'old-worker');
    const downloaded = (version: string, contents: string) => async ({ dir }: { dir: string }) => {
      const targetDir = join(dir, 'remote-desktop-worker', 'linux-x64');
      await mkdir(targetDir, { recursive: true });
      return writeRelease(targetDir, version, contents);
    };

    const newer = await refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      downloadLinuxWorker: downloaded('2026.10.5371-dev.5816', 'new-worker') as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
    });
    expect(newer).toMatchObject({ updated: true, targetVersion: '2026.10.5371-dev.5816' });
    expect(newer.installedVersion).toBe('2026.10.5371-dev.5816');
    expect(newer.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');

    const current = await refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      downloadLinuxWorker: downloaded('2026.10.5371-dev.5816', 'same-worker') as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
    });
    expect(current).toMatchObject({ updated: false, targetVersion: '2026.10.5371-dev.5816', reason: 'worker_current' });
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');

    const older = await refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      downloadLinuxWorker: downloaded('2026.9.5113-dev.5644', 'old-target') as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
    });
    expect(older).toMatchObject({ updated: false, targetVersion: '2026.9.5113-dev.5644', reason: 'worker_downgrade_rejected' });
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');

    const unknown = await refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      downloadLinuxWorker: downloaded('opaque-worker-build', 'unknown-target') as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
    });
    expect(unknown).toMatchObject({ updated: false, targetVersion: 'opaque-worker-build', reason: 'worker_version_unparseable' });
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');

    const fenced = await refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      canCommit: () => false,
      downloadLinuxWorker: downloaded('2026.11.1-dev.1', 'fenced-worker') as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
    });
    expect(fenced).toMatchObject({ updated: false, targetVersion: '2026.11.1-dev.1', reason: 'worker_busy' });
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');
  });

  it('holds the commit fence across a paused atomic rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-worker-fence-test-'));
    dirs.push(root);
    const workerRoot = join(root, 'remote-desktop-worker', 'linux-x64');
    await mkdir(workerRoot, { recursive: true });
    const workerFile = join(workerRoot, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
    const writeRelease = async (dir: string, version: string, contents: string) => {
      const executable = join(dir, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
      const bytes = Buffer.from(contents);
      await writeFile(executable, bytes, { mode: 0o755 });
      await writeFile(`${executable}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`, JSON.stringify({
        schemaVersion: 1,
        artifact: { fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME, os: 'linux', arch: 'x64', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
        build: { source: 'ci', version },
      }));
      return { workerDir: dir, artifactPath: executable, manifestPath: `${executable}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    await writeRelease(workerRoot, '2026.9.5113-dev.5644', 'old-worker');
    const downloaded = async ({ dir }: { dir: string }) => {
      const targetDir = join(dir, 'remote-desktop-worker', 'linux-x64');
      await mkdir(targetDir, { recursive: true });
      return writeRelease(targetDir, '2026.10.5371-dev.5816', 'new-worker');
    };
    let releaseRename!: () => void;
    let firstRenameReady!: () => void;
    const renameReady = new Promise<void>((resolve) => { firstRenameReady = resolve; });
    const renameContinue = new Promise<void>((resolve) => { releaseRename = resolve; });
    let held = false;
    const commitFence = {
      acquire: vi.fn(() => {
        if (held) return null;
        held = true;
        return () => { held = false; };
      }),
    };
    const refreshPromise = refreshControlledNodeRemoteDesktopWorker({
      credential,
      platform: 'linux',
      arch: 'x64',
      root,
      downloadLinuxWorker: downloaded as typeof downloadControlledNodeLinuxRemoteDesktopWorker,
      commitFence,
      rename: async (...args) => {
        firstRenameReady();
        await renameContinue;
        return fsRename(...args);
      },
    });
    await renameReady;
    expect(commitFence.acquire()).toBeNull();
    releaseRename();
    expect(await refreshPromise).toMatchObject({ updated: true, targetVersion: '2026.10.5371-dev.5816' });
    expect(await readFile(workerFile, 'utf8')).toBe('new-worker');
  });

  it('keeps the production controlled-node bundle independent of the native addon that requires quiesce', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-node-exe-deps.mjs'], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain('node-datachannel excluded');
  });

  it('maps only canonical platform artifacts', () => {
    expect(controlledNodeArtifactTarget('win32', 'x64')).toEqual({ os: 'win', arch: 'x64' });
    expect(controlledNodeArtifactTarget('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(controlledNodeArtifactTarget('darwin', 'x64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(controlledNodeArtifactTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(controlledNodeArtifactTarget('win32', 'arm64')).toBeNull();
    expect(normalizeControlledNodeArtifactPair('mac', 'arm64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(isControlledNodeArtifactCompatibleWithRuntime('mac', 'arm64', 'mac', 'arm64')).toBe(true);
    expect(isControlledNodeArtifactCompatibleWithRuntime('mac', 'universal', 'mac', 'x64')).toBe(true);
    expect(controlledNodeComputerUseHelperFilename('win')).toBe('open-computer-use.exe');
    expect(controlledNodeComputerUseHelperFilename('mac')).toBe('open-computer-use.app.zip');
    expect(controlledNodeComputerUseHelperFilename('linux')).toBe('open-computer-use');
  });

  it('builds the node-token artifact URL with serverId, os, and arch', () => {
    const url = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' });
    expect(url).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64`);
    const helperUrl = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' }, CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER);
    expect(helperUrl).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64&asset=computer-use-helper`);
  });

  it('streams the controlled-node executable to disk without buffering the whole response body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-streaming-download-test-'));
    dirs.push(dir);
    const chunks = [
      Buffer.alloc(64 * 1024, 0x61),
      Buffer.alloc(64 * 1024, 0x62),
      Buffer.from('final-chunk'),
    ];
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const hash = createHash('sha256');
    chunks.forEach((chunk) => hash.update(chunk));
    const sha256 = hash.digest('hex');
    let nextChunk = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[nextChunk++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }), {
      status: 200,
      headers: {
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(size),
        [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.9.1',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
      },
    });
    const wholeBodyRead = vi.fn(async () => {
      throw new Error('whole_body_buffered');
    });
    Object.defineProperty(response, 'arrayBuffer', { value: wholeBodyRead });

    const downloaded = await downloadControlledNodeExecutable({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });

    expect(wholeBodyRead).not.toHaveBeenCalled();
    expect(downloaded).toMatchObject({ sha256, sizeBytes: size });
    expect(await readFile(downloaded!.artifactPath)).toEqual(Buffer.concat(chunks));
  });

  it('removes a rejected streamed download without replacing an existing artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-streaming-reject-test-'));
    dirs.push(dir);
    const artifactPath = join(dir, 'imcodes-node.exe');
    await writeFile(artifactPath, 'existing verified artifact');
    const bytes = Buffer.from('corrupt replacement');

    await expect(downloadControlledNodeExecutable({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      fetchImpl: (async () => new Response(bytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: 'a'.repeat(64),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.9.1',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
        },
      })) as unknown as typeof fetch,
    })).rejects.toThrow('artifact_sha256_mismatch');

    expect(await readFile(artifactPath, 'utf8')).toBe('existing verified artifact');
    expect(await readdir(dir)).toEqual(['imcodes-node.exe']);
  });

  it('leaves a durable phase trail when the artifact body aborts before its first chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-node-download-phase-test-'));
    dirs.push(root);
    const bytes = Buffer.from('unread artifact');
    const fetchImpl = (async (url: string) => {
      if (url.includes('asset=')) return new Response(null, { status: 404 });
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('simulated_body_read_abort'));
        },
      }), {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.9.1',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
        },
      });
    }) as unknown as typeof fetch;

    await expect(startControlledNodeSelfUpgrade(credential, '2026.9.1', {
      fetchImpl,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => root,
      removeUpgradeDir: async () => {},
    })).rejects.toThrow('simulated_body_read_abort');

    const stagingDirs = await readdir(root);
    expect(stagingDirs).toHaveLength(1);
    const progress = (await readFile(join(
      root,
      stagingDirs[0]!,
      CONTROLLED_NODE_UPGRADE_PROGRESS_FILE,
    ), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { phase: string });
    expect(progress.map(({ phase }) => phase)).toEqual([
      'staging_created',
      'artifact_request_started',
      'artifact_response_open',
    ]);
  });

  it('downloads the Windows remote-desktop worker only with its matching pinned manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-worker-upgrade-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('pinned libwebrtc worker');
    const virtualDisplayBytes = Buffer.from('signed virtual display archive');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const manifest = Buffer.from(JSON.stringify({
      manifestVersion: 2,
      workerVersion: '0.1.2',
      protocolVersion: 2,
      ipcVersion: 1,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: bytes.length,
      sha256: digest,
      authenticodeSignerSha256: 'c'.repeat(64),
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      virtualDisplay: {
        archiveFileName: 'imcodes-virtual-display.zip',
        packageManifestFileName: 'imcodes-virtual-display.manifest.json',
        size: virtualDisplayBytes.length,
        sha256: createHash('sha256').update(virtualDisplayBytes).digest('hex'),
      },
      toolchain: {
        msvc: '14.44',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
      },
    }));
    const result = await downloadControlledNodeRemoteDesktopWorker({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      expectedVersion: '0.1.2',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
        });
        const isManifest = url.includes('asset=remote-desktop-worker-manifest');
        const isVirtualDisplay = url.includes('asset=remote-desktop-virtual-display');
        const body = isManifest ? manifest : isVirtualDisplay ? virtualDisplayBytes : bytes;
        return new Response(body, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isManifest
              ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
              : isVirtualDisplay ? 'imcodes-virtual-display.zip' : REMOTE_DESKTOP_WORKER_FILENAME,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '0.1.2',
          },
        });
      }) as unknown as typeof fetch,
    });
    expect(result).toBeDefined();
    expect(await readFile(result!.artifactPath)).toEqual(bytes);
    expect(await readFile(result!.manifestPath)).toEqual(manifest);
    expect((await readdir(join(dir, 'remote-desktop-worker', 'win32-x64'))).sort()).toEqual([
      'imcodes-remote-desktop-worker.exe',
      'imcodes-remote-desktop-worker.exe.manifest.json',
      'imcodes-virtual-display.zip',
    ]);
  });

  it.each([404, 409, 503])('refuses to split a Windows release when the worker endpoint returns %s', async (status) => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-worker-skew-test-'));
    dirs.push(dir);
    await expect(downloadControlledNodeRemoteDesktopWorker({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      expectedVersion: '0.1.2',
      fetchImpl: (async () => new Response(null, { status })) as unknown as typeof fetch,
    })).rejects.toThrow(`download_failed_${status}`);
  });

  it('rejects a worker artifact from a different Node release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-worker-version-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('stale remote desktop worker');
    await expect(downloadControlledNodeRemoteDesktopWorker({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      expectedVersion: '2026.7.2',
      fetchImpl: (async () => new Response(bytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: REMOTE_DESKTOP_WORKER_FILENAME,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
        },
      })) as unknown as typeof fetch,
    })).rejects.toThrow('artifact_version_mismatch');
  });

  it('downloads, verifies sha256, writes a staged artifact, and spawns a detached Windows upgrader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('new controlled node exe');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const helperBytes = Buffer.from('new open computer use helper');
    const helperSha256 = createHash('sha256').update(helperBytes).digest('hex');
    const workerBytes = Buffer.from('same-release remote desktop worker');
    const virtualDisplayBytes = Buffer.from('same-release virtual display archive');
    const workerManifest = Buffer.from(JSON.stringify({
      manifestVersion: 2,
      workerVersion: '2026.7.1',
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: 1,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: workerBytes.length,
      sha256: createHash('sha256').update(workerBytes).digest('hex'),
      authenticodeSignerSha256: WINDOWS_SIGNER_SHA256,
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      virtualDisplay: {
        archiveFileName: 'imcodes-virtual-display.zip',
        packageManifestFileName: 'imcodes-virtual-display.manifest.json',
        size: virtualDisplayBytes.length,
        sha256: createHash('sha256').update(virtualDisplayBytes).digest('hex'),
      },
      toolchain: {
        msvc: '14.44',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
      },
    }));
    const journalPath = join(dir, 'install-journal.json');
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_healthy',
      updatedAt: 1,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      sourceArtifact: { sha256: 'a'.repeat(64), size: 2048 },
      stagedExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      stagedReceipt: {
        path: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
        size: 3,
        sha256: 'b'.repeat(64),
        sourceIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
      },
      serverId: 'srv-1',
      serviceName: 'imcodes-node',
      serviceReceipt: { name: 'imcodes-node', platform: 'win32', action: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe' },
      serviceStartRequestedAt: 1,
      healthyAt: 1,
    }), 'utf8');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH);
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
        'X-Server-Id': 'srv-1',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
      });
      if (url.includes('asset=computer-use-helper')) {
        return new Response(helperBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: helperSha256,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(helperBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'open-computer-use.exe',
          },
        });
      }
      const isWorkerManifest = url.includes('asset=remote-desktop-worker-manifest');
      const isVirtualDisplay = url.includes('asset=remote-desktop-virtual-display');
      const isWorker = url.includes('asset=remote-desktop-worker');
      if (isWorkerManifest || isVirtualDisplay || isWorker) {
        const body = isWorkerManifest ? workerManifest : isVirtualDisplay ? virtualDisplayBytes : workerBytes;
        return new Response(body, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isWorkerManifest
              ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
              : isVirtualDisplay ? 'imcodes-virtual-display.zip' : REMOTE_DESKTOP_WORKER_FILENAME,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
        },
      });
    });
    const scheduled: Array<{ taskName: string; taskXmlPath: string }> = [];
    const result = await startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      journalPath,
      tmpdir: () => dir,
      now: () => 9,
      scheduleWindowsUpgrade: (taskName, taskXmlPath) => { scheduled.push({ taskName, taskXmlPath }); },
    });

    expect(result).toMatchObject({ ok: true, targetVersion: '2026.7.1', artifactSha256: sha256 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].taskName).toMatch(/^imcodes-node-upgrade-/);
    expect(scheduled[0].taskXmlPath).toBe(join(dirname(result.scriptPath!), 'upgrade-task.xml'));
    const stagedManifest = JSON.parse(
      await readFile(join(dirname(result.scriptPath!), 'imcodes-node.exe.manifest.json'), 'utf8'),
    ) as { artifact: { authenticodeSignerSha256?: string } };
    expect(stagedManifest.artifact.authenticodeSignerSha256).toBe(WINDOWS_SIGNER_SHA256);
    const script = await readFile(result.scriptPath!, 'utf8');
    expect(script).toContain("targetVersion = '2026.7.1'");
    expect(script).toContain(`artifactSha256 = '${sha256}'`);
    const ownershipMarkerPath = join(dirname(result.scriptPath!), CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
    const ownershipMarker = JSON.parse(await readFile(ownershipMarkerPath, 'utf8')) as {
      directoryName: string;
      ownerToken: string;
      pid: number;
    };
    expect(ownershipMarker.directoryName).toBe(dirname(result.scriptPath!).split('/').at(-1));
    expect(ownershipMarker.pid).toBe(process.pid);
    expect(script).toContain(`$stagingOwnershipMarker = '${ownershipMarkerPath}'`);
    expect(script).toContain(`$stagingOwnerToken = '${ownershipMarker.ownerToken}'`);
    expect(script).toContain('$stagingMarkerState.pid = $PID');
    const progress = (await readFile(join(
      dirname(result.scriptPath!),
      CONTROLLED_NODE_UPGRADE_PROGRESS_FILE,
    ), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { phase: string });
    expect(progress.map(({ phase }) => phase)).toEqual([
      'staging_created',
      'artifact_request_started',
      'artifact_response_open',
      'artifact_first_chunk',
      'artifact_body_complete',
      'artifact_verified',
      'artifact_published',
      'handoff_ready',
    ]);
    expect(script.indexOf('$stagingMarkerState.pid = $PID'))
      .toBeLessThan(script.indexOf('Get-AuthenticodeSignature -LiteralPath $src'));
    expect(script).toContain('Stop-ScheduledTask');
    expect(script).toContain('Start-ScheduledTask');
    expect(script).toContain('$waitForNodeExecutableRelease = { param([int]$timeoutMs = 30000)');
    expect(script).toContain("[IO.FileShare]::None");
    expect(script).toContain("throw 'controlled node executable remained locked after stop'");
    expect(script.indexOf('& $waitForNodeExecutableRelease'))
      .toBeLessThan(script.indexOf('& $publishAtomic $src $dst $backupDst'));
    expect(script).toContain("$rollbackExecutableReleased = [bool](& $runRecovery 'stop_new_node' { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; & $waitForNodeExecutableRelease; return $true })");
    const rollbackReleaseGuard = script.indexOf('if ($rollbackExecutableReleased) {');
    const rollbackMainRestore = script.indexOf("& $runRecovery 'restore_main'");
    const rollbackSkip = script.indexOf('restore_artifacts: skipped because the controlled node executable release fence failed');
    expect(rollbackReleaseGuard).toBeGreaterThan(script.indexOf('$rollbackExecutableReleased = [bool]'));
    expect(rollbackMainRestore).toBeGreaterThan(rollbackReleaseGuard);
    expect(rollbackSkip).toBeGreaterThan(rollbackMainRestore);
    expect(script).toContain("$upgradeMarker = Join-Path (Split-Path -Parent $dst) 'upgrade-in-progress.json'");
    expect(script).not.toContain('Disable-ScheduledTask -TaskName $watchdogTask');
    expect(script).not.toContain('Stop-ScheduledTask -TaskName $watchdogTask');
    expect(script).toContain('[IO.File]::Replace($pending, $destination, $backup, $true)');
    expect(script).toContain('previousReceipt = $previousJournal.stagedReceipt');
    expect(script).toContain('targetReceipt = $targetJournal.stagedReceipt');
    expect(script).toContain("product = 'imcodes-controlled-node-upgrade'");
    expect(script).toContain('computer-use-helper');
    expect(script).toContain('[IO.File]::Replace($pendingJournal, $dstJournal, $journalSwapBackup, $true)');
    expect(script).toContain('[IO.File]::Replace($pendingManifest, $dstManifest, $manifestSwapBackup, $true)');
    // Windows PowerShell 5.1 rejects a null destinationBackupFileName even
    // though newer .NET signatures annotate it nullable.
    expect(script).not.toMatch(/\[IO\.File\]::Replace\([^\r\n]+, \$null, \$true\)/);
    expect(script).toContain('Copy-Item -Recurse -Force -Path (Join-Path $srcHelper');
    expect(script).toContain('install-journal.json');
    expect(script).toContain(`Unregister-ScheduledTask -TaskName '${scheduled[0].taskName}'`);
    const taskXml = (await readFile(scheduled[0].taskXmlPath)).subarray(2).toString('utf16le');
    expect(taskXml).toContain('<UserId>S-1-5-18</UserId>');
    expect(taskXml).toContain('<BootTrigger><Enabled>true</Enabled></BootTrigger>');
    expect(taskXml).toContain('powershell.exe');
    expect(taskXml).toContain(result.scriptPath!);
    const helperPath = join(dirname(result.scriptPath!), 'computer-use-helper', 'win32-x64', 'open-computer-use.exe');
    expect(await readFile(helperPath, 'utf8')).toBe('new open computer use helper');
    expect(await readFile(
      join(dirname(result.scriptPath!), 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME),
      'utf8',
    )).toBe('same-release remote desktop worker');
    const nextJournal = JSON.parse(await readFile(join(dirname(result.scriptPath!), 'install-journal.json'), 'utf8')) as {
      updatedAt: number;
      stagedReceipt: { path: string; size: number; sha256: string; stagedIdentity: { size: number } };
    };
    expect(nextJournal.updatedAt).toBe(9);
    expect(nextJournal.stagedReceipt).toMatchObject({
      path: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      size: bytes.length,
      sha256,
    });
    expect(nextJournal.stagedReceipt.stagedIdentity.size).toBe(bytes.length);
  });

  describe('withArtifactDownloadRetries', () => {
    it('retries a transient network failure and returns the eventual success', async () => {
      let calls = 0;
      const sleeps: number[] = [];
      const result = await withArtifactDownloadRetries(async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed');
        return 'ok';
      }, { sleep: async (ms) => { sleeps.push(ms); } });
      expect(result).toBe('ok');
      expect(calls).toBe(3);
      // Exponential backoff from the base delay, doubling each retry.
      expect(sleeps).toEqual([3_000, 6_000]);
    });

    it('caps the backoff delay and exhausts attempts, throwing the last transient error', async () => {
      let calls = 0;
      const sleeps: number[] = [];
      await expect(withArtifactDownloadRetries(async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      }, { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 3_000, sleep: async (ms) => { sleeps.push(ms); } }))
        .rejects.toThrow('fetch failed');
      expect(calls).toBe(5);
      // 1000, 2000, then capped at 3000 for the remaining retries; the 5th
      // (final) attempt's failure is not followed by a sleep at all.
      expect(sleeps).toEqual([1_000, 2_000, 3_000, 3_000]);
    });

    it('does not retry a non-transient failure, such as a real integrity mismatch', async () => {
      let calls = 0;
      const sleep = vi.fn(async () => {});
      await expect(withArtifactDownloadRetries(async () => {
        calls += 1;
        throw new Error('artifact_sha256_mismatch');
      }, { sleep })).rejects.toThrow('artifact_sha256_mismatch');
      expect(calls).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it('recovers a self-upgrade from a transient artifact-download network failure without failing the whole attempt', async () => {
    // Reproduces the real fleet incident: an office machine on a poor network
    // link had its artifact download fail with Node's generic `fetch failed`
    // partway through, requiring a full ~70s server-driven retry cycle for
    // every dropped connection. This proves the download itself now retries
    // in-process instead of failing the whole upgrade attempt outright.
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-retry-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('new controlled node exe');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const helperBytes = Buffer.from('new open computer use helper');
    const workerBytes = Buffer.from('same-release remote desktop worker');
    const virtualDisplayBytes = Buffer.from('same-release virtual display archive');
    const workerManifest = Buffer.from(JSON.stringify({
      manifestVersion: 2,
      workerVersion: '2026.7.1',
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: 1,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: workerBytes.length,
      sha256: createHash('sha256').update(workerBytes).digest('hex'),
      authenticodeSignerSha256: WINDOWS_SIGNER_SHA256,
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      virtualDisplay: {
        archiveFileName: 'imcodes-virtual-display.zip',
        packageManifestFileName: 'imcodes-virtual-display.manifest.json',
        size: virtualDisplayBytes.length,
        sha256: createHash('sha256').update(virtualDisplayBytes).digest('hex'),
      },
      toolchain: {
        msvc: '14.44',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
      },
    }));
    const journalPath = join(dir, 'install-journal.json');
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_healthy',
      updatedAt: 1,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      sourceArtifact: { sha256: 'a'.repeat(64), size: 2048 },
      stagedExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      stagedReceipt: {
        path: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
        size: 3,
        sha256: 'b'.repeat(64),
        sourceIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
      },
      serverId: 'srv-1',
      serviceName: 'imcodes-node',
      serviceReceipt: { name: 'imcodes-node', platform: 'win32', action: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe' },
      serviceStartRequestedAt: 1,
      healthyAt: 1,
    }), 'utf8');
    let mainArtifactAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('asset=computer-use-helper')) {
        return new Response(helperBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(helperBytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(helperBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'open-computer-use.exe',
          },
        });
      }
      const isWorkerManifest = url.includes('asset=remote-desktop-worker-manifest');
      const isVirtualDisplay = url.includes('asset=remote-desktop-virtual-display');
      const isWorker = url.includes('asset=remote-desktop-worker');
      if (isWorkerManifest || isVirtualDisplay || isWorker) {
        const body = isWorkerManifest ? workerManifest : isVirtualDisplay ? virtualDisplayBytes : workerBytes;
        return new Response(body, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isWorkerManifest
              ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
              : isVirtualDisplay ? 'imcodes-virtual-display.zip' : REMOTE_DESKTOP_WORKER_FILENAME,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }
      // The main node executable: fail with the exact real-world error twice,
      // then succeed, matching the observed office-machine incident.
      mainArtifactAttempts += 1;
      if (mainArtifactAttempts <= 2) throw new TypeError('fetch failed');
      return new Response(bytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
        },
      });
    });
    const result = await startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      journalPath,
      tmpdir: () => dir,
      now: () => 9,
      scheduleWindowsUpgrade: () => {},
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, targetVersion: '2026.7.1', artifactSha256: sha256 });
    expect(mainArtifactAttempts).toBe(3);
  });

  it('refuses to stage when the temporary filesystem is below the free-space guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-low-space-'));
    dirs.push(root);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const result = await startControlledNodeSelfUpgrade(credential, '2026.9.1', {
      fetchImpl,
      platform: 'linux',
      arch: 'x64',
      tmpdir: () => root,
      freeBytes: async () => CONTROLLED_NODE_UPGRADE_MIN_FREE_BYTES - 1,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'insufficient_disk_space' }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not schedule the main executable when its Windows worker bundle is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-worker-missing-'));
    dirs.push(dir);
    const bytes = Buffer.from('new controlled node exe');
    const scheduleWindowsUpgrade = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async (url: string) => {
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        if (url.includes('asset=remote-desktop-worker')) return new Response(null, { status: 503 });
        return new Response(bytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
          },
        });
      }) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      scheduleWindowsUpgrade,
    })).rejects.toThrow('download_failed_503');
    expect(scheduleWindowsUpgrade).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects artifact checksum mismatches before spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-bad-'));
    dirs.push(dir);
    const spawned = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async () => new Response(Buffer.from('bad'), {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: 'a'.repeat(64),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: '3',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
        },
      })) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      spawnDetached: spawned,
    })).rejects.toThrow(/artifact_sha256_mismatch/);
    expect(spawned).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('best-effort removes its staging directory on download failure without masking the authoritative error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-download-cleanup-'));
    dirs.push(root);
    const diagnostics: Array<{ outcome: string; code: string }> = [];
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      tmpdir: () => root,
      removeUpgradeDir: async () => {
        const error = new Error('disk is full') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).rejects.toThrow('download_failed_503');
    expect(diagnostics).toContainEqual(expect.objectContaining({ outcome: 'failed', code: 'ENOSPC' }));
    expect(diagnostics.map((entry) => JSON.stringify(entry)).join('\n')).not.toContain(root);
  });

  it('removes its staging directory on download failure with the default cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-download-cleanup-default-'));
    dirs.push(root);
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      platform: 'linux',
      arch: 'x64',
      tmpdir: () => root,
      sleep: async () => {},
    })).rejects.toThrow('download_failed_503');
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['upgrade marker write', 'marker_write_failed'],
    ['upgrade script write', 'script_write_failed'],
    ['upgrade XML write', 'xml_write_failed'],
    ['schtasks Create', 'create_failed'],
    ['schtasks Run', 'run_failed'],
  ] as const)('removes its owned staging directory when %s fails before handoff', async (failurePoint, expectedError) => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-handoff-cleanup-'));
    dirs.push(root);
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: createWindowsUpgradeFetch(),
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => root,
      writeUpgradeFile: async (path, data, options) => {
        if (failurePoint === 'upgrade marker write' && path.endsWith(CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER)) throw new Error(expectedError);
        if (failurePoint === 'upgrade script write' && path.endsWith('upgrade.ps1')) throw new Error(expectedError);
        if (failurePoint === 'upgrade XML write' && path.endsWith('upgrade-task.xml')) throw new Error(expectedError);
        await writeFile(path, data, options);
      },
      scheduleWindowsUpgrade: (taskName, taskXmlPath) => {
        scheduleWindowsControlledNodeUpgrade(taskName, taskXmlPath, (_file, args) => {
          if (failurePoint === 'schtasks Create' && args[0] === '/Create') throw new Error(expectedError);
          if (failurePoint === 'schtasks Run' && args[0] === '/Run') throw new Error(expectedError);
        });
      },
    })).rejects.toThrow(expectedError);
    expect(await readdir(root)).toEqual([]);
  });

  it('removes its staging directory when journal preparation fails closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-journal-cleanup-'));
    dirs.push(root);
    const journalPath = join(root, 'install-journal.json');
    await writeFile(journalPath, '{not-json');
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: createWindowsUpgradeFetch(),
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      journalPath,
      tmpdir: () => root,
    })).rejects.toThrow('install journal JSON is invalid');
    expect(await readdir(root)).toEqual(['install-journal.json']);
  });

  it('emits ownership-bound helper cleanup from preflight and terminal finally paths', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe',
      stagedManifestPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe.manifest.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      upgradeTaskName: 'imcodes-node-upgrade-test',
      stagingOwnership: {
        directoryPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123',
        markerPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\.imcodes-controlled-node-upgrade.json',
        ownerToken: '12345678-1234-4123-8123-123456789abc',
      },
    });
    expect(script.match(/Remove-Item -LiteralPath \$stagingDir -Recurse -Force -ErrorAction Stop/g)).toHaveLength(2);
    expect(script).toContain("$stagingItem.Name -cnotmatch '^imcodes-node-upgrade-");
    expect(script).toContain('$stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint');
    expect(script).toContain('[string]$stagingMarker.ownerToken -cne $stagingOwnerToken');
    expect(script).toContain('$stagingMarkerState.pid = $PID');
    const finallyStart = script.lastIndexOf('} finally {');
    const finalCleanup = script.indexOf('Remove-Item -LiteralPath $stagingDir', finallyStart);
    expect(finallyStart).toBeGreaterThan(script.indexOf("status = 'success'"));
    expect(finallyStart).toBeGreaterThan(script.indexOf('$rollbackStatus ='));
    expect(script.indexOf("Unregister-ScheduledTask -TaskName 'imcodes-node-upgrade-test'", finallyStart))
      .toBeLessThan(finalCleanup);
  });

  it('persists bounded Windows handoff evidence before owned staging cleanup', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe',
      stagedManifestPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe.manifest.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      targetVersion: '2026.9.9999',
      artifactSha256: 'd'.repeat(64),
      upgradeTaskName: 'imcodes-node-upgrade-test',
      stagingOwnership: {
        directoryPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123',
        markerPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\.imcodes-controlled-node-upgrade.json',
        ownerToken: '12345678-1234-4123-8123-123456789abc',
      },
    });

    expect(script).toContain("$persistentUpgradeResult = Join-Path (Split-Path -Parent $dst) 'last-upgrade-result.json'");
    expect(script).toContain("targetVersion = '2026.9.9999'");
    expect(script).toContain("artifactSha256 = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'");
    expect(script).toContain("if ('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' -and $srcHash -cne 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')");
    expect(script).toContain('mainArtifactVerified = [bool]$mainArtifactVerified');
    expect(script).toContain('helperArtifactVerified = [bool]$helperArtifactVerified');
    expect(script).toContain('remoteDesktopArtifactVerified = [bool]$remoteDesktopArtifactVerified');
    expect(script).toContain('$persistentUpgradeResultTemp = "$persistentUpgradeResult.pending-$PID"');
    expect(script).toContain('Move-Item -Force -LiteralPath $persistentUpgradeResultTemp -Destination $persistentUpgradeResult');
    expect(script).toContain("status = 'preflight_failed'; phase = 'preflight'");
    expect(script).toContain("status = 'success'; phase = 'complete'");
    expect(script).toContain("status = $rollbackStatus; phase = 'rollback'");
    // preflight, rollback progress (per step), rollback_started, rollback terminal
    expect(script.match(/error = \$failureMessage/g)).toHaveLength(4);
    expect(script.match(/failedPhase = \$upgradePhase/g)).toHaveLength(3);
    expect(script).toContain("$upgradePhase = 'restart_health'");
    expect(script).toContain('if ($recoveryFailure.Length -gt 240)');
    const preflightPersist = script.indexOf("status = 'preflight_failed'; phase = 'preflight'");
    const preflightCleanup = script.indexOf('Remove-Item -LiteralPath $stagingDir', preflightPersist);
    expect(preflightPersist).toBeGreaterThan(0);
    expect(preflightCleanup).toBeGreaterThan(preflightPersist);
    expect(script).not.toContain('IMCODES_UPGRADE_CLEANUP_SKIPPED');
  });

  it('records the attempt as in_progress, waits for health with the progress-aware window, and journals every rollback step', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe',
      stagedManifestPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe.manifest.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      targetVersion: '2026.9.9999',
      artifactSha256: 'd'.repeat(64),
      upgradeTaskName: 'imcodes-node-upgrade-test',
    });

    // The old fixed 60 x 2 s poll from Start-ScheduledTask is gone.
    expect(script).not.toMatch(/\$attempt\s*-lt\s*60/);
    expect(script).toContain('function Get-IMCodesUpgradeHealthVerdict');
    expect(script).toContain(`-ge ${CONTROLLED_NODE_UPGRADE_HEALTH.HARD_CAP_MS}`);
    const start = script.indexOf('Start-ScheduledTask -TaskName $task\r\n');
    expect(start).toBeGreaterThan(0);
    expect(script.indexOf('Wait-IMCodesNodeHealthy -LeasePath $healthLease', start)).toBeGreaterThan(start);

    // A killed script leaves `in_progress` (target named) instead of the previous attempt's outcome,
    // and it is written before anything is stopped or replaced.
    const inProgress = script.indexOf("status = 'in_progress'; phase = 'install'");
    expect(inProgress).toBeGreaterThan(0);
    expect(inProgress).toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n& $waitForNodeExecutableRelease\r\n'));
    expect(inProgress).toBeLessThan(script.indexOf("$upgradePhase = 'restart_health'"));

    // Every completed rollback step is persisted, so an interrupted rollback says how far it got.
    expect(script).toContain('$rollbackProgress = [System.Collections.Generic.List[string]]::new()');
    expect(script).toMatch(/& \$action; \[void\]\$rollbackProgress\.Add\(\$label\); try \{ \[void\]\(& \$writeUpgradeResult @\{ status = 'rollback_started'; phase = 'rollback'; failedPhase = \$upgradePhase; error = \$failureMessage; reason = \$failureMessage; rollbackProgress = @\(\$rollbackProgress\)/);
    // Neither wait asks WMI (3 minutes for one query on a loaded real node) and the executable-release
    // wait always makes a verification pass after the kill, however slow the first pass was.
    expect(script).not.toContain('Get-CimInstance');
    expect(script).toContain('while ($passes -lt 2 -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)');
    // The failure text names the verdict so the diagnosis is not just "failed health verification".
    expect(script).toContain("'controlled node upgrade failed authenticated health verification ('");
  });

  it('scavenges only old direct owned non-reparse staging directories and preserves live/new/unowned entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-'));
    dirs.push(root);
    const now = Date.now();
    const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
    const stale = await createOwnedUpgradeDir({ root, suffix: 'stale01', createdAt: old, bom: true });
    const recent = await createOwnedUpgradeDir({ root, suffix: 'recent1', createdAt: now - 1_000 });
    const live = await createOwnedUpgradeDir({ root, suffix: 'active1', createdAt: old, pid: process.pid });
    const unowned = await createOwnedUpgradeDir({ root, suffix: 'nomark1', createdAt: old, marker: false });
    const wrongPrefix = join(root, 'other-product-upgrade-stale01');
    await mkdir(wrongPrefix);
    const external = join(root, 'external-target');
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'keep');
    const linked = join(root, `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}linked1`);
    await symlink(external, linked, 'dir');

    const diagnostics: Array<{ outcome: string; code: string }> = [];
    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      uptime: () => 30 * 24 * 60 * 60,
      isProcessAlive: (pid) => pid === process.pid,
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(removed).toBe(1);
    await expect(readFile(join(stale, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER))).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual([
      'external-target',
      `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}active1`,
      `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}linked1`,
      `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}nomark1`,
      `${CONTROLLED_NODE_UPGRADE_DIR_PREFIX}recent1`,
      'other-product-upgrade-stale01',
    ].sort());
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(recent, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), 'utf8')).toContain('recent1');
    expect(await readFile(join(live, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), 'utf8')).toContain('active1');
    expect(await readdir(unowned)).toEqual([]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'skipped', code: 'pid_alive' }),
      expect.objectContaining({ outcome: 'skipped', code: 'marker_missing' }),
    ]));
  });

  it('deletes a pre-boot staging directory even when its recorded pid was reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-preboot-'));
    dirs.push(root);
    const now = Date.now();
    const candidate = await createOwnedUpgradeDir({
      root,
      suffix: 'preboot1',
      createdAt: now - (2 * CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS),
      pid: 2_805_176,
    });
    const isProcessAlive = vi.fn(() => true);

    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      uptime: () => 24 * 60 * 60,
      isProcessAlive,
    });

    expect(removed).toBe(1);
    expect(isProcessAlive).not.toHaveBeenCalled();
    await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes staging beyond the absolute TTL even when the system and pid stayed alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-ttl-'));
    dirs.push(root);
    const now = Date.now();
    const candidate = await createOwnedUpgradeDir({
      root,
      suffix: 'expired1',
      createdAt: now - CONTROLLED_NODE_UPGRADE_ABSOLUTE_TTL_MS - 1,
      pid: 4,
    });
    const isProcessAlive = vi.fn(() => true);

    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      uptime: () => 30 * 24 * 60 * 60,
      isProcessAlive,
    });

    expect(removed).toBe(1);
    expect(isProcessAlive).not.toHaveBeenCalled();
    await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails open when stale cleanup cannot remove an owned directory and emits only a structured code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-failure-'));
    dirs.push(root);
    const now = Date.now();
    const stale = await createOwnedUpgradeDir({
      root,
      suffix: 'stale02',
      createdAt: now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000,
    });
    const diagnostics: Array<{ outcome: string; code: string }> = [];
    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      isProcessAlive: () => false,
      removeUpgradeDir: async () => {
        const error = new Error('secret filesystem detail') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(removed).toBe(0);
    expect(await readFile(join(stale, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), 'utf8')).toContain('stale02');
    expect(diagnostics).toEqual([expect.objectContaining({ outcome: 'failed', code: 'ENOSPC' })]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret filesystem detail');
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  it('hard-bounds lstat, marker reads and deletes per pass in a crowded Temp root, and still examines every directory over successive passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-bounds-'));
    dirs.push(root);
    const now = Date.now();
    const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
    for (let index = 0; index < 192; index += 1) {
      await createOwnedUpgradeDir({ root, suffix: `bulk${String(index).padStart(4, '0')}`, createdAt: old, pid: 1_000 + index });
    }
    const examined = new Set<number>();
    for (let pass = 0; pass < 8; pass += 1) {
      const operations = { enumerate: 0, lstat: 0, marker_read: 0, delete: 0 };
      const outcome = await scavengeStaleControlledNodeUpgradePass(root, {
        now: () => now,
        uptime: () => 30 * 24 * 60 * 60,
        isProcessAlive: (pid) => { examined.add(pid); return true; },
        onStaleScavengeOperation: (operation) => { operations[operation] += 1; },
      });
      expect(outcome.removed).toBe(0);
      // names are cheap and unbounded by the staging count; the expensive work is bounded per pass
      expect(operations.enumerate).toBe(192);
      expect(operations.lstat).toBeLessThanOrEqual(128);
      expect(operations.marker_read).toBeLessThanOrEqual(64);
      expect(operations.delete).toBe(0);
    }
    // nothing was removed (every owner is alive), and the cursor walked through all 192 directories
    expect(examined.size).toBe(192);
    expect(await readdir(root)).toHaveLength(192);
  });

  describe('a backlog behind a crowded Temp root (a real node: 155 stale staging directories among 15,067 entries)', () => {
    async function crowdedRoot(stale: number, junk: number) {
      const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-backlog-'));
      dirs.push(root);
      const now = Date.now();
      const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
      // Interleaved, so that wherever the filesystem puts them (creation order or hash order) the staging directories are
      // spread among the other entries instead of sitting at the front.
      const every = stale === 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(junk / stale));
      let madeStale = 0;
      for (let index = 0; index < junk; index += 1) {
        await writeFile(join(root, `other-${index}.log`), 'x');
        if (madeStale < stale && index % every === 0) {
          await createOwnedUpgradeDir({ root, suffix: `stale${String(madeStale).padStart(4, '0')}`, createdAt: old });
          madeStale += 1;
        }
      }
      for (; madeStale < stale; madeStale += 1) {
        await createOwnedUpgradeDir({ root, suffix: `stale${String(madeStale).padStart(4, '0')}`, createdAt: old });
      }
      return { root, now, old };
    }

    it('drains 163 stale directories in ceil(163 / 32) passes with every per-pass bound held, and touches nothing else', async () => {
      const { root, now } = await crowdedRoot(163, 4_000);
      const passes: number[] = [];
      for (let pass = 0; pass < 12 && passes.reduce((sum, n) => sum + n, 0) < 163; pass += 1) {
        const operations = { enumerate: 0, lstat: 0, marker_read: 0, delete: 0 };
        // the number-returning entry point (also the one the base build has): this test fails there, which is the point
        const removedNow = await scavengeStaleControlledNodeUpgradeDirs(root, {
          now: () => now,
          uptime: () => 1,
          isProcessAlive: () => false,
          onStaleScavengeOperation: (operation) => { operations[operation] += 1; },
        });
        expect(operations.delete).toBeLessThanOrEqual(32);
        expect(operations.lstat).toBeLessThanOrEqual(128);
        expect(operations.marker_read).toBeLessThanOrEqual(64);
        passes.push(removedNow);
      }
      expect(passes).toEqual([32, 32, 32, 32, 32, 3]);
      const remaining = await readdir(root);
      expect(remaining).toHaveLength(4_000);
      expect(remaining.every((name) => name.startsWith('other-'))).toBe(true);
    }, 120_000);

    it('young, live, unowned and symlinked entries at the front never starve the stale ones behind them', async () => {
      const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-starve-'));
      dirs.push(root);
      const now = Date.now();
      const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
      // names sort so the entries that must be kept come first
      for (let index = 0; index < 70; index += 1) await createOwnedUpgradeDir({ root, suffix: `a-young${String(index).padStart(3, '0')}`, createdAt: now - 1_000 });
      for (let index = 0; index < 30; index += 1) await createOwnedUpgradeDir({ root, suffix: `b-live${String(index).padStart(3, '0')}`, createdAt: old, pid: 424_242 });
      await createOwnedUpgradeDir({ root, suffix: 'c-nomarker', createdAt: old, marker: false });
      await symlink(tmpdir(), join(root, 'imcodes-node-upgrade-d-link01'));
      for (let index = 0; index < 40; index += 1) await createOwnedUpgradeDir({ root, suffix: `z-stale${String(index).padStart(3, '0')}`, createdAt: old, pid: 7 });
      const deps = { now: () => now, uptime: () => 30 * 24 * 60 * 60, isProcessAlive: (pid: number) => pid === 424_242 };
      let removedTotal = 0;
      let passesUsed = 0;
      for (; passesUsed < 10 && removedTotal < 40; passesUsed += 1) removedTotal += (await scavengeStaleControlledNodeUpgradePass(root, deps)).removed;
      expect(removedTotal).toBe(40);
      expect(passesUsed).toBeLessThanOrEqual(6);
      const left = await readdir(root);
      expect(left.filter((name) => name.includes('z-stale'))).toEqual([]);
      expect(left.filter((name) => name.includes('a-young'))).toHaveLength(70);
      expect(left.filter((name) => name.includes('b-live'))).toHaveLength(30);
      expect(left).toContain('imcodes-node-upgrade-c-nomarker');
      expect(left).toContain('imcodes-node-upgrade-d-link01');
      expect((await lstat(tmpdir())).isDirectory()).toBe(true);
    }, 120_000);

    it('never removes the staging directory of an upgrade in progress in this process', async () => {
      const { root, now, old } = await crowdedRoot(0, 0);
      const active = await createOwnedUpgradeDir({ root, suffix: 'activeone', createdAt: old, pid: 7 });
      activeControlledNodeUpgradeDirsForTests.add(active);
      try {
        const removed = await scavengeStaleControlledNodeUpgradeDirs(root, { now: () => now, uptime: () => 1, isProcessAlive: () => false });
        expect(removed).toBe(0);
        expect(await readdir(root)).toEqual([basename(active)]);
      } finally {
        activeControlledNodeUpgradeDirsForTests.delete(active);
      }
    });

    it('the scheduled sweep follows a budget-limited pass with short bounded passes until the backlog is gone, then stops', async () => {
      const { root, now } = await crowdedRoot(100, 0);
      vi.useFakeTimers();
      try {
        startControlledNodeUpgradeScavenger(root, { now: () => now, uptime: () => 1, isProcessAlive: () => false });
        const remainingAfter = async () => (await readdir(root)).length;
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(async () => expect(await remainingAfter()).toBe(68));
        // nothing happens before the follow-up delay...
        await vi.advanceTimersByTimeAsync(CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS - 1);
        expect(await remainingAfter()).toBe(68);
        // ...then one more bounded pass per delay
        for (const expected of [36, 4, 0]) {
          await vi.advanceTimersByTimeAsync(CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS);
          await vi.waitFor(async () => expect(await remainingAfter()).toBe(expected));
        }
        const timersBefore = vi.getTimerCount();
        await vi.advanceTimersByTimeAsync(CONTROLLED_NODE_UPGRADE_BACKLOG_PASS_DELAY_MS * 3);
        // only the hourly interval remains: no follow-up chain is left running
        expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);
      } finally {
        vi.useRealTimers();
      }
    }, 60_000);
  });

  it('uses a streaming directory iterator rather than eagerly materializing Windows Temp', async () => {
    const source = await readFile(join(process.cwd(), 'src/node/self-upgrade.ts'), 'utf8');
    expect(source).toContain('const directory = await opendir(canonicalRoot)');
    expect(source).toContain('for await (const entry of directory)');
    expect(source).not.toMatch(/await readdir\((?:tempRoot|canonicalRoot)/);
  });

  it('deletes at most 32 fully-qualified stale candidates per upgrade attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-delete-bound-'));
    dirs.push(root);
    const now = Date.now();
    const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
    for (let index = 0; index < 40; index += 1) {
      await createOwnedUpgradeDir({ root, suffix: `stale${String(index).padStart(2, '0')}`, createdAt: old });
    }
    const operations: string[] = [];
    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      isProcessAlive: () => false,
      onStaleScavengeOperation: (operation) => operations.push(operation),
    });
    expect(removed).toBe(32);
    expect(operations.filter((operation) => operation === 'delete')).toHaveLength(32);
    expect(await readdir(root)).toHaveLength(8);
  });

  it('counts failed stale removals against the 32-attempt budget and continues the upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-failed-delete-bound-'));
    dirs.push(root);
    const now = Date.now();
    const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
    for (let index = 0; index < 40; index += 1) {
      await createOwnedUpgradeDir({ root, suffix: `failed${String(index).padStart(2, '0')}`, createdAt: old });
    }
    const operations = { enumerate: 0, lstat: 0, marker_read: 0, delete: 0 };
    const diagnostics: Array<{ outcome: string; code: string }> = [];
    let removeCalls = 0;
    const scheduleWindowsUpgrade = vi.fn();
    const result = await startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: createWindowsUpgradeFetch(),
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => root,
      now: () => now,
      isProcessAlive: () => false,
      removeUpgradeDir: async () => {
        removeCalls += 1;
        const error = new Error('unbounded private filesystem detail') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
      onStaleScavengeOperation: (operation) => { operations[operation] += 1; },
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      scheduleWindowsUpgrade,
    });

    expect(result.ok).toBe(true);
    expect(scheduleWindowsUpgrade).toHaveBeenCalledOnce();
    expect(removeCalls).toBe(32);
    expect(operations.delete).toBe(32);
    expect(operations.enumerate).toBeLessThanOrEqual(128);
    expect(operations.lstat).toBeLessThanOrEqual(128);
    expect(operations.marker_read).toBeLessThanOrEqual(64);
    expect(diagnostics.filter((diagnostic) => diagnostic.outcome === 'failed')).toEqual(Array.from({ length: 32 }, () => expect.objectContaining({
      outcome: 'failed',
      code: 'ENOSPC',
    })));
    expect(diagnostics).toContainEqual(expect.objectContaining({ outcome: 'skipped', code: 'budget_exhausted' }));
    expect(JSON.stringify(diagnostics)).not.toContain('unbounded private filesystem detail');
    expect(JSON.stringify(diagnostics)).not.toContain(root);
    expect(await readdir(root)).toHaveLength(41);
  });

  it.each([
    'freshened directory',
    'revived owner',
    'changed marker',
    'replacement reparse point',
  ] as const)('refuses a stale candidate whose %s changes before final adjacent revalidation', async (mutation) => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-scavenge-race-'));
    dirs.push(root);
    const now = Date.now();
    const old = now - CONTROLLED_NODE_UPGRADE_STALE_AFTER_MS - 60_000;
    const candidate = await createOwnedUpgradeDir({ root, suffix: 'racing1', createdAt: old });
    const external = join(root, 'external-race-target');
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'keep');
    let livenessChecks = 0;
    const removed = await scavengeStaleControlledNodeUpgradeDirs(root, {
      now: () => now,
      uptime: () => 30 * 24 * 60 * 60,
      isProcessAlive: () => {
        livenessChecks += 1;
        return mutation === 'revived owner' && livenessChecks > 1;
      },
      beforeStaleCandidateRevalidation: async (candidatePath) => {
        expect(candidatePath).toBe(candidate);
        if (mutation === 'freshened directory') {
          const fresh = new Date(now);
          await utimes(candidate, fresh, fresh);
        } else if (mutation === 'changed marker') {
          const markerPath = join(candidate, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
          const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { ownerToken: string };
          marker.ownerToken = '87654321-4321-4432-8432-cba987654321';
          await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
          const oldTime = new Date(old);
          await utimes(markerPath, oldTime, oldTime);
        } else if (mutation === 'replacement reparse point') {
          await rm(candidate, { recursive: true, force: true });
          await symlink(external, candidate, 'dir');
        }
      },
    });
    expect(removed).toBe(0);
    if (mutation === 'replacement reparse point') {
      expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    } else {
      expect(await readdir(candidate)).toContain(CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
    }
  });

  it('rejects an artifact whose embedded version cannot satisfy the requested upgrade', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-version-'));
    dirs.push(dir);
    const bytes = Buffer.from('wrong-version-artifact');
    const spawned = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.2', {
      fetchImpl: (async (url: string) => {
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        return new Response(bytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      spawnDetached: spawned,
    })).rejects.toThrow(/artifact_version_mismatch/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('rejects a Windows upgrade when the server omits the release signer binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-signer-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('signed artifact without signer metadata');
    const scheduleWindowsUpgrade = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async (url: string) => {
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        return new Response(bytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      scheduleWindowsUpgrade,
    })).rejects.toThrow('missing_artifact_authenticode_signer_sha256');
    expect(scheduleWindowsUpgrade).not.toHaveBeenCalled();
  });

  it('quotes PowerShell paths and applies executable/helper ACLs', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: "C:\\tmp\\it's\\imcodes-node.exe",
      stagedManifestPath: 'C:\\tmp\\imcodes-node.exe.manifest.json',
      stagedJournalPath: 'C:\\tmp\\install-journal.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      destinationJournalPath: 'C:\\ProgramData\\imcodes-node\\install-journal.json',
    });
    expect(script).toContain("'C:\\tmp\\it''s\\imcodes-node.exe'");
    expect(script).toContain('*S-1-5-18:F');
    expect(script).toContain('*S-1-5-11:RX');
    expect(script).toContain('computer-use-helper');
  });

  it('atomically installs the remote desktop worker in its win32-x64 platform directory', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\tmp\\imcodes-node.exe',
      stagedManifestPath: 'C:\\tmp\\imcodes-node.exe.manifest.json',
      stagedRemoteDesktopWorkerDir: 'C:\\tmp\\remote-desktop-worker',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      upgradeTaskName: 'imcodes-node-upgrade-test',
    });
    expect(script).toContain("$srcRemoteDesktop = 'C:\\tmp\\remote-desktop-worker'");
    expect(script).toContain("$dstRemoteDesktop = 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker'");
    expect(script).toContain('remote-desktop-worker\\win32-x64\\imcodes-remote-desktop-worker.exe');
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe');
    expect(script).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'");
    expect(script).toContain('Import-Module -Name $securityModulePath -ErrorAction Stop');
    expect(script).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'");
    expect(script).toContain('Import-Module -Name $utilityModulePath -ErrorAction Stop');
    expect(script.indexOf('Import-Module -Name $utilityModulePath -ErrorAction Stop'))
      .toBeLessThan(script.indexOf('$srcHash = (Get-FileHash'));
    expect(script.indexOf('Import-Module -Name $securityModulePath -ErrorAction Stop'))
      .toBeLessThan(script.indexOf('Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe'));
    expect(script).toContain('[System.Management.Automation.SignatureStatus]::Valid');
    expect(script).toContain('remote desktop worker signer mismatch');
    expect(script).toContain('authenticodeSignerSha256');
    expect(script).toContain('THIRD_PARTY_NOTICES.webrtc.md');
    expect(script.indexOf('remote desktop worker Authenticode verification failed'))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script).toContain('remote desktop copied artifact hash mismatch');
    expect(script).toContain('remote desktop worker signer is not trusted by this controlled node build');
    expect(script).toContain('remote desktop artifact root contains unexpected entries');
    expect(script).toContain('virtual display package contains unexpected entries');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop');
    expect(script.indexOf('& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop'))
      .toBeLessThan(script.indexOf('Move-Item -Force $pendingRemoteDesktop $dstRemoteDesktop'));
    expect(script.indexOf('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop'))
      .toBeLessThan(script.indexOf('/add-driver $virtualDisplayInf /install'));
    expect(script.indexOf("'System32\\icacls.exe') 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker.new' '/inheritance:r'"))
      .toBeLessThan(script.indexOf("Copy-Item -Recurse -Force -Path (Join-Path $srcRemoteDesktop '*')"));
    expect(script).toContain("if ($aclExitCode -ne 0) { throw 'Windows ACL hardening failed' }");
    expect(script).toContain('controlled node release manifest does not match the staged executable');
    expect(script).toContain('controlled node published manifest hash mismatch');
    expect(script).toContain('$dstRemoteDesktop.upgrade-old');
    expect(script).toContain('controlled node upgrade failed authenticated health verification');
    expect(script).toContain("status = 'success'");
    expect(script).toContain("{ 'rolled_back' } else { 'rollback_failed' }");
    expect(script).toContain("status = 'preflight_failed'");
    expect(script).not.toContain('$verifyLegacyUnsignedArtifact');
    expect(script).toContain("$currentMainHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant()");
    expect(script).toContain('controlled node rollback source hash mismatch');
    expect(script.indexOf('& $verifyReleaseArtifact $src'))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script.indexOf("Unregister-ScheduledTask -TaskName 'imcodes-node-upgrade-test'"))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script).toContain('if ($failureMessage.Length -gt 240)');
    expect(script).toContain('[int64]$lease.updatedAt -ge $StartedAtMs');
    expect(script).toContain('Wait-IMCodesNodeHealthy -LeasePath $healthLease -NodePath $dst -StartedAtMs $upgradeStartedAt');
    expect(script).toContain('if ($remoteDesktopPublished -and (Test-Path $dstRemoteDesktop))');
    expect(script).toContain('Move-Item -Force $backupRemoteDesktop $dstRemoteDesktop');
    expect(script).toContain("Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf'");
    expect(script).toContain("[string]$_.ProviderName -ceq 'IM.codes'");
    expect(script).toContain('$newVirtualDisplayDrivers.Count -gt 1');
    expect(script).toContain('$driverInstallExitCode -ne 3010');
    expect(script).toContain("& $runRecovery 'restore_main'");
    expect(script).toContain("& $runRecovery 'restore_driver'");
    expect(script).toContain('controlled node interrupted upgrade has no trusted publication base');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash');
    expect(script).toContain("status = $rollbackStatus");
    expect(script).toContain("'rollback_failed'");
    expect(script).toContain("-cmatch '^oem[0-9]+\\.inf$'");
    expect(script).toContain('/delete-driver ([string]$newVirtualDisplayDriver.Driver) /uninstall /force');
    expect(script.indexOf('/delete-driver ([string]$newVirtualDisplayDriver.Driver)'))
      .toBeLessThan(script.indexOf('/add-driver $rollbackVirtualDisplayInf /install'));
  });

  it('escapes the one-shot upgrade script path in Task Scheduler XML', () => {
    const xml = windowsControlledNodeUpgradeTaskXml('C:\\Windows\\Temp\\a&b<1>\\upgrade.ps1');
    expect(xml).toContain('a&amp;b&lt;1&gt;');
    expect(xml).toContain('<BootTrigger><Enabled>true</Enabled></BootTrigger>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<AllowHardTerminate>false</AllowHardTerminate>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>');
  });

  it('registers and starts the one-shot task, deleting it if start fails', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    scheduleWindowsControlledNodeUpgrade('upgrade-ok', 'C:\\tmp\\upgrade.xml', (file, args) => {
      calls.push({ file, args });
    });
    expect(calls).toEqual([
      { file: 'schtasks.exe', args: ['/Create', '/TN', 'upgrade-ok', '/XML', 'C:\\tmp\\upgrade.xml', '/F'] },
      { file: 'schtasks.exe', args: ['/Run', '/TN', 'upgrade-ok'] },
    ]);

    const failedCalls: Array<{ file: string; args: readonly string[] }> = [];
    expect(() => scheduleWindowsControlledNodeUpgrade('upgrade-fail', 'C:\\tmp\\upgrade.xml', (file, args) => {
      failedCalls.push({ file, args });
      if (args[0] === '/Run') throw new Error('run failed');
    })).toThrow('run failed');
    expect(failedCalls.at(-1)).toEqual({
      file: 'schtasks.exe',
      args: ['/Delete', '/TN', 'upgrade-fail', '/F'],
    });

    const cleanupFailures: unknown[] = [];
    expect(() => scheduleWindowsControlledNodeUpgrade('upgrade-fail-delete', 'C:\\tmp\\upgrade.xml', (_file, args) => {
      if (args[0] === '/Run') throw new Error('authoritative run failure');
      if (args[0] === '/Delete') {
        const error = new Error('task cleanup failed') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
    }, (error) => cleanupFailures.push(error))).toThrow('authoritative run failure');
    expect(cleanupFailures).toHaveLength(1);
    expect((cleanupFailures[0] as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('starts Linux replacement in a transient unit outside the node service cgroup', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    scheduleLinuxControlledNodeUpgrade('imcodes-node-upgrade-test', '/tmp/upgrade.sh', (file, args) => {
      calls.push({ file, args });
    });
    expect(calls).toEqual([{
      file: 'systemd-run',
      args: [
        '--unit=imcodes-node-upgrade-test',
        '--collect',
        '--no-block',
        '--property=Type=oneshot',
        // the script hosts the whole health window (15 min cap) plus a rollback
        '--property=TimeoutStartSec=25min',
        '--property=TimeoutStopSec=5min',
        '/bin/sh',
        '/tmp/upgrade.sh',
      ],
    }]);
  });

  it.each([
    ['linux', 'systemctl stop imcodes-node.service', 'systemctl start imcodes-node.service'],
    ['darwin', 'launchctl bootout system/cc.imcodes.node', "launchctl bootstrap system '/Library/LaunchDaemons/cc.imcodes.node.plist'"],
  ] as const)('builds a detached %s upgrader that replaces the binary before restarting the boot service', (platform, stop, start) => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform,
      stagedArtifactPath: `/tmp/update-${platform}/imcodes-node`,
      stagedManifestPath: `/tmp/update-${platform}/imcodes-node.manifest.json`,
      stagedJournalPath: `/tmp/update-${platform}/install-journal.json`,
      destinationPath: '/opt/imcodes-node/imcodes-node',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node.manifest.json',
      destinationJournalPath: '/opt/imcodes-node/install-journal.json',
    });
    expect(script).toContain(stop);
    expect(script).toContain(start);
    expect(script).toContain(`IMCODES_SRC='/tmp/update-${platform}/imcodes-node'`);

    // The destination MUST be published by rename(2), never overwritten in
    // place: `cp -f` rewrites the existing inode, and macOS binds code-signing
    // state to it, so an in-place overwrite of the still-mapped running node
    // leaves bytes that no longer match the validated signature — every exec is
    // then SIGKILLed (OS_REASON_CODESIGNING) and launchd respawns forever.
    expect(script).toContain(`IMCODES_PENDING='/opt/imcodes-node/imcodes-node.new'`);
    expect(script).toContain('mv -f "$IMCODES_PENDING" "$IMCODES_DST"');
    expect(script).toContain('cp -f "$IMCODES_SRC" "$IMCODES_PENDING"');
    // The live binary is never a `cp` target.
    expect(script).not.toMatch(/cp -f [^\n]*"\$IMCODES_DST"( |$)/m);
    // chmod applies to the pending file, before it is published.
    expect(script).toContain('chmod 755 "$IMCODES_PENDING"');
    expect(script.indexOf('chmod 755 "$IMCODES_PENDING"')).toBeLessThan(script.indexOf('mv -f "$IMCODES_PENDING" "$IMCODES_DST"'));
    // The manifest must not vouch for a binary that never got published.
    expect(script.indexOf('mv -f "$IMCODES_PENDING" "$IMCODES_DST"')).toBeLessThan(script.indexOf('mv -f "$IMCODES_DST_MANIFEST_NEW" "$IMCODES_DST_MANIFEST"'));
    // A transaction: backup, health wait, rollback, durable result.
    expect(script).toContain('imcodes_wait_node_healthy');
    expect(script).toContain('imcodes_rollback');
    expect(script).toContain('last-upgrade-result.json');
    if (platform === 'darwin') {
      expect(script).toContain('launchctl bootout system/cc.imcodes.node.watchdog');
      expect(script).toContain("launchctl bootstrap system '/Library/LaunchDaemons/cc.imcodes.node.watchdog.plist'");
      expect(script.indexOf('bootout system/cc.imcodes.node.watchdog'))
        .toBeLessThan(script.indexOf('bootout system/cc.imcodes.node;'));
    }
  });

  it('binds POSIX staging cleanup to the owned marker and runs it on exit', () => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform: 'linux',
      stagedArtifactPath: '/tmp/imcodes-node-upgrade-abcd12/imcodes-node',
      stagedManifestPath: '/tmp/imcodes-node-upgrade-abcd12/imcodes-node.manifest.json',
      destinationPath: '/opt/imcodes-node/imcodes-node',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node.manifest.json',
      stagingOwnership: {
        directoryPath: '/tmp/imcodes-node-upgrade-abcd12',
        markerPath: '/tmp/imcodes-node-upgrade-abcd12/.imcodes-controlled-node-upgrade.json',
        ownerToken: '12345678-1234-4123-8123-123456789abc',
      },
    });
    expect(script).toContain('trap cleanup_staging EXIT');
    expect(script).toContain('"product":"imcodes-controlled-node-upgrade"');
    expect(script).toContain('"ownerToken":"12345678-1234-4123-8123-123456789abc"');
    expect(script).toContain('rm -rf --');
    expect(script).toContain('! -L');
  });

  it.runIf(process.platform === 'linux')('executes POSIX cleanup only for the exact owned marker and refuses symlinks', async () => {
    const runCase = async (name: string, markerToken: string, shape: 'valid' | 'dir-symlink' | 'marker-symlink'): Promise<boolean> => {
      const root = await mkdtemp(join(tmpdir(), `imcodes-posix-cleanup-${name}-`));
      dirs.push(root);
      const stage = join(root, 'imcodes-node-upgrade-abcd12');
      const destinationPath = join(root, 'installed-node');
      const destinationManifestPath = `${destinationPath}.manifest.json`;
      const stagedArtifactPath = join(stage, 'imcodes-node');
      const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
      await mkdir(stage, { recursive: true });
      await writeFile(stagedArtifactPath, 'new', { mode: 0o755 });
      await writeFile(stagedManifestPath, JSON.stringify({ build: { version: 'test' } }));
      await writeFile(destinationPath, 'old', { mode: 0o755 });
      await writeFile(join(stage, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), JSON.stringify({
        schemaVersion: 1,
        product: 'imcodes-controlled-node-upgrade',
        directoryName: 'imcodes-node-upgrade-abcd12',
        ownerToken: markerToken,
        createdAt: Date.now(),
        pid: process.pid,
      }));
      const markerPath = join(stage, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER);
      if (shape === 'dir-symlink') {
        const target = join(root, 'real-stage');
        await rm(stage, { recursive: true, force: true });
        await mkdir(target);
        await symlink(target, stage, 'dir');
      } else if (shape === 'marker-symlink') {
        const target = join(root, 'real-marker.json');
        await writeFile(target, JSON.stringify({
          product: 'imcodes-controlled-node-upgrade',
          directoryName: basename(stage),
          ownerToken: markerToken,
          createdAt: new Date().toISOString(),
          pid: process.pid,
        }));
        await rm(markerPath);
        await symlink(target, markerPath, 'file');
      }
      const binDir = join(root, 'bin');
      await mkdir(binDir);
      await installHealthyServiceStubs(binDir, join(root, 'health-lease.json'));
      const scriptPath = join(root, 'upgrade.sh');
      await writeFile(scriptPath, buildPosixControlledNodeUpgradeScript({
        platform: 'linux', stagedArtifactPath, stagedManifestPath, destinationPath, destinationManifestPath,
        stagingOwnership: { directoryPath: stage, markerPath, ownerToken: '12345678-1234-4123-8123-123456789abc' },
      }), { mode: 0o755 });
      // a symlinked staging directory leaves no artifact to install: the script ends in preflight (non-zero) and still runs its cleanup trap
      await execFileAsync('/bin/sh', [scriptPath], { timeout: 15_000, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` } }).catch(() => undefined);
      try { await lstat(stage); return true; } catch { return false; }
    };
    expect(await runCase('valid', '12345678-1234-4123-8123-123456789abc', 'valid')).toBe(false);
    expect(await runCase('wrong-token', 'abcdefab-cdef-4abc-8def-abcdefabcdef', 'valid')).toBe(true);
    expect(await runCase('dir-link', '12345678-1234-4123-8123-123456789abc', 'dir-symlink')).toBe(true);
    expect(await runCase('marker-link', '12345678-1234-4123-8123-123456789abc', 'marker-symlink')).toBe(true);
  });

  it('refuses to publish a macOS binary the kernel would kill, and leaves the old one intact', () => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform: 'darwin',
      stagedArtifactPath: '/tmp/stage/imcodes-node-macos',
      stagedManifestPath: '/tmp/stage/imcodes-node-macos.manifest.json',
      destinationPath: '/opt/imcodes-node/imcodes-node-macos',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node-macos.manifest.json',
    });
    // Verify BEFORE the rename, so a bad artifact never becomes the live binary.
    expect(script).toContain('codesign --verify "$IMCODES_PENDING"');
    expect(script).toContain("grep -q 'Mach-O'");
    expect(script.indexOf('codesign --verify')).toBeLessThan(script.indexOf('mv -f "$IMCODES_PENDING"'));
    // A failed verify ends in preflight, before the service is stopped: the old
    // node keeps running and nothing live was replaced.
    expect(script).toContain('rm -f -- "$IMCODES_PENDING"; return 1');
    expect(script.indexOf('codesign --verify')).toBeLessThan(script.indexOf('imcodes_service_stop\n'));
    expect(script).toContain('launchctl bootstrap system');
  });

  it('does not gate the linux upgrade on codesign (macOS-only tool)', () => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform: 'linux',
      stagedArtifactPath: '/tmp/stage/imcodes-node-linux',
      stagedManifestPath: '/tmp/stage/imcodes-node-linux.manifest.json',
      destinationPath: '/opt/imcodes-node/imcodes-node-linux',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node-linux.manifest.json',
    });
    expect(script).not.toContain('codesign');
    // rename(2) still matters on linux: writing a running binary fails ETXTBSY,
    // which `set +e` would otherwise swallow into a silently skipped upgrade.
    expect(script).toContain(`IMCODES_PENDING='/opt/imcodes-node/imcodes-node-linux.new'`);
    expect(script).toContain('mv -f "$IMCODES_PENDING" "$IMCODES_DST"');
  });

  it.runIf(['win32', 'darwin', 'linux'].includes(process.platform))('executes the native replacement script against an isolated destination and service-manager stub', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-native-upgrade-script-'));
    dirs.push(dir);
    const stagedArtifactPath = join(dir, process.platform === 'win32' ? 'staged-node.exe' : 'staged-node');
    const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
    const destinationPath = join(dir, process.platform === 'win32' ? 'installed-node.exe' : 'installed-node');
    const destinationManifestPath = `${destinationPath}.manifest.json`;
    const logPath = join(dir, 'service.log');
    await writeFile(stagedArtifactPath, 'new-native-artifact', { mode: 0o755 });
    await writeFile(stagedManifestPath, JSON.stringify({ build: { version: '2026.7.9999-dev.42' } }));
    await writeFile(destinationPath, 'old-native-artifact', { mode: 0o755 });

    if (process.platform === 'win32') {
      const generated = buildWindowsControlledNodeUpgradeScript({
        stagedArtifactPath,
        stagedManifestPath,
        destinationPath,
        destinationManifestPath,
      });
      const harnessPath = join(dir, 'upgrade-harness.ps1');
      const quotedLog = logPath.replaceAll("'", "''");
      await writeFile(harnessPath, [
        `function Start-Sleep { param([int]$Seconds) }`,
        `function Stop-ScheduledTask { param($TaskName, $ErrorAction); Add-Content -LiteralPath '${quotedLog}' -Value "stop:$TaskName" }`,
        `function Enable-ScheduledTask { param($TaskName, $ErrorAction); Add-Content -LiteralPath '${quotedLog}' -Value "enable:$TaskName" }`,
        `function Start-ScheduledTask { param($TaskName); Add-Content -LiteralPath '${quotedLog}' -Value "start:$TaskName" }`,
        'function Get-CimInstance { param($ClassName, $Filter); @() }',
        generated,
      ].join('\r\n'));
      const lockHolder = await holdWindowsFileLock(destinationPath, dir, 1500);
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], { timeout: 30_000 });
        if (lockHolder.exitCode === null) await once(lockHolder, 'exit');
      } finally {
        if (lockHolder.exitCode === null) lockHolder.kill();
      }
    } else {
      const binDir = join(dir, 'bin');
      await mkdir(binDir);
      await installHealthyServiceStubs(binDir, join(dir, 'health-lease.json'));
      const scriptPath = join(dir, 'upgrade.sh');
      await writeFile(scriptPath, buildPosixControlledNodeUpgradeScript({
        platform: process.platform,
        stagedArtifactPath,
        stagedManifestPath,
        destinationPath,
        destinationManifestPath,
      }), { mode: 0o755 });
      await execFileAsync('/bin/sh', [scriptPath], {
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          IMCODES_UPGRADE_TEST_LOG: logPath,
        },
      });
    }

    expect(await readFile(destinationPath, 'utf8')).toBe('new-native-artifact');
    expect(JSON.parse(await readFile(destinationManifestPath, 'utf8'))).toMatchObject({
      build: { version: '2026.7.9999-dev.42' },
    });
    const serviceLog = await readFile(logPath, 'utf8');
    if (process.platform === 'darwin') {
      expect(serviceLog).toContain('bootout system/cc.imcodes.node.watchdog');
      expect(serviceLog).toContain('bootout system/cc.imcodes.node');
      expect(serviceLog).toContain('bootstrap system /Library/LaunchDaemons/cc.imcodes.node.plist');
      expect(serviceLog).toContain('bootstrap system /Library/LaunchDaemons/cc.imcodes.node.watchdog.plist');
    } else {
      expect(serviceLog).toContain('stop');
      expect(serviceLog).toContain('start');
    }
  });

  it('keeps the previous POSIX remote-desktop worker, and replaces nothing, when the staged copy fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-worker-copy-rollback-'));
    dirs.push(root);
    const stage = join(root, 'stage', REMOTE_DESKTOP_WORKER_SIDECAR_DIR);
    const destinationRoot = join(root, 'installed', REMOTE_DESKTOP_WORKER_SIDECAR_DIR);
    const destinationWorker = join(destinationRoot, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
    const stagedArtifactPath = join(root, 'stage', 'imcodes-node');
    const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
    const destinationPath = join(root, 'installed', 'imcodes-node');
    const destinationManifestPath = `${destinationPath}.manifest.json`;
    const binDir = join(root, 'bin');
    await mkdir(join(stage, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR), { recursive: true });
    await mkdir(join(destinationRoot, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(stage, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR, REMOTE_DESKTOP_LINUX_WORKER_FILENAME), 'new-worker');
    await writeFile(join(stage, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR, `${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`), '{}');
    await writeFile(stagedArtifactPath, 'new-node', { mode: 0o755 });
    await writeFile(stagedManifestPath, JSON.stringify({ build: { version: 'new' } }));
    await writeFile(destinationWorker, 'old-worker', { mode: 0o755 });
    await writeFile(destinationPath, 'old-node', { mode: 0o755 });
    await installHealthyServiceStubs(binDir, join(root, 'installed', 'health-lease.json'));
    // Fail only for the remote-desktop worker copy. The release is one publication
    // unit: the failure now ends the upgrade in preflight, before the service is
    // stopped, so the old node, manifest and worker all stay in place.
    await writeFile(join(binDir, 'cp'), [
      '#!/bin/sh',
      'for arg in "$@"; do case "$arg" in *remote-desktop-worker*) exit 1;; esac; done',
      'exec /bin/cp "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const scriptPath = join(root, 'upgrade.sh');
    await writeFile(scriptPath, buildPosixControlledNodeUpgradeScript({
      platform: 'linux',
      stagedArtifactPath,
      stagedManifestPath,
      destinationPath,
      destinationManifestPath,
      stagedRemoteDesktopWorkerDir: stage,
    }), { mode: 0o755 });
    // exits non-zero: the preflight failure is the upgrade's outcome
    await expect(execFileAsync('/bin/sh', [scriptPath], {
      timeout: 15_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })).rejects.toMatchObject({ code: 1 });
    expect(await readFile(destinationWorker, 'utf8')).toBe('old-worker');
    expect(await readFile(destinationPath, 'utf8')).toBe('old-node');
    expect(JSON.parse(await readFile(join(root, 'installed', 'last-upgrade-result.json'), 'utf8'))).toMatchObject({ status: 'preflight_failed' });
    await expect(lstat(`${destinationRoot}.new`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${destinationRoot}.previous`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'linux')('a Linux upgrade whose worker is staged exactly as the node downloads it publishes the worker where the installed node looks for it', async () => {
    // The production flow end to end: the real downloader stages the worker, the real script builder gets the directory the
    // upgrade hands it, the generated script runs under sh. A check one directory too high ("artifact set is incomplete")
    // failed every Linux self-upgrade while each piece passed its own test with a hand-made flat layout.
    const root = await mkdtemp(join(tmpdir(), 'imcodes-linux-worker-e2e-'));
    dirs.push(root);
    const installed = join(root, 'installed');
    const binDir = join(root, 'bin');
    await mkdir(installed, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    const execPath = join(installed, 'imcodes-node-linux');
    const journalPath = join(installed, 'install-journal.json');
    await writeFile(execPath, 'old-node', { mode: 0o755 });
    await writeFile(`${execPath}.manifest.json`, JSON.stringify({ build: { version: 'old' } }));
    const oldWorkerDir = join(installed, REMOTE_DESKTOP_WORKER_SIDECAR_DIR, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR);
    await mkdir(oldWorkerDir, { recursive: true });
    await writeFile(join(oldWorkerDir, REMOTE_DESKTOP_LINUX_WORKER_FILENAME), 'old-worker', { mode: 0o755 });

    const version = '2026.10.5516-dev.5968';
    const main = Buffer.from('new controlled node');
    const worker = Buffer.from('new linux worker');
    const workerManifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      artifact: {
        fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME, os: 'linux', arch: 'x64',
        size: worker.length, sha256: createHash('sha256').update(worker).digest('hex'),
      },
      build: { source: 'ci', version },
    }));
    const fetchImpl = (async (url: string) => {
      if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
      const isManifest = url.includes('asset=remote-desktop-worker-manifest');
      const isWorker = !isManifest && url.includes('asset=remote-desktop-worker');
      const body = isManifest ? workerManifest : isWorker ? worker : main;
      return new Response(body, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isManifest
            ? `${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
            : isWorker ? REMOTE_DESKTOP_LINUX_WORKER_FILENAME : 'imcodes-node-linux',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
        },
      });
    }) as unknown as typeof fetch;
    let scriptToRun = '';
    const result = await startControlledNodeSelfUpgrade(credential, version, {
      fetchImpl,
      platform: 'linux',
      arch: 'x64',
      execPath,
      journalPath,
      tmpdir: () => join(root, 'tmp'),
      now: () => 9,
      scheduleLinuxUpgrade: (_name, scriptPath) => { scriptToRun = scriptPath; },
    });
    expect(result).toMatchObject({ ok: true, targetVersion: version });
    expect(scriptToRun).not.toBe('');

    await installHealthyServiceStubs(binDir, join(installed, 'health-lease.json'));
    await execFileAsync('/bin/sh', [scriptToRun], {
      timeout: 30_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, IMCODES_UPGRADE_TEST_LOG: join(root, 'service.log') },
    });
    expect(JSON.parse(await readFile(join(installed, 'last-upgrade-result.json'), 'utf8'))).toMatchObject({ status: 'success' });
    expect(await readFile(execPath, 'utf8')).toBe('new controlled node');
    // exactly the path the installed node resolves its worker from
    const { resolveLinuxRemoteDesktopWorkerPath } = await import('../../src/node/linux-remote-desktop-worker-host.js');
    const resolved = resolveLinuxRemoteDesktopWorkerPath(execPath);
    expect(await readFile(resolved, 'utf8')).toBe('new linux worker');
    expect((await lstat(resolved)).mode & 0o111).not.toBe(0);
    expect(await readFile(`${resolved}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`, 'utf8')).toBe(workerManifest.toString());
  });

  it('a macOS upgrade stages no worker sidecar and its script does not check for one (its components arrive through their own bootstrap)', async () => {
    // The Linux preflight looked for the staged worker one directory too high. macOS is the other POSIX user of the same
    // script builder: it must neither request the Linux/Windows worker assets nor carry any worker staging step.
    const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-no-worker-'));
    dirs.push(root);
    await mkdir(join(root, 'tmp'), { recursive: true });
    const installed = join(root, 'installed');
    await mkdir(installed, { recursive: true });
    const requested: string[] = [];
    const main = Buffer.from('new macos node');
    let scriptToRun = '';
    const result = await startControlledNodeSelfUpgrade(credential, '2026.10.5516-dev.5968', {
      fetchImpl: (async (url: string) => {
        requested.push(url);
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        return new Response(main, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(main).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(main.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node-macos',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.10.5516-dev.5968',
          },
        });
      }) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      execPath: join(installed, 'imcodes-node-macos'),
      journalPath: join(installed, 'install-journal.json'),
      tmpdir: () => join(root, 'tmp'),
      spawnDetached: (_file, args) => { scriptToRun = String(args[0]); },
    });
    expect(result).toMatchObject({ ok: true });
    expect(requested.filter((url) => url.includes('remote-desktop'))).toEqual([]);
    const script = await readFile(scriptToRun, 'utf8');
    expect(script).not.toContain('staged remote desktop worker');
  });

  it.runIf(process.platform === 'linux')('executes POSIX cleanup and removes the owned staging directory after handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-native-upgrade-staging-cleanup-'));
    dirs.push(root);
    const stage = join(root, 'imcodes-node-upgrade-abcd12');
    const stagedArtifactPath = join(stage, 'imcodes-node');
    const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
    const destinationPath = join(root, 'installed-node');
    const destinationManifestPath = `${destinationPath}.manifest.json`;
    const binDir = join(root, 'bin');
    await mkdir(stage, { recursive: true });
    await mkdir(binDir);
    await installHealthyServiceStubs(binDir, join(root, 'health-lease.json'));
    await writeFile(stagedArtifactPath, 'staged-artifact', { mode: 0o755 });
    await writeFile(stagedManifestPath, JSON.stringify({ build: { version: 'test' } }));
    await writeFile(destinationPath, 'old-artifact', { mode: 0o755 });
    await writeFile(join(stage, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER), JSON.stringify({
      schemaVersion: 1,
      product: 'imcodes-controlled-node-upgrade',
      directoryName: 'imcodes-node-upgrade-abcd12',
      ownerToken: '12345678-1234-4123-8123-123456789abc',
      createdAt: Date.now(),
      pid: process.pid,
    }));
    const scriptPath = join(root, 'upgrade.sh');
    await writeFile(scriptPath, buildPosixControlledNodeUpgradeScript({
      platform: 'linux',
      stagedArtifactPath,
      stagedManifestPath,
      destinationPath,
      destinationManifestPath,
      stagingOwnership: {
        directoryPath: stage,
        markerPath: join(stage, CONTROLLED_NODE_UPGRADE_OWNERSHIP_MARKER),
        ownerToken: '12345678-1234-4123-8123-123456789abc',
      },
    }), { mode: 0o755 });
    await execFileAsync('/bin/sh', [scriptPath], {
      timeout: 15_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    expect(await readFile(destinationPath, 'utf8')).toBe('staged-artifact');
    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'win32')('restores after a transient rollback lock and preserves bytes after a permanent lock timeout', async () => {
    const runRollbackLockCase = async (name: string, releaseTimeoutMs: number, lockDurationMs: number) => {
      const dir = await mkdtemp(join(tmpdir(), `imcodes-native-upgrade-rollback-${name}-`));
      dirs.push(dir);
      const destinationPath = join(dir, 'imcodes-node.exe');
      const destinationManifestPath = `${destinationPath}.manifest.json`;
      const backupPath = `${destinationPath}.upgrade-old`;
      const backupManifestPath = `${destinationManifestPath}.upgrade-old`;
      const stagedArtifactPath = join(dir, 'staged-node.exe');
      const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
      const outcomePath = join(dir, 'outcome.json');
      await writeFile(destinationPath, 'new-native-artifact');
      await writeFile(destinationManifestPath, 'new-native-manifest');
      await writeFile(backupPath, 'old-native-artifact');
      await writeFile(backupManifestPath, 'old-native-manifest');

      const generated = buildWindowsControlledNodeUpgradeScript({
        stagedArtifactPath,
        stagedManifestPath,
        destinationPath,
        destinationManifestPath,
      });
      const supportStart = generated.indexOf('$recoveryFailures =');
      const supportSentinel = "  throw 'controlled node executable remained locked after stop'\r\n}\r\n";
      const supportEnd = generated.indexOf(supportSentinel, supportStart) + supportSentinel.length;
      const rollbackStart = generated.indexOf('$rollbackExecutableReleased = [bool]');
      const rollbackEnd = generated.indexOf('$rollbackStatus =', rollbackStart);
      expect(supportStart).toBeGreaterThanOrEqual(0);
      expect(supportEnd).toBeGreaterThan(supportStart);
      expect(rollbackStart).toBeGreaterThan(supportEnd);
      expect(rollbackEnd).toBeGreaterThan(rollbackStart);
      const support = generated.slice(supportStart, supportEnd)
        .replace('param([int]$timeoutMs = 30000)', `param([int]$timeoutMs = ${releaseTimeoutMs})`);
      const rollback = generated.slice(rollbackStart, rollbackEnd);
      const oldHash = createHash('sha256').update('old-native-artifact').digest('hex');
      const oldManifestHash = createHash('sha256').update('old-native-manifest').digest('hex');
      const quote = (value: string): string => value.replaceAll("'", "''");
      const harnessPath = join(dir, 'rollback-lock-harness.ps1');
      await writeFile(harnessPath, [
        "$ErrorActionPreference = 'Stop'",
        `$task = 'imcodes-node'`,
        `$dst = '${quote(destinationPath)}'`,
        `$dstManifest = '${quote(destinationManifestPath)}'`,
        `$backupDst = '${quote(backupPath)}'`,
        `$backupManifest = '${quote(backupManifestPath)}'`,
        `$currentMainHash = '${oldHash}'`,
        `$currentManifestHash = '${oldManifestHash}'`,
        '$mainBackedUp = $true',
        '$mainPublished = $true',
        '$manifestBackedUp = $true',
        '$manifestPublished = $true',
        'function Stop-ScheduledTask { param($TaskName, $ErrorAction) }',
        'function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); @() }',
        support,
        rollback,
        `[pscustomobject]@{ released = $rollbackExecutableReleased; failures = @($recoveryFailures) } | ConvertTo-Json -Compress | Set-Content -LiteralPath '${quote(outcomePath)}' -Encoding utf8`,
      ].join('\r\n'));

      const lockHolder = await holdWindowsFileLock(destinationPath, dir, lockDurationMs);
      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
        ], { timeout: 10_000 });
      } finally {
        if (lockHolder.exitCode === null) lockHolder.kill();
      }
      const outcome = JSON.parse((await readFile(outcomePath, 'utf8')).replace(/^\uFEFF/, '')) as {
        released: boolean;
        failures: string[];
      };
      return {
        outcome,
        executable: await readFile(destinationPath, 'utf8'),
        manifest: await readFile(destinationManifestPath, 'utf8'),
      };
    };

    const transient = await runRollbackLockCase('transient', 3000, 500);
    expect(transient).toEqual({
      outcome: { released: true, failures: [] },
      executable: 'old-native-artifact',
      manifest: 'old-native-manifest',
    });

    const permanent = await runRollbackLockCase('permanent', 250, 1500);
    expect(permanent).toEqual({
      outcome: {
        released: false,
        failures: [
          'stop_new_node: controlled node executable remained locked after stop',
          'restore_artifacts: skipped because the controlled node executable release fence failed',
        ],
      },
      executable: 'new-native-artifact',
      manifest: 'new-native-manifest',
    });
  });
});
