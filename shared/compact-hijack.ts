/**
 * Compact Hijack shared contract.
 *
 * When enabled for an owned session, non-manual context compaction triggers an
 * automatic `/handoff` conversation reset with a CrossVendorHandoffPack and
 * dispatches the standardized continuation prompt to the fresh session.
 *
 * Pure module — safe to import in daemon, server, and web.
 */

import {
  CROSS_VENDOR_HANDOFF_DEFAULTS,
  CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS,
} from './cross-vendor-handoff.js';

export const COMPACT_HIJACK_GLOBAL_PREF_KEY = 'compact_hijack.global.v1';

export const COMPACT_HIJACK_MSG = {
  APPLY: 'compact_hijack.apply',
} as const;

export const COMPACT_HIJACK_MODE = {
  INHERIT: 'inherit',
  ON: 'on',
  OFF: 'off',
} as const;

export type CompactHijackMode = (typeof COMPACT_HIJACK_MODE)[keyof typeof COMPACT_HIJACK_MODE];

export const COMPACT_HIJACK_MODES: readonly CompactHijackMode[] = [
  COMPACT_HIJACK_MODE.INHERIT,
  COMPACT_HIJACK_MODE.ON,
  COMPACT_HIJACK_MODE.OFF,
] as const;

export const COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS = [
  'handoffTextLimit',
  'handoffSummaryLimit',
  'handoffMaxChars',
] as const;

export type CompactHijackHandoffLimitField = (typeof COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS)[number];

export const COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS: Record<
  CompactHijackHandoffLimitField,
  { min: number; max: number; defaultValue: number }
> = {
  handoffTextLimit: {
    ...CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.recentTurns,
    defaultValue: CROSS_VENDOR_HANDOFF_DEFAULTS.recentTurns,
  },
  handoffSummaryLimit: {
    ...CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.summaryLimit,
    defaultValue: CROSS_VENDOR_HANDOFF_DEFAULTS.summaryLimit,
  },
  handoffMaxChars: {
    ...CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.maxChars,
    defaultValue: CROSS_VENDOR_HANDOFF_DEFAULTS.maxChars,
  },
} as const;

export interface SessionHandoffLimits {
  handoffTextLimit?: number;
  handoffSummaryLimit?: number;
  handoffMaxChars?: number;
}

export type CompactHijackHandoffLimitPatch = {
  [K in CompactHijackHandoffLimitField]?: number | null;
};

export interface CompactHijackGlobalConfig extends SessionHandoffLimits {
  enabled: boolean;
}

export const DEFAULT_COMPACT_HIJACK_GLOBAL_CONFIG: CompactHijackGlobalConfig = {
  enabled: false,
};

export const COMPACT_HIJACK_CONTINUATION_PROMPT =
  'Continue the unfinished Next Steps from the handoff context. Check running subagents/task pairs and current workspace state first; do not redo completed steps.';

/** Minimum interval between automatic compact-hijack triggers on one session. */
export const COMPACT_HIJACK_COOLDOWN_MS = 30_000;

export function isCompactHijackMode(value: unknown): value is CompactHijackMode {
  return value === COMPACT_HIJACK_MODE.INHERIT
    || value === COMPACT_HIJACK_MODE.ON
    || value === COMPACT_HIJACK_MODE.OFF;
}

export function normalizeCompactHijackMode(value: unknown): CompactHijackMode {
  return isCompactHijackMode(value) ? value : COMPACT_HIJACK_MODE.INHERIT;
}

export function isValidHandoffLimitValue(field: CompactHijackHandoffLimitField, value: unknown): value is number {
  const bounds = COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

export function normalizeHandoffLimits(raw: unknown): SessionHandoffLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const result: SessionHandoffLimits = {};
  for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
    const val = obj[field];
    if (typeof val === 'number' && Number.isFinite(val)) {
      const bounds = COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS[field];
      result[field] = Math.max(bounds.min, Math.min(bounds.max, Math.trunc(val)));
    }
  }
  return result;
}

export function normalizeCompactHijackGlobalConfig(raw: unknown): CompactHijackGlobalConfig {
  if (typeof raw === 'boolean') return { enabled: raw };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = (raw as { enabled?: unknown }).enabled;
    if (typeof enabled === 'boolean') {
      return { enabled, ...normalizeHandoffLimits(raw) };
    }
  }
  return { enabled: false };
}

