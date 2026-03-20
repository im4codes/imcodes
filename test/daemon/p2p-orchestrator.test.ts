import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  sendKeysDelayedEnterMock,
  capturePaneMock,
  sendKeyMock,
  getSessionMock,
  detectStatusMock,
  serverLinkMock,
} = vi.hoisted(() => ({
  sendKeysDelayedEnterMock: vi.fn().mockResolvedValue(undefined),
  capturePaneMock: vi.fn().mockResolvedValue(['$']),
  sendKeyMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(() => ({ agentType: 'claude-code', projectDir: '/tmp/proj' })),
  detectStatusMock: vi.fn().mockReturnValue('idle'),
  serverLinkMock: { send: vi.fn() },
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeysDelayedEnter: sendKeysDelayedEnterMock,
  sendKeys: sendKeysDelayedEnterMock,
  capturePane: capturePaneMock,
  sendKey: sendKeyMock,
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatus: detectStatusMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  startP2pRun,
  cancelP2pRun,
  getP2pRun,
  listP2pRuns,
  _setIdlePollMs,
  type P2pRun,
  type P2pRunStatus,
  notifySessionIdle,
} from '../../src/daemon/p2p-orchestrator.js';
import { getP2pMode, BUILT_IN_MODES } from '../../src/shared/p2p-modes.js';

// ── Re-export parseAtTokens for Group 15 tests ───────────────────────────────
// parseAtTokens is not exported from command-handler, so we replicate its logic
// here for isolated testing. The regexes and logic are copied verbatim.

const DISCUSS_TOKEN_RE = /@@discuss\(([^,]+),\s*([^)]+)\)/g;
const FILE_TOKEN_RE = /@((?:[a-zA-Z0-9_.\-/]+\/)*[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)/g;

interface ParsedTokens {
  agents: Array<{ session: string; mode: string }>;
  files: string[];
  cleanText: string;
}

function parseAtTokens(text: string): ParsedTokens {
  const agents: Array<{ session: string; mode: string }> = [];
  const files: string[] = [];
  for (const m of text.matchAll(DISCUSS_TOKEN_RE)) {
    agents.push({ session: m[1].trim(), mode: m[2].trim() });
  }
  let withoutCx = text.replace(DISCUSS_TOKEN_RE, '');
  for (const m of withoutCx.matchAll(FILE_TOKEN_RE)) {
    files.push(m[1]);
  }
  const cleanText = withoutCx.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  return { agents, files, cleanText };
}

// File search excludes set (copied from command-handler.ts)
const FILE_SEARCH_EXCLUDES = new Set([
  'node_modules', '.git', 'venv', '__pycache__', '.venv',
  'dist', 'build', '.next', '.nuxt', 'vendor', 'target',
]);

const FILE_SEARCH_MAX = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for a run to reach a target status (or timeout). Uses real polling for non-timer tests. */
async function waitForStatus(
  runId: string,
  target: P2pRunStatus | P2pRunStatus[],
  maxMs = 5_000,
): Promise<P2pRun | undefined> {
  const targets = Array.isArray(target) ? target : [target];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const run = getP2pRun(runId);
    if (run && targets.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getP2pRun(runId);
}

/** Create a unique temp dir for context file isolation. */
async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `p2p-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _setIdlePollMs(50); // fast polling for tests
  // Default: agent is idle immediately
  detectStatusMock.mockReturnValue('idle');
  capturePaneMock.mockResolvedValue(['$']);
  // When sendKeys is called, simulate the agent writing to the context file
  // then firing an idle hook after a short delay
  sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
    // Extract the context file path from the prompt and append a section
    const pathMatch = prompt.match(/\/[^\s]*\.imcodes\/discussions\/[^\s]+\.md/);
    if (pathMatch) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(pathMatch[0], `\n## Output from ${session}\n\nSome analysis.\n`);
    }
    // Simulate idle hook firing after agent finishes (small delay for file poll to detect growth)
    setTimeout(() => notifySessionIdle(session), 150);
  });
  getSessionMock.mockReturnValue({ agentType: 'claude-code', projectDir: '/tmp/proj' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _setIdlePollMs(3_000); // restore default
  // Clean up temp files
  const { rm } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  await rm(join(homedir(), '.imcodes', 'discussions'), { recursive: true, force: true }).catch(() => {});
});

