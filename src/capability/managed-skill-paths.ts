import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getUserSkillRoot } from '../../shared/skill-store.js';
import {
  MANAGED_SKILL_ROOT_SEGMENTS,
  MANAGED_SKILL_STORE_MARKER,
} from '../../shared/capability-management.js';

export const MANAGED_SKILL_DIRECTORY = MANAGED_SKILL_ROOT_SEGMENTS.at(-1)!;
export const MANAGED_SKILL_MARKER = MANAGED_SKILL_STORE_MARKER;
export const MANAGED_SKILL_INDEX = '.imcodes-managed-index.json' as const;
export const MANAGED_SKILL_MANIFEST_SUFFIX = '.imcodes-manifest.json' as const;
export const CAPABILITY_QUARANTINE_DIRECTORY = 'capability-quarantine' as const;
export const MANAGED_SKILL_TRASH_DIRECTORY = 'managed-skill-trash' as const;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export type ManagedSkillPathErrorCode =
  | 'invalid_opaque_id'
  | 'managed_root_collision'
  | 'outside_managed_root';

export class ManagedSkillStorePathError extends Error {
  constructor(readonly code: ManagedSkillPathErrorCode, message: string = code) {
    super(message);
    this.name = 'ManagedSkillStorePathError';
  }
}

export function assertOpaqueCapabilityId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new ManagedSkillStorePathError('invalid_opaque_id', `Invalid ${label}`);
  }
  return value;
}

export function getManagedSkillRoot(homeDir = homedir()): string {
  return join(getUserSkillRoot(homeDir), MANAGED_SKILL_DIRECTORY);
}

export function getManagedSkillMarkerPath(homeDir = homedir()): string {
  return join(getManagedSkillRoot(homeDir), MANAGED_SKILL_MARKER);
}

export function getManagedSkillIndexPath(homeDir = homedir()): string {
  return join(getManagedSkillRoot(homeDir), MANAGED_SKILL_INDEX);
}

export function getManagedSkillRegistryRoot(homeDir: string, registryId: string): string {
  return join(getManagedSkillRoot(homeDir), assertOpaqueCapabilityId(registryId, 'registry ID'));
}

export function getManagedSkillVersionPath(homeDir: string, registryId: string, versionId: string): string {
  return join(
    getManagedSkillRegistryRoot(homeDir, registryId),
    assertOpaqueCapabilityId(versionId, 'version ID'),
  );
}

export function getManagedSkillManifestPath(homeDir: string, registryId: string, versionId: string): string {
  return join(
    getManagedSkillRegistryRoot(homeDir, registryId),
    `${assertOpaqueCapabilityId(versionId, 'version ID')}${MANAGED_SKILL_MANIFEST_SUFFIX}`,
  );
}

export function getCapabilityQuarantineRoot(homeDir = homedir()): string {
  return join(homeDir, '.imcodes', CAPABILITY_QUARANTINE_DIRECTORY);
}

export function getManagedSkillTrashRoot(homeDir = homedir()): string {
  return join(homeDir, '.imcodes', MANAGED_SKILL_TRASH_DIRECTORY);
}

export function isManagedSkillStoreEstablished(homeDir = homedir()): boolean {
  try {
    return readFileSync(getManagedSkillMarkerPath(homeDir), 'utf8').trim() === MANAGED_SKILL_MARKER;
  } catch {
    return false;
  }
}

/**
 * Claims the reserved managed subtree without ever hiding pre-existing user
 * content. An existing non-empty unmarked directory is a hard collision.
 */
export function establishManagedSkillStore(homeDir = homedir()): string {
  const root = getManagedSkillRoot(homeDir);
  const marker = getManagedSkillMarkerPath(homeDir);
  if (isManagedSkillStoreEstablished(homeDir)) return root;
  if (existsSync(root) && !isManagedSkillStoreEstablished(homeDir)) {
    const existing = readdirSync(root);
    if (existing.length > 0) {
      throw new ManagedSkillStorePathError(
        'managed_root_collision',
        'The reserved managed Skill directory contains pre-existing user content',
      );
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(marker, `${MANAGED_SKILL_MARKER}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return root;
}

export function assertPathInsideManagedRoot(path: string, homeDir = homedir()): string {
  const root = resolve(getManagedSkillRoot(homeDir));
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ManagedSkillStorePathError('outside_managed_root');
  }
  return target;
}
