import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';
import { defaultCredentialPath } from './enrollment.js';

interface PersistedRemoteDesktopAccessState {
  version: 1;
  paused: boolean;
}

export function defaultRemoteDesktopAccessStatePath(
  credentialPath = defaultCredentialPath(),
): string {
  return join(dirname(credentialPath), REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_FILE);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function loadRemoteDesktopAccessPaused(path = defaultRemoteDesktopAccessStatePath()): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('remote_desktop_access_state_not_regular');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('remote_desktop_access_state_permissions_insecure');
    }
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedRemoteDesktopAccessState>;
    if (value.version !== 1 || typeof value.paused !== 'boolean') {
      throw new Error('remote_desktop_access_state_invalid');
    }
    return value.paused;
  } catch (error) {
    if (isNotFound(error)) return false;
    // Corruption must fail closed: losing a persisted pause on restart would
    // silently reopen a machine whose local operator explicitly closed it.
    return true;
  }
}

export async function persistRemoteDesktopAccessPaused(
  paused: boolean,
  path = defaultRemoteDesktopAccessStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, paused } satisfies PersistedRemoteDesktopAccessState));
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * Order the durable bit and the live admission gate so every interruption is
 * fail-closed: pausing closes first, while resuming persists before reopening.
 */
export async function applyRemoteDesktopAccessPaused(
  paused: boolean,
  enforce: (paused: boolean) => Promise<void>,
  path = defaultRemoteDesktopAccessStatePath(),
): Promise<void> {
  if (paused) {
    await enforce(true);
    await persistRemoteDesktopAccessPaused(true, path);
    return;
  }
  await persistRemoteDesktopAccessPaused(false, path);
  await enforce(false);
}
