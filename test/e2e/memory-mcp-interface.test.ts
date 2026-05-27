import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  MEMORY_MCP_CAPS,
  MEMORY_MCP_TOOL_NAME_LIST,
  MEMORY_MCP_TOOL_NAMES,
} from '../../shared/memory-mcp-contracts.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, memoryFeatureFlagEnvKey } from '../../shared/feature-flags.js';
import { MEMORY_MCP_ENV_KEYS, buildMemoryMcpServerEnv } from '../../shared/memory-mcp-env.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  archiveEventsForMaterialization,
  listContextObservations,
  recordContextEvent,
  resetContextStoreForTests,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const USER_ID = 'memory-mcp-e2e-user';
const PROJECT_NAME = 'e2e-memory-mcp';
const SERVER_ID = 'srv-memory-mcp-e2e';
const SESSION_NAME = 'deck_sub_e2e_memory_mcp';
const namespace = { scope: 'user_private' as const, userId: USER_ID, projectId: PROJECT_NAME };

function structured(result: unknown): Record<string, unknown> {
  const record = result as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  if (record.structuredContent) return record.structuredContent;
  const text = record.content?.find((entry) => typeof entry.text === 'string')?.text;
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function withStdioClient(
  env: Record<string, string>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: 'memory-mcp-interface-e2e', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close();
  }
}

