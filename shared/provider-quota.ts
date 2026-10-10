export interface ProviderQuotaWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  percentPrecision?: number;
}

export interface ProviderQuotaGroup {
  id: string;
  label: string;
  primary?: ProviderQuotaWindow | null;
  secondary?: ProviderQuotaWindow | null;
}

export interface ProviderQuotaMeta {
  primary?: ProviderQuotaWindow | null;
  secondary?: ProviderQuotaWindow | null;
  groups?: ProviderQuotaGroup[];
}

function formatPercent(value: number | undefined, precision?: number): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const clamped = Math.max(0, Math.min(100, value));
  if (typeof precision === 'number' && precision >= 0) {
    return `${clamped.toFixed(precision)}%`;
  }
  return `${Math.round(clamped)}%`;
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

function formatQuotaWindow(
  window: ProviderQuotaWindow | null | undefined,
  fallbackWindowLabel: string,
  nowMs: number,
  includeResetDateTime = true,
): string | undefined {
  if (!window) return undefined;
  const parts = [formatWindowDuration(window.windowDurationMins, fallbackWindowLabel)];
  // The percent is only known for some sources (Codex always; the token-free
  // Claude rate_limit_event omits it when healthy). Show it only when present
  // rather than a bare "—" placeholder.
  const percent = formatPercent(window.usedPercent, window.percentPrecision);
  if (percent) parts.push(percent);
  const remaining = formatRemainingTime(window.resetsAt, nowMs);
  if (remaining) parts.push(remaining);
  if (includeResetDateTime) {
    const resetAt = formatResetDateTime(window.resetsAt);
    if (resetAt) parts.push(resetAt);
  }
  return parts.join(' ');
}

function formatQuotaGroup(
  group: ProviderQuotaGroup,
  nowMs: number,
  labels: { primary: string; secondary: string },
  includeResetDateTime: boolean,
): string | undefined {
  const windowParts = [
    formatQuotaWindow(group.primary, labels.primary, nowMs, includeResetDateTime),
    formatQuotaWindow(group.secondary, labels.secondary, nowMs, includeResetDateTime),
  ].filter((value): value is string => !!value);
  if (windowParts.length === 0) return undefined;
  const labelPrefix = group.label ? `${group.label} ` : '';
  return `${labelPrefix}${windowParts.join(' · ')}`;
}

