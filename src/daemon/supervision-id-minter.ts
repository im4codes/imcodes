/**
 * Daemon-side canonical id minting.
 *
 * A model may PROPOSE a semantic key for human legibility. It may never supply
 * the id itself: uniqueness, session binding and attempt round are daemon
 * property. `supervision-state-store.ts` historically did
 * `normalizeTaskString(input.taskId) ?? stableTaskId()`, which let a caller pin
 * any id it liked — including one colliding with, or impersonating, another
 * slice. This module is the replacement entry point.
 *
 * The pure contract (validation + formatting) lives in
 * shared/supervision-durable-identity.ts; only the entropy is added here, so the
 * format stays testable without a daemon and browser code can parse ids without
 * importing node:crypto.
 */
import { randomUUID } from 'node:crypto';
import {
  mintSupervisionCanonicalId,
  parseSupervisionCanonicalId,
  validateSupervisionSemanticKey,
  type SupervisionIdKind,
} from '../../shared/supervision-durable-identity.js';

export interface SupervisionMintRequest {
  kind: SupervisionIdKind;
  /** Model/user proposed, strict kebab-case. */
  semanticKey: string;
  /** Audit attempts only; daemon-counted, never model-supplied. */
  round?: number;
}

export type SupervisionMintFailure =
  | 'invalid_semantic_key'
  | 'invalid_round'
  | 'collision';

export interface SupervisionMintDeps {
  /** Injected for deterministic tests; defaults to a real UUID. */
  uniqueSuffix?: () => string;
  /** Returns true when the id already exists durably. */
  exists?: (id: string) => boolean;
}

/**
 * Mint a globally unique, immutable canonical id.
 *
 * Retries on the (astronomically unlikely, but cheap to handle) collision case
 * rather than returning a duplicate, and gives up rather than looping forever.
 */
export function mintSupervisionId(
  request: SupervisionMintRequest,
  deps: SupervisionMintDeps = {},
): { ok: true; id: string; semanticKey: string } | { ok: false; reason: SupervisionMintFailure } {
  const key = validateSupervisionSemanticKey(request.semanticKey);
  if (!key.ok) return { ok: false, reason: 'invalid_semantic_key' };
  if (request.round !== undefined
    && (!Number.isInteger(request.round) || request.round < 1 || request.round > 999)) {
    return { ok: false, reason: 'invalid_round' };
  }
  const suffix = deps.uniqueSuffix ?? (() => randomUUID());
  const exists = deps.exists ?? (() => false);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const minted = mintSupervisionCanonicalId({
      kind: request.kind,
      semanticKey: key.key,
      uniqueSuffix: suffix(),
      round: request.round === undefined ? undefined : `r${request.round}`,
    });
    if (!minted.ok) return { ok: false, reason: 'invalid_semantic_key' };
    if (!exists(minted.id)) return { ok: true, id: minted.id, semanticKey: key.key };
  }
  return { ok: false, reason: 'collision' };
}

/**
 * Guard for the legacy caller-supplied id path.
 *
 * A caller may still pass an id ONLY when it is one the daemon previously
 * minted and that already exists (idempotent retry / replay). A well-formed but
 * unknown canonical id is refused: that is the impersonation case, where a model
 * fabricates `tsk_<someone-elses-slice>_<uuid>` to write into another owner's
 * task.
 */
export function isAcceptableCallerSuppliedId(input: {
  id: string;
  kind: SupervisionIdKind;
  exists: (id: string) => boolean;
}): boolean {
  const parsed = parseSupervisionCanonicalId(input.id);
  if (!parsed) return false;
  if (parsed.kind !== input.kind) return false;
  return input.exists(input.id);
}
