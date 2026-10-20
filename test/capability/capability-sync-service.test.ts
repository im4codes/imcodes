import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_MCP_TRANSPORT,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
  type CapabilitySummary,
  type CapabilitySyncBinding,
  type CapabilitySyncAuthorityFrame,
  type CapabilitySyncDigestFrame,
  type CapabilitySyncSnapshot,
  type CapabilitySyncTombstoneFrame,
  type CapabilityTombstone,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { publishManagedSkillVersion, readManagedSkillIndex } from '../../src/capability/managed-skill-store.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { CAPABILITY_AUTHORIZATION_TESTING } from '../../src/capability/capability-authorization.js';
import {
  CAPABILITY_SYNC_ERROR,
  CAPABILITY_SYNC_SERVICE_TESTING,
  CapabilitySyncError,
  CapabilitySyncService,
} from '../../src/capability/capability-sync-service.js';
import {
  authorizedManagedBindings,
  authorizeSnapshotBindings,
  signedSyncBinding,
  TEST_CAPABILITY_AUTHORIZATION_KEY,
} from './capability-authorization-fixture.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const DIGEST_A = sha256('artifact-a');
const DIGEST_B = sha256('artifact-b');
const AUDIT_DIGEST = sha256('audit');

function item(input: Partial<CapabilitySummary> & Pick<CapabilitySummary, 'id' | 'kind' | 'name'>): CapabilitySummary {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    kind: input.kind,
    name: input.name,
    state: input.state ?? (input.kind === CAPABILITY_KIND.MCP ? CAPABILITY_STATE.RUNTIME_PENDING : CAPABILITY_STATE.ACTIVE),
    scope: input.scope ?? CAPABILITY_SCOPE.ACCOUNT,
    versionId: input.versionId,
    version: input.version ?? 1,
    artifactDigest: input.artifactDigest,
    sourceKind: input.sourceKind ?? CAPABILITY_SOURCE_KIND.INLINE,
    sourceLabel: input.sourceLabel ?? 'account-sync',
    readiness: input.readiness ?? CAPABILITY_READINESS.CONTENT_MISSING,
    findings: input.findings ?? [],
    updatedAt: input.updatedAt ?? 100,
  };
}

function version(capabilityId: string, id: string, artifactDigest: string): CapabilityVersion {
  return {
    id,
    capabilityId,
    version: 1,
    artifactDigest,
    auditDigest: AUDIT_DIGEST,
    auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
    sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
    sourceLocator: 'account-sync',
    createdAt: 100,
  };
}

function transferableVersion(capabilityId: string, id: string, artifactDigest: string, blob: Uint8Array): CapabilityVersion {
  return {
    ...version(capabilityId, id, artifactDigest),
    blobDigest: createHash('sha256').update(blob).digest('hex'),
    blobByteSize: blob.byteLength,
  };
}

function binding(capabilityId: string, versionId: string, input: Partial<CapabilitySyncBinding> = {}): CapabilitySyncBinding {
  return {
    id: input.id ?? `binding-${capabilityId}`,
    capabilityId,
    versionId,
    scope: input.scope ?? CAPABILITY_SCOPE.ACCOUNT,
    providers: input.providers ?? [],
    machines: input.machines ?? ['server-1'],
    active: input.active ?? true,
  };
}

function signed<T extends CapabilitySyncDigestFrame>(frame: Omit<T, 'digest'>): T {
  const draft = { ...frame, digest: sha256('placeholder') } as T;
  return { ...draft, digest: computeCapabilitySyncDigest(draft, sha256) };
}

function snapshot(input: {
  revision: number;
  ownerId?: string;
  items?: CapabilitySummary[];
  versions?: CapabilityVersion[];
  bindings?: CapabilitySyncBinding[];
  tombstones?: CapabilityTombstone[];
  type?: typeof CAPABILITY_SYNC_MSG.SNAPSHOT | typeof CAPABILITY_SYNC_MSG.DELTA;
}): CapabilitySyncSnapshot {
  const ownerId = input.ownerId ?? 'owner-1';
  const items = input.items ?? [];
  const versions = input.versions ?? [];
  const bindings = authorizeSnapshotBindings({
    ownerId,
    revision: input.revision,
    items,
    versions,
    bindings: input.bindings ?? [],
  });
  return signed<CapabilitySyncSnapshot>({
    type: input.type ?? CAPABILITY_SYNC_MSG.SNAPSHOT,
    ownerId,
    revision: input.revision,
    items,
    versions,
    bindings,
    tombstones: input.tombstones ?? [],
    authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
  });
}

