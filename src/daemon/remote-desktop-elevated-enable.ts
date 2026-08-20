import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_OS_WIN,
} from '../../shared/controlled-node-artifacts.js';
import {
  REMOTE_DESKTOP_ELEVATED_ERROR,
  type RemoteDesktopElevatedError,
} from '../../shared/remote-desktop-elevated.js';
import { REMOTE_DESKTOP_ELEVATED_SERVICE } from '../node/remote-desktop-elevated-install.js';
import { downloadControlledNodeExecutable } from '../node/self-upgrade.js';
import type { DaemonCredential } from './machine-mcp-deps.js';

const execFileAsync = promisify(execFile);
const SID_RE = /^S-1-[0-9-]{3,}$/;

function powershell(): string {
  return join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

/**
 * The SID of the account this daemon runs as, which is the only account the
 * helper will serve. Read from the process's own token rather than from a name:
 * names are ambiguous across domains and locales, SIDs are not.
 */
export async function currentUserSid(
  run: (file: string, args: readonly string[]) => Promise<{ stdout: string }> = (file, args) =>
    execFileAsync(file, [...args], { windowsHide: true, timeout: 15_000 }),
): Promise<string> {
  const { stdout } = await run(powershell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ]);
  const sid = stdout.trim();
  if (!SID_RE.test(sid)) throw new Error('remote_desktop_elevated_user_sid_unavailable');
  return sid;
}

/**
 * Ask Windows to elevate the signed runtime so it can install the helper.
 *
 * `-Verb RunAs` is what raises the UAC prompt, and the prompt is where the
 * publisher of the executable is shown — the one check that a swapped binary
 * cannot pass. It appears on the machine's own screen, so whoever is enabling
 * this either is at the machine or is already controlling its desktop.
 * A dismissed prompt fails the call rather than hanging.
 */
export async function elevateElevatedHelperInstall(input: {
  executable: string;
  workerDirectory: string;
  userSid: string;
  run?: (file: string, args: readonly string[]) => Promise<unknown>;
}): Promise<void> {
  const run = input.run ?? ((file, args) => execFileAsync(file, [...args], {
    windowsHide: true,
    timeout: 300_000,
  }));
  const argumentList = [
    REMOTE_DESKTOP_ELEVATED_SERVICE.INSTALL_FLAG,
    '--worker-dir', input.workerDirectory,
    '--user-sid', input.userSid,
  ].map((value) => `'${value.replace(/'/g, "''")}'`).join(',');
  await run(powershell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; `
    + `$p = Start-Process -FilePath '${input.executable.replace(/'/g, "''")}' `
    + `-ArgumentList ${argumentList} -Verb RunAs -Wait -PassThru; `
    + 'if ($p.ExitCode -ne 0) { throw "elevated install exited $($p.ExitCode)" }',
  ]);
}

export interface EnableElevatedRemoteDesktopInput {
  /** Where the daemon keeps downloads; the runtime lands here before elevation. */
  root: string;
  /** The verified worker bundle to stage into the privileged root. */
  workerDirectory: string;
  loadCredential: () => Promise<DaemonCredential | null>;
  fetchImpl?: typeof fetch;
  downloadExecutable?: typeof downloadControlledNodeExecutable;
  resolveUserSid?: () => Promise<string>;
  elevate?: typeof elevateElevatedHelperInstall;
  /** Whether the helper answers now; polled after the elevated step returns. */
  isInstalled: () => boolean;
}

/**
 * Enable login-screen control: fetch the signed runtime, elevate once, and
 * confirm the helper came up.
 *
 * Returns null on success, or the reason to report. A dismissed UAC prompt and a
 * helper that failed to start are deliberately distinct: the first is the user
 * saying no, the second is something to look into.
 */
export async function enableElevatedRemoteDesktop(
  input: EnableElevatedRemoteDesktopInput,
): Promise<RemoteDesktopElevatedError | null> {
  const credential = await input.loadCredential();
  if (!credential) return REMOTE_DESKTOP_ELEVATED_ERROR.INSTALL_FAILED;
  const downloaded = await (input.downloadExecutable ?? downloadControlledNodeExecutable)({
    credential,
    target: { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 },
    dir: join(input.root, 'remote-desktop-elevated'),
    fetchImpl: input.fetchImpl ?? fetch,
  });
  if (!downloaded) return REMOTE_DESKTOP_ELEVATED_ERROR.INSTALL_FAILED;

  const userSid = await (input.resolveUserSid ?? currentUserSid)();
  try {
    await (input.elevate ?? elevateElevatedHelperInstall)({
      executable: downloaded.artifactPath,
      workerDirectory: input.workerDirectory,
      userSid,
    });
  } catch {
    // Windows reports a dismissed prompt as a failed Start-Process, and there is
    // no way to tell "declined" from "cancelled" — both mean nobody approved it.
    return REMOTE_DESKTOP_ELEVATED_ERROR.ELEVATION_DECLINED;
  }
  return input.isInstalled() ? null : REMOTE_DESKTOP_ELEVATED_ERROR.INSTALL_FAILED;
}
