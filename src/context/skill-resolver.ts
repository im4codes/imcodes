import { readFileSync } from 'node:fs';
import type { ContextNamespace } from '../../shared/context-types.js';
import { renderSkillEnvelope } from '../../shared/skill-envelope.js';
import { skillRegistryEntryToSource, type SkillRegistryEntry } from '../../shared/skill-registry-types.js';
import { parseSkillMarkdown, type SkillProjectContext } from '../../shared/skill-store.js';
import { resolveSkillSelection } from '../../shared/skill-precedence.js';
import { getSkillRegistrySnapshot } from './skill-registry.js';
import { incrementCounter } from '../util/metrics.js';
import { assertManagedSkillPathSync, ManagedSkillPathError } from './managed-skill-path.js';

export type SkillResolveFailureReason = 'unknown_key' | 'stale_registry' | 'unauthorized' | 'oversize' | 'read_failed' | 'sanitize_rejected';

export type SkillResolveResult =
  | { ok: true; key: string; layer: string; path: string; text: string; entry: SkillRegistryEntry }
  | { ok: false; key: string; reason: SkillResolveFailureReason };

export interface SkillResolveOptions {
  namespace: ContextNamespace;
  key: string;
  projectDir?: string;
  homeDir?: string;
  maxBytes?: number;
}

function projectContext(namespace: ContextNamespace, projectDir?: string): SkillProjectContext {
  return {
    canonicalRepoId: namespace.projectId,
    projectId: namespace.projectId,
    workspaceId: namespace.workspaceId,
    orgId: namespace.enterpriseId,
    rootPath: projectDir,
  };
}

function chooseEntry(options: SkillResolveOptions): SkillRegistryEntry | undefined {
  const snapshot = getSkillRegistrySnapshot({
    namespace: options.namespace,
    projectDir: options.projectDir,
    homeDir: options.homeDir,
  });
  const sources = snapshot.entries.map((entry) => skillRegistryEntryToSource(entry));
  const selected = resolveSkillSelection(sources, projectContext(options.namespace, options.projectDir)).selected;
  const selectedSource = selected.find((entry) => entry.key === options.key.trim());
  if (!selectedSource) return undefined;
  return snapshot.entries.find((entry) => entry.key === selectedSource.key && entry.layer === selectedSource.effectiveLayer);
}

export function resolveSkillByKey(options: SkillResolveOptions): SkillResolveResult {
  const key = options.key.trim();
  const entry = chooseEntry({ ...options, key });
  if (!entry?.path) {
    incrementCounter('mem.skill.resolver_miss', { reason: 'unknown_key' });
    return { ok: false, key, reason: 'unknown_key' };
  }
  let managedPath;
  try {
    managedPath = assertManagedSkillPathSync({
      path: entry.path,
      projectDir: options.projectDir,
      homeDir: options.homeDir,
      maxBytes: options.maxBytes,
    });
  } catch (error) {
    const reason = error instanceof ManagedSkillPathError && error.reason === 'oversize'
      ? 'oversize'
      : (error instanceof ManagedSkillPathError && error.reason === 'not_file' ? 'stale_registry' : 'unauthorized');
    incrementCounter('mem.skill.resolver_miss', { reason });
    return { ok: false, key, reason };
  }
  try {
    const markdown = readFileSync(managedPath.realPath, 'utf8');
    const parsed = parseSkillMarkdown(markdown, { name: entry.metadata.name, category: entry.metadata.category });
    try {
      return {
        ok: true,
        key,
        layer: entry.layer,
        path: entry.displayPath,
        text: renderSkillEnvelope(parsed.content, { maxBytes: options.maxBytes }),
        entry,
      };
    } catch {
      incrementCounter('mem.skill.sanitize_rejected', { source: 'skill_resolver' });
      return { ok: false, key, reason: 'sanitize_rejected' };
    }
  } catch {
    incrementCounter('mem.skill.resolver_miss', { reason: 'read_failed' });
    return { ok: false, key, reason: 'read_failed' };
  }
}

export function resolveSkillsForTurn(input: Omit<SkillResolveOptions, 'key'> & { prompt: string; maxSkills?: number }): SkillResolveResult[] {
  const prompt = input.prompt.toLowerCase();
  const snapshot = getSkillRegistrySnapshot({ namespace: input.namespace, projectDir: input.projectDir, homeDir: input.homeDir });
  const keys = snapshot.entries
    .filter((entry) => {
      const haystack = [entry.key, entry.metadata.name, entry.metadata.category, entry.metadata.description, ...(entry.triggerKeywords ?? [])]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return haystack.split(/\s+/).some((token) => token.length >= 3 && prompt.includes(token));
    })
    .map((entry) => entry.key);
  return [...new Set(keys)].slice(0, Math.max(1, input.maxSkills ?? 3)).map((key) => resolveSkillByKey({ ...input, key }));
}
