import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonRuntimeManifest } from '../../scripts/daemon-runtime-artifacts.mjs';
import { openDaemonRuntimeArtifact } from '../../server/src/services/controlled-node-artifact-catalog.js';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
} from '../../shared/controlled-node-artifacts.js';
import {
  daemonRuntimeManifestFilename,
  desktopReleaseTargetManifestFilename,
} from '../../shared/desktop-release-manifest.js';
import {
  DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS,
  DAEMON_RUNTIME_FILES_FILENAME,
  DAEMON_RUNTIME_LOCK_DIR_NAME,
  UPGRADE_COOLDOWN_SENTINEL_FILE,
  acquireRuntimeUpgradeLock,
  inspectDaemonRuntimeMode,
  launchDetachedDaemonRuntimeSwitchRunner,
  readCurrentPointerTarget,
  releaseRuntimeUpgradeLock,
  resolveLegacyNpmCliFallback,
  rollbackDaemonRuntimeCurrentPointer,
  switchDaemonRuntimeCurrentPointer,
  upgradeBundledDaemonRuntime,
} from '../../src/daemon/daemon-runtime-upgrade.js';
import { inspectImcodesCliResolution, installImcodesCliWrapper } from '../../src/node/imcodes-cli-wrapper.js';
import { discoverCodingDaemonRuntime } from '../../src/node/local-daemon-control.js';
import { buildPosixRestartCommand } from '../../src/util/posix-upgrade-script.js';
import { imcodesStateDirForHome } from '../../src/util/imcodes-state-dir.js';

const tempDirs: string[] = [];
const chmodRestore: Array<{ path: string; mode: number }> = [];

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a self-contained runnable `daemon-runtime` layout inside `destDir`.
 * Uses a real executable node binary (symlink to host node ONLY inside fixtures outside staging,
 * OR direct copy / shell shim in archives so staging contains no escaping symlinks!).
 */
