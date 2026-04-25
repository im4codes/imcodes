import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import type { SessionRecord } from '../store/session-store.js';
import type { CodexRuntimeConfig } from './codex-runtime-config.js';

export type CodexDisplayFields = Pick<
  SessionRecord,
  'codexAvailableModels' | 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta'
>;

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function quotaMetaOrExisting(
  incoming: ProviderQuotaMeta | undefined,
  existing: ProviderQuotaMeta | undefined,
): ProviderQuotaMeta | undefined {
  if (incoming && (incoming.primary || incoming.secondary)) return incoming;
  return existing;
}

export function mergeCodexDisplayMetadata(
  runtime: CodexRuntimeConfig | null | undefined,
  existing?: Partial<CodexDisplayFields> | null,
): Partial<CodexDisplayFields> {
  const availableModels = runtime?.availableModels?.length
    ? runtime.availableModels
    : existing?.codexAvailableModels;
  const planLabel = nonEmpty(runtime?.planLabel) ?? nonEmpty(existing?.planLabel);
  const quotaLabel = nonEmpty(runtime?.quotaLabel) ?? nonEmpty(existing?.quotaLabel);
  const quotaUsageLabel = nonEmpty(runtime?.quotaUsageLabel) ?? nonEmpty(existing?.quotaUsageLabel);
  const quotaMeta = quotaMetaOrExisting(runtime?.quotaMeta, existing?.quotaMeta);
  return {
    ...(availableModels?.length ? { codexAvailableModels: availableModels } : {}),
    ...(planLabel ? { planLabel } : {}),
    ...(quotaLabel ? { quotaLabel } : {}),
    ...(quotaUsageLabel ? { quotaUsageLabel } : {}),
    ...(quotaMeta ? { quotaMeta } : {}),
  };
}