describe('memory MCP interface e2e', () => {
  let tempDbDir: string;
  let projectRoot: string;
  let serverConfigDir: string;
  let serverConfigPath: string;

  beforeEach(async () => {
    tempDbDir = await createIsolatedSharedContextDb('memory-mcp-interface-e2e');
    projectRoot = await mkdtemp(join(tmpdir(), 'e2e-memory-mcp-project-'));
    serverConfigDir = await mkdtemp(join(tmpdir(), 'e2e-memory-mcp-server-'));
    serverConfigPath = join(serverConfigDir, 'server.json');
    process.env.IMCODES_SERVER_CONFIG_PATH = serverConfigPath;
    await writeFile(serverConfigPath, JSON.stringify({ userId: USER_ID }), 'utf8');
  });

  afterEach(async () => {
    delete process.env.IMCODES_SERVER_CONFIG_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDbDir);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(serverConfigDir, { recursive: true, force: true });
  });

  function childEnv(): Record<string, string> {
    return {
      ...buildMemoryMcpServerEnv({
        [MEMORY_MCP_ENV_KEYS.USER_ID]: USER_ID,
        [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
        [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: SESSION_NAME,
        [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: PROJECT_NAME,
        [MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]: projectRoot,
        [MEMORY_MCP_ENV_KEYS.SERVER_ID]: SERVER_ID,
      }, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        IMCODES_SERVER_TOKEN: 'must-not-leak',
        OPENAI_API_KEY: 'must-not-leak',
      }),
      IMCODES_CONTEXT_DB_PATH: process.env.IMCODES_CONTEXT_DB_PATH!,
      IMCODES_SERVER_CONFIG_PATH: serverConfigPath,
      [memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry)]: 'true',
      [memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.observationStore)]: 'true',
      [memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.preferences)]: 'true',
    };
  }

  it('runs the real stdio server, exposes exactly eleven tools, and persists runtime-derived preference provenance', async () => {
    await withStdioClient(childEnv(), async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MEMORY_MCP_TOOL_NAME_LIST]);

      const saved = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
        arguments: {
          text: 'Prefer compact MCP answers in e2e verification.',
          sourceSessionName: 'deck_sub_forged',
          sourceProjectName: 'evil-project',
          sourceServerId: 'evil-server',
          projectRoot: '/tmp/evil-root',
        },
      }));

      expect(saved).toMatchObject({ status: 'ok', state: 'active' });
      expect(JSON.stringify(listed)).not.toContain('must-not-leak');
    });

    resetContextStoreForTests();
    const observations = listContextObservations({ class: 'preference' });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      scope: 'user_private',
      origin: 'user_note',
      state: 'active',
    });
    expect(observations[0].content).toMatchObject({
      text: 'Prefer compact MCP answers in e2e verification.',
      ownerUserId: USER_ID,
      sourceSessionName: SESSION_NAME,
      sourceProjectName: PROJECT_NAME,
      sourceServerId: SERVER_ID,
    });
    const serialized = JSON.stringify(observations[0].content);
    expect(serialized).not.toContain('forged');
    expect(serialized).not.toContain('evil-project');
    expect(serialized).not.toContain('evil-server');
    expect(serialized).not.toContain('evil-root');
  });

  it('rejects oversized stdio observation writes before persistence', async () => {
    await withStdioClient(childEnv(), async (client) => {
      const rejected = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
        arguments: {
          content: 'x'.repeat(MEMORY_MCP_CAPS.OBSERVATION_CONTENT_MAX_BYTES + 1),
          tags: ['e2e'],
        },
      }));

      expect(rejected).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED,
      });
    });

    resetContextStoreForTests();
    expect(listContextObservations()).toHaveLength(0);
  });

  it('saves an observation, finds it by exact MCP search, and expands source text by observationId or short ref', async () => {
    const text = 'mock server alpha lives at alpha.test.im.codes for MCP observation recall e2e';
    await withStdioClient(childEnv(), async (client) => {
      const saved = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
        arguments: {
          content: text,
          tags: ['e2e'],
          turnId: 'turn-observation-e2e',
        },
      }));
      expect(saved).toMatchObject({ status: 'ok', state: 'candidate' });
      const observationId = String(saved.observationId);

      const search = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
        arguments: {
          query: 'alpha.test.im.codes',
          limit: 5,
        },
      }));
      expect(search).toMatchObject({ status: 'ok' });
      const items = search.items as Array<Record<string, unknown>>;
      const expectedRef = `obs:${observationId.replace(/[^a-f0-9]/gi, '').slice(0, 10)}`;
      expect(items[0]).toMatchObject({
        observationId,
        ref: expectedRef,
        recordKind: 'observation',
        matchKind: 'exact',
        sourceLookup: {
          tool: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
          kind: 'observation',
          observationId,
        },
      });
      expect(items[0].ref).not.toBe(observationId);

      const sources = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        arguments: items[0].sourceLookup as Record<string, unknown>,
      }));
      expect(sources).toMatchObject({
        status: 'ok',
        observationId,
        sourceEventCount: 1,
        sources: [
          expect.objectContaining({
            eventId: 'turn-observation-e2e',
            status: 'observation',
            content: text,
          }),
        ],
      });

      const shortRefSources = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        arguments: {
          ref: expectedRef,
          kind: 'observation',
        },
      }));
      expect(shortRefSources).toMatchObject({
        status: 'ok',
        observationId,
        sourceEventCount: 1,
        sources: [
          expect.objectContaining({
            eventId: 'turn-observation-e2e',
            status: 'observation',
            content: text,
          }),
        ],
      });
    });
  });

  it('finds a projection by MCP search and expands summary fallback by projectionId or short ref', async () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-missing-projection-e2e'],
      summary: 'mock projection fallback source mentions alpha.test.im.codes for MCP expansion',
      content: { ownerUserId: USER_ID, eventCount: 2 },
      origin: 'chat_compacted',
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await withStdioClient(childEnv(), async (client) => {
      const listed = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
        arguments: {
          limit: 5,
        },
      }));
      expect(listed).toMatchObject({ status: 'ok' });
      const listedItems = listed.items as Array<Record<string, unknown>>;
      expect(listedItems.find((item) => item.projectionId === projection.id)).toMatchObject({
        projectionId: projection.id,
        ref: `proj:${projection.id.replace(/[^a-f0-9]/gi, '').slice(0, 10)}`,
        recordKind: 'projection',
        projectionClass: 'recent_summary',
        sourceLookup: {
          tool: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
          kind: 'projection',
          projectionId: projection.id,
        },
      });

      const search = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
        arguments: {
          query: 'alpha.test.im.codes MCP expansion',
          limit: 5,
        },
      }));
      expect(search).toMatchObject({ status: 'ok' });
      const items = search.items as Array<Record<string, unknown>>;
      const hit = items.find((item) => item.projectionId === projection.id);
      expect(hit).toMatchObject({
        projectionId: projection.id,
        recordKind: 'projection',
        sourceLookup: {
          tool: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
          kind: 'projection',
          projectionId: projection.id,
        },
      });
      expect(['exact', 'semantic', 'trigram']).toContain(hit?.matchKind);
      const expectedRef = `proj:${projection.id.replace(/[^a-f0-9]/gi, '').slice(0, 10)}`;
      expect(hit?.ref).toBe(expectedRef);

      const sources = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        arguments: hit?.sourceLookup as Record<string, unknown>,
      }));
      expect(sources).toMatchObject({
        status: 'ok',
        projectionId: projection.id,
        sourceEventCount: 1,
        partial: false,
        projectionSource: expect.objectContaining({
          eventId: 'evt-missing-projection-e2e',
          status: 'projection',
          content: projection.summary,
        }),
        sources: [
          expect.objectContaining({
            eventId: 'evt-missing-projection-e2e',
            status: 'projection',
            content: projection.summary,
          }),
        ],
      });
      expect(JSON.stringify(sources)).not.toContain('ownerUserId');

      const shortRefSources = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        arguments: {
          ref: expectedRef,
          kind: 'projection',
        },
      }));
      expect(shortRefSources).toMatchObject({
        status: 'ok',
        projectionId: projection.id,
        sourceEventCount: 1,
        projectionSource: expect.objectContaining({
          eventId: 'evt-missing-projection-e2e',
          status: 'projection',
          content: projection.summary,
        }),
        sources: [
          expect.objectContaining({
            eventId: 'evt-missing-projection-e2e',
            status: 'projection',
            content: projection.summary,
          }),
        ],
      });
    });
  });

  it('expands legacy personal projection raw sources after MCP search', async () => {
    const legacyNamespace = { scope: 'personal' as const, projectId: PROJECT_NAME };
    const event = recordContextEvent({
      id: 'evt-legacy-projection-e2e',
      target: { namespace: legacyNamespace, kind: 'session' as const, sessionName: SESSION_NAME },
      eventType: 'assistant.turn',
      content: 'legacy personal MCP source content for alpha.test.im.codes',
      createdAt: 2_000,
    });
    archiveEventsForMaterialization([event], 2_100);
    const projection = writeProcessedProjection({
      namespace: legacyNamespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-legacy-projection-e2e'],
      summary: 'legacy personal MCP summary alpha.test.im.codes',
      content: {},
      origin: 'chat_compacted',
      createdAt: 2_000,
      updatedAt: 2_000,
    });

    await withStdioClient({
      ...childEnv(),
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify({ scope: 'personal', userId: USER_ID, projectId: PROJECT_NAME }),
    }, async (client) => {
      const search = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
        arguments: {
          query: 'legacy personal MCP summary',
          limit: 5,
        },
      }));
      const items = search.items as Array<Record<string, unknown>>;
      const hit = items.find((item) => item.projectionId === projection.id);
      expect(hit).toMatchObject({
        projectionId: projection.id,
        recordKind: 'projection',
      });

      const sources = structured(await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        arguments: hit?.sourceLookup as Record<string, unknown>,
      }));
      expect(sources).toMatchObject({
        status: 'ok',
        projectionId: projection.id,
        sourceEventCount: 1,
        projectionSource: expect.objectContaining({
          eventId: 'evt-legacy-projection-e2e',
          status: 'projection',
          content: 'legacy personal MCP summary alpha.test.im.codes',
        }),
        partial: false,
        sources: [
          expect.objectContaining({
            eventId: 'evt-legacy-projection-e2e',
            status: 'archived',
            content: 'legacy personal MCP source content for alpha.test.im.codes',
          }),
        ],
      });
    });
  });

  it('covers sub-session send and cron scope through the MCP handlers', async () => {
    const runId = Math.random().toString(36).slice(2, 8);
    const mainSession = `deck_e2emcp_${runId}_brain`;
    const subSession = `deck_sub_e2e_mcp_${runId}`;
    const targetOne = `deck_e2emcp_${runId}_w1`;
    const targetTwo = `deck_e2emcp_${runId}_w2`;
    const otherProject = `deck_e2eother_${runId}_w1`;
    const targetFile = join(projectRoot, 'docs', 'plan.md');
    await mkdir(join(projectRoot, 'docs'), { recursive: true });
    await writeFile(targetFile, 'DO_NOT_SEND_FILE_BYTES', 'utf8');

    const sessions = [
      sessionRecord(mainSession, PROJECT_NAME, 'brain', projectRoot),
      sessionRecord(subSession, subSession, 'w1', projectRoot, { parentSession: mainSession, label: 'MCP Worker' }),
      sessionRecord(targetOne, PROJECT_NAME, 'w1', projectRoot, { label: 'Friendly Worker' }),
      sessionRecord(targetTwo, PROJECT_NAME, 'w2', projectRoot, { label: 'Second Worker' }),
      sessionRecord(otherProject, 'e2e-other-project', 'w1', projectRoot),
    ];
    const deliveries: Array<{ target: string; message: string }> = [];
    const fetches: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = [];
    const dispatchMessage = vi.fn(async (target: (typeof sessions)[number], message: string) => {
      if (target.name === targetTwo) throw new Error('failed with Bearer secret-token\n    at stack line');
      deliveries.push({ target: target.name, message });
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      fetches.push({ url: String(url), init: init ?? {}, body });
      return new Response(JSON.stringify({ ok: true, body }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const caller: McpRuntimeCaller = {
      userId: USER_ID,
      namespace,
      sessionName: subSession,
      projectName: null,
      projectRoot,
      serverId: SERVER_ID,
      transport: 'in_process',
    };
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: {
        listSessions: () => sessions,
        getSession: (name) => sessions.find((session) => session.name === name),
        dispatchMessage,
      },
      cronOptions: {
        endpoint: {
          serverId: SERVER_ID,
          workerUrl: 'https://worker.invalid/root/',
        },
        fetchImpl,
        nowMs: () => Date.now(),
      },
    });

    const targets = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({});
    expect(targets).toMatchObject({ status: 'ok' });
    expect((targets.items as Array<Record<string, unknown>>).map((item) => item.target)).toEqual([mainSession, targetOne, targetTwo]);
    expect(JSON.stringify(targets)).not.toContain(otherProject);
    expect(JSON.stringify(targets)).not.toContain(projectRoot);

    const labelRejected = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: 'Friendly Worker',
      message: 'label should not resolve on MCP path',
    });
    expect(labelRejected).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    expect(dispatchMessage).not.toHaveBeenCalled();

    const sent = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: targetOne,
      message: 'Please inspect the referenced plan.',
      files: ['docs/plan.md'],
      reply: true,
      idempotencyKey: `send-${runId}`,
    });
    expect(sent).toMatchObject({ status: 'accepted' });
    expect(deliveries.at(-1)).toMatchObject({ target: targetOne });
    expect(deliveries.at(-1)?.message).toContain('Referenced files:\n- docs/plan.md');
    expect(deliveries.at(-1)?.message).toContain(JSON.stringify(subSession));
    expect(deliveries.at(-1)?.message).not.toContain('DO_NOT_SEND_FILE_BYTES');

    const partial = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      broadcast: true,
      message: 'Broadcast partial delivery check.',
      idempotencyKey: `partial-${runId}`,
    });
    expect(partial).toMatchObject({
      status: 'accepted',
      partial: true,
      deliveries: expect.arrayContaining([
        expect.objectContaining({ target: mainSession, status: 'delivered' }),
        expect.objectContaining({ target: targetOne, status: 'delivered' }),
        expect.objectContaining({ target: targetTwo, status: 'failed' }),
      ]),
    });
    expect(JSON.stringify(partial)).not.toContain('secret-token');
    expect(JSON.stringify(partial)).not.toContain('stack line');

    const cronCreated = await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      name: 'MCP e2e scheduled send',
      cronExpr: '* * * * *',
      projectName: PROJECT_NAME,
      targetSessionName: targetOne,
      action: {
        type: 'send',
        target: targetOne,
        message: 'Scheduled MCP e2e send',
        sourceSessionName: 'deck_sub_forged',
        sourceProjectName: 'evil-project',
        sourceServerId: 'evil-server',
      },
      sourceSessionName: 'deck_sub_top_level_forged',
      serverId: 'evil-server',
      token: 'evil-token',
    });
    expect(cronCreated).toMatchObject({ status: 'ok' });
    expect(fetches.at(-1)?.url).toBe(`https://worker.invalid/root/api/server/${SERVER_ID}/cron`);
    expect(fetches.at(-1)?.init.headers).toMatchObject({ 'X-Server-Id': SERVER_ID });
    expect(fetches.at(-1)?.init.headers).not.toHaveProperty('Authorization');
    expect(fetches.at(-1)?.body).toMatchObject({
      serverId: SERVER_ID,
      projectName: PROJECT_NAME,
      targetSessionName: targetOne,
      action: {
        type: 'send',
        target: targetOne,
        message: 'Scheduled MCP e2e send',
        sourceSessionName: subSession,
        sourceProjectName: PROJECT_NAME,
        sourceServerId: SERVER_ID,
      },
    });
    expect(JSON.stringify(fetches.at(-1)?.body)).not.toContain('forged');
    expect(JSON.stringify(fetches.at(-1)?.body)).not.toContain('evil-project');
    expect(JSON.stringify(fetches.at(-1)?.body)).not.toContain('evil-token');

    const crossProjectCron = await handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({
      projectName: 'e2e-other-project',
    });
    expect(crossProjectCron).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });

    const listedCron = await handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ limit: 999 });
    expect(listedCron).toMatchObject({ status: 'ok', limit: 100 });
    expect(fetches.at(-1)?.url).toBe(`https://worker.invalid/root/api/server/${SERVER_ID}/cron?limit=100&projectName=${PROJECT_NAME}`);
  });
});

function sessionRecord(
  name: string,
  projectName: string,
  role: 'brain' | 'w1' | 'w2',
  projectDir: string,
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    projectName,
    role,
    agentType: 'codex-sdk',
    projectDir,
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}
