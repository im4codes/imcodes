import type { RemoteExecOutcome } from '../../../shared/remote-exec.js';
import type { Database } from '../db/client.js';

export interface MachineExecAuditIntent {
  correlationId: string;
  userId: string;
  sourceServerId: string;
  targetServerId: string;
  commandSha256: string;
  commandLength: number;
  shell: string;
  now: number;
}

export interface MachineExecAuditResult {
  outcome: RemoteExecOutcome;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  now: number;
}

/** Persist dispatch intent. Failure is fatal and MUST happen before socket send. */
export async function createMachineExecAuditIntent(
  db: Database,
  intent: MachineExecAuditIntent,
): Promise<void> {
  const result = await db.execute(
    `INSERT INTO machine_exec_audit
       (correlation_id, user_id, source_server_id, target_server_id,
        command_sha256, command_length, shell, outcome, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)`,
    [
      intent.correlationId,
      intent.userId,
      intent.sourceServerId,
      intent.targetServerId,
      intent.commandSha256,
      intent.commandLength,
      intent.shell,
      intent.now,
    ],
  );
  if (result.changes !== 1) throw new Error('machine_exec_audit_intent_not_persisted');
}

/**
 * Update the same semantic row after dispatch. Callers must log update failures,
 * but MUST NOT turn an already-dispatched command into a retry-safe HTTP error.
 */
export async function updateMachineExecAuditResult(
  db: Database,
  correlationId: string,
  result: MachineExecAuditResult,
): Promise<boolean> {
  const updated = await db.execute(
    `UPDATE machine_exec_audit
        SET outcome = $2, exit_code = $3, timed_out = $4,
            duration_ms = $5, updated_at = $6
      WHERE correlation_id = $1`,
    [
      correlationId,
      result.outcome,
      result.exitCode,
      result.timedOut,
      result.durationMs,
      result.now,
    ],
  );
  return updated.changes === 1;
}
