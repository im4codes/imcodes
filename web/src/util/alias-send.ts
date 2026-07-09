/**
 * Shared alias send-extra helper (web).
 *
 * A single choke point that every *human-composed* send surface routes through
 * so that `;;(name)` markers typed by the user resolve into the out-of-band
 * name→value map (A′) consistently — not just in the main SessionControls
 * composer. Without this, other human composers (compact sub-session card, etc.)
 * would send WITHOUT `resolvedAliases`, so shell targets fail-closed and LLM
 * targets receive the literal marker text (audit finding Cx1-2).
 *
 * Value-secrecy contract (identical to {@link buildResolvedAliases}):
 *  - The message text is NEVER expanded client-side; markers ride as-is.
 *  - The resolved map is attached to the send `extra` ONLY when at least one
 *    marker actually resolved, so ordinary (marker-free) sends stay
 *    byte-identical to before.
 *  - Only the caller's OWN composed body should be passed in — never a body
 *    already concatenated with quotes / attachment refs / system prefixes
 *    (audit finding Cx1-3). Those segments must be appended AFTER resolution.
 *
 * Agent-originated / generated sends (e.g. memory-summary sync, auto-retry of an
 * already-composed message) intentionally do NOT call this — see the opt-out
 * comments at those call sites.
 */

import type { AliasEntry, SendAliasResolution } from '@shared/alias-types.js';
import { buildResolvedAliases } from './alias-insert.js';

/**
 * The alias-related fields a human send may attach to its `extra`. The index
 * signature keeps this spread-compatible with the generic
 * `Record<string, unknown>` send-extra / resend-extra bags used across the
 * timeline and WS send paths.
 */
export interface AliasSendExtra {
  /** Out-of-band marker→value map (A′); present only when non-empty. */
  resolvedAliases?: SendAliasResolution;
  [key: string]: unknown;
}

/**
 * Compute the alias send-extra for a human-composed `bodyText` against the
 * caller's own `aliasList`.
 *
 * Returns an empty object `{}` (spread-safe) when the body references no known
 * marker, so callers can unconditionally spread the result into their send
 * `extra` without changing marker-free sends.
 *
 * @param bodyText The exact text the user typed (BEFORE quotes/attachments/
 *   system prefixes are concatenated). Passing already-concatenated text would
 *   wrongly resolve markers embedded in quoted history / attachment paths.
 * @param aliasList The caller's own alias list (unfiltered).
 */
export function buildAliasSendExtra(
  bodyText: string,
  aliasList: readonly AliasEntry[],
): AliasSendExtra {
  const { resolvedAliases } = buildResolvedAliases(bodyText, aliasList);
  if (Object.keys(resolvedAliases).length === 0) return {};
  return { resolvedAliases };
}
