import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from '../../shared/memory-mcp-feature-flags.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, type MemoryFeatureFlag } from '../../shared/feature-flags.js';
import {
  MEMORY_MCP_DISABLED_FLAGS,
  MEMORY_MCP_TOOL_CONTRACTS,
  MEMORY_MCP_TOOL_NAMES,
} from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import { CRON_COMPLETION_POLICY } from '../../shared/cron-types.js';
import { MEMORY_MCP_DEGRADED_REASON } from '../../shared/memory-ws.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
vi.mock('../../src/util/rate-limited-warn.js', () => ({ warnOncePerHour: vi.fn() }));

import { makeMemoryShortRef, registerMemoryShortRef, resetMemoryShortRefsForTests, seedMemoryShortRefCollisionForTests } from '../../src/context/memory-short-ref.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function caller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return {
    userId: 'user-1',
    namespace,
    sessionName: 'deck_proj_brain',
    projectName: 'proj',
    projectRoot: '/tmp/proj',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function projection(overrides: Partial<ProcessedContextProjection> = {}): ProcessedContextProjection {
  return {
    id: 'proj-1',
    namespace: { scope: 'personal', userId: 'user-1', projectId: 'repo-1' },
    class: 'durable_memory_candidate',
    sourceEventIds: ['evt-1'],
    summary: 'existing memory',
    content: { text: 'existing memory' },
    createdAt: 1,
    updatedAt: 1,
    status: 'active',
    ...overrides,
  };
}

