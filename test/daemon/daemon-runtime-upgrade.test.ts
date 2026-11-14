import { execFileSync, spawn } from 'node:child_process';
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
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
} from '../../shared/controlled-node-artifacts.js';
import { desktopReleaseTargetManifestFilename } from '../../shared/desktop-release-manifest.js';
import {
  DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS,
  DAEMON_RUNTIME_FILES_FILENAME,
  inspectDaemonRuntimeMode,
  launchDetachedDaemonRuntimeSwitchRunner,
  switchDaemonRuntimeCurrentPointer,
  upgradeBundledDaemonRuntime,
} from '../../src/daemon/daemon-runtime-upgrade.js';
import { inspectImcodesCliResolution, installImcodesCliWrapper } from '../../src/node/imcodes-cli-wrapper.js';
import { discoverCodingDaemonRuntime } from '../../src/node/local-daemon-control.js';

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
function writeRunnableLayout(
  destDir: string,
  version: string,
  options: {
    omitEntry?: string;
    includeFilesDoc?: boolean;
    useShellShimForNode?: boolean;
    archiveOut?: { dir: string; includeReleaseManifest?: boolean };
  } = {},
): {
  nodePath: string;
  entryPath: string;
  archivePath?: string;
  manifestPath?: string;
  archiveBytes?: Buffer;
  manifestBytes?: Buffer;
  releaseManifestBytes?: Buffer;
} {
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

  const entryPath = join(destDir, 'package', 'dist', 'src', 'index.js');
  if (!options.archiveOut) {
    return { nodePath, entryPath };
  }

  mkdirSync(options.archiveOut.dir, { recursive: true });
  const target = `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}` as const;
  const archiveName = `daemon-runtime-${target}.tar.gz`;
  const archivePath = join(options.archiveOut.dir, archiveName);
  execFileSync('tar', ['-czf', archivePath, '-C', destDir, '.'], { stdio: 'pipe' });
  const archiveBytes = readFileSync(archivePath);
  const archiveSha = sha256(archiveBytes);

  const manifestObj = {
    schemaVersion: 1,
    target: {
      os: 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      nodeRelativePath: 'bin/node',
      entryRelativePath: 'package/dist/src/index.js',
    },
    archive: {
      format: 'tar.gz',
      fileName: archiveName,
      size: archiveBytes.length,
      sha256: archiveSha,
    },
    build: {
      commit: 'abcdef123456',
      version,
    },
    toolchain: {
      nodeProvider: 'official-node',
      nodeVersion: process.version,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8');
  const manifestPath = join(options.archiveOut.dir, `${archiveName}.manifest.json`);
  writeFileSync(manifestPath, manifestBytes);

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
          arch: process.arch === 'arm64' ? 'arm64' : 'x64',
          components: {
            'imcodes-node': {
              component: 'imcodes-node',
              version,
              fileName: `imcodes-node-linux${target.endsWith('arm64') ? '-arm64' : ''}`,
              sha256: '1'.repeat(64),
              sizeBytes: 123,
              compat: { os: 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64' },
            },
            'remote-desktop': {
              component: 'remote-desktop',
              version,
              fileName: 'imcodes-linux-remote-desktop-worker',
              sha256: '2'.repeat(64),
              sizeBytes: 456,
              compat: { os: 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64', protocolVersion: 2 },
            },
            'open-computer-use': {
              component: 'open-computer-use',
              version,
              fileName: 'open-computer-use',
              sha256: '3'.repeat(64),
              sizeBytes: 789,
              compat: { os: 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64' },
            },
            'daemon-runtime': {
              component: 'daemon-runtime',
              version,
              fileName: archiveName,
              sha256: archiveSha,
              sizeBytes: archiveBytes.length,
              compat: { os: 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64', nodeVersion: process.version },
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
    writeRunnableLayout(rel100, '1.0.0');
    const curLayout = writeRunnableLayout(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    const buildRoot = makeTempDir('imcodes-rt-build-120-');
    const stagedOut = makeTempDir('imcodes-rt-dist-120-');
    const built = writeRunnableLayout(buildRoot, '1.2.0', {
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
    const curLayout = writeRunnableLayout(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    const buildRoot = makeTempDir('imcodes-rt-build-bad-');
    const localFeed = makeTempDir('imcodes-rt-feed-bad-');
    writeRunnableLayout(buildRoot, '1.2.0', {
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
    const curLayout = writeRunnableLayout(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    // Case 1: Pre-switch probe fails -> current stays 1.1.0
    const build1 = makeTempDir('imcodes-rt-pre-');
    const feed1 = makeTempDir('imcodes-rt-feed-pre-');
    writeRunnableLayout(build1, '1.2.0', { archiveOut: { dir: feed1 } });
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

    // Case 2: Missing critical entrypoint inside archive
    const build2 = makeTempDir('imcodes-rt-missing-');
    const feed2 = makeTempDir('imcodes-rt-feed-missing-');
    writeRunnableLayout(build2, '1.3.0', {
      omitEntry: 'package/dist/src/cli.js',
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
    const built3 = writeRunnableLayout(build3, '1.4.0');
    const secret = join(root, 'outside-secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(build3, 'package', 'escape-link'));
    const target = `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const archiveName = `daemon-runtime-${target}.tar.gz`;
    const archivePath = join(feed3, archiveName);
    execFileSync('tar', ['-czf', archivePath, '-C', build3, '.'], { stdio: 'pipe' });
    const archiveBytes = readFileSync(archivePath);
    writeFileSync(join(feed3, `${archiveName}.manifest.json`), JSON.stringify({
      schemaVersion: 1,
      target: {
        os: 'linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        nodeRelativePath: 'bin/node',
        entryRelativePath: 'package/dist/src/index.js',
      },
      archive: {
        format: 'tar.gz',
        fileName: archiveName,
        size: archiveBytes.length,
        sha256: sha256(archiveBytes),
      },
      build: { commit: 'abcdef123456', version: '1.4.0' },
      toolchain: { nodeProvider: 'official-node', nodeVersion: process.version },
    }));
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
    const sysLayout = writeRunnableLayout(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(sysRuntimeRoot, rel110, 'linux');

    // Make system runtimeRoot read-only (non-root user cannot write into it)
    chmodSync(sysRuntimeRoot, 0o555);
    chmodRestore.push({ path: sysRuntimeRoot, mode: 0o755 });

    const userHome = join(root, 'home');
    mkdirSync(userHome, { recursive: true });
    const userStateDir = join(userHome, '.imcodes');
    const buildRoot = makeTempDir('imcodes-rt-build-user-');
    const feed = makeTempDir('imcodes-rt-feed-user-');
    writeRunnableLayout(buildRoot, '1.2.0', { archiveOut: { dir: feed } });

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
    writeRunnableLayout(rel130, '1.3.0');
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
    const layout = writeRunnableLayout(rel200, '2.0.0');
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel200, 'linux');

    const build190 = makeTempDir('imcodes-rt-190-');
    const feed190 = makeTempDir('imcodes-rt-feed-190-');
    writeRunnableLayout(build190, '1.9.0', { archiveOut: { dir: feed190 } });

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

  it('detached switch-runner switches current, cleans staging, and rolls back automatically on failed daemon restart', async () => {
    const root = makeTempDir('imcodes-rt-detached-');
    const stateDir = join(root, 'state');
    const runtimeRoot = join(root, 'daemon-runtime');
    const rel100 = join(runtimeRoot, 'releases', '1.0.0');
    const rel110 = join(runtimeRoot, 'releases', '1.1.0');
    const rel120 = join(runtimeRoot, 'releases', '1.2.0');
    writeRunnableLayout(rel100, '1.0.0');
    writeRunnableLayout(rel110, '1.1.0');
    writeRunnableLayout(rel120, '1.2.0');
    mkdirSync(join(runtimeRoot, 'releases', '.staging-leftover'), { recursive: true });
    switchDaemonRuntimeCurrentPointer(runtimeRoot, rel110, 'linux');

    // Happy detached path: restart spawns a short-lived sleep subprocess and writes its PID into daemon.pid
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'daemon.pid'), '999999\n');
    const spawnedChildren: ReturnType<typeof spawn>[] = [];
    const happyRestartScript = join(root, 'happy-restart.sh');
    writeFileSync(
      happyRestartScript,
      `#!/bin/sh\nsleep 15 >/dev/null 2>&1 &\necho $! > "${join(stateDir, 'daemon.pid')}"\n`,
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
    void spawnedChildren;
  });

  it('unlinks newly created user-fallback current pointer on rollback so read-only system runtime immediately resumes priority', async () => {
    const root = makeTempDir('imcodes-rt-ro-rb-');
    const sysRuntimeRoot = join(root, 'sys', 'daemon-runtime');
    const rel110 = join(sysRuntimeRoot, 'releases', '1.1.0');
    const sysLayout = writeRunnableLayout(rel110, '1.1.0');
    switchDaemonRuntimeCurrentPointer(sysRuntimeRoot, rel110, 'linux');

    chmodSync(sysRuntimeRoot, 0o555);
    chmodRestore.push({ path: sysRuntimeRoot, mode: 0o755 });

    const userHome = join(root, 'home');
    mkdirSync(userHome, { recursive: true });
    const userStateDir = join(userHome, '.imcodes');
    const buildRoot = makeTempDir('imcodes-rt-build-120-rb-');
    const feed = makeTempDir('imcodes-rt-feed-120-rb-');
    writeRunnableLayout(buildRoot, '1.2.0', { archiveOut: { dir: feed } });

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
    writeRunnableLayout(sys110, '1.1.0');
    writeRunnableLayout(user120, '1.2.0');
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
    writeRunnableLayout(sys150, '1.5.0');
    switchDaemonRuntimeCurrentPointer(sysRoot, sys150, 'linux');

    const outSysNewer = execFileSync(wrapperPath, ['--version'], {
      env: { PATH: '/nonexistent', HOME: join(root, 'empty-home'), IMCODES_HOME: userStateDir },
      encoding: 'utf8',
    }).trim();
    expect(outSysNewer).toBe('1.5.0');
  });
});
