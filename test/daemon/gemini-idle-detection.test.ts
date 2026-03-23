import { describe, it, expect, vi, beforeEach } from 'vitest';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { pollTick, WatcherState } from '../../src/daemon/gemini-watcher.js';
import * as fs from 'fs/promises';
import * as tmux from '../../src/agent/tmux.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 100 }),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: vi.fn(),
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

  it('emits idle ONLY after JSON stops changing (new data always = running)', async () => {
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

    // Poll 1: new data → running (never idle on new data path)
    await pollTick(sid, state);
    // Poll 2: unchanged JSON → idle confirm = 1
    await pollTick(sid, state);
    // Poll 3: unchanged JSON → idle confirm = 2 → emit idle
    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('idle');
  });

  it('emits idle after trailing info message once JSON settles', async () => {
    state.seenCount = 1;
    state.lastUpdated = '2026-03-14T10:00:01Z';

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

    // Poll 1: new data → running
    await pollTick(sid, state);
    // Poll 2: unchanged → idle confirm = 1
    await pollTick(sid, state);
    // Poll 3: unchanged → idle confirm = 2 → emit idle
    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('idle');
  });
});

// ── Spinner ground truth detection ────────────────────────────────────────────

describe('Gemini spinner detection (braille at col 0)', () => {
  const sid = 'session-spinner-test';
  let state: WatcherState;

  // Stable idle JSON — Gemini finished responding
  const idleConv = {
    lastUpdated: '2026-03-14T10:00:00Z',
    messages: [
      { type: 'gemini', content: 'Done.', timestamp: '2026-03-14T10:00:00Z' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessionUuid: 'uuid-1',
      activeFile: '/tmp/session.json',
      seenCount: 1,
      lastUpdated: '2026-03-14T10:00:00Z',
      abort: new AbortController(),
      watchAbort: new AbortController(),
      stopped: false,
      polling: false,
      currentState: 'idle',
      lastConversationStatus: 'idle',
      idleConfirmCount: 2,
      _lastMtimeMs: 1000,
      _lastSize: 100,
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(idleConv));
  });

  function spinnerLines(): string[] {
    return ['', '⠹ Thinking...', '', ''];
  }

  function idleLines(): string[] {
    return ['', 'Done.', '', '> ', ''];
  }

  it('confirms working state when spinner seen in majority of burst reads', async () => {
    // capturePane returns spinner lines on all calls (burst confirmation succeeds)
    vi.mocked(tmux.capturePane).mockResolvedValue(spinnerLines());

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('running');
  });

  it('emits assistant.thinking with terminal-spinner source on confirmed spinner', async () => {
    vi.mocked(tmux.capturePane).mockResolvedValue(spinnerLines());

    await pollTick(sid, state);

    const thinkingCalls = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'assistant.thinking');

    expect(thinkingCalls.length).toBeGreaterThan(0);
    expect(thinkingCalls[0][3]).toMatchObject({ source: 'terminal-spinner', confidence: 'high' });
  });

  it('does NOT transition to running on single-frame spinner (burst fails)', async () => {
    // First call: spinner. Subsequent burst reads: idle (2/6 spinner = below threshold)
    let callCount = 0;
    vi.mocked(tmux.capturePane).mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? spinnerLines() : idleLines();
    });

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).not.toContain('running');
  });

  it('spinner overrides JSON idle status (ground truth)', async () => {
    // JSON says idle, but terminal shows spinner consistently → must be running
    state.lastConversationStatus = 'idle';
    state.currentState = 'idle';
    vi.mocked(tmux.capturePane).mockResolvedValue(spinnerLines());

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('running');
  });

  it('returns to idle when spinner disappears', async () => {
    // First tick: spinner confirmed → running
    vi.mocked(tmux.capturePane).mockResolvedValue(spinnerLines());
    await pollTick(sid, state);

    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(idleConv));

    // Next ticks: no spinner, idle terminal + idle JSON → should transition back to idle
    vi.mocked(tmux.capturePane).mockResolvedValue(idleLines());
    state.lastConversationStatus = 'idle';
    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('idle');
  });
});

// ── File size change detection + parse failure bias ───────────────────────────

describe('Gemini JSON change detection hardening', () => {
  const sid = 'session-change-test';
  let state: WatcherState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessionUuid: 'uuid-1',
      activeFile: '/tmp/session.json',
      seenCount: 1,
      lastUpdated: '2026-03-14T10:00:00Z',
      abort: new AbortController(),
      watchAbort: new AbortController(),
      stopped: false,
      polling: false,
      currentState: 'idle',
      lastConversationStatus: 'idle',
      idleConfirmCount: 2,
      _lastMtimeMs: 1000,
      _lastSize: 100,
    };
    vi.mocked(tmux.capturePane).mockResolvedValue(['', '> ', '']);
  });

  it('detects change when size differs even if mtime is same', async () => {
    const { stat: statMock } = await import('fs/promises');
    vi.mocked(statMock).mockResolvedValue({ mtimeMs: 1000, size: 200 } as any);

    const growingConv = {
      lastUpdated: '2026-03-14T10:00:01Z',
      messages: [
        { type: 'gemini', content: 'Still writing...', timestamp: '2026-03-14T10:00:01Z' },
      ],
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(growingConv));

    await pollTick(sid, state);

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter(c => c[1] === 'session.state')
      .map(c => (c[2] as any).state);

    expect(states).toContain('running');
  });

  it('biases toward running when JSON parse fails on changed file', async () => {
    const { stat: statMock } = await import('fs/promises');
    vi.mocked(statMock).mockResolvedValue({ mtimeMs: 1001, size: 150 } as any);
    vi.mocked(fs.readFile).mockResolvedValue('{ "messages": [ INCOMPLETE');

    await pollTick(sid, state);

    expect(state.currentState).toBe('running');
  });

  it('stays on unchanged path when both mtime and size match', async () => {
    const { stat: statMock } = await import('fs/promises');
    vi.mocked(statMock).mockResolvedValue({ mtimeMs: 1000, size: 100 } as any);

    vi.mocked(fs.readFile).mockRejectedValue(new Error('should not be called'));

    await pollTick(sid, state);

    expect(state.currentState).toBe('idle');
  });
});
