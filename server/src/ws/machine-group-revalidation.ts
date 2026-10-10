import type { Database } from '../db/client.js';
import { WsBridge } from './bridge.js';

/** Notify only existing sockets for devices actually associated with the changed group. */
export async function revalidateGroupMemberMachines(db: Database, teamId: string, actor: string): Promise<void> {
  const targets = await db.query<{ server_id: string }>(
    'SELECT server_id FROM machine_groups WHERE team_id = $1', [teamId],
  );
  await Promise.all(targets.map(({ server_id }) => WsBridge.find(server_id)?.revalidateShareSocketsForUser(actor)));
}
