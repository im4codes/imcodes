/**
 * Project-authoritative supervision snapshot resolution.
 *
 * Split out of send-tool.ts so it can be imported by task-pairs/service.ts
 * without creating a cycle (send-tool.ts imports the task-pairs service).
 */
import type { SessionRecord } from '../store/session-store.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import {
  readSupervisionSnapshotFromTransportConfig,
  type SessionSupervisionSnapshot,
} from '../../shared/supervision-config.js';
import { overlayCachedExecutionPools } from './supervisor-defaults-cache.js';
import type { SupervisionExecutionPoolsConfig } from '../../shared/supervision-execution-pool.js';

/**
 * Read the one project-owned execution-pool snapshot for every legitimate
 * project participant. Read authority is project membership; only mutation of
 * the snapshot remains Brain-owned. Falling back to a sub-session's private
 * snapshot made the same target alternately configured/unconfigured depending
 * on who called send_list_targets (tsk_79u).
 *
 * Multiple active Brain snapshots are accepted only when byte-equivalent;
 * disagreement is genuine authority ambiguity and fails closed as
 * legacy_unconfigured rather than selecting by array order.
 *
 * The execution pool specifically is account-level policy keyed by model
 * type, not by which Brain session happens to carry it (see
 * `overlayCachedExecutionPools`). Applying it here, after the
 * per-session/ambiguity resolution above, means every project on the
 * account is eligible for manual task dispatch the moment the account has
 * one configured pool -- a Brain never has to individually re-save it, and
 * an ambiguous or brain-less project still resolves through it rather than
 * only through the narrower ambiguity fallback.
 */
export function resolveProjectAuthoritativeSupervisionSnapshot(
  projectName: string,
  sessions: readonly SessionRecord[],
): SessionSupervisionSnapshot {
  const fallback = readSupervisionSnapshotFromTransportConfig(undefined);
  const brains = sessions.filter((session) => (
    session.role === 'brain'
    && !session.parentSession
    && resolveEffectiveProjectName(session, sessions) === projectName
  ));
  if (brains.length === 0) return overlayCachedExecutionPools(fallback);
  const snapshots = brains.map((brain) => readSupervisionSnapshotFromTransportConfig(brain.transportConfig));
  const encoded = new Set(snapshots.map((snapshot) => JSON.stringify(snapshot)));
  return overlayCachedExecutionPools(encoded.size === 1 ? snapshots[0]! : fallback);
}

export function resolveProjectAuthoritativeSupervisionPools(
  projectName: string,
  sessions: readonly SessionRecord[],
): SupervisionExecutionPoolsConfig {
  return resolveProjectAuthoritativeSupervisionSnapshot(projectName, sessions).executionPools;
}
