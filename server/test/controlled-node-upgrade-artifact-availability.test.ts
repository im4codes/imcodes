import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_ABI_GLIBC217,
  CONTROLLED_NODE_ABI_MODERN,
  CONTROLLED_NODE_ABI_PROFILES,
} from '../../shared/controlled-node-abi.js';
import {
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
} from '../../shared/controlled-node-artifacts.js';
import { CONTROLLED_NODE_UPGRADE_STATUS, DAEMON_UPGRADE_SOURCE } from '../../shared/daemon-upgrade.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
} from '../../shared/remote-desktop-worker.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { serverRoutes } from '../src/routes/server.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import {
  ArtifactCatalog,
  checkControlledNodeUpgradeArtifactAvailability,
} from '../src/services/controlled-node-artifact-catalog.js';
import {
  markDaemonUpgradeTargetVersionPublishedForTest,
  resetDaemonUpgradePublicationGateForTest,
} from '../src/ws/daemon-upgrade-publication-gate.js';
import {
  WsBridge,
  __setLegacyUpgradePublisherSignerResolverForTests,
} from '../src/ws/bridge.js';

class MockWs extends EventEmitter {
  readyState = 1;
  sentStrings: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });

  send(data: string | Buffer): void {
    if (typeof data === 'string') {
      this.sentStrings.push(data);
    }
  }

  sentMessages(): Array<Record<string, unknown>> {
    return this.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const tempDirs: string[] = [];
const prevNodeExeDir = process.env.IMCODES_NODE_EXE_DIR;
const prevAppVersion = process.env.APP_VERSION;
const JWT_KEY = 'controlled-node-upgrade-avail-test-key!';

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-avail-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function writeLinuxAndMacArtifacts(dir: string, version: string): void {
  const linuxModern = Buffer.from(`linux-modern-${version}`);
  writeFileSync(join(dir, 'imcodes-node-linux'), linuxModern);
  writeFileSync(join(dir, 'imcodes-node-linux.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    artifact: {
      os: 'linux',
      arch: 'x64',
      fileName: 'imcodes-node-linux',
      size: linuxModern.length,
      sha256: sha256(linuxModern),
    },
    build: { version },
  }));

  const pin = CONTROLLED_NODE_ABI_PROFILES.GLIBC217;
  const linuxCompat = Buffer.from(`linux-compat-${version}`);
  writeFileSync(join(dir, pin.fileName), linuxCompat);
  writeFileSync(join(dir, `${pin.fileName}.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    artifact: {
      os: 'linux',
      arch: 'x64',
      abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
      fileName: pin.fileName,
      size: linuxCompat.length,
      sha256: sha256(linuxCompat),
    },
    build: { version },
    toolchain: {
      nodeProvider: pin.provider,
      nodeVersion: pin.nodeVersion,
      nodeArchive: pin.nodeArchive,
      nodeArchiveSha256: pin.nodeArchiveSha256,
      nodeBinarySha256: pin.nodeBinarySha256,
      seaBlobSha256: 'c'.repeat(64),
    },
  }));

  const macUniversal = Buffer.from(`mac-universal-${version}`);
  writeFileSync(join(dir, 'imcodes-node-macos'), macUniversal);
  writeFileSync(join(dir, 'imcodes-node-macos.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    artifact: {
      os: 'mac',
      arch: 'universal',
      fileName: 'imcodes-node-macos',
      size: macUniversal.length,
      sha256: sha256(macUniversal),
    },
    build: { version },
  }));
}

function writeWindowsNodeExecutable(dir: string, version: string): void {
  const winExe = Buffer.from(`win-exe-${version}`);
  writeFileSync(join(dir, 'imcodes-node.exe'), winExe);
  writeFileSync(join(dir, 'imcodes-node.exe.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    artifact: {
      os: 'win',
      arch: 'x64',
      fileName: 'imcodes-node.exe',
      size: winExe.length,
      sha256: sha256(winExe),
      authenticodeSignerSha256: 'a'.repeat(64),
    },
    build: { version },
  }));
}

function writeWindowsRemoteDesktopWorker(dir: string, workerVersion: string): void {
  const workerDir = join(dir, 'remote-desktop-worker', 'win32-x64');
  mkdirSync(workerDir, { recursive: true });
  const workerBytes = Buffer.from(`win-rd-worker-${workerVersion}`);
  const vdBytes = Buffer.from(`win-rd-vd-${workerVersion}`);
  writeFileSync(join(workerDir, REMOTE_DESKTOP_WORKER_FILENAME), workerBytes);
  writeFileSync(join(workerDir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME), vdBytes);
  writeFileSync(
    join(workerDir, `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`),
    JSON.stringify({
      manifestVersion: 2,
      workerVersion,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: workerBytes.length,
      sha256: sha256(workerBytes),
      authenticodeSignerSha256: 'a'.repeat(64),
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      virtualDisplay: {
        archiveFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
        packageManifestFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
        size: vdBytes.length,
        sha256: sha256(vdBytes),
      },
      toolchain: {
        msvc: '14.40',
        windowsSdk: '10.0.22621',
        cmake: '3.30.0',
        ninja: '1.12.0',
        depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
      },
    }),
  );
}

async function waitForReal(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitForReal timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Waits until WsBridge has finished both `isDaemonConnected()` and the entire
 * async post-auth chain (`authPromise` -> `finishLocalAuth()`), which arms the
 * post-auth upgrade stagger timer synchronously before resolving.
 */
async function waitForPostAuthUpgradeArmed(bridge: WsBridge): Promise<void> {
  const internal = bridge as unknown as { authPromise: Promise<void> | null };
  await waitForReal(() => bridge.isDaemonConnected());
  while (internal.authPromise) {
    await internal.authPromise;
  }
  await Promise.resolve();
}

describe('controlled-node upgrade artifact availability', () => {
  let restorePublisherSignerResolver: (() => void) | null = null;

  beforeEach(() => {
    delete process.env.IMCODES_NODE_EXE_DIR;
    delete process.env.APP_VERSION;
    restorePublisherSignerResolver = __setLegacyUpgradePublisherSignerResolverForTests(
      async () => 'a'.repeat(64),
    );
  });

  afterEach(() => {
    restorePublisherSignerResolver?.();
    restorePublisherSignerResolver = null;
    vi.useRealTimers();
    resetDaemonUpgradePublicationGateForTest();
    if (prevNodeExeDir === undefined) delete process.env.IMCODES_NODE_EXE_DIR;
    else process.env.IMCODES_NODE_EXE_DIR = prevNodeExeDir;
    if (prevAppVersion === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = prevAppVersion;
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('treats unset IMCODES_NODE_EXE_DIR as unconfigured (available) and gates Windows vs Linux/macOS accurately when configured', async () => {
    const unset = await checkControlledNodeUpgradeArtifactAvailability({ os: CONTROLLED_NODE_OS_WIN });
    expect(unset).toEqual({ configured: false, available: true });

    const dir = makeTempDir();
    const catalog = new ArtifactCatalog();
    writeLinuxAndMacArtifacts(dir, '2026.11.6643-dev.6687');

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_LINUX,
      arch: 'x64',
      abiProfile: CONTROLLED_NODE_ABI_MODERN,
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: true });

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_LINUX,
      arch: 'x64',
      abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: true });

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_MAC,
      arch: 'arm64',
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: true });

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_WIN,
      arch: 'x64',
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'executable_not_built' });

    // Windows executable without remote-desktop-worker still fails closed (matches enroll.ts).
    writeWindowsNodeExecutable(dir, '2026.11.6643-dev.6687');
    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_WIN,
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'remote_desktop_worker_not_built' });

    // Worker with mismatched version fails closed.
    writeWindowsRemoteDesktopWorker(dir, '2026.11.6600-dev.6600');
    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_WIN,
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'windows_release_version_mismatch' });

    // Matching worker version unlocks Windows availability immediately.
    writeWindowsRemoteDesktopWorker(dir, '2026.11.6643-dev.6687');
    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_WIN,
      artifactDir: dir,
      artifactCatalog: catalog,
    })).toEqual({ configured: true, available: true });
  });

  it('prevents WsBridge auto-upgrade and legacy rescue for Windows nodes lacking artifacts, clears stale failed DB state, and resumes once artifacts exist', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const dir = makeTempDir();
    writeLinuxAndMacArtifacts(dir, '2026.11.6643-dev.6687');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    process.env.APP_VERSION = '2026.11.6643-dev.6687';
    markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

    const token = 'test-node-token';
    const tokenHash = sha256Hex(token);

    let winRowState = {
      controlled_upgrade_status: CONTROLLED_NODE_UPGRADE_STATUS.FAILED,
      controlled_upgrade_target_version: '2026.11.6643-dev.6687' as string | null,
      controlled_upgrade_reason: 'download_failed_503' as string | null,
    };

    const winServerId = `win-${randomBytes(4).toString('hex')}`;
    const winDb = {
      queryOne: async () => ({
        token_hash: tokenHash,
        owner_status: 'active',
        user_id: 'owner-1',
        node_role: 'controlled',
        revoked_at: null,
        os: CONTROLLED_NODE_OS_WIN,
        arch: 'x64',
        abi_profile: CONTROLLED_NODE_ABI_MODERN,
        ...winRowState,
      }),
      query: async () => [],
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SET controlled_upgrade_status')) {
          winRowState = {
            controlled_upgrade_status: String(params?.[0] ?? '') as typeof winRowState.controlled_upgrade_status,
            controlled_upgrade_target_version: (params?.[1] as string | null) ?? null,
            controlled_upgrade_reason: (params?.[2] as string | null) ?? null,
          };
        }
        return { changes: 1 };
      },
    } as unknown as Database;

    const winBridge = WsBridge.get(winServerId);
    const winWs = new MockWs();
    winBridge.handleDaemonConnection(winWs as never, winDb, {} as never);
    // Outdated Windows controlled node without safe-self-upgrade capability (normally would arm legacy rescue).
    winWs.emit('message', JSON.stringify({
      type: 'auth',
      serverId: winServerId,
      token,
      daemonVersion: '2026.11.6629-dev.6677',
      capabilities: [],
    }));
    await waitForPostAuthUpgradeArmed(winBridge);
    await waitForReal(() =>
      winRowState.controlled_upgrade_status === CONTROLLED_NODE_UPGRADE_STATUS.CURRENT,
    );
    await vi.advanceTimersByTimeAsync(20_000);

    const winSent = winWs.sentMessages();
    expect(winSent.some((m) => m.type === 'daemon.upgrade')).toBe(false);
    expect(winSent.some((m) => m.type === 'machine.exec')).toBe(false);
    expect(winRowState).toEqual({
      controlled_upgrade_status: CONTROLLED_NODE_UPGRADE_STATUS.CURRENT,
      controlled_upgrade_target_version: null,
      controlled_upgrade_reason: null,
    });
    expect(winBridge.getControlledNodeUpgradeStatus()).toEqual({
      status: CONTROLLED_NODE_UPGRADE_STATUS.CURRENT,
    });

    const manualBlocked = winBridge.requestDaemonUpgrade({
      targetVersion: process.env.APP_VERSION,
      source: DAEMON_UPGRADE_SOURCE.MANUAL,
    });
    expect(manualBlocked).toMatchObject({
      ok: false,
      reason: 'executable_not_built',
    });
    expect(winRowState.controlled_upgrade_status).toBe(CONTROLLED_NODE_UPGRADE_STATUS.CURRENT);

    // Linux controlled node on the exact same server receives daemon.upgrade normally.
    const linuxServerId = `linux-${randomBytes(4).toString('hex')}`;
    const linuxDb = {
      queryOne: async () => ({
        token_hash: tokenHash,
        owner_status: 'active',
        user_id: 'owner-1',
        node_role: 'controlled',
        revoked_at: null,
        os: CONTROLLED_NODE_OS_LINUX,
        arch: 'x64',
        abi_profile: CONTROLLED_NODE_ABI_GLIBC217,
      }),
      query: async () => [],
      execute: async () => ({ changes: 1 }),
    } as unknown as Database;
    const linuxBridge = WsBridge.get(linuxServerId);
    const linuxWs = new MockWs();
    linuxBridge.handleDaemonConnection(linuxWs as never, linuxDb, {} as never);
    linuxWs.emit('message', JSON.stringify({
      type: 'auth',
      serverId: linuxServerId,
      token,
      abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
      daemonVersion: '2026.11.6629-dev.6677',
      capabilities: [],
    }));
    await waitForPostAuthUpgradeArmed(linuxBridge);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(linuxWs.sentMessages().some((m) => m.type === 'daemon.upgrade')).toBe(true);

    // Full daemon on the exact same server is unaffected.
    const fullServerId = `full-${randomBytes(4).toString('hex')}`;
    const fullDb = {
      queryOne: async () => ({
        token_hash: tokenHash,
        owner_status: 'active',
        user_id: 'owner-1',
        node_role: 'full',
        revoked_at: null,
      }),
      query: async () => [],
      execute: async () => ({ changes: 1 }),
    } as unknown as Database;
    const fullBridge = WsBridge.get(fullServerId);
    const fullWs = new MockWs();
    fullBridge.handleDaemonConnection(fullWs as never, fullDb, {} as never);
    fullWs.emit('message', JSON.stringify({
      type: 'auth',
      serverId: fullServerId,
      token,
      daemonVersion: '2026.11.6629-dev.6677',
    }));
    await waitForPostAuthUpgradeArmed(fullBridge);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fullWs.sentMessages().some((m) => m.type === 'daemon.upgrade')).toBe(true);

    // Now publish complete Windows binaries (simulate switching to a release image) and reconnect.
    writeWindowsNodeExecutable(dir, '2026.11.6643-dev.6687');
    writeWindowsRemoteDesktopWorker(dir, '2026.11.6643-dev.6687');
    const winWs2 = new MockWs();
    winBridge.handleDaemonConnection(winWs2 as never, winDb, {} as never);
    winWs2.emit('message', JSON.stringify({
      type: 'auth',
      serverId: winServerId,
      token,
      daemonVersion: '2026.11.6629-dev.6677',
      capabilities: [],
    }));
    await waitForPostAuthUpgradeArmed(winBridge);
    await vi.advanceTimersByTimeAsync(20_000);
    await waitForReal(() => winWs2.sentMessages().some((m) => m.type === 'machine.exec'));
    // Triggers legacy rescue MACHINE_EXEC because this test node has no safe self-upgrade cap.
    expect(winWs2.sentMessages().some((m) => m.type === 'machine.exec')).toBe(true);
  });

  it('suppresses updateAvailable and failed status in /api/machines and refuses POST upgrade cleanly when Windows artifacts are absent', async () => {
    const dir = makeTempDir();
    writeLinuxAndMacArtifacts(dir, '2026.11.6643-dev.6687');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    process.env.APP_VERSION = '2026.11.6643-dev.6687';
    markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

    const ownerId = 'owner-avail-1';
    const winId = `win-srv-${randomBytes(3).toString('hex')}`;
    const linuxId = `lin-srv-${randomBytes(3).toString('hex')}`;
    let dbUpdatedToFailed = false;

    const rows = [
      {
        id: winId,
        user_id: ownerId,
        node_id: '9909368908',
        ref_name: 'win-box',
        display_name: 'Windows Box',
        status: 'online',
        node_role: 'controlled',
        host_server_id: null,
        last_heartbeat_at: Date.now(),
        exec_enabled: true,
        os: CONTROLLED_NODE_OS_WIN,
        arch: 'x64',
        abi_profile: CONTROLLED_NODE_ABI_MODERN,
        daemon_version: '2026.11.6629-dev.6677',
        revoked_at: null,
        auto_unlock_configured: false,
        controlled_capabilities: [],
        controlled_upgrade_status: CONTROLLED_NODE_UPGRADE_STATUS.FAILED,
        controlled_upgrade_target_version: '2026.11.6643-dev.6687',
        controlled_upgrade_reason: 'download_failed_503',
        controlled_worker_refresh_attempt_id: null,
        controlled_worker_refresh_phase: null,
        controlled_worker_refresh_installed_version: null,
        controlled_worker_refresh_target_version: null,
        controlled_worker_refresh_artifact_sha256: null,
        controlled_worker_refresh_reason: null,
        controlled_worker_refresh_recorded_at: null,
        remote_desktop_host_id: null,
        team_ids: [],
        team_names: [],
        access_role: 'owner',
        access_source: 'owner',
        exec_granted: false,
        can_rename: true,
        access_expires_at: null,
      },
      {
        id: linuxId,
        user_id: ownerId,
        node_id: '5511223344',
        ref_name: 'linux-box',
        display_name: 'Linux Box',
        status: 'online',
        node_role: 'controlled',
        host_server_id: null,
        last_heartbeat_at: Date.now(),
        exec_enabled: true,
        os: CONTROLLED_NODE_OS_LINUX,
        arch: 'x64',
        abi_profile: CONTROLLED_NODE_ABI_MODERN,
        daemon_version: '2026.11.6629-dev.6677',
        revoked_at: null,
        auto_unlock_configured: false,
        controlled_capabilities: [],
        controlled_upgrade_status: CONTROLLED_NODE_UPGRADE_STATUS.CURRENT,
        controlled_upgrade_target_version: null,
        controlled_upgrade_reason: null,
        controlled_worker_refresh_attempt_id: null,
        controlled_worker_refresh_phase: null,
        controlled_worker_refresh_installed_version: null,
        controlled_worker_refresh_target_version: null,
        controlled_worker_refresh_artifact_sha256: null,
        controlled_worker_refresh_reason: null,
        controlled_worker_refresh_recorded_at: null,
        remote_desktop_host_id: null,
        team_ids: [],
        team_names: [],
        access_role: 'owner',
        access_source: 'owner',
        exec_granted: false,
        can_rename: true,
        access_expires_at: null,
      },
    ];

    const mockDb = {
      query: async () => rows,
      queryOne: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes('FROM servers') && sql.includes('FROM users')) {
          return { id: ownerId, status: 'active', role: 'member', password_updated_at: null };
        }
        const row = rows.find((r) => params.includes(r.id)) ?? null;
        if (!row) return null;
        if (sql.includes('owner_status')) {
          return { ...row, owner_status: 'active', actor_status: 'active' };
        }
        return row;
      },
      execute: async (sql: string) => {
        if (sql.includes('SET controlled_upgrade_status')) {
          dbUpdatedToFailed = true;
        }
        return { changes: 1 };
      },
    } as unknown as Database;

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.env = {
        DB: mockDb,
        JWT_SIGNING_KEY: JWT_KEY,
        SERVER_URL: 'https://im.zhinet.work',
      } as unknown as Env;
      await next();
    });
    app.route('/api/machines', machinesRoutes);
    app.route('/api/server', serverRoutes);

    const authHeaders = {
      authorization: `Bearer ${signJwt({ sub: ownerId, type: 'web' }, JWT_KEY, 3600)}`,
    };

    const listRes1 = await app.request('/api/machines', { headers: authHeaders });
    expect(listRes1.status).toBe(200);
    const listBody1 = await listRes1.json() as { machines: Array<Record<string, unknown>> };
    const winMachine1 = listBody1.machines.find((m) => m.serverId === winId)!;
    const linuxMachine1 = listBody1.machines.find((m) => m.serverId === linuxId)!;

    expect(winMachine1.updateAvailable).toBeUndefined();
    expect(winMachine1.upgradeStatus).toBeUndefined();
    expect(winMachine1.upgradeReason).toBeUndefined();
    expect(linuxMachine1.updateAvailable).toBe(true);

    const manualRes1 = await app.request(`/api/machines/${winId}/upgrade`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(manualRes1.status).toBe(409);
    expect(await manualRes1.json()).toEqual({ error: 'executable_not_built' });
    expect(dbUpdatedToFailed).toBe(false);

    // /api/server/:id/upgrade must also refuse cleanly for a controlled node lacking artifacts.
    const serverUpgradeRes = await app.request(`/api/server/${winId}/upgrade`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(serverUpgradeRes.status).toBe(409);
    expect(await serverUpgradeRes.json()).toEqual({ error: 'executable_not_built' });

    // Once Windows artifacts exist, GET /api/machines exposes updateAvailable: true immediately.
    writeWindowsNodeExecutable(dir, '2026.11.6643-dev.6687');
    writeWindowsRemoteDesktopWorker(dir, '2026.11.6643-dev.6687');

    const listRes2 = await app.request('/api/machines', { headers: authHeaders });
    expect(listRes2.status).toBe(200);
    const listBody2 = await listRes2.json() as { machines: Array<Record<string, unknown>> };
    const winMachine2 = listBody2.machines.find((m) => m.serverId === winId)!;
    expect(winMachine2.updateAvailable).toBe(true);
  });

  it('checks per-arch macOS release manifest for darwin-x64 vs darwin-arm64 and checks both when macOS arch is universal/unknown', async () => {
    const dir = makeTempDir();
    const catalog = new ArtifactCatalog();
    const version = '2026.11.6643-dev.6687';
    writeLinuxAndMacArtifacts(dir, version);
    const macUniversal = Buffer.from(`mac-universal-${version}`);

    const writeMacManifest = (arch: 'arm64' | 'x64', nodeSha: string) => {
      const target = `darwin-${arch}`;
      writeFileSync(join(dir, `desktop-release-${target}.manifest.json`), JSON.stringify({
        schemaVersion: 1,
        releaseVersion: version,
        gitSha: '1234567abcdef',
        generatedAt: new Date().toISOString(),
        targets: {
          [target]: {
            target,
            os: 'darwin',
            arch,
            components: {
              'imcodes-node': {
                component: 'imcodes-node',
                version,
                fileName: 'imcodes-node-macos',
                sha256: nodeSha,
                sizeBytes: macUniversal.length,
                compat: { os: 'darwin', arch: 'universal' },
              },
              'remote-desktop': {
                component: 'remote-desktop',
                version,
                fileName: `imcodes-macos-remote-desktop-${arch}.tar.gz`,
                sha256: 'b'.repeat(64),
                sizeBytes: 100,
                compat: { os: 'darwin', arch, protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION },
              },
              'open-computer-use': {
                component: 'open-computer-use',
                version,
                fileName: 'open-computer-use.app.zip',
                sha256: 'c'.repeat(64),
                sizeBytes: 100,
                compat: { os: 'darwin', arch: 'universal' },
              },
              'daemon-runtime': {
                component: 'daemon-runtime',
                version,
                fileName: `daemon-runtime-${target}.tar.gz`,
                sha256: 'd'.repeat(64),
                sizeBytes: 100,
                compat: { os: 'darwin', arch, nodeVersion: 'v24.16.0' },
              },
            },
          },
        },
      }));
    };

    // arm64 matches, x64 mismatches -> Intel Mac (`x64`) and `universal` catch mismatch; `arm64` stays available.
    writeMacManifest('arm64', sha256(macUniversal));
    writeMacManifest('x64', 'f'.repeat(64));

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_MAC, arch: 'x64', artifactDir: dir, artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'desktop_release_manifest_mismatch' });

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_MAC, arch: 'universal', artifactDir: dir, artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'desktop_release_manifest_mismatch' });

    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_MAC, arch: 'arm64', artifactDir: dir, artifactCatalog: catalog,
    })).toEqual({ configured: true, available: true });

    // Once both match, x64, arm64, universal, and unrecognized (`unknown`) macOS arches are all available;
    // linux `unknown` still stays refused (`executable_not_built`).
    writeMacManifest('x64', sha256(macUniversal));
    for (const arch of ['x64', 'arm64', 'universal', 'unknown']) {
      expect(await checkControlledNodeUpgradeArtifactAvailability({
        os: CONTROLLED_NODE_OS_MAC, arch, artifactDir: dir, artifactCatalog: catalog,
      })).toEqual({ configured: true, available: true });
    }
    expect(await checkControlledNodeUpgradeArtifactAvailability({
      os: CONTROLLED_NODE_OS_LINUX, arch: 'unknown', artifactDir: dir, artifactCatalog: catalog,
    })).toEqual({ configured: true, available: false, reason: 'executable_not_built' });

    // Unilateral partial macOS release manifest publication (in either direction) rejects unknown/universal macOS arch.
    rmSync(join(dir, 'desktop-release-darwin-x64.manifest.json'));
    for (const arch of ['universal', 'unknown']) {
      expect(await checkControlledNodeUpgradeArtifactAvailability({
        os: CONTROLLED_NODE_OS_MAC, arch, artifactDir: dir, artifactCatalog: catalog,
      })).toEqual({ configured: true, available: false, reason: 'desktop_release_manifest_invalid' });
    }

    writeMacManifest('x64', sha256(macUniversal));
    rmSync(join(dir, 'desktop-release-darwin-arm64.manifest.json'));
    for (const arch of ['universal', 'unknown']) {
      expect(await checkControlledNodeUpgradeArtifactAvailability({
        os: CONTROLLED_NODE_OS_MAC, arch, artifactDir: dir, artifactCatalog: catalog,
      })).toEqual({ configured: true, available: false, reason: 'desktop_release_manifest_invalid' });
    }
  });
});
