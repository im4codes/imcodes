import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_FILENAME } from '../../shared/remote-desktop-worker.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_ERROR,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
} from '../../shared/remote-desktop-install.js';
import {
  DaemonRemoteDesktop,
  type DaemonRemoteDesktopDeps,
} from '../../src/daemon/remote-desktop-daemon.js';
import type { VerifiedRemoteDesktopWorkerArtifact } from '../../src/node/remote-desktop-worker-host.js';

const requestId = 'request_12345678';
const sessionId = 'session_12345678';
const capability = 'a'.repeat(43);
const root = '/home/tester/.imcodes';

const artifact = {
  executablePath: join(root, 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME),
  manifestPath: 'manifest',
  virtualDisplayDirectory: 'virtual-display',
  manifest: {},
} as unknown as VerifiedRemoteDesktopWorkerArtifact;

function prepareCommand(): Record<string, unknown> {
  return {
    type: REMOTE_DESKTOP_MSG.PREPARE,
    requestId,
    sessionId,
    capability,
    expiresAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() + 15_000,
    daemonGeneration: 7,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    inputEpoch: 0,
    iceServers: ['stun:stun.example.test:3478'],
  };
}

function fixture(overrides: Partial<DaemonRemoteDesktopDeps> & { installed?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const capabilityChanges: number[] = [];
  // Resolution reflects what is on disk: nothing until a download lands one.
  let resolved: VerifiedRemoteDesktopWorkerArtifact | null = overrides.installed ? artifact : null;
  const downloadWorker = vi.fn(async () => {
    resolved = artifact;
    return {
      workerDir: join(root, 'remote-desktop-worker', 'win32-x64'),
      artifactPath: artifact.executablePath,
      manifestPath: 'manifest',
      sha256: 'f'.repeat(64),
    };
  });
  const extractVirtualDisplay = vi.fn(async () => {});
  const capturedSigners: string[] = [];
  const host = { handle: vi.fn(async () => true), close: vi.fn() };
  const deps: DaemonRemoteDesktopDeps = {
    send: (message) => { sent.push(message); },
    onCapabilityChange: () => { capabilityChanges.push(Date.now()); },
    platform: 'win32',
    arch: 'x64',
    root,
    trustedSignerSha256: 'a'.repeat(64),
    loadCredential: async () => ({
      serverUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'token_1',
    }),
    downloadWorker: downloadWorker as unknown as DaemonRemoteDesktopDeps['downloadWorker'],
    extractVirtualDisplay,
    resolveArtifact: (_path: string, signer: string) => {
      capturedSigners.push(signer);
      return resolved;
    },
    createHost: () => host,
    ...overrides,
  };
  return {
    remoteDesktop: new DaemonRemoteDesktop(deps),
    sent,
    capabilityChanges,
    downloadWorker,
    extractVirtualDisplay,
    capturedSigners,
    host,
    states: () => sent
      .filter((message) => message.type === REMOTE_DESKTOP_INSTALL_MSG.STATE)
      .map((message) => message.state),
  };
}

describe('DaemonRemoteDesktop', () => {
  it('offers nothing on a platform that cannot serve remote control', () => {
    const f = fixture({ platform: 'darwin', arch: 'arm64' });
    expect(f.remoteDesktop.supported()).toBe(false);
    expect(f.remoteDesktop.capabilities()).toEqual([]);
    expect(f.remoteDesktop.installState()).toBe(REMOTE_DESKTOP_INSTALL_STATE.UNSUPPORTED);
  });

  it('offers nothing on Windows arm64, which has no worker build', () => {
    const f = fixture({ arch: 'arm64' });
    expect(f.remoteDesktop.capabilities()).toEqual([]);
  });

  it('still installs on an npm build, which carries no compiled publisher pin', async () => {
    // Requiring the pin here would only disable the feature: the bundle comes
    // from the very server that already drives this machine's agent sessions.
    const f = fixture({ trustedSignerSha256: '', readInstalledSigner: () => 'b'.repeat(64) });
    expect(f.remoteDesktop.supported()).toBe(true);
    await f.remoteDesktop.install();
    expect(f.remoteDesktop.capabilities()).toContain(REMOTE_DESKTOP_CAPABILITY);
  });

  it('verifies against the signer the bundle declares when there is no compiled pin', async () => {
    const f = fixture({ trustedSignerSha256: '', readInstalledSigner: () => 'b'.repeat(64) });
    await f.remoteDesktop.install();
    expect(f.capturedSigners).toContain('b'.repeat(64));
  });

  it('prefers the compiled pin over whatever the bundle declares', async () => {
    const f = fixture({ readInstalledSigner: () => 'b'.repeat(64) });
    await f.remoteDesktop.install();
    // A release build stays pinned; the bundle does not get to nominate itself.
    expect(f.capturedSigners).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  });

  it('rejects a bundle that declares no signer at all', async () => {
    const f = fixture({ trustedSignerSha256: '', readInstalledSigner: () => '' });
    await f.remoteDesktop.install();
    expect(f.sent.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
      error: REMOTE_DESKTOP_INSTALL_ERROR.VERIFICATION_FAILED,
    });
    expect(f.remoteDesktop.capabilities()).not.toContain(REMOTE_DESKTOP_CAPABILITY);
  });

  it('claims only installability until the worker is actually installed', () => {
    const f = fixture();
    expect(f.remoteDesktop.capabilities()).toEqual([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    expect(f.remoteDesktop.capabilities()).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(f.remoteDesktop.installState()).toBe(REMOTE_DESKTOP_INSTALL_STATE.MISSING);
  });

  it('claims the capability once a verified worker is present', () => {
    const f = fixture({ installed: true });
    expect(f.remoteDesktop.capabilities()).toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(f.remoteDesktop.installState()).toBe(REMOTE_DESKTOP_INSTALL_STATE.INSTALLED);
  });

  it('downloads, expands the virtual display, then re-advertises', async () => {
    const f = fixture();
    await f.remoteDesktop.install();

    expect(f.downloadWorker).toHaveBeenCalledTimes(1);
    expect(f.downloadWorker.mock.calls[0]![0]).toMatchObject({
      dir: root,
      target: { os: 'win', arch: 'x64' },
    });
    // The controlled node's upgrade script expands this archive; a daemon has
    // no such script, so the install must do it or verification fails closed.
    expect(f.extractVirtualDisplay).toHaveBeenCalledTimes(1);
    expect(f.states()).toEqual([
      REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING,
      REMOTE_DESKTOP_INSTALL_STATE.INSTALLED,
    ]);
    expect(f.remoteDesktop.capabilities()).toContain(REMOTE_DESKTOP_CAPABILITY);
    // Without this the daemon can serve remote control but is never asked to:
    // the server gates the feature on the advertised set.
    expect(f.capabilityChanges).toHaveLength(1);
  });

  it('joins a concurrent install instead of racing a second download', async () => {
    const f = fixture();
    await Promise.all([f.remoteDesktop.install(), f.remoteDesktop.install()]);
    expect(f.downloadWorker).toHaveBeenCalledTimes(1);
  });

  it('reports an unbound daemon rather than attempting a download', async () => {
    const f = fixture({ loadCredential: async () => null });
    await f.remoteDesktop.install();
    expect(f.downloadWorker).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
      error: REMOTE_DESKTOP_INSTALL_ERROR.NOT_BOUND,
    });
  });

  it('reports a server with no worker build for this platform', async () => {
    const f = fixture({
      downloadWorker: (async () => undefined) as unknown as DaemonRemoteDesktopDeps['downloadWorker'],
    });
    await f.remoteDesktop.install();
    expect(f.sent.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
      error: REMOTE_DESKTOP_INSTALL_ERROR.NOT_AVAILABLE,
    });
    expect(f.capabilityChanges).toHaveLength(0);
  });

  it('refuses to claim the capability when the downloaded bundle fails verification', async () => {
    const f = fixture({ resolveArtifact: () => null });
    await f.remoteDesktop.install();
    expect(f.sent.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
      error: REMOTE_DESKTOP_INSTALL_ERROR.VERIFICATION_FAILED,
    });
    expect(f.remoteDesktop.capabilities()).toEqual([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    expect(f.capabilityChanges).toHaveLength(0);
  });

  it('reports a failed download without leaving the install stuck', async () => {
    const f = fixture({
      downloadWorker: (async () => { throw new Error('network'); }) as unknown as DaemonRemoteDesktopDeps['downloadWorker'],
    });
    await f.remoteDesktop.install();
    expect(f.sent.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
      error: REMOTE_DESKTOP_INSTALL_ERROR.DOWNLOAD_FAILED,
    });
    expect(f.remoteDesktop.installState()).toBe(REMOTE_DESKTOP_INSTALL_STATE.MISSING);
  });

  it('answers signalling with a terminal frame while no worker is installed', async () => {
    const f = fixture();
    expect(await f.remoteDesktop.handle(prepareCommand())).toBe(true);
    expect(f.sent.at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE,
    });
  });

  it('stays silent when teardown arrives with no worker to tear down', async () => {
    const f = fixture();
    await f.remoteDesktop.handle({
      type: REMOTE_DESKTOP_MSG.STOP, requestId, sessionId, capability,
    });
    expect(f.sent).toHaveLength(0);
  });

  it('hands signalling to the worker once installed', async () => {
    const f = fixture({ installed: true });
    expect(await f.remoteDesktop.handle(prepareCommand())).toBe(true);
    expect(f.host.handle).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(0);
  });

  it('installs on request and leaves unrelated messages alone', async () => {
    const f = fixture();
    expect(await f.remoteDesktop.handle({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST })).toBe(true);
    expect(f.downloadWorker).toHaveBeenCalledTimes(1);
    expect(await f.remoteDesktop.handle({ type: 'session.send' })).toBe(false);
  });
});
