import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemorySearchResultItem } from './memory-search.js';
import { searchLocalMemory } from './memory-search.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';

export const STARTUP_MEMORY_DURABLE_LIMIT = 7;
export const STARTUP_MEMORY_RECENT_LIMIT = 8;
export const STARTUP_MEMORY_TOTAL_LIMIT = 15;
export const STARTUP_MEMORY_STAGES = ['collect', 'prioritize', 'apply_quotas', 'trim', 'dedup', 'render'] as const;
export const STARTUP_BOOTSTRAP_SOURCES = [
  'startup_memory',
  'preferences',
  'project_context',
  'user_context',
  'skills',
] as const;
export type StartupMemoryStage = (typeof STARTUP_MEMORY_STAGES)[number];
export type StartupBootstrapSource = (typeof STARTUP_BOOTSTRAP_SOURCES)[number];
export type StartupMemorySource = 'pinned' | 'durable' | 'recent' | 'project_docs' | 'preference' | 'user_context' | 'skill';

export interface StartupMemoryCandidate {
  id: string;
  source: StartupMemorySource;
  text: string;
  updatedAt?: number;
  estimatedTokens?: number;
  fingerprint?: string;
}

export interface StartupMemoryPolicy {
  totalTokens?: number;
  pinnedTokens?: number;
  durableTokens?: number;
  recentTokens?: number;
  projectDocsTokens?: number;
  skillTokens?: number;
}

export interface StartupMemorySelectionReport {
  stages: readonly StartupMemoryStage[];
  bootstrapSources: readonly StartupBootstrapSource[];
  selected: StartupMemoryCandidate[];
  dropped: Array<{ id: string; source: StartupMemorySource; reason: 'duplicate' | 'source_quota' | 'total_budget' }>;
  usedTokens: number;
}

export interface StartupMemorySelectionOptions {
  durableLimit?: number;
  recentLimit?: number;
  totalLimit?: number;
}

function tokenEstimate(candidate: StartupMemoryCandidate): number {
  return Math.max(0, Math.ceil(candidate.estimatedTokens ?? Math.max(1, candidate.text.length / 4)));
}

function candidateFingerprint(candidate: StartupMemoryCandidate): string {
  return candidate.fingerprint ?? `${candidate.source}\u0000${normalizeSummaryForFingerprint(candidate.text)}`;
}

function quotaForSource(policy: Required<StartupMemoryPolicy>, source: StartupMemorySource): number {
  switch (source) {
    case 'pinned': return policy.pinnedTokens;
    case 'durable': return policy.durableTokens;
    case 'recent': return policy.recentTokens;
    case 'project_docs': return policy.projectDocsTokens;
    case 'preference': return policy.skillTokens;
    case 'user_context': return policy.durableTokens;
    case 'skill': return policy.skillTokens;
  }
}

const SOURCE_PRIORITY: Record<StartupMemorySource, number> = {
  pinned: 0,
  skill: 1,
  preference: 2,
  user_context: 3,
  durable: 4,
  project_docs: 5,
  recent: 6,
};

function normalizeStartupPolicy(policy: StartupMemoryPolicy = {}): Required<StartupMemoryPolicy> {
  return {
    totalTokens: policy.totalTokens ?? MEMORY_DEFAULTS.startupTotalTokens,
    pinnedTokens: policy.pinnedTokens ?? MEMORY_DEFAULTS.pinnedTokens,
    durableTokens: policy.durableTokens ?? MEMORY_DEFAULTS.durableTokens,
    recentTokens: policy.recentTokens ?? MEMORY_DEFAULTS.recentTokens,
    projectDocsTokens: policy.projectDocsTokens ?? MEMORY_DEFAULTS.projectDocsTokens,
    skillTokens: policy.skillTokens ?? MEMORY_DEFAULTS.skillTokens,
  };
}

