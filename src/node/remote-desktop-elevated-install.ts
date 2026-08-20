import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REMOTE_DESKTOP_ELEVATED_LIMITS,
} from '../../shared/remote-desktop-elevated.js';
import { REMOTE_DESKTOP_WORKER_FILENAME } from '../../shared/remote-desktop-worker.js';
import {
  REMOTE_DESKTOP_COMPILED_SIGNER_SHA256,
  verifyWindowsAuthenticodeSigners,
} from './remote-desktop-worker-host.js';
import {
  assertProcessElevated,
  windowsCredentialAclCommands,
  windowsElevatedRemoteDesktopSecretAclCommands,
  windowsExecutableFileAclCommands,
  windowsScheduledTaskArgs,
  windowsScheduledTaskXml,
  type WindowsAclCommand,
} from './installer.js';

/** The task and flags that make up login-screen control. */
export const REMOTE_DESKTOP_ELEVATED_SERVICE = {
  WINDOWS_TASK: 'imcodes-remote-desktop-elevated',
  /** Runs the helper. Set on the registered task, never taken from a caller. */
  HOST_FLAG: '--remote-desktop-elevated-host',
  /** Performs this install. Invoked once, elevated, through a UAC prompt. */
  INSTALL_FLAG: '--install-remote-desktop-elevated-host',
  EXECUTABLE: 'imcodes-node.exe',
  SECRET_FILE: 'elevated.secret',
  CONFIG_FILE: 'elevated.json',
} as const;

/**
 * Where the privileged half lives.
 *
 * Under ProgramData rather than the daemon's own directory, and owned by SYSTEM:
 * a LocalSystem service must never execute anything its own unprivileged user
 * can rewrite, which is exactly what the daemon's npm install is.
 */
export function elevatedRemoteDesktopRoot(programData = process.env.ProgramData): string {
  return join(programData ?? 'C:\\ProgramData', 'imcodes', 'remote-desktop-elevated');
}

export interface ElevatedRemoteDesktopConfig {
  /** The one account allowed to drive the helper. */
  userSid: string;
}

export interface ElevatedRemoteDesktopInstallInput {
  /** A verified copy of the signed runtime, downloaded by the daemon. */
  sourceExecutable: string;
  /** The verified worker bundle's platform directory. */
  sourceWorkerDirectory: string;
  /** SID of the user enabling this; the helper will serve only them. */
  userSid: string;
  root?: string;
  runCommand?: (file: string, args: readonly string[]) => void;
  applyAcl?: (commands: readonly WindowsAclCommand[]) => void;
  assertElevated?: () => void;
  /** Authenticode check applied to the staged copies before registration. */
  verifySigners?: (paths: readonly string[], signerSha256: string) => Promise<boolean>;
  trustedSignerSha256?: string;
  now?: Date;
}

function defaultRunCommand(file: string, args: readonly string[]): void {
  execFileSync(file, [...args], { stdio: 'ignore', windowsHide: true });
}

function defaultApplyAcl(commands: readonly WindowsAclCommand[]): void {
  for (const [path, ...args] of commands) {
    execFileSync('icacls', [path, ...args], { stdio: 'ignore', windowsHide: true });
  }
}

/**
 * Install and start the elevated helper. Must run elevated; this is the one
 * step behind the UAC prompt.
 *
 * The runtime and the worker bundle are copied out of the user's directory into
 * the SYSTEM-owned root before anything is registered, so what the service
 * executes cannot be swapped afterwards by the account it serves. The secret is
 * generated here — not by the daemon — so the privileged side decides what
 * authenticates the unprivileged one.
 */
