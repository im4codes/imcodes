import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privacyMocks = vi.hoisted(() => ({
  getPrivacyState: vi.fn(),
  acknowledgeShield: vi.fn(),
  acknowledgeFreshFrame: vi.fn(),
  markRecoveryRequired: vi.fn(),
}));

vi.mock('../src/services/remote-desktop-management-privacy.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/services/remote-desktop-management-privacy.js')>()),
  getPrivacyState: privacyMocks.getPrivacyState,
  acknowledgeShield: privacyMocks.acknowledgeShield,
  acknowledgeFreshFrame: privacyMocks.acknowledgeFreshFrame,
  markRecoveryRequired: privacyMocks.markRecoveryRequired,
}));

import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import {
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRIVACY_PHASE,
  REMOTE_DESKTOP_SHELL_MSG,
  REMOTE_DESKTOP_SHELL_RECOVERY_REASON,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
} from '../../shared/remote-desktop-access.js';

class MockWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.emit('close'); }
}

const SERVER_ID = 'server-privacy-owner';
const HOST_ID = 'host-canonical-1';
const EPOCH_ID = 'epoch-privacy-0001';
const ROUTES = [{ routeId: 'route-privacy-0001', routeGeneration: 1 }] as const;
const NOW = 1_700_000_000_000;

function makeDb(): Database {
  const db = {
    queryOne: async (sql: string) => {
      if (sql.includes('clock_timestamp()')) return { now_ms: NOW };
      if (sql.includes('remote_desktop_host_endpoints')) return { host_id: HOST_ID, server_id: SERVER_ID };
      return {
        token_hash: createHash('sha256').update('my-token').digest('hex'),
        user_id: 'owner-1', node_role: 'controlled',
        revoked_at: null, os: 'win32',
      };
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => undefined,
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    close: async () => undefined,
  };
  return db as unknown as Database;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function connect(capabilities: readonly string[] = [REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY]): Promise<{ bridge: WsBridge; ws: MockWs; generation: number }> {
  const bridge = WsBridge.get(SERVER_ID);
  const ws = new MockWs();
  bridge.handleDaemonConnection(ws as never, makeDb(), {} as never);
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'auth', serverId: SERVER_ID, token: 'my-token',
    capabilities,
  })), false);
  await flush();
  return { bridge, ws, generation: bridge.daemonConnectionGeneration() };
}

function ack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
    hostId: HOST_ID,
    epochId: EPOCH_ID,
    revision: 3,
    workerGeneration: 9,
    routes: ROUTES,
    ...overrides,
  };
}