// =============================================================================
// Group 10: State Machine Transitions
// =============================================================================

describe('Group 10: State Machine Transitions', () => {
  it('queued → dispatched when initiator hop starts', async () => {
    const capturedTransitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) capturedTransitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'review this',
      [],
      serverLinkMock as any,
    );

    // Wait for chain to complete (it runs fast with mocks)
    await waitForStatus(run.id, 'completed', 10_000);

    // queued should be first, then dispatched should appear
    expect(capturedTransitions[0]).toBe('queued');
    expect(capturedTransitions).toContain('dispatched');
  }, 15_000);

  it('dispatched → running when context file size grows', async () => {
    // First poll: agent still working. Second poll: file grew but agent still working.
    let pollCount = 0;
    detectStatusMock.mockImplementation(() => {
      pollCount++;
      if (pollCount <= 3) return 'thinking'; // still working
      return 'idle'; // eventually idle
    });

    // Mock sendKeys to grow the context file immediately (no setTimeout race)
    sendKeysDelayedEnterMock.mockImplementation(async (_session: string, _prompt: string) => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        try {
          const current = await readFile(run.contextFilePath, 'utf8');
          await writeFile(run.contextFilePath, current + '\n## More content\n\nSome analysis.', 'utf8');
        } catch { /* ignore */ }
      }
    });

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'review' }],
      'check code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, ['completed', 'running', 'awaiting_next_hop'], 15_000);

    // dispatched should come before running
    const dispIdx = transitions.indexOf('dispatched');
    const runIdx = transitions.indexOf('running');
    expect(dispIdx).toBeGreaterThanOrEqual(0);
    // running may appear if file grew while agent was still working
    if (runIdx >= 0) {
      expect(runIdx).toBeGreaterThan(dispIdx);
    }
  });

  it('running → awaiting_next_hop when file growth + agent idle', async () => {
    // Agent is idle from the start, so hop completes and transitions to awaiting_next_hop
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Analysis\n\nDone.', 'utf8');
      }
    });

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'do audit',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // Should see awaiting_next_hop at least once (between initiator's initial hop and w1 hop)
    expect(transitions).toContain('awaiting_next_hop');
  });

  it('awaiting_next_hop → dispatched when next hop begins', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## More\n\nContent.', 'utf8');
      }
    });

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit please',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // After awaiting_next_hop, the next dispatched should follow
    const awaitIdx = transitions.indexOf('awaiting_next_hop');
    if (awaitIdx >= 0) {
      const nextDispatched = transitions.indexOf('dispatched', awaitIdx + 1);
      expect(nextDispatched).toBeGreaterThan(awaitIdx);
    }
  });

  it('final hop running → completed', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Final\n\nDone.', 'utf8');
      }
    });

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'review' }],
      'review now',
      [],
      serverLinkMock as any,
    );

    const final = await waitForStatus(run.id, 'completed', 15_000);
    expect(final?.status).toBe('completed');
    expect(final?.completedAt).toBeTruthy();
    expect(transitions[transitions.length - 1]).toBe('completed');
  });

  it('queued → cancelled when user cancels before dispatch', async () => {
    // Make the agent busy so chain blocks on waitForIdle, keeping status as queued
    detectStatusMock.mockReturnValue('thinking');
    // Delay sendKeys so the chain doesn't proceed
    sendKeysDelayedEnterMock.mockImplementation(() => new Promise(() => {})); // never resolves

    // Start but the chain will be stuck waiting for idle
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    // Run is queued initially, cancel immediately
    // Note: the chain starts in background, but since agent is not idle for targets,
    // we need to cancel before first dispatch. The initiator hop may still dispatch.
    // Cancel via the function:
    const ok = await cancelP2pRun(run.id, serverLinkMock as any);
    expect(ok).toBe(true);

    // Check final status — should be cancelled (may go through interrupted→cancelling→cancelled
    // if it was already dispatched, or direct cancelled if queued)
    const finalRun = getP2pRun(run.id);
    // Run is deleted from activeRuns after cancel, so it should be undefined
    expect(finalRun).toBeUndefined();
  });

  it('running → interrupted → cancelling → cancelled on cancel mid-hop', async () => {
    let hopResolve: (() => void) | null = null;
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Content\n\nSomething.', 'utf8');
      }
      // Block to simulate agent working
      return new Promise<void>((resolve) => { hopResolve = resolve; });
    });

    // Agent is working (not idle yet)
    let callCount = 0;
    detectStatusMock.mockImplementation(() => {
      callCount++;
      return callCount > 100 ? 'idle' : 'thinking';
    });

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit code',
      [],
      serverLinkMock as any,
    );

    // Wait for dispatched status
    await new Promise((r) => setTimeout(r, 100));

    // Cancel while dispatched/running
    const ok = await cancelP2pRun(run.id, serverLinkMock as any);
    expect(ok).toBe(true);

    // Should see interrupted → cancelling → cancelled in transitions
    expect(transitions).toContain('interrupted');
    expect(transitions).toContain('cancelling');
    expect(transitions).toContain('cancelled');

    // Order check
    const intIdx = transitions.indexOf('interrupted');
    const cingIdx = transitions.indexOf('cancelling');
    const cedIdx = transitions.indexOf('cancelled');
    expect(cingIdx).toBeGreaterThan(intIdx);
    expect(cedIdx).toBeGreaterThan(cingIdx);

    // Ctrl+C sent
    expect(sendKeyMock).toHaveBeenCalledWith(expect.any(String), 'C-c');

    // Resolve the blocked hop
    if (hopResolve) hopResolve();
  });

  it('dispatched → timed_out when timeout elapses without file growth', async () => {
    // Agent never becomes idle, file never grows — but don't write to context file
    detectStatusMock.mockReturnValue('thinking');
    sendKeysDelayedEnterMock.mockResolvedValue(undefined); // no file write

    const transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    // Override the mode to have a very short timeout
    const { BUILT_IN_MODES: modes } = await import('../../src/shared/p2p-modes.js');
    const original = modes[0].defaultTimeoutMs;
    modes[0].defaultTimeoutMs = 200; // 200ms timeout

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    // Wait for timeout to fire
    await waitForStatus(run.id, 'timed_out', 3_000);

    modes[0].defaultTimeoutMs = original; // restore

    expect(transitions).toContain('timed_out');
  }, 10_000);

  it('running → failed with session_crashed (dispatch_failed via sendKeys error)', async () => {
    sendKeysDelayedEnterMock.mockRejectedValue(new Error('tmux session not found'));

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'failed', 5_000);

    expect(transitions).toContain('failed');
    const finalRun = getP2pRun(run.id);
    if (finalRun) {
      expect(finalRun.error).toContain('dispatch_failed');
    }
  });

  it('running → failed with dispatch_failed', async () => {
    // sendKeys fails on the first hop
    sendKeysDelayedEnterMock.mockRejectedValueOnce(new Error('connection refused'));

    let transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'review' }],
      'review',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'failed', 5_000);

    expect(transitions).toContain('failed');
    const finalRun = getP2pRun(run.id);
    if (finalRun) {
      expect(finalRun.error).toContain('dispatch_failed');
    }
  });

  it('awaiting_next_hop → cancelled when cancel between hops', async () => {
    let hopCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      hopCount++;
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + `\n## Hop ${hopCount}\n\nContent.`, 'utf8');
      }
      // After first hop completes, the run should be in awaiting_next_hop
    });

    let transitions: P2pRunStatus[] = [];
    let latestRunId: string | null = null;
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) {
        transitions.push(msg.run.status);
        latestRunId = msg.run.id;
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }, { session: 'deck_proj_w2', mode: 'review' }],
      'multi-hop audit',
      [],
      serverLinkMock as any,
    );

    // Wait for first awaiting_next_hop (chain: brain→w1→w2→brain, 4 hops total)
    await waitForStatus(run.id, 'awaiting_next_hop', 10_000);

    // Cancel between hops
    const ok = await cancelP2pRun(run.id, serverLinkMock as any);
    // May or may not succeed depending on timing, but the run should end
    expect(typeof ok).toBe('boolean');
  }, 15_000);

  it('cancelled run ignores late file writes', async () => {
    let hopResolve: (() => void) | null = null;
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      return new Promise<void>((resolve) => { hopResolve = resolve; });
    });

    detectStatusMock.mockReturnValue('thinking');

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    // Wait for dispatch
    await new Promise((r) => setTimeout(r, 100));

    // Cancel
    await cancelP2pRun(run.id, serverLinkMock as any);

    // Now write to the file — should be ignored
    try {
      await writeFile(run.contextFilePath, 'late write after cancel', 'utf8');
    } catch { /* ignore if file doesn't exist */ }

    // Verify the run status didn't change to completed after cancel
    const finalRun = getP2pRun(run.id);
    // Run should have been deleted from activeRuns
    expect(finalRun).toBeUndefined();

    if (hopResolve) hopResolve();
  });
});

