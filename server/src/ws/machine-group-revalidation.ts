import type { Database } from '../db/client.js';
import { WsBridge } from './bridge.js';
import { mutateMachineGroupAccess } from '../services/machine-group-invalidation.js';
import type { MachineGroupInvalidationScope } from '../../../shared/machine-group-invalidation.js';

/** Only this pod's existing bridges, for targets actually associated with the changed group. */
export async function applyMachineGroupInvalidation(db: Database, scope: MachineGroupInvalidationScope): Promise<void> {
  const local = [...WsBridge.getAll().keys()];
  const targets = scope.serverId ? [scope.serverId] : !local.length ? [] : (await db.query<{ server_id: string }>(
    'SELECT server_id FROM machine_groups WHERE team_id = $1 AND server_id = ANY($2::text[])', [scope.teamId, local],
  )).map((row) => row.server_id);
  await Promise.all(targets.map((serverId) => scope.actorId
    ? WsBridge.find(serverId)?.revalidateShareSocketsForUser(scope.actorId)
    : WsBridge.find(serverId)?.revalidateMachineGroupAccess()));
}

export function failClosedMachineGroupConnections(): void {
  for (const bridge of WsBridge.getAll().values()) bridge.failClosedMachineGroupAccess();
}

export function mutateAndRevalidateMachineGroupAccess(
  db: Database, scope: MachineGroupInvalidationScope, mutation: (tx: Database) => Promise<unknown>,
): Promise<void> {
  return mutateMachineGroupAccess(db, scope, mutation, (event) => applyMachineGroupInvalidation(db, event));
}

/** Also usable by explicit notifications, with the same fleet-wide completion semantics. */
export function revalidateGroupMemberMachines(db: Database, teamId: string, actor: string): Promise<void> {
  return mutateAndRevalidateMachineGroupAccess(db, { teamId, actorId: actor }, async () => {});
}
