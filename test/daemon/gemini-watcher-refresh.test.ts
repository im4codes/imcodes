import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/store/session-store.js', () => ({
  updateSessionState: vi.fn(),
  getSession: vi.fn(() => null),
  upsertSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: vi.fn().mockResolvedValue(['', '> ', '']),
}));

import { startWatching, stopWatching } from '../../src/daemon/gemini-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

describe('gemini watcher refresh()', () => {
  let chatsDir: string;
  let file: string;
  const sessionUuid = 'abcd1234-1111-2222-3333-444444444444';

  beforeEach(async () => {
    vi.mocked(timelineEmitter.emit).mockClear();
    chatsDir = join(homedir(), '.gemini', 'tmp', `refresh-${Date.now()}`, 'chats');
    await mkdir(chatsDir, { recursive: true });
    file = join(chatsDir, 'session-old-abcd1234.json');
    await writeFile(file, JSON.stringify({
      sessionId: sessionUuid,
      lastUpdated: '2026-04-05T00:00:00Z',
      messages: [{ type: 'gemini', content: 'old', timestamp: '2026-04-05T00:00:00Z' }],
    }), 'utf8');
  });

  afterEach(async () => {
    stopWatching('gemini-refresh');
    await rm(chatsDir.substring(0, chatsDir.indexOf('/chats')), { recursive: true, force: true });
  });

  it('refresh re-reads updated content for the same session file', async () => {
    const control = await startWatching('gemini-refresh', sessionUuid);
    await writeFile(file, JSON.stringify({
      sessionId: sessionUuid,
      lastUpdated: '2026-04-05T00:01:00Z',
      messages: [{ type: 'gemini', content: 'new reply', timestamp: '2026-04-05T00:01:00Z' }],
    }), 'utf8');

    expect(await control.refresh()).toBe(true);
    await waitUntil(() => vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[1] === 'assistant.text'));
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[0] === 'gemini-refresh' && (c[2] as any).text === 'new reply')).toBe(true);
  });

  it('refresh does not follow a different session id file', async () => {
    const control = await startWatching('gemini-refresh', sessionUuid);
    const other = join(chatsDir, 'session-other-bbbb2222.json');
    await writeFile(other, JSON.stringify({
      sessionId: 'bbbb2222-2222-2222-2222-222222222222',
      lastUpdated: '2026-04-05T00:02:00Z',
      messages: [{ type: 'gemini', content: 'wrong session', timestamp: '2026-04-05T00:02:00Z' }],
    }), 'utf8');

    expect(await control.refresh()).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[0] === 'gemini-refresh' && (c[2] as any).text === 'wrong session')).toBe(false);
  });

  it('refresh returns false after stop', async () => {
    const control = await startWatching('gemini-refresh', sessionUuid);
    stopWatching('gemini-refresh');
    expect(await control.refresh()).toBe(false);
  });
});
