import { execFile, spawn, type ChildProcess } from 'node:child_process';

export const MACOS_LAUNCHCTL_PATH = '/bin/launchctl';
export const MACOS_MAX_USER_ID = 0xffff_fffe;

const MACOS_USER_SESSION_FIELD_MAX_BYTES = 4_096;
const MACOS_USER_NAME_MAX_BYTES = 255;

export const MACOS_USER_SESSION_ERROR = Object.freeze({
  NO_ACTIVE_GUI_SESSION: 'computer_use_no_active_gui_session',
  INVALID_CONSOLE_USER: 'computer_use_invalid_console_user',
  INVALID_CONSOLE_USER_HOME: 'computer_use_invalid_console_user_home',
  INVALID_CONSOLE_USER_TEMP: 'computer_use_invalid_console_user_temp',
  INVALID_COMMAND: 'macos_user_session_invalid_command',
} as const);

export interface MacosUserSession {
  name: string;
  uid: number;
  gid: number;
  home: string;
  tempDir: string;
}

export interface MacosUserSessionCommand {
  executable: string;
  args?: readonly string[];
  environment?: readonly (readonly [name: string, value: string])[];
}

export type MacosExecFileText = (
  file: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<string>;

export interface MacosUserSessionDiscoveryOptions {
  execFileText?: MacosExecFileText;
}

function defaultExecFileText(
  file: string,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function isBoundedText(value: string, maxBytes = MACOS_USER_SESSION_FIELD_MAX_BYTES): boolean {
  return value.length > 0
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r')
    && Buffer.byteLength(value) <= maxBytes;
}

function isEligibleMacosUserName(value: string): boolean {
  return isBoundedText(value, MACOS_USER_NAME_MAX_BYTES)
    && /^[A-Za-z0-9._-]+$/.test(value)
    && !value.startsWith('-')
    && value !== 'root'
    && value !== 'loginwindow'
    && value !== '_mbsetupuser';
}

function parseMacosUserId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    && parsed > 0
    && parsed <= MACOS_MAX_USER_ID
    ? parsed
    : null;
}

function isAbsoluteBoundedPath(value: string): boolean {
  return value.startsWith('/') && isBoundedText(value);
}

export function assertMacosUserSession(user: MacosUserSession): void {
  if (!isEligibleMacosUserName(user.name)
    || !Number.isInteger(user.uid)
    || user.uid <= 0
    || user.uid > MACOS_MAX_USER_ID
    || !Number.isInteger(user.gid)
    || user.gid <= 0
    || user.gid > MACOS_MAX_USER_ID) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER);
  }
  if (!isAbsoluteBoundedPath(user.home)) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER_HOME);
  }
  if (!isAbsoluteBoundedPath(user.tempDir)) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER_TEMP);
  }
}

/**
 * Resolve the one active macOS GUI console user.
 *
 * The error strings intentionally preserve the existing Computer Use contract
 * while this launcher becomes the common seam for Computer Use and remote
 * desktop. The launcher owns no request, route, socket or authority state.
 */
export async function resolveMacosUserSession(
  options: MacosUserSessionDiscoveryOptions = {},
): Promise<MacosUserSession> {
  const execText = options.execFileText ?? defaultExecFileText;
  const name = await execText('/usr/bin/stat', ['-f', '%Su', '/dev/console']);
  if (!isEligibleMacosUserName(name)) {
    throw new Error(MACOS_USER_SESSION_ERROR.NO_ACTIVE_GUI_SESSION);
  }

  const uid = parseMacosUserId(await execText('/usr/bin/id', ['-u', name]));
  const gid = parseMacosUserId(await execText('/usr/bin/id', ['-g', name]));
  if (uid === null || gid === null) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER);
  }

  const home = await execText('/usr/bin/dscl', [
    '.',
    '-read',
    `/Users/${name}`,
    'NFSHomeDirectory',
  ]).then((line) => line.replace(/^NFSHomeDirectory:\s*/, '').trim());
  if (!isAbsoluteBoundedPath(home)) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER_HOME);
  }

  const tempDir = await execText('/usr/bin/sudo', [
    '-n',
    '-u',
    name,
    '/usr/bin/getconf',
    'DARWIN_USER_TEMP_DIR',
  ]);
  if (!isAbsoluteBoundedPath(tempDir)) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER_TEMP);
  }

  return { name, uid, gid, home, tempDir };
}

function assertMacosUserSessionCommand(command: MacosUserSessionCommand): void {
  if (!isAbsoluteBoundedPath(command.executable)) {
    throw new Error(MACOS_USER_SESSION_ERROR.INVALID_COMMAND);
  }
  for (const arg of command.args ?? []) {
    if (!isBoundedText(arg)) throw new Error(MACOS_USER_SESSION_ERROR.INVALID_COMMAND);
  }
  const names = new Set<string>();
  for (const [name, value] of command.environment ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || names.has(name)
      || !isBoundedText(value)) {
      throw new Error(MACOS_USER_SESSION_ERROR.INVALID_COMMAND);
    }
    names.add(name);
  }
}

export function macosUserSessionLaunchctlArgs(
  user: MacosUserSession,
  command: MacosUserSessionCommand,
): string[] {
  assertMacosUserSession(user);
  assertMacosUserSessionCommand(command);
  return [
    'asuser',
    String(user.uid),
    '/usr/bin/sudo',
    '-n',
    '-u',
    user.name,
    '/usr/bin/env',
    `HOME=${user.home}`,
    `TMPDIR=${user.tempDir}`,
    ...(command.environment ?? []).map(([name, value]) => `${name}=${value}`),
    command.executable,
    ...(command.args ?? []),
  ];
}

export async function runMacosUserSessionCommand(
  user: MacosUserSession,
  command: MacosUserSessionCommand,
  timeoutMs = 15_000,
  execText: MacosExecFileText = defaultExecFileText,
): Promise<void> {
  await execText(MACOS_LAUNCHCTL_PATH, macosUserSessionLaunchctlArgs(user, command), timeoutMs);
}

export function launchMacosUserSessionCommand(
  user: MacosUserSession,
  command: MacosUserSessionCommand,
  spawnImpl: typeof spawn = spawn,
): ChildProcess {
  const child = spawnImpl(MACOS_LAUNCHCTL_PATH, macosUserSessionLaunchctlArgs(user, command), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
