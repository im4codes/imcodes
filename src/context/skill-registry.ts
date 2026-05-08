import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  SKILL_REGISTRY_FILE_NAME,
  SKILL_REGISTRY_SCHEMA_VERSION,
  makeSkillUri,
  type SkillRegistryEntry,
  type SkillRegistrySnapshot,
} from '../../shared/skill-registry-types.js';
import {
  getProjectSkillEscapeHatchDir,
  getUserSkillRoot,
  isSkillLayer,
  normalizeSkillMetadata,
  type SkillProjectContext,
} from '../../shared/skill-store.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';

const EMPTY_SNAPSHOT: SkillRegistrySnapshot = {
  schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
  generatedAt: 0,
  entries: [],
  sourceCounts: {},
};

type CacheEntry = { key: string; snapshot: SkillRegistrySnapshot };
let cache: CacheEntry | null = null;

const ALLOWED_REGISTRY_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'key',
  'layer',
  'metadata',
  'path',
  'displayPath',
  'uri',
  'fingerprint',
  'contentHash',
  'mtimeMs',
  'enforcement',
  'triggerKeywords',
  'project',
  'updatedAt',
]);

export interface SkillRegistryOptions {
  namespace: ContextNamespace;
  projectDir?: string;
  homeDir?: string;
}

function userRegistryPath(homeDir = homedir()): string {
  return join(getUserSkillRoot(homeDir), SKILL_REGISTRY_FILE_NAME);
}

function projectRegistryPath(projectDir: string | undefined): string | undefined {
  const root = projectDir?.trim();
  return root ? join(getProjectSkillEscapeHatchDir(root), SKILL_REGISTRY_FILE_NAME) : undefined;
}

function cacheKey(options: SkillRegistryOptions): string {
  return [
    options.homeDir ?? homedir(),
    options.projectDir ?? '',
    options.namespace.scope,
    options.namespace.projectId ?? '',
    options.namespace.workspaceId ?? '',
    options.namespace.enterpriseId ?? '',
    options.namespace.userId ?? '',
  ].join('\u0000');
}

function parseEntry(value: unknown): SkillRegistryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_REGISTRY_ENTRY_KEYS.has(key));
  if (unknownKey) throw new Error(`Unknown skill registry entry field: ${unknownKey}`);
  if (record.schemaVersion !== SKILL_REGISTRY_SCHEMA_VERSION) return null;
  if (typeof record.key !== 'string' || !record.key.trim()) return null;
  if (!isSkillLayer(record.layer)) return null;
  if (typeof record.displayPath !== 'string' || !record.displayPath.trim()) return null;
  if (typeof record.uri !== 'string' || !record.uri.startsWith('skill://')) return null;
  if (typeof record.fingerprint !== 'string' || !record.fingerprint.trim()) return null;
  const metadata = normalizeSkillMetadata(record.metadata as Record<string, unknown>);
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    key: record.key.trim(),
    layer: record.layer,
    metadata,
    path: typeof record.path === 'string' && record.path.trim() ? record.path : undefined,
    displayPath: sanitizeRegistryDisplayPath(record.displayPath, makeSkillUri(record.layer, record.key.trim())),
    uri: record.uri as SkillRegistryEntry['uri'],
    fingerprint: record.fingerprint.trim(),
    contentHash: typeof record.contentHash === 'string' && record.contentHash.trim() ? record.contentHash : undefined,
    mtimeMs: typeof record.mtimeMs === 'number' && Number.isFinite(record.mtimeMs) ? record.mtimeMs : undefined,
    enforcement: record.enforcement === 'additive' || record.enforcement === 'enforced' ? record.enforcement : undefined,
    triggerKeywords: Array.isArray(record.triggerKeywords)
      ? record.triggerKeywords.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
      : undefined,
    project: record.project && typeof record.project === 'object' && !Array.isArray(record.project)
      ? record.project as SkillProjectContext
      : undefined,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  };
}

function sanitizeRegistryDisplayPath(displayPath: string, fallbackUri: SkillRegistryEntry['uri']): string {
  const trimmed = displayPath.trim();
  if (!trimmed || trimmed.includes('\u0000')) return fallbackUri;
  if (trimmed.startsWith('skill://')) return trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || isAbsolute(trimmed)) return fallbackUri;
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return fallbackUri;
  return trimmed;
}

