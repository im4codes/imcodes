import { describe, it, expect, vi, beforeEach } from 'vitest';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { pollTick, WatcherState } from '../../src/daemon/gemini-watcher.js';
import * as fs from 'fs/promises';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('Gemini Idle Detection (Direct pollTick test)', () => {
  const sid = 'session-idle-test';
  let state: WatcherState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessionUuid: 'uuid-1',
      activeFile: '/tmp/session.json',
      seenCount: 0,
      lastUpdated: '',
      abort: new AbortController(),
      stopped: false,
    };
  });

  it('does NOT emit idle during thinking phase', async () => {
    const conv = {
      lastUpdated: '2026-03-14T10:00:00Z',
      messages: [
        {
          type: 'gemini',
          content: '', // No content yet
          thoughts: [{ description: 'I am thinking...' }],
          timestamp: '2026-03-14T10:00:00Z'
        }
      ]
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);
    
    expect(states).toContain('running');
    expect(states).not.toContain('idle');
  });

  it('does NOT emit idle when tool calls are pending', async () => {
    const conv = {
      lastUpdated: '2026-03-14T10:00:01Z',
      messages: [
        {
          type: 'gemini',
          content: 'Working on it...',
          toolCalls: [{ name: 'bash', status: undefined }], // Pending
          timestamp: '2026-03-14T10:00:01Z'
        }
      ]
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);
    
    expect(states).not.toContain('idle');
  });

  it('emits idle ONLY when content is present and all tools finished', async () => {
    const conv = {
      lastUpdated: '2026-03-14T10:00:02Z',
      messages: [
        {
          type: 'gemini',
          content: 'All done.',
          toolCalls: [{ name: 'bash', status: 'success' }],
          timestamp: '2026-03-14T10:00:02Z'
        }
      ]
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);
    
    expect(states).toContain('idle');
  });

  it('emits idle when a trailing info message arrives after a completed Gemini reply', async () => {
    state.seenCount = 1;
    state.lastUpdated = '2026-03-14T10:00:01Z';
    state.emittedRunning = false;

    const conv = {
      lastUpdated: '2026-03-14T10:00:03Z',
      messages: [
        {
          type: 'gemini',
          content: 'All done.',
          timestamp: '2026-03-14T10:00:02Z'
        },
        {
          type: 'info',
          content: 'Gemini CLI update available!',
          timestamp: '2026-03-14T10:00:03Z'
        }
      ]
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conv));

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('idle');
    expect(states).not.toContain('running');
  });
});
