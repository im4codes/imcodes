import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CANONICAL_INSTALL_POLICY,
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_INSTALL_STATES,
  CAPABILITY_LIMITS,
  CAPABILITY_LIFECYCLE_STATES,
  CAPABILITY_MANAGEMENT_ACTIONS,
  CAPABILITY_MCP_TOOL,
  CAPABILITY_MCP_TOOL_CONTRACTS,
  CAPABILITY_MCP_TOOL_NAMES,
  CAPABILITY_OPERATION_MSG,
  canonicalCapabilityBindingAuthorizationPayload,
  canonicalCapabilitySkillAuthorizationPayload,
  hasCredentialShapedKey,
  isCapabilityCredentialFreeHttpsUrl,
  isCapabilityInstallCancellable,
  normalizeCapabilityMcpDefinition,
  validateCapabilityInstallRequest,
} from '../../shared/capability-management.js';

describe('capability management shared contract', () => {
  it('exposes exactly four simple tools with complete descriptions', () => {
    expect(CAPABILITY_MCP_TOOL_NAMES).toEqual([
      'capability_list',
      'capability_install',
      'capability_status',
      'capability_manage',
    ]);
    expect(Object.keys(CAPABILITY_MCP_TOOL_CONTRACTS)).toEqual([...CAPABILITY_MCP_TOOL_NAMES]);
    for (const name of CAPABILITY_MCP_TOOL_NAMES) {
      const contract = CAPABILITY_MCP_TOOL_CONTRACTS[name];
      expect(contract.description.length).toBeGreaterThan(40);
      for (const property of Object.values(contract.inputSchema.properties ?? {})) {
        expect(property.description?.trim()).not.toBe('');
      }
    }
    expect(CAPABILITY_MCP_TOOL_CONTRACTS[CAPABILITY_MCP_TOOL.INSTALL].description).toContain('one isolated AI audit');
    expect(CAPABILITY_CANONICAL_INSTALL_POLICY).toContain('~/.imcodes/skills');
    expect(CAPABILITY_CANONICAL_INSTALL_POLICY).toContain('Only the user can confirm');
    expect(CAPABILITY_CANONICAL_INSTALL_POLICY).toContain('source.kind=mcp_config');
    expect(CAPABILITY_CANONICAL_INSTALL_POLICY).toContain('do not require an installer URL');
    expect(JSON.stringify(CAPABILITY_MCP_TOOL_CONTRACTS)).not.toMatch(/capability_(?:draft|commit|audit_start|request_approval)/);
  });

  it('advertises direct AI-composed MCP configuration instead of an installer download', () => {
    const install = CAPABILITY_MCP_TOOL_CONTRACTS[CAPABILITY_MCP_TOOL.INSTALL];
    const source = install.inputSchema.properties?.source as {
      properties?: Record<string, { description?: string }>;
    };
    expect(install.description).toContain('directly compose source.kind=mcp_config');
    expect(install.description).toContain('no downloadable installer is required');
    expect(source.properties?.kind?.description).toContain('Use mcp_config');
    expect(source.properties?.mcpConfig?.description).toContain('normal MCP install input');
  });

  it('keeps state and management vocabularies unique and bounded', () => {
    expect(new Set(CAPABILITY_INSTALL_STATES).size).toBe(CAPABILITY_INSTALL_STATES.length);
    expect(new Set(CAPABILITY_LIFECYCLE_STATES).size).toBe(CAPABILITY_LIFECYCLE_STATES.length);
    expect(new Set(CAPABILITY_MANAGEMENT_ACTIONS).size).toBe(CAPABILITY_MANAGEMENT_ACTIONS.length);
    expect(CAPABILITY_MANAGEMENT_ACTIONS).toContain('uninstall');
    expect(CAPABILITY_MANAGEMENT_ACTIONS).toContain('delete_credentials');
    expect(CAPABILITY_OPERATION_MSG).toEqual({
      INSTALL: 'capability.operation.install',
      PROGRESS: 'capability.operation.progress',
      CONFIRM: 'capability.operation.confirm',
      CANCEL: 'capability.operation.cancel',
      ACTIVATE: 'capability.operation.activate',
      AUTHORIZE: 'capability.operation.authorize',
      COMMIT_RESULT: 'capability.operation.commit_result',
      COMMIT_ACK: 'capability.operation.commit_ack',
      COMMIT_ABORT: 'capability.operation.commit_abort',
      MANAGE: 'capability.operation.manage',
      MANAGE_RESULT: 'capability.operation.manage_result',
      MANAGE_ACK: 'capability.operation.manage_ack',
    });
    expect(isCapabilityInstallCancellable(CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION)).toBe(true);
    expect(isCapabilityInstallCancellable(CAPABILITY_INSTALL_STATE.INSTALLING)).toBe(false);
    expect(isCapabilityInstallCancellable(CAPABILITY_INSTALL_STATE.SYNCING)).toBe(false);
    expect(isCapabilityInstallCancellable(CAPABILITY_INSTALL_STATE.INSTALLED)).toBe(false);
    const maximumRecordBudget = CAPABILITY_LIMITS.SYNC_ITEMS * CAPABILITY_LIMITS.SYNC_ITEM_RECORD_BYTES
      + CAPABILITY_LIMITS.SYNC_VERSIONS * CAPABILITY_LIMITS.SYNC_VERSION_RECORD_BYTES
      + CAPABILITY_LIMITS.SYNC_BINDINGS * CAPABILITY_LIMITS.SYNC_BINDING_RECORD_BYTES
      + CAPABILITY_LIMITS.SYNC_TOMBSTONES * CAPABILITY_LIMITS.SYNC_TOMBSTONE_RECORD_BYTES;
    expect(maximumRecordBudget).toBeLessThan(CAPABILITY_LIMITS.SYNC_FRAME_BYTES);
  });

  it('canonicalizes the exact server-signed Skill authorization fields without the signature', () => {
    const payload = canonicalCapabilitySkillAuthorizationPayload({
      schemaVersion: 1,
      algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
      keyId: 'a'.repeat(64),
      ownerId: 'owner-1',
      capabilityId: 'capability-1',
      versionId: 'version-1',
      artifactDigest: 'b'.repeat(64),
      auditDigest: 'c'.repeat(64),
      blobDigest: 'd'.repeat(64),
      bindingId: 'binding-1',
      bindingDigest: 'e'.repeat(64),
      itemRevision: 7,
      bindingRevision: 4,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      issuedRevision: 7,
      issuedAt: 123,
    });
    expect(payload).not.toContain('signature');
    expect(JSON.parse(payload)).toEqual(expect.objectContaining({
      algorithm: 'Ed25519',
      capabilityId: 'capability-1',
      bindingId: 'binding-1',
      issuedRevision: 7,
      itemRevision: 7,
      bindingRevision: 4,
      bindingState: 'active',
    }));
  });

  it('binds active state into the signed binding preimage', () => {
    const binding = {
      id: 'binding-1', capabilityId: 'capability-1', versionId: 'version-1',
      scope: 'account' as const, providers: [], machines: [], active: true,
    };
    expect(canonicalCapabilityBindingAuthorizationPayload(binding))
      .not.toBe(canonicalCapabilityBindingAuthorizationPayload({ ...binding, active: false }));
  });

  it('rejects project scope without id and raw credential-shaped MCP config', () => {
    expect(validateCapabilityInstallRequest({
      kind: 'skill',
      source: { kind: 'url', value: 'https://example.test/skill.zip' },
      scope: 'project',
      idempotencyKey: 'one',
    })).toContain('scopeId');
    expect(validateCapabilityInstallRequest({
      kind: 'mcp',
      source: { kind: 'mcp_config', mcpConfig: { url: 'https://mcp.example.test', apiToken: 'secret' } },
      scope: 'account',
      idempotencyKey: 'two',
    })).toContain('credential');
    expect(hasCredentialShapedKey({ nested: { private_key: 'x' } })).toBe(true);
    expect(hasCredentialShapedKey({ credentialRef: 'cred_opaque_123', apiKeyRef: 'cred_opaque_456' })).toBe(false);
    expect(hasCredentialShapedKey({ credentialRef: { token: 'raw-secret' } })).toBe(true);
    let buried: Record<string, unknown> = { token: 'raw-secret' };
    for (let depth = 0; depth < 20; depth += 1) buried = { nested: buried };
    expect(hasCredentialShapedKey(buried)).toBe(true);
    expect(validateCapabilityInstallRequest({
      kind: 'mcp',
      source: { kind: 'url', value: 'https://mcp.example.test/path?token=raw-secret' },
      scope: 'account',
      idempotencyKey: 'three',
    })).toContain('credential-free HTTPS');
    expect(validateCapabilityInstallRequest({
      kind: 'skill',
      source: { kind: 'inline', inlineFiles: { 'SKILL.md': 'x'.repeat(512 * 1024 + 1) } },
      scope: 'local',
      idempotencyKey: 'four',
    })).toContain('too large');
    expect(validateCapabilityInstallRequest({
      kind: 'mcp',
      source: { kind: 'mcp_config', mcpConfig: buried },
      scope: 'account',
      idempotencyKey: 'five',
    })).toContain('too deep');
  });

  it('advertises the truthful credential-store boundary to AI installers', () => {
    const source = CAPABILITY_MCP_TOOL_CONTRACTS.capability_install.inputSchema.properties?.source as {
      properties?: Record<string, { description?: string }>;
    };
    expect(source.properties?.mcpConfig?.description).toMatch(/credential store is not ready/i);
    expect(source.properties?.mcpConfig?.description).toMatch(/runtime_pending/i);
    expect(source.properties?.mcpConfig?.description).not.toMatch(/use credential references/i);
  });

  it('normalizes only non-secret stdio and Streamable HTTP MCP definitions', () => {
    expect(normalizeCapabilityMcpDefinition({
      kind: 'mcp_config',
      mcpConfig: {
        name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@example/mcp'],
        env: { API_TOKEN: { credentialRef: 'credential-1' } },
        toolAllowlist: ['files.read'],
      },
    })).toBeNull();
    for (const mcpConfig of [
      { name: 'top-ref', transport: 'stdio', command: 'mcp', credentialRef: 'credential-1' },
      { name: 'header-ref', transport: 'streamable_http', url: 'https://mcp.example.test/rpc', headers: { Authorization: { credentialRef: 'credential-1' } } },
      { name: 'unknown-ref', transport: 'stdio', command: 'mcp', credentialRef: 'unknown-reference' },
    ]) expect(normalizeCapabilityMcpDefinition({ kind: 'mcp_config', mcpConfig })).toBeNull();
    expect(normalizeCapabilityMcpDefinition({
      kind: 'url', value: 'https://mcp.example.test/rpc',
    }, 'remote')).toEqual({
      name: 'remote', transport: 'streamable_http', url: 'https://mcp.example.test/rpc',
    });
    expect(normalizeCapabilityMcpDefinition({
      kind: 'mcp_config',
      mcpConfig: { name: 'unsafe', transport: 'stdio', command: 'npx', env: { API_TOKEN: 'raw-secret' } },
    })).toBeNull();
    expect(normalizeCapabilityMcpDefinition({
      kind: 'mcp_config', mcpConfig: { name: 'legacy', transport: 'sse', url: 'https://mcp.example.test/sse' },
    })).toBeNull();
    for (const args of [
      ['--api-key', 'sk-live-1234567890123456'],
      ['--access_key=AKIA1234567890123456'],
      ['--token', 'plain-value'],
      ['Bearer abcdefghijklmnop'],
    ]) {
      expect(normalizeCapabilityMcpDefinition({
        kind: 'mcp_config',
        mcpConfig: { name: 'unsafe-argv', transport: 'stdio', command: 'mcp', args },
      })).toBeNull();
    }
    expect(normalizeCapabilityMcpDefinition({
      kind: 'mcp_config',
      mcpConfig: { name: 'safe-argv', transport: 'stdio', command: 'npx', args: ['-y', '@example/mcp', '--port', '4040'] },
    })).not.toBeNull();
    expect(normalizeCapabilityMcpDefinition({
      kind: 'mcp_config',
      mcpConfig: {
        name: 'unsafe-key', transport: 'stdio', command: 'mcp',
        env: JSON.parse('{"__proto__":{"credentialRef":"credential-1"}}') as Record<string, unknown>,
      },
    })).toBeNull();
    for (const url of [
      'https://mcp.example.test/rpc?key=raw',
      'https://mcp.example.test/rpc?access_key=raw',
      'https://mcp.example.test/rpc?signature=raw',
      'https://mcp.example.test/rpc?sig=raw',
      'https://mcp.example.test/rpc?X-Amz-Credential=raw',
      'https://mcp.example.test/rpc?next=sk-live-1234567890123456',
    ]) expect(isCapabilityCredentialFreeHttpsUrl(url)).toBe(false);
    expect(isCapabilityCredentialFreeHttpsUrl('https://mcp.example.test/rpc?region=us-east-1')).toBe(true);
    const secret = 'sk-live-1234567890123456';
    for (const mcpConfig of [
      { name: secret, transport: 'stdio', command: 'mcp' },
      { name: 'safe', transport: 'stdio', command: secret },
      { name: 'safe', transport: 'stdio', command: 'mcp', toolAllowlist: [secret] },
    ]) {
      expect(normalizeCapabilityMcpDefinition({ kind: 'mcp_config', mcpConfig })).toBeNull();
    }
  });

  it('strictly bounds every HTTP install field before persistence', () => {
    const valid = {
      kind: 'skill' as const,
      source: { kind: 'inline' as const, inlineFiles: { 'SKILL.md': 'safe' } },
      scope: 'account' as const,
      idempotencyKey: 'strict-request',
    };
    expect(validateCapabilityInstallRequest(valid)).toBeNull();
    expect(validateCapabilityInstallRequest({ ...valid, unknown: true } as never)).toContain('unsupported');
    expect(validateCapabilityInstallRequest({
      ...valid,
      source: { ...valid.source, unknown: true },
    } as never)).toContain('unsupported');
    expect(validateCapabilityInstallRequest({
      ...valid,
      displayName: 'x'.repeat(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS + 1),
    })).toContain('displayName');
    expect(validateCapabilityInstallRequest({
      ...valid,
      scopeId: 'not-valid-for-account',
    })).toContain('scopeId');
    expect(validateCapabilityInstallRequest({
      ...valid,
      providers: [42] as never,
    })).toContain('providers');
    expect(validateCapabilityInstallRequest({
      ...valid,
      machines: ['x'.repeat(CAPABILITY_LIMITS.MACHINE_ID_BYTES + 1)],
    })).toContain('machines');
    expect(validateCapabilityInstallRequest({
      ...valid,
      providers: ['codex\u0000forged'],
    })).toContain('providers');
    expect(validateCapabilityInstallRequest({
      ...valid,
      source: { kind: 'inline', value: 'unexpected', inlineFiles: { 'SKILL.md': 'safe' } },
    })).toContain('shape');
    expect(validateCapabilityInstallRequest({
      ...valid,
      source: { kind: 'repository', value: 'https://github.com/example/skill', repositorySubdir: '../escape' },
    })).toContain('repositorySubdir');
  });
});
