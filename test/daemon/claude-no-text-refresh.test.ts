import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { appendFile, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const events: Array<{ session: string; type: string; payload: Record<string, unknown> }> = [];
const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>) => {
      events.push({ session, type, payload });
      return {};
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/util/model-context.js', () => ({
  resolveContextWindow: vi.fn(() => 200000),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { startHookServer } from '../../src/daemon/hook-server.js';
import { startWatching, stopWatching, claudeProjectDir } from '../../src/daemon/jsonl-watcher.js';

function postNotify(port: number, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function assistantText(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'text', text }],
      model: 'claude-opus',
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })}\n`;
}

async function waitUntil(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

describe('Claude no-text refresh integration', () => {
  let server: http.Server;
  let port: number;
  let workDir: string;
  let projectDir: string;
  let ccSessionId: string;
  let sessionName: string;
  let trackedFile: string;
  let otherFile: string;

  beforeEach(async () => {
    events.length = 0;
    vi.clearAllMocks();
    workDir = join(tmpdir(), `claude-no-text-${randomUUID().slice(0, 8)}`);
    await mkdir(workDir, { recursive: true });
    projectDir = claudeProjectDir(workDir);
    await mkdir(projectDir, { recursive: true });
    ccSessionId = '11111111-1111-1111-1111-111111111111';
    sessionName = `deck_test_${randomUUID().slice(0, 8)}`;
    trackedFile = join(projectDir, `${ccSessionId}.jsonl`);
    otherFile = join(projectDir, '22222222-2222-2222-2222-222222222222.jsonl');
    await writeFile(trackedFile, '');
    await writeFile(otherFile, '');

    getSessionMock.mockImplementation((name: string) => {
      if (name !== sessionName) return null;
      return {
        name: sessionName,
        projectName: 'proj',
        role: 'brain',
        agentType: 'claude-code',
        projectDir: workDir,
        state: 'running',
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
    listSessionsMock.mockReturnValue([]);

    const started = await startHookServer(() => {});
    server = started.server;
    port = started.port;

    await startWatching(sessionName, workDir, ccSessionId);
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;
  });

  afterEach(async () => {
    stopWatching(sessionName);
    server.close();
    await rm(workDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('refreshes tracked claude transcript on idle and emits missing assistant text before idle', async () => {
    await appendFile(trackedFile, assistantText('cc refresh recovered text'));

    const res = await postNotify(port, { event: 'idle', session: sessionName, agentType: 'claude-code' });
    expect(res.status).toBe(200);

    await waitUntil(() => events.some((e) => e.session === sessionName && e.type === 'assistant.text'));

    const sessionEvents = events.filter((e) => e.session === sessionName);
    const assistantIdx = sessionEvents.findIndex((e) => e.type === 'assistant.text' && e.payload.text === 'cc refresh recovered text');
    const idleIdx = sessionEvents.findIndex((e) => e.type === 'session.state' && e.payload.state === 'idle');

    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(assistantIdx);
  });

  it('does not read a different claude session transcript during idle refresh', async () => {
    await appendFile(otherFile, assistantText('wrong claude transcript'));

    const res = await postNotify(port, { event: 'idle', session: sessionName, agentType: 'claude-code' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    expect(events.some((e) => e.session === sessionName && e.type === 'assistant.text' && e.payload.text === 'wrong claude transcript')).toBe(false);
    expect(events.some((e) => e.session === sessionName && e.type === 'session.state' && e.payload.state === 'idle')).toBe(true);
  });
});
