import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import {
  archiveEventsForMaterialization,
  ensureContextNamespace,
  getContextObservationById,
  getProcessedProjectionById,
  listContextNamespaces,
  recordContextEvent,
  resetContextStoreForTests,
  writeContextObservation,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { AMBIGUOUS_PARTICIPANT_ACTOR } from '../../src/daemon/sender-participant-turn.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('daemon participant memory isolation against owner-private storage', () => {
  let tempDir: string;
  let configDir: string;
  const projectId = 'proj-shared';
  const ownerId = 'owner-user-1';
  const participantId = 'participant-user-1';
  const ownerPersonalNs: ContextNamespace = { scope: 'personal', projectId, userId: ownerId };
  const ownerLegacyNs: ContextNamespace = { scope: 'personal', projectId, userId: LEGACY_DAEMON_LOCAL_USER_ID };
  const ownerPrivateNs: ContextNamespace = { scope: 'user_private', projectId, userId: ownerId };
  const projectSharedNs: ContextNamespace = { scope: 'project_shared', projectId };
  const participantPersonalNs: ContextNamespace = { scope: 'personal', projectId, userId: participantId };

  let ownerPersonalProjId: string;
  let ownerLegacyProjId: string;
  let sharedProjId: string;
  let ownerObsId: string;
  let sharedSession: SessionRecord;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('participant-memory-isolation');
    configDir = join(tmpdir(), `imc-part-mem-cfg-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'server.json');
    process.env.IMCODES_SERVER_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ userId: ownerId }), 'utf8');

    const evt = recordContextEvent({
      id: 'evt-owner-secret-1',
      target: { namespace: ownerPersonalNs, kind: 'session', sessionName: 'deck_proj-shared_brain' },
      eventType: 'user.message',
      content: 'owner-secret raw token alpha-999',
      createdAt: 100,
    });
    archiveEventsForMaterialization([evt], 101);

    const ownerPersonalProj = writeProcessedProjection({
      namespace: ownerPersonalNs,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-owner-secret-1'],
      summary: 'owner-secret personal deployment token',
      content: {},
      now: 110,
    });
    ownerPersonalProjId = ownerPersonalProj.id;

    const ownerLegacyProj = writeProcessedProjection({
      namespace: ownerLegacyNs,
      class: 'recent_summary',
      sourceEventIds: [],
      summary: 'owner-secret legacy daemon-local private summary',
      content: {},
      now: 120,
    });
    ownerLegacyProjId = ownerLegacyProj.id;

    const sharedProj = writeProcessedProjection({
      namespace: projectSharedNs,
      class: 'durable_memory_candidate',
      sourceEventIds: [],
      summary: 'shared project deployment convention',
      content: {},
      now: 130,
    });
    sharedProjId = sharedProj.id;

    const nsRow = ensureContextNamespace(ownerPrivateNs, 100);
    const ownerObs = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'fp-owner-secret-obs',
      content: { text: 'owner-secret personal SSH key password' },
      text: 'owner-secret personal SSH key password',
      sourceEventIds: ['evt-owner-secret-1'],
      state: 'active',
      now: 140,
    });
    ownerObsId = ownerObs.id;

    sharedSession = {
      name: 'deck_proj-shared_brain',
      projectName: projectId,
      role: 'brain',
      agentType: 'claude-code',
      state: 'running',
      projectDir: '/tmp/proj-shared',
      contextNamespace: ownerPersonalNs,
      createdAt: 10,
      updatedAt: 10,
      restarts: 0,
    } as SessionRecord;
  });

  afterEach(async () => {
    delete process.env.IMCODES_SERVER_CONFIG_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
    await rm(configDir, { recursive: true, force: true });
  });

  function makeParticipantHandlers(
    overrides: Partial<McpRuntimeCaller> = {},
    deps: Parameters<typeof createMemoryMcpToolHandlers>[1] = {},
  ) {
    const caller: McpRuntimeCaller = Object.freeze({
      userId: participantId,
      namespace: participantPersonalNs,
      sessionName: sharedSession.name,
      projectName: sharedSession.projectName,
      projectRoot: sharedSession.projectDir,
      serverId: 'srv-shared-1',
      providerId: 'claude-code',
      transport: 'in_process',
      isParticipantTurn: true,
      participantAuthority: null,
      ...overrides,
    });
    return createMemoryMcpToolHandlers(caller, {
      sendDeps: {
        listSessions: () => [sharedSession],
        listTargets: () => [],
      },
      ...deps,
    });
  }

  it('prevents participant from searching, listing, or expanding owner private and legacy-local memory, even when session record holds owner namespace', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ results: [], records: [] }), { status: 200 }));
    const handlers = makeParticipantHandlers(
      { participantAuthority: null },
      {
        memorySearchOptions: {
          credentials: { workerUrl: 'http://127.0.0.1:9999', serverId: 'srv-shared-1', token: 'tok' },
          fetchImpl: fetchSpy as unknown as typeof fetch,
        },
      },
    );

    const searchRes = await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'owner-secret' }) as {
      status: string;
      items: Array<{ summary: string }>;
    };
    expect(searchRes.status).toBe('ok');
    expect(searchRes.items).toEqual([]);
    // Must never issue unauthenticated owner cloud fallback calls when participantAuthority is absent.
    expect(fetchSpy).not.toHaveBeenCalled();

    const listRecent = await handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({ projectionClass: 'recent_summary' }) as {
      status: string;
      items: Array<{ summary: string }>;
    };
    expect(listRecent.status).toBe('ok');
    expect(listRecent.items).toEqual([]);

    const listDurable = await handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({ projectionClass: 'durable_memory_candidate' }) as {
      status: string;
      items: Array<{ summary: string }>;
    };
    expect(listDurable.status).toBe('ok');
    expect(listDurable.items).toEqual([]);

    // Owner raw sources must remain unreachable even with explicit ids.
    const projSources = await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: ownerPersonalProjId });
    expect(projSources).toMatchObject({ status: 'error' });

    const obsSources = await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ observationId: ownerObsId });
    expect(obsSources).toMatchObject({ status: 'error' });
  });

  it('attaches participant authority JWT to cloud memory searches when present while isolating owner-private hits', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: sharedProjId, projectId, class: 'durable_memory_candidate', summary: 'shared project deployment convention', updatedAt: 200, score: 0.9, source: 'enterprise' }],
      records: [],
    }), { status: 200 }));

    const handlers = makeParticipantHandlers(
      {
        namespace: projectSharedNs,
        participantAuthority: 'sma.jwt.participant.abc',
      },
      {
        memorySearchOptions: {
          credentials: { workerUrl: 'http://127.0.0.1:9999', serverId: 'srv-shared-1', token: 'tok' },
          fetchImpl: fetchSpy as unknown as typeof fetch,
        },
      },
    );

    const searchRes = await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'convention' }) as {
      status: string;
      items: Array<{ summary: string }>;
    };
    expect(searchRes.status).toBe('ok');
    expect(searchRes.items.some((item) => item.summary.includes('shared project deployment convention'))).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const firstHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(firstHeaders[SHARED_MACHINE_AUTHORITY_HEADER]).toBe('sma.jwt.participant.abc');
  });

  it('prevents participant from mutating or replacing owner projections/observations while allowing participant own observations and session tools', async () => {
    const handlers = makeParticipantHandlers();

    for (const [tool, input] of [
      [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY, { projectionId: ownerPersonalProjId }],
      [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY, { projectionId: ownerLegacyProjId }],
      [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY, { projectionId: ownerPersonalProjId }],
      [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY, { projectionId: ownerPersonalProjId }],
      [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY, { projectionId: ownerLegacyProjId }],
      [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY, { observationId: ownerObsId }],
      [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY, { projectionId: ownerPersonalProjId, text: 'tampered' }],
      [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY, { observationId: ownerObsId, text: 'tampered' }],
      [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK, { projectionId: ownerPersonalProjId, feedback: 'not_relevant' }],
    ] as const) {
      const res = await handlers[tool](input);
      expect(res, `${tool} rejects owner record`).toMatchObject({ status: 'error' });
    }

    // Attempted replacesRef targeting owner observation/projection must leave owner records untouched
    // and never leak or write under owner namespace.
    const replaceOwnerObs = await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]({
      content: 'participant replacement',
      replacesRef: `obs:${ownerObsId}`,
    }) as { status: string; observationId?: string };
    expect((getContextObservationById(ownerObsId)?.content as { text?: string } | undefined)?.text).toBe('owner-secret personal SSH key password');
    expect(getProcessedProjectionById(ownerPersonalProjId)?.summary).toBe('owner-secret personal deployment token');
    if (replaceOwnerObs.status === 'ok' && replaceOwnerObs.observationId) {
      const obsRow = getContextObservationById(replaceOwnerObs.observationId);
      const obsNs = listContextNamespaces().find((n) => n.id === obsRow?.namespaceId);
      expect(obsNs?.userId).toBe(participantId);
    }

    // Defense in depth: direct save_preference call is also blocked.
    const prefRes = await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]({ text: 'always speak terse' });
    expect(prefRes).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    // Participant CAN save, search, update, and delete their OWN observation under participant namespace.
    const saveOwn = await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]({
      content: 'participant-note build script runs via pnpm',
    }) as { status: string; observationId: string };
    expect(saveOwn.status).toBe('ok');
    expect(saveOwn.observationId).toBeTruthy();

    const savedObs = getContextObservationById(saveOwn.observationId);
    const savedNs = listContextNamespaces().find((n) => n.id === savedObs?.namespaceId);
    expect(savedNs?.userId).toBe(participantId);

    const searchOwn = await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'participant-note' }) as {
      status: string;
      items: Array<{ summary: string }>;
    };
    expect(searchOwn.status).toBe('ok');
    expect(searchOwn.items.map((i) => i.summary)).toContain('participant-note build script runs via pnpm');

    const updateOwn = await handlers[MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]({
      observationId: saveOwn.observationId,
      text: 'participant-note edited text',
    });
    expect(updateOwn).toMatchObject({ status: 'ok', changed: true });

    const deleteOwn = await handlers[MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]({
      observationId: saveOwn.observationId,
    });
    expect(deleteOwn).toMatchObject({ status: 'ok', changed: true });

    // Ambiguous participant turns fail closed on observation writes too.
    const ambigHandlers = makeParticipantHandlers({ userId: AMBIGUOUS_PARTICIPANT_ACTOR });
    const ambigSave = await ambigHandlers[MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]({ content: 'ambig' });
    expect(ambigSave).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    // Session/project operational controls remain allowed for the participant turn.
    const injGet = await handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_INJECTION_GET]({});
    expect(injGet).toMatchObject({ status: 'ok' });
  });
});
