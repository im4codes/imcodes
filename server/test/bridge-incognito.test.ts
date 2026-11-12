import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
  randomHex: (bytes: number) => 'a'.repeat(bytes * 2),
  signJwt: (payload: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`,
  verifyJwt: () => null,
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

import { WsBridge } from '../src/ws/bridge.js';
import logger from '../src/util/logger.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      callback?.(new Error('closed'));
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

async function flushAsync() {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => process.nextTick(r));
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 6; i += 1) await new Promise((r) => process.nextTick(r));
}

describe('server WsBridge incognito privacy isolation (F3)', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `srv-incognito-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.restoreAllMocks();
  });

  async function setupBridge() {
    const executedSql: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      queryOne: async (sql: string) => {
        if (sql.includes('FROM sessions WHERE')) return { ok: 1 };
        return {
          token_hash: 'valid-hash',
          owner_status: 'active',
          node_role: 'full',
          os: null,
          revoked_at: null,
          user_id: 'u1',
        };
      },
      query: async () => [],
      execute: async (sql: string, params: unknown[] = []) => {
        executedSql.push({ sql, params });
        return { changes: 1 };
      },
      exec: async () => {},
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
      close: () => {},
    };

    const bridge = WsBridge.get(serverId);
    const daemonWs = new MockWs();
    const browserWs = new MockWs();

    bridge.handleDaemonConnection(daemonWs as never, db as never, {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'secret-token' }));
    bridge.handleBrowserConnection(browserWs as never, 'u1', db as never);
    await flushAsync();
    browserWs.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.SUBSCRIBE,
      sessionName: 'deck_priv_brain',
      mode: 'full',
    }));
    await flushAsync();

    return { bridge, daemonWs, browserWs, executedSql };
  }

  it('blocks session_text_tail_cache DB writes, recentText caching, sub_sessions sync, and plaintext logs for incognito sessions', async () => {
    const { bridge, daemonWs, browserWs, executedSql } = await setupBridge();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 1. Authoritative session_list announces incognito session
    daemonWs.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [{ name: 'deck_priv_brain', state: 'running', incognito: true }],
    }));
    await flushAsync();

    // 2. Incognito timeline.event (user.message + assistant.text) arrives from daemon
    daemonWs.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        eventId: 'ev-priv-1',
        sessionId: 'deck_priv_brain',
        ts: Date.now(),
        seq: 1,
        epoch: 1,
        type: 'user.message',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'TOP-SECRET-PROMPT-XYZ', incognito: true },
      },
    }));
    daemonWs.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        eventId: 'ev-priv-2',
        sessionId: 'deck_priv_brain',
        ts: Date.now(),
        seq: 2,
        epoch: 1,
        type: 'assistant.text',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'TOP-SECRET-REPLY-XYZ', streaming: false, incognito: true },
      },
    }));

    // 3. Incognito subsession.sync must not touch sub_sessions DB
    daemonWs.emit('message', JSON.stringify({
      type: 'subsession.sync',
      id: 'sub-priv-1',
      sessionType: 'claude-code-sdk',
      parentSession: 'deck_priv_brain',
      incognito: true,
    }));

    // 4. Browser sends message to incognito session (when daemon is mid-send / offline error branch)
    browserWs.emit('message', JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_priv_brain',
      commandId: 'cmd-priv-1',
      text: 'TOP-SECRET-BROWSER-SEND-XYZ',
    }));

    daemonWs.emit('message', JSON.stringify({
      type: 'session_event',
      event: 'error',
      session: 'deck_priv_brain',
      message: 'TOP-SECRET-ERROR-XYZ',
    }));

    await flushAsync();

    // Assert zero session_text_tail_cache / sub_sessions DB writes
    const cacheWrites = executedSql.filter((q) => q.sql.includes('session_text_tail_cache'));
    const subSessionWrites = executedSql.filter((q) => q.sql.includes('sub_sessions'));
    expect(cacheWrites).toEqual([]);
    expect(subSessionWrites).toEqual([]);

    // Assert watch/recent text returns []
    expect(bridge.getRecentText('deck_priv_brain')).toEqual([]);
    await expect(bridge.getRecentTextForWatch('deck_priv_brain', 50)).resolves.toEqual([]);

    // Assert subscribed browser STILL receives live timeline events in transit
    const browserFrames = browserWs.sent.map((item) => String(item)).join('\n');
    expect(browserFrames).toContain('TOP-SECRET-REPLY-XYZ');

    // Assert zero private plaintext hit server logger
    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
    expect(allLogs).not.toContain('TOP-SECRET-PROMPT-XYZ');
    expect(allLogs).not.toContain('TOP-SECRET-REPLY-XYZ');
    expect(allLogs).not.toContain('TOP-SECRET-BROWSER-SEND-XYZ');

    // 5. Transition same session name back to normal via session_list -> writes cleanly
    daemonWs.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [{ name: 'deck_priv_brain', state: 'running', incognito: false }],
    }));
    daemonWs.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        eventId: 'ev-norm-1',
        sessionId: 'deck_priv_brain',
        ts: Date.now(),
        seq: 1,
        epoch: 2,
        type: 'assistant.text',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'ORDINARY-REPLY-OK', streaming: false },
      },
    }));

    await flushAsync();
    expect(bridge.getRecentText('deck_priv_brain').map((r) => r.text)).toContain('ORDINARY-REPLY-OK');
    const normalWrites = executedSql.filter((q) => q.sql.includes('session_text_tail_cache'));
    expect(normalWrites.length).toBeGreaterThan(0);

    // Sanity check logger itself is still active for ordinary calls
    logger.info({ tag: 'normal-control' }, 'ordinary log check');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('normal-control');
  });
});