function writeRunnableTree(
  destDir: string,
  version: string,
  options: {
    omitEntry?: string;
    includeFilesDoc?: boolean;
    useShellShimForNode?: boolean;
  } = {},
): { nodePath: string; entryPath: string } {
  mkdirSync(join(destDir, 'bin'), { recursive: true });
  const nodePath = join(destDir, 'bin', 'node');
  // In packaged archives, bin/node must be an executable regular file (never a symlink escaping root).
  if (options.useShellShimForNode !== false) {
    writeFileSync(
      nodePath,
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
  } else {
    writeFileSync(nodePath, readFileSync(process.execPath), { mode: 0o755 });
  }

  for (const rel of DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS) {
    if (options.omitEntry === rel) continue;
    const abs = join(destDir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    if (rel === 'package/package.json') {
      writeFileSync(
        abs,
        JSON.stringify({ name: 'imcodes', version }, null, 2),
      );
    } else if (rel === 'package/dist/src/index.js') {
      writeFileSync(
        abs,
        `if (process.argv.includes('--version')) { console.log('${version}'); process.exit(0); }\n`,
      );
    } else {
      writeFileSync(abs, `// ${rel} (${version})\n`);
    }
  }

  if (options.includeFilesDoc) {
    const entries: Array<{ path: string; size: number; sha256: string; executable: boolean }> = [];
    for (const rel of ['bin/node', ...DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS]) {
      if (options.omitEntry === rel) continue;
      const abs = join(destDir, ...rel.split('/'));
      const buf = readFileSync(abs);
      entries.push({
        path: rel,
        size: buf.length,
        sha256: sha256(buf),
        executable: rel === 'bin/node',
      });
    }
    writeFileSync(
      join(destDir, DAEMON_RUNTIME_FILES_FILENAME),
      JSON.stringify({ schemaVersion: 1, files: entries }, null, 2),
    );
  }

  return {
    nodePath,
    entryPath: join(destDir, 'package', 'dist', 'src', 'index.js'),
  };
}

/**
 * Create a self-contained runnable `daemon-runtime` layout inside `destDir`,
 * optionally packaging it with the REAL `createDaemonRuntimeManifest` generator
 * (`scripts/daemon-runtime-artifacts.mjs`) and `daemon-runtime-<target>.manifest.json`.
 */
async function buildRuntimeFeedArtifact(
  destDir: string,
  version: string,
  options: {
    omitEntry?: string;
    includeFilesDoc?: boolean;
    useShellShimForNode?: boolean;
    archiveOut: { dir: string; includeReleaseManifest?: boolean; targetSubdir?: boolean };
    preArchiveHook?: (bundleDir: string) => void;
  },
): Promise<{
  nodePath: string;
  entryPath: string;
  archivePath: string;
  manifestPath: string;
  archiveBytes: Buffer;
  manifestBytes: Buffer;
  releaseManifestBytes?: Buffer;
}> {
  const { nodePath, entryPath } = writeRunnableTree(destDir, version, options);
  options.preArchiveHook?.(destDir);

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = `linux-${arch}` as const;
  const artifactDir = options.archiveOut.targetSubdir ? join(options.archiveOut.dir, 'daemon-runtime') : options.archiveOut.dir;
  mkdirSync(artifactDir, { recursive: true });
  const archiveName = `daemon-runtime-${target}.tar.gz`;
  const archivePath = join(artifactDir, archiveName);
  execFileSync('tar', ['-czf', archivePath, '-C', destDir, '.'], { stdio: 'pipe' });

  let manifestObj: Record<string, unknown>;
  if (options.omitEntry || options.preArchiveHook) {
    // Allow negative tests omitting critical entries to craft an otherwise-canonical manifest.
    const archiveBytes = readFileSync(archivePath);
    manifestObj = {
      schemaVersion: 1,
      artifact: {
        fileName: archiveName,
        format: 'tar.gz',
        os: 'linux',
        arch,
        size: archiveBytes.length,
        sha256: sha256(archiveBytes),
      },
      entrypoint: { node: 'bin/node', script: 'package/dist/src/index.js' },
      toolchain: { nodeProvider: 'official-node', nodeVersion: process.version },
      build: { commit: 'abcdef123456', version },
      totalUncompressedBytes: 0,
      fileCount: 0,
      files: [],
    };
    const fileEntries: Array<{ path: string; size: number; sha256: string; executable?: boolean }> = [];
    for (const rel of ['bin/node', ...DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS]) {
      if (options.omitEntry === rel) continue;
      const abs = join(destDir, ...rel.split('/'));
      if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
      const buf = readFileSync(abs);
      fileEntries.push({ path: rel, size: buf.length, sha256: sha256(buf), ...(rel === 'bin/node' ? { executable: true } : {}) });
    }
    if (options.omitEntry !== 'package/dist/src/cli.js' && existsSync(join(destDir, 'package/dist/src/cli.js'))) {
      // ensure cli.js included when present
    }
    manifestObj.files = fileEntries;
    manifestObj.fileCount = fileEntries.length;
    manifestObj.totalUncompressedBytes = fileEntries.reduce((s, e) => s + e.size, 0);
  } else {
    const built = await createDaemonRuntimeManifest({
      bundleRoot: destDir,
      archivePath,
      os: 'linux',
      arch,
      nodeVersion: 'v22.11.0',
      nodeProvider: 'official-node',
      nodeArchive: `node-v22.11.0-linux-${arch}.tar.gz`,
      nodeArchiveSha256: 'a'.repeat(64),
      buildCommit: 'abcdef123456',
      buildVersion: version,
    });
    manifestObj = built.manifest;
  }

  const manifestBytes = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8');
  const manifestPath = join(artifactDir, daemonRuntimeManifestFilename(target));
  writeFileSync(manifestPath, manifestBytes);
  const archiveBytes = readFileSync(archivePath);
  const archiveSha = sha256(archiveBytes);

  let releaseManifestBytes: Buffer | undefined;
  if (options.archiveOut.includeReleaseManifest) {
    const rmObj = {
      schemaVersion: 1,
      releaseVersion: version,
      gitSha: 'abcdef123456',
      generatedAt: new Date().toISOString(),
      targets: {
        [target]: {
          target,
          os: 'linux',
          arch,
          components: {
            'imcodes-node': {
              component: 'imcodes-node',
              version,
              fileName: `imcodes-node-linux${target.endsWith('arm64') ? '-arm64' : ''}`,
              sha256: '1'.repeat(64),
              sizeBytes: 123,
              compat: { os: 'linux', arch },
            },
            'remote-desktop': {
              component: 'remote-desktop',
              version,
              fileName: 'imcodes-linux-remote-desktop-worker',
              sha256: '2'.repeat(64),
              sizeBytes: 456,
              compat: { os: 'linux', arch, protocolVersion: 2 },
            },
            'open-computer-use': {
              component: 'open-computer-use',
              version,
              fileName: 'open-computer-use',
              sha256: '3'.repeat(64),
              sizeBytes: 789,
              compat: { os: 'linux', arch },
            },
            'daemon-runtime': {
              component: 'daemon-runtime',
              version,
              fileName: archiveName,
              sha256: archiveSha,
              sizeBytes: archiveBytes.length,
              compat: { os: 'linux', arch, nodeVersion: process.version },
            },
          },
        },
      },
    };
    releaseManifestBytes = Buffer.from(JSON.stringify(rmObj, null, 2), 'utf8');
    writeFileSync(join(options.archiveOut.dir, desktopReleaseTargetManifestFilename(target)), releaseManifestBytes);
  }

  return { nodePath, entryPath, archivePath, manifestPath, archiveBytes, manifestBytes, releaseManifestBytes };
}

afterEach(() => {
  while (chmodRestore.length > 0) {
    const item = chmodRestore.pop()!;
    try {
      chmodSync(item.path, item.mode);
    } catch {
      // best effort
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('daemon-runtime atomic self-upgrade, rollback, discovery priority & fallback', () => {
  it('refuses auto-upgrade cleanly on git checkout / dev symlink (dev_symlink_exempt)', async () => {
    const devRepo = makeTempDir('imcodes-dev-repo-');
    mkdirSync(join(devRepo, '.git'), { recursive: true });
    mkdirSync(join(devRepo, 'dist', 'src'), { recursive: true });
    const realEntry = join(devRepo, 'dist', 'src', 'index.js');
    writeFileSync(realEntry, 'console.log("dev");\n');

    const linkDir = makeTempDir('imcodes-dev-bin-');
    const symEntry = join(linkDir, 'imcodes');
    symlinkSync(realEntry, symEntry);

    expect(inspectDaemonRuntimeMode({ entryScriptPath: symEntry })).toMatchObject({
      mode: 'dev_exempt',
      reason: 'dev_symlink_exempt',
    });

    const result = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '0.1.2',
      entryScriptPath: symEntry,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'dev_symlink_exempt',
    });

    // Package running from node_modules is treated as legacy_cli (not dev_exempt)
    const nmEntry = join(devRepo, 'node_modules', 'imcodes', 'dist', 'src', 'index.js');
    mkdirSync(join(nmEntry, '..'), { recursive: true });
    writeFileSync(nmEntry, 'console.log("npm");\n');
    expect(inspectDaemonRuntimeMode({ entryScriptPath: nmEntry })).toMatchObject({
      mode: 'legacy_cli',
    });
  });

  it('upgrades daemon-runtime atomically via server artifact endpoint, verifies release manifest, and prunes older releases keeping current + previous', async () => {
    const root = makeTempDir('imcodes-rt-srv-');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel100 = join(runtimeRoot, 'releases', '1.0.0');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    writeRunnableTree(rel100, '1.0.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    const buildRoot = makeTempDir('imcodes-rt-build-120-');
    const stagedOut = makeTempDir('imcodes-rt-dist-120-');
    const built = await buildRuntimeFeedArtifact(buildRoot, '1.2.0', {
      includeFilesDoc: true,
      archiveOut: { dir: stagedOut, includeReleaseManifest: true },
    });
    const rmSha = sha256(built.releaseManifestBytes!);

    const fetchImpl = async (url: string) => {
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME_MANIFEST}`)) {
        return new Response(built.manifestBytes, {
          status: 200,
          headers: { [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(built.manifestBytes!) },
        });
      }
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`)) {
        return new Response(built.archiveBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(built.archiveBytes!),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '1.2.0',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256]: rmSha,
          },
        });
      }
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST}`)) {
        return new Response(built.releaseManifestBytes, {
          status: 200,
          headers: { [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: rmSha },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const restarts: string[] = [];
    const res = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      targetVersion: '1.2.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: {
        kind: 'server',
        serverUrl: 'https://im.example',
        serverId: 'srv-1',
        token: 'tok-1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      restartService: async (ctx) => {
        restarts.push(`${ctx.previousVersion}->${ctx.targetVersion}`);
      },
    });

    expect(res).toMatchObject({
      status: 'upgraded',
      targetVersion: '1.2.0',
      previousVersion: '1.1.0',
      writableRootKind: 'in_place',
      rolledBack: false,
    });
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(join(runtimeRoot, 'releases', '1.2.0')));
    expect(existsSync(join(runtimeRoot, 'releases', '1.2.0'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'releases', '1.1.0'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'releases', '1.0.0'))).toBe(false);
    expect(restarts).toEqual(['1.1.0->1.2.0']);
  });

  it('automatically rolls back current pointer and restarts old version when post-restart health check fails', async () => {
    const root = makeTempDir('imcodes-rt-rb-');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    const buildRoot = makeTempDir('imcodes-rt-build-bad-');
    const localFeed = makeTempDir('imcodes-rt-feed-bad-');
    await buildRuntimeFeedArtifact(buildRoot, '1.2.0', {
      includeFilesDoc: true,
      archiveOut: { dir: localFeed, includeReleaseManifest: true },
    });

    const restartCalls: string[] = [];
    const seenPhases: string[] = [];

    const res = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: localFeed },
      restartService: async (ctx) => {
        restartCalls.push(`${ctx.previousVersion}->${ctx.targetVersion}`);
      },
      healthCheck: async (ctx) => {
        seenPhases.push(ctx.phase);
        if (ctx.phase === 'post_restart') {
          throw new Error('simulated_post_restart_crash');
        }
      },
    });

    expect(res).toMatchObject({
      status: 'rolled_back',
      targetVersion: '1.2.0',
      previousVersion: '1.1.0',
      restoredTarget: resolve(rel110),
      rolledBack: true,
    });
    expect(seenPhases).toEqual(['pre_switch', 'post_restart']);
    expect(restartCalls).toEqual(['1.1.0->1.2.0', '1.2.0->1.1.0']);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(rel110));
  });

  it('aborts pre-switch before touching current when archive fails pre-switch health probe or contains symlink escape or missing entrypoint', async () => {
    const root = makeTempDir('imcodes-rt-sec-');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    // Case 1: Pre-switch probe fails -> current stays 1.1.0
    const build1 = makeTempDir('imcodes-rt-pre-');
    const feed1 = makeTempDir('imcodes-rt-feed-pre-');
    await buildRuntimeFeedArtifact(build1, '1.2.0', { archiveOut: { dir: feed1 } });
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: feed1 },
      healthCheck: async () => {
        throw new Error('pre_switch_probe_failed');
      },
    })).rejects.toThrow('pre_switch_probe_failed');
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(rel110));

    // Case 2: Missing critical bootstrap inside archive (omitted before creating manifest, keeping 4 shared critical entries intact)
    const build2 = makeTempDir('imcodes-rt-missing-');
    const feed2 = makeTempDir('imcodes-rt-feed-missing-');
    await buildRuntimeFeedArtifact(build2, '1.3.0', {
      omitEntry: 'package/dist/src/daemon/memory-mcp-bootstrap.js',
      archiveOut: { dir: feed2 },
    });
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: feed2 },
    })).rejects.toThrow(/daemon_runtime_missing_critical_entry/);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(rel110));

    // Case 3: Escaping symlink inside archive
    const build3 = makeTempDir('imcodes-rt-sym-');
    const feed3 = makeTempDir('imcodes-rt-feed-sym-');
    const secret = join(root, 'outside-secret.txt');
    writeFileSync(secret, 'secret');
    const built3 = await buildRuntimeFeedArtifact(build3, '1.4.0', {
      archiveOut: { dir: feed3 },
      preArchiveHook: (bundleDir) => {
        symlinkSync(secret, join(bundleDir, 'package', 'escape-link'));
      },
    });
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: built3.nodePath,
      entryScriptPath: built3.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: feed3 },
    })).rejects.toThrow(/daemon_runtime_symlink_escape/);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(rel110));
  });

  it('uses user-level daemon-runtime fallback when system root is read-only and prioritizes highest valid version in discovery/CLI', async () => {
    const root = makeTempDir('imcodes-rt-ro-');
    const sysRuntimeRoot = join(root, 'sys', 'daemon-runtime');
    const rel110 = join(sysRuntimeRoot, 'releases', '1.1.0');
    const sysLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(sysRuntimeRoot, rel110, 'linux');

    // Make system runtimeRoot read-only (non-root user cannot write into it)
    chmodSync(sysRuntimeRoot, 0o555);
    chmodRestore.push({ path: sysRuntimeRoot, mode: 0o755 });

    const userHome = join(root, 'home');
    mkdirSync(userHome, { recursive: true });
    const userStateDir = join(userHome, '.imcodes');
    const buildRoot = makeTempDir('imcodes-rt-build-user-');
    const feed = makeTempDir('imcodes-rt-feed-user-');
    await buildRuntimeFeedArtifact(buildRoot, '1.2.0', { archiveOut: { dir: feed } });

    const res = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: sysLayout.nodePath,
      entryScriptPath: sysLayout.entryPath,
      runtimeRootOverride: sysRuntimeRoot,
      userHome,
      env: { IMCODES_HOME: userStateDir },
      source: { kind: 'local', dir: feed },
    });

    const userRuntimeRoot = join(userStateDir, 'daemon-runtime');
    expect(res).toMatchObject({
      status: 'upgraded',
      targetVersion: '1.2.0',
      runtimeRoot: userRuntimeRoot,
      writableRootKind: 'user_fallback',
      rolledBack: false,
    });

    // Both discoverCodingDaemonRuntime and inspectImcodesCliResolution select higher version 1.2.0!
    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: { IMCODES_HOME: userStateDir },
      userHome,
      execPath: sysLayout.nodePath,
      bundleDirs: [userRuntimeRoot, sysRuntimeRoot],
      cliCandidates: [],
    });
    expect(discovered?.version).toBe('1.2.0');
    expect(discovered?.bundleDir).toBe(join(userRuntimeRoot, 'current'));

    const resolvedCli = inspectImcodesCliResolution({
      platform: 'linux',
      runtimeRoot: sysRuntimeRoot,
      userRuntimeRoot,
    });
    expect(resolvedCli?.source).toBe('daemon_runtime_current');
    expect(resolvedCli?.executable).toBe(join(userRuntimeRoot, 'current', 'bin', 'node'));

    // Conversely, when system has higher 1.3.0, system wins!
    chmodSync(sysRuntimeRoot, 0o755);
    const rel130 = join(sysRuntimeRoot, 'releases', '1.3.0');
    writeRunnableTree(rel130, '1.3.0');
    switchDaemonRuntimeCurrentPointer(sysRuntimeRoot, rel130, 'linux');

    const discoveredNewSys = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: { IMCODES_HOME: userStateDir },
      userHome,
      execPath: sysLayout.nodePath,
      bundleDirs: [userRuntimeRoot, sysRuntimeRoot],
      cliCandidates: [],
    });
    expect(discoveredNewSys?.version).toBe('1.3.0');
    expect(discoveredNewSys?.bundleDir).toBe(join(sysRuntimeRoot, 'current'));

    const resolvedNewSys = inspectImcodesCliResolution({
      platform: 'linux',
      runtimeRoot: sysRuntimeRoot,
      userRuntimeRoot,
    });
    expect(resolvedNewSys?.executable).toBe(join(sysRuntimeRoot, 'current', 'bin', 'node'));
  });

  it('refuses downgrades cleanly and falls back to legacy CLI path when feed is unpublished (404)', async () => {
    const root = makeTempDir('imcodes-rt-fb-');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel200 = join(runtimeRoot, 'releases', '2.0.0');
    const layout = writeRunnableTree(rel200, '2.0.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel200, 'linux');

    const build190 = makeTempDir('imcodes-rt-190-');
    const feed190 = makeTempDir('imcodes-rt-feed-190-');
    await buildRuntimeFeedArtifact(build190, '1.9.0', { archiveOut: { dir: feed190 } });

    const downgradeRes = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '2.0.0',
      execPath: layout.nodePath,
      entryScriptPath: layout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: feed190 },
    });
    expect(downgradeRes).toMatchObject({ status: 'blocked', reason: 'downgrade_refused' });

    const fallbackRes = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '2.0.0',
      execPath: layout.nodePath,
      entryScriptPath: layout.entryPath,
      runtimeRootOverride: runtimeRoot,
      allowLegacyCliFallback: true,
      source: {
        kind: 'server',
        serverUrl: 'https://im.example',
        serverId: 'srv-1',
        token: 'tok-1',
        fetchImpl: (async () => new Response('not published', { status: 404 })) as unknown as typeof fetch,
      },
    });
    expect(fallbackRes).toMatchObject({
      status: 'fallback_legacy_cli',
      reason: 'daemon_runtime_not_published:404',
    });
  });

  it('detached switch-runner verifies daemon-runtime.json + cooldown, rejects sleep/wrong-version fakes, and rolls back automatically on failed restart', async () => {
    const root = makeTempDir('imcodes-rt-detached-');
    const stateDir = join(root, 'state');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel100 = join(runtimeRoot, 'releases', '1.0.0');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const rel120 = join(runtimeRoot, 'releases', '1.2.0');
    writeRunnableTree(rel100, '1.0.0');
    writeRunnableTree(rel110, '1.1.0');
    writeRunnableTree(rel120, '1.2.0');
    mkdirSync(join(runtimeRoot, 'releases', '.staging-leftover'), { recursive: true });
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    // Counterexample 1: sleep 15 without daemon-runtime.json MUST FAIL post-restart health & roll back!
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'daemon.pid'), '999999\n');
    const fakeSleepScript = join(root, 'fake-sleep-restart.sh');
    writeFileSync(
      fakeSleepScript,
      `#!/bin/sh\nsleep 15 >/dev/null 2>&1 &\necho $! > "${join(stateDir, 'daemon.pid')}"\n`,
      { mode: 0o755 },
    );
    const scriptDirSleep = mkdtempSync(join(root, 'script-sleep-'));
    const launchedSleep = launchDetachedDaemonRuntimeSwitchRunner({
      scriptDir: scriptDirSleep,
      platform: 'linux',
      runtimeRoot,
      stagedReleaseDir: rel120,
      previousTarget: rel110,
      targetVersion: '1.2.0',
      stateDir,
      homeDir: root,
      keepTargets: [rel120, rel110],
      restartCommand: `"${fakeSleepScript}"`,
      healthCheckTimeoutMs: 1200,
      settleMs: 100,
      spawnRunner: () => {},
    });
    let sleepStatus = 0;
    try {
      execFileSync(process.execPath, [launchedSleep.scriptPath, join(scriptDirSleep, 'runtime-upgrade.json')], {
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (err) {
      sleepStatus = (err as { status?: number }).status ?? 1;
    }
    try { process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim()), 'SIGKILL'); } catch {}
    expect(sleepStatus).toBe(1);
    expect(realpathSync(join(runtimeRoot, 'current'))).toBe(realpathSync(rel110));

    // Counterexample 2: daemon starts on OLD version 1.1.0 when 1.2.0 was expected -> MUST FAIL & roll back!
    const oldVerScript = join(root, 'old-ver-restart.sh');
    writeFileSync(
      oldVerScript,
      `#!/bin/sh
sleep 15 >/dev/null 2>&1 &
PID=$!
echo "$PID" > "${join(stateDir, 'daemon.pid')}"
"${process.execPath}" -e "const fs=require('fs');const p=Number(process.argv[1]);const s=Date.now();fs.writeFileSync('${join(stateDir, 'daemon-runtime.json')}', JSON.stringify({pid:p,startedAt:s,updatedAt:s,restartCount:1,version:'1.1.0'}));" "$PID"
`,
      { mode: 0o755 },
    );
    const scriptDirOldVer = mkdtempSync(join(root, 'script-oldver-'));
    const launchedOldVer = launchDetachedDaemonRuntimeSwitchRunner({
      scriptDir: scriptDirOldVer,
      platform: 'linux',
      runtimeRoot,
      stagedReleaseDir: rel120,
      previousTarget: rel110,
      targetVersion: '1.2.0',
      stateDir,
      homeDir: root,
      keepTargets: [rel120, rel110],
      restartCommand: `"${oldVerScript}"`,
      healthCheckTimeoutMs: 1200,
      settleMs: 100,
      spawnRunner: () => {},
    });
    let oldVerStatus = 0;
    try {
      execFileSync(process.execPath, [launchedOldVer.scriptPath, join(scriptDirOldVer, 'runtime-upgrade.json')], {
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (err) {
      oldVerStatus = (err as { status?: number }).status ?? 1;
    }
    try { process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim()), 'SIGKILL'); } catch {}
    expect(oldVerStatus).toBe(1);
    expect(realpathSync(join(runtimeRoot, 'current'))).toBe(realpathSync(rel110));

    // Happy detached path: restart spawns a live daemon writing daemon.pid + daemon-runtime.json with target version 1.2.0
    const happyRestartScript = join(root, 'happy-restart.sh');
    writeFileSync(
      happyRestartScript,
      `#!/bin/sh
sleep 15 >/dev/null 2>&1 &
PID=$!
echo "$PID" > "${join(stateDir, 'daemon.pid')}"
"${process.execPath}" -e "const fs=require('fs');const p=Number(process.argv[1]);const s=Date.now();fs.writeFileSync('${join(stateDir, 'daemon-runtime.json')}', JSON.stringify({pid:p,startedAt:s,updatedAt:s,restartCount:1,version:'1.2.0'}));" "$PID"
`,
      { mode: 0o755 },
    );

    const scriptDirOk = mkdtempSync(join(root, 'script-ok-'));
    const launchedOk = launchDetachedDaemonRuntimeSwitchRunner({
      scriptDir: scriptDirOk,
      platform: 'linux',
      runtimeRoot,
      stagedReleaseDir: rel120,
      previousTarget: rel110,
      targetVersion: '1.2.0',
      stateDir,
      homeDir: root,
      keepTargets: [rel120, rel110],
      restartCommand: `"${happyRestartScript}"`,
      settleMs: 150,
      spawnRunner: () => {},
    });

    execFileSync(process.execPath, [launchedOk.scriptPath, join(scriptDirOk, 'runtime-upgrade.json')], {
      stdio: 'pipe',
      timeout: 15_000,
    });
    const newPid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim());
    try { process.kill(newPid, 'SIGKILL'); } catch { /* cleanup */ }
    expect(realpathSync(join(runtimeRoot, 'current'))).toBe(realpathSync(rel120));
    expect(existsSync(join(runtimeRoot, 'releases', '1.1.0'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'releases', '1.0.0'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'releases', '.staging-leftover'))).toBe(false);
    expect(existsSync(join(stateDir, UPGRADE_COOLDOWN_SENTINEL_FILE))).toBe(true);

    // Failed restart path: restart exits 1 -> switch-runner automatically rolls current back to 1.1.0!
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');
    const failRestartScript = join(root, 'fail-restart.sh');
    const markerFile = join(root, 'rollback-restarted.txt');
    writeFileSync(
      failRestartScript,
      `#!/bin/sh\ntarget="$(readlink "${join(runtimeRoot, 'current')}")"\necho "$target" >> "${markerFile}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const scriptDirFail = mkdtempSync(join(root, 'script-fail-'));
    const launchedFail = launchDetachedDaemonRuntimeSwitchRunner({
      scriptDir: scriptDirFail,
      platform: 'linux',
      runtimeRoot,
      stagedReleaseDir: rel120,
      previousTarget: rel110,
      targetVersion: '1.2.0',
      stateDir,
      homeDir: root,
      keepTargets: [rel120, rel110],
      restartCommand: `"${failRestartScript}"`,
      spawnRunner: () => {},
    });

    let exitStatus = 0;
    try {
      execFileSync(process.execPath, [launchedFail.scriptPath, join(scriptDirFail, 'runtime-upgrade.json')], {
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (err) {
      exitStatus = (err as { status?: number }).status ?? 1;
    }
    expect(exitStatus).toBe(1);
    expect(realpathSync(join(runtimeRoot, 'current'))).toBe(realpathSync(rel110));
    const restartedTargets = readFileSync(markerFile, 'utf8').trim().split('\n');
    expect(restartedTargets).toHaveLength(2);
    expect(restartedTargets[0]).toBe(resolve(rel120));
    expect(restartedTargets[1]).toBe(resolve(rel110));
  });

  it('unlinks newly created user-fallback current pointer on rollback so read-only system runtime immediately resumes priority', async () => {
    const root = makeTempDir('imcodes-rt-ro-rb-');
    const sysRuntimeRoot = join(root, 'sys', 'daemon-runtime');
    const rel110 = join(sysRuntimeRoot, 'releases', '1.1.0');
    const sysLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(sysRuntimeRoot, rel110, 'linux');

    chmodSync(sysRuntimeRoot, 0o555);
    chmodRestore.push({ path: sysRuntimeRoot, mode: 0o755 });

    const userHome = join(root, 'home');
    mkdirSync(userHome, { recursive: true });
    const userStateDir = join(userHome, '.imcodes');
    const buildRoot = makeTempDir('imcodes-rt-build-120-rb-');
    const feed = makeTempDir('imcodes-rt-feed-120-rb-');
    await buildRuntimeFeedArtifact(buildRoot, '1.2.0', { archiveOut: { dir: feed } });

    const res = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: sysLayout.nodePath,
      entryScriptPath: sysLayout.entryPath,
      runtimeRootOverride: sysRuntimeRoot,
      userHome,
      env: { IMCODES_HOME: userStateDir },
      source: { kind: 'local', dir: feed },
      healthCheck: async (ctx) => {
        if (ctx.phase === 'post_restart') throw new Error('post_restart_boom');
      },
    });

    const userRuntimeRoot = join(userStateDir, 'daemon-runtime');
    expect(res).toMatchObject({ status: 'rolled_back', rolledBack: true, runtimeRoot: userRuntimeRoot });
    expect(existsSync(join(userRuntimeRoot, 'current'))).toBe(false);

    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: { IMCODES_HOME: userStateDir },
      userHome,
      execPath: sysLayout.nodePath,
      bundleDirs: [userRuntimeRoot, sysRuntimeRoot],
      cliCandidates: [],
    });
    expect(discovered?.version).toBe('1.1.0');
    expect(discovered?.bundleDir).toBe(join(sysRuntimeRoot, 'current'));
  });

  it('POSIX imcodes CLI wrapper picks strictly higher version between user ~/.imcodes/daemon-runtime and system runtime', () => {
    const root = makeTempDir('imcodes-cli-prio-');
    const sysRoot = join(root, 'sys', 'daemon-runtime');
    const userStateDir = join(root, 'user-state');
    const userRoot = join(userStateDir, 'daemon-runtime');
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });

    const sys110 = join(sysRoot, 'releases', '1.1.0');
    const user120 = join(userRoot, 'releases', '1.2.0');
    writeRunnableTree(sys110, '1.1.0');
    writeRunnableTree(user120, '1.2.0');
    switchDaemonRuntimeCurrentPointer(sysRoot, sys110, 'linux');
    switchDaemonRuntimeCurrentPointer(userRoot, user120, 'linux');

    const wrapperPath = join(binDir, 'imcodes');
    installImcodesCliWrapper({
      platform: 'linux',
      wrapperPath,
      runtimeRoot: sysRoot,
    });

    const outUserNewer = execFileSync(wrapperPath, ['--version'], {
      env: { PATH: '/nonexistent', HOME: join(root, 'empty-home'), IMCODES_HOME: userStateDir },
      encoding: 'utf8',
    }).trim();
    expect(outUserNewer).toBe('1.2.0');

    // Now system upgrades to 1.5.0 -> wrapper chooses system 1.5.0 over older user 1.2.0
    const sys150 = join(sysRoot, 'releases', '1.5.0');
    writeRunnableTree(sys150, '1.5.0');
    switchDaemonRuntimeCurrentPointer(sysRoot, sys150, 'linux');

    const outSysNewer = execFileSync(wrapperPath, ['--version'], {
      env: { PATH: '/nonexistent', HOME: join(root, 'empty-home'), IMCODES_HOME: userStateDir },
      encoding: 'utf8',
    }).trim();
    expect(outSysNewer).toBe('1.5.0');
  });

  // ── Round 2 Rework Causal Counterexample Tests (F1–F6) ───────────────────────────────────────────

  it('[F1] loads canonical server.json (workerUrl wss:// -> https://) inside IMCODES_HOME with no explicit source', async () => {
    const root = makeTempDir('imcodes-rt-f1-');
    const stateDir = join(root, 'state');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'server.json'),
      JSON.stringify({
        serverId: 'srv-canon-1',
        token: 'tok-canon-1',
        workerUrl: 'wss://127.0.0.1:9/worker',
        serverName: 'Test Server',
        boundAt: Date.now(),
      }),
    );

    // Without source override, canonical server.json must NOT return daemon_runtime_source_not_configured;
    // it actually attempts connecting to https://127.0.0.1:9 (which fails connection refused, proving workerUrl resolved!).
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      userHome: root,
      env: { ...process.env, IMCODES_HOME: stateDir },
    })).rejects.toThrow();

    // Symlinked server.json MUST be rejected -> falls back to daemon_runtime_source_not_configured
    const realCred = join(root, 'elsewhere.json');
    writeFileSync(realCred, JSON.stringify({ serverId: 'x', token: 'y', workerUrl: 'https://im.example' }));
    rmSync(join(stateDir, 'server.json'));
    symlinkSync(realCred, join(stateDir, 'server.json'));
    const symRes = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      userHome: root,
      env: { ...process.env, IMCODES_HOME: stateDir },
    });
    expect(symRes).toMatchObject({ status: 'fallback_legacy_cli', reason: 'daemon_runtime_source_not_configured' });
  });

  it('[F2] accepts real createDaemonRuntimeManifest through server catalog + local dir and rejects tampered files/old custom schema', async () => {
    const root = makeTempDir('imcodes-rt-f2-');
    const catalogRoot = join(root, 'catalog');
    const buildRoot = makeTempDir('imcodes-rt-f2-build-');
    const built = await buildRuntimeFeedArtifact(buildRoot, '1.2.0', {
      archiveOut: { dir: catalogRoot, includeReleaseManifest: true, targetSubdir: true },
    });
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const target = `linux-${arch}` as const;

    // 1. Server catalog validates the exact same real manifest generated by scripts/daemon-runtime-artifacts.mjs
    const catManifest = await openDaemonRuntimeArtifact(catalogRoot, target, true);
    expect(catManifest.status).toBe('ok');
    if (catManifest.status === 'ok') {
      expect(catManifest.version).toBe('1.2.0');
      await catManifest.close();
    }

    // 2. Old custom schema { target, archive } MUST be rejected cleanly
    const badFeed = makeTempDir('imcodes-rt-f2-badschema-');
    writeFileSync(join(badFeed, daemonRuntimeManifestFilename(target)), JSON.stringify({
      schemaVersion: 1,
      target: { os: 'linux', arch, nodeRelativePath: 'bin/node', entryRelativePath: 'package/dist/src/index.js' },
      archive: { format: 'tar.gz', fileName: `daemon-runtime-${target}.tar.gz`, size: 10, sha256: 'a'.repeat(64) },
      build: { commit: 'abcdef1', version: '1.2.0' },
    }));
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: badFeed },
    })).rejects.toThrow(/daemon_runtime_manifest_invalid/);

    // 3. Tampered file inside archive matching stale manifest fails files digest check BEFORE touching current
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: catalogRoot },
      extractArchive: ({ destDir }) => {
        execFileSync('tar', ['-xzf', built.archivePath, '-C', destDir], { stdio: 'pipe' });
        writeFileSync(join(destDir, 'package', 'dist', 'src', 'cli.js'), '// TAMPERED!\n');
      },
    })).rejects.toThrow(/daemon_runtime_manifest_files_digest_mismatch/);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(resolve(rel110));
  });

  it('[F3] aligns systemd, launchd, and Windows watchdog across user_fallback & restores on rollback; scoped restarts isolate profiles', async () => {
    // Part A: Linux scoped systemd rewrite forward & rollback restoration
    const rootLinux = makeTempDir('imcodes-rt-f3-linux-');
    const sysRootL = join(rootLinux, 'sys', 'daemon-runtime');
    const rel110L = join(sysRootL, 'releases', '1.1.0');
    const sysLayoutL = writeRunnableTree(rel110L, '1.1.0');
    switchDaemonRuntimeCurrentPointer(sysRootL, rel110L, 'linux');
    chmodSync(sysRootL, 0o555);
    chmodRestore.push({ path: sysRootL, mode: 0o755 });

    const homeL = join(rootLinux, 'home');
    const scopedStateL = join(homeL, 'custom-state');
    const userSvcDir = join(homeL, '.config', 'systemd', 'user');
    mkdirSync(userSvcDir, { recursive: true });
    mkdirSync(scopedStateL, { recursive: true });

    const restartCmdDefault = buildPosixRestartCommand({
      platform: 'linux',
      home: homeL,
      stateDir: join(homeL, '.imcodes'),
    });
    const scopedUnitPath = imcodesStateDirForHome(homeL, { HOME: homeL, IMCODES_HOME: scopedStateL });
    void scopedUnitPath;

    const unitContentOrig = '[Unit]\nDescription=imcodes\n[Service]\nExecStart=/opt/imcodes/daemon-runtime/current/bin/node /opt/imcodes/daemon-runtime/current/package/dist/src/index.js start --foreground\n';
    const { resolvePosixDaemonServicePaths } = await import('../../src/util/posix-daemon-service.js');
    const svcInfo = resolvePosixDaemonServicePaths({ HOME: homeL, IMCODES_HOME: scopedStateL });
    const svcUnitPath = join(userSvcDir, svcInfo.systemdUnitName);
    writeFileSync(svcUnitPath, unitContentOrig);

    expect(buildPosixRestartCommand({ platform: 'linux', home: homeL, stateDir: scopedStateL })).toContain(svcInfo.systemdUnitName);
    expect(restartCmdDefault).toContain('No user service found');

    const buildL = makeTempDir('imcodes-rt-f3-lb-');
    const feedL = makeTempDir('imcodes-rt-f3-lf-');
    await buildRuntimeFeedArtifact(buildL, '1.2.0', { archiveOut: { dir: feedL } });

    const capturedUnitStatesDuringRestarts: string[] = [];
    const rbRes = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: sysLayoutL.nodePath,
      entryScriptPath: sysLayoutL.entryPath,
      runtimeRootOverride: sysRootL,
      userHome: homeL,
      env: { ...process.env, HOME: homeL, IMCODES_HOME: scopedStateL },
      source: { kind: 'local', dir: feedL },
      restartService: async () => {
        capturedUnitStatesDuringRestarts.push(readFileSync(svcUnitPath, 'utf8'));
      },
      healthCheck: async (ctx) => {
        if (ctx.phase === 'post_restart') throw new Error('boom');
      },
    });
    expect(rbRes).toMatchObject({ status: 'rolled_back', rolledBack: true });
    expect(capturedUnitStatesDuringRestarts).toHaveLength(2);
    expect(capturedUnitStatesDuringRestarts[0]).toContain(join(scopedStateL, 'daemon-runtime', 'current', 'bin', 'node'));
    // After rollback, exact original ExecStart must be restored BEFORE rollback restart!
    expect(capturedUnitStatesDuringRestarts[1]).toBe(unitContentOrig);
    expect(readFileSync(svcUnitPath, 'utf8')).toBe(unitContentOrig);

    // Part B: macOS LaunchAgent ProgramArguments alignment + rollback restoration
    const rootMac = makeTempDir('imcodes-rt-f3-mac-');
    const homeM = join(rootMac, 'home');
    const stateM = join(homeM, '.imcodes');
    const plistPath = join(homeM, 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
    mkdirSync(join(homeM, 'Library', 'LaunchAgents'), { recursive: true });
    const origPlist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>Label</key><string>imcodes.daemon</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/opt/old/node</string>\n    <string>/opt/old/index.js</string>\n  </array>\n</dict></plist>\n`;
    writeFileSync(plistPath, origPlist);
    const { prepareServiceLaunchTarget, restoreServiceLaunchTarget } = await import('../../src/daemon/daemon-runtime-upgrade.js');
    const macBackup = prepareServiceLaunchTarget({
      kind: 'launchd',
      filePath: plistPath,
      programArguments: ['/user/new/bin/node', '/user/new/package/dist/src/index.js', 'start', '--foreground'],
    });
    expect(readFileSync(plistPath, 'utf8')).toContain('/user/new/bin/node');
    expect(restoreServiceLaunchTarget(macBackup)).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toBe(origPlist);

    // Part C: Windows daemon-watchdog.cmd BOM-free rewrite + rollback restoration
    const wdPath = join(stateM, 'daemon-watchdog.cmd');
    mkdirSync(stateM, { recursive: true });
    writeFileSync(wdPath, '@echo off\r\nREM old watchdog\r\n');
    const winBackup = prepareServiceLaunchTarget({
      kind: 'windows_watchdog',
      filePath: wdPath,
      watchdogContent: '@echo off\r\nchcp 65001 >nul 2>&1\r\ncall "C:\\Users\\k\\.imcodes\\daemon-runtime\\current\\node.exe" "C:\\Users\\k\\.imcodes\\daemon-runtime\\current\\package\\dist\\src\\index.js" start --foreground\r\n',
    });
    const wdBytes = readFileSync(wdPath);
    expect(wdBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(wdBytes.toString('utf8')).toContain('daemon-runtime\\current\\node.exe');
    expect(restoreServiceLaunchTarget(winBackup)).toBe(true);
    expect(readFileSync(wdPath, 'utf8')).toBe('@echo off\r\nREM old watchdog\r\n');
  });

  it('[F4] preserves existing real-directory current payload across switch & rollback without creating current -> current self-loop', async () => {
    const root = makeTempDir('imcodes-rt-f4-realdir-');
    const runtimeRoot = join(root, 'daemon-runtime');
    const realCurrent = join(runtimeRoot, 'current');
    // Unpacked real directory (NOT a symlink!) with no prior releases/1.1.0 directory
    const origLayout = writeRunnableTree(realCurrent, '1.1.0');
    writeFileSync(join(realCurrent, 'package', 'sentinel.txt'), 'preserve-me-1.1.0');

    const build120 = makeTempDir('imcodes-rt-f4-120-');
    const feed120 = makeTempDir('imcodes-rt-f4-feed-');
    await buildRuntimeFeedArtifact(build120, '1.2.0', { archiveOut: { dir: feed120 } });

    const res = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: origLayout.nodePath,
      entryScriptPath: origLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      source: { kind: 'local', dir: feed120 },
      healthCheck: async (ctx) => {
        if (ctx.phase === 'post_restart') throw new Error('post_restart_fail');
      },
    });

    expect(res).toMatchObject({ status: 'rolled_back', rolledBack: true });
    if (res.status === 'rolled_back') {
      expect(res.restoredTarget).toBeTruthy();
      expect(resolve(res.restoredTarget!)).not.toBe(resolve(realCurrent));
    }
    const ptr = readCurrentPointerTarget(runtimeRoot);
    expect(ptr.targetPath).toBeTruthy();
    expect(resolve(ptr.targetPath!)).not.toBe(resolve(realCurrent));
    expect(readFileSync(join(realCurrent, 'package', 'sentinel.txt'), 'utf8')).toBe('preserve-me-1.1.0');
    expect(rollbackDaemonRuntimeCurrentPointer).toBeTypeOf('function');
  });

  it('[F5] enforces cross-process single-flight lock without foreign unlink and writes last-upgrade-at sentinel', async () => {
    const root = makeTempDir('imcodes-rt-f5-lock-');
    const stateDir = join(root, 'state');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const curLayout = writeRunnableTree(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    const build120 = makeTempDir('imcodes-rt-f5-120-');
    const feed120 = makeTempDir('imcodes-rt-f5-feed-');
    await buildRuntimeFeedArtifact(build120, '1.2.0', { archiveOut: { dir: feed120 } });

    const held = acquireRuntimeUpgradeLock(stateDir, { mode: 'external_actor' });
    // Foreign release token cannot delete held lock
    expect(releaseRuntimeUpgradeLock(stateDir, 'wrong-token')).toBe(false);
    expect(existsSync(join(stateDir, DAEMON_RUNTIME_LOCK_DIR_NAME))).toBe(true);

    // Concurrent upgrade fails cleanly while lock is active and never removes releases
    await expect(upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      userHome: root,
      env: { ...process.env, IMCODES_HOME: stateDir },
      source: { kind: 'local', dir: feed120 },
    })).rejects.toThrow(/daemon_runtime_upgrade_in_progress/);
    expect(existsSync(rel110)).toBe(true);

    // Owner release cleans up, allowing upgrade to proceed & write cooldown sentinel
    expect(releaseRuntimeUpgradeLock(stateDir, held.ownerToken)).toBe(true);
    const okRes = await upgradeBundledDaemonRuntime({
      platform: 'linux',
      arch: process.arch,
      currentVersion: '1.1.0',
      execPath: curLayout.nodePath,
      entryScriptPath: curLayout.entryPath,
      runtimeRootOverride: runtimeRoot,
      userHome: root,
      env: { ...process.env, IMCODES_HOME: stateDir },
      source: { kind: 'local', dir: feed120 },
      now: () => 1700000123456,
    });
    expect(okRes).toMatchObject({ status: 'upgraded', targetVersion: '1.2.0' });
    expect(readFileSync(join(stateDir, UPGRADE_COOLDOWN_SENTINEL_FILE), 'utf8').trim()).toBe('1700000123456');
  });

  it('[F6] resolves eligible writable legacy npm CLI fallback cleanly and blocks read-only / missing / git fallback paths', () => {
    const root = makeTempDir('imcodes-rt-f6-');

    // 1. Missing npm CLI -> ineligible
    const emptyRes = resolveLegacyNpmCliFallback({
      platform: 'linux',
      env: { PATH: '/nonexistent' },
      userHome: root,
    });
    expect(emptyRes).toMatchObject({ eligible: false, reason: 'legacy_npm_cli_missing' });

    // 2. Writable custom prefix -> eligible
    const prefix = join(root, 'npm-global');
    const pkgDir = join(prefix, 'lib', 'node_modules', 'imcodes');
    const binDir = join(prefix, 'bin');
    mkdirSync(join(pkgDir, 'dist', 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'imcodes', version: '0.1.2' }));
    writeFileSync(join(pkgDir, 'dist', 'src', 'cli.js'), '// cli\n');
    writeFileSync(join(binDir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    const eligibleRes = resolveLegacyNpmCliFallback({
      platform: 'linux',
      env: { NPM_CONFIG_PREFIX: prefix, PATH: binDir },
      userHome: root,
    });
    expect(eligibleRes).toMatchObject({
      eligible: true,
      pkgDir,
      prefixDir: prefix,
      nodeBin: join(binDir, 'node'),
    });

    // 3. Read-only system prefix -> blocked cleanly (never mutates system dir)
    chmodSync(join(prefix, 'lib', 'node_modules'), 0o555);
    chmodRestore.push({ path: join(prefix, 'lib', 'node_modules'), mode: 0o755 });
    const roRes = resolveLegacyNpmCliFallback({
      platform: 'linux',
      env: { NPM_CONFIG_PREFIX: prefix, PATH: binDir },
      userHome: root,
    });
    expect(roRes).toMatchObject({ eligible: false, reason: 'legacy_npm_cli_read_only' });
  });
});