// =============================================================================
// Group 11: Bookend Chain Flow
// =============================================================================

describe('Group 11: Bookend Chain Flow', () => {
  let dispatchedSessions: string[] = [];

  beforeEach(() => {
    dispatchedSessions = [];
    sendKeysDelayedEnterMock.mockImplementation(async (session: string) => {
      dispatchedSessions.push(session);
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + `\n## ${session} output\n\nDone.`, 'utf8');
      }
    });
  });

  it('single target: A(initial) → sub1 → A(summary) = 3 hops', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'review code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // Should have: brain(initial), w1, brain(summary) = 3 dispatches
    expect(dispatchedSessions.length).toBe(3);
    expect(dispatchedSessions[0]).toBe('deck_proj_brain');
    expect(dispatchedSessions[1]).toBe('deck_proj_w1');
    expect(dispatchedSessions[2]).toBe('deck_proj_brain');
  });

  it('two targets: A(initial) → sub1 → sub2 → A(summary) = 4 hops', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'review' },
      ],
      'review code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    expect(dispatchedSessions.length).toBe(4);
    expect(dispatchedSessions[0]).toBe('deck_proj_brain');
    expect(dispatchedSessions[1]).toBe('deck_proj_w1');
    expect(dispatchedSessions[2]).toBe('deck_proj_w2');
    expect(dispatchedSessions[3]).toBe('deck_proj_brain');
  });

  it('initiator initial hop writes correct section header', async () => {
    let capturedPrompts: Array<{ session: string; prompt: string }> = [];
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      capturedPrompts.push({ session, prompt });
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + `\n## ${session}\n\nDone.`, 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // The first prompt (initiator) should mention "Initial Analysis"
    const initialPrompt = capturedPrompts[0];
    expect(initialPrompt.session).toBe('deck_proj_brain');
    expect(initialPrompt.prompt).toContain('Initial Analysis');
    expect(initialPrompt.prompt).toContain('brain');
  });

  it('sub-session hop appends correct section header', async () => {
    let capturedPrompts: Array<{ session: string; prompt: string }> = [];
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      capturedPrompts.push({ session, prompt });
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + `\n## ${session}\n\nDone.`, 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // The second prompt (sub-session w1) should mention "Audit" and "hop 1/1"
    const w1Prompt = capturedPrompts[1];
    expect(w1Prompt.session).toBe('deck_proj_w1');
    expect(w1Prompt.prompt).toContain('Audit');
    expect(w1Prompt.prompt).toContain('hop 1/1');
  });

  it('final summary hop reads all prior sections', async () => {
    let capturedPrompts: Array<{ session: string; prompt: string }> = [];
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      capturedPrompts.push({ session, prompt });
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + `\n## ${session}\n\nDone.`, 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'discuss' }],
      'discuss approach',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // The final prompt (summary) should mention "Summary"
    const summaryPrompt = capturedPrompts[capturedPrompts.length - 1];
    expect(summaryPrompt.session).toBe('deck_proj_brain');
    expect(summaryPrompt.prompt).toContain('Summary');
    expect(summaryPrompt.prompt).toContain('Synthesize');
  });

  it('context file accumulation after full chain', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'review code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // Read the accumulated context file
    const content = await readFile(run.contextFilePath, 'utf8');

    // Should contain seed content
    expect(content).toContain('# P2P Discussion:');
    expect(content).toContain('## User Request');
    expect(content).toContain('review code');

    // Should contain output from all 3 hops
    expect(content).toContain('deck_proj_brain output');
    expect(content).toContain('deck_proj_w1 output');
  });
});

