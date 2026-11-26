import { homedir } from 'node:os';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  MEMORY_FEATURE_FLAGS,
  MEMORY_FEATURE_FLAGS_BY_NAME,
  memoryFeatureFlagEnvKey,
  resolveEffectiveMemoryFeatureFlagValue,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagValues,
} from '../../shared/feature-flags.js';
import { computeMemoryFingerprint } from '../../shared/memory-fingerprint.js';
import { violatesSkillSystemInstructionGuard } from '../../shared/skill-envelope.js';
import { skillRegistryEntryToSource } from '../../shared/skill-registry-types.js';
import type { SkillProjectContext } from '../../shared/skill-store.js';
import {
  CAPABILITY_CANONICAL_INSTALL_POLICY,
  MANAGED_SKILL_PROVIDER_COMPATIBILITY,
} from '../../shared/capability-management.js';
import {
  resolveSkillSelection,
  type SelectedSkill,
} from '../../shared/skill-precedence.js';
import type { StartupMemoryCandidate } from './startup-memory.js';
import { getSkillRegistrySnapshot } from './skill-registry.js';
import { incrementCounter } from '../util/metrics.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import {
  getMemoryFeatureConfigStoreDiagnostics,
  getPersistedMemoryFeatureFlagValues,
  getRuntimeMemoryFeatureFlagValues,
} from '../store/memory-feature-config-store.js';
import {
  readManagedSkillIndex,
} from '../capability/managed-skill-store.js';
import { selectAuthorizedManagedSkillVersion } from './skill-resolver.js';

const SKILL_STARTUP_SOURCE = 'skill-startup-registry';

export interface SkillStartupContextOptions {
  namespace: ContextNamespace;
  /** Authenticated ServerLink account identity; never derived from model input. */
  trustedOwnerId?: string;
  /** Exact IM.codes session identity required for session-scoped bindings. */
  sessionId?: string;
  /** Exact provider and daemon identities required by non-empty binding dimensions. */
  providerId?: string;
  serverId?: string;
  projectDir?: string;
  homeDir?: string;
  featureEnabled?: boolean;
}

function isSkillsFeatureEnabled(): boolean {
  const flag = MEMORY_FEATURE_FLAGS_BY_NAME.skills;
  const environmentStartupDefault = Object.fromEntries(
    MEMORY_FEATURE_FLAGS.flatMap((candidate): Array<[MemoryFeatureFlag, boolean]> => {
      const raw = process.env[memoryFeatureFlagEnvKey(candidate)];
      return raw == null ? [] : [[candidate, raw === 'true' || raw === '1']];
    }),
  ) as MemoryFeatureFlagValues;
  return resolveEffectiveMemoryFeatureFlagValue(flag, {
    runtimeConfigOverride: getRuntimeMemoryFeatureFlagValues(),
    persistedConfig: getPersistedMemoryFeatureFlagValues(),
    environmentStartupDefault,
    readFailed: !!getMemoryFeatureConfigStoreDiagnostics().lastLoadIssue,
  });
}

function skillProjectContext(namespace: ContextNamespace, projectDir?: string): SkillProjectContext {
  return {
    canonicalRepoId: namespace.projectId,
    projectId: namespace.projectId,
    workspaceId: namespace.workspaceId,
    orgId: namespace.enterpriseId,
    rootPath: projectDir,
  };
}

function sanitizeSkillDescriptor(value: string | undefined): string | undefined {
  const oneLine = value?.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  if (violatesSkillSystemInstructionGuard(oneLine)) return undefined;
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine;
}

function renderSkillReference(entry: SelectedSkill): string {
  const metadata = entry.source.metadata;
  const description = sanitizeSkillDescriptor(metadata.description);
  const path = entry.source.path ?? '(unavailable)';
  return [
    `skill: ${entry.key}`,
    `layer: ${entry.effectiveLayer}`,
    `selection: ${entry.selectionKind}`,
    `path: ${path}`,
    ...(description ? [`description: ${description}`] : []),
    'instruction: This is a registry hint only. Read this skill only when the current task is relevant; do not assume or execute its body until explicitly read.',
  ].join('\n');
}

function normalizeSkillIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function collectManagedSkillCandidates(options: SkillStartupContextOptions): Array<StartupMemoryCandidate & { skillName: string }> {
  const homeDir = options.homeDir ?? homedir();
  const candidates: Array<StartupMemoryCandidate & { skillName: string }> = [];
  for (const entry of readManagedSkillIndex(homeDir).entries) {
    if (entry.state !== 'active') continue;
    try {
      const selected = selectAuthorizedManagedSkillVersion(entry, options);
      if (!selected) continue;
      const description = sanitizeSkillDescriptor(selected.description);
      const generationId = selected.generationId;
      candidates.push({
        id: `skill:managed:${generationId}`,
        source: 'skill',
        skillName: selected.name,
        text: [
          `skill: managed/${selected.name}`,
          'layer: managed_registry',
          `version: ${selected.versionId}`,
          'provenance: verified-managed-package',
          `generation: ${generationId}`,
          ...(description ? [`description: ${description}`] : []),
          `capability-policy: ${CAPABILITY_CANONICAL_INSTALL_POLICY}`,
          `lifecycle-hot-resume: ${MANAGED_SKILL_PROVIDER_COMPATIBILITY.HOT_RESUME}`,
          `lifecycle-compaction: ${MANAGED_SKILL_PROVIDER_COMPATIBILITY.COMPACTION}`,
          `capability-id: ${entry.registryId}`,
          'activation: This startup entry is metadata only. When the user asks to use this Skill, call capability_status with this exact capability-id and activate:true to obtain the currently authorized bounded instructions.',
          `resources: Additional package resources are ${MANAGED_SKILL_PROVIDER_COMPATIBILITY.PACKAGED_RESOURCES}; report that limitation instead of guessing or dereferencing paths.`,
          'lifecycle: Activation re-verifies the exact owner, scope, provider, machine, binding, version, digest, and current server authority. Never infer or read package files directly.',
        ].join('\n'),
        fingerprint: computeMemoryFingerprint({
          kind: 'skill',
          content: `managed\n${generationId}\n${selected.name}\n${selected.description}`,
        }),
      });
    } catch {
      incrementCounter('mem.skill.resolver_miss', { reason: 'invalid_managed_version' });
    }
  }
  return candidates;
}

export function collectSkillStartupCandidates(options: SkillStartupContextOptions): StartupMemoryCandidate[] {
  const featureEnabled = options.featureEnabled ?? isSkillsFeatureEnabled();
  if (!featureEnabled) return [];
  try {
    const context = skillProjectContext(options.namespace, options.projectDir);
    const snapshot = getSkillRegistrySnapshot({
      namespace: options.namespace,
      projectDir: options.projectDir,
      homeDir: options.homeDir ?? homedir(),
    });
    const managedCandidates = collectManagedSkillCandidates(options);
    if (snapshot.entries.length === 0) return managedCandidates;
    const sources = snapshot.entries.map((entry) => skillRegistryEntryToSource(entry, { displayPath: true }));
    const selection = resolveSkillSelection(sources, context);
    const managedNames = new Set(managedCandidates.map((entry) => normalizeSkillIdentity(entry.skillName)));
    const legacyCandidates = selection.selected
      .filter((entry) => !managedNames.has(normalizeSkillIdentity(entry.source.metadata.name)))
      .map((entry): StartupMemoryCandidate => ({
      id: `skill:${entry.effectiveLayer}:${entry.key}`,
      source: 'skill',
      text: renderSkillReference(entry),
      fingerprint: computeMemoryFingerprint({
        kind: 'skill',
        content: `${entry.selectionKind}\n${entry.effectiveLayer}\n${entry.key}\n${entry.source.path ?? ''}`,
      }),
      }));
    return [...managedCandidates, ...legacyCandidates];
  } catch (error) {
    incrementCounter('mem.startup.silent_failure', { source: SKILL_STARTUP_SOURCE });
    warnOncePerHour('skill_startup.registry_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export const SKILL_STARTUP_CONTEXT_TESTING = {
  skillProjectContext,
};
