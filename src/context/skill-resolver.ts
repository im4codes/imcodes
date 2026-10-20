import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ContextNamespace } from '../../shared/context-types.js';
import { renderSkillEnvelope } from '../../shared/skill-envelope.js';
import { skillRegistryEntryToSource, type SkillRegistryEntry } from '../../shared/skill-registry-types.js';
import { parseSkillMarkdown, type SkillProjectContext } from '../../shared/skill-store.js';
import { resolveSkillSelection } from '../../shared/skill-precedence.js';
import { getSkillRegistrySnapshot } from './skill-registry.js';
import { incrementCounter } from '../util/metrics.js';
import { assertManagedSkillPathSync, ManagedSkillPathError } from './managed-skill-path.js';
import { MANAGED_SKILL_PACKAGE_LIMITS, parseAgentSkillMarkdown } from '../capability/agent-skill-package.js';
import {
  readManagedSkillIndex,
  readVerifiedManagedSkillFile,
  verifyManagedSkillVersion,
} from '../capability/managed-skill-store.js';
import { getManagedSkillVersionPath } from '../capability/managed-skill-paths.js';
import { managedSkillBindingApplies } from '../capability/managed-skill-binding.js';
import { verifyCapabilitySkillAuthorization } from '../capability/capability-authorization.js';
import type { ManagedSkillBinding, ManagedSkillIndexEntry } from '../capability/managed-skill-store.js';

export type SkillResolveFailureReason = 'unknown_key' | 'stale_registry' | 'stale_generation' | 'unauthorized' | 'oversize' | 'read_failed' | 'sanitize_rejected';

export type SkillResolveResult =
  | { ok: true; key: string; layer: string; path: string; text: string; entry?: SkillRegistryEntry; generationId?: string; registryId?: string; versionId?: string }
  | { ok: false; key: string; reason: SkillResolveFailureReason };

export interface SkillResolveOptions {
  namespace: ContextNamespace;
  /** Authenticated ServerLink account identity; never model supplied. */
  trustedOwnerId?: string;
  /** Exact IM.codes session identity required for session-scoped bindings. */
  sessionId?: string;
  /** Exact provider and daemon identities required by non-empty binding dimensions. */
  providerId?: string;
  serverId?: string;
  key: string;
  projectDir?: string;
  homeDir?: string;
  maxBytes?: number;
  generationId?: string;
}

export interface ManagedSkillResourceReadOptions extends SkillResolveOptions {
  resourcePath: string;
}

export type ManagedSkillResourceReadResult =
  | { ok: true; key: string; generationId: string; path: string; content: Buffer }
  | { ok: false; key: string; reason: SkillResolveFailureReason };

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

function chooseManagedEntry(options: SkillResolveOptions): {
  registryId: string;
  versionId: string;
  name: string;
  description: string;
  generationId: string;
} | undefined {
  const requested = options.key.trim();
  for (const entry of readManagedSkillIndex(options.homeDir).entries) {
    if (entry.state !== 'active') continue;
    const selected = selectAuthorizedManagedSkillVersion(entry, options, requested);
    if (selected) return { registryId: entry.registryId, ...selected };
  }
  return undefined;
}

