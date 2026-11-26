import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We mock the p2p-orchestrator so the scope-filter tests below can inject
// synthetic runs without booting the full orchestrator. The earlier
// list_discussions tests are not affected because they exercise the file
// system, not in-memory runs (other than handleP2pReadDiscussion's run lookup,
// which gracefully falls back to file reads when listP2pRuns returns empty).
const mockListP2pRuns = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockGetP2pRun = vi.fn((_id: string) => undefined as Record<string, unknown> | undefined);
vi.mock('../../src/daemon/p2p-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/p2p-orchestrator.js')>();
  return {
    ...actual,
    listP2pRuns: (...args: Parameters<typeof actual.listP2pRuns>) => mockListP2pRuns(...args) as ReturnType<typeof actual.listP2pRuns>,
    getP2pRun: (id: string) => mockGetP2pRun(id) as ReturnType<typeof actual.getP2pRun>,
    serializeP2pRun: (run: Record<string, unknown>) => ({ id: run.id, status: run.status, contextFilePath: run.contextFilePath }),
  };
});

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { imcSubDir } from '../../src/util/imc-dir.js';
import { listSessions, removeSession, upsertSession } from '../../src/store/session-store.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';

const sent: unknown[] = [];
const serverLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

async function waitForSentCount(count: number): Promise<void> {
  // Poll up to ~5s. The handler does async fs work (e.g. the "limit" case writes
  // + reads 51 discussion files); under full-suite CPU/fs contention a 500ms
  // budget could expire before the response was pushed, so `sent[0]` read as
  // undefined (a load-dependent flake). The loop still returns the instant the
  // count is met, so widening the ceiling has no happy-path cost.
  for (let i = 0; i < 500; i += 1) {
    if (sent.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('p2p.list_discussions', () => {
  let projectDir: string;
  let otherProjectDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sent.length = 0;
    serverLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    projectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-discussions-'));
    otherProjectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-discussions-other-'));
    await mkdir(imcSubDir(projectDir, 'discussions'), { recursive: true });
    await mkdir(imcSubDir(otherProjectDir, 'discussions'), { recursive: true });
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
    upsertSession({
      name: 'deck_other_brain',
      projectName: 'other',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: otherProjectDir,
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
    if (otherProjectDir) await rm(otherProjectDir, { recursive: true, force: true });
  });

  it('returns only the canonical discussion file and excludes hop artifacts', async () => {
    const discussionsDir = imcSubDir(projectDir, 'discussions');
    await writeFile(join(discussionsDir, 'run-main.md'), '## User Request\nmain request\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.round1.hop1.md'), '## User Request\nhop 1\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.round1.hop2.md'), '## User Request\nhop 2\n', 'utf8');
    await writeFile(join(discussionsDir, 'run-main.reducer.2.md'), '# reducer snapshot\n', 'utf8');

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-list-1',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
      requestId: 'p2p-list-1',
      discussions: [
        expect.objectContaining({
          id: 'run-main',
          fileName: 'run-main.md',
          preview: 'main request',
        }),
      ],
    });
    const response = sent[0] as { discussions: Array<{ fileName: string; path?: string }> };
    expect(response.discussions.map((d) => d.fileName)).toEqual(['run-main.md']);
    expect(response.discussions[0]?.path).toBe(join(discussionsDir, 'run-main.md'));
  });

  it('serves rapid repeat polls for the same scope from the short-lived cache', async () => {
    // Regression guard for the p2p_list_discussions cache+dedup: before it,
    // every poll re-scanned project dirs and re-parsed every discussion file
    // (a top GC-pressure source under load). Two back-to-back polls for the
    // same scope must collapse to a single scan — proven here by adding a
    // second discussion file between the polls and asserting the cached
    // (pre-add) result is returned within the 2s TTL.
    const discussionsDir = imcSubDir(projectDir, 'discussions');
    await writeFile(join(discussionsDir, 'run-first.md'), '## User Request\nfirst\n', 'utf8');

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-cache-1',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);
    expect((sent[0] as { discussions: Array<{ id: string }> }).discussions.map((d) => d.id)).toEqual(['run-first']);

    // Add a second discussion, then poll again immediately. Within the TTL the
    // cached result (just the first file) must come back — the new file is not
    // re-scanned. This is the behaviour that collapses a poll burst.
    await writeFile(join(discussionsDir, 'run-second.md'), '## User Request\nsecond\n', 'utf8');
    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-cache-2',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(2);
    expect((sent[1] as { discussions: Array<{ id: string }> }).discussions.map((d) => d.id)).toEqual(['run-first']);
  });

  it('does not list or read discussions across project scope', async () => {
    await writeFile(join(imcSubDir(projectDir, 'discussions'), 'run-main.md'), '## User Request\nmain request\n', 'utf8');
    await writeFile(join(imcSubDir(otherProjectDir, 'discussions'), 'run-secret.md'), '## User Request\nsecret request\n', 'utf8');

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-list-scope',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect((sent[0] as { discussions: Array<{ id: string }> }).discussions.map((entry) => entry.id)).toEqual(['run-main']);

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
      requestId: 'p2p-read-scope',
      id: 'run-secret',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(2);

    expect(sent[1]).toMatchObject({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
      requestId: 'p2p-read-scope',
      id: 'run-secret',
      error: 'not_found',
    });
  });

  // Audit fix (e940d73f-a8e / M7-B) regression coverage.
  it('aggregates discussions across known projects when scope is omitted on a multi-project daemon', async () => {
    await writeFile(join(imcSubDir(projectDir, 'discussions'), 'run-main.md'), '## User Request\nmain request\n', 'utf8');
    await writeFile(join(imcSubDir(otherProjectDir, 'discussions'), 'run-secret.md'), '## User Request\nsecret request\n', 'utf8');

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-list-no-scope',
    }, serverLink as any);
    await waitForSentCount(1);

    const response = sent[0] as { discussions: Array<{ id: string; projectDir?: string }>; aggregated?: boolean };
    expect(response.aggregated).toBe(true);
    const ids = response.discussions.map((d) => d.id).sort();
    expect(ids).toEqual(['run-main', 'run-secret']);
    // Each entry MUST carry projectDir when aggregated so the UI can route reads back.
    for (const entry of response.discussions) {
      expect(typeof entry.projectDir).toBe('string');
    }
  });

  it('limits list previews to the newest canonical discussion files', async () => {
    const discussionsDir = imcSubDir(projectDir, 'discussions');
    const oldPath = join(discussionsDir, 'run-old.md');
    await writeFile(oldPath, `## User Request\nold request\n\n${'x'.repeat(70_000)}`, 'utf8');
    await utimes(oldPath, new Date(1_000), new Date(1_000));
    for (let i = 0; i < 50; i += 1) {
      const path = join(discussionsDir, `run-new-${String(i).padStart(2, '0')}.md`);
      await writeFile(path, `## User Request\nnew request ${i}\n`, 'utf8');
      await utimes(path, new Date(10_000 + i), new Date(10_000 + i));
    }

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
      requestId: 'p2p-list-limit',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    const response = sent[0] as { discussions: Array<{ id: string; preview: string }> };
    expect(response.discussions).toHaveLength(50);
    expect(response.discussions.some((entry) => entry.id === 'run-old')).toBe(false);
    expect(response.discussions.every((entry) => entry.preview.startsWith('new request'))).toBe(true);
  });

  it('reads a discussion via cross-project file sweep when scope is omitted', async () => {
    await writeFile(join(imcSubDir(otherProjectDir, 'discussions'), 'run-elsewhere.md'), '## User Request\nelsewhere\n', 'utf8');

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
      requestId: 'p2p-read-no-scope',
      id: 'run-elsewhere',
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
      requestId: 'p2p-read-no-scope',
      id: 'run-elsewhere',
      content: expect.stringContaining('elsewhere'),
    });
    expect((sent[0] as { error?: string }).error).toBeUndefined();
  });

  it('reads a discussion via active P2P run lookup when scope is omitted', async () => {
    const runDiscussionsDir = imcSubDir(projectDir, 'discussions');
    const runFile = join(runDiscussionsDir, 'live-run.md');
    await writeFile(runFile, '## User Request\nlive\n', 'utf8');
    mockListP2pRuns.mockReturnValue([
      { id: 'live-run', discussionId: 'live-run', contextFilePath: runFile, status: 'running' },
    ]);

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
      requestId: 'p2p-read-active-no-scope',
      id: 'live-run',
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
      requestId: 'p2p-read-active-no-scope',
      id: 'live-run',
      content: expect.stringContaining('live'),
    });
    expect((sent[0] as { error?: string }).error).toBeUndefined();
  });
});

