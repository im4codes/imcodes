import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  chown,
  chmod,
  lchown,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AIDESK_LINUX_DESKTOP_FILE_NAME,
  AIDESK_MACOS_APP_NAME,
  AIDESK_PRODUCT_NAME,
  AIDESK_WINDOWS_SHORTCUT_FILE_NAME,
} from '../../shared/aidesk-product.js';
import { AIDESK_HICOLOR_ICONS_BASE64 } from '../../shared/aidesk-icon-generated.js';
import { parseAideskMenuBarProcesses } from '../../shared/aidesk-app-refresh.js';
import { MACOS_AIDESK_EXECUTABLE } from './macos-computer-use.js';
import { LOCAL_PANEL_LINUX_WM_CLASS } from '../../shared/local-panel-window.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';
import { pickLinuxDesktopUserProfile } from './linux-desktop-environment.js';
import { MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH } from './macos-remote-desktop-responsible-spawn.js';
import {
  launchMacosUserSessionCommand,
  resolveMacosUserSession,
  type MacosExecFileText,
  type MacosUserSession,
} from './user-session-launcher.js';
import {
  allowWindowsNamedPipeClients,
  launchWindowsActiveUserCommand,
} from './windows-user-session.js';

const MANAGED_MARKER = 'X-IMCodes-Managed=true';
const WINDOWS_MANAGED_DESCRIPTION = `${AIDESK_PRODUCT_NAME} — managed by IM.codes`;

export type AideskDesktopEntryResult =
  | 'created' | 'repaired' | 'unchanged' | 'preserved' | 'unavailable' | 'failed';

function defaultMacosExecFileText(
  file: string,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolveText, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolveText(String(stdout).trim());
    });
  });
}

function desktopExecQuote(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('aidesk_desktop_entry_invalid_path');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`;
}

/** The themed icon name of the desktop entry: the PNGs are written to the user's hicolor theme under this name (see writeLinuxAideskIcons). */
export const LINUX_AIDESK_ICON_NAME = 'aidesk';

export function buildLinuxAideskDesktopEntry(executablePath: string): string {
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${AIDESK_PRODUCT_NAME}\nComment=${AIDESK_PRODUCT_NAME}\nExec=${desktopExecQuote(executablePath)} --open-local-panel\nIcon=${LINUX_AIDESK_ICON_NAME}\nTerminal=false\nCategories=Network;RemoteAccess;\nStartupNotify=true\nStartupWMClass=${LOCAL_PANEL_LINUX_WM_CLASS}\n${MANAGED_MARKER}\n`;
}

function windowsEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * PowerShell runs inside the active user's session, so SpecialFolder(Programs)
 * resolves that user's Start menu rather than the service account's profile.
 * It repairs only a shortcut carrying our exact ownership description.
 */
export function buildWindowsAideskShortcutCommand(
  executablePath: string,
  resultPath?: string,
): string {
  const target64 = Buffer.from(executablePath, 'utf8').toString('base64');
  const name64 = Buffer.from(AIDESK_WINDOWS_SHORTCUT_FILE_NAME, 'utf8').toString('base64');
  const description64 = Buffer.from(WINDOWS_MANAGED_DESCRIPTION, 'utf8').toString('base64');
  const result64 = Buffer.from(resultPath ?? '', 'utf8').toString('base64');
  const script = String.raw`$ErrorActionPreference='Stop'
$utf8=[Text.Encoding]::UTF8
$target=$utf8.GetString([Convert]::FromBase64String('${target64}'))
$name=$utf8.GetString([Convert]::FromBase64String('${name64}'))
$description=$utf8.GetString([Convert]::FromBase64String('${description64}'))
$resultPath=$utf8.GetString([Convert]::FromBase64String('${result64}'))
function Report([string]$value){if($resultPath){Set-Content -LiteralPath $resultPath -Value $value -NoNewline -Encoding UTF8}}
$programs=[Environment]::GetFolderPath('Programs')
$path=[IO.Path]::Combine($programs,$name)
$shell=New-Object -ComObject WScript.Shell
$status='created'
if(Test-Path -LiteralPath $path){
  $old=$shell.CreateShortcut($path)
  if($old.Description -ne $description){Report 'preserved';exit 0}
  if($old.TargetPath -eq $target -and $old.Arguments -eq '--open-local-panel' -and $old.Description -eq $description){Report 'unchanged';exit 0}
  $status='repaired'
}
$shortcut=$shell.CreateShortcut($path)
$shortcut.TargetPath=$target
$shortcut.Arguments='--open-local-panel'
$shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($target)
$shortcut.IconLocation=$target+',0'
$shortcut.Description=$description
$shortcut.Save()
Report $status`;
  return `-NoProfile -NonInteractive -EncodedCommand ${windowsEncodedCommand(script)}`;
}