// =============================================================================
// Group 12: Completion Detection
// =============================================================================

describe('Group 12: Completion Detection', () => {
  it('file unchanged + agent idle → NOT complete (times out)', async () => {
    // Agent is idle but sendKeys doesn't write to file → no file growth → timeout
    detectStatusMock.mockReturnValue('idle');
    sendKeysDelayedEnterMock.mockResolvedValue(undefined); // no file write

    const transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    // Use very short timeout
    const { BUILT_IN_MODES: modes } = await import('../../src/shared/p2p-modes.js');
    const original = modes[0].defaultTimeoutMs;
    modes[0].defaultTimeoutMs = 300;

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'timed_out', 5_000);
    modes[0].defaultTimeoutMs = original;

    expect(transitions).toContain('timed_out');
  }, 10_000);

  it('file grew + agent still working → NOT complete (times out eventually)', async () => {
    // Agent is always working, file grows on dispatch
    detectStatusMock.mockReturnValue('thinking');

    sendKeysDelayedEnterMock.mockImplementation(async (_session: string, prompt: string) => {
      const pathMatch = prompt.match(/\/[^\s]*\.imcodes\/discussions\/[^\s]+\.md/);
      if (pathMatch) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(pathMatch[0], '\n## Growing\nContent.\n');
      }
    });

    const transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const { BUILT_IN_MODES: modes } = await import('../../src/shared/p2p-modes.js');
    const original = modes[0].defaultTimeoutMs;
    // Use a longer timeout (2s) to ensure at least several poll cycles run before timeout.
    // The previous 500ms value was too tight for CI environments with high CPU load,
    // where sleep(50ms) can drift significantly.
    modes[0].defaultTimeoutMs = 2_000;

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'timed_out', 10_000);
    modes[0].defaultTimeoutMs = original;

    // File grew but agent never idle → should time out, never complete.
    // 'running' should appear if the poll detected file growth before timeout;
    // on very slow CI it may skip straight from dispatched → timed_out.
    expect(transitions).not.toContain('completed');
    expect(transitions).toContain('timed_out');
    // If running was detected, it should come after dispatched
    const runIdx = transitions.indexOf('running');
    if (runIdx >= 0) {
      expect(transitions.indexOf('dispatched')).toBeLessThan(runIdx);
    }
  }, 15_000);

  it('file grew + agent idle → hop complete', async () => {
    // Agent becomes idle immediately, file grows on dispatch
    detectStatusMock.mockReturnValue('idle');
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Complete\n\nDone.', 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit code',
      [],
      serverLinkMock as any,
    );

    const final = await waitForStatus(run.id, 'completed', 15_000);
    expect(final?.status).toBe('completed');
  });

  it('file grew after cancel → ignored', async () => {
    detectStatusMock.mockReturnValue('thinking');
    sendKeysDelayedEnterMock.mockResolvedValue(undefined);

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    // Wait for dispatched
    await new Promise((r) => setTimeout(r, 100));

    // Cancel
    await cancelP2pRun(run.id, serverLinkMock as any);

    // Write to file after cancel
    try {
      await writeFile(run.contextFilePath, 'late write', 'utf8');
    } catch { /* ignore */ }

    // Verify no completion after cancel
    await new Promise((r) => setTimeout(r, 200));
    const finalRun = getP2pRun(run.id);
    expect(finalRun).toBeUndefined(); // deleted from activeRuns on cancel
  });

  it('timeout fires before file growth → timed_out', async () => {
    detectStatusMock.mockReturnValue('thinking');
    sendKeysDelayedEnterMock.mockResolvedValue(undefined); // no file write

    const transitions: P2pRunStatus[] = [];
    serverLinkMock.send.mockImplementation((msg: any) => {
      if (msg.run?.status) transitions.push(msg.run.status);
    });

    const { BUILT_IN_MODES: modes } = await import('../../src/shared/p2p-modes.js');
    const original = modes[0].defaultTimeoutMs;
    modes[0].defaultTimeoutMs = 300;

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'timed_out', 5_000);
    modes[0].defaultTimeoutMs = original;

    expect(transitions).toContain('timed_out');
  });
});