describe('p2p.status', () => {
  let projectDir: string;
  let otherProjectDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sent.length = 0;
    serverLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    mockListP2pRuns.mockReturnValue([]);
    mockGetP2pRun.mockReturnValue(undefined);
    projectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-status-'));
    otherProjectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-status-other-'));
    await mkdir(imcSubDir(projectDir, 'discussions'), { recursive: true });
    await mkdir(imcSubDir(otherProjectDir, 'discussions'), { recursive: true });
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
    upsertSession({
      name: 'deck_other_brain',
      projectName: 'other',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: otherProjectDir,
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
    if (otherProjectDir) await rm(otherProjectDir, { recursive: true, force: true });
  });

  it('echoes requestId on status responses for bridge singlecast routing', async () => {
    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId: 'p2p-status-1',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-1',
      runs: expect.any(Array),
    });
  });

  it('handleP2pStatus rejects request without scope', async () => {
    // Even with runs present in memory, an unscoped request must fail closed.
    mockListP2pRuns.mockReturnValue([
      { id: 'run-a', status: 'queued', contextFilePath: join(imcSubDir(projectDir, 'discussions'), 'run-a.md'), initiatorSession: 'deck_proj_brain' },
    ]);

    handleWebCommand({ type: P2P_WORKFLOW_MSG.STATUS, requestId: 'p2p-status-no-scope' }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-no-scope',
      runs: [],
    });
  });

  it('handleP2pStatus filters runs to scope project', async () => {
    mockListP2pRuns.mockReturnValue([
      {
        id: 'run-in-scope',
        status: 'queued',
        contextFilePath: join(imcSubDir(projectDir, 'discussions'), 'run-in-scope.md'),
        initiatorSession: 'deck_proj_brain',
      },
      {
        id: 'run-other',
        status: 'queued',
        contextFilePath: join(imcSubDir(otherProjectDir, 'discussions'), 'run-other.md'),
        initiatorSession: 'deck_other_brain',
      },
    ]);

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId: 'p2p-status-filter',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    const response = sent[0] as { runs: Array<{ id: string }> };
    expect(response.runs.map((r) => r.id)).toEqual(['run-in-scope']);
  });

  it('handleP2pStatus emits an authoritative empty full-list response after active runs drain', async () => {
    mockListP2pRuns.mockReturnValue([
      {
        id: 'run-draining',
        status: 'running',
        contextFilePath: join(imcSubDir(projectDir, 'discussions'), 'run-draining.md'),
        initiatorSession: 'deck_proj_brain',
      },
    ]);

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId: 'p2p-status-before-drain',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-before-drain',
      runs: [{ id: 'run-draining' }],
    });

    sent.length = 0;
    mockListP2pRuns.mockReturnValue([]);

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId: 'p2p-status-after-drain',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-after-drain',
      runs: [],
    });
  });

  it('handleP2pStatus with runId outside scope returns null run', async () => {
    const outOfScopeRun = {
      id: 'run-other',
      status: 'queued',
      contextFilePath: join(imcSubDir(otherProjectDir, 'discussions'), 'run-other.md'),
      initiatorSession: 'deck_other_brain',
    };
    mockGetP2pRun.mockImplementation((id: string) => (id === 'run-other' ? outOfScopeRun : undefined));

    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId: 'p2p-status-runid-deny',
      runId: 'run-other',
      scope: { sessionName: 'deck_proj_brain' },
    }, serverLink as any);
    await waitForSentCount(1);

    expect(sent[0]).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-runid-deny',
      runId: 'run-other',
      run: null,
    });
  });
});
