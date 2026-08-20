/**
 * Pairs the real relay against the real elevated host over a real socket. The
 * two halves are the only speakers of this protocol, and they run in different
 * processes at different privilege levels, so a drift between them would only
 * ever show up on a Windows box with login-screen control enabled.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';
import { ElevatedRemoteDesktopHost } from '../../src/node/remote-desktop-elevated-host.js';
import { ElevatedRemoteDesktopRelay } from '../../src/daemon/remote-desktop-elevated-relay.js';

const secret = 'a'.repeat(43);
const requestId = 'request_12345678';
const sessionId = 'session_12345678';
const capability = 'b'.repeat(43);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function prepareCommand(): RemoteDesktopDaemonCommand {
  return {
    type: REMOTE_DESKTOP_MSG.PREPARE,
    requestId,
    sessionId,
    capability,
    expiresAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() + 15_000,
    daemonGeneration: 4,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    inputEpoch: 0,
    iceServers: ['stun:stun.example.test:3478'],
  } as unknown as RemoteDesktopDaemonCommand;
}

async function pair(options: { accept?: boolean; relaySecret?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-elevated-pair-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const pipePath = join(dir, 'elevated.sock');
  const handled: unknown[] = [];
  const worker = {
    handle: async (command: unknown) => {
      handled.push(command);
      return options.accept ?? true;
    },
    close: vi.fn(),
  };
  const host = new ElevatedRemoteDesktopHost({ worker: worker as never, secret, pipePath });
  await host.listen();
  cleanup.push(() => host.close());
  const relayed: Array<Record<string, unknown>> = [];
  const relay = new ElevatedRemoteDesktopRelay({
    send: (message) => { relayed.push(message); },
    readSecret: async () => options.relaySecret ?? secret,
    pipePath,
    connectTimeoutMs: 1_000,
  });
  cleanup.push(() => relay.close());
  return { host, relay, handled, relayed, pipePath };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('elevated remote desktop relay', () => {
  it('carries a command to the privileged worker', async () => {
    const f = await pair();
    await expect(f.relay.handle(prepareCommand())).resolves.toBe(true);
    await waitFor(() => f.handled.length === 1, 'the command to arrive');
    expect(f.handled[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.PREPARE, sessionId });
  });

  it('carries the worker verdict back to the daemon', async () => {
    const f = await pair({ accept: false });
    await f.relay.handle(prepareCommand());
    await waitFor(() => f.relayed.length === 1, 'the terminal frame to come back');
    expect(f.relayed[0]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    });
  });

  it('reuses one connection across commands', async () => {
    const f = await pair();
    await expect(f.relay.handle(prepareCommand())).resolves.toBe(true);
    await expect(f.relay.handle(prepareCommand())).resolves.toBe(true);
    await waitFor(() => f.handled.length === 2, 'both commands');
  });

  it('reports failure rather than throwing when the secret is wrong', async () => {
    const f = await pair({ relaySecret: 'c'.repeat(43) });
    await expect(f.relay.handle(prepareCommand())).resolves.toBe(false);
    expect(f.handled).toHaveLength(0);
  });

  it('reports failure when no helper is listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-elevated-absent-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const relay = new ElevatedRemoteDesktopRelay({
      send: () => {},
      readSecret: async () => secret,
      pipePath: join(dir, 'missing.sock'),
      connectTimeoutMs: 500,
    });
    cleanup.push(() => relay.close());
    await expect(relay.handle(prepareCommand())).resolves.toBe(false);
  });

  it('retries after a failed attempt instead of caching it', async () => {
    const f = await pair();
    const relay = new ElevatedRemoteDesktopRelay({
      send: () => {},
      readSecret: vi.fn()
        .mockRejectedValueOnce(new Error('secret not written yet'))
        .mockResolvedValue(secret),
      pipePath: f.pipePath,
      connectTimeoutMs: 1_000,
    });
    cleanup.push(() => relay.close());
    // The helper may still be starting at boot; a first failure must not
    // poison every later command.
    await expect(relay.handle(prepareCommand())).resolves.toBe(false);
    await expect(relay.handle(prepareCommand())).resolves.toBe(true);
  });

  it('stops relaying once closed', async () => {
    const f = await pair();
    await f.relay.handle(prepareCommand());
    f.relay.close();
    await expect(f.relay.handle(prepareCommand())).resolves.toBe(false);
  });
});
