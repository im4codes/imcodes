// Alias send audit anchor (RV-C).
//
// The human-facing timeline shows only the original `;;(name)` markers while the
// agent receives the expanded value. Without an anchor, "what did `;;(deploy)`
// actually deliver to the agent" is unauditable — and, since `resolvedAliases`
// is client-supplied out-of-band, an injected value could be delivered with no
// trace. This helper produces a non-displayed {@link AliasSendAudit} attached to
// the `user.message` timeline event: it records WHICH aliases were referenced and
// a SHA-256 over the referenced {name: value} map, so a value change is
// detectable — WITHOUT ever persisting or emitting the plaintext value.
//
// Invariant: the plaintext alias value is used ONLY as SHA-256 hash input here.
// It is never returned, logged, or placed on any event payload.

import { createHash } from 'node:crypto';
import {
  aliasNoteFor,
  nfc,
  parseAliasMarkers,
  type AliasSendAudit,
  type SendAliasNotes,
  type SendAliasResolution,
} from '../../shared/alias-types.js';

/**
 * Build the audit anchor for an alias-bearing send.
 *
 * @param text            The human-facing text containing `;;(name)` markers
 *                        (the daemon's `displayText`).
 * @param resolvedAliases The client-supplied out-of-band `name -> value` map.
 * @returns An {@link AliasSendAudit} when at least one referenced marker has a
 *          resolved value; otherwise `undefined` (nothing to anchor). The
 *          returned object contains NO plaintext value — only the referenced
 *          names and a hash.
 */
export function buildAliasSendAudit(
  text: string,
  resolvedAliases: SendAliasResolution,
  resolvedAliasNotes?: SendAliasNotes,
): AliasSendAudit | undefined {
  // Distinct valid marker names in first-occurrence order (shared parser).
  const referenced = parseAliasMarkers(text);
  if (referenced.length === 0) return undefined;

  const has = (name: string) => Object.prototype.hasOwnProperty.call(resolvedAliases, name);
  // Only names that were actually resolved contribute to the anchor. A referenced
  // marker with no resolved value has no value to audit.
  const resolvedNames = referenced.filter(has);
  if (resolvedNames.length === 0) return undefined;

  // Canonical JSON: a fresh object containing ONLY the referenced+resolved names,
  // keys sorted, mapped to their NFC-normalized values. Sorting + a purpose-built
  // object make the hash stable regardless of marker order or map key order, and
  // independent of any unrelated aliases the client happened to ship.
  // The note is delivered to the agent alongside the value, so it is part of
  // "what this marker actually delivered" and must be covered by the anchor —
  // otherwise a silently edited note would leave no trace. Absent notes omit the
  // key entirely, so an alias without one hashes unambiguously.
  // A note is delivered to the agent alongside its value, so it is part of "what
  // this marker actually delivered" and must be covered by the anchor —
  // otherwise a silently edited note would leave no trace. Aliases with no note
  // omit the key entirely and keep hashing exactly as before, so existing
  // note-free sends produce unchanged anchors.
  const canonical: Record<string, string | { value: string; description: string }> = {};
  for (const name of [...resolvedNames].sort()) {
    const note = aliasNoteFor(resolvedAliasNotes, name);
    canonical[name] = note === undefined
      ? nfc(resolvedAliases[name])
      : { value: nfc(resolvedAliases[name]), description: nfc(note) };
  }
  const resolvedHash = createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');

  // `names` preserves first-occurrence order (audit trail of what the user
  // referenced); the hash is order-independent by construction above.
  return { names: resolvedNames, resolvedHash };
}
