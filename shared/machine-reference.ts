import { isControlledNodeId, type ControlledNodeId } from './controlled-node-identity.js';

// Machine quick-reference protocol shared by daemon, server, and web.
//
// A controlled machine is referenced in the composer with a `^^(name)` marker.
// New markers carry the server-minted canonical nodeId. Historical noncanonical
// `ref_name` slugs remain owner-scoped compatibility aliases only; hostname/OS
// never determine canonical identity and are render-only display inputs.

/**
 * Valid `ref_name` grammar: letters/digits/`._-`, NFC, 1..40 code points. Mirrors
 * the alias name allowlist (whitespace, control/bidi, and marker/URL-dangerous
 * characters `;():#/%` are excluded by omission) but allows a slightly longer key
 * so a sanitized hostname plus a short `serverId` suffix fits.
 */
export const MACHINE_REF_NAME_MAX = 40;
const MACHINE_NAME_FRAGMENT = `[\\p{L}\\p{N}._-]{1,${MACHINE_REF_NAME_MAX}}`;
export const MACHINE_NAME_PATTERN = new RegExp(`^${MACHINE_NAME_FRAGMENT}$`, 'u');
/** Action-tool targets accept a canonical nodeId or deprecated alias, bare or marked. */
export const MACHINE_TARGET_MAX = MACHINE_REF_NAME_MAX + 4;
export const MACHINE_TARGET_PATTERN = new RegExp(
  `^(?:${MACHINE_NAME_FRAGMENT}|\\^\\^\\(${MACHINE_NAME_FRAGMENT}\\))$`,
  'u',
);
const MACHINE_TARGET_MARKER_PATTERN = new RegExp(`^\\^\\^\\((${MACHINE_NAME_FRAGMENT})\\)$`, 'u');
export const MACHINE_DISPLAY_NAME_MAX = 120;
/** Bounded render fallback for endpoints that have no public node identity. */
export const MACHINE_IDENTITY_UNAVAILABLE = '—';

/** Owner-scoped controllable-machine list endpoint (DB-backed presence, F1). */
export const MACHINE_API_PATH = '/api/machines';

/** Reason codes for machine reference resolution + exec targeting. */
export const MACHINE_REASONS = {
  INVALID_NAME: 'machine_invalid_name',
  INVALID_DISPLAY_NAME: 'machine_invalid_display_name',
  MACHINE_NOT_FOUND: 'machine_not_found',
  MACHINE_AMBIGUOUS: 'machine_ambiguous',
  MACHINE_OFFLINE: 'machine_offline',
} as const;
export type MachineReason = (typeof MACHINE_REASONS)[keyof typeof MACHINE_REASONS];

/** NFC-normalize (safe on runtimes without full ICU — `normalize` is core JS). */
export function nfc(input: string): string {
  return input.normalize('NFC');
}

/** True when `raw` is a valid machine `ref_name` (post-NFC). */
export function isValidMachineName(raw: string): boolean {
  return MACHINE_NAME_PATTERN.test(nfc(raw));
}

/**
 * Normalize an action-tool target to its bare canonical nodeId or legacy alias.
 *
 * This deliberately accepts only a complete marker, never a marker embedded in
 * surrounding text. List/output contracts use canonical nodeIds as primary.
 */
export function normalizeMachineTarget(raw: string): string | null {
  const normalized = nfc(raw);
  if (isValidMachineName(normalized)) return normalized;
  const marker = MACHINE_TARGET_MARKER_PATTERN.exec(normalized);
  return marker && isValidMachineName(marker[1]) ? nfc(marker[1]) : null;
}

/** True when an action-tool target is a bare identity or a complete marker. */
export function isValidMachineTarget(raw: string): boolean {
  return normalizeMachineTarget(raw) !== null;
}

export type MachineTargetIdentity =
  | { kind: 'node_id'; value: ControlledNodeId }
  | { kind: 'legacy_ref_name'; value: string };

/** Canonical grammar wins; a canonical target is never retried as a legacy alias. */
export function classifyMachineTarget(raw: string): MachineTargetIdentity | null {
  const value = normalizeMachineTarget(raw);
  if (value === null) return null;
  return isControlledNodeId(value)
    ? { kind: 'node_id', value }
    : { kind: 'legacy_ref_name', value };
}

/** Build the reference marker a composer surface inserts (marker only, never a value). */
export function buildMachineMarker(name: string): string {
  return `^^(${name})`;
}

/**
 * Build the human-readable reference inserted by machine pickers.
 *
 * The stable marker remains the only routing identity. The mutable display name
 * is an explanatory suffix so two opaque refs are easy to distinguish in the
 * composer and timeline. Protocol-looking runs in the display name are rendered
 * with full-width sigils so an owner-authored note cannot forge another machine,
 * alias, or P2P target when the message is later parsed.
 */
