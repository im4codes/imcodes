// Machine quick-reference protocol shared by daemon, server, and web.
//
// A controlled machine is referenced in the composer with a `^^(name)` marker,
// mirroring the alias `;;(name)` mechanics but for a machine target rather than
// a secret value. The reference KEY is a server-derived `ref_name` slug that is
// guaranteed to match the marker grammar and be account-unique; the untrusted
// redeemed hostname is only used to compute a render-only `display_name`.

/**
 * Valid `ref_name` grammar: letters/digits/`._-`, NFC, 1..40 code points. Mirrors
 * the alias name allowlist (whitespace, control/bidi, and marker/URL-dangerous
 * characters `;():#/%` are excluded by omission) but allows a slightly longer key
 * so a sanitized hostname plus a short `serverId` suffix fits.
 */
export const MACHINE_NAME_PATTERN = /^[\p{L}\p{N}._-]{1,40}$/u;
export const MACHINE_REF_NAME_MAX = 40;
export const MACHINE_DISPLAY_NAME_MAX = 120;

/** Owner-scoped controllable-machine list endpoint (DB-backed presence, F1). */
export const MACHINE_API_PATH = '/api/machines';

/** Reason codes for machine reference resolution + exec targeting. */
export const MACHINE_REASONS = {
  INVALID_NAME: 'machine_invalid_name',
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

/** Build the reference marker a composer surface inserts (marker only, never a value). */
export function buildMachineMarker(name: string): string {
  return `^^(${name})`;
}

/**
 * Single-pass marker regex: `^^(` then any run without parens, then the first `)`.
 * `[^()]*` structurally rejects an inner `(`, so `^^(na(me)` is not a marker.
 */
export const MACHINE_MARKER_REGEX = /\^\^\(([^()]*)\)/g;

/**
 * Extract distinct valid machine `ref_name`s referenced by `^^(name)` markers,
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
  refName: string;
  online: boolean;
}

/**
 * Out-of-band map carried with a sent message: marker `ref_name` → target
 * `serverId`. Unknown/ambiguous names are omitted (marker stays literal/visible).
 * The receiver MUST treat this as a hint and re-validate each `serverId` against
 * the owner's controlled-machine list — it is never an authorization input.
 */
export type SendMachineResolution = Record<string, string>;

/**
 * Compute the compose-time machine resolution for `text` against `machines`.
 * Pure. A `ref_name` that matches exactly one machine maps to its `serverId`;
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

  const byRef = new Map<string, string[]>();
  for (const m of machines) {
    const key = nfc(m.refName);
    const list = byRef.get(key) ?? [];
    list.push(m.serverId);
    byRef.set(key, list);
  }
  for (const name of names) {
    const ids = byRef.get(name);
    if (!ids || ids.length === 0) unresolved.push(name);
    else if (ids.length > 1) ambiguous.push(name);
    else resolvedMachines[name] = ids[0];
  }
  return { text, resolvedMachines, ambiguous, unresolved };
}

// ── Server-derived identity (ref_name + display_name) ────────────────────────

const CONTROL_BIDI_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Sanitize an untrusted hostname to the `ref_name` allowlist (may be empty). */
function slugifyHostname(hostname: string): string {
  return nfc(hostname)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // collapse runs of disallowed chars to '-'
    .replace(/^-+|-+$/g, '')
    .slice(0, MACHINE_REF_NAME_MAX - 8); // leave room for '-' + 6-char suffix
}

/**
 * Derive a unique, grammar-valid `ref_name` from an UNTRUSTED hostname plus a
 * short `serverId` suffix. Always returns a value matching MACHINE_NAME_PATTERN;
 * two machines with the same hostname get distinct keys via the suffix.
 */
export function deriveRefName(hostname: string, serverId: string): string {
  const suffix = nfc(serverId).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 6) || 'node';
  const base = slugifyHostname(hostname) || 'host';
  const candidate = `${base}-${suffix}`.slice(0, MACHINE_REF_NAME_MAX);
  // Guarantee validity even if slicing produced a trailing separator / empty base.
  const cleaned = candidate.replace(/^[._-]+|[._-]+$/g, '') || `host-${suffix}`;
  return MACHINE_NAME_PATTERN.test(cleaned) ? cleaned : `host-${suffix}`.slice(0, MACHINE_REF_NAME_MAX);
}

/** Derive a render-only display name from untrusted hostname/os (control/bidi stripped). */
export function deriveDisplayName(hostname: string, os: string): string {
  const h = nfc(hostname).replace(CONTROL_BIDI_RE, '').trim();
  const o = nfc(os).replace(CONTROL_BIDI_RE, '').trim();
  const combined = o ? `${h} (${o})` : h;
  return combined.slice(0, MACHINE_DISPLAY_NAME_MAX);
}
