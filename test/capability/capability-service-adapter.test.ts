import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_ERROR,
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_KIND,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
} from '../../shared/capability-management.js';
import { createDefaultCapabilityService } from '../../src/capability/capability-service-adapter.js';
import type { CapabilityAuditEnvelope } from '../../src/capability/capability-audit.js';
import { signedSyncBinding } from './capability-authorization-fixture.js';

describe('shared daemon capability service adapter', () => {
  let homeDir: string | undefined;
  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  it('maps shared inline requests and fails closed when the auditor is unavailable', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-home-'));
    const service = createDefaultCapabilityService({
      ownerId: 'owner', conversationIdentity: 'conversation', homeDir,
      auditRunner: { identity: 'isolated-unavailable', async audit() { throw new Error('unavailable'); } },
    });
    const result = await service.install({
      kind: CAPABILITY_KIND.SKILL,
      source: {
        kind: CAPABILITY_SOURCE_KIND.INLINE,
        inlineFiles: { 'SKILL.md': '---\nname: adapter-skill\ndescription: Adapter Skill.\n---\nBody.\n' },
      },
      scope: CAPABILITY_SCOPE.LOCAL,
      idempotencyKey: 'adapter-install',
    });
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'rework', errorCode: CAPABILITY_ERROR.AUDIT_REWORK } });
  });

  it('runs MCP admission and fails closed when the real default auditor is unavailable', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-home-'));
    const service = createDefaultCapabilityService({
      ownerId: 'owner', conversationIdentity: 'conversation', homeDir,
      auditRunner: { identity: 'isolated-unavailable', async audit() { throw new Error('offline'); } },
    });
    const result = await service.install({
      kind: CAPABILITY_KIND.MCP,
      displayName: 'safe-mcp',
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: { transport: 'stdio', name: 'safe-mcp', command: 'safe-command' } },
      scope: CAPABILITY_SCOPE.LOCAL,
      idempotencyKey: 'mcp-install',
    });
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'rework', errorCode: CAPABILITY_ERROR.AUDIT_REWORK } });
  });

  it('rejects raw MCP secrets and deprecated HTTP+SSE before audit', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-home-'));
    const service = createDefaultCapabilityService({ ownerId: 'owner', conversationIdentity: 'conversation', homeDir });
    await expect(service.install({
      kind: CAPABILITY_KIND.MCP,
      displayName: 'unsafe-mcp',
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: { transport: 'stdio', command: 'mcp', env: { API_TOKEN: 'raw-secret' } } },
      scope: CAPABILITY_SCOPE.LOCAL, idempotencyKey: 'raw-secret',
    })).resolves.toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.INVALID_INPUT });
    await expect(service.install({
      kind: CAPABILITY_KIND.MCP,
      displayName: 'legacy-mcp',
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: { transport: 'sse', url: 'https://example.test/sse' } },
      scope: CAPABILITY_SCOPE.LOCAL, idempotencyKey: 'legacy-sse',
    })).resolves.toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.INVALID_INPUT });
  });

  it('preserves a real REWORK verdict instead of inferring PASS from the audit digest', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-home-'));
    const service = createDefaultCapabilityService({
      ownerId: 'owner', conversationIdentity: 'conversation', homeDir,
      auditRunner: {
        identity: 'isolated-rework',
        async audit(envelope: CapabilityAuditEnvelope) {
          return {
            verdict: 'REWORK', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest,
            findings: [{ severity: 'medium', code: 'review_needed', summary: 'Review needed.' }], model: 'test',
          };
        },
      },
    });
    const result = await service.install({
      kind: CAPABILITY_KIND.SKILL,
      source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': '---\nname: rework-skill\ndescription: Rework Skill.\n---\nBody.\n' } },
      scope: CAPABILITY_SCOPE.LOCAL,
      idempotencyKey: 'rework-install',
    });
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'rework', auditVerdict: 'REWORK' } });
  });

  it('uses an explicitly injected isolated auditor and preserves exact session scope', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-home-'));
    const service = createDefaultCapabilityService({
      ownerId: 'owner',
      conversationIdentity: 'conversation',
      sessionId: 'deck_one',
      homeDir,
      auditRunner: {
        identity: 'isolated-audit',
        async audit(envelope: CapabilityAuditEnvelope) {
          return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
        },
      },
    });
    const result = await service.install({
      kind: CAPABILITY_KIND.SKILL,
      source: {
        kind: CAPABILITY_SOURCE_KIND.INLINE,
        inlineFiles: { 'SKILL.md': '---\nname: scoped-skill\ndescription: Scoped Skill.\n---\nBody.\n' },
      },
      scope: CAPABILITY_SCOPE.SESSION,
      scopeId: 'deck_one',
      idempotencyKey: 'scoped-install',
    });
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'awaiting_confirmation' } });
    if (result.status !== 'ok') throw new Error('unexpected adapter error');
    const installing = service.confirm({
      operationId: result.operation.id,
      revision: result.operation.revision,
      artifactDigest: result.operation.artifactDigest!,
      auditDigest: result.operation.auditDigest!,
      decision: 'install',
    });
    expect(installing).toMatchObject({ status: 'ok', operation: { state: 'installing' } });
    if (installing.status !== 'ok') throw new Error('missing installing operation');
    const capabilityId = 'authority-scoped-skill';
    const version = {
      id: 'authority-scoped-version', capabilityId, version: 1,
      artifactDigest: installing.operation.artifactDigest!, auditDigest: installing.operation.auditDigest!,
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS, sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: Date.now(),
    };
    const binding = signedSyncBinding({
      ownerId: 'owner', capabilityId, version,
      binding: { id: 'authority-scoped-binding', capabilityId, versionId: version.id,
        scope: CAPABILITY_SCOPE.SESSION, scopeId: 'deck_one', providers: [], machines: [], active: true },
    });
    const rollbackSnapshot = service.captureAuthorizedState(capabilityId, CAPABILITY_KIND.SKILL);
    const installed = service.commitAuthorized({
      operationId: installing.operation.id,
      capability: {
        id: capabilityId, revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'scoped-skill', state: CAPABILITY_STATE.PENDING,
        scope: CAPABILITY_SCOPE.SESSION, versionId: version.id, version: 1,
        artifactDigest: version.artifactDigest, sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
        readiness: CAPABILITY_READINESS.CONTENT_MISSING, findings: [], bindings: [binding], updatedAt: Date.now(),
      },
      versionId: version.id,
      binding,
    });
    expect(installed?.operation).toMatchObject({ state: 'installed', capabilityId });
    expect(service.list({})).toMatchObject({ items: [{ name: 'scoped-skill', scope: CAPABILITY_SCOPE.SESSION }] });
    expect(await service.manage({
      action: 'disable',
      capabilityId,
      expectedRevision: 999,
    })).toEqual(expect.objectContaining({ status: 'error', reason: CAPABILITY_ERROR.CONFLICT }));
    expect(service.rollbackAuthorizedState(rollbackSnapshot, version.id)).toBe(true);
    expect(service.rollbackAuthorizedState(rollbackSnapshot, version.id)).toBe(true);
    expect(service.status({ capabilityId })).toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.NOT_FOUND });
  });

  it('persists and exactly manages machine-local MCP authority across daemon service restart', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-local-mcp-'));
    const options = {
      ownerId: 'owner', conversationIdentity: 'conversation', serverId: 'server-1', homeDir,
      auditRunner: { identity: 'isolated-audit', async audit(envelope: CapabilityAuditEnvelope) {
        return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      } },
    };
    const service = createDefaultCapabilityService(options);
    const result = await service.install({
      kind: CAPABILITY_KIND.MCP,
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: {
        name: 'local-mcp', transport: 'streamable-http', url: 'https://mcp.example/tools',
      } },
      scope: CAPABILITY_SCOPE.LOCAL, idempotencyKey: 'local-mcp',
    });
    if (result.status !== 'ok') throw new Error('MCP admission failed');
    const installing = service.confirm({
      operationId: result.operation.id, revision: result.operation.revision,
      artifactDigest: result.operation.artifactDigest!, auditDigest: result.operation.auditDigest!, decision: 'install',
    });
    if (installing.status !== 'ok') throw new Error('MCP confirmation failed');
    const binding = {
      id: 'local-mcp-binding', capabilityId: 'local-mcp-authority', versionId: 'local-mcp-version',
      scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: [], machines: [], active: true,
    } as const;
    const rollbackSnapshot = service.captureAuthorizedState('local-mcp-authority', CAPABILITY_KIND.MCP);
    expect(service.commitAuthorized({
      operationId: installing.operation.id,
      capability: {
        id: 'local-mcp-authority', revision: 10, kind: CAPABILITY_KIND.MCP, name: 'local-mcp',
        state: CAPABILITY_STATE.PENDING, scope: CAPABILITY_SCOPE.LOCAL,
        versionId: 'local-mcp-version', version: 1, artifactDigest: installing.operation.artifactDigest,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
        findings: [], bindings: [binding], updatedAt: Date.now(),
      },
      versionId: 'local-mcp-version', binding,
    })?.operation).toMatchObject({ state: 'installed', capabilityId: 'local-mcp-authority' });

    const restored = createDefaultCapabilityService(options);
    expect(restored.list({})).toMatchObject({ items: [{ id: 'local-mcp-authority', state: CAPABILITY_STATE.RUNTIME_PENDING }] });
    expect(restored.manageExactLocalMcp({
      serverId: 'server-1', capabilityId: 'local-mcp-authority', bindingId: binding.id,
      action: 'disable', expectedRevision: 10,
    })).toMatchObject({ ok: true, capability: { state: CAPABILITY_STATE.DISABLED, revision: 11 } });
    const restartedAgain = createDefaultCapabilityService(options);
    expect(restartedAgain.list({})).toMatchObject({
      items: [{
        id: 'local-mcp-authority',
        state: CAPABILITY_STATE.RUNTIME_PENDING,
        readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
      }],
    });
    expect(restartedAgain.manageExactLocalMcp({
      serverId: 'server-2', capabilityId: 'local-mcp-authority', bindingId: binding.id,
      action: 'restore', expectedRevision: 11,
    })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(restartedAgain.manageExactLocalMcp({
      serverId: 'server-1', capabilityId: 'local-mcp-authority', bindingId: binding.id,
      action: 'restore', expectedRevision: 11,
    })).toMatchObject({ ok: true, capability: { state: CAPABILITY_STATE.RUNTIME_PENDING, revision: 12 } });
    expect(restartedAgain.rollbackAuthorizedState(rollbackSnapshot, 'local-mcp-version')).toBe(true);
    expect(restartedAgain.rollbackAuthorizedState(rollbackSnapshot, 'local-mcp-version')).toBe(true);
    expect(restartedAgain.status({ capabilityId: 'local-mcp-authority' }))
      .toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.NOT_FOUND });
  });

  it('rolls back only one machine-local MCP binding version across restart', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-adapter-local-mcp-bindings-'));
    const options = {
      ownerId: 'owner', conversationIdentity: 'conversation', serverId: 'server-1', homeDir,
      auditRunner: { identity: 'isolated-audit', async audit(envelope: CapabilityAuditEnvelope) {
        return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest,
          scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      } },
    };
    const service = createDefaultCapabilityService(options);
    const capabilityId = 'multi-binding-mcp';
    const commit = async (input: { versionId: string; bindingId: string; revision: number; url: string }) => {
      const admitted = await service.install({
        kind: CAPABILITY_KIND.MCP,
        source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: {
          name: 'multi-binding-mcp', transport: 'streamable-http', url: input.url,
        } },
        scope: CAPABILITY_SCOPE.LOCAL, idempotencyKey: `install-${input.versionId}-${input.bindingId}`,
      });
      if (admitted.status !== 'ok') throw new Error('MCP admission failed');
      const installing = service.confirm({ operationId: admitted.operation.id, revision: admitted.operation.revision,
        artifactDigest: admitted.operation.artifactDigest!, auditDigest: admitted.operation.auditDigest!, decision: 'install' });
      if (installing.status !== 'ok') throw new Error('MCP confirmation failed');
      const binding = { id: input.bindingId, capabilityId, versionId: input.versionId,
        scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: [], machines: [], active: true } as const;
      const committed = service.commitAuthorized({
        operationId: installing.operation.id,
        capability: { id: capabilityId, revision: input.revision, kind: CAPABILITY_KIND.MCP,
          name: 'multi-binding-mcp', state: CAPABILITY_STATE.PENDING, scope: CAPABILITY_SCOPE.LOCAL,
          versionId: input.versionId, version: input.revision / 10,
          artifactDigest: installing.operation.artifactDigest, sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
          readiness: CAPABILITY_READINESS.RUNTIME_PENDING, findings: [], bindings: [binding], updatedAt: Date.now() },
        versionId: input.versionId, binding,
      });
      expect(committed?.operation).toMatchObject({ state: 'installed' });
    };

    await commit({ versionId: 'mcp-v1', bindingId: 'binding-a', revision: 10, url: 'https://mcp.example/v1' });
    await commit({ versionId: 'mcp-v2', bindingId: 'binding-b', revision: 20, url: 'https://mcp.example/v2' });
    await commit({ versionId: 'mcp-v3', bindingId: 'binding-a', revision: 30, url: 'https://mcp.example/v3' });
    expect(service.status({ capabilityId })).toMatchObject({ status: 'ok', capability: { bindings: expect.arrayContaining([
      expect.objectContaining({ id: 'binding-a', versionId: 'mcp-v3' }),
      expect.objectContaining({ id: 'binding-b', versionId: 'mcp-v2' }),
    ]) } });

    const restarted = createDefaultCapabilityService(options);
    expect(restarted.manageExactLocalMcp({ serverId: 'server-1', capabilityId, bindingId: 'binding-a',
      action: 'rollback', expectedRevision: 30, finalAuthorityRevision: 31, versionId: 'mcp-v1' }))
      .toMatchObject({ ok: true, capability: { bindings: expect.arrayContaining([
        expect.objectContaining({ id: 'binding-a', versionId: 'mcp-v1' }),
        expect.objectContaining({ id: 'binding-b', versionId: 'mcp-v2' }),
      ]) } });
    const restartedAgain = createDefaultCapabilityService(options);
    expect(restartedAgain.status({ capabilityId })).toMatchObject({ status: 'ok', capability: {
      revision: 31,
      bindings: expect.arrayContaining([
        expect.objectContaining({ id: 'binding-a', versionId: 'mcp-v1' }),
        expect.objectContaining({ id: 'binding-b', versionId: 'mcp-v2' }),
      ]),
    } });
  });
});
