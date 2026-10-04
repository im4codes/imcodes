import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';

const downloadMock = vi.fn();
const selectMock = vi.fn();
const promoteMock = vi.fn();

vi.mock('../../src/node/self-upgrade.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/node/self-upgrade.js')>()),
  downloadControlledNodeMacosRemoteDesktopComponentSet: downloadMock,
}));
vi.mock('../../src/node/macos-remote-desktop-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/node/macos-remote-desktop-artifact.js')>()),
  selectMacosRemoteDesktopArtifact: selectMock,
  promoteMacosRemoteDesktopArtifact: promoteMock,
}));

const { createControlledNodeRuntime } = await import('../../src/node/runtime.js');

class MockSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

const tempDirs: string[] = [];
afterEach(async () => {
  delete process.env.IMCODES_REMOTE_DESKTOP_ENABLED;
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function worker() {
  return {
    available: vi.fn(() => true),
    adapterCapabilities: vi.fn(() => []),
    sessionCapabilities: vi.fn(() => ['remote.desktop'] as string[]),
    activeConnections: vi.fn(() => []),
    handle: vi.fn(async () => false),
    close: vi.fn(),
  };
}

async function runRefresh(currentVersion: string | null, targetVersion: string) {
  process.env.IMCODES_REMOTE_DESKTOP_ENABLED = '1';
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-runtime-refresh-'));
  tempDirs.push(root);
  const manifestPath = join(root, 'imcodes-remote-desktop.manifest.json');
  await writeFile(manifestPath, JSON.stringify({ workerVersion: targetVersion }));
  downloadMock.mockResolvedValue({
    componentDirectory: root,
    manifestPath,
    artifactSha256: 'b'.repeat(64),
  });
  selectMock.mockResolvedValue(currentVersion ? { manifest: { workerVersion: currentVersion } } : null);
  promoteMock.mockResolvedValue({ setSha256: 'a'.repeat(64) });
  const socket = new MockSocket();
  const runtime = createControlledNodeRuntime({
    serverUrl: 'https://im.example', serverId: 'mac-runtime', token: 'secret', nodeRole: 'controlled',
  }, () => socket as never, {
    platform: 'darwin',
    arch: 'arm64',
    remoteDesktopWorker: worker(),
    macosRemoteDesktopComponentsInstalled: async () => false,
  });
  runtime.start();
  socket.open();
  socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
  await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw)).some((message) => (
    message.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS
    && (message.phase === 'succeeded' || message.phase === 'failed')
  ))).toBe(true));
  const statuses = socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS);
  runtime.stop();
  return { statuses, promoteCalls: promoteMock.mock.calls.length };
}

describe('macOS independent remote-desktop worker refresh', () => {
  it('installs a newer signed component set while the daemon carrier stays stale', async () => {
    const result = await runRefresh('2026.8.3510-dev.3935', '2026.10.5371-dev.5816');
    expect(result.statuses.map((status) => status.phase)).toEqual(['started', 'succeeded']);
    expect(result.statuses[1]).toEqual(expect.objectContaining({
      installedVersion: '2026.10.5371-dev.5816',
      targetVersion: '2026.10.5371-dev.5816',
      artifactSha256: 'a'.repeat(64),
    }));
    expect(result.promoteCalls).toBe(1);
  });

  it.each([
    ['2026.10.5371-dev.5816', 'worker_current'],
    ['2026.11.5371-dev.5816', 'worker_downgrade_rejected'],
  ])('rejects a current or downgrade component set without promotion (%s)', async (currentVersion, reason) => {
    const result = await runRefresh(currentVersion, '2026.10.5371-dev.5816');
    expect(result.statuses.map((status) => status.phase)).toEqual(['started', 'failed']);
    expect(result.statuses[1]).toEqual(expect.objectContaining({
      targetVersion: '2026.10.5371-dev.5816',
      reason,
    }));
    expect(result.promoteCalls).toBe(0);
  });
});