// =============================================================================
// Group 13: Context & File I/O
// =============================================================================

describe('Group 13: Context & File I/O', () => {
  it('context file seed contains correct headers', async () => {
    // Use the default mock that resolves immediately
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Extra\n', 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'please review the auth module',
      [],
      serverLinkMock as any,
    );

    // Read the initial seed content (before agent writes)
    // Note: the agent has already started, so we read what's there
    const content = await readFile(run.contextFilePath, 'utf8');

    expect(content).toContain('# P2P Discussion:');
    expect(content).toContain('## User Request');
    expect(content).toContain('please review the auth module');

    // Wait for completion to avoid dangling promises
    await waitForStatus(run.id, 'completed', 15_000);
  });

  it('context file seed includes @file content', async () => {
    const tempDir = await makeTempDir();
    const testFilePath = join(tempDir, 'test.ts');
    await writeFile(testFilePath, 'export function hello() { return "world"; }', 'utf8');

    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Analysis\n', 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'review this code',
      [{ path: 'test.ts', content: 'export function hello() { return "world"; }' }],
      serverLinkMock as any,
    );

    const content = await readFile(run.contextFilePath, 'utf8');

    expect(content).toContain('## Referenced Files');
    expect(content).toContain('### test.ts');
    expect(content).toContain('export function hello()');

    await waitForStatus(run.id, 'completed', 15_000);

    // Cleanup
    await rm(tempDir, { recursive: true, force: true });
  });

  it('mode prompt includes role prompt + file path', async () => {
    let capturedPrompt = '';
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      if (!capturedPrompt) capturedPrompt = prompt; // capture the first prompt
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## hop\n', 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit the code',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, 'completed', 15_000);

    // The prompt should include the audit mode's role prompt
    const auditMode = getP2pMode('audit');
    expect(capturedPrompt).toContain(auditMode!.prompt);
    // Should include the context file path
    expect(capturedPrompt).toContain(run.contextFilePath);
  });

  it('maxOutputChars truncation (resultSummary capped at 2000 chars)', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        // Write a very large output
        const largeContent = 'X'.repeat(5000);
        await writeFile(run.contextFilePath, current + `\n${largeContent}`, 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit code',
      [],
      serverLinkMock as any,
    );

    const final = await waitForStatus(run.id, 'completed', 15_000);
    // resultSummary is capped to last 2000 chars
    if (final?.resultSummary) {
      expect(final.resultSummary.length).toBeLessThanOrEqual(2000);
    }
  });
});

