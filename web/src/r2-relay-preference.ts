import { FILE_RELAY_MODE, R2_RELAY_PREFERENCE_KEY, type FileRelayMode } from '@shared/r2-relay.js';
export function readFileRelayMode(userId: string | null): FileRelayMode {
  if (!userId) return FILE_RELAY_MODE.DIRECT;
  try { return localStorage.getItem(`${R2_RELAY_PREFERENCE_KEY}:${userId}`) === FILE_RELAY_MODE.R2
    ? FILE_RELAY_MODE.R2 : FILE_RELAY_MODE.DIRECT; } catch { return FILE_RELAY_MODE.DIRECT; }
}
export function saveFileRelayMode(userId: string | null, mode: FileRelayMode): void {
  if (!userId) return;
  try { localStorage.setItem(`${R2_RELAY_PREFERENCE_KEY}:${userId}`, mode); } catch { /* ignore */ }
  notifyR2RelayState();
}

let currentUserId: string | null = null;
let serverR2RelayEnabled = false;
const listeners = new Set<() => void>();

function notifyR2RelayState(): void {
  for (const listener of listeners) listener();
}

export function setFileRelayUser(userId: string | null): void {
  if (currentUserId === userId) return;
  currentUserId = userId;
  notifyR2RelayState();
}
export function getFileRelayUser(): string | null { return currentUserId; }
export function setServerR2RelayEnabled(enabled: boolean): void {
  const next = enabled === true;
  if (serverR2RelayEnabled === next) return;
  serverR2RelayEnabled = next;
  notifyR2RelayState();
}
export function isServerR2RelayEnabled(): boolean { return serverR2RelayEnabled; }
export function subscribeR2RelayState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isFileRelaySelected(): boolean {
  return serverR2RelayEnabled && readFileRelayMode(currentUserId) === FILE_RELAY_MODE.R2;
}
