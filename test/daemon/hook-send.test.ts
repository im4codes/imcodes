/**
 * Tests for hook server /send endpoint.
 * Covers: target resolution, queue-when-busy, circuit breakers, Content-Type, body size.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// ── Mocks ──────────────────────────────────────────────────────────────────

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const timelineEmitMock = vi.hoisted(() => vi.fn(() => ({})));
const sendKeysMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const capturePane = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const getTransportRuntimeMock = vi.hoisted(() => vi.fn());
const refreshSessionWatcherMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: sendKeysMock,
  capturePane: capturePane,
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatus: vi.fn(() => 'idle'),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
}));

vi.mock('../../src/daemon/watcher-controls.js', () => ({
  refreshSessionWatcher: refreshSessionWatcherMock,
}));

import { startHookServer, clearQueues, getQueue, resolveTarget } from '../../src/daemon/hook-server.js';
import { detectStatus } from '../../src/agent/detect.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function postSend(port: number, body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode!, body: { raw: body } }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postRaw(port: number, path: string, body: string, contentType?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Length': String(Buffer.byteLength(body)) };
    if (contentType) headers['Content-Type'] = contentType;
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let respBody = '';
      res.on('data', (chunk) => { respBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: respBody }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown>) {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/proj',
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('Hook server /send endpoint', () => {
  let server: http.Server;
  let port: number;
  const hookCallback = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    refreshSessionWatcherMock.mockReset();
    refreshSessionWatcherMock.mockResolvedValue(false);
    const result = await startHookServer(hookCallback);
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  // ── Content-Type validation ──────────────────────────────────────────────

  describe('Content-Type validation', () => {
    it('rejects /send with non-JSON content type', async () => {
      const res = await postRaw(port, '/send', 'hello', 'text/plain');
      expect(res.status).toBe(415);
    });

    it('rejects /send with no content type', async () => {
      const res = await postRaw(port, '/send', '{}');
      expect(res.status).toBe(415);
    });

    it('accepts /send with application/json', async () => {
      getSessionMock.mockReturnValue(makeSession({ name: 'deck_proj_brain' }));
      listSessionsMock.mockReturnValue([
        makeSession({ name: 'deck_proj_brain' }),
        makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex' }),
      ]);

      const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'test' });
      // It should not be 415 — either 200 or 404 depending on resolution
      expect(res.status).not.toBe(415);
    });

    it('accepts /send with application/json; charset=utf-8', async () => {
      getSessionMock.mockReturnValue(null);
      const res = await postRaw(port, '/send', JSON.stringify({ from: 'x', to: 'y', message: 'z' }), 'application/json; charset=utf-8');
      // Should not be 415 (will be 404 since from session not found)
      expect(res.status).not.toBe(415);
    });
  });

  // ── Body size limit ──────────────────────────────────────────────────────

  describe('Body size limit', () => {
    it('rejects body exceeding 1MB', async () => {
      const largeBody = JSON.stringify({ from: 'x', to: 'y', message: 'a'.repeat(1024 * 1024 + 1) });
      const res = await postRaw(port, '/send', largeBody, 'application/json');
      expect(res.status).toBe(413);
    });
  });

  // ── Required field validation ────────────────────────────────────────────

  describe('Required fields', () => {
    it('rejects when from is missing', async () => {
      const res = await postSend(port, { to: 'target', message: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects when to is missing', async () => {
      const res = await postSend(port, { from: 'src', message: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects when message is missing', async () => {
      const res = await postSend(port, { from: 'src', to: 'target' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  // ── Target resolution ────────────────────────────────────────────────────

  describe('Target resolution', () => {
    const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code', label: 'Brain' });
    const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex', label: 'Coder' });
    const w2 = makeSession({ name: 'deck_proj_w2', role: 'w2', agentType: 'gemini', label: 'Reviewer' });
    const w3 = makeSession({ name: 'deck_proj_w3', role: 'w1', agentType: 'codex', label: 'Coder2' });

    it('resolves by label (case-insensitive)', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1, w2]);

      const result = resolveTarget('deck_proj_brain', 'coder');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targets[0].name).toBe('deck_proj_w1');
    });

    it('resolves by session name (exact)', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1, w2]);

      const result = resolveTarget('deck_proj_brain', 'deck_proj_w2');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targets[0].name).toBe('deck_proj_w2');
    });

    it('resolves by agent type (single match)', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1, w2]);

      const result = resolveTarget('deck_proj_brain', 'gemini');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targets[0].name).toBe('deck_proj_w2');
    });

    it('returns error on ambiguous agent type match', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1, w3]);

      const result = resolveTarget('deck_proj_brain', 'codex');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('ambiguous');
    });

    it('returns error when target not found', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1]);

      const result = resolveTarget('deck_proj_brain', 'nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not found');
        expect(result.available).toBeDefined();
      }
    });

    it('resolves --all to all siblings (up to 8)', () => {
      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, w1, w2]);

      const result = resolveTarget('deck_proj_brain', '--all');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targets.length).toBe(2); // w1 and w2 (brain excluded)
    });

    it('returns error when sender not found in store', () => {
      getSessionMock.mockReturnValue(null);
      const result = resolveTarget('nonexistent', 'target');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('sender session not found');
    });
  });

  describe('/notify idle refresh', () => {
    it('refreshes the registered watcher before emitting idle for claude-code', async () => {
      getSessionMock.mockReturnValue(makeSession({ name: 'deck_proj_brain', agentType: 'claude-code' }));
      refreshSessionWatcherMock.mockResolvedValue(true);

      const res = await postRaw(port, '/notify', JSON.stringify({ event: 'idle', session: 'deck_proj_brain', agentType: 'claude-code' }), 'application/json');

      expect(res.status).toBe(200);
      expect(refreshSessionWatcherMock).toHaveBeenCalledWith('deck_proj_brain');
      expect(timelineEmitMock).toHaveBeenCalledWith('deck_proj_brain', 'session.state', { state: 'idle' }, { source: 'hook' });
    });
  });

  // ── Successful delivery ──────────────────────────────────────────────────

  describe('Successful delivery', () => {
    it('delivers message to idle process session via sendKeys', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex' });

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_brain') return brain;
        if (name === 'deck_proj_w1') return w1;
        return null;
      });
      listSessionsMock.mockReturnValue([brain, w1]);
      vi.mocked(detectStatus).mockReturnValue('idle');

      const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'hello' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.delivered).toBe(true);
      expect(res.body.target).toBe('deck_proj_w1');
      expect(sendKeysMock).toHaveBeenCalledWith('deck_proj_w1', 'hello');
    });

    it('delivers message to transport session via runtime.send()', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const transport = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'openclaw', runtimeType: 'transport' });

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_brain') return brain;
        if (name === 'deck_proj_w1') return transport;
        return null;
      });
      listSessionsMock.mockReturnValue([brain, transport]);

      const mockRuntime = { send: vi.fn().mockResolvedValue(undefined), getStatus: vi.fn().mockReturnValue('idle') };
      getTransportRuntimeMock.mockReturnValue(mockRuntime);

      const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'hello transport' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.delivered).toBe(true);
      expect(mockRuntime.send).toHaveBeenCalledWith('hello transport');
      expect(typeof mockRuntime.send.mock.calls[0][0]).toBe('string');
    });
  });

  // ── Queue-when-busy (disabled — messages always delivered immediately) ───

  describe.skip('Queue-when-busy', () => {
    it('queues message when target is busy', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex' });

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_brain') return brain;
        if (name === 'deck_proj_w1') return w1;
        return null;
      });
      listSessionsMock.mockReturnValue([brain, w1]);
      vi.mocked(detectStatus).mockReturnValue('thinking');

      const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'queued msg' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.queued).toBe(true);
      expect(sendKeysMock).not.toHaveBeenCalled();

      // Verify it's in the queue
      const queue = getQueue('deck_proj_w1');
      expect(queue).toHaveLength(1);
      expect(queue[0].message).toBe('queued msg');
    });

    it('rejects when queue is full (10 messages)', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex' });
      // Use multiple different sources to avoid rate limit
      const sources = Array.from({ length: 11 }, (_, i) =>
        makeSession({ name: `deck_proj_src${i}`, role: 'brain', agentType: 'claude-code' }),
      );

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_w1') return w1;
        return sources.find((s) => s.name === name) ?? brain;
      });
      listSessionsMock.mockReturnValue([brain, w1, ...sources]);
      vi.mocked(detectStatus).mockReturnValue('thinking');

      // Fill queue with messages from different senders (avoids rate limit)
      for (let i = 0; i < 10; i++) {
        const res = await postSend(port, { from: `deck_proj_src${i}`, to: 'deck_proj_w1', message: `msg ${i}` });
        expect(res.body.queued).toBe(true);
      }

      expect(getQueue('deck_proj_w1')).toHaveLength(10);

      // 11th message from a new sender should fail because queue is full
      const res = await postSend(port, { from: 'deck_proj_src10', to: 'deck_proj_w1', message: 'overflow' });
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });
  });

  // ── Queue drain (disabled — no queue) ───────────────────────────────────

  describe.skip('Queue drain', () => {
    it('drains queued messages when session becomes idle via /notify', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'claude-code' });

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_brain') return brain;
        if (name === 'deck_proj_w1') return w1;
        return null;
      });
      listSessionsMock.mockReturnValue([brain, w1]);

      // Queue a message (target busy)
      vi.mocked(detectStatus).mockReturnValue('thinking');
      await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'drain me' });

      expect(getQueue('deck_proj_w1')).toHaveLength(1);
      expect(sendKeysMock).not.toHaveBeenCalled();

      // Trigger idle notification for w1
      const notifyData = JSON.stringify({ event: 'idle', session: 'deck_proj_w1' });
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/notify', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(notifyData.length) },
        }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(notifyData);
        req.end();
      });

      // Give async drain a moment
      await new Promise((r) => setTimeout(r, 50));

      // Queue should be drained and message sent
      expect(getQueue('deck_proj_w1')).toHaveLength(0);
      expect(sendKeysMock).toHaveBeenCalledWith('deck_proj_w1', 'drain me');
    });
  });

  // ── Circuit breakers ─────────────────────────────────────────────────────

  describe('Circuit breakers', () => {
    it('rejects when depth >= 3', async () => {
      const res = await postSend(port, { from: 'src', to: 'dst', message: 'hi', depth: 3 });
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('depth limit');
    });

    it('rejects when rate limit exceeded (> 10 per minute)', async () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      const w1 = makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'codex' });

      getSessionMock.mockImplementation((name: string) => {
        if (name === 'deck_proj_brain') return brain;
        if (name === 'deck_proj_w1') return w1;
        return null;
      });
      listSessionsMock.mockReturnValue([brain, w1]);
      vi.mocked(detectStatus).mockReturnValue('idle');

      // Send 10 messages (should all succeed)
      for (let i = 0; i < 10; i++) {
        const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: `msg ${i}` });
        expect(res.body.ok).toBe(true);
      }

      // 11th should be rate limited
      const res = await postSend(port, { from: 'deck_proj_brain', to: 'deck_proj_w1', message: 'overflow' });
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('rate limit');
    });

    it('broadcast caps at 8 recipients', () => {
      const brain = makeSession({ name: 'deck_proj_brain', role: 'brain', agentType: 'claude-code' });
      // Create 10 siblings
      const siblings = Array.from({ length: 10 }, (_, i) =>
        makeSession({ name: `deck_proj_w${i + 1}`, role: `w${i + 1}`, agentType: 'codex' }),
      );

      getSessionMock.mockReturnValue(brain);
      listSessionsMock.mockReturnValue([brain, ...siblings]);

      const result = resolveTarget('deck_proj_brain', '--all');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targets.length).toBe(8);
    });
  });

  // ── /notify backward compatibility ───────────────────────────────────────

  describe('/notify backward compat', () => {
    it('existing /notify idle hook still works', async () => {
      getSessionMock.mockReturnValue(makeSession({ name: 'deck_cd_brain', agentType: 'claude-code' }));

      const data = JSON.stringify({ event: 'idle', session: 'deck_cd_brain' });
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/notify', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length) },
        }, (resp) => {
          let body = '';
          resp.on('data', (chunk) => { body += chunk; });
          resp.on('end', () => resolve({ status: resp.statusCode!, body }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(res.status).toBe(200);
      expect(res.body).toBe('ok');
      expect(hookCallback).toHaveBeenCalledWith(expect.objectContaining({ event: 'idle' }));
    });

    it('/notify works without Content-Type header', async () => {
      getSessionMock.mockReturnValue(makeSession({ name: 'deck_cd_brain', agentType: 'claude-code' }));

      const data = JSON.stringify({ event: 'tool_start', session: 'deck_cd_brain', tool: 'Read' });
      const res = await postRaw(port, '/notify', data); // No Content-Type
      // /notify should still work without Content-Type
      expect(res.status).toBe(200);
    });
  });
});
