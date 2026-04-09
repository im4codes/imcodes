import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { imcSubDir } from '../../src/util/imc-dir.js';
import { listSessions, removeSession, upsertSession } from '../../src/store/session-store.js';

const sent: unknown[] = [];
const serverLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

async function waitForSentCount(count: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (sent.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('p2p.list_discussions', () => {
  let projectDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sent.length = 0;
    serverLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    projectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-discussions-'));
    await mkdir(imcSubDir(projectDir, 'discussions'), { recursive: true });
    upsertSession({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterEach(async () => {
    for (const session of listSessions()) removeSession(session.name);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns only the canonical discussion file and excludes hop artifacts', async () => {
    const discussionsDir = imcSubDir(projectDir, 'discussions');
    await writeFile(join(discussionsDir, 'run-main.md'), '## User Request\nmain request\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.round1.hop1.md'), '## User Request\nhop 1\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.round1.hop2.md'), '## User Request\nhop 2\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.reducer.2.md'), '# reducer snapshot\n', 'utf8');

    handleWebCommand({ type: 'p2p.list_discussions' }, serverLink as any);
    await waitForSentCount(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'p2p.list_discussions_response',
      discussions: [
        expect.objectContaining({
          id: 'run-main',
          fileName: 'run-main.md',
          preview: 'main request',
        }),
      ],
    });
    const response = sent[0] as { discussions: Array<{ fileName: string }> };
    expect(response.discussions.map((d) => d.fileName)).toEqual(['run-main.md']);
  });
});
