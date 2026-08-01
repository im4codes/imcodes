// Shared contract for the user-level "别名 / alias" quick-reference feature.
// Pure, dependency-free: safe to import from daemon (src/), server (server/), and web (web/).
// See openspec/changes/alias-quick-insert.

/** Max length of an alias name, counted in Unicode code points after NFC. */
export const ALIAS_NAME_MAX = 20;
/** Max length of an alias value, counted in Unicode code points after NFC. */
export const ALIAS_VALUE_MAX = 500;
/** Max length of an optional description, counted in Unicode code points after NFC. */
export const ALIAS_DESCRIPTION_MAX = 200;

/**
 * Hard ceiling applied to a client-supplied note before it is injected.
 *
 * Deliberately ABOVE {@link ALIAS_DESCRIPTION_MAX}: this bounds abuse from an
 * out-of-band map that never passed server validation, while still leaving the
 * visible budget cut (and its "fetch the rest" hint) to the legend builder. If
 * this were also 200, an oversized note would arrive pre-trimmed to exactly the
 * budget and the agent would never be told that anything was withheld.
 */
export const ALIAS_NOTE_HARD_MAX = 4000;

/**
 * Allowlist for an alias name (NFC, case-sensitive). Excludes whitespace,
 * Unicode control/format (`\p{C}`) and bidi via the positive class, and the
 * marker/legend/URL-dangerous characters `; ( ) : / % #` by omission. CJK is
 * `\p{L}`, so `win服务器` is valid.
 */
export const ALIAS_NAME_PATTERN = /^[\p{L}\p{N}._-]{1,20}$/u;

/** Where alias CRUD lives on the server (pod-independent; no serverId). */
export const ALIAS_API_PATH = '/api/aliases';

/**
 * MCP tool names exposed by the daemon for the alias store.
 * - Read: `resolve_alias` (single value), `list_aliases` (metadata-only, optional search query).
 * - Write: `save_alias` (create/edit = upsert), `delete_alias` (remove).
 * Every write goes through the SAME server-authoritative validation as the web
 * app (`POST/DELETE /api/aliases`); the agent cannot bypass it.
 */
export const ALIAS_MCP_TOOLS = {
  RESOLVE: 'resolve_alias',
  LIST: 'list_aliases',
  SAVE: 'save_alias',
  DELETE: 'delete_alias',
} as const;
export type AliasMcpToolName = typeof ALIAS_MCP_TOOLS[keyof typeof ALIAS_MCP_TOOLS];

/** MCP tool names that MUTATE the alias store (create/edit/delete). */
export const ALIAS_MCP_WRITE_TOOLS: readonly AliasMcpToolName[] = [
  ALIAS_MCP_TOOLS.SAVE,
  ALIAS_MCP_TOOLS.DELETE,
] as const;

/** Structured reason codes shared by server/daemon/web (never leak `value`). */
export const ALIAS_REASONS = {
  INVALID_NAME: 'invalid_alias_name',
  VALUE_INVALID: 'alias_value_invalid',
  DESCRIPTION_INVALID: 'alias_description_invalid',
  NOT_FOUND: 'alias_not_found',
  UNRESOLVED_FAILCLOSED: 'alias_unresolved_failclosed',
  TAGS_INVALID: 'alias_tags_invalid',
} as const;
export type AliasReason = typeof ALIAS_REASONS[keyof typeof ALIAS_REASONS];

/** Origin of a stored alias record. */
export type AliasSource = 'web' | 'mcp';

/** Canonical alias record. `id`/`user_id` are server-only and not part of this wire shape. */
export interface AliasEntry {
  name: string;
  value: string;
  description?: string;
  tags: string[];
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. */
  updatedAt: string;
  source: AliasSource;
}

/**
 * Metadata-only view of an alias: everything EXCEPT the sensitive `value`.
 * This is what the read-only `list_aliases` MCP tool returns to agents — a bulk
 * listing must never expose alias plaintext values (that would let a single
 * `list_aliases` call dump every value into the agent's LLM context / memory).
 * The single-name `resolve_alias` tool remains the ONLY value-retrieval path.
 */
export type AliasMetadata = Omit<AliasEntry, 'value'>;

/** Project a full {@link AliasEntry} down to its {@link AliasMetadata} (drops `value`). */
export function toAliasMetadata(entry: AliasEntry): AliasMetadata {
  const { value: _value, ...metadata } = entry;
  return metadata;
}