export function selectAuthorizedManagedSkillVersion(
  entry: ManagedSkillIndexEntry,
  options: Omit<SkillResolveOptions, 'key'>,
  requested?: string,
): { versionId: string; name: string; description: string; generationId: string } | undefined {
  const candidates = entry.bindings
    .filter((binding) => binding.active !== false && binding.removed !== true && managedSkillBindingApplies(binding, options))
    .map((binding) => ({ binding, versionId: binding.versionId || entry.activeVersionId }))
    .filter((candidate): candidate is { binding: ManagedSkillBinding; versionId: string } => Boolean(candidate.versionId))
    .sort((left, right) => {
      const rank = (scope: ManagedSkillBinding['scope']): number => scope === 'session' ? 4
        : scope === 'project' ? 3 : scope === 'account' ? 2 : 1;
      return rank(right.binding.scope) - rank(left.binding.scope)
        || (left.binding.bindingId ?? '').localeCompare(right.binding.bindingId ?? '');
    });
  for (const candidate of candidates) {
    try {
      const manifest = verifyManagedSkillVersion(options.homeDir ?? homedir(), entry.registryId, candidate.versionId);
      if (requested && requested !== `managed/${manifest.name}` && requested !== entry.registryId && requested !== manifest.name) continue;
      if (!managedBindingAuthorizationValid(entry.registryId, candidate.versionId, candidate.binding, manifest, options)) continue;
      return {
        versionId: candidate.versionId,
        name: manifest.name,
        description: manifest.description,
        generationId: `${entry.registryId}:${candidate.versionId}:${manifest.treeDigest}`,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function managedBindingAuthorizationValid(
  registryId: string,
  versionId: string,
  binding: ManagedSkillBinding,
  manifest: ReturnType<typeof verifyManagedSkillVersion>,
  options: Omit<SkillResolveOptions, 'key'>,
): boolean {
  const ownerId = options.trustedOwnerId ?? options.namespace.userId;
  if (!ownerId || !options.serverId
    || !binding.bindingId || binding.versionId !== versionId || !binding.authorization) return false;
  return verifyCapabilitySkillAuthorization({
    ownerId,
    serverId: options.serverId,
    capabilityId: registryId,
    version: {
      id: versionId,
      artifactDigest: manifest.treeDigest,
      auditDigest: manifest.auditDigest,
      ...(binding.authorization.blobDigest ? { blobDigest: binding.authorization.blobDigest } : {}),
    },
    binding: {
      id: binding.bindingId,
      capabilityId: registryId,
      versionId,
      scope: binding.scope,
      ...(binding.scope === 'local' && binding.serverId ? { scopeId: binding.serverId } : {}),
      ...(binding.scope === 'project' && binding.projectId ? { scopeId: binding.projectId } : {}),
      ...(binding.scope === 'session' && binding.sessionId ? { scopeId: binding.sessionId } : {}),
      providers: binding.providers ?? [],
      machines: binding.machines ?? [],
      active: binding.active !== false && binding.removed !== true,
      authorization: binding.authorization,
    },
    envelope: binding.authorization,
  });
}

function resolveManagedSkill(options: SkillResolveOptions): SkillResolveResult | undefined {
  const managed = chooseManagedEntry(options);
  if (!managed) return undefined;
  if (options.generationId && options.generationId !== managed.generationId) {
    return { ok: false, key: options.key.trim(), reason: 'stale_generation' };
  }
  try {
    const { content } = readVerifiedManagedSkillFile(
      options.homeDir ?? homedir(), managed.registryId, managed.versionId, 'SKILL.md',
      MANAGED_SKILL_PACKAGE_LIMITS.maxSkillMarkdownBytes,
    );
    const markdown = content.toString('utf8');
    const parsed = parseAgentSkillMarkdown(markdown);
    return {
      ok: true,
      key: `managed/${managed.name}`,
      layer: 'managed_registry',
      path: `skill://managed/${encodeURIComponent(managed.registryId)}/${encodeURIComponent(managed.versionId)}`,
      text: renderSkillEnvelope(parsed.instructions, { maxBytes: options.maxBytes }),
      generationId: managed.generationId,
      registryId: managed.registryId,
      versionId: managed.versionId,
    };
  } catch {
    return { ok: false, key: options.key.trim(), reason: 'read_failed' };
  }
}

export function resolveSkillByKey(options: SkillResolveOptions): SkillResolveResult {
  const key = options.key.trim();
  const managed = resolveManagedSkill({ ...options, key });
  if (managed) return managed;
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

export function readManagedSkillResource(options: ManagedSkillResourceReadOptions): ManagedSkillResourceReadResult {
  const key = options.key.trim();
  const managed = chooseManagedEntry(options);
  if (!managed) return { ok: false, key, reason: 'unknown_key' };
  if (!options.generationId || options.generationId !== managed.generationId) {
    return { ok: false, key, reason: 'stale_generation' };
  }
  const manifest = verifyManagedSkillVersion(options.homeDir ?? homedir(), managed.registryId, managed.versionId);
  const manifestEntry = manifest.files.find((entry) => entry.path === options.resourcePath);
  if (!manifestEntry) return { ok: false, key, reason: 'unauthorized' };
  const packageRoot = resolve(getManagedSkillVersionPath(options.homeDir ?? homedir(), managed.registryId, managed.versionId));
  const target = resolve(packageRoot, options.resourcePath);
  const rel = relative(packageRoot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, key, reason: 'unauthorized' };
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifestEntry.size) {
      return { ok: false, key, reason: 'unauthorized' };
    }
    const realRoot = realpathSync(packageRoot);
    const realTarget = realpathSync(target);
    const realRel = relative(realRoot, realTarget);
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) return { ok: false, key, reason: 'unauthorized' };
    const content = readFileSync(realTarget);
    if (content.length !== manifestEntry.size) return { ok: false, key, reason: 'stale_registry' };
    if (createHash('sha256').update(content).digest('hex') !== manifestEntry.sha256) {
      return { ok: false, key, reason: 'stale_registry' };
    }
    return { ok: true, key, generationId: managed.generationId, path: options.resourcePath, content };
  } catch {
    return { ok: false, key, reason: 'read_failed' };
  }
}

export function resolveSkillsForTurn(input: Omit<SkillResolveOptions, 'key'> & { prompt: string; maxSkills?: number }): SkillResolveResult[] {
  const prompt = input.prompt.toLowerCase();
  const snapshot = getSkillRegistrySnapshot({ namespace: input.namespace, projectDir: input.projectDir, homeDir: input.homeDir });
  const managedKeys = readManagedSkillIndex(input.homeDir).entries.flatMap((entry) => {
    if (entry.state !== 'active') return [];
    const candidate = entry.bindings.find((binding) => binding.active !== false && binding.removed !== true
      && managedSkillBindingApplies(binding, input) && Boolean(binding.versionId || entry.activeVersionId));
    if (!candidate) return [];
    const resolved = chooseManagedEntry({ ...input, key: entry.registryId });
    return resolved && (prompt.includes(resolved.name.toLowerCase()) || prompt.includes(resolved.description.toLowerCase()))
      ? [`managed/${resolved.name}`]
      : [];
  });
  const keys = snapshot.entries
    .filter((entry) => {
      const haystack = [entry.key, entry.metadata.name, entry.metadata.category, entry.metadata.description, ...(entry.triggerKeywords ?? [])]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return haystack.split(/\s+/).some((token) => token.length >= 3 && prompt.includes(token));
    })
    .map((entry) => entry.key);
  return [...new Set([...managedKeys, ...keys])].slice(0, Math.max(1, input.maxSkills ?? 3)).map((key) => resolveSkillByKey({ ...input, key }));
}