type WindowsShortcutLaunch = (
  command: string,
  onFailure: (detail: string) => void,
) => void | Promise<void>;

type WindowsActiveUserProcessLaunch = (
  executable: string,
  command: string,
  onFailure: (detail: string) => void,
) => void | Promise<void>;

export function resolveWindowsPowerShellExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const systemRoot = (environment.SystemRoot ?? environment.WINDIR)?.trim();
  if (!systemRoot || /[\0\r\n"]/u.test(systemRoot) || !win32.isAbsolute(systemRoot)) {
    throw new Error('aidesk_windows_system_root_unavailable');
  }
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Run a PowerShell script in the ACTIVE USER's session and read its bounded outcome. The launcher is asynchronous, so success is not
 * reported until the script writes `accept`-able text into a result file the user session can reach (random name, strict vocabulary,
 * so a stale file is never mistaken for an answer). `undefined` = the launcher failed, timed out, or answered with something else.
 * Shared by the aiDesk shortcut setup and the local-panel window adapter.
 */
export async function runWindowsUserSessionScript(input: {
  /** Builds the powershell arguments (an -EncodedCommand line) once the result file path is known. */
  buildCommand: (resultPath: string) => string;
  accept: (value: string) => boolean;
  launch?: WindowsShortcutLaunch;
  launchActiveUserProcess?: WindowsActiveUserProcessLaunch;
  windowsEnvironment?: Readonly<Record<string, string | undefined>>;
  grantResultAccess?: (path: string) => Promise<void>;
  resultRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
  resultPrefix?: string;
}): Promise<string | undefined> {
  const resultPath = join(
    input.resultRoot ?? tmpdir(),
    `${input.resultPrefix ?? 'aidesk-entry'}-${process.pid}-${randomUUID()}.result`,
  );
  await writeFile(resultPath, '', { mode: 0o600, flag: 'wx' });
  let launchFailure = false;
  try {
    await (input.grantResultAccess ?? allowWindowsNamedPipeClients)(resultPath);
    const launch = input.launch ?? (async (command, onFailure) => {
      const executable = resolveWindowsPowerShellExecutable(input.windowsEnvironment);
      const launchActiveUserProcess = input.launchActiveUserProcess
        ?? ((resolvedExecutable, resolvedCommand, resolvedOnFailure) => {
          launchWindowsActiveUserCommand(
            resolvedExecutable, resolvedCommand, undefined,
            false, false, false, resolvedOnFailure,
          );
        });
      await launchActiveUserProcess(executable, command, onFailure);
    });
    await launch(input.buildCommand(resultPath), () => {
      launchFailure = true;
    });
    const deadline = Date.now() + (input.timeoutMs ?? 15_000);
    while (!launchFailure && Date.now() < deadline) {
      const value = (await readFile(resultPath, 'utf8').catch(() => '')).trim();
      if (input.accept(value)) return value;
      await delay(input.pollMs ?? 50);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await rm(resultPath, { force: true }).catch(() => {});
  }
}

/**
 * Shortcut setup is not reported as successful until the user-session PowerShell writes its bounded outcome (see
 * runWindowsUserSessionScript); the result carries diagnostics only, never authority.
 */
export async function ensureWindowsAideskShortcut(input: {
  executablePath: string;
  launch?: WindowsShortcutLaunch;
  launchActiveUserProcess?: WindowsActiveUserProcessLaunch;
  windowsEnvironment?: Readonly<Record<string, string | undefined>>;
  grantResultAccess?: (path: string) => Promise<void>;
  resultRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<AideskDesktopEntryResult> {
  const accepted = new Set<string>(['created', 'repaired', 'unchanged', 'preserved', 'failed']);
  const value = await runWindowsUserSessionScript({
    buildCommand: (resultPath) => buildWindowsAideskShortcutCommand(input.executablePath, resultPath),
    accept: (text) => accepted.has(text),
    ...(input.launch ? { launch: input.launch } : {}),
    ...(input.launchActiveUserProcess ? { launchActiveUserProcess: input.launchActiveUserProcess } : {}),
    ...(input.windowsEnvironment ? { windowsEnvironment: input.windowsEnvironment } : {}),
    ...(input.grantResultAccess ? { grantResultAccess: input.grantResultAccess } : {}),
    ...(input.resultRoot ? { resultRoot: input.resultRoot } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
  });
  return (value as AideskDesktopEntryResult | undefined) ?? 'failed';
}

export function buildWindowsAideskShortcutRemovalCommand(): string {
  const name64 = Buffer.from(AIDESK_WINDOWS_SHORTCUT_FILE_NAME, 'utf8').toString('base64');
  const description64 = Buffer.from(WINDOWS_MANAGED_DESCRIPTION, 'utf8').toString('base64');
  const script = String.raw`$ErrorActionPreference='Stop'
$utf8=[Text.Encoding]::UTF8
$name=$utf8.GetString([Convert]::FromBase64String('${name64}'))
$description=$utf8.GetString([Convert]::FromBase64String('${description64}'))
$path=[IO.Path]::Combine([Environment]::GetFolderPath('Programs'),$name)
if(!(Test-Path -LiteralPath $path)){exit 0}
$shell=New-Object -ComObject WScript.Shell
$old=$shell.CreateShortcut($path)
if($old.Description -eq $description){Remove-Item -LiteralPath $path -Force}`;
  return `-NoProfile -NonInteractive -EncodedCommand ${windowsEncodedCommand(script)}`;
}

async function ensureDirectory(path: string, uid: number, gid: number): Promise<void> {
  const before = await lstat(path).catch(() => null);
  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new Error('aidesk_desktop_entry_parent_unsafe');
  }
  if (!before) {
    await mkdir(path, { recursive: true, mode: 0o755 });
    await chown(path, uid, gid);
  }
}

async function ensureOwnedDirectoryChain(
  home: string,
  parts: readonly string[],
  uid: number,
  gid: number,
): Promise<string> {
  let current = home;
  for (const part of parts) {
    current = join(current, part);
    await ensureDirectory(current, uid, gid);
  }
  return current;
}

export async function ensureMacosAideskApplicationEntry(input: {
  home: string;
  uid: number;
  gid: number;
  signedAppPath?: string;
}): Promise<AideskDesktopEntryResult> {
  const source = input.signedAppPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH;
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) return 'unavailable';
  const applications = join(input.home, 'Applications');
  await ensureDirectory(applications, input.uid, input.gid);
  const entry = join(applications, AIDESK_MACOS_APP_NAME);
  const existing = await lstat(entry).catch(() => null);
  if (existing) {
    if (!existing.isSymbolicLink()) return 'preserved';
    const target = resolve(dirname(entry), await readlink(entry));
    return target === resolve(source) ? 'unchanged' : 'preserved';
  }
  await symlink(source, entry, 'dir');
  await lchown(entry, input.uid, input.gid);
  return 'created';
}

export async function removeMacosAideskApplicationEntry(input: {
  home: string;
  signedAppPath?: string;
}): Promise<boolean> {
  const entry = join(input.home, 'Applications', AIDESK_MACOS_APP_NAME);
  const existing = await lstat(entry).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  const source = input.signedAppPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH;
  if (resolve(dirname(entry), await readlink(entry)) !== resolve(source)) return false;
  await rm(entry);
  return true;
}

/** The icon file name inside `<home>/.local/share/icons/hicolor/<n>x<n>/apps/`. */
const LINUX_ICON_FILE = `${LINUX_AIDESK_ICON_NAME}.png`;

/**
 * Writes the logo PNGs that travel inside the node bundle to the desktop user's own hicolor theme (owned by that user, mode 0644), so the
 * desktop entry's themed `Icon=aidesk` resolves with nothing shipped next to the executable. Returns whether anything changed.
 */
export async function writeLinuxAideskIcons(
  home: string,
  uid: number,
  gid: number,
  icons: Readonly<Record<number, string>> = AIDESK_HICOLOR_ICONS_BASE64,
): Promise<boolean> {
  let changed = false;
  for (const [sizeText, base64] of Object.entries(icons)) {
    const size = Number(sizeText);
    if (!Number.isInteger(size) || size <= 0) continue;
    const bytes = Buffer.from(base64, 'base64');
    const directory = await ensureOwnedDirectoryChain(home, ['.local', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps'], uid, gid);
    const path = join(directory, LINUX_ICON_FILE);
    const current = await readFile(path).catch(() => null);
    if (current !== null && current.equals(bytes)) continue;
    const temp = join(directory, `.${LINUX_ICON_FILE}.${process.pid}.tmp`);
    await writeFile(temp, bytes, { mode: 0o644, flag: 'wx' });
    await chown(temp, uid, gid);
    await chmod(temp, 0o644);
    await rename(temp, path);
    changed = true;
  }
  return changed;
}

export async function ensureLinuxAideskDesktopEntry(input: {
  home: string;
  uid: number;
  gid: number;
  executablePath: string;
  runUpdateDatabase?: (directory: string) => Promise<void>;
}): Promise<AideskDesktopEntryResult> {
  // The icon is best effort: a desktop entry without its icon is still a working entry.
  await writeLinuxAideskIcons(input.home, input.uid, input.gid).catch(() => false);
  const directory = await ensureOwnedDirectoryChain(
    input.home, ['.local', 'share', 'applications'], input.uid, input.gid,
  );
  const path = join(directory, AIDESK_LINUX_DESKTOP_FILE_NAME);
  const wanted = buildLinuxAideskDesktopEntry(input.executablePath);
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== null && !current.includes(MANAGED_MARKER)) return 'preserved';
  if (current === wanted) return 'unchanged';
  const temp = join(directory, `.${AIDESK_LINUX_DESKTOP_FILE_NAME}.${process.pid}.tmp`);
  await writeFile(temp, wanted, { mode: 0o644, flag: 'wx' });
  await chown(temp, input.uid, input.gid);
  await chmod(temp, 0o644);
  await rename(temp, path);
  await input.runUpdateDatabase?.(directory);
  return current === null ? 'created' : 'repaired';
}

export async function removeLinuxAideskDesktopEntry(home: string): Promise<boolean> {
  const path = join(home, '.local', 'share', 'applications', AIDESK_LINUX_DESKTOP_FILE_NAME);
  const current = await readFile(path, 'utf8').catch(() => null);
  if (!current?.includes(MANAGED_MARKER)) return false;
  await rm(path);
  // Only the icon files this node wrote (byte-identical): a user's own aidesk.png is left alone.
  for (const [sizeText, base64] of Object.entries(AIDESK_HICOLOR_ICONS_BASE64)) {
    const icon = join(home, '.local', 'share', 'icons', 'hicolor', `${sizeText}x${sizeText}`, 'apps', LINUX_ICON_FILE);
    const bytes = await readFile(icon).catch(() => null);
    if (bytes !== null && bytes.equals(Buffer.from(base64, 'base64'))) await rm(icon).catch(() => undefined);
  }
  return true;
}

function runUpdateDesktopDatabase(directory: string): Promise<void> {
  if (!existsSync('/usr/bin/update-desktop-database')) return Promise.resolve();
  return new Promise((resolveDone) => {
    execFile('/usr/bin/update-desktop-database', [directory], { timeout: 15_000 }, () => resolveDone());
  });
}

/**
 * `open -g <app> --args --aidesk-background` only spawns a fresh process the
 * first time; once the background agent is already running, macOS instead
 * delivers a "reopen" Apple Event to it (which opens the aiDesk window), so
 * ensureAideskDesktopEntry -- which runs on every controlled-node startup,
 * including every post-upgrade restart -- must not start it again.
 *
 * "Running" means the MENU-BAR process only (no arguments or `--aidesk-background`):
 * the same executable path is also used by the remote-desktop launch agent and
 * its helpers, which run for days with other arguments and used to be taken for
 * the app, so a Mac whose menu-bar app had quit was never given a new one.
 */
export async function isMacosAideskAgentRunning(
  user: MacosUserSession,
  execFileText: MacosExecFileText,
): Promise<boolean> {
  const executable = join(MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH, 'Contents', 'MacOS', MACOS_AIDESK_EXECUTABLE);
  return execFileText('/bin/ps', ['-axo', 'pid=,uid=,command='])
    .then((stdout) => parseAideskMenuBarProcesses(stdout, executable, user.uid).length > 0)
    .catch(() => false);
}

/** Best-effort startup repair. Failure must never take the controlled node down. */
export async function ensureAideskDesktopEntry(
  platform = process.platform,
  options: { execFileText?: MacosExecFileText } = {},
): Promise<AideskDesktopEntryResult> {
  if (platform === 'darwin') {
    const user = await resolveMacosUserSession().catch(() => null);
    if (!user) return 'unavailable';
    const result = await ensureMacosAideskApplicationEntry(user);
    if (result !== 'unavailable') {
      const execFileText = options.execFileText ?? defaultMacosExecFileText;
      const alreadyRunning = await isMacosAideskAgentRunning(user, execFileText);
      if (!alreadyRunning) {
        launchMacosUserSessionCommand(user, {
          executable: '/usr/bin/open',
          // -n: a new process even when the app's launcher role (which holds the remote-desktop helpers and has no menu bar) is
          // already running -- LaunchServices treats both as one application and would only activate that one.
          args: ['-g', '-n', MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,
            '--args', '--aidesk-background'],
        });
      }
    }
    return result;
  }
  if (platform === 'linux') {
    const passwd = readFileSync('/etc/passwd', 'utf8');
    const user = pickLinuxDesktopUserProfile(passwd);
    if (!user) return 'unavailable';
    // Always the node itself (`--open-local-panel`): the shared window decision verifies any native host before it starts one. An
    // unverified executable found beside the node is never what a user's launcher points at.
    return ensureLinuxAideskDesktopEntry({
      ...user,
      executablePath: process.execPath,
      runUpdateDatabase: runUpdateDesktopDatabase,
    });
  }
  if (platform === 'win32') {
    return ensureWindowsAideskShortcut({
      executablePath: process.execPath,
    });
  }
  return 'unavailable';
}

export function localPanelUrl(): string {
  return `http://${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}:${REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT}/`;
}

/**
 * The pre-window way of opening the panel: the default browser. Kept as the last resort behind the shared window decision
 * (local-panel-window-run.ts), so there is always an entry. (It no longer starts an executable it found beside the node: only the
 * decision layer starts a native host, and only after verifying it.)
 */
export function openAideskLocalPanelLegacy(platform = process.platform): void {
  const url = localPanelUrl();
  if (platform === 'darwin') {
    execFile('/usr/bin/open', [url], { windowsHide: true }, () => undefined);
  } else if (platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => undefined);
  } else if (platform === 'linux') {
    execFile('xdg-open', [url], { windowsHide: true }, () => undefined);
  }
}