export function isValidCompactHijackGlobalPrefPayload(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'boolean') return true;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.enabled !== 'boolean') return false;
    for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(obj, field)) continue;
      const val = obj[field];
      if (val !== undefined && val !== null && !isValidHandoffLimitValue(field, val)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

export function parseCompactHijackGlobalConfigJson(raw: string | null | undefined): CompactHijackGlobalConfig {
  if (!raw) return { enabled: false };
  try {
    return normalizeCompactHijackGlobalConfig(JSON.parse(raw));
  } catch {
    return { enabled: false };
  }
}

export function encodeCompactHijackGlobalConfigJson(config: CompactHijackGlobalConfig): string {
  return JSON.stringify(normalizeCompactHijackGlobalConfig(config));
}

export function extractSessionCompactHijackMode(transportConfig: unknown): CompactHijackMode {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return COMPACT_HIJACK_MODE.INHERIT;
  }
  const value = (transportConfig as Record<string, unknown>).compactHijack;
  return normalizeCompactHijackMode(value);
}

export function extractSessionHandoffLimits(transportConfig: unknown): SessionHandoffLimits {
  return normalizeHandoffLimits(transportConfig);
}

export function resolveEffectiveHandoffLimits(
  transportConfig: unknown,
  globalConfig?: CompactHijackGlobalConfig | null,
): { recentTurns: number; summaryLimit: number; maxChars: number } {
  const session = extractSessionHandoffLimits(transportConfig);
  const global = normalizeHandoffLimits(globalConfig);
  return {
    recentTurns: session.handoffTextLimit ?? global.handoffTextLimit ?? CROSS_VENDOR_HANDOFF_DEFAULTS.recentTurns,
    summaryLimit: session.handoffSummaryLimit ?? global.handoffSummaryLimit ?? CROSS_VENDOR_HANDOFF_DEFAULTS.summaryLimit,
    maxChars: session.handoffMaxChars ?? global.handoffMaxChars ?? CROSS_VENDOR_HANDOFF_DEFAULTS.maxChars,
  };
}

export function hasCompactHijackField(transportConfig: unknown): boolean {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(transportConfig, 'compactHijack')) return true;
  return COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(transportConfig, field),
  );
}

export function hasInvalidCompactHijackSetting(transportConfig: unknown): boolean {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return false;
  }
  const obj = transportConfig as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'compactHijack')) {
    const value = obj.compactHijack;
    if (value !== undefined && value !== null && !isCompactHijackMode(value)) {
      return true;
    }
  }
  for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) continue;
    const value = obj[field];
    if (value !== undefined && value !== null && !isValidHandoffLimitValue(field, value)) {
      return true;
    }
  }
  return false;
}

export function buildTransportConfigWithCompactHijack(
  existing: Record<string, unknown> | null | undefined,
  mode: CompactHijackMode,
  handoffLimits?: CompactHijackHandoffLimitPatch,
): Record<string, unknown> | null {
  const base: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {};
  if (mode === COMPACT_HIJACK_MODE.INHERIT) {
    delete base.compactHijack;
  } else {
    base.compactHijack = mode;
  }
  const sourceLimits: Record<string, unknown> = handoffLimits ?? base;
  for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(sourceLimits, field)) continue;
    const raw = sourceLimits[field];
    if (raw === undefined || raw === null) {
      delete base[field];
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      const bounds = COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS[field];
      base[field] = Math.max(bounds.min, Math.min(bounds.max, Math.trunc(raw)));
    }
  }
  return Object.keys(base).length > 0 ? base : null;
}

export function stripCompactHijackFromTransportConfig(transportConfig: unknown): Record<string, unknown> | null {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return null;
  }
  const copy = { ...(transportConfig as Record<string, unknown>) };
  delete copy.compactHijack;
  for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
    delete copy[field];
  }
  return Object.keys(copy).length > 0 ? copy : null;
}

function parseTransportConfigValue(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const candidate = JSON.parse(raw) as unknown;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/**
 * Strip `compactHijack` from serialized or object `transport_config`/`transportConfig`
 * fields on DB/response rows returned to share callers, leaving owner/admin rows untouched.
 */
export function sanitizeShareTransportConfigRow<T extends Record<string, unknown>>(row: T): T {
  let updated: T | null = null;
  for (const key of ['transport_config', 'transportConfig'] as const) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const raw = row[key];
    const parsed = parseTransportConfigValue(raw);
    if (!parsed || !hasCompactHijackField(parsed)) continue;
    const stripped = stripCompactHijackFromTransportConfig(parsed);
    const nextVal = typeof raw === 'string' ? (stripped ? JSON.stringify(stripped) : null) : stripped;
    updated = { ...(updated ?? row), [key]: nextVal };
  }
  return updated ?? row;
}

export function resolveCompactHijackEnabled(
  sessionOverride: unknown,
  globalEnabled: boolean,
): boolean {
  const mode = normalizeCompactHijackMode(sessionOverride);
  if (mode === COMPACT_HIJACK_MODE.ON) return true;
  if (mode === COMPACT_HIJACK_MODE.OFF) return false;
  return globalEnabled === true;
}