export function buildMachineComposerReference(name: string, displayName?: string): string {
  const marker = buildMachineMarker(name);
  if (displayName == null) return marker;
  const normalized = normalizeMachineDisplayName(displayName);
  if (!normalized) return marker;
  const safeNote = normalized
    .split('^^(').join('＾＾(')
    .split(';;(').join('；；(')
    .split('@@').join('＠＠');
  return `${marker}-(${safeNote})`;
}

/**
 * Single-pass marker regex: `^^(` then any run without parens, then the first `)`.
 * `[^()]*` structurally rejects an inner `(`, so `^^(na(me)` is not a marker.
 */
export const MACHINE_MARKER_REGEX = /\^\^\(([^()]*)\)/g;

/**
 * Extract distinct valid machine identities referenced by `^^(name)` markers,
 * in first-occurrence order. Invalid markers (spaces, inner `(`, empty, too long,
 * disallowed chars) are ignored and left literal.
 */
export function parseMachineMarkers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(MACHINE_MARKER_REGEX)) {
    const raw = match[1];
    if (!isValidMachineName(raw)) continue;
    const name = nfc(raw);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** A machine as referenced in the composer resolution list. */
export interface MachineRef {
  serverId: string;
  /** Primary public identity. Optional only for rolling-compatibility fixtures. */
  nodeId?: string;
  /** Deprecated compatibility alias; never consulted for canonical-ID grammar. */
  refName: string;
  online: boolean;
}

/**
 * Out-of-band map carried with a sent message: marker identity → target
 * `serverId`. Unknown/ambiguous names are omitted (marker stays literal/visible).
 * The receiver MUST treat this as a hint and re-validate each `serverId` against
 * the owner's controlled-machine list — it is never an authorization input.
 */
export type SendMachineResolution = Record<string, string>;

/**
 * Compute the compose-time machine resolution for `text` against `machines`.
 * Pure. An identity that matches exactly one machine maps to its `serverId`;
 * unknown or ambiguous names are skipped (left literal). The `^^(name)` marker
 * text is intentionally NOT expanded — it stays visible so the agent sees the
 * referenced machine.
 */
export function buildResolvedMachines(
  text: string,
  machines: readonly MachineRef[],
): { text: string; resolvedMachines: SendMachineResolution; ambiguous: string[]; unresolved: string[] } {
  const names = parseMachineMarkers(text);
  const resolvedMachines: SendMachineResolution = {};
  const ambiguous: string[] = [];
  const unresolved: string[] = [];
  if (names.length === 0) return { text, resolvedMachines, ambiguous, unresolved };

  const byNodeId = new Map<string, string[]>();
  const byRef = new Map<string, string[]>();
  for (const m of machines) {
    if (isControlledNodeId(m.nodeId)) {
      const nodeIds = byNodeId.get(m.nodeId) ?? [];
      nodeIds.push(m.serverId);
      byNodeId.set(m.nodeId, nodeIds);
    }
    const key = nfc(m.refName);
    const list = byRef.get(key) ?? [];
    list.push(m.serverId);
    byRef.set(key, list);
  }
  for (const name of names) {
    const target = classifyMachineTarget(name);
    const ids = target?.kind === 'node_id'
      ? byNodeId.get(target.value)
      : byRef.get(name);
    if (!ids || ids.length === 0) unresolved.push(name);
    else if (ids.length > 1) ambiguous.push(name);
    else resolvedMachines[name] = ids[0];
  }
  return { text, resolvedMachines, ambiguous, unresolved };
}

// ── Deprecated compatibility alias + mutable display name ───────────────────

const CONTROL_BIDI_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_BIDI_GLOBAL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Normalize an owner-supplied render-only machine name. A deprecated legacy
 * `ref_name`, when present, is deliberately not changed by rename operations,
 * so historical `^^(name)` references remain valid.
 */
export function normalizeMachineDisplayName(raw: string): string | null {
  const normalized = nfc(raw).trim();
  if (!normalized || [...normalized].length > MACHINE_DISPLAY_NAME_MAX) return null;
  if (CONTROL_BIDI_RE.test(normalized)) return null;
  return normalized;
}

/** Derive a render-only display name from untrusted hostname/os (control/bidi stripped). */
export function deriveDisplayName(hostname: string, os: string): string {
  const h = nfc(hostname).replace(CONTROL_BIDI_GLOBAL_RE, '').trim();
  const o = nfc(os).replace(CONTROL_BIDI_GLOBAL_RE, '').trim();
  const combined = o ? `${h} (${o})` : h;
  return combined.slice(0, MACHINE_DISPLAY_NAME_MAX);
}