describe('memory MCP tool schema firewall', () => {
  let shortRefDir: string;
  let priorShortRefPath: string | undefined;
  let priorLegacyPath: string | undefined;

  beforeEach(() => {
    // Registering a handle now persists it, and the default target is the
    // context store — which would build a real SQLite database and WAL in the
    // runner's home directory just from exercising these handlers. Point
    // persistence at a scratch file, and the legacy cache at a path that does
    // not exist. The collision cases also emit a throttled warning, so the
    // warning module is stubbed above to keep that content out of the daemon
    // log. Two writes remain outside this suite's reach and are NOT claimed to
    // be isolated: the daemon logger creates its file when the module is
    // imported, and one pre-existing observation-expansion case below builds the
    // context store.
    shortRefDir = mkdtempSync(join(tmpdir(), 'imc-mcp-shortref-'));
    priorShortRefPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacyPath = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_PATH = join(shortRefDir, 'refs.json');
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = join(shortRefDir, 'absent-legacy.json');
    resetMemoryShortRefsForTests();
  });

  afterEach(() => {
    resetMemoryShortRefsForTests();
    if (priorShortRefPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorShortRefPath;
    if (priorLegacyPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacyPath;
    rmSync(shortRefDir, { recursive: true, force: true });
  });

  it('submits peer audit replies only through the strict structured dependency', async () => {
    const peerAuditReply = vi.fn(async () => ({ ok: true }));
    const handlers = createMemoryMcpToolHandlers(caller(), { peerAuditReply });
    const valid = {
      attemptId: 'attempt_12345678',
      replyCapability: 'A'.repeat(32),
      verdict: 'PASS',
      findings: 'Focused tests passed.',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    };
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY](valid)).resolves.toEqual({ status: 'ok', accepted: true });
    expect(peerAuditReply).toHaveBeenCalledWith(expect.objectContaining({
      version: 'peer_audit_reply_v1',
      attemptId: valid.attemptId,
      replyCapability: valid.replyCapability,
    }));

    const forged = await handlers[MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]({ ...valid, injectedTarget: 'other-session' });
    expect(forged).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(peerAuditReply).toHaveBeenCalledTimes(1);
  });

  it('submits delegation replies only through the strict structured dependency', async () => {
    const delegationReply = vi.fn(async () => ({ ok: true, delivered: true }));
    const handlers = createMemoryMcpToolHandlers(caller(), { delegationReply });
    const valid = {
      delegationId: 'delegation_identity_1234567890',
      replyCapability: 'reply_capability_1234567890_ABCDEFG',
      result: 'Completed with exact evidence.',
    };

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY](valid)).resolves.toEqual({
      status: 'ok',
      accepted: true,
      delivered: true,
    });
    expect(delegationReply).toHaveBeenCalledWith({
      version: 'agent_delegation_reply_v1',
      ...valid,
    });

    const forged = await handlers[MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY]({
      ...valid,
      replyTo: 'deck_other_brain',
    });
    expect(forged).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(delegationReply).toHaveBeenCalledTimes(1);
  });

  it('defers peer-audit PASS evidence policy until the sender-bound ingress', async () => {
    const peerAuditReply = vi.fn(async () => ({ ok: false, error: 'invalid_capability' }));
    const handlers = createMemoryMcpToolHandlers(caller(), { peerAuditReply });
    const structureOnlyPass = {
      attemptId: 'attempt_12345678',
      replyCapability: 'A'.repeat(32),
      verdict: 'PASS',
      findings: 'No executable evidence was supplied.',
      validations: [],
    };

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY](structureOnlyPass)).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
    });
    expect(peerAuditReply).toHaveBeenCalledWith(expect.objectContaining({
      version: 'peer_audit_reply_v1',
      verdict: 'PASS',
      validations: [],
    }));
  });

  it('strips forged memory authority fields before search and write helpers', async () => {
    const searchMemory = vi.fn(async () => ({
      items: [],
    }));
    const listMemorySummaries = vi.fn(async () => ({
      items: [],
    }));
    const saveObservation = vi.fn(async () => ({ status: 'ok', observationId: 'obs-1', fingerprint: 'fp', state: 'candidate' }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      listMemorySummaries,
      saveObservation,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({
      query: 'hello',
      limit: 3,
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      embedding: [1, 2, 3],
      vector: [4, 5, 6],
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({
      limit: 2,
      projectionClass: 'recent_summary',
      projectOnly: false,
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      projectId: 'evil-project',
      query: 'must not be forwarded',
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]({
      content: 'remember this',
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      fingerprint: 'forged',
      state: 'active',
      sourceSessionName: 'deck_sub_forged',
      sourceProjectName: 'other',
      sourceServerId: 'srv-forged',
    });

    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'hello',
      limit: 3,
      namespace: expect.objectContaining({ userId: 'user-1' }),
      includeLegacyPersonalOwner: true,
    }));
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('userId', 'mallory');
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('embedding');
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('vector');
    expect(listMemorySummaries).toHaveBeenCalledWith(expect.objectContaining({
      limit: 2,
      projectionClass: 'recent_summary',
      namespace: expect.objectContaining({ userId: 'user-1' }),
      userId: 'user-1',
    }));
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('query');
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('projectOnly');
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('projectId', 'evil-project');
    expect(saveObservation).toHaveBeenCalledWith({ content: 'remember this' }, expect.objectContaining({
      userId: 'user-1',
      sourceSessionName: 'deck_proj_brain',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    }));
  });

  it('strips forged authority fields before MCP memory management actions', async () => {
    const getProcessedProjectionById = vi.fn((id: string) => projection({ id }));
    const archiveMemory = vi.fn(() => true);
    const restoreArchivedMemory = vi.fn(() => true);
    const deleteMemory = vi.fn(() => true);
    const updateProcessedProjectionSummary = vi.fn((input: { projectionId: string; summary: string }) => projection({ id: input.projectionId, summary: input.summary }));
    const recordMemoryHits = vi.fn();
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getProcessedProjectionById,
      archiveMemory,
      restoreArchivedMemory,
      deleteMemory,
      updateProcessedProjectionSummary,
      recordMemoryHits,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]({
      projectionId: 'proj-1',
      userId: 'mallory',
      namespace: { scope: 'personal', userId: 'mallory', projectId: 'evil' },
      projectId: 'evil',
    })).resolves.toMatchObject({ status: 'ok', projectionId: 'proj-1', changed: true });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]({ projectionId: 'proj-1', canonicalRepoId: 'evil' })).resolves.toMatchObject({ status: 'ok', changed: true });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]({
      projectionId: 'proj-1',
      text: 'corrected memory',
      ownerUserId: 'mallory',
      updatedByUserId: 'mallory',
    })).resolves.toMatchObject({ status: 'ok', changed: true });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]({
      projectionId: 'proj-1',
      feedback: 'relevant',
      projectRoot: '/evil',
    })).resolves.toMatchObject({ status: 'ok', action: 'hit_recorded', changed: true });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]({ projectionId: 'proj-1', scope: 'org_shared' })).resolves.toMatchObject({ status: 'ok', changed: true });

    expect(getProcessedProjectionById).toHaveBeenCalledWith('proj-1');
    expect(archiveMemory).toHaveBeenCalledWith('proj-1');
    expect(restoreArchivedMemory).toHaveBeenCalledWith('proj-1');
    expect(deleteMemory).toHaveBeenCalledWith('proj-1');
    expect(recordMemoryHits).toHaveBeenCalledWith(['proj-1']);
    expect(updateProcessedProjectionSummary).toHaveBeenCalledWith({
      projectionId: 'proj-1',
      summary: 'corrected memory',
      ownerUserId: 'user-1',
      updatedByUserId: 'user-1',
    });
  });

  it('blocks MCP memory management for projections outside the caller namespace', async () => {
    const archiveMemory = vi.fn(() => true);
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getProcessedProjectionById: vi.fn(() => projection({
        namespace: { scope: 'personal', userId: 'other-user', projectId: 'repo-1' },
      })),
      archiveMemory,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]({ projectionId: 'proj-foreign' })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE,
    });
    expect(archiveMemory).not.toHaveBeenCalled();
  });

  it('supports compact projection refs and not_relevant feedback archives memory', async () => {
    const namespace: ContextNamespace = { scope: 'personal', userId: 'user-1', projectId: 'repo-1' };
    const ref = registerMemoryShortRef({ kind: 'projection', id: 'proj-ref', namespace });
    const archiveMemory = vi.fn(() => true);
    const handlers = createMemoryMcpToolHandlers(caller({ namespace }), {
      getProcessedProjectionById: vi.fn(() => projection({ id: 'proj-ref', namespace })),
      archiveMemory,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]({ ref, feedback: 'not_relevant' })).resolves.toMatchObject({
      status: 'ok',
      projectionId: 'proj-ref',
      feedback: 'not_relevant',
      action: 'archived',
      changed: true,
    });
    expect(archiveMemory).toHaveBeenCalledWith('proj-ref');
  });

  it('rejects a kind that disagrees with an ambiguous ref instead of expanding it', async () => {
    // The single-candidate path validates the requested kind; the ambiguous
    // path returned candidates regardless, silently dropping the caller's
    // constraint. Resolver-level tests could not see this — it needs the handler.
    const namespace: ContextNamespace = { scope: 'personal', userId: 'user-1', projectId: 'repo-1' };
    const ref = registerMemoryShortRef({ kind: 'projection', id: 'collide-a', namespace });
    registerMemoryShortRef({ kind: 'projection', id: 'collide-b', namespace });
    // Force both onto one handle so the ambiguous branch is exercised.
    seedMemoryShortRefCollisionForTests(ref, [
      { kind: 'projection', id: 'collide-a', namespace },
      { kind: 'projection', id: 'collide-b', namespace },
    ]);
    const getProcessedProjectionById = vi.fn(() => projection({ id: 'collide-a', namespace }));
    const handlers = createMemoryMcpToolHandlers(caller({ namespace }), {
      getProcessedProjectionById,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ ref, kind: 'observation' })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
  });

  it('declares how many records an ambiguous ref covers when expansion is bounded', async () => {
    // Expansion is capped, so a caller told it received "every match" would stop
    // looking while the answer sat in an omitted record.
    //
    // The orchestrator MUST be injected: without it the handler falls through to
    // the real one, which builds an actual SQLite store (plus WAL and a log) in
    // the runner's home directory.
    const namespace: ContextNamespace = { scope: 'personal', userId: 'user-1', projectId: 'repo-1' };
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const ref = registerMemoryShortRef({ kind: 'projection', id: ids[0]!, namespace });
    seedMemoryShortRefCollisionForTests(ref, ids.map((id) => ({ kind: 'projection' as const, id, namespace })));
    const getMemorySourcesOrchestrator = vi.fn(async (projectionId: string) => ({
      status: 'ok' as const,
      projectionId,
      sourceEventCount: 1,
      sources: [{ eventId: `evt-${projectionId}`, status: 'ok', content: `body ${projectionId}` }],
    }));
    const handlers = createMemoryMcpToolHandlers(caller({ namespace }), {
      getMemorySourcesOrchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ ref }) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'ok', ambiguousRef: true, candidateCount: 5, truncated: true });
    const candidates = result.candidates as Array<Record<string, unknown>>;
    // Exactly the cap, carrying real expanded content — `length < 5` alone would
    // also pass on an empty array.
    expect(candidates).toHaveLength(4);
    expect(candidates.map((candidate) => candidate.projectionId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(candidates[0]).toMatchObject({ kind: 'projection', sources: [expect.objectContaining({ content: 'body c1' })] });
  });

  it('marks an ambiguous ref untruncated when every candidate fits', async () => {
    const namespace: ContextNamespace = { scope: 'personal', userId: 'user-1', projectId: 'repo-1' };
    const ref = registerMemoryShortRef({ kind: 'projection', id: 'pair-a', namespace });
    seedMemoryShortRefCollisionForTests(ref, [
      { kind: 'projection', id: 'pair-a', namespace },
      { kind: 'projection', id: 'pair-b', namespace },
    ]);
    const handlers = createMemoryMcpToolHandlers(caller({ namespace }), {
      getMemorySourcesOrchestrator: vi.fn(async (projectionId: string) => ({
        status: 'ok' as const, projectionId, sourceEventCount: 0, sources: [],
      })),
      isMemoryFeatureEnabled: () => true,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ ref }) as Record<string, unknown>;
    expect(result).toMatchObject({ ambiguousRef: true, candidateCount: 2, truncated: false });
    expect((result.candidates as unknown[])).toHaveLength(2);
  });

  it('short-circuits memory disabled gates before backend calls', async () => {
    const searchMemory = vi.fn();
    const savePreference = vi.fn(async () => ({ status: 'ok' }));
    const enabled = (flag: MemoryFeatureFlag) => flag !== MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch && flag !== MEMORY_FEATURE_FLAGS_BY_NAME.preferences;
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      savePreference,
      isMemoryFeatureEnabled: enabled,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'test' })).resolves.toMatchObject({
      status: 'disabled',
      disabledFlag: MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH,
    });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]({ text: 'prefer this' })).toMatchObject({
      status: 'disabled',
      disabledFlag: MEMORY_MCP_DISABLED_FLAGS.PREFERENCES,
    });
    expect(searchMemory).not.toHaveBeenCalled();
    expect(savePreference).not.toHaveBeenCalled();
  });

  it('surfaces the first local degraded reason instead of hardcoding context-store unavailable', async () => {
    const searchMemory = vi.fn(async () => ({
      items: [],
      localUnavailable: true,
      degradedReasons: [MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'semantic recall' })).resolves.toMatchObject({
      status: 'ok',
      reason: MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE,
      degradedReasons: [MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE],
      items: [],
    });
  });

  it('recovers the project namespace from the stored session before searching memory', async () => {
    const searchMemory = vi.fn(async () => ({ items: [] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: 'deck_proj_brain',
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: {
        listSessions: () => [sessionRecord({
          contextNamespace: { scope: 'personal', userId: 'user-1', projectId: 'github.com/im4codes/imcodes' },
          contextNamespaceDiagnostics: ['namespace:git-origin'],
        })],
      },
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 });

    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'github.com/im4codes/imcodes',
      namespace: expect.objectContaining({
        scope: 'personal',
        userId: 'user-1',
        projectId: 'github.com/im4codes/imcodes',
      }),
    }));
  });

  it('derives a local project id from the project path when no namespace project id is available', async () => {
    const searchMemory = vi.fn(async () => ({ items: [] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: 'deck_proj_brain',
      projectRoot: null,
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: {
        listSessions: () => [sessionRecord({
          projectDir: '/workspace/example-project',
          contextNamespace: undefined,
        })],
      },
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 });

    const forwarded = searchMemory.mock.calls[0]?.[0];
    expect(forwarded?.repo).toMatch(/^local\/[0-9a-f]{12}$/);
    expect(forwarded?.namespace).toMatchObject({
      scope: 'personal',
      userId: 'user-1',
      projectId: forwarded?.repo,
    });
  });

  it('does not invoke memory search when runtime scope has no project id', async () => {
    const searchMemory = vi.fn(async () => ({ items: [{ projectionId: 'p1', projectId: 'other', summary: 'hidden' }] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      items: [],
    });
    expect(searchMemory).not.toHaveBeenCalled();
  });

  it('does not invoke memory summary listing when runtime scope has no project id', async () => {
    const listMemorySummaries = vi.fn(async () => ({ items: [{ projectionId: 'p1', projectId: 'other', summary: 'hidden' }] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      listMemorySummaries,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({ limit: 5 })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      items: [],
    });
    expect(listMemorySummaries).not.toHaveBeenCalled();
  });

  it('returns compact hits from the same recall search used by message memory recall', async () => {
    const projectionId = '1111111111222222222233333333334444444444555555555566666666667777';
    const searchMemory = vi.fn(async () => ({
      items: [
        {
          projectionId,
          recordKind: 'projection',
          projectId: 'repo-1',
          scope: 'user_private',
          projectionClass: 'recent_summary',
          matchKind: 'exact',
          summary: 'MCP provider readiness fixed for Gemini, Copilot, and Qwen.',
          createdAt: 100,
          updatedAt: 200,
          relevanceScore: 0.9,
          source: 'cloud',
        },
      ],
    }));
    const orchestrator = vi.fn(async (id: string) => ({
      status: 'ok' as const,
      projectionId: id,
      sourceEventCount: 1,
      sources: [{ eventId: 'evt-1', status: 'archived', content: 'expanded source' }],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'provider readiness', limit: 5 })).resolves.toMatchObject({
      status: 'ok',
      items: [
        {
          projectionId,
          ref: makeMemoryShortRef('projection', projectionId),
          recordKind: 'projection',
          sourceLookup: { tool: 'get_memory_sources', kind: 'projection', projectionId },
          summary: 'MCP provider readiness fixed for Gemini, Copilot, and Qwen.',
          projectionClass: 'recent_summary',
          matchKind: 'exact',
          projectId: 'repo-1',
          scope: 'user_private',
          createdAt: 100,
          updatedAt: 200,
          relevanceScore: 0.9,
          source: 'cloud',
        },
      ],
    });
    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'provider readiness',
      namespace: expect.objectContaining({ scope: 'personal', userId: 'user-1', projectId: 'repo-1' }),
      repo: 'repo-1',
      limit: 5,
    }));
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      ref: makeMemoryShortRef('projection', projectionId),
      kind: 'projection',
    })).resolves.toMatchObject({
      status: 'ok',
      projectionId,
      sourceEventCount: 1,
    });
    expect(orchestrator).toHaveBeenCalledWith(projectionId, expect.any(Object));
  });

  it('returns observation sourceLookup objects and expands them without the projection orchestrator', async () => {
    const observationId = 'aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeeffffffff00000000';
    const searchMemory = vi.fn(async () => ({
      items: [
        {
          recordKind: 'observation' as const,
          projectionId: observationId,
          observationId,
          projectId: 'repo-1',
          scope: 'user_private',
          observationClass: 'note',
          observationState: 'candidate',
          matchKind: 'exact' as const,
          summary: 'Saved observation about alpha.test.im.codes.',
          createdAt: 100,
          updatedAt: 200,
          source: 'local' as const,
        },
      ],
    }));
    const orchestrator = vi.fn();
    const handlers = createMemoryMcpToolHandlers(caller({
      userId: 'daemon-local',
      namespace: { scope: 'user_private', userId: 'daemon-local', projectId: 'repo-1' },
    }), {
      searchMemory,
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'alpha.test.im.codes' })).resolves.toMatchObject({
      status: 'ok',
      items: [
        {
          observationId,
          ref: makeMemoryShortRef('observation', observationId),
          recordKind: 'observation',
          sourceLookup: { tool: 'get_memory_sources', kind: 'observation', observationId },
          observationClass: 'note',
          observationState: 'candidate',
          matchKind: 'exact',
        },
      ],
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      observationId,
      kind: 'observation',
      serverId: 'attacker-srv',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      ref: makeMemoryShortRef('observation', observationId),
      kind: 'observation',
    })).resolves.toMatchObject({
      status: 'ok',
      observationId,
      sourceEventCount: 0,
      sources: [],
    });
    expect(orchestrator).not.toHaveBeenCalled();
  });

  it('does not treat local send and cron MCP feature flags as auth gates', async () => {
    const listSessions = vi.fn(() => []);
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      featureFlags: {
        [MCP_FEATURE_FLAGS_BY_NAME.sendDispatch]: false,
        [MCP_FEATURE_FLAGS_BY_NAME.cronRead]: false,
      },
      sendDeps: { listSessions },
      cronList,
      isMemoryFeatureEnabled: () => true,
    });

    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).toMatchObject({
      status: 'ok',
      items: [],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'ok',
      limit: 10,
    });
    expect(listSessions).toHaveBeenCalled();
    expect(cronList).toHaveBeenCalled();
  });

  it('keeps self out of send_list_targets while returning only the bound caller from session_runtime_identity_get', async () => {
    const self = sessionRecord({
      sessionInstanceId: 'self-instance', runtimeEpoch: 'self-epoch', activeModel: 'gpt-5.6', requestedModel: 'gpt-5.6', runtimeType: 'transport', providerId: 'codex',
    });
    const peer = sessionRecord({ name: 'deck_proj_w1', role: 'w1', sessionInstanceId: 'peer-instance', runtimeEpoch: 'peer-epoch', activeModel: 'opus[1M]', agentType: 'claude-code-sdk', runtimeType: 'transport', providerId: 'claude', userCreated: true });
    const handlers = createMemoryMcpToolHandlers(caller(), { sendDeps: { listSessions: () => [self, peer] } });
    const targets = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({});
    expect(targets).toMatchObject({ status: 'ok', items: [expect.objectContaining({ target: 'deck_proj_w1' })] });
    expect((targets as { items: Array<{ target: string }> }).items.some((item) => item.target === 'deck_proj_brain')).toBe(false);
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET]({})).resolves.toMatchObject({
      status: 'ok',
      identity: {
        sessionName: 'deck_proj_brain', sessionInstanceId: 'self-instance', runtimeEpoch: 'self-epoch',
        agentType: 'codex-sdk', runtimeType: 'transport', providerFamily: 'openai',
        normalizedModelId: 'gpt-5.6', effectiveModelId: 'gpt-5.6', modelMetadataState: 'known',
        modelMetadataSource: 'active_model', modelMetadataConfidence: 'daemon_observed',
      },
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET]({ sessionName: 'deck_proj_w1', model: 'opus' })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
  });

  it('threads the optional executionPool contract through MCP ingress without changing default discovery', async () => {
    const codexConfig = {
      agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6',
    };
    const qwenConfig = {
      agentType: 'qwen', providerFamily: 'alibaba', runtimeType: 'transport' as const, model: 'qwen3-coder-plus',
    };
    const self = sessionRecord({
      sessionInstanceId: 'self-instance', runtimeEpoch: 'self-epoch', activeModel: 'gpt-5.6', runtimeType: 'transport',
      transportConfig: {
        supervision: {
          mode: 'off',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: { configs: [{ ...codexConfig, capabilityId: buildSupervisionExecutionCapabilityId(codexConfig) }] },
            economyTaskPool: { configs: [{ ...qwenConfig, capabilityId: buildSupervisionExecutionCapabilityId(qwenConfig) }] },
          },
        },
      },
    });
    const primary = sessionRecord({
      name: 'deck_proj_codex', role: 'w1', parentSession: self.name, userCreated: true,
      sessionInstanceId: 'codex-instance', runtimeEpoch: 'codex-epoch',
      agentType: codexConfig.agentType, activeModel: codexConfig.model, runtimeType: 'transport',
    });
    const economy = sessionRecord({
      name: 'deck_proj_qwen', role: 'w2', parentSession: self.name, userCreated: true,
      sessionInstanceId: 'qwen-instance', runtimeEpoch: 'qwen-epoch',
      agentType: qwenConfig.agentType, activeModel: qwenConfig.model, runtimeType: 'transport',
    });
    const outside = sessionRecord({
      name: 'deck_proj_cc', role: 'w3', parentSession: self.name, userCreated: true,
      sessionInstanceId: 'cc-instance', runtimeEpoch: 'cc-epoch',
      agentType: 'claude-code-sdk', activeModel: 'opus[1M]', runtimeType: 'transport',
    });
    const handlers = createMemoryMcpToolHandlers(caller(), {
      sendDeps: { listSessions: () => [self, primary, economy, outside] },
    });

    const contract = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS];
    expect(contract.inputSchema.properties?.executionPool).toMatchObject({ enum: ['primary', 'economy'] });
    expect(contract.outputSchema.properties).toHaveProperty('executionPoolsState');
    expect(contract.outputSchema.properties).toHaveProperty('items');

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).resolves.toMatchObject({
      status: 'ok',
      executionPoolsState: 'configured',
      items: [
        expect.objectContaining({ target: primary.name, eligiblePools: ['primary'] }),
        expect.objectContaining({ target: economy.name, eligiblePools: ['economy'] }),
        expect.objectContaining({ target: outside.name, eligiblePools: [] }),
      ],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ executionPool: 'primary' })).resolves.toMatchObject({
      status: 'ok', appliedExecutionPool: 'primary', items: [expect.objectContaining({ target: primary.name })],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ executionPool: 'economy' })).resolves.toMatchObject({
      status: 'ok', appliedExecutionPool: 'economy', items: [expect.objectContaining({ target: economy.name })],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ executionPool: 'audit' })).resolves.toMatchObject({
      status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
  });

  it('publishes and preserves optional ccPresetId through the real send_message MCP ingress', async () => {
    const presetConfig = {
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      runtimeType: 'transport' as const,
      model: 'opus[1M]',
      ccPresetId: 'preset-a',
    };
    const requestedExecutionType = {
      ...presetConfig,
      capabilityId: buildSupervisionExecutionCapabilityId(presetConfig),
    };
    const legacyConfig = {
      agentType: 'codex-sdk',
      providerFamily: 'openai',
      runtimeType: 'transport' as const,
      model: 'gpt-5.6',
    };
    const legacyRequestedExecutionType = {
      ...legacyConfig,
      capabilityId: buildSupervisionExecutionCapabilityId(legacyConfig),
    };
    const self = sessionRecord({
      sessionInstanceId: 'self-instance', runtimeEpoch: 'self-epoch', activeModel: 'gpt-5.6', runtimeType: 'transport',
      transportConfig: {
        supervision: {
          mode: 'off',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: { configs: [requestedExecutionType, legacyRequestedExecutionType] },
            economyTaskPool: { configs: [] },
          },
        },
      },
    });
    const presetPeer = sessionRecord({
      name: 'deck_proj_cc_preset', role: 'w1', parentSession: self.name, userCreated: true,
      sessionInstanceId: 'preset-instance', runtimeEpoch: 'preset-epoch',
      agentType: presetConfig.agentType, providerId: 'anthropic', activeModel: presetConfig.model,
      runtimeType: presetConfig.runtimeType, ccPreset: presetConfig.ccPresetId,
    });
    const legacyPeer = sessionRecord({
      name: 'deck_proj_codex_legacy', role: 'w2', parentSession: self.name, userCreated: true,
      sessionInstanceId: 'legacy-instance', runtimeEpoch: 'legacy-epoch',
      agentType: legacyConfig.agentType, providerId: 'openai', activeModel: legacyConfig.model,
      runtimeType: legacyConfig.runtimeType,
    });
    const dispatchMessage = vi.fn(async () => undefined);
    const server = createMemoryMcpServer(caller(), {
      sendDeps: { listSessions: () => [self, presetPeer, legacyPeer], dispatchMessage },
    });
    const client = new Client({ name: 'cc-preset-ingress-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const contractTask = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]
        .inputSchema.properties?.task as { properties?: Record<string, unknown> };
      const contractRequested = contractTask.properties?.requestedExecutionType as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(contractRequested.properties?.ccPresetId).toMatchObject({ type: 'string', minLength: 1 });
      expect(contractRequested.required).not.toContain('ccPresetId');

      const advertised = (await client.listTools()).tools
        .find((tool) => tool.name === MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE);
      const advertisedTask = advertised?.inputSchema.properties?.task as {
        properties?: Record<string, unknown>;
      };
      const advertisedRequested = advertisedTask.properties?.requestedExecutionType as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(advertisedRequested.properties?.ccPresetId).toMatchObject({ minLength: 1 });
      expect(advertisedRequested.required).not.toContain('ccPresetId');

      const exact = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
        arguments: {
          target: presetPeer.name,
          message: 'preset-bound task',
          task: {
            taskId: 'supervision_task_missing_preset_ingress',
            executionPool: 'primary',
            requestedExecutionType,
          },
        },
      });
      expect(exact.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
        error: 'task is not visible to this caller',
      });

      const legacy = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
        arguments: {
          target: legacyPeer.name,
          message: 'legacy task without preset identity',
          task: {
            taskId: 'supervision_task_missing_legacy_ingress',
            executionPool: 'primary',
            requestedExecutionType: legacyRequestedExecutionType,
          },
        },
      });
      expect(legacy.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
        error: 'task is not visible to this caller',
      });

      const { ccPresetId: _omitted, ...missingPreset } = requestedExecutionType;
      for (const malformed of [missingPreset, { ...requestedExecutionType, ccPresetId: 'preset-b' }]) {
        const rejected = await client.callTool({
          name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
          arguments: {
            target: presetPeer.name,
            message: 'malformed preset identity',
            task: {
              taskId: 'supervision_task_missing_preset_ingress',
              executionPool: 'primary',
              requestedExecutionType: malformed,
            },
          },
        });
        expect(rejected.structuredContent).toMatchObject({
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
        });
      }
      expect(dispatchMessage).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('retains an omitted live target from the authoritative directory but rejects an explicit stopped record', async () => {
    const self = sessionRecord({
      sessionInstanceId: 'self-instance', runtimeEpoch: 'self-epoch', runtimeType: 'transport',
    });
    const peer = sessionRecord({
      name: 'deck_proj_w1', role: 'w1', sessionInstanceId: 'peer-instance', runtimeEpoch: 'peer-epoch',
      agentType: 'claude-code-sdk', runtimeType: 'transport', userCreated: true,
    });
    let snapshot = [self, peer];
    const dispatchMessage = vi.fn(async () => undefined);
    const authoritative = vi.fn(async (candidate: SessionRecord) => candidate.name === peer.name);
    const handlers = createMemoryMcpToolHandlers(caller(), {
      sendDeps: {
        listSessions: () => snapshot,
        dispatchMessage,
        isSessionAuthoritativelyActive: authoritative,
      },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).resolves.toMatchObject({
      status: 'ok', items: [expect.objectContaining({ target: peer.name })],
    });

    // Deterministic snapshot race: the directory refresh omits only the live
    // peer. No timer is advanced; authority answers synchronously from the
    // runtime directory and both list + send retain the same target.
    snapshot = [self];
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).resolves.toMatchObject({
      status: 'ok', items: [expect.objectContaining({ target: peer.name })],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: peer.name, message: 'continue after snapshot race',
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(authoritative).toHaveBeenCalledWith(expect.objectContaining({ name: peer.name }));

    // An explicit stopped record is newer authority, not an omission. It must
    // never be resurrected by the previous-good snapshot.
    snapshot = [self, { ...peer, state: 'stopped' as const }];
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).resolves.toMatchObject({
      status: 'ok', items: [],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: peer.name, message: 'must reject stopped',
    })).resolves.toMatchObject({ status: 'error' });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('does not forward forged cron identity fields to the cron client', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronCreate,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      name: 'daily',
      cronExpr: '0 9 * * *',
      action: { type: 'send', target: 'w1', message: 'go' },
      userId: 'mallory',
      serverId: 'srv-forged',
      token: 'secret',
      actorId: 'actor',
      sourceSessionName: 'deck_sub_forged',
    });

    expect(cronCreate).toHaveBeenCalledWith(expect.not.objectContaining({
      userId: expect.anything(),
      serverId: expect.anything(),
      token: expect.anything(),
      actorId: expect.anything(),
    }), expect.any(Object));
    expect(cronCreate.mock.calls[0][0]).toMatchObject({
      projectName: 'proj',
      sourceSessionName: 'deck_proj_brain',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    });
    expect(cronCreate.mock.calls[0][1]).toMatchObject({ runtimeServerId: 'srv-1' });
  });

  it('creates a self cron for the runtime-bound main session without session arguments', async () => {
    const cronCreateSelf = vi.fn(async () => ({ status: 'ok' as const, body: { id: 'job-self' } }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronCreateSelf,
      sendDeps: { listSessions: () => [sessionRecord()] },
      isMemoryFeatureEnabled: () => true,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]({
      cronExpr: '*/10 * * * *',
      message: 'Check the current work',
      sessionName: 'deck_sub_forged',
      projectName: 'other',
      serverId: 'srv-forged',
    });

    expect(cronCreateSelf).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Check the current work',
      cronExpr: '*/10 * * * *',
      message: 'Check the current work',
      projectName: 'proj',
      targetRole: 'brain',
      targetSessionName: null,
      completionPolicy: CRON_COMPLETION_POLICY.RECURRING,
    }), expect.objectContaining({ runtimeServerId: 'srv-1' }));
    expect(result).toMatchObject({
      status: 'ok',
      preferredCronInterface: true,
      jobId: 'job-self',
      completionPolicy: CRON_COMPLETION_POLICY.RECURRING,
      controls: {
        update: { tool: 'cron_update_self', args: { id: 'job-self' } },
        cancel: { tool: 'cron_cancel_self', args: { id: 'job-self' }, forceRequired: true },
      },
    });
  });

  it('creates a self cron directly for the runtime-bound sub-session', async () => {
    const cronCreateSelf = vi.fn(async () => ({ status: 'ok' as const, body: { id: 'job-sub' } }));
    const handlers = createMemoryMcpToolHandlers(caller({
      sessionName: 'deck_sub_worker',
      projectName: 'deck_sub_worker',
    }), {
      cronCreateSelf,
      sendDeps: {
        listSessions: () => [
          sessionRecord(),
          sessionRecord({
            name: 'deck_sub_worker',
            projectName: 'deck_sub_worker',
            parentSession: 'deck_proj_brain',
            role: 'w1',
          }),
        ],
      },
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]({
      name: 'Sub reminder',
      cronExpr: '0 9 * * *',
      message: 'Continue this task',
    });

    expect(cronCreateSelf).toHaveBeenCalledWith(expect.objectContaining({
      projectName: 'proj',
      targetRole: 'brain',
      targetSessionName: 'deck_sub_worker',
      message: 'Continue this task',
    }), expect.any(Object));
  });

  it('updates only a cron targeting the runtime-bound current session', async () => {
    const cronUpdateSelf = vi.fn(async () => ({ status: 'ok' as const, body: { ok: true } }));
    const cronList = vi.fn(async () => ({
      status: 'ok' as const,
      limit: 100,
      body: {
        jobs: [
          { id: 'self-1', name: 'Progress', project_name: 'proj', target_role: 'brain', target_session_name: null },
          { id: 'worker-1', name: 'Worker progress', project_name: 'proj', target_role: 'w1', target_session_name: null },
        ],
      },
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      cronUpdateSelf,
      sendDeps: { listSessions: () => [sessionRecord()] },
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]({
      id: 'self-1',
      cronExpr: '*/20 * * * *',
      message: 'Check whether the work is complete',
      sessionName: 'deck_proj_w1',
      serverId: 'srv-forged',
    });

    expect(cronUpdateSelf).toHaveBeenCalledWith({
      id: 'self-1',
      projectName: 'proj',
      name: undefined,
      cronExpr: '*/20 * * * *',
      message: 'Check whether the work is complete',
      timezone: undefined,
      expiresAt: undefined,
      completionPolicy: undefined,
      force: false,
    }, expect.objectContaining({ runtimeServerId: 'srv-1' }));

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]({
      id: 'worker-1',
      name: 'Do not change',
    })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    expect(cronUpdateSelf).toHaveBeenCalledTimes(1);
  });

  it('cancels only a uniquely named cron targeting the current session', async () => {
    const cronDelete = vi.fn(async () => ({ status: 'ok' as const, body: { ok: true } }));
    const cronList = vi.fn(async () => ({
      status: 'ok' as const,
      limit: 100,
      body: {
        jobs: [
          {
            id: 'self-1',
            name: 'Daily check',
            project_name: 'proj',
            target_role: 'brain',
            target_session_name: null,
            completion_policy: CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
          },
          { id: 'worker-1', name: 'Daily check', project_name: 'proj', target_role: 'w1', target_session_name: null },
          { id: 'other-project', name: 'Daily check', project_name: 'other', target_role: 'brain', target_session_name: null },
        ],
      },
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      cronDelete,
      sendDeps: { listSessions: () => [sessionRecord()] },
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]({ name: 'Daily check' })).resolves.toEqual({
      status: 'ok',
      count: 1,
      deleted: [{ id: 'self-1', name: 'Daily check' }],
    });
    expect(cronDelete).toHaveBeenCalledOnce();
    expect(cronDelete).toHaveBeenCalledWith('self-1', expect.objectContaining({ runtimeServerId: 'srv-1' }), false);
  });

  it('requires force for recurring self cron cancellation and forwards the explicit latch', async () => {
    const cronDelete = vi.fn(async () => ({ status: 'ok' as const, body: { ok: true } }));
    const cronList = vi.fn(async () => ({
      status: 'ok' as const,
      limit: 100,
      body: {
        jobs: [
          {
            id: 'recurring-1',
            name: 'Daily report',
            project_name: 'proj',
            target_role: 'brain',
            target_session_name: null,
            completion_policy: CRON_COMPLETION_POLICY.RECURRING,
          },
        ],
      },
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      cronDelete,
      sendDeps: { listSessions: () => [sessionRecord()] },
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]({
      id: 'recurring-1',
    })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      protected: [{ id: 'recurring-1', name: 'Daily report' }],
    });
    expect(cronDelete).not.toHaveBeenCalled();

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]({
      id: 'recurring-1',
      force: true,
    })).resolves.toMatchObject({
      status: 'ok',
      count: 1,
    });
    expect(cronDelete).toHaveBeenCalledWith(
      'recurring-1',
      expect.objectContaining({ runtimeServerId: 'srv-1' }),
      true,
    );
  });

  it('forwards force through generic cron_delete so the server remains authoritative', async () => {
    const cronDelete = vi.fn(async () => ({ status: 'ok' as const, body: { ok: true } }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronDelete,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_DELETE]({ id: 'recurring-1', force: true });

    expect(cronDelete).toHaveBeenCalledWith(
      'recurring-1',
      expect.objectContaining({ runtimeServerId: 'srv-1' }),
      true,
    );
  });

  it('requires an explicit unambiguous self-cron cancellation selector', async () => {
    const cronList = vi.fn(async () => ({
      status: 'ok' as const,
      limit: 100,
      body: {
        jobs: [
          { id: 'self-1', name: 'Duplicate', project_name: 'proj', target_role: 'brain', target_session_name: null },
          { id: 'self-2', name: 'Duplicate', project_name: 'proj', target_role: 'brain', target_session_name: null },
        ],
      },
    }));
    const cronDelete = vi.fn(async () => ({ status: 'ok' as const, body: { ok: true } }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      cronDelete,
      sendDeps: { listSessions: () => [sessionRecord()] },
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]({})).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]({ name: 'Duplicate' })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      matches: [{ id: 'self-1' }, { id: 'self-2' }],
    });
    expect(cronDelete).not.toHaveBeenCalled();
  });

  it('resolves cron project scope from the caller session store for sub-sessions', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const handlers = createMemoryMcpToolHandlers(caller({
      sessionName: 'deck_sub_worker',
      projectName: 'deck_sub_worker',
      projectRoot: '/work/alpha',
    }), {
      cronCreate,
      sendDeps: {
        listSessions: () => [
          {
            name: 'deck_alpha_brain',
            projectName: 'alpha',
            projectDir: '/work/alpha',
            role: 'brain',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
          {
            name: 'deck_sub_worker',
            projectName: 'deck_sub_worker',
            projectDir: '/work/alpha',
            parentSession: 'deck_alpha_brain',
            role: 'w1',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
        ],
      },
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      name: 'daily',
      cronExpr: '0 9 * * *',
      action: { type: 'send', target: 'deck_alpha_w1', message: 'go' },
    });

    expect(cronCreate.mock.calls[0][0]).toMatchObject({
      projectName: 'alpha',
      sourceSessionName: 'deck_sub_worker',
      sourceProjectName: 'alpha',
    });
  });

  it('wraps unexpected tool exceptions as sanitized structured MCP errors', async () => {
    const handlers = createMemoryMcpToolHandlers(caller(), {
      savePreference: vi.fn(async () => {
        throw new Error('failed with token=secret-token and https://example.test/api/server/srv-1/cron');
      }),
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]({ text: 'prefer this' })).resolves.toMatchObject({
      status: 'error',
      reason: 'internal_error',
      message: 'failed with token=[redacted] and [redacted-url]',
    });
  });

  it('requires MCP send_message to use the exact target field rather than display labels', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const handlers = createMemoryMcpToolHandlers(caller(), {
      sendDeps: {
        listSessions: () => [
          {
            name: 'deck_proj_brain',
            projectName: 'proj',
            projectDir: '/tmp/proj',
            role: 'brain',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
          {
            name: 'deck_proj_w1',
            projectName: 'proj',
            projectDir: '/tmp/proj',
            role: 'w1',
            label: 'Friendly',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
        ],
        dispatchMessage,
      },
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({ target: 'Friendly', message: 'hello' })).resolves.toMatchObject({
      status: 'error',
      reason: 'validation_failed',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({ target: 'deck_proj_w1', message: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('strips forged serverId from get_memory_sources input — orchestrator never sees it', async () => {
    // Regression for memory-source-server-routing: serverId is in the
    // forbidden args list precisely so callers cannot influence routing by
    // forging an identity field. The orchestrator resolves originServerId
    // itself (cache or cloud), never from input. This test injects a
    // forged `serverId: 'attacker-srv'` and asserts the orchestrator was
    // called WITHOUT it (and projectionId was preserved).
    const orchestrator = vi.fn(async (projectionId: string) => ({
      status: 'ok' as const,
      projectionId,
      sourceEventCount: 0,
      sources: [],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      projectionId: 'proj-1',
      serverId: 'attacker-srv',
      // throw the kitchen sink at it
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      sourceServerId: 'attacker-srv-2',
    });

    // The orchestrator wraps two positional args: (projectionId, caller).
    // Both must be free of attacker-controlled routing fields.
    expect(orchestrator).toHaveBeenCalledOnce();
    const [passedProjectionId, passedCaller] = orchestrator.mock.calls[0];
    expect(passedProjectionId).toBe('proj-1');
    expect(passedCaller.userId).toBe('user-1');
    // Caller is built from runtime, not args — verify no smuggled fields.
    expect((passedCaller as unknown as Record<string, unknown>).serverId).not.toBe('attacker-srv');
  });

  it('does not expand memory sources when runtime scope has no project id', async () => {
    const orchestrator = vi.fn(async () => ({
      status: 'ok' as const,
      projectionId: 'proj-1',
      sourceEventCount: 1,
      sources: [{ eventId: 'evt-1', status: 'archived', content: 'hidden source' }],
    }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: 'proj-1' })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      projectionId: 'proj-1',
      sourceEventCount: 0,
      sources: [],
    });
    expect(orchestrator).not.toHaveBeenCalled();
  });

  it('keeps get_memory_sources available when quick search is disabled but the MCP memory surface is enabled', async () => {
    // Production path: get_memory_sources flows through the orchestrator,
    // which resolves originServerId from cache/cloud and then dispatches to
    // the local SQLite or the pod-sticky remote. We bypass that machinery
    // here by injecting a stub orchestrator so the test stays focused on
    // the disabled-flag semantics.
    const orchestrator = vi.fn(async () => ({
      status: 'ok' as const,
      projectionId: 'p1',
      sourceEventCount: 0,
      sources: [],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: (flag) => flag !== MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch,
    });

    expect(await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: 'p1' })).toMatchObject({
      status: 'ok',
      projectionId: 'p1',
      sources: [],
    });
    expect(orchestrator).toHaveBeenCalled();
  });

  it('allows cron calls without runtime server identity but rejects outside the caller project before the cron client', async () => {
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const noServerHandlers = createMemoryMcpToolHandlers(caller({ serverId: null }), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(noServerHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'ok',
      limit: 10,
    });

    const scopedHandlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(scopedHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ projectName: 'other' })).resolves.toMatchObject({
      status: 'error',
      reason: 'scope_forbidden',
    });
    expect(cronList).toHaveBeenCalledTimes(1);
    expect(cronList.mock.calls[0][1]).not.toHaveProperty('runtimeServerId');
  });

  it('does not accept legacy cron schedule wrappers or unused cursor arguments', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronCreate,
      cronList,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      schedule: { name: 'wrapped', cronExpr: '0 9 * * *' },
      action: { type: 'send', target: 'w1', message: 'go' },
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ cursor: 'unused', limit: 5 });

    expect(cronCreate.mock.calls[0][0]).toMatchObject({ name: '', cronExpr: '' });
    expect(cronList.mock.calls[0][0]).toEqual({ projectName: 'proj', limit: 5 });
  });
});