export async function installElevatedRemoteDesktopHost(
  input: ElevatedRemoteDesktopInstallInput,
): Promise<{ root: string; executable: string; task: string }> {
  (input.assertElevated ?? assertProcessElevated)();
  const root = input.root ?? elevatedRemoteDesktopRoot();
  const runCommand = input.runCommand ?? defaultRunCommand;
  const applyAcl = input.applyAcl ?? defaultApplyAcl;

  mkdirSync(root, { recursive: true });
  // Lock the directory down before it holds anything worth protecting.
  applyAcl(windowsCredentialAclCommands(root));

  const executable = join(root, REMOTE_DESKTOP_ELEVATED_SERVICE.EXECUTABLE);
  cpSync(input.sourceExecutable, executable);
  applyAcl(windowsExecutableFileAclCommands(executable));

  const workerDirectory = join(root, 'remote-desktop-worker', 'win32-x64');
  mkdirSync(workerDirectory, { recursive: true });
  cpSync(input.sourceWorkerDirectory, workerDirectory, { recursive: true });
  const workerExecutable = join(workerDirectory, REMOTE_DESKTOP_WORKER_FILENAME);
  applyAcl(windowsExecutableFileAclCommands(workerExecutable));

  // Windows names the publisher in the UAC prompt that got us here, which is
  // what stops a swapped binary from being elevated in the first place. This
  // re-checks the staged copies against the pin compiled into this release, so
  // nothing unsigned is left behind registered as a LocalSystem service.
  const trustedSigner = input.trustedSignerSha256 ?? REMOTE_DESKTOP_COMPILED_SIGNER_SHA256;
  const authentic = await (input.verifySigners ?? verifyWindowsAuthenticodeSigners)(
    [executable, workerExecutable],
    trustedSigner,
  );
  if (!authentic) {
    rmSync(root, { recursive: true, force: true });
    throw new Error('remote_desktop_elevated_authenticity_failed');
  }

  const secret = randomBytes(REMOTE_DESKTOP_ELEVATED_LIMITS.SECRET_BYTES).toString('base64url');
  const secretPath = join(root, REMOTE_DESKTOP_ELEVATED_SERVICE.SECRET_FILE);
  writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  applyAcl(windowsElevatedRemoteDesktopSecretAclCommands(secretPath, input.userSid));

  const config: ElevatedRemoteDesktopConfig = { userSid: input.userSid };
  const configPath = join(root, REMOTE_DESKTOP_ELEVATED_SERVICE.CONFIG_FILE);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
  applyAcl(windowsExecutableFileAclCommands(configPath));

  const taskXmlPath = join(root, 'task.xml');
  writeFileSync(taskXmlPath, windowsScheduledTaskXml(executable, input.now ?? new Date(), {
    description: 'IM.codes remote desktop elevated helper',
    arguments: [REMOTE_DESKTOP_ELEVATED_SERVICE.HOST_FLAG],
  }), { encoding: 'utf16le' });
  runCommand('schtasks', windowsScheduledTaskArgs(
    taskXmlPath,
    REMOTE_DESKTOP_ELEVATED_SERVICE.WINDOWS_TASK,
  ));
  runCommand('schtasks', ['/Run', '/TN', REMOTE_DESKTOP_ELEVATED_SERVICE.WINDOWS_TASK]);

  return { root, executable, task: REMOTE_DESKTOP_ELEVATED_SERVICE.WINDOWS_TASK };
}

/** The secret the daemon must present, or '' when the helper is not installed. */
export function readElevatedRemoteDesktopSecret(root = elevatedRemoteDesktopRoot()): string {
  try {
    return readFileSync(
      join(root, REMOTE_DESKTOP_ELEVATED_SERVICE.SECRET_FILE),
      'utf8',
    ).trim();
  } catch {
    return '';
  }
}

/** The account the helper was installed for, or null when not installed. */
export function readElevatedRemoteDesktopConfig(
  root = elevatedRemoteDesktopRoot(),
): ElevatedRemoteDesktopConfig | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, REMOTE_DESKTOP_ELEVATED_SERVICE.CONFIG_FILE), 'utf8'),
    );
    const userSid = (parsed as { userSid?: unknown } | null)?.userSid;
    return typeof userSid === 'string' && userSid ? { userSid } : null;
  } catch {
    return null;
  }
}
