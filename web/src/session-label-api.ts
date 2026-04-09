import { apiFetch } from './api.js';

export async function updateMainSessionLabel(
  serverId: string,
  sessionName: string,
  nextLabel: string | null,
): Promise<void> {
  await apiFetch(`/api/server/${serverId}/sessions/${encodeURIComponent(sessionName)}/label`, {
    method: 'PATCH',
    keepalive: true,
    body: JSON.stringify({ label: nextLabel }),
  });
}
