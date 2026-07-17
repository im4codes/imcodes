/**
 * Forced-fresh (`fresh:true`) provider-family-independence for startSubSession,
 * plus the transport-teardown execution-clone completion hook in stopSubSession.
 *
 * Item 11 — when a sub-session record carries `fresh:true` (e.g. an execution
 * clone), the launch path MUST start a brand-new provider/CLI session for EVERY
 * provider family and MUST NOT carry any stored runtime identity (provider/CLI
 * session ids, resume tokens, bind keys). These tests pass OLD identity ids in
 * and assert none of them reach `launchTransportSession` (transport) or
 * `resolveStructuredSessionBootstrap` / the driver launch opts (process), while
 * `fresh:true` DOES reach the launch layer. The non-fresh path is asserted
 * unchanged.
 *
 * Item 18b — on a successful transport-runtime teardown of an execution clone,
 * `stopSubSession` calls `completeExecutionCloneOnRuntimeExit(record,
 * 'destroyed')` BEFORE `removeSession`, driving the metadata transition to
 * `cleanupState:'collecting'` so the daemon GC sweep can reap it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  type ExecutionCloneMetadata,
} from '../../shared/execution-clone.js';

const {
  upsertSessionMock, getSessionMock, removeSessionMock,
  startWatchingFileMock, jsonlStartWatchingMock, jsonlIsWatchingMock,
  jsonlStopWatchingMock, codexStopWatchingMock, geminiStopWatchingMock, opencodeStopWatchingMock,
  codexStartWatchingByIdMock, geminiStartWatchingMock, opencodeStartWatchingMock,
  sessionExistsMock, newSessionMock, getDriverMock,
  killSessionMock, timelineEmitMock, emitSessionInlineErrorMock,
  launchTransportSessionMock, getTransportRuntimeMock, stopTransportRuntimeSessionMock,
  getAgentVersionMock, capturePaneMock, timelineReadMock,
  resolveBootstrapMock,
  isExecutionCloneMock, completeExecutionCloneOnRuntimeExitMock,
} = vi.hoisted(() => ({
  upsertSessionMock: vi.fn(),
  getSessionMock: vi.fn(() => null),
  removeSessionMock: vi.fn(),
  startWatchingFileMock: vi.fn().mockResolvedValue(undefined),
  jsonlStartWatchingMock: vi.fn().mockResolvedValue(undefined),
  jsonlIsWatchingMock: vi.fn().mockReturnValue(false),
  jsonlStopWatchingMock: vi.fn(),
  codexStopWatchingMock: vi.fn(),
  geminiStopWatchingMock: vi.fn(),
  opencodeStopWatchingMock: vi.fn(),
  codexStartWatchingByIdMock: vi.fn().mockResolvedValue(undefined),
  geminiStartWatchingMock: vi.fn().mockResolvedValue(undefined),
  opencodeStartWatchingMock: vi.fn().mockResolvedValue(undefined),
  sessionExistsMock: vi.fn().mockResolvedValue(false),
  newSessionMock: vi.fn().mockResolvedValue(undefined),
  getDriverMock: vi.fn(),
  killSessionMock: vi.fn().mockResolvedValue(undefined),
  timelineEmitMock: vi.fn(),
  emitSessionInlineErrorMock: vi.fn(),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  getTransportRuntimeMock: vi.fn().mockReturnValue(null),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  getAgentVersionMock: vi.fn().mockResolvedValue(undefined),
  capturePaneMock: vi.fn().mockResolvedValue([]),
  timelineReadMock: vi.fn(() => Promise.resolve([])),
  resolveBootstrapMock: vi.fn(async () => ({})),
  isExecutionCloneMock: vi.fn().mockReturnValue(false),
  completeExecutionCloneOnRuntimeExitMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  upsertSession: upsertSessionMock,
  getSession: getSessionMock,
  removeSession: removeSessionMock,
  createRuntimeEpoch: vi.fn(() => 'runtime-epoch-new'),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatchingFile: startWatchingFileMock,
  startWatching: jsonlStartWatchingMock,
  stopWatching: jsonlStopWatchingMock,
  isWatching: jsonlIsWatchingMock,
  preClaimFile: vi.fn(),
  claudeProjectDir: (dir: string) => `/mock-claude-projects/${dir.replace(/\//g, '-')}`,
  findJsonlPathBySessionId: (dir: string, id: string) => `/mock-claude-projects/${dir.replace(/\//g, '-')}/${id}.jsonl`,
  ensureClaudeSessionFile: vi.fn().mockResolvedValue('/mock/seed.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: codexStartWatchingByIdMock,
  stopWatching: codexStopWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
  isFileClaimedByOther: vi.fn().mockReturnValue(false),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: geminiStartWatchingMock,
  startWatchingDiscovered: vi.fn().mockResolvedValue(undefined),
  stopWatching: geminiStopWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: opencodeStartWatchingMock,
  stopWatching: opencodeStopWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/opencode-history.js', () => ({
  // Forced-fresh opencode launches with no stored id, then waits for a brand-new
  // session id to be minted by the CLI.
  listOpenCodeSessions: vi.fn().mockResolvedValue([]),
  waitForOpenCodeSessionId: vi.fn().mockResolvedValue('fresh-opencode-id'),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  newSession: newSessionMock,
  killSession: killSessionMock,
  sessionExists: sessionExistsMock,
  capturePane: capturePaneMock,
  sendKey: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  getPanePids: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getDriver: getDriverMock,
  launchTransportSession: launchTransportSessionMock,
  getTransportRuntime: getTransportRuntimeMock,
  stopTransportRuntimeSession: stopTransportRuntimeSessionMock,
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: getAgentVersionMock,
}));

vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({
  resolveStructuredSessionBootstrap: resolveBootstrapMock,
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: { rebindSession: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { readPreferred: timelineReadMock, read: timelineReadMock, append: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })), forgetSession: vi.fn() },
}));

vi.mock('../../src/daemon/session-error.js', () => ({
  emitSessionInlineError: emitSessionInlineErrorMock,
}));

// Item 18b: stub the execution-clone module so stopSubSession's dynamic import
// resolves to controllable spies. The real completion fn (added by a parallel
// change) is responsible for the metadata write; here the stub simulates that
// transition so we can assert the hook drives it.
vi.mock('../../src/daemon/execution-clone.js', () => ({
  isExecutionClone: isExecutionCloneMock,
  completeExecutionCloneOnRuntimeExit: completeExecutionCloneOnRuntimeExitMock,
}));

import { startSubSession, stopSubSession } from '../../src/daemon/subsession-manager.js';

// Fields that must NEVER appear on a forced-fresh launch (any provider family).
const OLD_TRANSPORT_IDS = {
  providerSessionId: 'OLD-provider-sid',
  ccSessionId: 'OLD-cc-id',
  codexSessionId: 'OLD-codex-id',
};

function lastTransportLaunchArg(): Record<string, unknown> {
  const calls = launchTransportSessionMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe('startSubSession — forced fresh (transport families)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue(null);
    getTransportRuntimeMock.mockReturnValue(null);
    launchTransportSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // openclaw included; qwen/cursor-headless/copilot-sdk/gemini-sdk/grok-sdk are the
  // families the OLD code never passed `fresh` to.
  const TRANSPORT_FAMILIES = ['qwen', 'cursor-headless', 'copilot-sdk', 'gemini-sdk', 'grok-sdk', 'openclaw'] as const;

  for (const type of TRANSPORT_FAMILIES) {
    it(`${type}: fresh:true reaches launch, NO old identity / bind reaches launchTransportSession`, async () => {
      await startSubSession({
        id: `ff-${type}`,
        type,
        cwd: '/proj',
        parentSession: 'deck_proj_brain',
        fresh: true,
        ...OLD_TRANSPORT_IDS,
      });

      expect(launchTransportSessionMock).toHaveBeenCalledTimes(1);
      const arg = lastTransportLaunchArg();

      // fresh:true reaches the launch layer
      expect(arg.fresh).toBe(true);
      // brand-new provider session — never bind/skipCreate an existing one
      expect(arg.skipCreate).toBe(false);
      expect(arg.bindExistingKey).toBeUndefined();
      // NO stored runtime identity is forwarded for any family
      expect(arg.providerSessionId).toBeUndefined();
      expect(arg.providerResumeId).toBeUndefined();
      expect(arg.ccSessionId).toBeUndefined();
      expect(arg.codexSessionId).toBeUndefined();
      expect(arg.geminiSessionId).toBeUndefined();
      expect(arg.opencodeSessionId).toBeUndefined();
      // Old ids must not leak via ANY field
      const serialized = JSON.stringify(arg);
      expect(serialized).not.toContain('OLD-provider-sid');
      expect(serialized).not.toContain('OLD-cc-id');
      expect(serialized).not.toContain('OLD-codex-id');
    });
  }

  it('claude-code-sdk forced fresh: mints a NEW ccSessionId, never forwards the old one', async () => {
    await startSubSession({
      id: 'ff-cc-sdk',
      type: 'claude-code-sdk',
      cwd: '/proj',
      parentSession: 'deck_proj_brain',
      fresh: true,
      ...OLD_TRANSPORT_IDS,
    });

    const arg = lastTransportLaunchArg();
    expect(arg.fresh).toBe(true);
    expect(arg.skipCreate).toBe(false);
    expect(arg.bindExistingKey).toBeUndefined();
    expect(arg.providerSessionId).toBeUndefined();
    // claude-code-sdk needs a freshly generated ccSessionId — and it must NOT
    // be the old one.
    expect(typeof arg.ccSessionId).toBe('string');
    expect(arg.ccSessionId).not.toBe('OLD-cc-id');
    expect(String(arg.ccSessionId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg.codexSessionId).toBeUndefined();
  });
});

describe('startSubSession — forced fresh (process families)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue(null);
    getTransportRuntimeMock.mockReturnValue(null);
    sessionExistsMock.mockResolvedValue(false);
    newSessionMock.mockResolvedValue(undefined);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: vi.fn(() => 'launch-cmd'),
      buildResumeCommand: vi.fn(() => 'resume-cmd'),
      postLaunch: undefined,
    });
    // Bootstrap returns FRESH ids (the resolver mints brand-new ones when no
    // stored id is passed). It must be invoked WITHOUT any old id.
    resolveBootstrapMock.mockImplementation(async () => ({
      ccSessionId: 'fresh-cc-id',
      codexSessionId: 'fresh-codex-id',
      geminiSessionId: 'fresh-gemini-id',
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const PROCESS_FAMILIES = ['claude-code', 'codex', 'gemini', 'opencode'] as const;

  for (const type of PROCESS_FAMILIES) {
    it(`${type}: no old id reaches resolveStructuredSessionBootstrap or driver launch opts; fresh:true reaches launch opts`, async () => {
      await startSubSession({
        id: `ff-proc-${type}`,
        type,
        cwd: '/proj',
        fresh: true,
        ccSessionId: 'OLD-cc-id',
        codexSessionId: 'OLD-codex-id',
        geminiSessionId: 'OLD-gemini-id',
        opencodeSessionId: 'OLD-opencode-id',
      });

      // launchTransportSession is never used for process families
      expect(launchTransportSessionMock).not.toHaveBeenCalled();

      // Bootstrap must be called with NO stored identity ids
      expect(resolveBootstrapMock).toHaveBeenCalledTimes(1);
      const bootstrapArg = resolveBootstrapMock.mock.calls[0][0] as Record<string, unknown>;
      expect(bootstrapArg.ccSessionId).toBeUndefined();
      expect(bootstrapArg.codexSessionId).toBeUndefined();
      expect(bootstrapArg.geminiSessionId).toBeUndefined();
      expect(bootstrapArg.isNewSession).toBe(true);
      const bootstrapSerialized = JSON.stringify(bootstrapArg);
      expect(bootstrapSerialized).not.toContain('OLD-');

      // Driver launch opts must carry fresh:true and NO old id
      const buildLaunch = getDriverMock.mock.results[0]?.value.buildLaunchCommand as ReturnType<typeof vi.fn>;
      expect(buildLaunch).toHaveBeenCalledTimes(1);
      const launchOpts = buildLaunch.mock.calls[0][1] as Record<string, unknown>;
      expect(launchOpts.fresh).toBe(true);
      const launchSerialized = JSON.stringify(launchOpts);
      expect(launchSerialized).not.toContain('OLD-cc-id');
      expect(launchSerialized).not.toContain('OLD-codex-id');
      expect(launchSerialized).not.toContain('OLD-gemini-id');
      expect(launchSerialized).not.toContain('OLD-opencode-id');
    });
  }

  it('claude-code forced fresh never uses --resume (buildResumeCommand not called)', async () => {
    await startSubSession({
      id: 'ff-cc-noresume',
      type: 'claude-code',
      cwd: '/proj',
      fresh: true,
      ccSessionId: 'OLD-cc-id',
    });

    const buildResume = getDriverMock.mock.results[0]?.value.buildResumeCommand as ReturnType<typeof vi.fn>;
    const buildLaunch = getDriverMock.mock.results[0]?.value.buildLaunchCommand as ReturnType<typeof vi.fn>;
    expect(buildResume).not.toHaveBeenCalled();
    expect(buildLaunch).toHaveBeenCalledTimes(1);
  });
});

describe('startSubSession — non-fresh path unchanged (no regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue(null);
    getTransportRuntimeMock.mockReturnValue(null);
    sessionExistsMock.mockResolvedValue(false);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: vi.fn(() => 'launch-cmd'),
      buildResumeCommand: vi.fn(() => 'resume-cmd'),
      postLaunch: undefined,
    });
    resolveBootstrapMock.mockImplementation(async (input: Record<string, unknown>) => ({
      ccSessionId: (input.ccSessionId as string) ?? undefined,
      codexSessionId: (input.codexSessionId as string) ?? undefined,
      geminiSessionId: (input.geminiSessionId as string) ?? undefined,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('transport non-fresh with providerSessionId still binds + skipCreate true (existing behavior)', async () => {
    await startSubSession({
      id: 'nf-qwen',
      type: 'qwen',
      cwd: '/proj',
      parentSession: 'deck_proj_brain',
      providerSessionId: 'bind-this-sid',
      // no fresh flag
    });

    const arg = lastTransportLaunchArg();
    expect(arg.bindExistingKey).toBe('bind-this-sid');
    expect(arg.skipCreate).toBe(true);
    // The old behavior forwards sub.fresh (undefined here) under providerSessionId
    expect(arg.fresh).toBeUndefined();
  });

  it('grok-sdk non-fresh resumes only from providerResumeId and never binds the stale route key', async () => {
    await startSubSession({
      id: 'nf-grok',
      type: 'grok-sdk',
      cwd: '/proj',
      parentSession: 'deck_proj_brain',
      providerSessionId: 'stale-local-route',
      providerResumeId: 'grok-acp-session',
    });

    const arg = lastTransportLaunchArg();
    expect(arg.providerResumeId).toBe('grok-acp-session');
    expect(arg.bindExistingKey).toBeUndefined();
    expect(arg.skipCreate).toBe(true);
    expect(arg.fresh).toBeUndefined();
  });

  it('grok-sdk ignores a local route key without providerResumeId and starts fresh', async () => {
    await startSubSession({
      id: 'nf-grok-stale-route',
      type: 'grok-sdk',
      cwd: '/proj',
      providerSessionId: 'stale-local-route',
    });

    const arg = lastTransportLaunchArg();
    expect(arg.providerResumeId).toBeUndefined();
    expect(arg.bindExistingKey).toBeUndefined();
    expect(arg.skipCreate).toBe(false);
    expect(arg.fresh).toBe(true);
  });

  it('process non-fresh forwards stored ccSessionId into bootstrap + launch opts (existing behavior)', async () => {
    await startSubSession({
      id: 'nf-cc',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: 'keep-cc-id',
      // no fresh flag
    });

    const bootstrapArg = resolveBootstrapMock.mock.calls[0][0] as Record<string, unknown>;
    expect(bootstrapArg.ccSessionId).toBe('keep-cc-id');

    const buildLaunch = getDriverMock.mock.results[0]?.value.buildLaunchCommand as ReturnType<typeof vi.fn>;
    const launchOpts = buildLaunch.mock.calls[0][1] as Record<string, unknown>;
    expect(launchOpts.ccSessionId).toBe('keep-cc-id');
    expect(launchOpts.fresh).toBeUndefined();
  });
});

describe('stopSubSession — transport execution-clone runtime-exit completion (Item 18b)', () => {
  const CLONE_NAME = 'deck_sub_clonexyz';

  function cloneMetadata(state: ExecutionCloneMetadata['cleanupState'] = 'active'): ExecutionCloneMetadata {
    return {
      kind: EXECUTION_CLONE_KIND,
      ephemeral: true,
      cloneOfSessionName: 'deck_proj_w1',
      parentRunId: 'run-1',
      parentStage: 'implement',
      createdBySessionName: 'deck_proj_brain',
      createdAt: 1,
      hardTimeoutAt: 999999,
      retentionExpiresAt: null,
      cleanupState: state,
      autoDestroy: true,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getTransportRuntimeMock.mockReturnValue(null);
    sessionExistsMock.mockResolvedValue(false);
    stopTransportRuntimeSessionMock.mockResolvedValue(undefined);
    // Simulate the real completion fn: transition the record metadata to
    // `collecting` via upsertSession (what the parallel-change fn does).
    isExecutionCloneMock.mockReturnValue(true);
    completeExecutionCloneOnRuntimeExitMock.mockImplementation(async (rec: { name: string; executionCloneMetadata?: ExecutionCloneMetadata }) => {
      upsertSessionMock({
        ...rec,
        executionCloneMetadata: { ...rec.executionCloneMetadata, cleanupState: 'collecting' },
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls completeExecutionCloneOnRuntimeExit(record, "destroyed") on transport stop success, before removeSession, transitioning to collecting', async () => {
    const record = {
      name: CLONE_NAME,
      projectName: 'proj',
      role: 'w1' as const,
      agentType: 'qwen',
      projectDir: '/proj',
      state: 'running' as const,
      runtimeType: 'transport' as const,
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      parentSession: 'deck_proj_brain',
      executionCloneMetadata: cloneMetadata('active'),
    };
    getSessionMock.mockReturnValue(record);

    const result = await stopSubSession(CLONE_NAME);

    expect(result.ok).toBe(true);
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith(CLONE_NAME);
    // Hook invoked with the record + 'destroyed'
    expect(completeExecutionCloneOnRuntimeExitMock).toHaveBeenCalledTimes(1);
    expect(completeExecutionCloneOnRuntimeExitMock).toHaveBeenCalledWith(record, 'destroyed');

    // Metadata transitioned to collecting via the (mocked) completion fn
    expect(upsertSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: CLONE_NAME,
        executionCloneMetadata: expect.objectContaining({ cleanupState: 'collecting' }),
      }),
    );

    // Completion runs BEFORE removeSession (persistSuccess)
    expect(removeSessionMock).toHaveBeenCalledWith(CLONE_NAME);
    const completeOrder = completeExecutionCloneOnRuntimeExitMock.mock.invocationCallOrder[0];
    const removeOrder = removeSessionMock.mock.invocationCallOrder[0];
    expect(completeOrder).toBeLessThan(removeOrder);
  });

  it('does NOT call the completion hook for a non-clone transport session', async () => {
    isExecutionCloneMock.mockReturnValue(false);
    const record = {
      name: 'deck_sub_plain',
      projectName: 'proj',
      role: 'w1' as const,
      agentType: 'qwen',
      projectDir: '/proj',
      state: 'running' as const,
      runtimeType: 'transport' as const,
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      parentSession: 'deck_proj_brain',
    };
    getSessionMock.mockReturnValue(record);

    const result = await stopSubSession('deck_sub_plain');

    expect(result.ok).toBe(true);
    expect(completeExecutionCloneOnRuntimeExitMock).not.toHaveBeenCalled();
  });
});
