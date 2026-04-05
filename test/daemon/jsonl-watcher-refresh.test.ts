import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { randomUUID } from 'crypto';

const emittedEvents: Array<{ session: string; type: string; payload: Record<string, unknown> }> = [];

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>) => {
      emittedEvents.push({ session, type, payload });
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/util/model-context.js', () => ({
  resolveContextWindow: vi.fn(() => 200000),
}));

import { startWatching, startWatchingFile, stopWatching, claudeProjectDir } from '../../src/daemon/jsonl-watcher.js';

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }], model: 'claude-opus', usage: { input_tokens: 1 } },
  }) + '\n';
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

describe('jsonl watcher refresh()', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;
  let claudeProject: string;
  let ccSessionId: string;
  let otherSessionId: string;
  let ccSessionFile: string;
  let otherSessionFile: string;

  beforeEach(async () => {
    emittedEvents.length = 0;
    dir = join(tmpdir(), `jsonl-refresh-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    fileA = join(dir, 'a.jsonl');
    fileB = join(dir, 'b.jsonl');
    await writeFile(fileA, '');
    await writeFile(fileB, '');
    claudeProject = claudeProjectDir(dir);
    await mkdir(claudeProject, { recursive: true });
    ccSessionId = randomUUID();
    otherSessionId = randomUUID();
    ccSessionFile = join(claudeProject, `${ccSessionId}.jsonl`);
    otherSessionFile = join(claudeProject, `${otherSessionId}.jsonl`);
    await writeFile(ccSessionFile, '');
    await writeFile(otherSessionFile, '');
  });

  afterEach(async () => {
    stopWatching('jsonl-a');
    stopWatching('jsonl-b');
    stopWatching('jsonl-cc');
    await rm(dir, { recursive: true, force: true });
    await rm(join(homedir(), '.claude', 'projects', claudeProject.split('/').at(-1) ?? ''), { recursive: true, force: true });
  });

  it('refresh reads newly appended content for its own tracked file', async () => {
    const control = await startWatchingFile('jsonl-a', fileA);
    await new Promise((r) => setTimeout(r, 100));
    emittedEvents.length = 0;

    await appendFile(fileA, assistantText('refresh picked up A'));
    expect(await control.refresh()).toBe(true);

    await waitUntil(() => emittedEvents.some((e) => e.session === 'jsonl-a' && e.type === 'assistant.text'));
    expect(emittedEvents.some((e) => e.session === 'jsonl-a' && e.payload.text === 'refresh picked up A')).toBe(true);
  });

  it('refresh does not read another watcher\'s file', async () => {
    const controlA = await startWatchingFile('jsonl-a', fileA);
    await startWatchingFile('jsonl-b', fileB);
    await new Promise((r) => setTimeout(r, 100));
    emittedEvents.length = 0;

    await appendFile(fileB, assistantText('belongs to B'));
    expect(await controlA.refresh()).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    expect(emittedEvents.some((e) => e.session === 'jsonl-a' && e.payload.text === 'belongs to B')).toBe(false);
  });

  it('refresh returns false after watcher is stopped', async () => {
    const control = await startWatchingFile('jsonl-a', fileA);
    stopWatching('jsonl-a');
    expect(await control.refresh()).toBe(false);
  });

  it('startWatching with ccSessionId only follows that transcript file', async () => {
    const control = await startWatching('jsonl-cc', dir, ccSessionId);
    await new Promise((r) => setTimeout(r, 100));
    emittedEvents.length = 0;

    await appendFile(otherSessionFile, assistantText('wrong session transcript'));
    await appendFile(ccSessionFile, assistantText('correct session transcript'));
    expect(await control.refresh()).toBe(true);

    await waitUntil(() => emittedEvents.some((e) => e.session === 'jsonl-cc' && e.type === 'assistant.text'));
    expect(emittedEvents.some((e) => e.session === 'jsonl-cc' && e.payload.text === 'correct session transcript')).toBe(true);
    expect(emittedEvents.some((e) => e.session === 'jsonl-cc' && e.payload.text === 'wrong session transcript')).toBe(false);
  });
});
