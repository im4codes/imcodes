/**
 * The transport runtime hands an open pair's executor/auditor turn its pair
 * workspace (tsk_cd_executor_default_cwd): as the turn's cwd for a provider that
 * takes one, as a one-line `cwd:` preamble for one that cannot. Brain, sessions
 * without an open pair, and turns after the pair ended are unchanged.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests } from '../../src/daemon/task-pairs/focus.js';
import type { TaskPairState, TaskPairStatus } from '../../shared/task-pair.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitterEmitMock },
}));

const PROJECT = 'rtcwdproj';
const BRAIN = 'deck_rtcwdproj_brain';
const EXEC = 'deck_sub_rtcwdexec';
const OWNER = 'deck_sub_rtcwdowner';
let root: string;
let workspace: string;
let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;

function makeProvider(turnCwd: boolean): TransportProvider {
  return {
    id: 'test-transport',
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities: {
      streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false,
      contextSupport: 'full-normalized-context-injection',
      ...(turnCwd ? { turnCwd: true } : {}),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    createSession: vi.fn().mockResolvedValue('provider-session-1'),
    endSession: vi.fn(),
    onDelta: (_callback: (sessionId: string, delta: MessageDelta) => void) => () => undefined,
    onComplete: (callback: (sessionId: string, message: AgentMessage) => void) => { complete = callback; return () => undefined; },
    onError: (_callback: (sessionId: string, error: ProviderError) => void) => () => undefined,
    onApprovalRequest: () => undefined,
    onStatus: (_callback: (sessionId: string, status: ProviderStatusUpdate) => void) => () => undefined,
    onUsage: (_callback: (sessionId: string, update: ProviderUsageUpdate) => void) => () => undefined,
    onToolCall: (_callback: (sessionId: string, toolCall: ToolCallEvent) => void) => () => undefined,
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: '/Users/test/main-checkout', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function savePair(status: TaskPairStatus): void {
  const now = Date.now();
  getTaskPairStore().savePair(PROJECT, {
    taskId: 'T1', status, brain: BRAIN, executor: EXEC, auditor: 'deck_sub_rtcwdaud', round: 1, blocking: ['P0'], title: 'demo',
    workspace: { kind: 'worktree', path: workspace, createdAt: now, status: 'active' },
    createdAt: now, updatedAt: now,
  } as unknown as TaskPairState);
}

const sends = (provider: TransportProvider) => (provider.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as ProviderContextPayload);

async function waitForSends(provider: TransportProvider, count: number): Promise<ProviderContextPayload[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (sends(provider).length >= count) break;
  }
  expect(sends(provider)).toHaveLength(count);
  return sends(provider);
}

const turnDone = (): AgentMessage => ({
  id: 'turn-done', sessionId: 'provider-session-1', kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete',
});

async function runtimeFor(provider: TransportProvider, name: string): Promise<TransportSessionRuntime> {
  const runtime = new TransportSessionRuntime(provider, name);
  await runtime.initialize({ sessionKey: name });
  return runtime;
}

describe('transport runtime: pair participant turn cwd', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imc-rt-cwd-'));
    workspace = join(root, 'pair_t1/repo');
    mkdirSync(workspace, { recursive: true });
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
    timelineEmitterEmitMock.mockReset();
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    complete = undefined;
    upsertSession(session(BRAIN, 'brain'));
    upsertSession(session(EXEC, 'w1'));
    upsertSession(session(OWNER, 'w2'));
    savePair('working');
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, OWNER]) removeSession(name);
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    rmSync(root, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('a provider that takes a turn cwd gets the workspace as turnCwd, and it reverts once the pair is done', async () => {
    const provider = makeProvider(true);
    const runtime = await runtimeFor(provider, EXEC);
    runtime.send('do the work', 'work-1');
    const [first] = await waitForSends(provider, 1);
    expect(first!.turnCwd).toBe(workspace);
    expect(first!.messagePreamble ?? '').not.toContain('cwd:');

    savePair('done');
    complete?.('provider-session-1', turnDone());
    runtime.send('one more thing', 'work-2');
    const second = (await waitForSends(provider, 2))[1]!;
    expect(second.turnCwd).toBeUndefined();
    expect(second.assembledMessage).not.toContain(workspace);
  });

  it('a provider that cannot take a turn cwd is told the workspace on one line instead', async () => {
    const provider = makeProvider(false);
    const runtime = await runtimeFor(provider, EXEC);
    runtime.send('do the work', 'work-1');
    const [payload] = await waitForSends(provider, 1);
    expect(payload!.turnCwd).toBeUndefined();
    expect(payload!.assembledMessage).toContain(`cwd: ${workspace}`);
  });

  it('a non-git project: a task-directory workspace is the turn cwd, as turnCwd or as the fallback line', async () => {
    const taskDir = join(root, 'works', PROJECT, 'T1');
    mkdirSync(taskDir, { recursive: true });
    const now = Date.now();
    getTaskPairStore().savePair(PROJECT, {
      taskId: 'T1', status: 'working', brain: BRAIN, executor: EXEC, auditor: 'deck_sub_rtcwdaud', round: 1, blocking: ['P0'], title: 'demo',
      workspace: { kind: 'dir', path: taskDir, createdAt: now, status: 'active' },
      createdAt: now, updatedAt: now,
    } as unknown as TaskPairState);
    const capable = makeProvider(true);
    (await runtimeFor(capable, EXEC)).send('do the work', 'dir-1');
    expect((await waitForSends(capable, 1))[0]!.turnCwd).toBe(taskDir);
    const incapable = makeProvider(false);
    (await runtimeFor(incapable, EXEC)).send('do the work', 'dir-2');
    expect((await waitForSends(incapable, 1))[0]!.assembledMessage).toContain(`cwd: ${taskDir}`);
  });

  it.each([
    ['Brain', BRAIN],
    ['a session without an open pair', OWNER],
  ])('%s is unchanged', async (_label, name) => {
    for (const takesTurnCwd of [true, false]) {
      const provider = makeProvider(takesTurnCwd);
      const runtime = await runtimeFor(provider, name);
      runtime.send('hello', 'plain-1');
      const [payload] = await waitForSends(provider, 1);
      expect(payload!.turnCwd).toBeUndefined();
      expect(payload!.assembledMessage).not.toContain('cwd:');
      expect(payload!.assembledMessage).not.toContain(workspace);
    }
  });
});
