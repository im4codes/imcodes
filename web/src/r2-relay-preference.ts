import { FILE_RELAY_MODE, R2_RELAY_PREFERENCE_KEY, type FileRelayMode } from '@shared/r2-relay.js';
export function readFileRelayMode(userId: string | null): FileRelayMode {
  if (!userId) return FILE_RELAY_MODE.DIRECT;
  try { return localStorage.getItem(`${R2_RELAY_PREFERENCE_KEY}:${userId}`) === FILE_RELAY_MODE.R2
    ? FILE_RELAY_MODE.R2 : FILE_RELAY_MODE.DIRECT; } catch { return FILE_RELAY_MODE.DIRECT; }
}
export function saveFileRelayMode(userId: string | null, mode: FileRelayMode): void {
  if (!userId) return;
  localStorage.setItem(`${R2_RELAY_PREFERENCE_KEY}:${userId}`, mode);
}

let currentUserId: string | null = null;
export function setFileRelayUser(userId: string | null): void { currentUserId = userId; }
export function isFileRelaySelected(): boolean { return readFileRelayMode(currentUserId) === FILE_RELAY_MODE.R2; }
