/**
 * Tests for Gemini watcher file tracking robustness:
 * - Inode change detection (atomic file replacement)
 * - Consecutive readConversation failure → file rescan
 * - Rotation does NOT skip messages (seenCount not pre-set)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/store/session-store.js', () => ({
  updateSessionState: vi.fn(),
  getSession: vi.fn(() => null),
  upsertSession: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  watch: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: vi.fn().mockResolvedValue(['', '> ', '']),
}));

import { pollTick, WatcherState } from '../../src/daemon/gemini-watcher.js';
import * as fs from 'fs/promises';

function makeState(overrides?: Partial<WatcherState>): WatcherState {
  return {
    sessionUuid: 'test-uuid',
    activeFile: '/tmp/session.json',
    seenCount: 0,
    lastUpdated: '',
    abort: new AbortController(),
    watchAbort: new AbortController(),
    stopped: false,
    polling: false,
    ...overrides,
  };
}

function makeConv(msgCount: number, lastUpdated = '2026-01-01T00:00:00Z') {
  return {
    lastUpdated,
    messages: Array.from({ length: msgCount }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'gemini',
      content: i % 2 === 0 ? [{ text: `msg ${i}` }] : `response ${i}`,
      timestamp: `2026-01-01T00:0${i}:00Z`,
    })),
  };
}

describe('Gemini watcher — inode change detection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-reads file when inode changes even if mtime and size are unchanged', async () => {
    const conv = makeConv(2, 'ts-1');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));

    // First poll: establish baseline with inode 100
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 200, ino: 100 } as any);
    const state = makeState();
    await pollTick('test', state);
    expect(state._lastIno).toBe(100);

    // Second poll: same mtime/size but different inode → must re-read
    const conv2 = makeConv(4, 'ts-2');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv2));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 200, ino: 200 } as any);

    await pollTick('test', state);
    expect(state.seenCount).toBe(4); // processed new messages
    expect(state._lastIno).toBe(200);
  });

  it('skips read when mtime, size, AND inode are all unchanged', async () => {
    const conv = makeConv(2, 'ts-1');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 200, ino: 100 } as any);

    const state = makeState();
    await pollTick('test', state);

    // Second poll: everything identical
    vi.mocked(fs.readFile).mockClear();
    await pollTick('test', state);

    // readFile should NOT have been called (cheap check passed)
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('forces re-read when ONLY inode changes (atomic replacement)', async () => {
    const conv = makeConv(2, 'ts-1');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 200, ino: 100 } as any);

    const state = makeState();
    await pollTick('test', state);

    // Same mtime/size but inode changed
    const conv2 = makeConv(3, 'ts-2');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv2));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 200, ino: 999 } as any);

    await pollTick('test', state);
    expect(state.seenCount).toBe(3);
  });
});

describe('Gemini watcher — consecutive read failures trigger rescan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets activeFile after 5 consecutive readConversation failures', async () => {
    // stat shows file changed each time
    let callCount = 0;
    vi.mocked(fs.stat).mockImplementation(async () => {
      callCount++;
      return { mtimeMs: callCount * 1000, size: callCount * 100, ino: 1 } as any;
    });
    // readFile always fails (invalid JSON)
    vi.mocked(fs.readFile).mockResolvedValue('not valid json{{{');

    const state = makeState();

    // First 4 failures: activeFile should still be set
    for (let i = 0; i < 4; i++) {
      await pollTick('test', state);
      expect(state.activeFile).toBe('/tmp/session.json');
    }
    expect(state._readFailCount).toBe(4);

    // 5th failure: triggers rescan
    await pollTick('test', state);
    expect(state.activeFile).toBeNull();
    expect(state._readFailCount).toBe(0);
  });

  it('resets readFailCount on successful read', async () => {
    let callCount = 0;
    vi.mocked(fs.stat).mockImplementation(async () => {
      callCount++;
      return { mtimeMs: callCount * 1000, size: 100, ino: 1 } as any;
    });

    const state = makeState();

    // 3 failures
    vi.mocked(fs.readFile).mockResolvedValue('broken json');
    for (let i = 0; i < 3; i++) await pollTick('test', state);
    expect(state._readFailCount).toBe(3);

    // Then a successful read
    const conv = makeConv(1, 'ts-ok');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));
    await pollTick('test', state);
    expect(state._readFailCount).toBe(0);
  });
});

describe('Gemini watcher — rotation preserves message processing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('processes all messages after file switch (seenCount starts at 0)', async () => {
    const conv = makeConv(4, 'ts-new');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 2000, size: 500, ino: 1 } as any);

    // Simulate state after activateFile (which sets seenCount=0)
    const state = makeState({ seenCount: 0, lastUpdated: '' });

    await pollTick('test', state);

    // All 4 messages should be processed (not skipped)
    expect(state.seenCount).toBe(4);
  });

  it('does not skip messages when lastUpdated differs from previous file', async () => {
    const conv = makeConv(6, 'ts-rotated');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 3000, size: 800, ino: 2 } as any);

    // State from old file: had 3 messages seen, different lastUpdated
    const state = makeState({ seenCount: 0, lastUpdated: 'ts-old-file' });

    await pollTick('test', state);

    // Should have processed all 6 messages from the new file
    expect(state.seenCount).toBe(6);
    expect(state.lastUpdated).toBe('ts-rotated');
  });
});
