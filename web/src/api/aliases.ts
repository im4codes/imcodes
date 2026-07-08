/**
 * Web client for the server-native, user-scoped alias API (`/api/aliases`).
 *
 * These routes are session-authenticated and daemon-independent: they read and
 * write PostgreSQL directly under the existing `/api/*` CSRF protection, so no
 * `serverId` is sent (see openspec/changes/alias-quick-insert design D6).
 * `apiFetch` handles cookie credentials + CSRF headers automatically.
 *
 * Server validation failures are surfaced as {@link AliasApiError} carrying a
 * shared {@link AliasReason} code (from `@shared/alias-types`) so callers can
 * render an inline, localized error without ever exposing the alias `value`.
 */

import {
  ALIAS_API_PATH,
  ALIAS_REASONS,
  type AliasEntry,
  type AliasReason,
} from '@shared/alias-types.js';
import { apiFetch, ApiError } from '../api.js';

/** Payload for creating or updating (upsert) an alias. */
export interface UpsertAliasInput {
  name: string;
  value: string;
  description?: string;
  tags?: string[];
}

/**
 * A surfaced alias API failure. `reason` is a shared, structured reason code
 * (e.g. `invalid_alias_name`) suitable for keying a localized inline message;
 * it is `null` when the server returned no recognized reason code.
 */
export class AliasApiError extends Error {
  /** Structured reason code shared across daemon/server/web, or null. */
  public readonly reason: AliasReason | null;
  /** HTTP status, when the failure originated from an HTTP response. */
  public readonly status: number | null;

  constructor(message: string, reason: AliasReason | null, status: number | null) {
    super(message);
    this.name = 'AliasApiError';
    this.reason = reason;
    this.status = status;
  }
}

const VALID_REASONS: ReadonlySet<string> = new Set(Object.values(ALIAS_REASONS));

/** Narrow an arbitrary error `code` to a known {@link AliasReason}, else null. */
function toAliasReason(code: string | null | undefined): AliasReason | null {
  return code != null && VALID_REASONS.has(code) ? (code as AliasReason) : null;
}

/** Wrap an {@link ApiError} into an {@link AliasApiError} preserving the reason code. */
function toAliasApiError(err: unknown): AliasApiError {
  if (err instanceof ApiError) {
    return new AliasApiError(err.message, toAliasReason(err.code), err.status);
  }
  if (err instanceof Error) {
    return new AliasApiError(err.message, null, null);
  }
  return new AliasApiError('alias_request_failed', null, null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Defensively coerce a raw wire record into a canonical {@link AliasEntry}.
 * Unknown/missing fields fall back to safe defaults; the alias `value` is
 * carried through unchanged (never logged here).
 */
function normalizeAliasEntry(raw: unknown): AliasEntry | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  const value = typeof raw.value === 'string' ? raw.value : null;
  if (name == null || value == null) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    name,
    value,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    tags,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    source: raw.source === 'mcp' ? 'mcp' : 'web',
  };
}

/** Accept either `{ aliases: [...] }` or a bare array response, then normalize. */
function extractAliasList(res: unknown): AliasEntry[] {
  const rawList = Array.isArray(res)
    ? res
    : isRecord(res) && Array.isArray(res.aliases)
      ? res.aliases
      : [];
  const out: AliasEntry[] = [];
  for (const raw of rawList) {
    const entry = normalizeAliasEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

function extractAliasEntry(res: unknown): AliasEntry | null {
  if (isRecord(res) && isRecord(res.alias)) return normalizeAliasEntry(res.alias);
  return normalizeAliasEntry(res);
}

/**
 * List the caller's aliases. `q` is an optional NFC literal substring filter
 * applied server-side over name + description (LIKE wildcards escaped server-side).
 */
export async function listAliases(q?: string): Promise<AliasEntry[]> {
  const trimmed = q?.trim();
  const path = trimmed
    ? `${ALIAS_API_PATH}?q=${encodeURIComponent(trimmed)}`
    : ALIAS_API_PATH;
  try {
    const res = await apiFetch<unknown>(path);
    return extractAliasList(res);
  } catch (err) {
    throw toAliasApiError(err);
  }
}

/**
 * Create or update (upsert) an alias by name. On a server validation failure,
 * throws {@link AliasApiError} whose `reason` can be shown inline.
 */
export async function upsertAlias(input: UpsertAliasInput): Promise<AliasEntry | null> {
  const body: UpsertAliasInput = {
    name: input.name,
    value: input.value,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
  };
  try {
    const res = await apiFetch<unknown>(ALIAS_API_PATH, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return extractAliasEntry(res);
  } catch (err) {
    throw toAliasApiError(err);
  }
}

/**
 * Delete an alias by name. The name rides the URL PATH (`DELETE
 * /api/aliases/:name`) to match the server route — Hono decodes the path param,
 * so a CJK name like `win服务器` arrives decoded server-side. No serverId
 * (aliases are a user-level, pod-independent store).
 */
export async function deleteAlias(name: string): Promise<void> {
  try {
    await apiFetch<unknown>(`${ALIAS_API_PATH}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    throw toAliasApiError(err);
  }
}
