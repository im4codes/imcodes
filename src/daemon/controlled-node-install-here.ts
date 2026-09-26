import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL,
  CONTROLLED_NODE_INSTALL_COMMAND_PATH,
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  type ControlledNodeArtifactPair,
} from '../../shared/controlled-node-artifacts.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  type RemoteDesktopLoginScreenError,
} from '../../shared/remote-desktop-login-screen.js';
import type { DaemonCredential } from './machine-mcp-deps.js';

/**
 * Installing the IM.codes controlled node on a Linux or macOS daemon's own
 * computer, when its owner asks for it from the daemon's remote-desktop setup.
 *
 * The daemon runs exactly the script the copyable one-line command runs: it
 * fetches `/i/<code>` from the server it is bound to -- never from a URL taken
 * from the request -- and runs it as root. The install code was minted for this
 * daemon by its owner, so the node enrols linked to it.
 */

/** Downloading the node itself happens inside the script; allow a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SUDO_PROBE_TIMEOUT_MS = 15_000;
const MAX_SCRIPT_BYTES = 256 * 1024;
const SUDO = '/usr/bin/sudo';
const OSASCRIPT = '/usr/bin/osascript';

/** The artifact this computer needs, or null where a daemon cannot install one. */
export function controlledNodeInstallHereTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ControlledNodeArtifactPair | null {
  if (platform === 'linux' && arch === 'x64') {
    return { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 };
  }
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL };
  }
  return null;
}

export type ControlledNodeAdminRunOutcome = 'ok' | 'admin_required' | 'declined' | 'failed';

export type ControlledNodeAdminCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>;

const runCommand: ControlledNodeAdminCommandRunner = (file, args, timeoutMs) => new Promise(
  (resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? '') }));
      else resolve();
    });
  },
);

/**
 * Run the install script as root.
 *
 * A user allowed to sudo without a password installs silently, on either
 * system. Otherwise macOS shows its own administrator prompt on that Mac's
 * screen -- the counterpart of the UAC prompt the Windows install raises -- and
 * Linux reports that someone has to type the password there.
 */
export async function runControlledNodeInstallScriptAsAdmin(
  platform: NodeJS.Platform,
  script: string,
  run: ControlledNodeAdminCommandRunner = runCommand,
): Promise<ControlledNodeAdminRunOutcome> {
  const passwordless = await run(SUDO, ['-n', 'true'], SUDO_PROBE_TIMEOUT_MS).then(() => true, () => false);
  if (passwordless) {
    return run(SUDO, ['-n', '/bin/sh', script], INSTALL_TIMEOUT_MS).then(() => 'ok' as const, () => 'failed' as const);
  }
  if (platform !== 'darwin') return 'admin_required';
  // The path travels as an argument, never inside the AppleScript source.
  return run(OSASCRIPT, [
    '-e', 'on run argv',
    '-e', 'do shell script "/bin/sh " & quoted form of (item 1 of argv) with administrator privileges',
    '-e', 'end run',
    script,
  ], INSTALL_TIMEOUT_MS).then(
    () => 'ok' as const,
    (error: { stderr?: string }) => (/\(-128\)|User canceled/i.test(error?.stderr ?? '') ? 'declined' as const : 'failed' as const),
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export interface InstallControlledNodeHereInput {
  /** Minted by the owner's browser for this daemon. */
  installCode: string;
  platform: NodeJS.Platform;
  /** Where the daemon keeps downloads. */
  root: string;
  loadCredential: () => Promise<DaemonCredential | null>;
  fetchImpl?: typeof fetch;
  runAsAdmin?: (platform: NodeJS.Platform, script: string) => Promise<ControlledNodeAdminRunOutcome>;
  onState?: (state: 'downloading' | 'elevating') => void;
}

/**
 * Fetch the install code's script from this daemon's own server and run it as
 * root. Returns null on success, or the reason to report. Like the Windows
 * install, the node enrols itself from inside the script, so the browser sees
 * the outcome as the machine appearing, linked to this daemon.
 */
export async function installControlledNodeHere(
  input: InstallControlledNodeHereInput,
): Promise<RemoteDesktopLoginScreenError | null> {
  const credential = await input.loadCredential();
  if (!credential) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND;

  input.onState?.('downloading');
  let script: string;
  try {
    const url = new URL(`${CONTROLLED_NODE_INSTALL_COMMAND_PATH}/${input.installCode}`, credential.serverUrl);
    // The script runs as root, so it is only ever fetched over TLS (loopback
    // HTTP only for a development server), and never through a redirect.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
    }
    const response = await (input.fetchImpl ?? fetch)(url, { redirect: 'error' });
    if (!response.ok) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
    script = await response.text();
  } catch {
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
  }
  if (!script.startsWith('#!/bin/sh') || Buffer.byteLength(script) > MAX_SCRIPT_BYTES) {
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
  }

  const directory = join(input.root, 'node-install');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Named by content so a retry cannot run a stale download.
  const scriptPath = join(directory, `install-${createHash('sha256').update(script).digest('hex').slice(0, 16)}.sh`);
  await writeFile(scriptPath, script, { mode: 0o700 });
  input.onState?.('elevating');
  try {
    const outcome = await (input.runAsAdmin ?? runControlledNodeInstallScriptAsAdmin)(input.platform, scriptPath);
    if (outcome === 'ok') return null;
    if (outcome === 'admin_required') return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ADMIN_REQUIRED;
    if (outcome === 'declined') return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED;
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED;
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
  }
}
