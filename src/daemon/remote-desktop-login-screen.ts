import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  type RemoteDesktopLoginScreenError,
} from '../../shared/remote-desktop-login-screen.js';
import type { DaemonCredential } from './machine-mcp-deps.js';

const execFileAsync = promisify(execFile);

/** The enrolment download, which personalises the executable for one ticket. */
const ENROLL_DOWNLOAD_PATH = '/api/enroll/v2/download';

function powershell(): string {
  return join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

/**
 * Ask Windows to run the enrolment installer elevated.
 *
 * `-Verb RunAs` raises the UAC prompt, and that prompt is where the executable's
 * publisher is shown — the check a swapped binary cannot pass. It appears on the
 * machine's own screen, so whoever enables this is either sitting at it or
 * already controlling its desktop. A dismissed prompt fails the call instead of
 * hanging, and `-Wait` means the daemon reports only once the installer is done.
 */
export async function elevateLoginScreenInstaller(
  executable: string,
  run: (file: string, args: readonly string[]) => Promise<unknown> = (file, args) =>
    execFileAsync(file, [...args], { windowsHide: true, timeout: 600_000 }),
): Promise<void> {
  await run(powershell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference=\'Stop\'; '
    + `$p = Start-Process -FilePath '${executable.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; `
    + 'if ($p.ExitCode -ne 0) { throw "elevated install exited $($p.ExitCode)" }',
  ]);
}

export interface InstallLoginScreenControlInput {
  /** Minted by the browser with the user's own session. */
  ticket: string;
  /** Where the daemon keeps downloads. */
  root: string;
  loadCredential: () => Promise<DaemonCredential | null>;
  fetchImpl?: typeof fetch;
  elevate?: (executable: string) => Promise<void>;
  onState?: (state: 'downloading' | 'elevating') => void;
}

/**
 * Fetch the ticket's installer and run it elevated once.
 *
 * Returns null on success, or the reason to report. Nothing about the enrolment
 * itself is decided here: the installer enrols the node from inside, which is
 * why the browser learns the outcome by seeing the machine appear rather than
 * from this daemon.
 */
export async function installLoginScreenControl(
  input: InstallLoginScreenControlInput,
): Promise<RemoteDesktopLoginScreenError | null> {
  const credential = await input.loadCredential();
  if (!credential) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND;

  input.onState?.('downloading');
  const url = new URL(ENROLL_DOWNLOAD_PATH, credential.serverUrl).toString();
  let bytes: Buffer;
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${input.ticket}` },
    });
    if (!response.ok) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
  }
  // An installer is personalised per ticket, so it carries an enrolment blob
  // rather than being a fixed artifact with a known digest. Refusing an empty or
  // absurdly small body is the one sanity check available before elevating.
  if (bytes.length < 1024) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;

  const directory = join(input.root, 'login-screen');
  await mkdir(directory, { recursive: true });
  // Named by content so a retry cannot silently elevate a stale download.
  const executable = join(
    directory,
    `imcodes-node-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.exe`,
  );
  await writeFile(executable, bytes, { mode: 0o755 });

  input.onState?.('elevating');
  try {
    await (input.elevate ?? elevateLoginScreenInstaller)(executable);
  } catch {
    // Windows reports a dismissed prompt as a failed Start-Process, and cannot
    // distinguish "declined" from "cancelled" — both mean nobody approved it.
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED;
  }
  return null;
}
