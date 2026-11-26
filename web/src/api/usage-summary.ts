import {
  USAGE_SUMMARY_API_PATH,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
} from '@shared/usage-analytics.js';
import { apiFetch } from '../api.js';

export type {
  UsageSummaryQuery,
  UsageSummaryResponse,
  UsageSummaryRow,
} from '@shared/usage-analytics.js';

export async function fetchUsageSummary(query: UsageSummaryQuery = {}): Promise<UsageSummaryResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return apiFetch<UsageSummaryResponse>(suffix ? `${USAGE_SUMMARY_API_PATH}?${suffix}` : USAGE_SUMMARY_API_PATH);
}
