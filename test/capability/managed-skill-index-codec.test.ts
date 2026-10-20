import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_LIMITS,
  CAPABILITY_SCOPE,
  CAPABILITY_STATE,
  type CapabilitySkillAuthorizationEnvelope,
} from '../../shared/capability-management.js';
import {
  establishManagedSkillStore,
  getManagedSkillIndexPath,
} from '../../src/capability/managed-skill-paths.js';
import {
  MANAGED_SKILL_INDEX_SCHEMA_VERSION,
  readManagedSkillIndex,
  updateManagedSkillEntry,
  writeManagedSkillIndex,
  type ManagedSkillIndex,
} from '../../src/capability/managed-skill-store.js';
import { authorizedManagedBindings } from './capability-authorization-fixture.js';

const OWNER_ID = 'skill-index-owner';
const SERVER_ID = 'skill-index-server';
const REGISTRY_ID = 'skill-index-registry';
const VERSION_ID = 'skill-index-version';
const ARTIFACT_DIGEST = 'a'.repeat(64);
const AUDIT_DIGEST = 'b'.repeat(64);

function validIndex(): ManagedSkillIndex {
  const bindings = authorizedManagedBindings({
    ownerId: OWNER_ID,
    serverId: SERVER_ID,
    capabilityId: REGISTRY_ID,
    versionId: VERSION_ID,
    artifactDigest: ARTIFACT_DIGEST,
    auditDigest: AUDIT_DIGEST,
    issuedRevision: 3,
    bindings: [{
      bindingId: 'skill-index-binding',
      versionId: VERSION_ID,
      scope: CAPABILITY_SCOPE.LOCAL,
      ownerId: OWNER_ID,
      serverId: SERVER_ID,
      providers: [],
      machines: [],
      active: true,
    }],
  });
  return {
    schemaVersion: MANAGED_SKILL_INDEX_SCHEMA_VERSION,
    revision: 1,
    entries: [{
      registryId: REGISTRY_ID,
      name: 'index-skill',
      description: 'A strictly decoded managed Skill.',
      activeVersionId: VERSION_ID,
      versions: [VERSION_ID],
      bindings,
      versionBindings: { [VERSION_ID]: structuredClone(bindings) },
      state: CAPABILITY_STATE.ACTIVE,
      revision: 1,
      authorityRevision: 3,
      updatedAt: 1,
    }],
  };
}

describe('managed Skill index codec', () => {
  let homeDir: string | undefined;

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  async function prepare(): Promise<{ path: string; index: ManagedSkillIndex }> {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-index-codec-'));
    establishManagedSkillStore(homeDir);
    const index = validIndex();
    writeManagedSkillIndex(index, homeDir);
    return { path: getManagedSkillIndexPath(homeDir), index };
  }

  it('accepts an exact bounded signed owner/server binding', async () => {
    const { index } = await prepare();
    expect(readManagedSkillIndex(homeDir)).toEqual(index);
  });

  it('fails closed on unknown readiness/authority fields without letting mutation overwrite the file', async () => {
    const { path, index } = await prepare();
    const forged = structuredClone(index) as ManagedSkillIndex & { entries: Array<Record<string, unknown>> };
    forged.entries[0]!.readiness = 'ready';
    await writeFile(path, JSON.stringify(forged), 'utf8');
    const before = await readFile(path);

    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
    expect(() => updateManagedSkillEntry(REGISTRY_ID, (entry) => ({ ...entry, revision: 999 }), homeDir))
      .toThrow('Invalid managed Skill index');
    expect(() => writeManagedSkillIndex(index, homeDir)).toThrow('Invalid managed Skill index');
    await expect(readFile(path)).resolves.toEqual(before);
  });

  it('rejects cross-owner, cross-server, and forged binding digests', async () => {
    const { path, index } = await prepare();
    const cases = [
      (candidate: ManagedSkillIndex): void => {
        candidate.entries[0]!.bindings[0]!.ownerId = 'different-owner';
      },
      (candidate: ManagedSkillIndex): void => {
        candidate.entries[0]!.bindings[0]!.serverId = 'different-server';
      },
      (candidate: ManagedSkillIndex): void => {
        candidate.entries[0]!.bindings[0]!.authorization = {
          ...candidate.entries[0]!.bindings[0]!.authorization!,
          bindingDigest: 'f'.repeat(64),
        } as CapabilitySkillAuthorizationEnvelope;
      },
    ];

    for (const mutate of cases) {
      const candidate = structuredClone(index);
      mutate(candidate);
      await writeFile(path, JSON.stringify(candidate), 'utf8');
      expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
    }
  });

  it('caps index reads before JSON parsing and preserves the oversized file', async () => {
    const { path, index } = await prepare();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(CAPABILITY_LIMITS.PACKAGE_BYTES + 1, 0x20));
    const before = await stat(path);

    expect(readManagedSkillIndex(homeDir).entries).toEqual([]);
    expect(() => writeManagedSkillIndex(index, homeDir)).toThrow('Invalid managed Skill index');
    await expect(stat(path)).resolves.toMatchObject({ size: before.size });
  });
});
