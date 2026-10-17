import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The macOS sign-in secret used to unlock a locked Mac for a remote controller.
 *
 * Windows keeps the equivalent machine-scoped under DPAPI inside its SYSTEM
 * worker. On macOS the worker runs as the logged-in user, so it must never hold
 * the secret at rest: the node (root) keeps it here, beside its own credential,
 * and hands it to the authenticated worker of the live session only when an
 * unlock is actually requested. The directory is root-only (0700) and the file
 * 0600; nothing here logs, caches or returns the value except `reveal()`.
 */
export interface MacosRemoteDesktopUnlockSecretStore {
  configured(): Promise<boolean>;
  reveal(): Promise<string | null>;
  store(secret: string): Promise<boolean>;
  clear(): Promise<boolean>;
}

export const MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE = 'sign-in-secret';
/** A macOS account password is bounded well below this; anything larger is not one. */
export const MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_MAX_BYTES = 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export function isAcceptableMacosUnlockSecret(secret: string): boolean {
  if (secret.length === 0 || secret.includes('\0')) return false;
  return Buffer.byteLength(secret, 'utf8') <= MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_MAX_BYTES;
}

export function createMacosRemoteDesktopUnlockSecretStore(
  directory: string,
): MacosRemoteDesktopUnlockSecretStore {
  const path = join(directory, MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE);

  /** Refuses a directory or file anyone but this process's user could touch. */
  const safe = async (target: string, expectDirectory: boolean): Promise<boolean> => {
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) return false;
      if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) return false;
      const uid = process.geteuid?.() ?? stat.uid;
      return stat.uid === uid && (stat.mode & 0o077) === 0;
    } catch {
      return false;
    }
  };

  const ensureDirectory = async (): Promise<boolean> => {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    return await safe(directory, true);
  };

  const reveal = async (): Promise<string | null> => {
    if (!await safe(directory, true) || !await safe(path, false)) return null;
    try {
      const value = await readFile(path, 'utf8');
      return isAcceptableMacosUnlockSecret(value) ? value : null;
    } catch {
      return null;
    }
  };

  return {
    async configured() {
      return (await reveal()) !== null;
    },

    reveal,

    async store(secret) {
      if (!isAcceptableMacosUnlockSecret(secret)) return false;
      try {
        if (!await ensureDirectory()) return false;
        // Written beside the target and renamed over it, so a crash leaves
        // either the old secret or the new one -- never a truncated file.
        const temporary = join(directory, `.${MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE}.${randomBytes(6).toString('hex')}`);
        const handle = await open(temporary, 'wx', FILE_MODE);
        try {
          await handle.writeFile(secret, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, FILE_MODE);
        await rename(temporary, path);
        return await safe(path, false);
      } catch {
        return false;
      }
    },

    async clear() {
      try {
        await rm(path, { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