describe('management privacy authenticated node channel', () => {
  beforeEach(() => {
    WsBridge.setRemoteDesktopReconnectRevalidator(async () => undefined);
    privacyMocks.getPrivacyState.mockReset();
    privacyMocks.acknowledgeShield.mockReset();
    privacyMocks.acknowledgeFreshFrame.mockReset();
    privacyMocks.markRecoveryRequired.mockReset();
  });

  afterEach(() => {
    WsBridge.setRemoteDesktopReconnectRevalidator(null);
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  it('sends BEGIN only to the current capability/generation-bound daemon socket', async () => {
    const { bridge, ws, generation } = await connect();
    const message = {
      type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      revision: 3,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      deadlineAt: NOW + 5_000,
      routeSnapshot: [],
    } as const;
    expect(WsBridge.dispatchRemoteDesktopManagementPrivacy({
      executionServerId: SERVER_ID, daemonGeneration: generation, message,
    })).toBe(true);
    expect(ws.sent.map((item) => JSON.parse(item))).toContainEqual(message);
    expect(WsBridge.dispatchRemoteDesktopManagementPrivacy({
      executionServerId: SERVER_ID, daemonGeneration: generation - 1, message,
    })).toBe(false);

    const sentBeforeGenericBypass = ws.sent.length;
    bridge.sendToDaemon(JSON.stringify(message));
    expect(ws.sent).toHaveLength(sentBeforeGenericBypass);

    const droppedBeforeReverseInjection = WsBridge.invalidRemoteDesktopPrivacyFramesDropped;
    ws.emit('message', Buffer.from(JSON.stringify(message)), false);
    await flush();
    expect(WsBridge.invalidRemoteDesktopPrivacyFramesDropped)
      .toBe(droppedBeforeReverseInjection + 1);
  });

  it('advances STARTING only for a strict current exact-route acknowledgement', async () => {
    const { ws, generation } = await connect();
    privacyMocks.getPrivacyState.mockResolvedValue({
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 3,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.STARTING,
      executionServerId: SERVER_ID, daemonGeneration: generation,
    });
    ws.emit('message', Buffer.from(JSON.stringify(ack())), false);
    await flush();
    expect(privacyMocks.acknowledgeShield).toHaveBeenCalledWith(expect.anything(), {
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 3,
      executionServerId: SERVER_ID, daemonGeneration: generation,
      workerGeneration: 9, acknowledgedRoutes: ROUTES, now: NOW,
    });
    expect(privacyMocks.acknowledgeFreshFrame).not.toHaveBeenCalled();
  });

  it('maps ENDING acknowledgement to fresh-frame validation with the exact route set', async () => {
    const { ws, generation } = await connect();
    privacyMocks.getPrivacyState.mockResolvedValue({
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 3,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.ENDING,
      executionServerId: SERVER_ID, daemonGeneration: generation,
    });
    ws.emit('message', Buffer.from(JSON.stringify(ack({ workerGeneration: 10 }))), false);
    await flush();
    expect(privacyMocks.acknowledgeFreshFrame).toHaveBeenCalledWith(expect.anything(), {
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 3,
      executionServerId: SERVER_ID, daemonGeneration: generation,
      freshFrameGeneration: 10, acknowledgedRoutes: ROUTES, now: NOW,
    });
  });

  it('drops malformed, stale and wrong-owner acknowledgements without state advance', async () => {
    const { ws, generation } = await connect();
    privacyMocks.getPrivacyState.mockResolvedValue({
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 4,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.STARTING,
      executionServerId: SERVER_ID, daemonGeneration: generation,
    });
    ws.emit('message', Buffer.from(JSON.stringify(ack({ secret: 'must-not-pass' }))), false);
    ws.emit('message', Buffer.from(JSON.stringify(ack())), false);
    privacyMocks.getPrivacyState.mockResolvedValueOnce({
      hostId: HOST_ID, epochId: EPOCH_ID, revision: 3,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.STARTING,
      executionServerId: 'other-pod', daemonGeneration: generation,
    });
    ws.emit('message', Buffer.from(JSON.stringify(ack())), false);
    await flush();
    expect(privacyMocks.getPrivacyState).toHaveBeenCalledTimes(2);
    expect(privacyMocks.acknowledgeShield).not.toHaveBeenCalled();
    expect(privacyMocks.acknowledgeFreshFrame).not.toHaveBeenCalled();
  });

  it('resolves and dispatches a launch context only to the current signed-shell generation', async () => {
    const { bridge, ws, generation } = await connect([
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
    ]);
    const dispatcher = WsBridge.remoteDesktopShellLaunchContextDispatcher();
    await expect(dispatcher.currentControlledEndpoint({
      ownerUserId: 'owner-1', hostId: HOST_ID,
    })).resolves.toEqual({ serverId: SERVER_ID, endpointGeneration: generation });
    const context = {
      hostId: HOST_ID,
      launchId: 'launch-shell-0000000001',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      endpointGeneration: generation,
    };
    await expect(dispatcher.dispatch({
      ownerUserId: 'owner-1', hostId: HOST_ID, context,
      executionServerId: SERVER_ID, endpointGeneration: generation,
    })).resolves.toBe(true);
    expect(ws.sent.map((item) => JSON.parse(item))).toContainEqual({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH,
      context,
    });
    await expect(dispatcher.dispatch({
      ownerUserId: 'owner-1', hostId: HOST_ID, context,
      executionServerId: SERVER_ID, endpointGeneration: generation + 1,
    })).resolves.toBe(false);

    const dropped = WsBridge.invalidRemoteDesktopShellFramesDropped;
    ws.emit('message', Buffer.from(JSON.stringify({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH, context,
    })), false);
    await flush();
    expect(WsBridge.invalidRemoteDesktopShellFramesDropped).toBe(dropped + 1);
    expect(bridge).toBeDefined();
  });

  it('maps an exact current shell cleanup failure to durable recovery_required', async () => {
    const { ws, generation } = await connect([
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
    ]);
    privacyMocks.getPrivacyState.mockResolvedValue({
      hostId: HOST_ID, epochId: EPOCH_ID,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
      executionServerId: SERVER_ID, daemonGeneration: generation,
    });
    ws.emit('message', Buffer.from(JSON.stringify({
      type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      endpointGeneration: generation,
      reason: REMOTE_DESKTOP_SHELL_RECOVERY_REASON.CLIPBOARD_WATCHDOG_CRASHED,
    })), false);
    await flush();
    expect(privacyMocks.markRecoveryRequired).toHaveBeenCalledWith(expect.anything(), {
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      reason: REMOTE_DESKTOP_SHELL_RECOVERY_REASON.CLIPBOARD_WATCHDOG_CRASHED,
      now: NOW,
    });
  });
});
