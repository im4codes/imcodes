import { closeSync, fsyncSync, openSync } from 'node:fs';

const TRANSIENT_FSYNC_ERRORS = new Set(['EACCES', 'EAGAIN', 'EBUSY', 'EPERM']);
const MAX_FSYNC_ATTEMPTS = 3;

/** Fsync a file descriptor, retrying short-lived antivirus/lock races. */
export function fsyncDescriptorSync(descriptor: number): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsyncSync(descriptor);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_FSYNC_ERRORS.has(code) || attempt >= MAX_FSYNC_ATTEMPTS) throw error;
    }
  }
}

/**
 * Persist directory metadata on POSIX. NTFS rejects directory fsync with
 * EPERM; the file was already fsynced before rename, and Windows' metadata
 * journal covers the rename, so directory fsync is intentionally skipped.
 */
export function fsyncDirectorySync(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncDescriptorSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