export function selectStartupMemoryByPolicy(
  candidates: readonly StartupMemoryCandidate[],
  policyInput: StartupMemoryPolicy = {},
): StartupMemorySelectionReport {
  const policy = normalizeStartupPolicy(policyInput);
  const dropped: StartupMemorySelectionReport['dropped'] = [];
  const seen = new Set<string>();
  const usedBySource = new Map<StartupMemorySource, number>();
  const selected: StartupMemoryCandidate[] = [];
  let usedTokens = 0;

  const prioritized = [...candidates].sort((a, b) => {
    const priorityDiff = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
    if (priorityDiff !== 0) return priorityDiff;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  for (const candidate of prioritized) {
    const fingerprint = candidateFingerprint(candidate);
    if (seen.has(fingerprint)) {
      dropped.push({ id: candidate.id, source: candidate.source, reason: 'duplicate' });
      continue;
    }
    const tokens = tokenEstimate(candidate);
    const sourceUsed = usedBySource.get(candidate.source) ?? 0;
    if (sourceUsed + tokens > quotaForSource(policy, candidate.source)) {
      dropped.push({ id: candidate.id, source: candidate.source, reason: 'source_quota' });
      continue;
    }
    if (usedTokens + tokens > policy.totalTokens) {
      dropped.push({ id: candidate.id, source: candidate.source, reason: 'total_budget' });
      continue;
    }
    seen.add(fingerprint);
    usedBySource.set(candidate.source, sourceUsed + tokens);
    usedTokens += tokens;
    selected.push(candidate);
  }

  return {
    stages: STARTUP_MEMORY_STAGES,
    bootstrapSources: STARTUP_BOOTSTRAP_SOURCES,
    selected,
    dropped,
    usedTokens,
  };
}

export interface StartupBootstrapInput {
  pinned?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  durable?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  recent?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  projectContext?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  userContext?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  preferences?: readonly Omit<StartupMemoryCandidate, 'source'>[];
  skills?: readonly Omit<StartupMemoryCandidate, 'source'>[];
}

function tagStartupCandidates(
  source: StartupMemorySource,
  candidates: readonly Omit<StartupMemoryCandidate, 'source'>[] | undefined,
): StartupMemoryCandidate[] {
  return (candidates ?? []).map((candidate) => ({ ...candidate, source }));
}

/**
 * Unified Wave 4/5 bootstrap entry point.  It keeps preferences, user context,
 * project docs, current startup memory, and future skills on the same named
 * collect→prioritize→quota→trim→dedup→render path, so adding a source cannot
 * bypass budget or duplicate handling.
 */
export function buildStartupBootstrapSelection(
  input: StartupBootstrapInput,
  policyInput: StartupMemoryPolicy = {},
): StartupMemorySelectionReport {
  return selectStartupMemoryByPolicy([
    ...tagStartupCandidates('pinned', input.pinned),
    ...tagStartupCandidates('durable', input.durable),
    ...tagStartupCandidates('recent', input.recent),
    ...tagStartupCandidates('project_docs', input.projectContext),
    ...tagStartupCandidates('user_context', input.userContext),
    ...tagStartupCandidates('preference', input.preferences),
    ...tagStartupCandidates('skill', input.skills),
  ], policyInput);
}

export function selectStartupMemoryItems(
  namespace: ContextNamespace,
  options: StartupMemorySelectionOptions = {},
): MemorySearchResultItem[] {
  const durableLimit = options.durableLimit ?? STARTUP_MEMORY_DURABLE_LIMIT;
  const recentLimit = options.recentLimit ?? STARTUP_MEMORY_RECENT_LIMIT;
  const totalLimit = options.totalLimit ?? STARTUP_MEMORY_TOTAL_LIMIT;

  // Startup bootstrap is project-scoped memory loading, NOT a query-driven
  // recall. Any memory that belongs to the project's timeline is valid
  // context for session startup, including entries whose source turn was a
  // templated workflow prompt — the user still worked on this project and
  // the resulting summary is part of the project's history. Template-prompt
  // filtering is applied only on the recall/search paths.

  const durable = searchLocalMemory({
    namespace,
    projectionClass: 'durable_memory_candidate',
    limit: durableLimit,
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  const recent = searchLocalMemory({
    namespace,
    projectionClass: 'recent_summary',
    limit: Math.max(recentLimit, totalLimit),
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  // ID-based dedup was failing against duplicates produced by the old
  // writeProcessedProjection path that generated fresh UUIDs on every turn
  // for identical summary text. Pair it with a content fingerprint so
  // startup memory never dumps three copies of the same durable summary
  // into the session opener.
  const fingerprintOf = (item: MemorySearchResultItem): string => {
    const projectionClass = item.projectionClass ?? 'recent_summary';
    return `${projectionClass}\u0000${normalizeSummaryForFingerprint(item.summary ?? '')}`;
  };

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const dedupedDurable: MemorySearchResultItem[] = [];
  for (const item of durable) {
    if (seenIds.has(item.id)) continue;
    const fp = fingerprintOf(item);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(item.id);
    seenFingerprints.add(fp);
    dedupedDurable.push(item);
  }

  const selectedDurable = dedupedDurable.slice(0, Math.min(durableLimit, totalLimit));
  const remaining = Math.max(0, totalLimit - selectedDurable.length);
  const selectedRecent: MemorySearchResultItem[] = [];
  for (const item of recent) {
    if (seenIds.has(item.id)) continue;
    const fp = fingerprintOf(item);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(item.id);
    seenFingerprints.add(fp);
    selectedRecent.push(item);
    if (selectedRecent.length >= remaining) break;
  }

  return [...selectedDurable, ...selectedRecent];
}