export function formatProviderQuotaLabel(
  meta: ProviderQuotaMeta | null | undefined,
  nowMs = Date.now(),
  labels: { primary: string; secondary: string } = { primary: '5h', secondary: '7d' },
): string | undefined {
  if (meta?.groups && meta.groups.length > 0) {
    const groupParts = meta.groups
      .map((group) => formatQuotaGroup(group, nowMs, labels, false))
      .filter((value): value is string => !!value);
    return groupParts.length > 0 ? groupParts.join(' | ') : undefined;
  }
  const parts = [
    formatQuotaWindow(meta?.primary, labels.primary, nowMs, true),
    formatQuotaWindow(meta?.secondary, labels.secondary, nowMs, true),
  ].filter((value): value is string => !!value);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function formatProviderQuotaTitle(
  meta: ProviderQuotaMeta | null | undefined,
  nowMs = Date.now(),
  labels: { primary: string; secondary: string } = { primary: '5h', secondary: '7d' },
): string | undefined {
  if (meta?.groups && meta.groups.length > 0) {
    const groupLines = meta.groups
      .map((group) => formatQuotaGroup(group, nowMs, labels, true))
      .filter((value): value is string => !!value);
    return groupLines.length > 0 ? groupLines.join('\n') : undefined;
  }
  const parts = [
    formatQuotaWindow(meta?.primary, labels.primary, nowMs, true),
    formatQuotaWindow(meta?.secondary, labels.secondary, nowMs, true),
  ].filter((value): value is string => !!value);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function quotaWindowEquals(a: ProviderQuotaWindow | null | undefined, b: ProviderQuotaWindow | null | undefined): boolean {
  return (a?.usedPercent ?? null) === (b?.usedPercent ?? null)
    && (a?.windowDurationMins ?? null) === (b?.windowDurationMins ?? null)
    && (a?.resetsAt ?? null) === (b?.resetsAt ?? null)
    && (a?.percentPrecision ?? null) === (b?.percentPrecision ?? null);
}

function quotaGroupEquals(a: ProviderQuotaGroup, b: ProviderQuotaGroup): boolean {
  return a.id === b.id
    && a.label === b.label
    && quotaWindowEquals(a.primary, b.primary)
    && quotaWindowEquals(a.secondary, b.secondary);
}

function quotaGroupsEquals(a: ProviderQuotaGroup[] | undefined, b: ProviderQuotaGroup[] | undefined): boolean {
  const aLen = a?.length ?? 0;
  const bLen = b?.length ?? 0;
  if (aLen === 0 && bLen === 0) return true;
  if (aLen !== bLen || !a || !b) return false;
  for (let i = 0; i < aLen; i++) {
    if (!quotaGroupEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

export function providerQuotaMetaEquals(a: ProviderQuotaMeta | null | undefined, b: ProviderQuotaMeta | null | undefined): boolean {
  return quotaWindowEquals(a?.primary, b?.primary)
    && quotaWindowEquals(a?.secondary, b?.secondary)
    && quotaGroupsEquals(a?.groups, b?.groups);
}

export const PROVIDER_QUOTA_MAX_GROUPS = 8;
export const PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS = 64;
export const PROVIDER_QUOTA_GROUP_ID_MAX_CHARS = 64;

export function sanitizeProviderQuotaWindow(value: unknown): ProviderQuotaWindow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usedPercent = typeof raw.usedPercent === 'number' && Number.isFinite(raw.usedPercent)
    ? Math.max(0, Math.min(100, raw.usedPercent))
    : undefined;
  const windowDurationMins = typeof raw.windowDurationMins === 'number'
    && Number.isFinite(raw.windowDurationMins)
    && raw.windowDurationMins > 0
    ? raw.windowDurationMins
    : undefined;
  const resetsAt = typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0
    ? raw.resetsAt
    : undefined;
  if (usedPercent === undefined && windowDurationMins === undefined && resetsAt === undefined) return undefined;
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function sanitizeProviderQuotaGroup(value: unknown): ProviderQuotaGroup | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string') return undefined;
  const trimmedId = raw.id.trim();
  if (!trimmedId) return undefined;
  const id = trimmedId.length > PROVIDER_QUOTA_GROUP_ID_MAX_CHARS
    ? trimmedId.slice(0, PROVIDER_QUOTA_GROUP_ID_MAX_CHARS)
    : trimmedId;

  if (typeof raw.label !== 'string') return undefined;
  const trimmedLabel = raw.label.trim();
  if (!trimmedLabel) return undefined;
  const label = trimmedLabel.length > PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS
    ? trimmedLabel.slice(0, PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS)
    : trimmedLabel;

  const primary = sanitizeProviderQuotaWindow(raw.primary);
  const secondary = sanitizeProviderQuotaWindow(raw.secondary);
  if (!primary && !secondary) return undefined;
  return {
    id,
    label,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export function sanitizeProviderQuotaMeta(value: unknown): ProviderQuotaMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const primary = sanitizeProviderQuotaWindow(raw.primary);
  const secondary = sanitizeProviderQuotaWindow(raw.secondary);
  const groups = Array.isArray(raw.groups)
    ? raw.groups
      .map(sanitizeProviderQuotaGroup)
      .filter((g): g is ProviderQuotaGroup => !!g)
      .slice(0, PROVIDER_QUOTA_MAX_GROUPS)
    : undefined;
  if (!primary && !secondary && (!groups || groups.length === 0)) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(groups && groups.length > 0 ? { groups } : {}),
  };
}