function readRegistryFile(path: string | undefined): SkillRegistryEntry[] {
  if (!path || !existsSync(path)) return [];
  try {
    const stat = statSync(path);
    if (stat.size > MEMORY_DEFAULTS.skillRegistryMaxBytes) {
      incrementCounter('mem.skill.registry_oversize', { source: 'skill_registry_read' });
      warnOncePerHour('skill_registry.oversize', { path, size: stat.size, maxBytes: MEMORY_DEFAULTS.skillRegistryMaxBytes });
      return [];
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const entries = typeof parsed === 'object' && parsed && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
    if (entries.length > MEMORY_DEFAULTS.skillRegistryMaxEntries) {
      incrementCounter('mem.skill.registry_oversize', { source: 'skill_registry_entries' });
      warnOncePerHour('skill_registry.too_many_entries', { path, entries: entries.length, maxEntries: MEMORY_DEFAULTS.skillRegistryMaxEntries });
      return [];
    }
    return entries.flatMap((entry) => {
      try {
        const parsed = parseEntry(entry);
        return parsed ? [parsed] : [];
      } catch (error) {
        incrementCounter('mem.skill.sanitize_rejected', { source: 'skill_registry_entry' });
        warnOncePerHour('skill_registry.entry_rejected', { path, error: error instanceof Error ? error.message : String(error) });
        return [];
      }
    });
  } catch (error) {
    incrementCounter('mem.skill.sanitize_rejected', { source: 'skill_registry_read' });
    warnOncePerHour('skill_registry.read_failed', { path, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function namespaceMatches(entry: SkillRegistryEntry, namespace: ContextNamespace): boolean {
  const project = entry.metadata.project ?? entry.project;
  if (!project) return true;
  if (project.canonicalRepoId && project.canonicalRepoId !== namespace.projectId) return false;
  if (project.projectId && project.projectId !== namespace.projectId) return false;
  if (project.workspaceId && project.workspaceId !== namespace.workspaceId) return false;
  if (project.orgId && project.orgId !== namespace.enterpriseId) return false;
  return true;
}

function mergeEntries(entries: SkillRegistryEntry[]): SkillRegistryEntry[] {
  const byIdentity = new Map<string, SkillRegistryEntry>();
  for (const entry of entries) {
    const id = `${entry.layer}\u0000${entry.key}\u0000${entry.path ?? entry.uri}`;
    const prior = byIdentity.get(id);
    if (!prior || entry.updatedAt >= prior.updatedAt) byIdentity.set(id, entry);
  }
  return [...byIdentity.values()].sort((a, b) => `${a.layer}:${a.key}`.localeCompare(`${b.layer}:${b.key}`));
}

export function getSkillRegistrySnapshot(options: SkillRegistryOptions): SkillRegistrySnapshot {
  const key = cacheKey(options);
  if (cache?.key === key) return cache.snapshot;
  const entries = mergeEntries([
    ...readRegistryFile(projectRegistryPath(options.projectDir)),
    ...readRegistryFile(userRegistryPath(options.homeDir)),
  ]).filter((entry) => namespaceMatches(entry, options.namespace));
  const snapshot: SkillRegistrySnapshot = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries,
    sourceCounts: entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.layer] = (acc[entry.layer] ?? 0) + 1;
      return acc;
    }, {}),
  };
  cache = { key, snapshot };
  return snapshot;
}

export function getSkillRegistryManagementSnapshot(options: { projectDir?: string; homeDir?: string } = {}): SkillRegistrySnapshot {
  const entries = mergeEntries([
    ...readRegistryFile(projectRegistryPath(options.projectDir)),
    ...readRegistryFile(userRegistryPath(options.homeDir)),
  ]);
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries,
    sourceCounts: entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.layer] = (acc[entry.layer] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export function writeSkillRegistryManagementSnapshot(path: string, entries: SkillRegistryEntry[]): SkillRegistrySnapshot {
  const snapshot = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries: mergeEntries(entries),
  } satisfies SkillRegistrySnapshot;
  writeSnapshot(path, snapshot);
  invalidateSkillRegistryCache();
  return snapshot;
}

export function getSkillRegistryPathsForManagement(options: { projectDir?: string; homeDir?: string } = {}): {
  user: string;
  project?: string;
} {
  return {
    user: userRegistryPath(options.homeDir),
    project: projectRegistryPath(options.projectDir),
  };
}

export function invalidateSkillRegistryCache(): void {
  cache = null;
}

function readSnapshotForWrite(path: string): SkillRegistrySnapshot {
  const entries = readRegistryFile(path);
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries,
  };
}

function writeSnapshot(path: string, snapshot: SkillRegistrySnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

export function upsertUserSkillRegistryEntry(entry: SkillRegistryEntry, options: { homeDir?: string } = {}): void {
  const path = userRegistryPath(options.homeDir);
  const snapshot = readSnapshotForWrite(path);
  const nextEntries = mergeEntries([
    ...snapshot.entries.filter((existing) => !(existing.layer === entry.layer && existing.key === entry.key && existing.path === entry.path)),
    entry,
  ]);
  writeSnapshot(path, {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries: nextEntries,
  });
  invalidateSkillRegistryCache();
}

export const SKILL_REGISTRY_TESTING = {
  userRegistryPath,
  projectRegistryPath,
  parseEntry,
  readRegistryFile,
  reset: invalidateSkillRegistryCache,
};
