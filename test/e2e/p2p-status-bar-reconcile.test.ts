import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockListP2pRuns = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockGetP2pRun = vi.fn((_id: string) => undefined as Record<string, unknown> | undefined);

vi.mock('../../src/daemon/p2p-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/p2p-orchestrator.js')>();
  return {
    ...actual,
    listP2pRuns: (...args: Parameters<typeof actual.listP2pRuns>) => mockListP2pRuns(...args) as ReturnType<typeof actual.listP2pRuns>,
    getP2pRun: (id: string) => mockGetP2pRun(id) as ReturnType<typeof actual.getP2pRun>,
    serializeP2pRun: (run: Record<string, unknown>) => ({
      id: run.id,
      status: run.status,
      mode_key: run.mode_key ?? 'discuss',
      current_round: run.current_round ?? 1,
      total_rounds: run.total_rounds ?? 1,
      total_hops: run.total_hops ?? 0,
      active_phase: run.active_phase ?? 'hop',
      contextFilePath: run.contextFilePath,
      all_nodes: run.all_nodes,
    }),
  };
});
vi.mock('@shared/p2p-status.js', async () => import('../../shared/p2p-status.js'));
vi.mock('@shared/p2p-workflow-diagnostics.js', async () => import('../../shared/p2p-workflow-diagnostics.js'));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { imcSubDir } from '../../src/util/imc-dir.js';
import { listSessions, removeSession, upsertSession } from '../../src/store/session-store.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { mapP2pRunToDiscussion, mergeP2pStatusResponseDiscussions } from '../../web/src/p2p-run-mapping.js';

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

describe('p2p status bar reconcile e2e', () => {
  let projectDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sent.length = 0;
    serverLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    projectDir = await mkdtemp(join(tmpdir(), 'imcodes-p2p-status-reconcile-'));
    await mkdir(imcSubDir(projectDir, 'discussions'), { recursive: true });
    upsertSession({
      name: 'deck_e2e_brain',
      projectName: 'p2p-status-e2e',
      role: 'brain',
      agentType: 'codex-sdk',
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

  async function requestStatus(requestId: string) {
    const targetSentCount = sent.length + 1;
    handleWebCommand({
      type: P2P_WORKFLOW_MSG.STATUS,
      requestId,
      scope: { sessionName: 'deck_e2e_brain' },
    }, serverLink as any);
    await waitForSentCount(targetSentCount);
    return sent.at(-1) as { type: string; requestId: string; runs?: Array<Record<string, unknown>> };
  }

  it('daemon full-list empty status clears stale running P2P bar state in the web reducer', async () => {
    const contextFilePath = join(imcSubDir(projectDir, 'discussions'), 'run-status-e2e.md');
    mockListP2pRuns.mockReturnValue([
      {
        id: 'run-status-e2e',
        status: 'running',
        contextFilePath,
        all_nodes: [
          { label: 'done-hop', agentType: 'codex-sdk', status: 'completed', phase: 'hop' },
          { label: 'active-hop', agentType: 'cursor-headless', status: 'running', phase: 'hop' },
        ],
      },
    ]);

    const activeResponse = await requestStatus('p2p-status-active');
    expect(activeResponse).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-active',
      runs: [expect.objectContaining({ id: 'run-status-e2e', status: 'running' })],
    });

    const activeDiscussions = (activeResponse.runs ?? []).map((run) => mapP2pRunToDiscussion(run));
    expect(activeDiscussions).toHaveLength(1);
    expect(activeDiscussions[0]?.id).toBe('p2p_run-status-e2e');
    expect(activeDiscussions[0]?.state).toBe('running');
    expect(activeDiscussions[0]?.nodes?.map((node) => node.status)).toEqual(['done', 'active']);

    mockListP2pRuns.mockReturnValue([]);
    const drainedResponse = await requestStatus('p2p-status-drained');
    expect(drainedResponse).toMatchObject({
      type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
      requestId: 'p2p-status-drained',
      runs: [],
    });

    const reconciled = mergeP2pStatusResponseDiscussions(
      [
        ...activeDiscussions,
        { ...activeDiscussions[0]!, id: 'p2p_run-already-done', state: 'done' },
        { ...activeDiscussions[0]!, id: 'classic-discussion', state: 'running' },
      ],
      (drainedResponse.runs ?? []).map((run) => mapP2pRunToDiscussion(run)),
      { fullList: Array.isArray(drainedResponse.runs) },
    );

    expect(reconciled.map((discussion) => discussion.id)).toEqual(['p2p_run-already-done', 'classic-discussion']);
  });
});
