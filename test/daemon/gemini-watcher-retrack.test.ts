import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile, rm, stat, utimes } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

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

import { startWatching, startWatchingLatest, retrackLatestSessionFile, stopWatching } from '../../src/daemon/gemini-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

async function waitUntil(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

// Purge any stale slug directories in ~/.gemini/tmp whose chats contain files
// matching the given uuid prefix. Leaked files from a crashed prior run can
// otherwise poison findSessionFile(), because the hardcoded 8-char uuid prefix
// becomes a collision key across runs.
async function purgeGeminiTmpForPrefix(prefix: string): Promise<void> {
  const root = join(homedir(), '.gemini', 'tmp');
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return;
  }
  for (const slug of slugs) {
    if (!slug.startsWith('slug-')) continue;
    const chatsDir = join(root, slug, 'chats');
    let entries: string[];
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.endsWith(`-${prefix}.json`) || entry.endsWith(`-${prefix}`))) {
      await rm(join(root, slug), { recursive: true, force: true });
    }
  }
}

describe('gemini retrackLatestSessionFile', () => {
  let rootDir: string;
  let chatsDir: string;
  let oldFile: string;
  let newFile: string;
  // Fresh uuid per suite run so crashed prior runs can't poison findSessionFile
  // via leaked `~/.gemini/tmp/slug-*/chats/session-*-<prefix>.json` files.
  const sessionUuid = randomUUID();
  const uuidPrefix = sessionUuid.slice(0, 8);
  const sessionName = `session-gemini-retrack-${Date.now()}`;

  beforeEach(async () => {
    vi.mocked(timelineEmitter.emit).mockClear();
    await purgeGeminiTmpForPrefix(uuidPrefix);
    rootDir = await mkdtemp(join(tmpdir(), 'gemini-retrack-proj-'));
    chatsDir = join(homedir(), '.gemini', 'tmp', `slug-${Date.now()}-${uuidPrefix}`, 'chats');
    await mkdir(chatsDir, { recursive: true });
    oldFile = join(chatsDir, `session-old-${uuidPrefix}.json`);
    newFile = join(chatsDir, `session-new-${uuidPrefix}.json`);
    await writeFile(oldFile, JSON.stringify({
      sessionId: sessionUuid,
      lastUpdated: '2026-04-05T00:00:00Z',
      messages: [{ type: 'gemini', content: 'old reply', timestamp: '2026-04-05T00:00:00Z' }],
    }), 'utf8');
    await startWatching(sessionName, sessionUuid);
    await rm(oldFile, { force: true });
    await writeFile(newFile, JSON.stringify({
      sessionId: sessionUuid,
      lastUpdated: '2026-04-05T00:01:00Z',
      messages: [{ type: 'gemini', content: 'retracked gemini reply', timestamp: '2026-04-05T00:01:00Z' }],
    }), 'utf8');
  });

  afterEach(async () => {
    stopWatching(sessionName);
    await rm(rootDir, { recursive: true, force: true });
    await rm(chatsDir.substring(0, chatsDir.indexOf('/chats')), { recursive: true, force: true });
    // Belt-and-suspenders: if the test crashed before reaching the rm above
    // on a previous run, the next run still starts clean.
    await purgeGeminiTmpForPrefix(uuidPrefix);
  });

  it('switches to the latest matching session file and replays missed content', async () => {
    await retrackLatestSessionFile(sessionName);
    await waitUntil(() =>
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'assistant.text' && (call[2] as any).text === 'retracked gemini reply',
      ),
    );
  });

  it('does not switch to an unrelated latest file when sessionUuid is unknown', async () => {
    const latestSessionName = `${sessionName}-latest`;
    const unknownChatsDir = join(homedir(), '.gemini', 'tmp', `slug-latest-${Date.now()}`, 'chats');
    const currentFile = join(unknownChatsDir, 'session-current-aaaa1111.json');
    const wrongFile = join(unknownChatsDir, 'session-wrong-bbbb2222.json');
    await mkdir(unknownChatsDir, { recursive: true });
    await writeFile(currentFile, JSON.stringify({
      sessionId: 'aaaa1111-1111-1111-1111-111111111111',
      lastUpdated: '2026-04-05T00:02:00Z',
      messages: [{ type: 'gemini', content: 'current reply', timestamp: '2026-04-05T00:02:00Z' }],
    }), 'utf8');
    await startWatchingLatest(latestSessionName);
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(wrongFile, JSON.stringify({
      sessionId: 'bbbb2222-2222-2222-2222-222222222222',
      lastUpdated: '2026-04-05T00:03:00Z',
      messages: [{ type: 'gemini', content: 'wrong latest reply', timestamp: '2026-04-05T00:03:00Z' }],
    }), 'utf8');

    vi.mocked(timelineEmitter.emit).mockClear();
    expect(await retrackLatestSessionFile(latestSessionName)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === latestSessionName && call[1] === 'assistant.text' && (call[2] as any).text === 'wrong latest reply',
      ),
    ).toBe(false);

    stopWatching(latestSessionName);
    await rm(unknownChatsDir.substring(0, unknownChatsDir.indexOf('/chats')), { recursive: true, force: true });
  });

  it('bound watcher does not switch to a newer file for a different sessionUuid', async () => {
    vi.useFakeTimers();
    const wrongFile = join(chatsDir, 'session-wrong-deadbeef.json');
    await writeFile(wrongFile, JSON.stringify({
      sessionId: 'deadbeef-9999-8888-7777-666666666666',
      lastUpdated: '2026-04-05T00:02:00Z',
      messages: [{ type: 'gemini', content: 'wrong gemini reply', timestamp: '2026-04-05T00:02:00Z' }],
    }), 'utf8');
    const oldStat = await stat(newFile);
    await utimes(wrongFile, new Date(oldStat.mtimeMs + 4000), new Date(oldStat.mtimeMs + 4000));
    vi.mocked(timelineEmitter.emit).mockClear();

    await vi.advanceTimersByTimeAsync(11000);

    expect(
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'assistant.text' && (call[2] as any).text === 'wrong gemini reply',
      ),
    ).toBe(false);

    await rm(wrongFile, { force: true });
    vi.useRealTimers();
  });
});
