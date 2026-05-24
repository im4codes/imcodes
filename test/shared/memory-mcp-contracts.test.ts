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
  it('exposes exactly the ten MVP tool names', () => {
    expect(MEMORY_MCP_TOOL_NAME_LIST).toEqual([
      'search_memory',
      'get_memory_sources',
      'save_observation',
      'save_preference',
      'send_list_targets',
      'send_message',
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

    const send = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE];
    const files = send.inputSchema.properties?.files as { description?: string } | undefined;
    expect(files?.description).toMatch(/path references/i);
    expect(files?.description).toMatch(/not read or transferred/i);
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
      CRON_EXPIRES_AT_MAX_DAYS: 90,
      CRON_LIST_MAX_LIMIT: 100,
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
