/**
 * The one gate every execute-class machine action passes (exec_remote, computer_use, file send/fetch/list):
 *   admission (shared/machine-access-policy.ts via admitMachineAction) -> rate limit -> a durable audit row.
 *
 * - A REFUSED attempt is audited too (reason, actor, delegated actor, source), throttled per actor+device so a probe cannot fill the table.
 * - Only ADMITTED actions consume the per-device budget, so a stranger hammering a device with refused requests cannot starve its owner.
 * - Per pod, in memory: the target's requests are routed to the pod that holds its daemon (`?serverId=`), which is where its budget lives.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  MACHINE_ACTION_RATE_LIMIT,
  MACHINE_DENIAL_REASON,
  MACHINE_INTERACTIVE_SOURCE,
  type MachineAction,
  type MachineDenialReason,
} from '../../../shared/machine-access-policy.js';
import { admitMachineAction, type MachineActionAdmission, type MachineActionAdmissionInput } from '../share/shared-machine-authority.js';
import { recordMachineActionDenial } from './machine-exec-audit.js';
import logger from '../util/logger.js';

export const MACHINE_ACTION_RATE_LIMITED = 'rate_limited' as const;

class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number) {}
  /** Count one hit if the key has budget left; returns false (and counts nothing) when it does not. */
  tryHit(key: string, limit: number, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= limit) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }
  private sweep(now: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
  clear(): void { this.hits.clear(); }
}

const deviceBudget = new SlidingWindowCounter(MACHINE_ACTION_RATE_LIMIT.WINDOW_MS);
const actorBudget = new SlidingWindowCounter(MACHINE_ACTION_RATE_LIMIT.WINDOW_MS);
const deniedAuditBudget = new SlidingWindowCounter(MACHINE_ACTION_RATE_LIMIT.WINDOW_MS);

export function resetMachineActionGateForTests(): void {
  deviceBudget.clear();
  actorBudget.clear();
  deniedAuditBudget.clear();
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** What the audit may hold about an action's payload: a hash and a length, never the content. */
export function describeActionPayload(payload: string): { commandSha256: string; commandLength: number } {
  return { commandSha256: sha256Hex(payload), commandLength: Buffer.byteLength(payload, 'utf8') };
}

export type MachineActionGateInput = MachineActionAdmissionInput & {
  /** Hash+length of what is about to run (never the text). */
  payload: { commandSha256: string; commandLength: number };
};

export type MachineActionGateResult =
  | { ok: true; admission: Extract<MachineActionAdmission, { ok: true }> }
  | {
      ok: false;
      /** `target_forbidden` or `exec_disabled` on the existing wire (old clients keep understanding it); 429 for the rate limit. */
      status: 403 | 429;
      wireReason: 'target_forbidden' | 'exec_disabled' | 'target_unavailable';
      reason: MachineDenialReason | typeof MACHINE_ACTION_RATE_LIMITED;
    };

async function auditDenial(
  db: Database,
  input: MachineActionGateInput,
  reason: MachineDenialReason | typeof MACHINE_ACTION_RATE_LIMITED,
  admission: { accessSource: string | null; delegatedActorUserId?: string } | null,
): Promise<void> {
  const key = `${input.sourceOwnerUserId}\0${input.targetServerId}`;
  if (!deniedAuditBudget.tryHit(key, MACHINE_ACTION_RATE_LIMIT.DENIED_AUDITS_PER_ACTOR_PER_DEVICE, input.now)) return;
  try {
    await recordMachineActionDenial(db, {
      correlationId: randomBytes(16).toString('hex'),
      userId: input.sourceOwnerUserId,
      sourceServerId: input.authenticatedSourceServerId || MACHINE_INTERACTIVE_SOURCE,
      targetServerId: input.targetServerId,
      action: input.action,
      reason,
      commandSha256: input.payload.commandSha256,
      commandLength: input.payload.commandLength,
      ...(admission?.delegatedActorUserId ? { delegatedActorUserId: admission.delegatedActorUserId } : {}),
      accessSource: admission?.accessSource ?? null,
      now: input.now,
    });
  } catch (err) {
    // The refusal stands whether or not the row could be written.
    logger.error({ targetServerId: input.targetServerId, action: input.action, err }, 'Could not audit a refused machine action');
  }
}

export async function gateMachineAction(db: Database, input: MachineActionGateInput): Promise<MachineActionGateResult> {
  const admission = await admitMachineAction(db, input);
  if (!admission.ok) {
    await auditDenial(db, input, admission.reason, admission);
    return {
      ok: false,
      status: 403,
      wireReason: admission.reason === MACHINE_DENIAL_REASON.EXEC_DISABLED ? 'exec_disabled' : 'target_forbidden',
      reason: admission.reason,
    };
  }
  const actorKey = `${input.sourceOwnerUserId}\0${input.targetServerId}`;
  const withinActor = actorBudget.tryHit(actorKey, MACHINE_ACTION_RATE_LIMIT.PER_ACTOR_PER_DEVICE, input.now);
  const withinDevice = withinActor && deviceBudget.tryHit(input.targetServerId, MACHINE_ACTION_RATE_LIMIT.PER_DEVICE, input.now);
  if (!withinActor || !withinDevice) {
    await auditDenial(db, input, MACHINE_ACTION_RATE_LIMITED, admission.delegatedActorUserId
      ? { accessSource: admission.target.access_source, delegatedActorUserId: admission.delegatedActorUserId }
      : { accessSource: admission.target.access_source });
    return { ok: false, status: 429, wireReason: 'target_unavailable', reason: MACHINE_ACTION_RATE_LIMITED };
  }
  return { ok: true, admission };
}

export type { MachineAction };