function tombstoneFrame(revision: number, tombstone: CapabilityTombstone): CapabilitySyncTombstoneFrame {
  return signed<CapabilitySyncTombstoneFrame>({ type: CAPABILITY_SYNC_MSG.TOMBSTONE, ownerId: 'owner-1', revision, tombstone });
}

async function portableSkill(name: string): Promise<{ path: string; digest: string }> {
  const path = await mkdtemp(join(tmpdir(), 'imcodes-sync-skill-'));
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Synchronized Skill.\n---\nUse safely.\n`);
  return { path, digest: inventoryAgentSkillPackage(path).treeDigest };
}

describe('daemon capability account synchronization', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    CAPABILITY_AUTHORIZATION_TESTING.clearAll();
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('persists an owner/server cursor and reports missing Skill content before ACK', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const sent: unknown[] = [];
    const service = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir, now: () => 500, send: (frame) => { sent.push(frame); },
    });
    const skill = item({ id: 'skill-1', kind: CAPABILITY_KIND.SKILL, name: 'skill-one', versionId: 'version-1', artifactDigest: DIGEST_A });
    const frame = snapshot({ revision: 1, items: [skill], versions: [version(skill.id, 'version-1', DIGEST_A)], bindings: [binding(skill.id, 'version-1')] });
    const result = await service.apply(frame);

    expect(result.outbound).toEqual([
      expect.objectContaining({ type: CAPABILITY_SYNC_MSG.READINESS, readiness: CAPABILITY_READINESS.CONTENT_MISSING, revision: 1 }),
      { type: CAPABILITY_SYNC_MSG.ACK, revision: 1, digest: frame.digest },
    ]);
    expect(sent).toEqual(result.outbound);
    expect(service.cursor).toEqual({ revision: 1, digest: frame.digest });
    const restored = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    expect(restored.cursor).toEqual(service.cursor);
    expect(restored.snapshot.readiness).toEqual([expect.objectContaining({ readiness: CAPABILITY_READINESS.CONTENT_MISSING })]);

    const otherMachine = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-2', homeDir });
    const otherOwner = new CapabilitySyncService({ ownerId: 'owner-2', serverId: 'server-1', homeDir });
    expect(otherMachine.cursor.revision).toBe(0);
    expect(otherOwner.cursor.revision).toBe(0);
  });

  it('rejects a digest mismatch and leaves the durable cursor unchanged', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const frame = { ...snapshot({ revision: 1 }), digest: DIGEST_B };
    await expect(service.apply(frame)).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.DIGEST_MISMATCH });
    expect(service.cursor.revision).toBe(0);
    expect(existsSync(join(CAPABILITY_SYNC_SERVICE_TESTING.stateDirectory(homeDir, 'owner-1', 'server-1'), 'state.json'))).toBe(false);
  });

  it('rejects a validly digested frame bound to another owner', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const otherOwnerFrame = snapshot({ revision: 1, ownerId: 'owner-2' });
    await expect(service.apply(otherOwnerFrame)).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.OWNER_MISMATCH });
    expect(service.cursor.revision).toBe(0);
  });

  it('normalizes non-secret MCP definitions and rejects secret-shaped or Skill definitions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const mcp = item({ id: 'defined-mcp', kind: CAPABILITY_KIND.MCP, name: 'defined-mcp', versionId: 'defined-version', artifactDigest: DIGEST_A });
    const definedVersion: CapabilityVersion = {
      ...version(mcp.id, 'defined-version', DIGEST_A),
      definition: {
        name: 'defined-mcp',
        transport: CAPABILITY_MCP_TRANSPORT.STDIO,
        command: 'safe-command',
        args: ['--stdio'],
      },
    };
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await service.apply(snapshot({
      revision: 1, items: [mcp], versions: [definedVersion], bindings: [binding(mcp.id, 'defined-version')],
    }));
    expect(service.snapshot.versions[0]?.definition).toEqual(definedVersion.definition);

    const rawSecret = {
      ...definedVersion,
      definition: {
        name: 'defined-mcp', transport: CAPABILITY_MCP_TRANSPORT.STDIO, command: 'safe-command',
        env: { MCP_TOKEN: 'raw-secret-value' },
      },
    } as unknown as CapabilityVersion;
    await expect(service.apply(snapshot({
      revision: 2, type: CAPABILITY_SYNC_MSG.DELTA, items: [mcp], versions: [rawSecret], bindings: [],
    }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });

    const skill = item({ id: 'skill-with-definition', kind: CAPABILITY_KIND.SKILL, name: 'skill-with-definition', versionId: 'skill-version', artifactDigest: DIGEST_B });
    const skillVersion = {
      ...version(skill.id, 'skill-version', DIGEST_B),
      definition: definedVersion.definition,
    };
    await expect(service.apply(snapshot({
      revision: 2, type: CAPABILITY_SYNC_MSG.DELTA,
      items: [skill], versions: [skillVersion], bindings: [binding(skill.id, 'skill-version')],
    }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });
  });


  it('rejects delta gaps but accepts a complete snapshot jump and exact retry idempotently', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const send = vi.fn();
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir, send });
    await service.apply(snapshot({ revision: 1 }));
    await expect(service.apply(snapshot({ revision: 3, type: CAPABILITY_SYNC_MSG.DELTA })))
      .rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.REVISION_GAP });
    const recovery = snapshot({ revision: 3 });
    await expect(service.apply(recovery)).resolves.toMatchObject({ accepted: true, revision: 3, idempotent: false });
    await expect(service.apply(recovery)).resolves.toMatchObject({ accepted: true, revision: 3, idempotent: true });
    await expect(service.apply(snapshot({ revision: 2 }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.STALE_REVISION });
  });

  it('treats DELTA as a validated complete-current projection and drops omitted remote state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const localSource = await portableSkill('local-only-skill');
    temporary.push(homeDir, localSource.path);
    const localScan = scanAgentSkillPackage(inventoryAgentSkillPackage(localSource.path));
    publishManagedSkillVersion({
      registryId: 'local-only-skill',
      versionId: 'local-only-version',
      quarantinePath: localSource.path,
      source: 'local-test',
      scannerDigest: localScan.scannerDigest,
      auditDigest: AUDIT_DIGEST,
      auditPolicyVersion: 'audit-v1',
      bindings: [{ scope: CAPABILITY_SCOPE.LOCAL, ownerId: 'owner-1', machines: ['server-1'] }],
    }, homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const first = item({ id: 'mcp-first', kind: CAPABILITY_KIND.MCP, name: 'first', versionId: 'mcp-v1', artifactDigest: DIGEST_A });
    const second = item({ id: 'mcp-second', kind: CAPABILITY_KIND.MCP, name: 'second', versionId: 'mcp-v2', artifactDigest: DIGEST_B });
    await service.apply(snapshot({
      revision: 1,
      items: [first, second],
      versions: [version(first.id, 'mcp-v1', DIGEST_A), version(second.id, 'mcp-v2', DIGEST_B)],
      bindings: [binding(first.id, 'mcp-v1'), binding(second.id, 'mcp-v2')],
    }));
    const changed = { ...first, name: 'first-updated', revision: 2, updatedAt: 200 };
    await service.apply(snapshot({
      type: CAPABILITY_SYNC_MSG.DELTA,
      revision: 2,
      items: [changed],
      versions: [version(first.id, 'mcp-v1', DIGEST_A)],
      bindings: [binding(first.id, 'mcp-v1')],
    }));
    expect(service.snapshot.items).toEqual([
      expect.objectContaining({ id: first.id, name: 'first-updated' }),
    ]);
    expect(service.snapshot.versions.map((entry) => entry.capabilityId)).toEqual([first.id]);
    expect(service.snapshot.bindings.map((entry) => entry.capabilityId)).toEqual([first.id]);
    expect(readManagedSkillIndex(homeDir).entries).toEqual([
      expect.objectContaining({
        registryId: 'local-only-skill',
        activeVersionId: 'local-only-version',
        state: CAPABILITY_STATE.ACTIVE,
      }),
    ]);
  });

  it('accepts the bounded legal cardinality above 200 versions and bindings', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const capability = item({ id: 'many-versions', kind: CAPABILITY_KIND.SKILL, name: 'many-versions', versionId: 'version-0', artifactDigest: DIGEST_A });
    const versions = Array.from({ length: 201 }, (_, index) => version(capability.id, `version-${index}`, DIGEST_A));
    const bindings = versions.map((entry, index) => binding(capability.id, entry.id, { id: `binding-many-${index}` }));
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await expect(service.apply(snapshot({ revision: 1, items: [capability], versions, bindings })))
      .resolves.toMatchObject({ accepted: true });
    expect(service.snapshot.versions).toHaveLength(201);
    expect(service.snapshot.bindings).toHaveLength(201);
  });

  it('filters local scope and applies embedded and standalone tombstones before content', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const account = item({ id: 'account-skill', kind: CAPABILITY_KIND.SKILL, name: 'account-skill', versionId: 'account-version', artifactDigest: DIGEST_A });
    account.bindings = [
      { id: 'nested-local', scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-secret-local', providers: [], machines: [], active: true },
      { id: 'nested-account', scope: CAPABILITY_SCOPE.ACCOUNT, providers: [], machines: [], active: true },
    ];
    const local = item({ id: 'local-skill', kind: CAPABILITY_KIND.SKILL, name: 'local-skill', scope: CAPABILITY_SCOPE.LOCAL, versionId: 'local-version', artifactDigest: DIGEST_B });
    const embedded: CapabilityTombstone = {
      id: 'tombstone-account', capabilityId: account.id, scope: CAPABILITY_SCOPE.ACCOUNT,
      accountRevision: 1, expiresAt: 10_000, createdAt: 100,
    };
    await service.apply(snapshot({
      revision: 1,
      items: [account, local],
      versions: [version(account.id, 'account-version', DIGEST_A), version(local.id, 'local-version', DIGEST_B)],
      bindings: [binding(account.id, 'account-version'), binding(local.id, 'local-version', { scope: CAPABILITY_SCOPE.LOCAL })],
      tombstones: [embedded],
    }));
    expect(service.snapshot.items).toEqual([]);
    expect(service.snapshot.versions).toEqual([]);
    expect(service.snapshot.bindings).toEqual([]);
    expect(service.snapshot.tombstones).toEqual([embedded]);

    // Server summaries can inherit their display scope from a local first
    // binding; the dedicated sync binding remains the authority.
    const mcp = item({
      id: 'mcp-1', kind: CAPABILITY_KIND.MCP, name: 'mcp-one', scope: CAPABILITY_SCOPE.LOCAL,
      versionId: 'mcp-version', artifactDigest: DIGEST_A,
    });
    mcp.bindings = [
      { id: 'nested-mcp-local', scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-secret-local', providers: [], machines: [], active: true },
      { id: 'nested-mcp-account', scope: CAPABILITY_SCOPE.ACCOUNT, providers: [], machines: [], active: true },
    ];
    await service.apply(snapshot({
      revision: 2,
      type: CAPABILITY_SYNC_MSG.DELTA,
      items: [mcp],
      versions: [version(mcp.id, 'mcp-version', DIGEST_A)],
      bindings: [binding(mcp.id, 'mcp-version')],
    }));
    expect(service.snapshot.items[0]?.bindings).toEqual([
      expect.objectContaining({ id: 'nested-mcp-account', scope: CAPABILITY_SCOPE.ACCOUNT }),
    ]);
    expect(service.snapshot.items[0]?.scope).toBe(CAPABILITY_SCOPE.ACCOUNT);
    const standalone: CapabilityTombstone = {
      id: 'tombstone-mcp', capabilityId: mcp.id, scope: CAPABILITY_SCOPE.ACCOUNT,
      accountRevision: 3, expiresAt: 10_000, createdAt: 101,
    };
    await service.apply(tombstoneFrame(3, standalone));
    expect(service.snapshot.items).toEqual([]);
    expect(service.snapshot.tombstones).toContainEqual(standalone);
  });

  it('validates every available package in temporary storage before publishing any and emits integrity failure without ACK', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const valid = await portableSkill('valid-skill');
    const corrupt = await portableSkill('corrupt-skill');
    temporary.push(homeDir, valid.path, corrupt.path);
    const publishSkill = vi.fn(async () => ({ rollback: vi.fn() }));
    const send = vi.fn();
    const validBlob = Buffer.from('valid-archive');
    const corruptBlob = Buffer.from('corrupt-archive');
    const first = item({ id: 'skill-valid', kind: CAPABILITY_KIND.SKILL, name: 'valid-skill', versionId: 'version-valid', artifactDigest: valid.digest });
    const second = item({ id: 'skill-corrupt', kind: CAPABILITY_KIND.SKILL, name: 'corrupt-skill', versionId: 'version-corrupt', artifactDigest: DIGEST_B });
    const service = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir, send,
      loadSkillContent: async ({ capability }) => ({
        status: 'available',
        sourceDirectory: capability.id === first.id ? valid.path : corrupt.path,
        blob: capability.id === first.id ? validBlob : corruptBlob,
      }),
      publishSkill,
    });
    const frame = snapshot({
      revision: 1,
      items: [first, second],
      versions: [
        transferableVersion(first.id, 'version-valid', valid.digest, validBlob),
        transferableVersion(second.id, 'version-corrupt', DIGEST_B, corruptBlob),
      ],
      bindings: [binding(first.id, 'version-valid'), binding(second.id, 'version-corrupt')],
    });
    await expect(service.apply(frame)).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.CONTENT_INTEGRITY_FAILED });
    expect(publishSkill).not.toHaveBeenCalled();
    expect(service.cursor.revision).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: CAPABILITY_SYNC_MSG.READINESS,
      capabilityId: second.id,
      readiness: CAPABILITY_READINESS.INTEGRITY_FAILED,
    }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: CAPABILITY_SYNC_MSG.ACK }));
  });

  it('publishes only a verified staging copy and rolls publications back when the batch cannot commit', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const source = await portableSkill('published-skill');
    temporary.push(homeDir, source.path);
    const rollback = vi.fn();
    const blob = Buffer.from('published-archive');
    let stagedPath = '';
    const capability = item({
      id: 'published-skill', kind: CAPABILITY_KIND.SKILL, name: 'published-skill',
      versionId: 'published-version', artifactDigest: source.digest,
    });
    const service = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir,
      loadSkillContent: async () => ({ status: 'available', sourceDirectory: source.path, blob }),
      publishSkill: async (input) => {
        stagedPath = input.stagingDirectory;
        expect(stagedPath).not.toBe(source.path);
        expect(inventoryAgentSkillPackage(stagedPath).treeDigest).toBe(source.digest);
        return { rollback };
      },
    });
    const frame = snapshot({
      revision: 1,
      items: [capability],
      versions: [transferableVersion(capability.id, 'published-version', source.digest, blob)],
      bindings: [binding(capability.id, 'published-version')],
    });
    const result = await service.apply(frame);
    expect(result.outbound).toContainEqual(expect.objectContaining({ readiness: CAPABILITY_READINESS.READY }));
    expect(rollback).not.toHaveBeenCalled();
    expect(existsSync(stagedPath)).toBe(false);

    const persistedPath = join(CAPABILITY_SYNC_SERVICE_TESTING.stateDirectory(homeDir, 'owner-1', 'server-1'), 'state.json');
    const persisted = JSON.parse(await readFile(persistedPath, 'utf8')) as { stateDigest: string };
    persisted.stateDigest = DIGEST_B;
    await writeFile(persistedPath, JSON.stringify(persisted));
    expect(() => new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir }))
      .toThrowError(expect.objectContaining({ code: CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT }));
  });

  it('rolls back earlier publications in reverse order when a later publication fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const firstSource = await portableSkill('first-skill');
    const secondSource = await portableSkill('second-skill');
    temporary.push(homeDir, firstSource.path, secondSource.path);
    const rollback = vi.fn();
    const firstBlob = Buffer.from('first-archive');
    const secondBlob = Buffer.from('second-archive');
    const first = item({ id: 'first-skill', kind: CAPABILITY_KIND.SKILL, name: 'first-skill', versionId: 'first-version', artifactDigest: firstSource.digest });
    const second = item({ id: 'second-skill', kind: CAPABILITY_KIND.SKILL, name: 'second-skill', versionId: 'second-version', artifactDigest: secondSource.digest });
    let calls = 0;
    const service = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir,
      loadSkillContent: async ({ capability }) => ({
        status: 'available',
        sourceDirectory: capability.id === first.id ? firstSource.path : secondSource.path,
        blob: capability.id === first.id ? firstBlob : secondBlob,
      }),
      publishSkill: async () => {
        calls += 1;
        if (calls === 2) throw new Error('second publish failed');
        return { rollback };
      },
    });
    await expect(service.apply(snapshot({
      revision: 1,
      items: [first, second],
      versions: [
        transferableVersion(first.id, 'first-version', firstSource.digest, firstBlob),
        transferableVersion(second.id, 'second-version', secondSource.digest, secondBlob),
      ],
      bindings: [binding(first.id, 'first-version'), binding(second.id, 'second-version')],
    }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.PUBLISH_FAILED });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(service.cursor.revision).toBe(0);
  });

  it('revokes a tombstoned managed Skill from the resolver and rolls the revocation back when cursor commit fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const source = await portableSkill('tombstoned-skill');
    temporary.push(homeDir, source.path);
    const scan = scanAgentSkillPackage(inventoryAgentSkillPackage(source.path));
    publishManagedSkillVersion({
      registryId: 'tombstoned-skill',
      versionId: 'tombstoned-version',
      quarantinePath: source.path,
      source: 'sync-test',
      scannerDigest: scan.scannerDigest,
      auditDigest: AUDIT_DIGEST,
      auditPolicyVersion: 'audit-v1',
      bindings: authorizedManagedBindings({
        ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'tombstoned-skill',
        versionId: 'tombstoned-version', artifactDigest: source.digest, auditDigest: AUDIT_DIGEST,
        bindings: [{ scope: CAPABILITY_SCOPE.ACCOUNT, ownerId: 'owner-1', bindingId: 'tombstoned-binding' }],
      }),
    }, homeDir);
    const capability = item({
      id: 'tombstoned-skill', kind: CAPABILITY_KIND.SKILL, name: 'tombstoned-skill',
      versionId: 'tombstoned-version', artifactDigest: source.digest,
    });
    const authority = snapshot({
      revision: 1,
      items: [capability],
      versions: [version(capability.id, 'tombstoned-version', source.digest)],
      bindings: [binding(capability.id, 'tombstoned-version', { id: 'tombstoned-binding', machines: [] })],
    });
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await service.apply(authority);
    const resolverInput = {
      namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' },
      key: capability.id,
      homeDir,
      serverId: 'server-1',
    } as const;
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: true });
    const tombstone: CapabilityTombstone = {
      id: 'tombstone-managed', capabilityId: capability.id, scope: CAPABILITY_SCOPE.ACCOUNT,
      accountRevision: 2, expiresAt: 10_000, createdAt: 200,
    };

    const commitFailure = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir,
      persistState: () => { throw new Error('disk unavailable'); },
    });
    await expect(commitFailure.apply(tombstoneFrame(2, tombstone)))
      .rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.PUBLISH_FAILED });
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: true });
    expect(commitFailure.cursor.revision).toBe(1);

    await service.apply(tombstoneFrame(2, tombstone));
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: false, reason: 'unknown_key' });
  });

  it('accepts a wire-faithful removed Skill envelope with its tombstone without inferring disabled authority', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-removed-home-'));
    const source = await portableSkill('removed-skill');
    temporary.push(homeDir, source.path);
    const scan = scanAgentSkillPackage(inventoryAgentSkillPackage(source.path));
    publishManagedSkillVersion({
      registryId: 'removed-skill', versionId: 'removed-version', quarantinePath: source.path,
      source: 'sync-test', scannerDigest: scan.scannerDigest, auditDigest: AUDIT_DIGEST,
      auditPolicyVersion: 'audit-v1',
      bindings: authorizedManagedBindings({
        ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'removed-skill',
        versionId: 'removed-version', artifactDigest: source.digest, auditDigest: AUDIT_DIGEST,
        bindings: [{ scope: CAPABILITY_SCOPE.ACCOUNT, ownerId: 'owner-1', bindingId: 'removed-binding' }],
      }),
    }, homeDir);
    const capability = item({
      id: 'removed-skill', revision: 2, kind: CAPABILITY_KIND.SKILL, name: 'removed-skill',
      state: CAPABILITY_STATE.TOMBSTONED, versionId: 'removed-version', artifactDigest: source.digest,
    });
    const capabilityVersion = version(capability.id, 'removed-version', source.digest);
    const removedBinding = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: capability.id, version: capabilityVersion,
      bindingState: CAPABILITY_AUTHORITY_STATE.REMOVED, issuedRevision: 2,
      binding: binding(capability.id, capabilityVersion.id, { id: 'removed-binding', active: false, machines: [] }),
    });
    const tombstone: CapabilityTombstone = {
      id: 'removed-tombstone', capabilityId: capability.id, scope: CAPABILITY_SCOPE.ACCOUNT,
      accountRevision: 2, expiresAt: 10_000, createdAt: 200,
    };
    const frame = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 2,
      items: [capability], versions: [capabilityVersion], bindings: [removedBinding],
      tombstones: [tombstone], authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const resolverInput = {
      namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id,
      homeDir, serverId: 'server-1',
    } as const;
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: true });
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await expect(service.apply(frame)).resolves.toMatchObject({ accepted: true, revision: 2 });
    expect(readManagedSkillIndex(homeDir).entries).toEqual([
      expect.objectContaining({ registryId: capability.id, state: CAPABILITY_STATE.TOMBSTONED, bindings: [] }),
    ]);
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: false, reason: 'unknown_key' });

    const authorization = removedBinding.authorization!;
    const authority = signed<CapabilitySyncAuthorityFrame>({
      type: CAPABILITY_SYNC_MSG.AUTHORITY, ownerId: 'owner-1', serverId: 'server-1', revision: 2,
      records: [{
        capabilityId: capability.id, versionId: capabilityVersion.id, bindingId: removedBinding.id,
        state: CAPABILITY_AUTHORITY_STATE.REMOVED, itemRevision: authorization.itemRevision,
        bindingRevision: authorization.bindingRevision, authorization,
      }],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await expect(service.apply(authority)).resolves.toMatchObject({ accepted: true, revision: 2 });
  });

  it('rejects an inactive Skill binding whose signed authority state claims active before persistence', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-state-mismatch-home-'));
    temporary.push(homeDir);
    const capability = item({
      id: 'state-mismatch', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'state-mismatch',
      state: CAPABILITY_STATE.DISABLED, versionId: 'state-mismatch-version', artifactDigest: DIGEST_A,
    });
    const capabilityVersion = version(capability.id, 'state-mismatch-version', DIGEST_A);
    const mismatched = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: capability.id, version: capabilityVersion,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      binding: binding(capability.id, capabilityVersion.id, { active: false }),
    });
    const frame = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [capability], versions: [capabilityVersion], bindings: [mismatched], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await expect(service.apply(frame)).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });
    expect(service.cursor.revision).toBe(0);
  });

  it('keeps a committed cursor/content transaction when readiness delivery fails and retries ACK idempotently', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    const source = await portableSkill('delivery-skill');
    temporary.push(homeDir, source.path);
    const blob = Buffer.from('delivery-archive');
    const marker = join(homeDir, 'published.marker');
    const rollback = vi.fn(async () => { await rm(marker, { force: true }); });
    let deliveryFails = true;
    const send = vi.fn(async () => {
      if (deliveryFails) throw new Error('socket closed');
    });
    const capability = item({
      id: 'delivery-skill', kind: CAPABILITY_KIND.SKILL, name: 'delivery-skill',
      versionId: 'delivery-version', artifactDigest: source.digest,
    });
    const service = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir, send,
      loadSkillContent: async () => ({ status: 'available', sourceDirectory: source.path, blob }),
      publishSkill: async () => {
        await writeFile(marker, 'published');
        return { rollback };
      },
    });
    const frame = snapshot({
      revision: 1,
      items: [capability],
      versions: [transferableVersion(capability.id, 'delivery-version', source.digest, blob)],
      bindings: [binding(capability.id, 'delivery-version')],
    });
    await expect(service.apply(frame)).resolves.toMatchObject({ accepted: true, idempotent: false });
    expect(service.cursor.revision).toBe(1);
    expect(await readFile(marker, 'utf8')).toBe('published');
    expect(rollback).not.toHaveBeenCalled();
    deliveryFails = false;
    await expect(service.apply(frame)).resolves.toMatchObject({ accepted: true, idempotent: true });
    expect(send).toHaveBeenLastCalledWith({ type: CAPABILITY_SYNC_MSG.ACK, revision: 1, digest: frame.digest });
    expect(await readFile(marker, 'utf8')).toBe('published');
  });

  it('requires blob digest and byte size as a bounded pair', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const capability = item({ id: 'blob-skill', kind: CAPABILITY_KIND.SKILL, name: 'blob-skill', versionId: 'blob-version', artifactDigest: DIGEST_A });
    const malformed = version(capability.id, 'blob-version', DIGEST_A) as CapabilityVersion & { blobDigest?: string };
    malformed.blobDigest = DIGEST_B;
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await expect(service.apply(snapshot({
      revision: 1, items: [capability], versions: [malformed], bindings: [binding(capability.id, 'blob-version')],
    }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });
  });

  it('rejects unknown fields, relationship forgery, and malformed persisted owner state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-home-'));
    temporary.push(homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await expect(service.apply({ ...snapshot({ revision: 1 }), unexpected: true }))
      .rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });
    const forgedItem = item({ id: 'forged', kind: CAPABILITY_KIND.SKILL, name: 'forged', versionId: 'version-forged', artifactDigest: DIGEST_A });
    const forged = snapshot({
      revision: 1,
      items: [forgedItem],
      versions: [version('another-capability', 'version-forged', DIGEST_A)],
      bindings: [],
    });
    await expect(service.apply(forged)).rejects.toBeInstanceOf(CapabilitySyncError);

    const directory = CAPABILITY_SYNC_SERVICE_TESTING.stateDirectory(homeDir, 'owner-1', 'server-1');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'state.json'), JSON.stringify({ ownerId: 'owner-2' }));
    expect(() => new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir }))
      .toThrowError(expect.objectContaining({ code: CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT }));
  });

  it('enforces encoded sync-record and persisted-state byte bounds before decoding', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-bounds-'));
    temporary.push(homeDir);
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const oversizedItem = item({
      id: 'oversized-item', kind: CAPABILITY_KIND.MCP, name: 'oversized-item',
      sourceLabel: 'x'.repeat(CAPABILITY_LIMITS.SYNC_ITEM_RECORD_BYTES),
    });
    await expect(service.apply(snapshot({ revision: 1, items: [oversizedItem] })))
      .rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });

    const capability = item({
      id: 'oversized-binding', kind: CAPABILITY_KIND.MCP, name: 'oversized-binding',
      versionId: 'oversized-binding-v1', artifactDigest: DIGEST_A,
    });
    const oversizedBinding = binding(capability.id, capability.versionId!, {
      providers: Array.from({ length: 13 }, (_, index) => `${index}-${'p'.repeat(980)}`),
    });
    await expect(service.apply(snapshot({
      revision: 1,
      items: [capability],
      versions: [version(capability.id, capability.versionId!, DIGEST_A)],
      bindings: [oversizedBinding],
    }))).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.INVALID_FRAME });

    const directory = CAPABILITY_SYNC_SERVICE_TESTING.stateDirectory(homeDir, 'owner-1', 'server-1');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'state.json'), 'x'.repeat(CAPABILITY_LIMITS.SYNC_FRAME_BYTES + 1));
    expect(() => new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir }))
      .toThrowError(expect.objectContaining({ code: CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT }));
  });

  it('replaces complete current authority, revokes omissions, and rejects an older valid signed replay', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-authority-home-'));
    const source = await portableSkill('authority-replay-skill');
    temporary.push(homeDir, source.path);
    const scan = scanAgentSkillPackage(inventoryAgentSkillPackage(source.path));
    const [managedBinding] = authorizedManagedBindings({
      ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'authority-replay-skill',
      versionId: 'authority-version', artifactDigest: source.digest, auditDigest: AUDIT_DIGEST,
      bindings: [{ bindingId: 'authority-binding', scope: CAPABILITY_SCOPE.ACCOUNT, ownerId: 'owner-1' }],
    });
    publishManagedSkillVersion({
      registryId: 'authority-replay-skill', versionId: 'authority-version', quarantinePath: source.path,
      source: 'test', scannerDigest: scan.scannerDigest, auditDigest: AUDIT_DIGEST, auditPolicyVersion: 'test',
      bindings: [managedBinding],
    }, homeDir);
    const authorization = managedBinding.authorization!;
    const active = signed<CapabilitySyncAuthorityFrame>({
      type: CAPABILITY_SYNC_MSG.AUTHORITY, ownerId: 'owner-1', serverId: 'server-1', revision: 1,
      records: [{ capabilityId: 'authority-replay-skill', versionId: 'authority-version', bindingId: 'authority-binding',
        state: CAPABILITY_AUTHORITY_STATE.ACTIVE, itemRevision: authorization.itemRevision,
        bindingRevision: authorization.bindingRevision, authorization }],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    await service.apply(active);
    const resolverInput = { namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, homeDir,
      serverId: 'server-1', key: 'managed/authority-replay-skill' } as const;
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: true });
    const revoked = signed<CapabilitySyncAuthorityFrame>({
      type: CAPABILITY_SYNC_MSG.AUTHORITY, ownerId: 'owner-1', serverId: 'server-1', revision: 2,
      records: [], authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await service.apply(revoked);
    expect(resolveSkillByKey(resolverInput)).toMatchObject({ ok: false });
    await expect(service.apply(active)).rejects.toMatchObject({ code: CAPABILITY_SYNC_ERROR.STALE_REVISION });
  });
});
