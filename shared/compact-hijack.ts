/**
 * Compact Hijack shared contract.
 *
 * When enabled for an owned session, non-manual context compaction triggers an
 * automatic `/handoff` conversation reset with a CrossVendorHandoffPack and
 * dispatches the standardized continuation prompt to the fresh session.
 *
 * Pure module — safe to import in daemon, server, and web.
 */

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

export interface CompactHijackGlobalConfig {
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

export function normalizeCompactHijackGlobalConfig(raw: unknown): CompactHijackGlobalConfig {
  if (typeof raw === 'boolean') return { enabled: raw };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = (raw as { enabled?: unknown }).enabled;
    if (typeof enabled === 'boolean') return { enabled };
  }
  return { enabled: false };
}

export function isValidCompactHijackGlobalPrefPayload(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'boolean') return true;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = (raw as { enabled?: unknown }).enabled;
    return typeof enabled === 'boolean';
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
  return JSON.stringify({ enabled: config.enabled === true });
}

export function extractSessionCompactHijackMode(transportConfig: unknown): CompactHijackMode {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return COMPACT_HIJACK_MODE.INHERIT;
  }
  const value = (transportConfig as Record<string, unknown>).compactHijack;
  return normalizeCompactHijackMode(value);
}

export function hasCompactHijackField(transportConfig: unknown): boolean {
  return Boolean(
    transportConfig
    && typeof transportConfig === 'object'
    && !Array.isArray(transportConfig)
    && Object.prototype.hasOwnProperty.call(transportConfig, 'compactHijack'),
  );
}

export function hasInvalidCompactHijackSetting(transportConfig: unknown): boolean {
  if (!hasCompactHijackField(transportConfig)) return false;
  const value = (transportConfig as Record<string, unknown>).compactHijack;
  return value !== undefined && value !== null && !isCompactHijackMode(value);
}

export function buildTransportConfigWithCompactHijack(
  existing: Record<string, unknown> | null | undefined,
  mode: CompactHijackMode,
): Record<string, unknown> | null {
  const base: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {};
  if (mode === COMPACT_HIJACK_MODE.INHERIT) {
    delete base.compactHijack;
  } else {
    base.compactHijack = mode;
  }
  return Object.keys(base).length > 0 ? base : null;
}

export function stripCompactHijackFromTransportConfig(transportConfig: unknown): Record<string, unknown> | null {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) {
    return null;
  }
  const copy = { ...(transportConfig as Record<string, unknown>) };
  delete copy.compactHijack;
  return Object.keys(copy).length > 0 ? copy : null;
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
