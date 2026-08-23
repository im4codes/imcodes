import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  type CapabilityOperationActivateFrame,
  type CapabilityOperationAuthorizeFrame,
  type CapabilityOperationCommitResultFrame,
  type CapabilityOperationInstallFrame,
  type CapabilityOperationManageResultFrame,
  type CapabilityOperationProgressFrame,
} from '../../shared/capability-management.js';
import { CapabilityOperationHandler } from '../../src/capability/capability-operation-handler.js';
import { CapabilityOperationJournal } from '../../src/capability/capability-operation-journal.js';
import { createDefaultCapabilityService } from '../../src/capability/capability-service-adapter.js';
import { publishManagedSkillVersion, readManagedSkillIndex, updateManagedSkillEntry } from '../../src/capability/managed-skill-store.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import type { CapabilityAuditEnvelope } from '../../src/capability/capability-audit.js';
import { resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { getManagedSkillTrashRoot } from '../../src/capability/managed-skill-paths.js';
import { CAPABILITY_AUTHORIZATION_TESTING, setCapabilityAuthority } from '../../src/capability/capability-authorization.js';
import { authorizedManagedBindings, signedSyncBinding, TEST_CAPABILITY_AUTHORIZATION_KEY } from './capability-authorization-fixture.js';

type SentFrame = CapabilityOperationProgressFrame | CapabilityOperationActivateFrame
  | CapabilityOperationCommitResultFrame | CapabilityOperationManageResultFrame;

function authorizeSkill(activation: CapabilityOperationActivateFrame, capabilityId = 'authority-skill', versionId = 'authority-version'): CapabilityOperationAuthorizeFrame {
  const version = { ...activation.version, id: versionId, capabilityId };
  const binding = signedSyncBinding({
    ownerId: 'owner-1', capabilityId, version,
    binding: { ...activation.binding, id: 'authority-binding', capabilityId, versionId },
    issuedRevision: 7,
  });
  return {
    type: CAPABILITY_OPERATION_MSG.AUTHORIZE,
    operationId: activation.operationId,
    expectedRevision: 7,
    capability: { ...activation.capability, id: capabilityId, revision: 7, versionId, state: 'pending', bindings: [binding] },
    version,
    binding,
    authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    expiresAt: Date.now() + 60_000,
  };
}

function installFrame(ownerId = 'owner-1'): CapabilityOperationInstallFrame {
  return {
    type: CAPABILITY_OPERATION_MSG.INSTALL,
    operationId: 'external-operation-1',
    revision: 1,
    ownerId,
    request: {
      kind: CAPABILITY_KIND.SKILL,
      source: {
        kind: CAPABILITY_SOURCE_KIND.INLINE,
        inlineFiles: { 'SKILL.md': '---\nname: handler-skill\ndescription: Handler Skill.\n---\nSafe body.\n' },
      },
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providers: ['codex-sdk'],
      machines: ['server-1'],
      idempotencyKey: 'handler-install',
    },
  };
}

describe('daemon capability operation frames', () => {
  let homeDir: string | undefined;
  afterEach(async () => {
    CAPABILITY_AUTHORIZATION_TESTING.clearAll();
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  it('maps external operations, reports reviewed progress, and activates only after matching confirmation', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-home-'));
    const sent: SentFrame[] = [];
    const upload = vi.fn(async () => undefined);
    const onBlobUploadFailure = vi.fn();
    const factory = vi.fn((ownerId: string) => createDefaultCapabilityService({
      ownerId,
      conversationIdentity: 'installing-conversation',
      homeDir,
      auditRunner: {
        identity: 'isolated-auditor',
        async audit(envelope: CapabilityAuditEnvelope) {
          return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
        },
      },
    }));
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: factory,
      send: (frame) => { sent.push(frame); },
      blobClient: { upload },
      onBlobUploadFailure,
    });
    expect(await handler.handle(installFrame())).toBe(true);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'awaiting_confirmation' }));
    expect(sent.map((frame) => 'state' in frame ? frame.state : 'activate')).toEqual([
      'acquiring', 'scanning', 'auditing', 'awaiting_confirmation',
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'external-operation-1',
      expectedRevision: 4,
      state: 'awaiting_confirmation',
      auditVerdict: 'PASS',
    });
    const progress = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM,
      operationId: 'external-operation-1',
      expectedRevision: 6,
      decision: 'install',
      artifactDigest: progress.artifactDigest!,
      auditDigest: progress.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providers: ['codex-sdk'],
      machines: ['server-1'],
    });
    expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      operationId: 'external-operation-1',
      expectedRevision: 6,
      capability: { kind: CAPABILITY_KIND.SKILL, state: 'pending', name: 'handler-skill' },
      version: {
        auditVerdict: 'PASS', artifactDigest: progress.artifactDigest,
        blobDigest: expect.stringMatching(/^[a-f0-9]{64}$/), blobByteSize: expect.any(Number),
      },
      binding: { scope: CAPABILITY_SCOPE.ACCOUNT, active: true },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    const activated = sent.at(-1) as CapabilityOperationActivateFrame;
    const blobFrame = {
      type: CAPABILITY_SYNC_MSG.BLOB_CAPABILITY,
      operationId: 'external-operation-1',
      access: {
        action: CAPABILITY_BLOB_ACTION.UPLOAD,
        capabilityId: activated.capability.id,
        versionId: activated.version.id,
        blobDigest: activated.version.blobDigest!,
        maxBytes: activated.version.blobByteSize!,
        expiresAt: Date.now() + 60_000,
        singleUseToken: 'grant-1',
      },
    } as const;
    await handler.handle(blobFrame);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toEqual(blobFrame.access);
    expect(createHash('sha256').update(upload.mock.calls[0]?.[1] as Buffer).digest('hex')).toBe(blobFrame.access.blobDigest);
    await handler.handle(blobFrame);
    expect(upload).toHaveBeenCalledTimes(1);
    const authorization = authorizeSkill(activated);
    // Duplicate AUTHORIZE delivery may arrive concurrently after a reconnect.
    // It must serialize into one publication and replay the same durable result;
    // a losing publication attempt must never remove the winner's package.
    await Promise.all([
      handler.handle(authorization),
      handler.handle(structuredClone(authorization)),
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
      operationId: activated.operationId,
      capabilityId: 'authority-skill',
      versionId: 'authority-version',
      bindingId: 'authority-binding',
      ok: true,
    });
    expect(readManagedSkillIndex(homeDir).entries.find((entry) => entry.registryId === 'authority-skill'))
      .toMatchObject({ activeVersionId: 'authority-version' });
    await handler.handle(authorization);
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);

    await handler.handle({
      ...blobFrame,
      operationId: 'unknown-operation',
      access: { ...blobFrame.access, singleUseToken: 'grant-2' },
    });
    expect(onBlobUploadFailure).toHaveBeenLastCalledWith(expect.objectContaining({
      readiness: 'content_missing', errorCode: CAPABILITY_ERROR.NOT_FOUND,
    }));
    await handler.handle({
      ...blobFrame,
      access: { ...blobFrame.access, blobDigest: '0'.repeat(64), singleUseToken: 'grant-3' },
    });
    expect(onBlobUploadFailure).toHaveBeenLastCalledWith(expect.objectContaining({
      readiness: 'content_missing', errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
    }));
    expect(upload).toHaveBeenCalledTimes(1);
    // A retry uses the owner-bound cached operation and replays authoritative state.
    await handler.handle(installFrame());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('fails closed to REWORK when the isolated auditor is unavailable', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-home-'));
    const send = vi.fn();
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId, conversationIdentity: 'conversation', homeDir,
        auditRunner: { identity: 'isolated-unavailable', async audit() { throw new Error('offline'); } },
      }),
      send,
    });
    await handler.handle(installFrame());
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'rework' })));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      state: 'rework',
      errorCode: CAPABILITY_ERROR.AUDIT_REWORK,
    }));
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('auditVerdict', 'PASS');
  });

  it('persists only recovery evidence and never free-form install request prose', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-journal-redaction-'));
    const service = createDefaultCapabilityService({
      ownerId: 'owner-1', conversationIdentity: 'journal-redaction', homeDir,
      auditRunner: { identity: 'journal-redaction-auditor', async audit(envelope) {
        return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest,
          scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      } },
    });
    const handler = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: () => service, send: () => undefined,
    });
    const frame = installFrame();
    frame.request.idempotencyKey = 'secret-idempotency-sentinel';
    frame.request.userIntent = 'secret-user-intent-sentinel';
    frame.request.source = { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: {
      'SKILL.md': '---\nname: handler-skill\ndescription: Safe Skill.\n---\nsecret-inline-sentinel\n',
    } };
    await handler.handle(frame);
    await vi.waitFor(() => expect(new CapabilityOperationJournal('server-1', homeDir).candidates()).toHaveLength(1));
    const journalFile = join(homeDir, '.imcodes', 'capability-operations', `${createHash('sha256').update('server-1').digest('hex')}.json`);
    const raw = await readFile(journalFile, 'utf8');
    expect(raw).not.toContain('secret-user-intent-sentinel');
    expect(raw).not.toContain('secret-idempotency-sentinel');
    expect(raw).not.toContain('secret-inline-sentinel');
  });

  it('bounds durable candidates, expires abandoned review state, and preserves an active proposal', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-candidate-cap-'));
    let now = 1_000_000;
    const sent: SentFrame[] = [];
    const auditRunner = {
      identity: 'candidate-cap-auditor',
      audit: vi.fn(async (envelope: CapabilityAuditEnvelope) => {
        return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      }),
    };
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId,
        conversationIdentity: `candidate-cap-${ownerId}`,
        homeDir,
        auditRunner,
      }),
      send: (frame) => { sent.push(frame); },
      now: () => now,
    });

    for (let index = 0; index < CAPABILITY_LIMITS.PERSISTED_CANDIDATES; index += 1) {
      const frame = installFrame(`owner-${index}`);
      frame.operationId = `candidate-${index}`;
      frame.request.idempotencyKey = `candidate-${index}`;
      await handler.handle(frame);
      await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
        operationId: frame.operationId,
        state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      })));
    }
    const overflow = installFrame('owner-overflow');
    overflow.operationId = 'candidate-overflow';
    overflow.request.idempotencyKey = 'candidate-overflow';
    await handler.handle(overflow);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      operationId: overflow.operationId,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      errorCode: CAPABILITY_ERROR.RATE_LIMITED,
    })));
    expect(new CapabilityOperationJournal('server-1', homeDir).candidates())
      .toHaveLength(CAPABILITY_LIMITS.PERSISTED_CANDIDATES);

    // Advance one reviewed candidate into the durable activation outbox. Its
    // independent proposal expiry is later than the remaining review TTLs.
    now += Math.floor(CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS / 2);
    const reviewed = sent.findLast((frame) => 'state' in frame
      && frame.operationId === 'candidate-0'
      && frame.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM,
      operationId: 'candidate-0', expectedRevision: 6, decision: 'install',
      artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.ACTIVATE, operationId: 'candidate-0' });

    now = 1_000_000 + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS + 1;
    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', now: () => now,
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId, conversationIdentity: `candidate-restart-${ownerId}`, homeDir, auditRunner,
      }),
      send: (frame) => { replayed.push(frame); },
    });
    const auditCallsBeforeRestart = auditRunner.audit.mock.calls.length;
    await restarted.replayPending();
    expect(auditRunner.audit).toHaveBeenCalledTimes(auditCallsBeforeRestart);
    expect(replayed.filter((frame) => 'state' in frame
      && frame.state === CAPABILITY_INSTALL_STATE.FAILED
      && frame.errorCode === CAPABILITY_ERROR.CONFIRMATION_STALE)).toHaveLength(
      CAPABILITY_LIMITS.PERSISTED_CANDIDATES - 1,
    );
    expect(replayed).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.ACTIVATE, operationId: 'candidate-0',
    }));
    expect(new CapabilityOperationJournal('server-1', homeDir).candidates().map((entry) => entry.operationId))
      .toEqual(['candidate-0']);

    const afterExpiry = installFrame('owner-after-expiry');
    afterExpiry.operationId = 'candidate-after-expiry';
    afterExpiry.request.idempotencyKey = 'candidate-after-expiry';
    await restarted.handle(afterExpiry);
    await vi.waitFor(() => expect(replayed).toContainEqual(expect.objectContaining({
      operationId: afterExpiry.operationId,
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
    })));
    expect(replayed).not.toContainEqual(expect.objectContaining({
      operationId: afterExpiry.operationId,
      errorCode: CAPABILITY_ERROR.RATE_LIMITED,
    }));
  });

  it('expires every confirmed activation locally and frees the same-process active-job capacity', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-activation-cap-'));
    let now = 2_000_000;
    const sent: SentFrame[] = [];
    const service = createDefaultCapabilityService({
      ownerId: 'owner-1', conversationIdentity: 'activation-cap', homeDir,
      auditRunner: { identity: 'activation-cap-auditor', async audit(envelope: CapabilityAuditEnvelope) {
        return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      } },
    });
    const handler = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', now: () => now,
      serviceForOwner: () => service,
      send: (frame) => { sent.push(frame); },
    });
    for (let index = 0; index < CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS; index += 1) {
      const frame = installFrame();
      frame.operationId = `confirmed-${index}`;
      frame.request.idempotencyKey = `confirmed-${index}`;
      frame.request.source = {
        kind: CAPABILITY_SOURCE_KIND.INLINE,
        inlineFiles: { 'SKILL.md': `---\nname: confirmed-${index}\ndescription: Confirmed candidate ${index}.\n---\nSafe.\n` },
      };
      await handler.handle(frame);
      await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
        operationId: frame.operationId, state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      })));
      const reviewed = sent.findLast((item) => 'state' in item && item.operationId === frame.operationId
        && item.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) as CapabilityOperationProgressFrame;
      await handler.handle({
        type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: frame.operationId, expectedRevision: 6,
        decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
        scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
      });
      expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.ACTIVATE, operationId: frame.operationId });
    }
    const overflow = installFrame();
    overflow.operationId = 'confirmed-overflow';
    overflow.request.idempotencyKey = 'confirmed-overflow';
    await handler.handle(overflow);
    expect(sent).toContainEqual(expect.objectContaining({
      operationId: overflow.operationId, state: CAPABILITY_INSTALL_STATE.FAILED, errorCode: CAPABILITY_ERROR.RATE_LIMITED,
    }));

    now += CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS + 1;
    // The lifecycle invokes this sweep while the socket stays online; no
    // reconnect/replay is required to release abandoned ACTIVATE proposals.
    await handler.cleanupExpiredCandidates();
    expect(sent.filter((item) => 'state' in item && item.state === CAPABILITY_INSTALL_STATE.FAILED
      && item.errorCode === CAPABILITY_ERROR.CONFIRMATION_STALE)).toHaveLength(CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS);
    const afterExpiry = installFrame();
    afterExpiry.operationId = 'confirmed-after-expiry';
    afterExpiry.request.idempotencyKey = 'confirmed-after-expiry';
    await handler.handle(afterExpiry);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      operationId: afterExpiry.operationId, state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
    })));
  });

  it('evicts retained terminal external operations at the shared bound', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-terminal-cap-'));
    const sent: SentFrame[] = [];
    const factory = vi.fn((ownerId: string) => createDefaultCapabilityService({
      ownerId,
      conversationIdentity: `terminal-cap-${ownerId}`,
      homeDir,
      auditRunner: { identity: 'terminal-cap-auditor', async audit() { throw new Error('unavailable'); } },
    }));
    const handler = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: factory,
      send: (frame) => { sent.push(frame); },
    });
    const count = CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS + 1;
    for (let index = 0; index < count; index += 1) {
      const frame = installFrame(`terminal-owner-${index}`);
      frame.operationId = `terminal-${index}`;
      frame.request.idempotencyKey = `terminal-${index}`;
      await handler.handle(frame);
    }
    await vi.waitFor(() => expect(sent.filter((frame) => 'state' in frame
      && frame.state === CAPABILITY_INSTALL_STATE.REWORK)).toHaveLength(count));
    const retained = (handler as unknown as { operations: Map<string, unknown> }).operations;
    expect(retained.size).toBe(CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS);
    expect(retained.has('terminal-0')).toBe(false);
    expect(retained.has(`terminal-${count - 1}`)).toBe(true);
  });

  it('fails tampered persisted evidence without rerunning AI or leaking active capacity', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-restore-failure-'));
    const audit = vi.fn(async (envelope: CapabilityAuditEnvelope) => ({
      verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest,
      scannerDigest: envelope.scannerDigest, findings: [], model: 'first-audit',
    }));
    const auditRunner = { identity: 'restore-failure-auditor', audit };
    const firstService = createDefaultCapabilityService({ ownerId: 'owner-1', conversationIdentity: 'first', homeDir, auditRunner });
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: () => firstService, send: () => undefined,
    });
    for (let index = 0; index < CAPABILITY_LIMITS.PERSISTED_CANDIDATES; index += 1) {
      const frame = installFrame();
      frame.operationId = `tampered-${index}`;
      frame.request.idempotencyKey = `tampered-${index}`;
      await first.handle(frame);
    }
    await vi.waitFor(() => expect(new CapabilityOperationJournal('server-1', homeDir).candidates())
      .toHaveLength(CAPABILITY_LIMITS.PERSISTED_CANDIDATES));
    const callsBeforeRestart = audit.mock.calls.length;
    const journalFile = join(homeDir, '.imcodes', 'capability-operations', `${createHash('sha256').update('server-1').digest('hex')}.json`);
    const state = JSON.parse(await readFile(journalFile, 'utf8')) as { candidates: Array<{ reviewedEvidence?: { audit?: { auditDigest?: string } } }> };
    for (const candidate of state.candidates) {
      if (candidate.reviewedEvidence?.audit) candidate.reviewedEvidence.audit.auditDigest = '0'.repeat(64);
    }
    await writeFile(journalFile, JSON.stringify(state), 'utf8');

    const sent: SentFrame[] = [];
    const restoredService = createDefaultCapabilityService({ ownerId: 'owner-1', conversationIdentity: 'restart', homeDir, auditRunner });
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: () => restoredService,
      send: (frame) => { sent.push(frame); },
    });
    await restarted.replayPending();
    expect(audit).toHaveBeenCalledTimes(callsBeforeRestart);
    expect(new CapabilityOperationJournal('server-1', homeDir).candidates()).toHaveLength(0);
    const fresh = installFrame();
    fresh.operationId = 'after-restore-failure';
    fresh.request.idempotencyKey = 'after-restore-failure';
    await restarted.handle(fresh);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      operationId: fresh.operationId, state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
    })));
  });

  it('admits a non-secret MCP definition and activates it as runtime_pending without executing stdio', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-home-'));
    const sent: SentFrame[] = [];
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId, conversationIdentity: 'conversation', homeDir,
        auditRunner: {
          identity: 'isolated-auditor',
          async audit(envelope) {
            return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
          },
        },
      }),
      send: (frame) => { sent.push(frame); },
    });
    const frame = installFrame();
    frame.operationId = 'external-mcp-operation';
    frame.request = {
      capabilityId: 'existing-mcp-authority-item',
      bindingId: 'existing-mcp-authority-binding',
      kind: CAPABILITY_KIND.MCP,
      displayName: 'safe-mcp',
      source: {
        kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        mcpConfig: {
          transport: 'stdio', name: 'safe-mcp', command: 'safe-command', args: ['--stdio'],
          toolAllowlist: ['safe_tool'],
        },
      },
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providers: ['codex-sdk'], machines: ['server-1'], idempotencyKey: 'mcp-install',
    };
    await handler.handle(frame);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({
      state: 'awaiting_confirmation',
      sourceLabel: 'stdio:safe-command',
      tools: ['safe_tool'],
      permissions: ['process:stdio'],
      updateDiff: [
        'target_capability:existing-mcp-authority-item',
        'target_binding:existing-mcp-authority-binding',
        expect.stringMatching(/^artifact:previous_unavailable->[a-f0-9]{64}$/),
      ],
      hasExecutables: true,
      stdioCommand: ['safe-command', '--stdio'],
    }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM,
      operationId: frame.operationId,
      expectedRevision: 6,
      decision: 'install',
      artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      capability: {
        id: 'existing-mcp-authority-item',
        kind: CAPABILITY_KIND.MCP,
        state: 'pending', readiness: 'runtime_pending',
        sourceLabel: 'stdio:safe-command',
        tools: ['safe_tool'],
        permissions: ['process:stdio'],
        hasExecutables: true,
        stdioCommand: ['safe-command', '--stdio'],
      },
      version: { capabilityId: 'existing-mcp-authority-item' },
      binding: { capabilityId: 'existing-mcp-authority-item' },
      definition: {
        transport: 'stdio', command: 'safe-command', args: ['--stdio'],
        toolAllowlist: ['safe_tool'],
      },
    });
    const activation = sent.at(-1) as CapabilityOperationActivateFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.AUTHORIZE,
      operationId: activation.operationId,
      expectedRevision: 7,
      capability: { ...activation.capability, state: 'pending' },
      version: activation.version,
      binding: activation.binding,
      authorizationKeys: [],
      expiresAt: Date.now() + 60_000,
    });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
  });

  it('carries an exact update target through ACTIVATE after rescanning and re-auditing changed bytes', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-update-'));
    const auditArtifacts: string[] = [];
    const sent: SentFrame[] = [];
    const service = createDefaultCapabilityService({
      ownerId: 'owner-1', conversationIdentity: 'conversation', homeDir,
      auditRunner: {
        identity: 'isolated-auditor',
        async audit(envelope) {
          auditArtifacts.push(envelope.artifactDigest);
          return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
        },
      },
    });
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: () => service,
      send: (frame) => { sent.push(frame); },
    });
    await handler.handle(installFrame());
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'awaiting_confirmation' }));
    const firstReview = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: 'external-operation-1', expectedRevision: 6,
      decision: 'install', artifactDigest: firstReview.artifactDigest!, auditDigest: firstReview.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    const firstActivation = sent.at(-1) as CapabilityOperationActivateFrame;
    await handler.handle(authorizeSkill(firstActivation, 'existing-authority-item', 'authority-version-1'));
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });

    const update = installFrame();
    update.operationId = 'external-update-operation';
    update.request = {
      ...update.request,
      capabilityId: 'existing-authority-item',
      bindingId: 'authority-binding',
      idempotencyKey: 'handler-update',
      source: {
        kind: CAPABILITY_SOURCE_KIND.INLINE,
        inlineFiles: { 'SKILL.md': '---\nname: handler-skill\ndescription: Handler Skill updated.\nallowed-tools: Read Write\n---\nChanged audited body.\n' },
      },
    };
    await handler.handle(update);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: update.operationId,
      state: 'awaiting_confirmation',
    }));
    const updateReview = sent.at(-1) as CapabilityOperationProgressFrame;
    expect(updateReview.artifactDigest).not.toBe(firstReview.artifactDigest);
    expect(auditArtifacts).toEqual([firstReview.artifactDigest, updateReview.artifactDigest]);
    expect(updateReview).toMatchObject({
      sourceLabel: 'inline-package',
      tools: [],
      permissions: ['Read', 'Write'],
      updateDiff: [
        'target_capability:existing-authority-item',
        'target_binding:authority-binding',
        `artifact:${firstReview.artifactDigest}->${updateReview.artifactDigest}`,
        'permission_added:Read',
        'permission_added:Write',
      ],
    });
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: update.operationId, expectedRevision: 6,
      decision: 'install', artifactDigest: updateReview.artifactDigest!, auditDigest: updateReview.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    const updateActivation = sent.at(-1) as CapabilityOperationActivateFrame;
    expect(updateActivation).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      capability: { id: 'existing-authority-item', kind: CAPABILITY_KIND.SKILL },
      version: { capabilityId: 'existing-authority-item', artifactDigest: updateReview.artifactDigest },
      binding: { capabilityId: 'existing-authority-item' },
    });
    await handler.handle(authorizeSkill(updateActivation, 'existing-authority-item', 'authority-version-2'));
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    const index = readManagedSkillIndex(homeDir);
    expect(index.entries.find((entry) => entry.registryId === 'existing-authority-item')).toMatchObject({
      activeVersionId: 'authority-version-2',
      versions: ['authority-version-1', 'authority-version-2'],
    });
    expect(index.entries).toHaveLength(1);
  });

  it('cancels while the auditor is pending, aborts it, and never later confirms or activates', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-home-'));
    const sent: Array<CapabilityOperationProgressFrame | CapabilityOperationActivateFrame> = [];
    let markAuditStarted!: () => void;
    const auditStarted = new Promise<void>((resolve) => { markAuditStarted = resolve; });
    let auditSignal: AbortSignal | undefined;
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId,
        conversationIdentity: 'conversation',
        homeDir,
        auditRunner: {
          identity: 'isolated-auditor',
          async audit(_envelope, options) {
            auditSignal = options?.signal;
            markAuditStarted();
            return await new Promise((_resolve, reject) => {
              if (auditSignal?.aborted) reject(auditSignal.reason);
              else auditSignal?.addEventListener('abort', () => reject(auditSignal?.reason), { once: true });
            });
          },
        },
      }),
      send: (frame) => { sent.push(frame); },
    });
    await handler.handle(installFrame());
    await auditStarted;
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'auditing' }));
    const cancel = {
      type: CAPABILITY_OPERATION_MSG.CANCEL,
      operationId: 'external-operation-1',
      expectedRevision: 5,
    } as const;
    await handler.handle(cancel);
    expect(sent.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'external-operation-1',
      expectedRevision: 5,
      state: 'cancelled',
    });
    expect(auditSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.some((frame) => frame.type === CAPABILITY_OPERATION_MSG.ACTIVATE)).toBe(false);
    expect(sent.some((frame) => 'state' in frame && frame.state === 'awaiting_confirmation')).toBe(false);
    await handler.handle(cancel);
    expect(sent.at(-1)).toMatchObject({ state: 'cancelled' });
  });

  it('rejects cancellation after INSTALLING and applies exact local management only after signed authorization', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-local-manage-'));
    const sent: SentFrame[] = [];
    const service = createDefaultCapabilityService({
      ownerId: 'owner-1', conversationIdentity: 'conversation', homeDir,
      auditRunner: { identity: 'isolated-auditor', async audit(envelope) {
        return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
      } },
    });
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true, serverId: 'server-1', serviceForOwner: (ownerId) => ownerId === 'owner-1' ? service : createDefaultCapabilityService({
        ownerId, conversationIdentity: 'other-owner', homeDir,
        auditRunner: { identity: 'unused', async audit() { throw new Error('unused'); } },
      }),
      send: (frame) => { sent.push(frame); },
    });
    const install = installFrame();
    install.request = { ...install.request, scope: CAPABILITY_SCOPE.LOCAL, scopeId: undefined, machines: [] };
    await handler.handle(install);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'awaiting_confirmation' }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: install.operationId, expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.LOCAL, providers: ['codex-sdk'], machines: [],
    });
    const activation = sent.at(-1) as CapabilityOperationActivateFrame;
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
    await handler.handle({ type: CAPABILITY_OPERATION_MSG.CANCEL, operationId: install.operationId, expectedRevision: 7 });
    expect(sent.at(-1)).toMatchObject({ state: 'installing', errorCode: CAPABILITY_ERROR.CONFLICT });
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);

    const authorize = authorizeSkill(activation, 'local-authority', 'local-version');
    await handler.handle(authorize);
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    const committed = sent.at(-1) as CapabilityOperationCommitResultFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK,
      operationId: committed.operationId,
      capabilityId: committed.capabilityId,
      versionId: committed.versionId,
      bindingId: committed.bindingId,
      authorityRevision: committed.authorityRevision,
    });
    expect(setCapabilityAuthority('owner-1', 'server-1', 7, [{
      capabilityId: 'local-authority', versionId: 'local-version', bindingId: authorize.binding.id,
      state: authorize.binding.authorization!.bindingState,
      itemRevision: authorize.binding.authorization!.itemRevision,
      bindingRevision: authorize.binding.authorization!.bindingRevision,
      authorization: authorize.binding.authorization,
    }], [TEST_CAPABILITY_AUTHORIZATION_KEY])).toBe(true);
    const resolver = () => resolveSkillByKey({
      namespace: { scope: 'personal' as const, userId: 'owner-1' }, homeDir,
      serverId: 'server-1', providerId: 'codex-sdk', key: 'managed/handler-skill',
    });
    expect(resolver()).toMatchObject({ ok: true });

    const manage = async (action: 'disable' | 'enable' | 'uninstall' | 'restore', expectedRevision: number) => {
      const authorityRevision = expectedRevision + 1;
      const active = action === 'enable' || action === 'restore';
      const signed = signedSyncBinding({
        ownerId: 'owner-1', capabilityId: 'local-authority', version: authorize.version,
        issuedRevision: authorityRevision,
        bindingState: action === 'uninstall' ? 'removed' : active ? 'active' : 'disabled',
        binding: { ...authorize.binding, active, authorization: undefined },
      });
      const frame = {
        type: CAPABILITY_OPERATION_MSG.MANAGE,
        requestId: `manage-${action}`, ownerId: 'owner-1', serverId: 'server-1',
        capabilityId: 'local-authority', bindingId: 'authority-binding', action, expectedRevision,
        authorityRevision, authorization: signed.authorization,
      } as const;
      await handler.handle({ ...frame, phase: 'prepare' });
      expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT, phase: 'prepared', action, ok: true });
      await handler.handle({ ...frame, phase: 'commit' });
      expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT, phase: 'applied', action, ok: true });
      await handler.handle({
        type: CAPABILITY_OPERATION_MSG.MANAGE_ACK,
        requestId: frame.requestId,
        capabilityId: frame.capabilityId,
        bindingId: frame.bindingId,
        authorityRevision,
      });
      expect(setCapabilityAuthority('owner-1', 'server-1', authorityRevision, [{
        capabilityId: frame.capabilityId, versionId: signed.versionId, bindingId: signed.id,
        state: signed.authorization!.bindingState,
        itemRevision: signed.authorization!.itemRevision,
        bindingRevision: signed.authorization!.bindingRevision,
        authorization: signed.authorization,
      }], [TEST_CAPABILITY_AUTHORIZATION_KEY])).toBe(true);
    };
    await manage('disable', 7);
    expect(resolver()).toMatchObject({ ok: false });
    await manage('enable', 8);
    expect(resolver()).toMatchObject({ ok: true });
    await manage('uninstall', 9);
    expect(resolver()).toMatchObject({ ok: false });
    await manage('restore', 10);
    expect(resolver()).toMatchObject({ ok: true });

    const v2Source = await mkdtemp(join(tmpdir(), 'imcodes-operation-local-v2-'));
    await writeFile(join(v2Source, 'SKILL.md'), '---\nname: handler-skill\ndescription: Handler Skill v2.\n---\nVersion two.\n');
    const v2Inventory = inventoryAgentSkillPackage(v2Source);
    const v2Scan = scanAgentSkillPackage(v2Inventory);
    publishManagedSkillVersion({
      registryId: 'local-authority', versionId: 'local-version-2', quarantinePath: v2Source,
      source: 'test-update', scannerDigest: v2Scan.scannerDigest, auditDigest: 'audit-v2', auditPolicyVersion: 'test',
      bindings: authorizedManagedBindings({
        ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'local-authority',
        versionId: 'local-version-2', artifactDigest: v2Inventory.treeDigest, auditDigest: 'audit-v2',
        issuedRevision: 20,
        bindings: [{ scope: CAPABILITY_SCOPE.LOCAL, ownerId: 'owner-1', serverId: 'server-1',
          bindingId: 'authority-binding', providers: ['codex-sdk'], machines: [] }],
      }),
    }, homeDir);
    updateManagedSkillEntry('local-authority', (entry) => ({ ...entry, authorityRevision: 20 }), homeDir);
    expect(resolveSkillByKey({
      namespace: { scope: 'personal' as const, userId: 'owner-1' }, homeDir,
      serverId: 'server-1', providerId: 'codex-sdk', key: 'managed/handler-skill',
    })).toMatchObject({ ok: true, versionId: 'local-version-2' });
    const rollbackAuthorization = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'local-authority', version: authorize.version, issuedRevision: 21,
      binding: { ...authorize.binding, active: true, authorization: undefined },
    }).authorization!;
    const rollbackFrame = {
      type: CAPABILITY_OPERATION_MSG.MANAGE,
      requestId: 'manage-rollback', ownerId: 'owner-1', serverId: 'server-1',
      capabilityId: 'local-authority', bindingId: 'authority-binding', action: 'rollback',
      expectedRevision: 20, authorityRevision: 21, versionId: 'local-version', authorization: rollbackAuthorization,
    } as const;
    await handler.handle({ ...rollbackFrame, phase: 'prepare' });
    await handler.handle({ ...rollbackFrame, phase: 'commit' });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT, phase: 'applied', action: 'rollback', ok: true, activeVersionId: 'local-version' });
    await handler.handle({ type: CAPABILITY_OPERATION_MSG.MANAGE_ACK, requestId: rollbackFrame.requestId,
      capabilityId: rollbackFrame.capabilityId, bindingId: rollbackFrame.bindingId, authorityRevision: 21 });
    expect(setCapabilityAuthority('owner-1', 'server-1', 21, [{
      capabilityId: rollbackFrame.capabilityId, versionId: rollbackAuthorization.versionId,
      bindingId: rollbackFrame.bindingId, state: rollbackAuthorization.bindingState,
      itemRevision: rollbackAuthorization.itemRevision, bindingRevision: rollbackAuthorization.bindingRevision,
      authorization: rollbackAuthorization,
    }], [TEST_CAPABILITY_AUTHORIZATION_KEY])).toBe(true);
    expect(resolver()).toMatchObject({ ok: true, versionId: 'local-version' });
    await rm(v2Source, { recursive: true, force: true });

    const abortAuthorization = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'local-authority', version: authorize.version,
      issuedRevision: 22, bindingState: 'disabled',
      binding: { ...authorize.binding, active: false, authorization: undefined },
    }).authorization!;
    const abortFrame = {
      type: CAPABILITY_OPERATION_MSG.MANAGE, requestId: 'manage-terminal-abort', ownerId: 'owner-1',
      serverId: 'server-1', capabilityId: 'local-authority', bindingId: 'authority-binding',
      action: 'disable', expectedRevision: 21, authorityRevision: 22, authorization: abortAuthorization,
    } as const;
    await handler.handle({ ...abortFrame, phase: 'prepare' });
    await handler.handle({ ...abortFrame, phase: 'abort' });
    expect(new CapabilityOperationJournal('server-1', homeDir).manages())
      .toEqual([expect.objectContaining({ result: expect.objectContaining({ phase: 'aborted', ok: true }) })]);
    const replayedAbort: SentFrame[] = [];
    const restartedAbort = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: () => createDefaultCapabilityService({
        ownerId: 'owner-1', serverId: 'server-1', conversationIdentity: 'abort-restart', homeDir,
        auditRunner: { identity: 'abort-restart-auditor', async audit() { throw new Error('unused'); } },
      }),
      send: (frame) => { replayedAbort.push(frame); },
    });
    await restartedAbort.replayPending();
    expect(replayedAbort).toContainEqual(expect.objectContaining({ requestId: abortFrame.requestId, phase: 'aborted', ok: true }));
    await restartedAbort.handle({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK, requestId: abortFrame.requestId,
      capabilityId: abortFrame.capabilityId, bindingId: abortFrame.bindingId, authorityRevision: 22,
    });
    expect(new CapabilityOperationJournal('server-1', homeDir).manages()).toEqual([]);

    const before = JSON.stringify(readManagedSkillIndex(homeDir));
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.MANAGE,
      phase: 'prepare', authorityRevision: 22,
      requestId: 'wrong-owner', ownerId: 'owner-2', serverId: 'server-1',
      capabilityId: 'local-authority', bindingId: 'authority-binding', action: 'disable', expectedRevision: 21,
    });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT, ok: false, errorCode: CAPABILITY_ERROR.NOT_FOUND });
    expect(JSON.stringify(readManagedSkillIndex(homeDir))).toBe(before);
  });

  it('persists commit outbox across delivery loss and rolls back only on authoritative abort', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-compensation-'));
    const sent: SentFrame[] = [];
    let failCommitDelivery = false;
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId, conversationIdentity: 'compensation', homeDir,
        auditRunner: { identity: 'isolated-auditor', async audit(envelope) {
          return { verdict: 'PASS', artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
        } },
      }),
      send: (frame) => {
        if (failCommitDelivery && frame.type === CAPABILITY_OPERATION_MSG.COMMIT_RESULT) throw new Error('link closed');
        sent.push(frame);
      },
    });
    await handler.handle(installFrame());
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'awaiting_confirmation' }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: 'external-operation-1', expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    const activation = sent.at(-1) as CapabilityOperationActivateFrame;
    const authorize = authorizeSkill(activation, 'compensated-authority', 'compensated-version');
    failCommitDelivery = true;
    await expect(handler.handle(authorize))
      .rejects.toThrow('link closed');
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);
    expect(resolveSkillByKey({ namespace: { scope: 'personal', userId: 'owner-1' }, homeDir,
      serverId: 'server-1', providerId: 'codex-sdk', key: 'managed/handler-skill' })).toMatchObject({ ok: false });
    failCommitDelivery = false;
    const replayed: SentFrame[] = [];
    const restartService = createDefaultCapabilityService({ ownerId: 'owner-1', conversationIdentity: 'restart', homeDir,
      auditRunner: { identity: 'unused', async audit() { throw new Error('unused'); } } });
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: () => restartService,
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.handle({ ...authorize, capability: { ...authorize.capability, id: 'mismatched-authority' } });
    expect(replayed.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: false, errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
    });
    await restarted.handle(authorize);
    expect(replayed.at(-1)).toMatchObject({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true, capabilityId: 'compensated-authority',
    });
    await restarted.replayPending();
    const commit = replayed.at(-1) as CapabilityOperationCommitResultFrame;
    expect(commit).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    const originalRollback = restartService.rollbackAuthorizedState.bind(restartService);
    const rollback = vi.spyOn(restartService, 'rollbackAuthorizedState')
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error('filesystem temporarily unavailable'); });
    await restarted.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ABORT,
      operationId: commit.operationId,
      capabilityId: commit.capabilityId,
      versionId: commit.versionId,
      bindingId: commit.bindingId,
      authorityRevision: commit.authorityRevision,
      errorCode: CAPABILITY_ERROR.CONFLICT,
    });
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);
    await restarted.replayPending();
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);
    rollback.mockRestore();
    const afterFailure = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: () => restartService,
      send: (frame) => { replayed.push(frame); },
    });
    // A fresh process/service can retry the durable abort and clear only after
    // exact compensation succeeds.
    expect(originalRollback).toBeTypeOf('function');
    await afterFailure.replayPending();
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
  });

  it('restores a reviewed candidate after daemon restart without publishing it early', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-candidate-restart-'));
    const auditRunner = { identity: 'restart-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const firstSent: SentFrame[] = [];
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'first', homeDir, auditRunner }),
      send: (frame) => { firstSent.push(frame); },
    });
    await first.handle(installFrame());
    await vi.waitFor(() => expect(firstSent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);

    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'second', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.replayPending();
    await vi.waitFor(() => expect(replayed.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    const reviewed = replayed.at(-1) as CapabilityOperationProgressFrame;
    await restarted.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: 'external-operation-1', expectedRevision: 20,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    expect(replayed.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.ACTIVATE });
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
  });

  it('durably replays an undelivered ACTIVATE after restart until AUTHORIZE and ACK complete it', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-activate-outbox-'));
    const auditRunner = { identity: 'activate-outbox-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const firstSent: SentFrame[] = [];
    let disconnectActivate = false;
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'first', homeDir, auditRunner }),
      send: (frame) => {
        if (disconnectActivate && frame.type === CAPABILITY_OPERATION_MSG.ACTIVATE) throw new Error('socket closed');
        firstSent.push(frame);
      },
    });
    await first.handle(installFrame());
    await vi.waitFor(() => expect(firstSent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    const reviewed = firstSent.at(-1) as CapabilityOperationProgressFrame;
    disconnectActivate = true;
    await expect(first.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: 'external-operation-1', expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    })).rejects.toThrow('socket closed');
    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);

    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'restart', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.replayPending();
    const activation = replayed.at(-1) as CapabilityOperationActivateFrame;
    expect(activation).toMatchObject({ type: CAPABILITY_OPERATION_MSG.ACTIVATE, operationId: 'external-operation-1' });
    await restarted.handle(authorizeSkill(activation, 'activate-authority', 'activate-version'));
    const commit = replayed.at(-1) as CapabilityOperationCommitResultFrame;
    expect(commit).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    await restarted.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK, operationId: commit.operationId,
      capabilityId: commit.capabilityId, versionId: commit.versionId,
      bindingId: commit.bindingId, authorityRevision: commit.authorityRevision,
    });
    const afterAck: SentFrame[] = [];
    const finalRestart = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'final', homeDir, auditRunner }),
      send: (frame) => { afterAck.push(frame); },
    });
    await finalRestart.replayPending();
    expect(afterAck).toEqual([]);
  });

  it('expires an abandoned durable ACTIVATE instead of replaying it forever', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-activate-expiry-'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const auditRunner = { identity: 'activate-expiry-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const sent: SentFrame[] = [];
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'first', homeDir, auditRunner }),
      send: (frame) => { sent.push(frame); },
    });
    await first.handle(installFrame());
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: 'external-operation-1', expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.ACTIVATE });
    now.mockReturnValue(25 * 60 * 60 * 1_000);
    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'restart', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.replayPending();
    expect(replayed).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'external-operation-1',
      state: CAPABILITY_INSTALL_STATE.FAILED,
      errorCode: CAPABILITY_ERROR.CONFIRMATION_STALE,
    }));
    now.mockRestore();
  });

  it('restores a durable Skill manage rollback after restart before accepting ABORT', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-skill-manage-restart-'));
    const auditRunner = { identity: 'manage-restart-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const sent: SentFrame[] = [];
    const service = createDefaultCapabilityService({ ownerId: 'owner-1', serverId: 'server-1', conversationIdentity: 'first', homeDir, auditRunner });
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: () => service,
      send: (frame) => { sent.push(frame); },
    });
    const install = installFrame();
    install.request = { ...install.request, scope: CAPABILITY_SCOPE.LOCAL, scopeId: undefined, machines: [] };
    await first.handle(install);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: install.operationId, expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.LOCAL, providers: ['codex-sdk'], machines: [],
    });
    const authorization = authorizeSkill(sent.at(-1) as CapabilityOperationActivateFrame, 'restart-skill', 'restart-skill-v1');
    await first.handle(authorization);
    const committed = sent.at(-1) as CapabilityOperationCommitResultFrame;
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK, operationId: committed.operationId,
      capabilityId: committed.capabilityId, versionId: committed.versionId,
      bindingId: committed.bindingId, authorityRevision: committed.authorityRevision,
    });
    const disabled = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'restart-skill', version: authorization.version,
      issuedRevision: 8, bindingState: 'disabled',
      binding: { ...authorization.binding, active: false, authorization: undefined },
    });
    const manage = {
      type: CAPABILITY_OPERATION_MSG.MANAGE, requestId: 'restart-skill-disable',
      ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'restart-skill',
      bindingId: 'authority-binding', action: 'disable', expectedRevision: 7,
      authorityRevision: 8, authorization: disabled.authorization,
    } as const;
    await first.handle({ ...manage, phase: 'prepare' });
    await first.handle({ ...manage, phase: 'commit' });
    expect(sent.at(-1)).toMatchObject({ phase: 'applied', ok: true });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: 'disabled', authorityRevision: 8 });

    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'restart', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.replayPending();
    expect(replayed.at(-1)).toMatchObject({ requestId: manage.requestId, phase: 'applied', ok: true });
    await restarted.handle({ ...manage, phase: 'abort' });
    expect(replayed.at(-1)).toMatchObject({ requestId: manage.requestId, phase: 'aborted', ok: true });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: 'active', authorityRevision: 7 });
    expect(readManagedSkillIndex(homeDir).entries[0]?.bindings[0]).toMatchObject({ active: true });

    const crashSent: SentFrame[] = [];
    const crashManage = { ...manage, requestId: 'restart-skill-disable-crash-gap' };
    const crashHandler = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'crash-gap', homeDir, auditRunner }),
      send: (frame) => { crashSent.push(frame); },
      afterManageMutation: () => { throw new Error('simulated crash after mutation'); },
    });
    await crashHandler.handle({ ...crashManage, phase: 'prepare' });
    await expect(crashHandler.handle({ ...crashManage, phase: 'commit' })).rejects.toThrow('simulated crash');
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: 'disabled', authorityRevision: 8 });
    const crashRestartSent: SentFrame[] = [];
    const afterCrash = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'after-crash', homeDir, auditRunner }),
      send: (frame) => { crashRestartSent.push(frame); },
    });
    await afterCrash.replayPending();
    expect(crashRestartSent).toContainEqual(expect.objectContaining({
      requestId: crashManage.requestId, phase: 'aborted', ok: false,
    }));
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: 'active', authorityRevision: 7 });
  });

  it('recovers Skill and MCP publication when the process dies after mutation but before COMMIT_RESULT WAL finalization', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-authorize-wal-crash-'));
    const auditRunner = { identity: 'authorize-wal-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const run = async (frame: CapabilityOperationInstallFrame, authorize: (activation: CapabilityOperationActivateFrame) => CapabilityOperationAuthorizeFrame) => {
      const sent: SentFrame[] = [];
      const crashing = new CapabilityOperationHandler({
        homeDir, isFullDaemon: true, serverId: 'server-1',
        serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: `crash-${frame.operationId}`, homeDir, auditRunner }),
        send: (value) => { sent.push(value); },
        afterAuthorizedMutation: () => { throw new Error('simulated authorize crash gap'); },
      });
      await crashing.handle(frame);
      await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
      const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
      await crashing.handle({
        type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: frame.operationId, expectedRevision: 6,
        decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
        scope: frame.request.scope, providers: frame.request.providers ?? [], machines: frame.request.machines ?? [],
      });
      const authorization = authorize(sent.at(-1) as CapabilityOperationActivateFrame);
      await expect(crashing.handle(authorization)).rejects.toThrow('simulated authorize crash gap');

      const replayed: SentFrame[] = [];
      const restarted = new CapabilityOperationHandler({
        homeDir, isFullDaemon: true, serverId: 'server-1',
        serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, serverId: 'server-1', conversationIdentity: `restart-${frame.operationId}`, homeDir, auditRunner }),
        send: (value) => { replayed.push(value); },
      });
      await restarted.replayPending();
      expect(replayed).toContainEqual(expect.objectContaining({
        type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, operationId: frame.operationId, ok: true,
        capabilityId: authorization.capability.id, versionId: authorization.version.id,
      }));
      return { restarted, authorization, replayed };
    };

    const skill = await run(installFrame(), (activation) => authorizeSkill(activation, 'wal-skill', 'wal-skill-v1'));
    await skill.restarted.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK, operationId: installFrame().operationId,
      capabilityId: skill.authorization.capability.id, versionId: skill.authorization.version.id,
      bindingId: skill.authorization.binding.id, authorityRevision: skill.authorization.capability.revision,
    });

    const mcpFrame = installFrame();
    mcpFrame.operationId = 'wal-mcp-operation';
    mcpFrame.request = {
      kind: CAPABILITY_KIND.MCP, displayName: 'wal-mcp',
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: {
        transport: 'streamable-http', name: 'wal-mcp', url: 'https://mcp.example/tools',
      } },
      scope: CAPABILITY_SCOPE.LOCAL, providers: [], machines: [], idempotencyKey: 'wal-mcp-install',
    };
    await run(mcpFrame, (activation) => {
      const version = { ...activation.version, id: 'wal-mcp-v1', capabilityId: 'wal-mcp' };
      const binding = { ...activation.binding, id: 'wal-mcp-binding', capabilityId: 'wal-mcp', versionId: version.id };
      return {
        type: CAPABILITY_OPERATION_MSG.AUTHORIZE, operationId: activation.operationId, expectedRevision: 10,
        capability: { ...activation.capability, id: 'wal-mcp', revision: 10, versionId: version.id, bindings: [binding] },
        version, binding, authorizationKeys: [], expiresAt: Date.now() + 60_000,
      };
    });
  });

  it('restores a durable MCP manage rollback after restart before accepting ABORT', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-mcp-manage-restart-'));
    const auditRunner = { identity: 'mcp-manage-restart-auditor', async audit(envelope: CapabilityAuditEnvelope) {
      return { verdict: 'PASS' as const, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
    } };
    const sent: SentFrame[] = [];
    const service = createDefaultCapabilityService({ ownerId: 'owner-1', serverId: 'server-1', conversationIdentity: 'first', homeDir, auditRunner });
    const first = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1', serviceForOwner: () => service,
      send: (frame) => { sent.push(frame); },
    });
    const install = installFrame();
    install.operationId = 'restart-mcp-operation';
    install.request = {
      kind: CAPABILITY_KIND.MCP, displayName: 'restart-mcp',
      source: { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: {
        transport: 'streamable-http', name: 'restart-mcp', url: 'https://mcp.example/tools',
      } },
      scope: CAPABILITY_SCOPE.LOCAL, providers: [], machines: [],
      idempotencyKey: 'restart-mcp-install',
    };
    await first.handle(install);
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION }));
    const reviewed = sent.at(-1) as CapabilityOperationProgressFrame;
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM, operationId: install.operationId, expectedRevision: 6,
      decision: 'install', artifactDigest: reviewed.artifactDigest!, auditDigest: reviewed.auditDigest!,
      scope: CAPABILITY_SCOPE.LOCAL, providers: [], machines: [],
    });
    const activation = sent.at(-1) as CapabilityOperationActivateFrame;
    const version = { ...activation.version, id: 'restart-mcp-v1', capabilityId: 'restart-mcp' };
    const binding = { ...activation.binding, id: 'restart-mcp-binding', capabilityId: 'restart-mcp', versionId: version.id };
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.AUTHORIZE, operationId: activation.operationId, expectedRevision: 10,
      capability: { ...activation.capability, id: 'restart-mcp', revision: 10, versionId: version.id, bindings: [binding] },
      version, binding, authorizationKeys: [], expiresAt: Date.now() + 60_000,
    });
    const committed = sent.at(-1) as CapabilityOperationCommitResultFrame;
    await first.handle({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK, operationId: committed.operationId,
      capabilityId: committed.capabilityId, versionId: committed.versionId,
      bindingId: committed.bindingId, authorityRevision: committed.authorityRevision,
    });
    const manage = {
      type: CAPABILITY_OPERATION_MSG.MANAGE, requestId: 'restart-mcp-disable', ownerId: 'owner-1',
      serverId: 'server-1', capabilityId: 'restart-mcp', bindingId: 'restart-mcp-binding',
      action: 'disable', expectedRevision: 10, authorityRevision: 11,
    } as const;
    await first.handle({ ...manage, phase: 'prepare' });
    await first.handle({ ...manage, phase: 'commit' });
    expect(sent.at(-1)).toMatchObject({ phase: 'applied', ok: true, state: CAPABILITY_STATE.DISABLED });

    const replayed: SentFrame[] = [];
    const restarted = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, serverId: 'server-1', conversationIdentity: 'restart', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
    });
    await restarted.replayPending();
    expect(replayed.at(-1)).toMatchObject({ requestId: manage.requestId, phase: 'applied', ok: true });
    await restarted.handle({ ...manage, phase: 'abort' });
    expect(replayed.at(-1)).toMatchObject({ requestId: manage.requestId, phase: 'aborted', ok: true });
    const restored = createDefaultCapabilityService({ ownerId: 'owner-1', serverId: 'server-1', conversationIdentity: 'verify', homeDir, auditRunner });
    expect(restored.status({ capabilityId: 'restart-mcp' })).toMatchObject({
      status: 'ok', capability: {
        revision: 10, state: CAPABILITY_STATE.RUNTIME_PENDING, readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
        bindings: [{ id: 'restart-mcp-binding', active: true }],
      },
    });

    const crashManage = { ...manage, requestId: 'restart-mcp-disable-crash-gap' };
    const crashHandler = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, serverId: 'server-1', conversationIdentity: 'mcp-crash', homeDir, auditRunner }),
      send: (frame) => { replayed.push(frame); },
      afterManageMutation: () => { throw new Error('simulated mcp crash after mutation'); },
    });
    await crashHandler.handle({ ...crashManage, phase: 'prepare' });
    await expect(crashHandler.handle({ ...crashManage, phase: 'commit' })).rejects.toThrow('simulated mcp crash');
    const afterCrashSent: SentFrame[] = [];
    const afterCrash = new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, serverId: 'server-1', conversationIdentity: 'mcp-after-crash', homeDir, auditRunner }),
      send: (frame) => { afterCrashSent.push(frame); },
    });
    await afterCrash.replayPending();
    expect(afterCrashSent).toContainEqual(expect.objectContaining({
      requestId: crashManage.requestId, phase: 'aborted', ok: false,
    }));
    expect(createDefaultCapabilityService({ ownerId: 'owner-1', serverId: 'server-1', conversationIdentity: 'verify-crash', homeDir, auditRunner })
      .status({ capabilityId: 'restart-mcp' })).toMatchObject({
      status: 'ok', capability: { revision: 10, state: CAPABILITY_STATE.RUNTIME_PENDING },
    });
  });

  it('restores exact Skill package and trash state when uninstall or restore is aborted after restart', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-trash-rollback-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-operation-trash-source-'));
    await writeFile(join(source, 'SKILL.md'), '---\nname: trash-rollback\ndescription: Trash rollback.\n---\nSafe.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    const [initialBinding] = authorizedManagedBindings({
      ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'trash-rollback',
      versionId: 'trash-version', artifactDigest: inventory.treeDigest, auditDigest: 'trash-audit',
      issuedRevision: 7,
      bindings: [{
        ownerId: 'owner-1', serverId: 'server-1', scope: CAPABILITY_SCOPE.LOCAL,
        bindingId: 'trash-binding', providers: [], machines: [],
      }],
    });
    publishManagedSkillVersion({
      registryId: 'trash-rollback', versionId: 'trash-version', quarantinePath: source,
      source: 'test', scannerDigest: scan.scannerDigest, auditDigest: 'trash-audit', auditPolicyVersion: 'test',
      bindings: [initialBinding!],
    }, homeDir);
    updateManagedSkillEntry('trash-rollback', (entry) => ({ ...entry, authorityRevision: 7 }), homeDir);
    const auditRunner = { identity: 'unused', async audit() { throw new Error('unused'); } };
    const makeHandler = (sent: SentFrame[]) => new CapabilityOperationHandler({
      homeDir, isFullDaemon: true, serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({ ownerId, conversationIdentity: 'manage', homeDir, auditRunner }),
      send: (frame) => { sent.push(frame); },
    });
    const version = {
      id: 'trash-version', capabilityId: 'trash-rollback', version: 1,
      artifactDigest: inventory.treeDigest, auditDigest: 'trash-audit',
      auditVerdict: 'PASS', sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 1,
    } as const;
    const signedManage = (action: 'uninstall' | 'restore', requestId: string, expectedRevision: number) => {
      const active = action === 'restore';
      const authorization = signedSyncBinding({
        ownerId: 'owner-1', capabilityId: 'trash-rollback', version,
        issuedRevision: expectedRevision + 1,
        bindingState: active ? 'active' : 'removed',
        binding: {
          id: 'trash-binding', capabilityId: 'trash-rollback', versionId: 'trash-version',
          scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: [], machines: [], active,
        },
      }).authorization!;
      return {
        type: CAPABILITY_OPERATION_MSG.MANAGE, requestId, ownerId: 'owner-1', serverId: 'server-1',
        capabilityId: 'trash-rollback', bindingId: 'trash-binding', action,
        expectedRevision, authorityRevision: expectedRevision + 1, authorization,
      } as const;
    };

    const firstSent: SentFrame[] = [];
    const first = makeHandler(firstSent);
    const abortedUninstall = signedManage('uninstall', 'abort-uninstall', 7);
    await first.handle({ ...abortedUninstall, phase: 'prepare' });
    await first.handle({ ...abortedUninstall, phase: 'commit' });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: CAPABILITY_STATE.TOMBSTONED });
    expect(await readdir(getManagedSkillTrashRoot(homeDir))).toHaveLength(1);
    const afterUninstallRestart: SentFrame[] = [];
    const restartedUninstall = makeHandler(afterUninstallRestart);
    await restartedUninstall.replayPending();
    await restartedUninstall.handle({ ...abortedUninstall, phase: 'abort' });
    expect(afterUninstallRestart.at(-1)).toMatchObject({ phase: 'aborted', ok: true });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: CAPABILITY_STATE.ACTIVE, authorityRevision: 7 });
    expect(await readdir(getManagedSkillTrashRoot(homeDir))).toEqual([]);

    const committedUninstall = signedManage('uninstall', 'commit-uninstall', 7);
    await restartedUninstall.handle({ ...committedUninstall, phase: 'prepare' });
    await restartedUninstall.handle({ ...committedUninstall, phase: 'commit' });
    await restartedUninstall.handle({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK, requestId: committedUninstall.requestId,
      capabilityId: committedUninstall.capabilityId, bindingId: committedUninstall.bindingId,
      authorityRevision: committedUninstall.authorityRevision,
    });
    const stableTrash = await readdir(getManagedSkillTrashRoot(homeDir));
    expect(stableTrash).toHaveLength(1);
    const restore = signedManage('restore', 'abort-restore', 8);
    await restartedUninstall.handle({ ...restore, phase: 'prepare' });
    await restartedUninstall.handle({ ...restore, phase: 'commit' });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: CAPABILITY_STATE.ACTIVE, authorityRevision: 9 });
    expect(await readdir(getManagedSkillTrashRoot(homeDir))).toEqual([]);
    const afterRestoreRestart: SentFrame[] = [];
    const restartedRestore = makeHandler(afterRestoreRestart);
    await restartedRestore.replayPending();
    await restartedRestore.handle({ ...restore, phase: 'abort' });
    expect(afterRestoreRestart.at(-1)).toMatchObject({ phase: 'aborted', ok: true });
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: CAPABILITY_STATE.TOMBSTONED, authorityRevision: 8 });
    expect(await readdir(getManagedSkillTrashRoot(homeDir))).toEqual(stableTrash);
    await rm(source, { recursive: true, force: true });
  });

  it('rejects non-FULL daemons and changed cross-owner retries', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-operation-home-'));
    const send = vi.fn();
    const serviceForOwner = vi.fn();
    const blocked = new CapabilityOperationHandler({ homeDir, isFullDaemon: false, serverId: 'server-1', serviceForOwner, send });
    await blocked.handle(installFrame());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', errorCode: CAPABILITY_ERROR.FORBIDDEN }));
    expect(serviceForOwner).not.toHaveBeenCalled();
  });
});
