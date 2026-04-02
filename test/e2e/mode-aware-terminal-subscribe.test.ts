/**
 * E2E tests for mode-aware terminal subscriptions.
 *
 * Covers the real tmux -> terminalStreamer -> daemon command handler -> bridge -> browser path
 * using:
 * - a real tmux session
 * - real daemon-side terminal subscriptions via handleWebCommand()
 * - a real WsBridge instance
 * - browser-side mock WebSockets
 *
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { newSession, killSession, sendKeys } from '../../src/agent/tmux.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import type { ServerLink } from '../../src/daemon/server-link.js';
import { WsBridge } from '../../server/src/ws/bridge.js';
import { sha256Hex } from '../../server/src/security/crypto.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const SESSION = `deck_modeawaree2e${RUN_ID}_brain`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function waitForCondition(check: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

class MockBrowserWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason ?? ''));
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }

  get sentBuffers(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}

class MockDaemonWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  constructor(private onCommand: (msg: Record<string, unknown>) => void) {
    super();
  }

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    if (typeof data === 'string') {
      try {
        this.onCommand(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // ignore malformed test payloads
      }
    }
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', code, reason ?? '');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

function makeDaemonDb() {
  const tokenHash = sha256Hex('valid-token');
  return {
    queryOne: async () => ({ token_hash: tokenHash }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../../server/src/db/client.js').Database;
}

async function setupBridgeHarness(serverId: string) {
  const bridge = WsBridge.get(serverId);
  let daemonWs!: MockDaemonWs;
  const serverLink = {
    send: (msg: unknown) => {
      daemonWs.emit('message', JSON.stringify(msg), false);
    },
    sendBinary: (data: Buffer) => {
      daemonWs.emit('message', data, true);
    },
  } as ServerLink;

  daemonWs = new MockDaemonWs((msg) => {
    handleWebCommand(msg, serverLink);
  });

  bridge.handleDaemonConnection(daemonWs as never, makeDaemonDb(), {} as never);
  daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'valid-token' }), false);
  await flushAsync();

  return { bridge, daemonWs };
}

function hasTerminalDiff(browser: MockBrowserWs): boolean {
  return browser.sentStrings.some((s) => {
    try { return (JSON.parse(s) as { type?: string }).type === 'terminal.diff'; } catch { return false; }
  });
}

describe.skipIf(SKIP)('mode-aware terminal subscribe e2e', () => {
  beforeEach(async () => {
    await killSession(SESSION).catch(() => {});
    await newSession(SESSION, 'bash', { cwd: '/tmp' });
    await wait(400);
  });

  afterEach(async () => {
    await killSession(SESSION).catch(() => {});
    WsBridge.getAll().clear();
  });

  it('routes binary only to raw subscribers and stops binary after downgrade', async () => {
    const serverId = `modeaware-${Math.random().toString(36).slice(2)}`;
    const { bridge } = await setupBridgeHarness(serverId);

    const passive = new MockBrowserWs();
    const active = new MockBrowserWs();
    bridge.handleBrowserConnection(passive as never, 'user-passive', null as never);
    bridge.handleBrowserConnection(active as never, 'user-active', null as never);

    passive.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: SESSION, raw: false }));
    active.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: SESSION, raw: true }));
    await waitForCondition(() => hasTerminalDiff(passive) && hasTerminalDiff(active), 8000);

    passive.sent.length = 0;
    active.sent.length = 0;

    await sendKeys(SESSION, `echo MODE_AWARE_E2E_${RUN_ID}_ONE`);
    await waitForCondition(() => active.sentBuffers.length > 0, 8000);

    expect(passive.sentBuffers).toHaveLength(0);
    expect(active.sentBuffers.length).toBeGreaterThan(0);

    passive.sent.length = 0;
    active.sent.length = 0;

    active.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: SESSION, raw: false }));
    await flushAsync();
    await wait(150);

    await sendKeys(SESSION, `echo MODE_AWARE_E2E_${RUN_ID}_TWO`);
    await wait(1200);

    expect(passive.sentBuffers).toHaveLength(0);
    expect(active.sentBuffers).toHaveLength(0);

    passive.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: SESSION }));
    active.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: SESSION }));
    await flushAsync();
  }, 20_000);

  it('preserves effective raw mode across daemon reconnect', async () => {
    const serverId = `modeaware-${Math.random().toString(36).slice(2)}`;
    const setup1 = await setupBridgeHarness(serverId);
    const bridge = setup1.bridge;

    const passive = new MockBrowserWs();
    const active = new MockBrowserWs();
    bridge.handleBrowserConnection(passive as never, 'user-passive', null as never);
    bridge.handleBrowserConnection(active as never, 'user-active', null as never);

    passive.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: SESSION, raw: false }));
    active.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: SESSION, raw: true }));
    await waitForCondition(() => hasTerminalDiff(passive) && hasTerminalDiff(active), 8000);

    setup1.daemonWs.close();
    await flushAsync();

    const setup2 = await setupBridgeHarness(serverId);
    expect(setup2.daemonWs.sentStrings.some((s) => s.includes('"type":"terminal.subscribe"') && s.includes(`"session":"${SESSION}"`) && s.includes('"raw":true'))).toBe(true);

    passive.sent.length = 0;
    active.sent.length = 0;

    await sendKeys(SESSION, `echo MODE_AWARE_E2E_${RUN_ID}_RECONNECT`);
    await waitForCondition(() => active.sentBuffers.length > 0, 8000);

    expect(passive.sentBuffers).toHaveLength(0);
    expect(active.sentBuffers.length).toBeGreaterThan(0);

    passive.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: SESSION }));
    active.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: SESSION }));
    await flushAsync();
  }, 20_000);
});
