export interface ProviderQuotaWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface ProviderQuotaMeta {
  primary?: ProviderQuotaWindow | null;
  secondary?: ProviderQuotaWindow | null;
}

function formatPercent(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatWindowDuration(value: number | undefined, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  const rounded = Math.max(1, Math.round(value));
  if (rounded % (60 * 24) === 0) return `${rounded / (60 * 24)}d`;
  if (rounded % 60 === 0) return `${rounded / 60}h`;
  return `${rounded}m`;
}

export function formatRemainingTime(epochSeconds: number | undefined, nowMs = Date.now()): string | undefined {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return undefined;
  const diffMs = Math.max(0, epochSeconds * 1000 - nowMs);
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

export function formatResetDateTime(epochSeconds: number | undefined): string | undefined {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return undefined;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

function formatQuotaWindow(window: ProviderQuotaWindow | null | undefined, fallbackWindowLabel: string, nowMs: number): string | undefined {
  if (!window) return undefined;
  const parts = [
    formatWindowDuration(window.windowDurationMins, fallbackWindowLabel),
    formatPercent(window.usedPercent) ?? '—',
  ];
  const remaining = formatRemainingTime(window.resetsAt, nowMs);
  const resetAt = formatResetDateTime(window.resetsAt);
  if (remaining) parts.push(remaining);
  if (resetAt) parts.push(resetAt);
  return parts.join(' ');
}

export function formatProviderQuotaLabel(
  meta: ProviderQuotaMeta | null | undefined,
  nowMs = Date.now(),
  labels: { primary: string; secondary: string } = { primary: '5h', secondary: '7d' },
): string | undefined {
  const parts = [
    formatQuotaWindow(meta?.primary, labels.primary, nowMs),
    formatQuotaWindow(meta?.secondary, labels.secondary, nowMs),
  ].filter((value): value is string => !!value);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function quotaWindowEquals(a: ProviderQuotaWindow | null | undefined, b: ProviderQuotaWindow | null | undefined): boolean {
  return (a?.usedPercent ?? null) === (b?.usedPercent ?? null)
    && (a?.windowDurationMins ?? null) === (b?.windowDurationMins ?? null)
    && (a?.resetsAt ?? null) === (b?.resetsAt ?? null);
}

export function providerQuotaMetaEquals(a: ProviderQuotaMeta | null | undefined, b: ProviderQuotaMeta | null | undefined): boolean {
  return quotaWindowEquals(a?.primary, b?.primary) && quotaWindowEquals(a?.secondary, b?.secondary);
}
