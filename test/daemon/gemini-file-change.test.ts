import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitMock: vi.fn(),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: mocks.emitMock,
    on: vi.fn(),
  },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
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

import { pollTick, type WatcherState } from '../../src/daemon/gemini-watcher.js';
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

describe('Gemini watcher — file.change emission', () => {
  beforeEach(() => {
    mocks.emitMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits hidden raw tool events and file.change for write_file', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 500, ino: 1 } as any);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      lastUpdated: 'ts-1',
      messages: [
        {
          type: 'gemini',
          content: '',
          timestamp: '2026-04-08T00:00:00Z',
          toolCalls: [
            {
              id: 'gm-1',
              name: 'write_file',
              status: 'success',
              args: { file_path: 'src/gemini.ts', content: 'hello' },
              result: [
                {
                  functionResponse: {
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          ],
        },
      ],
    }));

    const state = makeState();
    await pollTick('gemini-session', state);

    const fileChange = mocks.emitMock.mock.calls.find((call) => call[1] === 'file.change');
    expect(fileChange).toBeDefined();
    expect(fileChange?.[2].batch.provider).toBe('gemini');
    expect(fileChange?.[2].batch.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/gemini.ts',
      confidence: 'derived',
    }));

    const toolCall = mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.call');
    const toolResult = mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.result');
    expect(toolCall?.[3]?.hidden).toBe(true);
    expect(toolResult?.[3]?.hidden).toBe(true);
  });

  it('defers file-tool rows until terminal success and falls back to visible rows on error', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 500, ino: 1 } as any);

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify({
        lastUpdated: 'ts-1',
        messages: [
          {
            type: 'gemini',
            content: '',
            timestamp: '2026-04-08T00:00:00Z',
            toolCalls: [
              {
                id: 'gm-3',
                name: 'write_file',
                status: 'running',
                args: { file_path: 'src/gemini.ts', content: 'hello' },
                result: [],
              },
            ],
          },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        lastUpdated: 'ts-2',
        messages: [
          {
            type: 'gemini',
            content: '',
            timestamp: '2026-04-08T00:00:00Z',
            toolCalls: [
              {
                id: 'gm-3',
                name: 'write_file',
                status: 'error',
                args: { file_path: 'src/gemini.ts', content: 'hello' },
                result: [
                  {
                    functionResponse: {
                      response: { output: 'permission denied' },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }));

    const state = makeState();
    await pollTick('gemini-session', state);
    expect(mocks.emitMock.mock.calls.some((call) => ['tool.call', 'tool.result', 'file.change'].includes(call[1]))).toBe(false);

    await pollTick('gemini-session', state);
    expect(mocks.emitMock.mock.calls.some((call) => call[1] === 'file.change')).toBe(false);
    expect(mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.call')?.[3]?.hidden).not.toBe(true);
    expect(mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.result')?.[3]?.hidden).not.toBe(true);
  });

  it('does not emit file.change for shell-only Gemini tools', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1000, size: 500, ino: 1 } as any);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      lastUpdated: 'ts-1',
      messages: [
        {
          type: 'gemini',
          content: '',
          timestamp: '2026-04-08T00:00:00Z',
          toolCalls: [
            {
              id: 'gm-2',
              name: 'run_shell_command',
              status: 'success',
              args: { command: 'sed -i ...' },
              result: [
                {
                  functionResponse: {
                    response: { output: 'done' },
                  },
                },
              ],
            },
          ],
        },
      ],
    }));

    const state = makeState();
    await pollTick('gemini-session', state);

    expect(mocks.emitMock.mock.calls.some((call) => call[1] === 'file.change')).toBe(false);
    expect(mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.call')?.[3]?.hidden).not.toBe(true);
    expect(mocks.emitMock.mock.calls.find((call) => call[1] === 'tool.result')?.[3]?.hidden).not.toBe(true);
  });
});