/** Out-of-band map sent alongside a message: marker name -> resolved value (A′). */
export type SendAliasResolution = Record<string, string>;

/**
 * Sibling map: marker name -> the author's note on that alias.
 *
 * The note used to be dropped at this boundary, so an agent saw
 * `;;(deploy_key): sk-…` with none of the constraints the human wrote down
 * ("read replica only", "revoke after use") — the part that makes a bare value
 * safe to act on.
 *
 * Deliberately a SEPARATE field rather than widening {@link SendAliasResolution}
 * into `string | {value, description}`: the daemon is a globally-installed CLI
 * that users upgrade independently of the server-served web UI, so new-web +
 * old-daemon is routine. An old daemon calls `nfc()` on each map entry, which
 * throws `TypeError: i.normalize is not a function` on an object — every alias
 * send would fail to deliver. An unknown sibling field is simply ignored.
 */
export type SendAliasNotes = Record<string, string>;

/** Read a note for `name`, treating blank/non-string entries as absent. */
export function aliasNoteFor(notes: SendAliasNotes | undefined, name: string): string | undefined {
  if (!notes || typeof notes !== 'object') return undefined;
  const note = (notes as Record<string, unknown>)[name];
  return typeof note === 'string' && note.trim().length > 0 ? note : undefined;
}

/** NFC normalization used consistently on every layer before validation/storage/matching. */
export function nfc(input: string): string {
  return input.normalize('NFC');
}

/** Length in Unicode code points (not UTF-16 units). */
export function codePointLength(input: string): number {
  let n = 0;
  // Iterating a string yields code points.
  for (const _cp of input) n += 1;
  return n;
}

/** Normalize a value for storage: NFC + CRLF/CR -> LF. */
export function normalizeAliasValueForStorage(rawValue: string): string {
  return nfc(rawValue).replace(/\r\n?/g, '\n');
}

/** Validate an alias name; returns a reason code or null when valid. Input is NFC-normalized. */
export function validateAliasName(rawName: string): AliasReason | null {
  const name = nfc(rawName);
  if (name.length === 0) return ALIAS_REASONS.INVALID_NAME;
  if (codePointLength(name) > ALIAS_NAME_MAX) return ALIAS_REASONS.INVALID_NAME;
  if (!ALIAS_NAME_PATTERN.test(name)) return ALIAS_REASONS.INVALID_NAME;
  return null;
}

/**
 * Validate an alias value; returns a reason code or null when valid.
 * The value is the user's own exact text: it may contain spaces and newlines,
 * but must be non-empty, contain no NUL, and be <= ALIAS_VALUE_MAX code points (post-NFC).
 */
export function validateAliasValue(rawValue: string): AliasReason | null {
  const value = normalizeAliasValueForStorage(rawValue);
  if (value.length === 0) return ALIAS_REASONS.VALUE_INVALID;
  if (value.includes(String.fromCharCode(0))) return ALIAS_REASONS.VALUE_INVALID;
  if (codePointLength(value) > ALIAS_VALUE_MAX) return ALIAS_REASONS.VALUE_INVALID;
  return null;
}

/** Validate an optional description; returns a reason code or null when valid/absent. */
export function validateAliasDescription(rawDescription: string | undefined): AliasReason | null {
  if (rawDescription == null) return null;
  const description = nfc(rawDescription);
  if (codePointLength(description) > ALIAS_DESCRIPTION_MAX) return ALIAS_REASONS.DESCRIPTION_INVALID;
  return null;
}

/** Max number of tags on an alias. */
export const ALIAS_TAG_MAX_COUNT = 10;
/** Max length of a single tag, in Unicode code points after NFC. */
export const ALIAS_TAG_MAX_LEN = 30;

/**
 * Validate an alias `tags` array; returns a reason code or null when valid/absent.
 * Server-authoritative: reject (do not silently truncate) an oversized array, a
 * non-string / empty / oversized tag, or a tag containing control characters.
 */
export function validateAliasTags(tags: unknown): AliasReason | null {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) return ALIAS_REASONS.TAGS_INVALID;
  if (tags.length > ALIAS_TAG_MAX_COUNT) return ALIAS_REASONS.TAGS_INVALID;
  for (const raw of tags) {
    if (typeof raw !== 'string') return ALIAS_REASONS.TAGS_INVALID;
    const tag = nfc(raw);
    if (tag.length === 0) return ALIAS_REASONS.TAGS_INVALID;
    if (codePointLength(tag) > ALIAS_TAG_MAX_LEN) return ALIAS_REASONS.TAGS_INVALID;
    if (/\p{Cc}/u.test(tag)) return ALIAS_REASONS.TAGS_INVALID;
  }
  return null;
}

