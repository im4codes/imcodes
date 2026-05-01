import type {
  SkillEnforcementMode,
  SkillLayer,
  SkillMetadata,
  SkillProjectContext,
  SkillSource,
} from './skill-store.js';
import { createSkillSource } from './skill-store.js';

export const SKILL_REGISTRY_SCHEMA_VERSION = 1 as const;
export const SKILL_REGISTRY_FILE_NAME = 'registry.json' as const;
export const SKILL_URI_SCHEME = 'skill' as const;

export interface SkillRegistryEntry {
  schemaVersion: typeof SKILL_REGISTRY_SCHEMA_VERSION;
  key: string;
  layer: SkillLayer;
  metadata: SkillMetadata;
  /** Absolute local path for daemon resolution. Never render directly to provider context. */
  path?: string;
  /** Provider-safe redacted path or opaque skill:// URI. */
  displayPath: string;
  uri: `${typeof SKILL_URI_SCHEME}://${string}`;
  fingerprint: string;
  contentHash?: string;
  mtimeMs?: number;
  enforcement?: SkillEnforcementMode;
  triggerKeywords?: string[];
  project?: SkillProjectContext;
  updatedAt: number;
}

export interface SkillRegistrySnapshot {
  schemaVersion: typeof SKILL_REGISTRY_SCHEMA_VERSION;
  generatedAt: number;
  entries: SkillRegistryEntry[];
  sourceCounts?: Record<string, number>;
}

export function makeSkillUri(layer: SkillLayer, key: string): SkillRegistryEntry['uri'] {
  return `${SKILL_URI_SCHEME}://${encodeURIComponent(layer)}/${encodeURIComponent(key)}`;
}

export function skillRegistryEntryToSource(entry: SkillRegistryEntry, options: { displayPath?: boolean } = {}): SkillSource {
  return createSkillSource({
    layer: entry.layer,
    metadata: entry.metadata,
    content: '',
    path: options.displayPath ? entry.displayPath : (entry.path ?? entry.uri),
    enforcement: entry.enforcement,
  });
}
