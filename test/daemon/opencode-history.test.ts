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
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(new Error('no db path')))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([{ id: 's1', title: 't', updated: 10, created: 1, directory: '/proj' }]),
        stderr: '',
      }));

    const sessions = await listOpenCodeSessions('/proj', 5);
    expect(sessions).toEqual([
      { id: 's1', title: 't', updated: 10, created: 1, directory: '/proj' },
    ]);
  });

  it('prefers sqlite session list when available', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: '/tmp/opencode.db\n',
        stderr: '',
      }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([{ id: 's1', title: 'sqlite', time_updated: 10, time_created: 1, directory: '/proj', project_id: 'p1' }]),
        stderr: '',
      }));

    await expect(listOpenCodeSessions('/proj', 5)).resolves.toEqual([
      { id: 's1', title: 'sqlite', updated: 10, created: 1, directory: '/proj', projectId: 'p1' },
    ]);
  });

  it('discovers the latest matching session id by directory and timestamp', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: '/tmp/opencode.db\n',
        stderr: '',
      }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([
          { id: 'old', title: 'old', time_updated: 100, time_created: 1, directory: '/proj' },
          { id: 'wrong-dir', title: 'x', time_updated: 300, time_created: 1, directory: '/other' },
          { id: 'new', title: 'new', time_updated: 250, time_created: 1, directory: '/proj' },
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
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, { stdout: '/tmp/opencode.db\n', stderr: '' }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, { stdout: '[]', stderr: '' }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, { stdout: '/tmp/opencode.db\n', stderr: '' }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([{ id: 'appeared', title: 't', time_updated: 500, time_created: 1, directory: '/proj' }]),
        stderr: '',
      }));

    await expect(waitForOpenCodeSessionId('/proj', { updatedAfter: 400, attempts: 2, delayMs: 1, knownSessionIds: ['already-there'] }))
      .resolves.toBe('appeared');
  });

  it('exports a session as JSON', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(new Error('sqlite unavailable')))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: 'Exporting session: s1\n' + JSON.stringify({ info: { id: 's1' }, messages: [{ info: { id: 'm1' }, parts: [] }] }),
        stderr: '',
      }));

    await expect(exportOpenCodeSession('/proj', 's1')).resolves.toEqual({
      info: { id: 's1' },
      messages: [{ info: { id: 'm1' }, parts: [] }],
    });
  });

  it('exports a session from sqlite tables when available', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: '/tmp/opencode.db\n',
        stderr: '',
      }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([{ id: 's1', title: 'sqlite title', directory: '/proj', time_created: 1, time_updated: 2 }]),
        stderr: '',
      }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([
          { id: 'm1', time_created: 100, data: JSON.stringify({ role: 'user', time: { created: 100 } }) },
          { id: 'm2', time_created: 110, data: JSON.stringify({ role: 'assistant', time: { created: 110 } }) },
        ]),
        stderr: '',
      }))
      .mockImplementationOnce((_file, _args, _opts, cb) => cb(null, {
        stdout: JSON.stringify([
          { id: 'p1', message_id: 'm1', time_created: 101, data: JSON.stringify({ type: 'text', text: 'hello' }) },
          { id: 'p2', message_id: 'm2', time_created: 111, data: JSON.stringify({ type: 'text', text: 'world' }) },
        ]),
        stderr: '',
      }));

    await expect(exportOpenCodeSession('/proj', 's1')).resolves.toEqual({
      info: { id: 's1', title: 'sqlite title', directory: '/proj', time_created: 1, time_updated: 2 },
      messages: [
        { info: { id: 'm1', role: 'user', time: { created: 100 } }, parts: [{ id: 'p1', type: 'text', text: 'hello' }] },
        { info: { id: 'm2', role: 'assistant', time: { created: 110 } }, parts: [{ id: 'p2', type: 'text', text: 'world' }] },
      ],
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

  it('emits hidden raw events plus file.change for normalized OpenCode edits', () => {
    const events = buildTimelineEventsFromOpenCodeExport('deck_oc_brain', {
      info: { id: 's1' },
      messages: [
        {
          info: { id: 'a1', role: 'assistant', time: { created: 110 } },
          parts: [
            {
              id: 'p-edit',
              type: 'tool',
              tool: 'edit',
              state: {
                status: 'completed',
                input: { filePath: 'src/app.ts', oldString: 'before', newString: 'after' },
                metadata: {
                  exists: true,
                  filediff: { before: 'before', after: 'after' },
                },
                output: 'ok',
                time: { start: 111, end: 112 },
              },
            },
          ],
        },
      ],
    }, 1234);

    expect(events.map((event) => event.type)).toEqual([
      'tool.call',
      'tool.result',
      'file.change',
    ]);
    expect(events[0].hidden).toBe(true);
    expect(events[1].hidden).toBe(true);
    expect(events[2].payload.batch.provider).toBe('opencode');
    expect(events[2].payload.batch.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/app.ts',
      beforeText: 'before',
      afterText: 'after',
      confidence: 'exact',
    }));
  });

  it('preserves repeated file patches inside the same OpenCode batch when present', () => {
    const events = buildTimelineEventsFromOpenCodeExport('deck_oc_brain', {
      info: { id: 's1' },
      messages: [
        {
          info: { id: 'a1', role: 'assistant', time: { created: 110 } },
          parts: [
            {
              id: 'p-edit',
              type: 'tool',
              tool: 'edit',
              state: {
                status: 'completed',
                input: { filePath: 'src/app.ts', oldString: 'before', newString: 'after' },
                metadata: {
                  exists: true,
                  filediff: { before: 'before', after: 'after' },
                },
                output: 'ok',
                time: { start: 111, end: 112 },
              },
            },
            {
              id: 'p-write',
              type: 'tool',
              tool: 'write',
              state: {
                status: 'completed',
                input: { filePath: 'src/app.ts', content: 'after-2' },
                metadata: { exists: true },
                output: 'ok',
                time: { start: 113, end: 114 },
              },
            },
          ],
        },
      ],
    }, 1234);

    const fileChanges = events.filter((event) => event.type === 'file.change');
    expect(fileChanges).toHaveLength(2);
    expect(fileChanges[0].payload.batch.patches[0].filePath).toBe('src/app.ts');
    expect(fileChanges[1].payload.batch.patches[0].filePath).toBe('src/app.ts');
  });

  it('keeps raw OpenCode tool rows visible when an edit tool errors', () => {
    const events = buildTimelineEventsFromOpenCodeExport('deck_oc_brain', {
      info: { id: 's1' },
      messages: [
        {
          info: { id: 'a1', role: 'assistant', time: { created: 110 } },
          parts: [
            {
              id: 'p-edit-error',
              type: 'tool',
              tool: 'edit',
              state: {
                status: 'error',
                input: { filePath: 'src/app.ts', oldString: 'before', newString: 'after' },
                error: 'permission denied',
                time: { start: 111, end: 112 },
              },
            },
          ],
        },
      ],
    }, 1234);

    expect(events.map((event) => event.type)).toEqual(['tool.call', 'tool.result']);
    expect(events[0].hidden).not.toBe(true);
    expect(events[1].hidden).not.toBe(true);
  });
});
