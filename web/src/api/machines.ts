/**
 * Web client for the server-native, owner-scoped controllable-machine list
 * (`/api/machines`). Session-authenticated and daemon-independent: presence is
 * read from the DB (F1), so no `serverId` is sent — `apiFetch` handles cookie
 * credentials + CSRF automatically, mirroring `api/aliases.ts`.
 *
 * Returns the composer-facing machine DTO used by the `^^(name)` quick-reference
 * (ref_name key + render-only display name + online/exec-enabled flags). Offline
 * machines are included for display; the picker renders them non-selectable.
 */
import { MACHINE_API_PATH } from '@shared/machine-reference.js';
import { apiFetch } from '../api.js';

/** One controllable machine as shown in the composer picker. */
export interface MachineListItem {
  serverId: string;
  refName: string;
  displayName: string;
  os?: string;
  online: boolean;
  execEnabled: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizeMachine(raw: unknown): MachineListItem | null {
  if (!isRecord(raw)) return null;
  const serverId = typeof raw.serverId === 'string' ? raw.serverId : '';
  const refName = typeof raw.refName === 'string' ? raw.refName : '';
  if (!serverId || !refName) return null;
  return {
    serverId,
    refName,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : refName,
    ...(typeof raw.os === 'string' && raw.os ? { os: raw.os } : {}),
    online: raw.online === true,
    execEnabled: raw.execEnabled === true,
  };
}

function extractMachineList(res: unknown): MachineListItem[] {
  const rawList = isRecord(res) && Array.isArray(res.machines) ? res.machines : Array.isArray(res) ? res : [];
  const out: MachineListItem[] = [];
  for (const raw of rawList) {
    const m = normalizeMachine(raw);
    if (m) out.push(m);
  }
  return out;
}

/**
 * List the caller's controllable machines with DB-backed presence. Does NOT
 * swallow errors — the send path relies on distinguishing "loaded (empty)" from
 * "load failed" before attaching a marker resolution (fail-closed).
 */
export async function listControllableMachines(): Promise<MachineListItem[]> {
  const res = await apiFetch<unknown>(MACHINE_API_PATH);
  return extractMachineList(res);
}
