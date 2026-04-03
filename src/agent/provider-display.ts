import { getQwenAuthTier, QWEN_AUTH_TIERS } from '../../shared/qwen-auth.js';

export interface ProviderDisplayMetadata {
  modelDisplay?: string;
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
}

export function formatQuotaLabel(limit?: string | null): string | undefined {
  const value = limit?.trim();
  if (!value) return undefined;
  return value
    .replace(/^Up to\s+/i, '')
    .replace(/\s*requests?\s*\/\s*day/i, '/day')
    .replace(/\s*requests?\s*\/\s*minute/i, '/min');
}

export function formatQwenPlanLabel(authType?: string | null): string | undefined {
  switch (getQwenAuthTier(authType)) {
    case QWEN_AUTH_TIERS.FREE:
      return 'Free';
    case QWEN_AUTH_TIERS.PAID:
      return 'Paid';
    case QWEN_AUTH_TIERS.BYO:
      return 'BYO';
    default:
      return undefined;
  }
}

export function getQwenDisplayMetadata(opts: {
  model?: string | null;
  authType?: string | null;
  authLimit?: string | null;
  quotaUsageLabel?: string | null;
}): ProviderDisplayMetadata {
  const modelDisplay = opts.model?.trim() || undefined;
  const planLabel = formatQwenPlanLabel(opts.authType);
  const quotaLabel = formatQuotaLabel(opts.authLimit);
  return {
    ...(modelDisplay ? { modelDisplay } : {}),
    ...(planLabel ? { planLabel } : {}),
    ...(quotaLabel ? { quotaLabel } : {}),
    ...(opts.quotaUsageLabel?.trim() ? { quotaUsageLabel: opts.quotaUsageLabel.trim() } : {}),
  };
}
