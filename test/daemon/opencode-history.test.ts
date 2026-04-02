import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

import {
  buildTimelineEventsFromOpenCodeExport,
  discoverOpenCodeSessionIdFromList,
  discoverLatestOpenCodeSessionId,
  exportOpenCodeSession,
  getOpenCodeDbPath,
  listOpenCodeSessions,
  waitForOpenCodeSessionId,
} from '../../src/daemon/opencode-history.js';

describe('opencode-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads db path via `opencode db path`', async () => {
    mocks.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, {
      stdout: '/Users/k/.local/share/opencode/opencode.db\n',
      stderr: '',
    }));

    await expect(getOpenCodeDbPath('/proj')).resolves.toBe('/Users/k/.local/share/opencode/opencode.db');
  });

  it('lists sessions via `opencode session list --format json`', async () => {
    mocks.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, {
      stdout: JSON.stringify([{ id: 's1', title: 't', updated: 10, created: 1, directory: '/proj' }]),
      stderr: '',
    }));

    const sessions = await listOpenCodeSessions('/proj', 5);
    expect(sessions).toEqual([
      { id: 's1', title: 't', updated: 10, created: 1, directory: '/proj' },
    ]);
  });

  it('discovers the latest matching session id by directory and timestamp', async () => {
    mocks.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, {
      stdout: JSON.stringify([
        { id: 'old', title: 'old', updated: 100, created: 1, directory: '/proj' },
        { id: 'wrong-dir', title: 'x', updated: 300, created: 1, directory: '/other' },
        { id: 'new', title: 'new', updated: 250, created: 1, directory: '/proj' },
      ]),
      stderr: '',
    }));

    await expect(discoverLatestOpenCodeSessionId('/proj', { updatedAfter: 200, exactDirectory: '/proj' }))
      .resolves.toBe('new');
  });

  it('prefers a newly appeared session over older known sessions', () => {
    const id = discoverOpenCodeSessionIdFromList([
      { id: 'new', title: 'new', updated: 250, created: 1, directory: '/proj' },
      { id: 'old', title: 'old', updated: 300, created: 1, directory: '/proj' },
    ], {
      updatedAfter: 200,
      exactDirectory: '/proj',
      knownSessionIds: ['old'],
    });

    expect(id).toBe('new');
  });

  it('normalizes Windows directory paths for matching', () => {
    const id = discoverOpenCodeSessionIdFromList([
      { id: 'win-new', title: 'new', updated: 250, created: 1, directory: 'c:/Users/k/proj' },
      { id: 'other', title: 'other', updated: 260, created: 1, directory: 'D:/Users/k/proj' },
    ], {
      updatedAfter: 200,
      exactDirectory: 'C:\\Users\\k\\proj\\',
    });

    expect(id).toBe('win-new');
  });

  it('retries until a session appears', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, { stdout: '[]', stderr: '' }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([{ id: 'appeared', title: 't', updated: 500, created: 1, directory: '/proj' }]),
        stderr: '',
      }));

    await expect(waitForOpenCodeSessionId('/proj', { updatedAfter: 400, attempts: 2, delayMs: 1, knownSessionIds: ['already-there'] }))
      .resolves.toBe('appeared');
  });

  it('exports a session as JSON', async () => {
    mocks.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, {
      stdout: JSON.stringify({ info: { id: 's1' }, messages: [{ info: { id: 'm1' }, parts: [] }] }),
      stderr: '',
    }));

    await expect(exportOpenCodeSession('/proj', 's1')).resolves.toEqual({
      info: { id: 's1' },
      messages: [{ info: { id: 'm1' }, parts: [] }],
    });
  });

  it('converts OpenCode export data into timeline events', () => {
    const events = buildTimelineEventsFromOpenCodeExport('deck_oc_brain', {
      info: { id: 's1' },
      messages: [
        {
          info: { id: 'u1', role: 'user', time: { created: 100 } },
          parts: [{ id: 'p1', type: 'text', text: 'hello' }],
        },
        {
          info: { id: 'a1', role: 'assistant', time: { created: 110 } },
          parts: [
            { id: 'p2', type: 'reasoning', text: 'thinking', time: { start: 111, end: 112 } },
            { id: 'p3', type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'a.ts' }, time: { start: 113, end: 114 } } },
            { id: 'p4', type: 'text', text: 'done', time: { start: 115, end: 116 } },
          ],
        },
      ],
    }, 999);

    expect(events.map((event) => event.type)).toEqual([
      'user.message',
      'assistant.thinking',
      'tool.call',
      'tool.result',
      'assistant.text',
    ]);
    expect(events[0].payload.text).toBe('hello');
    expect(events[4].payload.text).toBe('done');
    expect(events.every((event) => event.epoch === 999)).toBe(true);
  });
});
