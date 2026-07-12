import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import {
  NODE_ROLE,
  encodeEnrollmentTrailer,
  decodeEnrollmentTrailer,
  ENROLLMENT_MAX_TRAILER_BYTES,
  type EnrollRedeemResponse,
  type EnrollmentBlob,
} from '../../shared/remote-exec.js';

export interface ControlledNodeCredential extends EnrollRedeemResponse {
  serverUrl: string;
}

// Framing lives in shared/ (10.4): the server download route and the node use
// one implementation. The node keeps only the IO layer. These thin wrappers
// preserve the historical names used by callers/tests.
export function encodeEnrollmentBlob(blob: EnrollmentBlob): Buffer {
  return encodeEnrollmentTrailer(blob);
}

export function parseEnrollmentBlob(data: Buffer): EnrollmentBlob | null {
  return decodeEnrollmentTrailer(data);
}

/** Read only the executable's tail (random access, no full-file load). */
export async function readEnrollmentBlob(executablePath = process.execPath): Promise<EnrollmentBlob | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(executablePath, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - ENROLLMENT_MAX_TRAILER_BYTES);
    const length = size - start;
    if (length <= 0) return null;
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, start);
    return decodeEnrollmentTrailer(buf);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export function defaultCredentialPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'imcodes-node', 'credential.json');
  return platform === 'darwin'
    ? '/Library/Application Support/imcodes-node/credential.json'
    : '/var/lib/imcodes-node/credential.json';
}

export async function loadCredential(path = defaultCredentialPath()): Promise<ControlledNodeCredential | null> {
  try {
    // The credential grants SYSTEM/root remote exec; refuse to start from a
    // symlinked or group/world-accessible credential file (10.10).
    if (process.platform !== 'win32') {
      const st = await lstat(path);
      if (st.isSymbolicLink()) return null;
      if ((st.mode & 0o077) !== 0) return null;
    }
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlledNodeCredential>;
    if (value.nodeRole !== NODE_ROLE.CONTROLLED || !value.serverId || !value.token || !value.serverUrl) return null;
    return value as ControlledNodeCredential;
  } catch {
    return null;
  }
}

export async function persistCredential(credential: ControlledNodeCredential, path = defaultCredentialPath()): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {});
  // Never follow a pre-existing symlink at the credential path (anti-redirect).
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error('credential_path_is_symlink');
  } catch (err) {
    if ((err as { message?: string })?.message === 'credential_path_is_symlink') throw err;
    // ENOENT (no existing file) is expected on first write.
  }
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(credential), { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(temp, 0o600).catch(() => {});
  await rename(temp, path);
}

export async function redeemEnrollment(blob: EnrollmentBlob, fetchFn: typeof fetch = fetch): Promise<ControlledNodeCredential> {
  const response = await fetchFn(`${blob.serverUrl.replace(/\/$/, '')}/api/enroll/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollToken: blob.enrollToken, hostname: os.hostname(), os: `${process.platform}-${process.arch}` }),
  });
  if (!response.ok) throw new Error(`enrollment_redeem_failed:${response.status}`);
  const value = await response.json() as EnrollRedeemResponse;
  if (value.nodeRole !== NODE_ROLE.CONTROLLED || !value.serverId || !value.token) throw new Error('enrollment_redeem_invalid_response');
  return { ...value, serverUrl: blob.serverUrl.replace(/\/$/, '') };
}

/**
 * Best-effort token burn (D-A privacy cleanup only, NOT a security boundary; the
 * server-side used state is authoritative). Truncates the fixed-footer trailer
 * from the executable tail if present. Failure (e.g. a locked running image on
 * Windows) is surfaced to the caller rather than a security guarantee.
 */
export async function burnEnrollmentBlob(executablePath = process.execPath): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(executablePath, 'r+');
    const { size } = await fh.stat();
    const start = Math.max(0, size - ENROLLMENT_MAX_TRAILER_BYTES);
    const length = size - start;
    if (length <= 0) return;
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, start);
    if (!decodeEnrollmentTrailer(buf)) return; // no trailer present
    // Zero the tail region that holds the trailer (best-effort privacy).
    await fh.write(Buffer.alloc(length), 0, length, start);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