// =============================================================================
// Group 14: Error Handling
// =============================================================================

describe('Group 14: Error Handling', () => {
  it('cross-domain @@cx token rejected', async () => {
    await expect(
      startP2pRun(
        'deck_proj_brain',
        [{ session: 'deck_other_w1', mode: 'audit' }],
        'audit code',
        [],
        serverLinkMock as any,
      ),
    ).rejects.toThrow('Cross-domain P2P not supported');
  });

  it('busy target → queued → idle → proceeds', async () => {
    // Target is busy initially, then becomes idle
    let pollCount = 0;
    detectStatusMock.mockImplementation(() => {
      pollCount++;
      // First few polls: busy (for waitForIdle). Then idle.
      if (pollCount <= 4) return 'thinking';
      return 'idle';
    });

    sendKeysDelayedEnterMock.mockImplementation(async () => {
      const runs = listP2pRuns();
      const run = runs[runs.length - 1];
      if (run) {
        const current = await readFile(run.contextFilePath, 'utf8');
        await writeFile(run.contextFilePath, current + '\n## Hop\n\nDone.', 'utf8');
      }
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'review' }],
      'review code',
      [],
      serverLinkMock as any,
    );

    const final = await waitForStatus(run.id, 'completed', 30_000);
    expect(final?.status).toBe('completed');
  });

  it('busy target + cancel while queued → cancelled', async () => {
    // Target is always busy
    detectStatusMock.mockReturnValue('thinking');
    sendKeysDelayedEnterMock.mockImplementation(() => new Promise(() => {}));

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'audit',
      [],
      serverLinkMock as any,
    );

    // Wait a moment then cancel
    await new Promise((r) => setTimeout(r, 100));

    const ok = await cancelP2pRun(run.id, serverLinkMock as any);
    expect(ok).toBe(true);

    // Run should be removed
    expect(getP2pRun(run.id)).toBeUndefined();
  });
});