/**
 * Non-displayed audit anchor attached to the human-facing timeline `user.message`
 * event for an alias-bearing send. Records WHICH aliases were referenced and a
 * hash of the resolved values — never the plaintext values — so that "what did
 * `;;(name)` actually deliver to the agent" is auditable without exposing secrets.
 */
export interface AliasSendAudit {
  /** Distinct alias marker names referenced by the sent text (first-occurrence order). */
  names: string[];
  /** Hex SHA-256 over the canonical {name: value} map (referenced names only); no plaintext. */
  resolvedHash: string;
}

/** Build the reference marker a surface inserts into the composer. */
export function buildAliasMarker(name: string): string {
  return `;;(${name})`;
}

/**
 * Single-pass marker regex: `;;(` then any run without parens, then the first `)`.
 * `[^()]*` structurally rejects an inner `(`, so `;;(na(me)` is not a marker.
 */
export const ALIAS_MARKER_REGEX = /;;\(([^()]*)\)/g;

/** True when the captured marker content is a valid alias name (NFC). */
export function isValidMarkerName(rawName: string): boolean {
  return validateAliasName(rawName) === null;
}

/**
 * Extract distinct valid alias names referenced by `;;(name)` markers in the
 * text, in first-occurrence order. Invalid markers (spaces, `:`, empty,
 * unclosed, inner `(`, too long) are ignored (left literal).
 */
export function parseAliasMarkers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(ALIAS_MARKER_REGEX)) {
    const raw = match[1];
    if (!isValidMarkerName(raw)) continue;
    const name = nfc(raw);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Directive prepended to the legend block for NL/LLM agents. */
export const ALIAS_LEGEND_DIRECTIVE =
  'The ;;(name) markers in the message below expand to the following values; use the value wherever its marker appears. '
  + 'A line may carry a "— note:" written by the user about that alias: treat it as a constraint on how the value may be used, not as part of the value:';

/** Separator between the value and the author's note on a legend line. */
export const ALIAS_LEGEND_NOTE_SEPARATOR = ' — note: ';

/**
 * Longest note injected inline on a legend line.
 *
 * A note rides on EVERY send that references the alias, whether or not the agent
 * ends up needing it, so a long one is a recurring token cost for information
 * that is often irrelevant. Past this budget the line carries the leading slice
 * plus a hint, and the agent fetches the rest on demand — `list_aliases` returns
 * full alias metadata (including `description`) and never exposes values, so
 * redeeming the hint costs nothing in value-secrecy terms.
 *
 * This is a real enforcement point, not a formality: the note map is supplied
 * out-of-band by the client and is never re-validated against the server's
 * save-time ceiling, so an oversized note can reach this line regardless of what
 * {@link ALIAS_DESCRIPTION_MAX} allows at save time.
 */
export const ALIAS_LEGEND_NOTE_INLINE_MAX = 200;

/** Appended when a note was cut to the inline budget; names the tool that returns the rest. */
export const ALIAS_LEGEND_NOTE_TRUNCATED_HINT = '… (note truncated — call list_aliases for the full text)';

/** Collapse internal whitespace runs (incl. newlines/tabs) so a legend line stays single-line. */
export function legendValueSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Build one legend line `;;(name): value` (value single-lined), appending
 * `— note: <description>` when the alias carries one.
 *
 * The note is deliberately placed AFTER the value and behind a separator: the
 * value stays the first thing following the marker, so a model copying "the
 * thing after the colon" cannot pick up the note by accident.
 */
export function buildAliasLegendLine(name: string, value: string, description?: string): string {
  const line = `${buildAliasMarker(name)}: ${legendValueSingleLine(value)}`;
  const note = description ? legendValueSingleLine(description) : '';
  if (!note) return line;
  // Slice on code points, never UTF-16 units, so a surrogate pair (emoji, rare
  // CJK) is not split into a lone half at the cut.
  const points = Array.from(note);
  const shown = points.length > ALIAS_LEGEND_NOTE_INLINE_MAX
    ? points.slice(0, ALIAS_LEGEND_NOTE_INLINE_MAX).join('') + ALIAS_LEGEND_NOTE_TRUNCATED_HINT
    : note;
  return `${line}${ALIAS_LEGEND_NOTE_SEPARATOR}${shown}`;
}
