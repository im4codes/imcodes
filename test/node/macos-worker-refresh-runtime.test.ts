import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

const downloadMacSet = vi.fn();
const promoteMacSet = vi.fn();
const selectMacSet = vi.fn();

vi.mock('../../src/node/self-upgrade.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/node/self-upgrade.js')>()),
  downloadControlledNodeMacosRemoteDesktopComponentSet: downloadMacSet,
}));
vi.mock('../../src/node/macos-remote-desktop-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/node/macos-remote-desktop-artifact.js')>()),
  promoteMacosRemoteDesktopArtifact: promoteMacSet,
  selectMacosRemoteDesktopArtifact: selectMacSet,
}));

const { createControlledNodeRuntime } = await import('../../src/node/runtime.js');

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('macOS worker refresh runtime', () => {
  it('checks the hosted sidecar even when stale daemon release is already installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-mac-worker-refresh-'));
    tempDirs.push(root);
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ workerVersion: '2026.10.5371-dev.5816' }));
    downloadMacSet.mockResolvedValue({
      componentDirectory: join(root, 'components'),
      manifestPath,
      artifactSha256: 'a'.repeat(64),
    });
    selectMacSet.mockResolvedValue({ manifest: { workerVersion: '2026.9.5113-dev.5644' } });
    promoteMacSet.mockResolvedValue({ setSha256: 'b'.repeat(64) });
    const socket = new MockSocket();
    const worker = {
      available: vi.fn(() => true),
      sessionCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPABILITY]),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example', serverId: 'mac-refresh-runtime', token: 'secret', nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'darwin', arch: 'arm64', remoteDesktopWorker: worker,
      macosRemoteDesktopComponentsInstalled: async () => true,
      now: () => 10_000,
    });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => expect(downloadMacSet).toHaveBeenCalledOnce());
    expect(downloadMacSet.mock.calls[0]?.[0]).not.toHaveProperty('expectedVersion');
    await vi.waitFor(() => {
      const statuses = socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS);
      expect(statuses.at(-1)).toEqual(expect.objectContaining({ phase: 'succeeded', targetVersion: '2026.10.5371-dev.5816', artifactSha256: 'b'.repeat(64) }));
    });
    expect(promoteMacSet).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('reports the current-worker rejection without promoting an equal sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-mac-worker-refresh-current-'));
    tempDirs.push(root);
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ workerVersion: '2026.9.5113-dev.5644' }));
    downloadMacSet.mockResolvedValue({
      componentDirectory: join(root, 'components'),
      manifestPath,
      artifactSha256: 'c'.repeat(64),
    });
    selectMacSet.mockResolvedValue({ manifest: { workerVersion: '2026.9.5113-dev.5644' } });
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example', serverId: 'mac-refresh-current', token: 'secret', nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'darwin', arch: 'arm64',
      remoteDesktopWorker: { available: vi.fn(() => true), sessionCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPABILITY]), close: vi.fn() },
      macosRemoteDesktopComponentsInstalled: async () => true,
      now: () => 10_000,
    });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => {
      const statuses = socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS);
      expect(statuses.at(-1)).toEqual(expect.objectContaining({ phase: 'failed', targetVersion: '2026.9.5113-dev.5644', reason: 'worker_current' }));
    });
    expect(promoteMacSet).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('rejects a downgrade and preserves the installed sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-mac-worker-refresh-downgrade-'));
    tempDirs.push(root);
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ workerVersion: '2026.9.5113-dev.5644' }));
    downloadMacSet.mockResolvedValue({
      componentDirectory: join(root, 'components'),
      manifestPath,
      artifactSha256: 'd'.repeat(64),
    });
    selectMacSet.mockResolvedValue({ manifest: { workerVersion: '2026.10.5371-dev.5816' } });
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example', serverId: 'mac-refresh-downgrade', token: 'secret', nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'darwin', arch: 'arm64',
      remoteDesktopWorker: { available: vi.fn(() => true), sessionCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPABILITY]), close: vi.fn() },
      macosRemoteDesktopComponentsInstalled: async () => true,
      now: () => 10_000,
    });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => {
      const statuses = socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS);
      expect(statuses.at(-1)).toEqual(expect.objectContaining({ phase: 'failed', targetVersion: '2026.9.5113-dev.5644', reason: 'worker_downgrade_rejected' }));
    });
    expect(promoteMacSet).not.toHaveBeenCalled();
    runtime.stop();
  });
  describe('old worker release cleanup', () => {
    const open = (runtimeOptions: Record<string, unknown>, serverId: string) => {
      const socket = new MockSocket();
      const runtime = createControlledNodeRuntime({
        serverUrl: 'https://im.example', serverId, token: 'secret', nodeRole: NODE_ROLE.CONTROLLED,
      }, () => socket, {
        remoteDesktopWorker: { available: vi.fn(() => true), sessionCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPABILITY]), close: vi.fn() },
        macosRemoteDesktopComponentsInstalled: async () => true,
        now: () => 10_000,
        ...runtimeOptions,
      } as never);
      runtime.start();
      socket.open();
      return { socket, runtime };
    };

    it('starts once on the first authenticated heartbeat, not again on later ones, and waits while an install runs', async () => {
      const prune = vi.fn(async (_input: { isBusy: () => boolean }) => ({ removed: 3 }));
      selectMacSet.mockResolvedValue({ manifest: { workerVersion: '2026.9.5113-dev.5644' } });
      downloadMacSet.mockResolvedValue(undefined);
      const { socket, runtime } = open({ platform: 'darwin', arch: 'arm64', pruneMacosRemoteDesktopReleases: prune }, 'prune-start');
      expect(prune).not.toHaveBeenCalled();
      socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
      await vi.waitFor(() => expect(prune).toHaveBeenCalledOnce());
      socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
      socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prune).toHaveBeenCalledOnce();
      expect(typeof prune.mock.calls[0]![0].isBusy).toBe('function');
      runtime.stop();
    });

    it('runs again after a worker set was installed, and a failing cleanup changes nothing else', async () => {
      const root = await mkdtemp(join(tmpdir(), 'imcodes-mac-worker-prune-'));
      tempDirs.push(root);
      const manifestPath = join(root, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify({ workerVersion: '2026.10.5371-dev.5816' }));
      downloadMacSet.mockResolvedValue({ componentDirectory: join(root, 'components'), manifestPath, artifactSha256: 'a'.repeat(64) });
      selectMacSet.mockResolvedValue({ manifest: { workerVersion: '2026.9.5113-dev.5644' } });
      promoteMacSet.mockResolvedValue({ setSha256: 'b'.repeat(64) });
      const prune = vi.fn(async (_input: { isBusy: () => boolean }) => { throw new Error('disk exploded'); });
      const { socket, runtime } = open({ platform: 'darwin', arch: 'arm64', pruneMacosRemoteDesktopReleases: prune }, 'prune-after-install');
      socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
      await vi.waitFor(() => expect(promoteMacSet).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(prune.mock.calls.length).toBeGreaterThanOrEqual(1));
      await vi.waitFor(() => {
        const statuses = socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS);
        expect(statuses.at(-1)).toEqual(expect.objectContaining({ phase: 'succeeded' }));
      });
      runtime.stop();
    });

    it('never runs on a platform without this store', async () => {
      const prune = vi.fn(async () => ({ removed: 1 }));
      const { socket, runtime } = open({ platform: 'linux', arch: 'x64', pruneMacosRemoteDesktopReleases: prune }, 'prune-linux');
      socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(prune).not.toHaveBeenCalled();
      runtime.stop();
    });
  });
});