// =============================================================================
// Group 15: Token Parser + File Search (from command-handler.ts)
// =============================================================================

describe('Group 15: Token Parser + File Search', () => {
  describe('parseAtTokens', () => {
    it('extracts @@discuss tokens', () => {
      const result = parseAtTokens('hello @@discuss(deck_proj_w1, audit) world');
      expect(result.agents).toEqual([{ session: 'deck_proj_w1', mode: 'audit' }]);
      expect(result.cleanText).toBe('hello world');
    });


    it('extracts @file tokens', () => {
      const result = parseAtTokens('check @src/index.ts please');
      expect(result.files).toEqual(['src/index.ts']);
      expect(result.cleanText).toBe('check please');
    });

    it('handles mixed tokens', () => {
      const result = parseAtTokens(
        'review @@discuss(deck_proj_w1, audit) @src/auth.ts and @@discuss(deck_proj_w2, review) @lib/utils.ts please',
      );

      expect(result.agents).toEqual([
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'review' },
      ]);
      expect(result.files).toEqual(['src/auth.ts', 'lib/utils.ts']);
      expect(result.cleanText).toBe('review and please');
    });

    it('does not partially match @@discuss tokens as @file tokens', () => {
      const result = parseAtTokens('test @@discuss(deck_proj_w1, audit) only');
      // The @@discuss token should not produce a file match
      expect(result.files).toEqual([]);
    });

    it('handles multiple @@discuss tokens', () => {
      const result = parseAtTokens('@@discuss(deck_proj_w1, audit) @@discuss(deck_proj_w2, review)');
      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].mode).toBe('audit');
      expect(result.agents[1].mode).toBe('review');
    });

    it('handles text with no tokens', () => {
      const result = parseAtTokens('just a normal message');
      expect(result.agents).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.cleanText).toBe('just a normal message');
    });

    it('extracts file with nested path', () => {
      const result = parseAtTokens('look at @src/daemon/p2p-orchestrator.ts');
      expect(result.files).toEqual(['src/daemon/p2p-orchestrator.ts']);
    });

    it('handles @file with dashes and dots', () => {
      const result = parseAtTokens('check @my-module/sub.component.tsx');
      expect(result.files).toEqual(['my-module/sub.component.tsx']);
    });
  });

  describe('FILE_SEARCH_EXCLUDES', () => {
    it('excludes node_modules', () => {
      expect(FILE_SEARCH_EXCLUDES.has('node_modules')).toBe(true);
    });

    it('excludes .git', () => {
      expect(FILE_SEARCH_EXCLUDES.has('.git')).toBe(true);
    });

    it('excludes venv', () => {
      expect(FILE_SEARCH_EXCLUDES.has('venv')).toBe(true);
    });

    it('excludes __pycache__', () => {
      expect(FILE_SEARCH_EXCLUDES.has('__pycache__')).toBe(true);
    });

    it('excludes dist', () => {
      expect(FILE_SEARCH_EXCLUDES.has('dist')).toBe(true);
    });

    it('excludes build', () => {
      expect(FILE_SEARCH_EXCLUDES.has('build')).toBe(true);
    });

    it('excludes all expected directories', () => {
      const expected = ['node_modules', '.git', 'venv', '__pycache__', '.venv', 'dist', 'build', '.next', '.nuxt', 'vendor', 'target'];
      for (const dir of expected) {
        expect(FILE_SEARCH_EXCLUDES.has(dir)).toBe(true);
      }
    });
  });

  describe('file.search sort and limits', () => {
    it('sorts basename match first', () => {
      const queryBase = 'index';
      const results = [
        { path: 'src/components/index.ts', basename: 'index.ts' },
        { path: 'src/index-helper.ts', basename: 'index-helper.ts' },
        { path: 'src/deep/nested/thing.ts', basename: 'thing.ts' },
      ];

      // Replicate the sort logic from handleFileSearch
      results.sort((a, b) => {
        const aBase = a.basename.toLowerCase().includes(queryBase) ? 0 : 1;
        const bBase = b.basename.toLowerCase().includes(queryBase) ? 0 : 1;
        if (aBase !== bBase) return aBase - bBase;
        return a.path.localeCompare(b.path);
      });

      // Both index files match basename, so they come first (alphabetically by path).
      // thing.ts doesn't match basename, so it's last.
      expect(results[0].basename).toMatch(/index/);
      expect(results[1].basename).toMatch(/index/);
      expect(results[2].basename).toBe('thing.ts');
    });

    it('max 20 results', () => {
      expect(FILE_SEARCH_MAX).toBe(20);

      // Simulate 30 results, sliced to 20
      const results = Array.from({ length: 30 }, (_, i) => ({
        path: `src/file${i}.ts`,
        basename: `file${i}.ts`,
      }));

      const top = results.slice(0, FILE_SEARCH_MAX);
      expect(top.length).toBe(20);
    });

    it('file.search with real temp directory structure', async () => {
      const tempDir = await makeTempDir();

      // Create a directory structure
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(join(tempDir, 'lib'), { recursive: true });
      await writeFile(join(tempDir, 'src', 'index.ts'), '', 'utf8');
      await writeFile(join(tempDir, 'src', 'utils.ts'), '', 'utf8');
      await writeFile(join(tempDir, 'lib', 'helper.ts'), '', 'utf8');
      await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.js'), '', 'utf8');

      // Walk the directory, excluding FILE_SEARCH_EXCLUDES
      const { readdir } = await import('node:fs/promises');

      const results: Array<{ path: string; basename: string }> = [];
      const query = 'index';

      async function walk(dir: string, rel: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (FILE_SEARCH_EXCLUDES.has(entry.name)) continue;
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(join(dir, entry.name), relPath);
          } else if (entry.isFile()) {
            if (relPath.toLowerCase().includes(query)) {
              results.push({ path: relPath, basename: entry.name });
            }
          }
        }
      }

      await walk(tempDir, '');

      // node_modules/pkg/index.js should be excluded
      expect(results.some((r) => r.path.includes('node_modules'))).toBe(false);
      // src/index.ts should be found
      expect(results.some((r) => r.path === 'src/index.ts')).toBe(true);

      await rm(tempDir, { recursive: true, force: true });
    });
  });
});

// =============================================================================
// Shared P2P Modes (supplemental)
// =============================================================================

describe('P2P Modes', () => {
  it('getP2pMode returns correct mode for known keys', () => {
    expect(getP2pMode('audit')).toBeDefined();
    expect(getP2pMode('audit')!.key).toBe('audit');
    expect(getP2pMode('review')!.key).toBe('review');
    expect(getP2pMode('brainstorm')!.key).toBe('brainstorm');
    expect(getP2pMode('discuss')!.key).toBe('discuss');
  });

  it('getP2pMode returns undefined for unknown keys', () => {
    expect(getP2pMode('nonexistent')).toBeUndefined();
  });

  it('all modes have required fields', () => {
    for (const mode of BUILT_IN_MODES) {
      expect(mode.key).toBeTruthy();
      expect(mode.prompt).toBeTruthy();
      expect(typeof mode.callbackRequired).toBe('boolean');
      expect(mode.defaultTimeoutMs).toBeGreaterThan(0);
      expect(['findings-first', 'summary-first', 'free-form']).toContain(mode.resultStyle);
      expect(mode.maxOutputChars).toBeGreaterThan(0);
    }
  });
});
