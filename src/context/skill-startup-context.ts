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
  resolveSkillSelection,
  type SelectedSkill,
} from '../../shared/skill-precedence.js';
import type { StartupMemoryCandidate } from './startup-memory.js';
import { getSkillRegistrySnapshot } from './skill-registry.js';
import { incrementCounter } from '../util/metrics.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';

const SKILL_STARTUP_SOURCE = 'skill-startup-registry';

export interface SkillStartupContextOptions {
  namespace: ContextNamespace;
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
    environmentStartupDefault,
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
    if (snapshot.entries.length === 0) return [];
    const sources = snapshot.entries.map((entry) => skillRegistryEntryToSource(entry, { displayPath: true }));
    const selection = resolveSkillSelection(sources, context);
    return selection.selected.map((entry): StartupMemoryCandidate => ({
      id: `skill:${entry.effectiveLayer}:${entry.key}`,
      source: 'skill',
      text: renderSkillReference(entry),
      fingerprint: computeMemoryFingerprint({
        kind: 'skill',
        content: `${entry.selectionKind}\n${entry.effectiveLayer}\n${entry.key}\n${entry.source.path ?? ''}`,
      }),
    }));
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
