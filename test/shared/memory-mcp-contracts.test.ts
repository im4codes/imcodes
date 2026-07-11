import { describe, expect, it } from 'vitest';
import {
  MEMORY_MCP_CAPS,
  MEMORY_MCP_FORBIDDEN_ARG_NAMES,
  MEMORY_MCP_TOOL_CONTRACTS,
  MEMORY_MCP_TOOL_NAME_LIST,
  MEMORY_MCP_TOOL_NAMES,
  buildMcpDisabledResult,
  pickAllowedMcpArgs,
  stripForbiddenMcpArgs,
} from '../../shared/memory-mcp-contracts.js';
import { PREFERENCE_MAX_BYTES } from '../../shared/preference-ingest.js';

function collectDescriptions(schema: { description?: string; properties?: Readonly<Record<string, unknown>> }): string[] {
  const descriptions: string[] = [];
  if (schema.description) descriptions.push(schema.description);
  for (const value of Object.values(schema.properties ?? {})) {
    descriptions.push(...collectDescriptions(value as { description?: string; properties?: Readonly<Record<string, unknown>> }));
  }
  return descriptions;
}

describe('memory MCP shared contracts', () => {
  it('exposes the registered MCP tool names including the execution-clone destroy tool', () => {
    expect(MEMORY_MCP_TOOL_NAME_LIST).toEqual([
      'search_memory',
      'list_memory_summaries',
      'get_memory_sources',
      'archive_memory',
      'restore_memory',
      'delete_memory',
      'update_memory',
      'memory_feedback',
      'save_observation',
      'save_preference',
      'send_list_targets',
      'send_message',
      'send_stop',
      'destroy_execution_clone',
      'cron_create_self',
      'cron_update_self',
      'cron_cancel_self',
      'cron_create',
      'cron_list',
      'cron_update',
      'cron_delete',
    ]);
    expect(Object.keys(MEMORY_MCP_TOOL_CONTRACTS)).toEqual([...MEMORY_MCP_TOOL_NAME_LIST]);
  });

  it('keeps search as a text-query contract and send files as path references', () => {
    const search = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY].inputSchema.properties ?? {};
    expect(Object.keys(search)).toEqual(['query', 'limit']);
    expect(search).not.toHaveProperty('embedding');
    expect(search).not.toHaveProperty('vector');

    const summaries = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES].inputSchema.properties ?? {};
    expect(Object.keys(summaries)).toEqual(['projectionClass', 'limit']);
    expect(summaries).not.toHaveProperty('query');

    const archive = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY].inputSchema.properties ?? {};
    const update = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY].inputSchema.properties ?? {};
    const feedback = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK].inputSchema.properties ?? {};
    expect(Object.keys(archive)).toEqual(['projectionId', 'ref']);
    expect(Object.keys(update)).toEqual(['projectionId', 'ref', 'text']);
    expect(Object.keys(feedback)).toEqual(['projectionId', 'ref', 'feedback', 'reason']);
    expect(archive).not.toHaveProperty('projectId');
    expect(update).not.toHaveProperty('namespace');
    expect(feedback).not.toHaveProperty('userId');

    const send = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE];
    const files = send.inputSchema.properties?.files as { description?: string } | undefined;
    expect(files?.description).toMatch(/path references/i);
    expect(files?.description).toMatch(/not read or transferred/i);
  });

  it('documents scoped send target discovery and self-target rejection', () => {
    const sendList = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS];
    const sendMessage = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE];

    expect(sendList.description).toContain('current caller session');
    expect(sendList.description).toContain('stopped sessions are excluded');
    expect(sendList.description).toContain('if this returns no items');
    expect(sendList.description).toContain('ask CC to audit');
    expect(sendList.description).toContain('invite a reviewer to discuss');
    expect(sendList.description).toContain('display label');
    expect(sendList.description).toContain('no such running peer session is available');
    expect(sendMessage.description).toContain('caller session is not a valid target');
    expect(sendMessage.description).toContain('empty send_list_targets result');
    expect(sendMessage.description).toContain('asking a CC session to audit');
    expect(sendMessage.description).toContain('does not start a structured Team/P2P discussion run');

    const sendListQuery = sendList.inputSchema.properties?.query as { description?: string } | undefined;
    const sendMessageText = sendMessage.inputSchema.properties?.message as { description?: string } | undefined;
    const sendMessageReply = sendMessage.inputSchema.properties?.reply as { description?: string } | undefined;
    const sendMessageBroadcast = sendMessage.inputSchema.properties?.broadcast as { description?: string } | undefined;
    expect(sendListQuery?.description).toContain('cc');
    expect(sendListQuery?.description).toContain('display labels');
    expect(sendMessageText?.description).toContain('complete task/request text');
    expect(sendMessageReply?.description).toContain('Set true');
    expect(sendMessageReply?.description).toContain('discussion invites');
    expect(sendMessageBroadcast?.description).toContain('every/all available sessions');
  });

  it('provides operational tool and parameter descriptions without secret/doc leakage', () => {
    for (const name of MEMORY_MCP_TOOL_NAME_LIST) {
      const contract = MEMORY_MCP_TOOL_CONTRACTS[name];
      expect(contract.description.length).toBeGreaterThan(60);
      expect(contract.description).not.toMatch(/\b(tool|does stuff|see docs|external documentation)\b/i);
      for (const [property, schema] of Object.entries(contract.inputSchema.properties ?? {})) {
        expect(property).not.toEqual('');
        expect((schema as { description?: string }).description?.length ?? 0).toBeGreaterThan(20);
      }
      const allDescriptions = [contract.description, ...collectDescriptions(contract.inputSchema)].join('\n');
      expect(allDescriptions).not.toMatch(/IMCODES_|server token|api key|docs\/mcp|namespace json/i);
    }
  });

  it('documents when search_memory results should be expanded through get_memory_sources', () => {
    const search = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY];
    const getSources = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES];
    const projectionId = getSources.inputSchema.properties?.projectionId as { description?: string } | undefined;
    const observationId = getSources.inputSchema.properties?.observationId as { description?: string } | undefined;
    const ref = getSources.inputSchema.properties?.ref as { description?: string } | undefined;

    expect(search.description).toContain('call get_memory_sources');
    expect(search.description).toContain('sourceLookup');
    expect(search.description).toMatch(/typed sourceLookup/i);
    expect(getSources.description).toContain('Use it after search_memory');
    expect(getSources.description).toContain('observation id');
    expect(getSources.description).toContain('compact ref');
    expect(getSources.description).toContain('provenance-sensitive answers');
    expect(projectionId?.description).toContain('search_memory');
    expect(observationId?.description).toContain('search_memory');
    expect(ref?.description).toContain('startup memory');
  });

  it('pins locked caps and disabled response shape', () => {
    expect(MEMORY_MCP_CAPS).toMatchObject({
      OBSERVATION_CONTENT_MAX_BYTES: 16 * 1024,
      OBSERVATION_TAGS_MAX_COUNT: 8,
      OBSERVATION_TAG_MAX_CHARS: 64,
      PREFERENCE_MAX_BYTES,
      SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS: 5_000,
      SEND_MESSAGE_MAX_BYTES: 64 * 1024,
      SEND_FILES_MAX_COUNT: 32,
      SEND_FILE_PATH_MAX_CHARS: 512,
      CRON_MIN_INTERVAL_MINUTES: 5,
      CRON_EXPIRES_AT_MAX_DAYS: 90,
      CRON_LIST_MAX_LIMIT: 100,
      LIST_MEMORY_SUMMARIES_DEFAULT_LIMIT: 20,
      LIST_MEMORY_SUMMARIES_MAX_LIMIT: 100,
    });
    expect(buildMcpDisabledResult('mem.feature.quick_search', { items: [] })).toEqual({
      status: 'disabled',
      reason: 'feature_disabled',
      disabledFlag: 'mem.feature.quick_search',
      recoverable: true,
      items: [],
    });
  });

  it('does not include forbidden authority fields in schemas and strips them at runtime', () => {
    for (const contract of Object.values(MEMORY_MCP_TOOL_CONTRACTS)) {
      for (const forbidden of MEMORY_MCP_FORBIDDEN_ARG_NAMES) {
        expect(contract.inputSchema.properties ?? {}).not.toHaveProperty(forbidden);
      }
    }

    const stripped = stripForbiddenMcpArgs({
      content: 'persist me',
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      fingerprint: 'forged',
      sourceSessionName: 'deck_sub_forged',
      sourceProjectName: 'other',
      sourceServerId: 'srv-forged',
      token: 'secret',
    });
    expect(stripped).toEqual({ content: 'persist me' });
    expect(pickAllowedMcpArgs({ content: 'ok', extra: true, state: 'active' }, ['content'])).toEqual({ content: 'ok' });
  });

  it('keeps cron shared schemas aligned with the registered top-level MCP inputs', () => {
    const cronCreateSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF].inputSchema;
    expect(Object.keys(cronCreateSelf.properties ?? {})).toEqual([
      'cronExpr',
      'message',
      'name',
      'timezone',
      'expiresAt',
    ]);
    expect(cronCreateSelf.required).toEqual(['cronExpr', 'message']);
    expect(cronCreateSelf.properties ?? {}).not.toHaveProperty('sessionName');

    const cronUpdateSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF].inputSchema;
    expect(Object.keys(cronUpdateSelf.properties ?? {})).toEqual([
      'id',
      'cronExpr',
      'message',
      'name',
      'timezone',
      'expiresAt',
    ]);
    expect(cronUpdateSelf.required).toEqual(['id']);
    expect(cronUpdateSelf.properties ?? {}).not.toHaveProperty('sessionName');

    const cronCancelSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF].inputSchema;
    expect(Object.keys(cronCancelSelf.properties ?? {})).toEqual(['id', 'name', 'all']);
    expect(cronCancelSelf.properties ?? {}).not.toHaveProperty('sessionName');

    const cronCreate = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CREATE].inputSchema;
    expect(Object.keys(cronCreate.properties ?? {})).toEqual([
      'name',
      'cronExpr',
      'projectName',
      'targetRole',
      'targetSessionName',
      'action',
      'timezone',
      'expiresAt',
    ]);
    expect(cronCreate.required).toEqual(['name', 'cronExpr', 'action']);
    expect(cronCreate.properties ?? {}).not.toHaveProperty('schedule');

    const cronList = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_LIST].inputSchema;
    expect(Object.keys(cronList.properties ?? {})).toEqual([
      'projectName',
      'limit',
    ]);
    expect(cronList.properties ?? {}).not.toHaveProperty('cursor');

    const cronUpdate = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE].inputSchema;
    expect(Object.keys(cronUpdate.properties ?? {})).toEqual([
      'id',
      'name',
      'cronExpr',
      'projectName',
      'targetRole',
      'targetSessionName',
      'action',
      'timezone',
      'expiresAt',
    ]);
    expect(cronUpdate.required).toEqual(['id']);
    expect(cronUpdate.properties ?? {}).not.toHaveProperty('schedule');
  });

  it('documents cron scheduling limits and structured send source-target resolution', () => {
    const cronCreateSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF];
    const cronUpdateSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF];
    const cronCancelSelf = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF];
    const cronCreate = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_CREATE];
    const cronUpdate = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.CRON_UPDATE];
    const createProps = cronCreate.inputSchema.properties ?? {};
    const updateProps = cronUpdate.inputSchema.properties ?? {};

    expect(cronCreateSelf.description).toContain('current caller session');
    expect(cronCreateSelf.description).toContain('detected from the MCP runtime');
    expect(cronCreateSelf.description).toContain('PREFERRED');
    expect(cronUpdateSelf.description).toContain('PREFERRED');
    expect(cronCancelSelf.description).toContain('current caller session');
    expect(cronCancelSelf.description).toContain('PREFERRED');
    expect(cronCreate.description).toContain('prefer cron_create_self');
    expect(cronCreate.description).toContain('at least 5 minutes');
    expect((createProps.cronExpr as { description?: string }).description).toContain('* * * * *');
    expect((createProps.targetSessionName as { description?: string }).description).toContain('source session');
    expect((createProps.action as { description?: string }).description).toContain('send_list_targets');
    expect((createProps.action as { description?: string }).description).toContain('selected by targetSessionName or targetRole');
    expect((createProps.timezone as { description?: string }).description).toContain('schedule evaluation only');
    expect((createProps.expiresAt as { description?: string }).description).toContain('explicit offset or Z suffix');
    expect((createProps.expiresAt as { description?: string }).description).toContain('does not retract messages already dispatched');
    expect(cronUpdate.description).toContain('at least 5 minutes');
    expect((updateProps.action as { description?: string }).description).toContain('selected by targetSessionName or targetRole');
    expect((updateProps.expiresAt as { description?: string }).description).toContain('does not retract already dispatched messages');
  });

  // ── memory-source-server-routing change ─────────────────────────────
  //
  // `serverId` must stay in MEMORY_MCP_FORBIDDEN_ARG_NAMES so callers
  // cannot forge routing by claiming a different daemon. The daemon's
  // get_memory_sources orchestrator resolves originServerId from cache
  // or the cloud projection-owner endpoint, never from tool input.

  it('keeps serverId in the forbidden args list (cross-server routing safety)', () => {
    expect(MEMORY_MCP_FORBIDDEN_ARG_NAMES).toContain('serverId');
  });

  it('strips serverId from get_memory_sources input via pickAllowedMcpArgs', () => {
    const stripped = pickAllowedMcpArgs(
      { ref: 'proj:abc123', serverId: 'attacker-srv', userId: 'mallory' },
      ['projectionId', 'observationId', 'kind', 'ref'],
    );
    expect(stripped).toEqual({ ref: 'proj:abc123' });
    expect(stripped).not.toHaveProperty('serverId');
  });

  it('also strips serverId via the broader stripForbiddenMcpArgs helper', () => {
    const stripped = stripForbiddenMcpArgs({
      projectionId: 'p1',
      serverId: 'attacker-srv',
      sourceServerId: 'attacker-2',
    });
    expect(stripped).toEqual({ projectionId: 'p1' });
  });
});
