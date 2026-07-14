// Per-OS boot-level autostart for the controlled node (tasks 4.1-4.3), with a
// service identity DELIBERATELY DISTINCT from the full daemon (4.4) so both can
// coexist on one machine. Autostart is BOOT-scoped (runs with no interactive
// login) so the node is controllable after an unattended reboot:
//   Windows: scheduled task, ONSTART, RU SYSTEM, RL HIGHEST
//   macOS:   LaunchDaemon (/Library/LaunchDaemons, root) — NOT a user LaunchAgent
//   Linux:   systemd SYSTEM unit (/etc/systemd/system) — NOT `--user`
//
// The pure artifact generators are unit-tested; the actual install (which needs
// elevation + the real OS) runs from the install journal on first run.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServiceReceipt } from './install-journal.js';

/** Controlled-node service identities — distinct from the full daemon's. */
export const CONTROLLED_NODE_SERVICE = {
  /** Windows Task Scheduler task name (full daemon uses `imcodes-daemon`). */
  WINDOWS_TASK: 'imcodes-node',
  /** macOS LaunchDaemon label (full daemon uses `imcodes.daemon`). */
  MACOS_LABEL: 'cc.imcodes.node',
  /** Linux systemd unit name (full daemon uses `imcodes.service`). */
  LINUX_UNIT: 'imcodes-node.service',
} as const;

export const MACOS_PLIST_PATH = `/Library/LaunchDaemons/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}.plist`;
export const LINUX_UNIT_PATH = `/etc/systemd/system/${CONTROLLED_NODE_SERVICE.LINUX_UNIT}`;

export interface PrivilegeCheckOptions {
  platform?: NodeJS.Platform;
  getUid?: () => number;
  runCommand?: (file: string, args: readonly string[]) => string | Buffer;
}

export interface ServiceInstallOptions {
  platform?: NodeJS.Platform;
  runCommand?: (file: string, args: readonly string[]) => unknown;
  macosPlistPath?: string;
  linuxUnitPath?: string;
  /** Test seam for the Windows watchdog trigger's local start boundary. */
  now?: () => Date;
}

const WINDOWS_ADMIN_CHECK = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
] as const;

/** Testable current-process privilege probe; it never attempts a UAC relaunch. */
export function isProcessElevated(options: PrivilegeCheckOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin' || platform === 'linux') {
    const getUid = options.getUid
      ?? (typeof process.getuid === 'function' ? () => process.getuid!() : undefined);
    return getUid?.() === 0;
  }
  if (platform === 'win32') {
    const runCommand = options.runCommand ?? ((file: string, args: readonly string[]) => (
      execFileSync(file, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    ));
    try {
      return String(runCommand('powershell.exe', WINDOWS_ADMIN_CHECK)).trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }
  return false;
}

/** Fail before protected writes when the user did not run as Administrator/root. */
export function assertProcessElevated(options: PrivilegeCheckOptions = {}): void {
  if (!isProcessElevated(options)) {
    throw new Error('controlled node installation requires Administrator/root; rerun this executable with elevated privileges');
  }
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const WINDOWS_WATCHDOG_INTERVAL = 'PT1M';

function windowsWatchdogStartBoundary(now: Date): string {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
    + `T${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
}

/**
 * Task Scheduler artifact for boot-time SYSTEM autostart plus a one-minute
 * watchdog. RestartOnFailure does not reliably restart an action terminated by
 * an external force-kill, so the recurring TimeTrigger supplies the durable
 * liveness guarantee; IgnoreNew makes its ticks no-ops while the node is alive.
 * The start boundary is the next local minute so first-run journal handoff can
 * finish before the watchdog becomes eligible.
 */
export function windowsScheduledTaskXml(exePath: string, now: Date = new Date()): string {
  const watchdogStartBoundary = windowsWatchdogStartBoundary(now);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>IM.codes controlled node</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
    <TimeTrigger>
      <StartBoundary>${watchdogStartBoundary}</StartBoundary>
      <Repetition>
        <Interval>${WINDOWS_WATCHDOG_INTERVAL}</Interval>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${WINDOWS_WATCHDOG_INTERVAL}</Interval>
      <Count>255</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>${escapeXmlText(exePath)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

export function encodeWindowsScheduledTaskXml(xml: string): Buffer {
  // Task Scheduler's COM XML loader expects the declared UTF-16 encoding to
  // match a BOM-prefixed UTF-16LE file. UTF-8 without a BOM is rejected on
  // Windows PowerShell 5-era hosts with "cannot switch encoding".
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** Windows `schtasks /Create` args for an XML task definition. */
export function windowsScheduledTaskArgs(taskXmlPath: string): string[] {
  return [
    '/Create', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
    '/XML', taskXmlPath, '/F',
  ];
}

/**
 * Default protected credential directory on Windows (SYSTEM-scoped service ⇒
 * `%ProgramData%`, not a per-user path). Falls back to the conventional path when
 * `ProgramData` is unset. Mirrors the POSIX `0700` credential dir on macOS/Linux.
 */
export function windowsCredentialDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ProgramData && env.ProgramData.trim() ? env.ProgramData : 'C:\\ProgramData';
  return `${base}\\imcodes-node`;
}

/**
 * `icacls` args to lock the credential directory to SYSTEM + Administrators only
 * (the Windows equivalent of POSIX dir `0700`, 10.10). Removes inherited ACEs
 * (`/inheritance:r`) so no interactive/other user retains access, then grants
 * SYSTEM and Administrators full control with object+container inheritance so the
 * credential file underneath is covered. The actual `icacls` invocation is
 * applied at install time (E2E on real Windows); this builder is unit-tested.
 */
const WINDOWS_SYSTEM_SID = '*S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = '*S-1-5-32-544';
const WINDOWS_AUTHENTICATED_USERS_SID = '*S-1-5-11';

export type WindowsAclCommand = readonly [path: string, ...args: string[]];

/**
 * `icacls /setowner` is a separate command form and cannot be combined with
 * `/grant` or `/inheritance`. Grant the durable principals first so the
 * elevated installer never removes its own access between ACL operations,
 * then strip inherited ACEs and transfer ownership to SYSTEM.
 *
 * Numeric well-known SIDs keep this locale-independent on non-English Windows.
 */
export function windowsCredentialAclCommands(dir: string): WindowsAclCommand[] {
  return [
    [dir, '/grant:r', `${WINDOWS_SYSTEM_SID}:(OI)(CI)F`],
    [dir, '/grant:r', `${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)F`],
    [dir, '/inheritance:r'],
    [dir, '/setowner', WINDOWS_SYSTEM_SID],
  ];
}

/** Explicit protected DACL for each persisted secret file (no inheritance). */
export function windowsSecretFileAclCommands(path: string): WindowsAclCommand[] {
  return [
    [path, '/grant:r', `${WINDOWS_SYSTEM_SID}:F`],
    [path, '/grant:r', `${WINDOWS_ADMINISTRATORS_SID}:F`],
    [path, '/inheritance:r'],
    [path, '/setowner', WINDOWS_SYSTEM_SID],
  ];
}

/**
 * The staged executable lives beside SYSTEM-only credentials, but Windows
 * Computer Use launches a helper copy of this executable under the active
 * interactive user token. Keep secrets sealed while allowing authenticated
 * local users to read/execute only the binary.
 */
export function windowsExecutableFileAclCommands(path: string): WindowsAclCommand[] {
  return [
    [path, '/grant:r', `${WINDOWS_SYSTEM_SID}:F`],
    [path, '/grant:r', `${WINDOWS_ADMINISTRATORS_SID}:F`],
    [path, '/grant:r', `${WINDOWS_AUTHENTICATED_USERS_SID}:RX`],
    [path, '/inheritance:r'],
    [path, '/setowner', WINDOWS_SYSTEM_SID],
  ];
}

export function applyWindowsAclCommands(
  commands: readonly WindowsAclCommand[],
  runCommand: (file: string, args: readonly string[]) => void = (file, args) => {
    execFileSync(file, args, { stdio: 'ignore' });
  },
): void {
  for (const args of commands) runCommand('icacls', args);
}

/** macOS LaunchDaemon plist (boot-scoped, root, keep-alive). */
export function macosLaunchDaemonPlist(exePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CONTROLLED_NODE_SERVICE.MACOS_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escapeXmlText(exePath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/var/log/imcodes-node.err.log</string>
  <key>StandardOutPath</key><string>/var/log/imcodes-node.out.log</string>
</dict>
</plist>
`;
}

/** Linux systemd SYSTEM unit (boot-scoped, restart-on-failure with backoff). */
export function linuxSystemdUnit(exePath: string): string {
  return `[Unit]
Description=IM.codes controlled node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exePath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fsyncParentDir(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(dirname(path), 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeDurableTextFile(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(temp, 'wx', mode);
    await fh.writeFile(content, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    if (process.platform !== 'win32') await chmod(temp, mode);
    await rename(temp, path);
    await fsyncParentDir(path);
  } catch (error) {
    await fh?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function runCommandFromOptions(options: ServiceInstallOptions): (file: string, args: readonly string[]) => unknown {
  return options.runCommand ?? ((file: string, args: readonly string[]) => (
    execFileSync(file, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  ));
}

async function installWindowsTaskDefinition(
  exePath: string,
  runCommand: (file: string, args: readonly string[]) => unknown,
  now: Date,
): Promise<ServiceReceipt> {
    const xml = windowsScheduledTaskXml(exePath, now);
    const artifactDir = await mkdtemp(join(tmpdir(), 'imcodes-node-task-'));
    const artifactPath = join(artifactDir, 'task.xml');
    try {
      await writeFile(artifactPath, encodeWindowsScheduledTaskXml(xml), { mode: 0o600 });
      runCommand('schtasks', windowsScheduledTaskArgs(artifactPath));
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
    return {
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      definitionSha256: sha256Text(xml),
      action: exePath,
    };
}

/**
 * Structured result of a side-effect-free service inspection. Returned by
 * `inspectServiceState` for the stable runtime's `markServiceHealthy` gate
 * AND for source-path repair decisions. The inspection MUST NOT mutate
 * service-manager state (no enable/start/bootout) — only READ operations
 * (`schtasks /Query`, `launchctl print`, `systemctl is-enabled/show/cat`)
 * are permitted.
 */
export interface ServiceInspection {
  installed: boolean;
  /** Action value parsed from the on-disk service definition, when available. */
  action: string | null;
  /**
   * Action the service MANAGER currently reports as loaded — parsed from live
   * manager state (`launchctl print` program/arguments, systemd `ExecStart`,
   * `schtasks /XML` Command), NOT the on-disk definition. A manager that never
   * reloaded after a definition rewrite keeps the OLD action here even once
   * `action` (disk) already shows the new one; that divergence is the signal a
   * bare disk-hash check misses.
   */
  effectiveAction: string | null;
  /** True iff the manager's `effectiveAction` matches the receipt's pinned action. */
  loadedActionMatches: boolean;
  /** True iff the service manager currently has this service loaded. */
  loaded: boolean;
  /** True iff the service is enabled to start at boot. */
  bootEnabled: boolean;
  /** Principal/user the manager runs the service as (root / SYSTEM SID / User=), when parseable. */
  principal: string | null;
  /** Restart / keep-alive policy the manager reports (on-failure / keepalive / RestartOnFailure), when parseable. */
  restartPolicy: string | null;
  /** Definition hash as observed on disk. Compared with the receipt's pinned hash. */
  observedDefinitionSha256: string | null;
  /** True iff the observed on-disk definition hash + action match the receipt's pinned values. */
  definitionMatches: boolean;
  /** OS-specific effective run state. */
  runState: 'running' | 'stopped' | 'unknown';
  /** Errors collected during inspection; not all must fail the verdict. */
  errors: string[];
  /** Raw inspection output retained for audit. */
  raw: string;
}

interface DefinitionInspection {
  present: boolean;
  action: string | null;
  sha256: string | null;
  matches: boolean;
  errors: string[];
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

async function inspectDefinitionFile(receipt: ServiceReceipt): Promise<DefinitionInspection> {
  const errors: string[] = [];
  if (!receipt.definitionPath || !receipt.definitionSha256) {
    return { present: false, action: null, sha256: null, matches: false, errors: ['definition_receipt_incomplete'] };
  }
  try {
    const st = await lstat(receipt.definitionPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { present: false, action: null, sha256: null, matches: false, errors: ['definition_not_regular'] };
    }
    const content = await readFile(receipt.definitionPath, 'utf8');
    const sha256 = sha256Text(content);
    let action: string | null = null;
    if (receipt.platform === 'darwin') {
      const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/i.exec(content);
      action = match ? decodeXmlText(match[1]) : null;
    } else if (receipt.platform === 'linux') {
      const match = /^ExecStart=(.+)$/m.exec(content);
      action = match?.[1]?.trim() ?? null;
    }
    return {
      present: true,
      action,
      sha256,
      matches: sha256 === receipt.definitionSha256 && action === (receipt.action ?? null),
      errors,
    };
  } catch (error) {
    errors.push(`definition_read_failed:${(error as Error).message}`);
    return { present: false, action: null, sha256: null, matches: false, errors };
  }
}

interface WindowsTaskInspection {
  action: string | null;
  matches: boolean;
  bootEnabled: boolean;
  principal: string | null;
  restartPolicy: string | null;
}

/**
 * Parse the authoritative task registration from `schtasks /Query /XML` — this
 * is the manager's live view of the task store, not a file on disk. Extracts the
 * loaded Command (effective action) plus boot-enablement, principal, and restart
 * policy so the inspection can report the manager's real posture.
 */
function inspectWindowsTaskXml(xml: string, expectedAction: string | undefined): WindowsTaskInspection {
  const commandMatch = /<Command>([^<]*)<\/Command>/i.exec(xml);
  const action = commandMatch ? decodeXmlText(commandMatch[1].trim()) : null;
  // Task Scheduler normalizes default-true settings away and exports an
  // enabled boot trigger as `<BootTrigger />`. Treat an explicit false as the
  // only disabled form instead of requiring tags the manager removes.
  const bootBlock = /<BootTrigger\b[^>]*(?:\/>|>[\s\S]*?<\/BootTrigger>)/i.exec(xml)?.[0] ?? '';
  const settingsBlock = /<Settings\b[^>]*>[\s\S]*?<\/Settings>/i.exec(xml)?.[0] ?? '';
  const bootTrigger = bootBlock.length > 0 && !/<Enabled>\s*false\s*<\/Enabled>/i.test(bootBlock);
  const settingsEnabled = settingsBlock.length > 0 && !/<Enabled>\s*false\s*<\/Enabled>/i.test(settingsBlock);
  const systemPrincipal = /<UserId>\s*S-1-5-18\s*<\/UserId>/i.test(xml);
  const highRunLevel = /<RunLevel>\s*HighestAvailable\s*<\/RunLevel>/i.test(xml);
  const restartBlock = /<RestartOnFailure\b[^>]*>[\s\S]*?<\/RestartOnFailure>/i.exec(xml)?.[0] ?? '';
  const restartOnFailure = /<Interval>\s*PT1M\s*<\/Interval>/i.test(restartBlock)
    && /<Count>\s*255\s*<\/Count>/i.test(restartBlock);
  const watchdogBlock = /<TimeTrigger\b[^>]*>[\s\S]*?<\/TimeTrigger>/i.exec(xml)?.[0] ?? '';
  const watchdogRepetition = /<Repetition\b[^>]*>[\s\S]*?<\/Repetition>/i.exec(watchdogBlock)?.[0] ?? '';
  const watchdogEnabled = watchdogBlock.length > 0
    && !/<Enabled>\s*false\s*<\/Enabled>/i.test(watchdogBlock);
  // An omitted Duration means the repetition continues indefinitely. A finite
  // duration would silently remove crash recovery after that window expires.
  const watchdogRepeatsIndefinitely = watchdogRepetition.length > 0
    && /<Interval>\s*PT1M\s*<\/Interval>/i.test(watchdogRepetition)
    && !/<Duration>\s*[^<]+\s*<\/Duration>/i.test(watchdogRepetition);
  const watchdogStartPresent = /<StartBoundary>\s*[^<]+\s*<\/StartBoundary>/i.test(watchdogBlock);
  const ignoresConcurrentTicks = /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settingsBlock);
  const userIdMatch = /<UserId>\s*([^<]+?)\s*<\/UserId>/i.exec(xml);
  return {
    action,
    matches: systemPrincipal && highRunLevel && settingsEnabled && restartOnFailure
      && bootTrigger && watchdogEnabled && watchdogRepeatsIndefinitely
      && watchdogStartPresent && ignoresConcurrentTicks
      && action !== null && action === expectedAction,
    bootEnabled: bootTrigger && settingsEnabled,
    principal: userIdMatch ? userIdMatch[1].trim() : null,
    restartPolicy: restartOnFailure ? 'on-failure' : null,
  };
}

interface LaunchctlPrintInspection {
  effectiveAction: string | null;
  loaded: boolean;
  bootEnabled: boolean;
  principal: string | null;
  restartPolicy: string | null;
  loadedPath: string | null;
}

/**
 * Parse `launchctl print system/<label>` — the authoritative loaded-daemon state,
 * INDEPENDENT of the on-disk plist. `program = <path>` (or the first
 * `arguments = { … }` entry) is the action launchd actually has resident, so a
 * daemon that never rebootstrapped after a plist rewrite is caught here.
 */
function parseLaunchctlPrint(printOut: string): LaunchctlPrintInspection {
  const loaded = printOut.trim().length > 0;
  let effectiveAction: string | null = null;
  const programMatch = /^\s*program\s*=\s*(.+)$/mi.exec(printOut);
  if (programMatch) {
    effectiveAction = programMatch[1].trim();
  } else {
    const argsBlock = /arguments\s*=\s*\{([\s\S]*?)\}/i.exec(printOut);
    if (argsBlock) {
      effectiveAction = argsBlock[1].split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? null;
    }
  }
  const pathMatch = /^\s*path\s*=\s*(.+)$/mi.exec(printOut);
  const usernameMatch = /^\s*username\s*=\s*(\S+)/mi.exec(printOut);
  const disabled = /\bdisabled\s*=\s*(?:1|true)\b/i.test(printOut);
  return {
    effectiveAction,
    loaded,
    bootEnabled: loaded && !disabled,
    // A system-domain LaunchDaemon runs as root unless UserName pins another user.
    principal: usernameMatch ? usernameMatch[1].trim() : (loaded ? 'root' : null),
    restartPolicy: /\bkeepalive\b/i.test(printOut) ? 'keepalive' : null,
    loadedPath: pathMatch ? pathMatch[1].trim() : null,
  };
}

interface SystemctlShowInspection {
  effectiveAction: string | null;
  fragmentPath: string | null;
  loadState: string | null;
  unitFileState: string | null;
  principal: string | null;
  restartPolicy: string | null;
}

/**
 * Parse `systemctl show` key=value output — the loaded unit's live properties.
 * `ExecStart` is rendered as `{ path=… ; argv[]=… ; … }`, so the effective action
 * is the resident `path=`. `FragmentPath` is the unit file systemd actually
 * loaded (compared to the receipt's definition path to catch a stale fragment).
 */
function parseSystemctlShow(showOut: string): SystemctlShowInspection {
  const prop = (key: string): string | null => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(showOut);
    return match ? match[1].trim() : null;
  };
  const execStart = prop('ExecStart');
  let effectiveAction: string | null = null;
  if (execStart) {
    const pathMatch = /path=([^ ;]+)/.exec(execStart);
    effectiveAction = pathMatch ? pathMatch[1].trim() : (execStart.startsWith('/') ? execStart.split(/\s+/)[0] : null);
  }
  const userRaw = prop('User');
  const restartPolicy = prop('Restart');
  return {
    effectiveAction,
    fragmentPath: prop('FragmentPath'),
    loadState: prop('LoadState'),
    unitFileState: prop('UnitFileState'),
    // A systemd SYSTEM unit with no `User=` runs as root.
    principal: userRaw && userRaw.length > 0 ? userRaw : (showOut.trim().length > 0 ? 'root' : null),
    restartPolicy: restartPolicy && restartPolicy.length > 0 ? restartPolicy : null,
  };
}

/** The manager's live loaded action must be present AND equal the receipt's pin. */
function loadedActionMatchesReceipt(effectiveAction: string | null, receipt: ServiceReceipt): boolean {
  return effectiveAction !== null && effectiveAction === (receipt.action ?? null);
}

export async function installDefinition(
  exePath: string,
  options: ServiceInstallOptions = {},
): Promise<ServiceReceipt> {
  const platform = options.platform ?? process.platform;
  const runCommand = runCommandFromOptions(options);

  if (platform === 'win32') {
    return installWindowsTaskDefinition(exePath, runCommand, options.now?.() ?? new Date());
  }
  if (platform === 'darwin') {
    const plistPath = options.macosPlistPath ?? MACOS_PLIST_PATH;
    const plist = macosLaunchDaemonPlist(exePath);
    await writeDurableTextFile(plistPath, plist, 0o644);
    return {
      name: CONTROLLED_NODE_SERVICE.MACOS_LABEL,
      platform,
      definitionPath: plistPath,
      definitionSha256: sha256Text(plist),
      action: exePath,
    };
  }
  if (platform === 'linux') {
    const unitPath = options.linuxUnitPath ?? LINUX_UNIT_PATH;
    const unit = linuxSystemdUnit(exePath);
    await writeDurableTextFile(unitPath, unit, 0o644);
    runCommand('systemctl', ['daemon-reload']);
    runCommand('systemctl', ['enable', CONTROLLED_NODE_SERVICE.LINUX_UNIT]);
    return {
      name: CONTROLLED_NODE_SERVICE.LINUX_UNIT,
      platform,
      definitionPath: unitPath,
      definitionSha256: sha256Text(unit),
      action: exePath,
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export async function inspectDefinition(
  receipt: ServiceReceipt,
  options: ServiceInstallOptions = {},
): Promise<ServiceReceipt> {
  const platform = options.platform ?? receipt.platform;
  const runCommand = runCommandFromOptions(options);
  if (platform === 'win32') {
    // SIDE-EFFECT-FREE: only query, never re-install or run.
    runCommand('schtasks', ['/Query', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK]);
    return receipt;
  }
  if (receipt.definitionPath && receipt.definitionSha256) {
    const content = await readFile(receipt.definitionPath, 'utf8');
    if (sha256Text(content) !== receipt.definitionSha256) {
      throw new Error('controlled node service definition hash mismatch');
    }
  }
  return receipt;
}

/**
 * SIDE-EFFECT-FREE structured service inspection. Permitted operations:
 *   Windows: `schtasks /Query` (no /Create, no /Run, no /Delete)
 *   macOS:   `launchctl print` (no bootout/bootstrap/kickstart)
 *   Linux:   `systemctl cat` / `is-enabled` / `show` (no daemon-reload/restart)
 *
 * The stable runtime calls this on every heartbeat and BEFORE writing
 * `service_healthy`. The source path also calls this to decide whether
 * repair is required.
 */
export async function inspectServiceState(
  receipt: ServiceReceipt,
  options: ServiceInstallOptions = {},
): Promise<ServiceInspection> {
  const platform = options.platform ?? receipt.platform;
  const runCommand = runCommandFromOptions(options);
  const errors: string[] = [];
  let raw = '';

  if (platform === 'win32') {
    // SIDE-EFFECT-FREE: /Query only. /XML is also non-mutating and gives the
    // current task definition as XML — we parse out the <Command> for parity
    // with the install-time action.
    let queryOut = '';
    try {
      queryOut = String(
        runCommand('schtasks', ['/Query', '/XML', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK]),
      );
    } catch (err) {
      errors.push(`schtasks_query_failed:${(err as Error).message}`);
      return blankInspection(receipt.platform, errors, queryOut);
    }
    raw = queryOut;
    const semantic = inspectWindowsTaskXml(queryOut, receipt.action);
    const observedHash = sha256Text(queryOut);
    let stateOut = '';
    let runState: ServiceInspection['runState'] = 'unknown';
    try {
      stateOut = String(runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-ScheduledTask -TaskName '${CONTROLLED_NODE_SERVICE.WINDOWS_TASK}').State.ToString()`,
      ]) ?? '').trim();
      if (/^running$/i.test(stateOut)) runState = 'running';
      else if (/^(ready|disabled|queued)$/i.test(stateOut)) runState = 'stopped';
    } catch (err) {
      errors.push(`scheduled_task_state_failed:${(err as Error).message}`);
    }
    raw = `${queryOut}\nstate:${stateOut}`;
    return {
      installed: queryOut.length > 0,
      // Task Scheduler's store IS the manager; the /XML query is its live view,
      // so the on-disk and effective actions are the same authoritative source.
      action: semantic.action,
      effectiveAction: semantic.action,
      loadedActionMatches: loadedActionMatchesReceipt(semantic.action, receipt),
      loaded: queryOut.length > 0,
      bootEnabled: semantic.bootEnabled,
      principal: semantic.principal,
      restartPolicy: semantic.restartPolicy,
      observedDefinitionSha256: observedHash,
      // Task Scheduler normalizes exported XML, so compare required semantics
      // rather than unstable whitespace/registration metadata.
      definitionMatches: semantic.matches,
      runState,
      errors,
      raw,
    };
  }

  if (platform === 'darwin') {
    // SIDE-EFFECT-FREE: `launchctl print` is purely read-only.
    let printOut = '';
    try {
      printOut = String(runCommand('launchctl', ['print', `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}`]));
    } catch (err) {
      errors.push(`launchctl_print_failed:${(err as Error).message}`);
      return blankInspection(receipt.platform, errors, printOut);
    }
    const managerState = parseLaunchctlPrint(printOut);
    const definition = await inspectDefinitionFile(receipt);
    errors.push(...definition.errors);
    raw = printOut;
    const installed = printOut.length > 0 && definition.present;
    // /LoadState is shown by `launchctl print` as "running" / "waiting" /
    // "not running" — we accept any of those as the run state.
    let runState: ServiceInspection['runState'] = 'unknown';
    const stateMatch = /state\s*=\s*([a-z ]+)/i.exec(printOut);
    if (stateMatch) {
      const s = stateMatch[1].toLowerCase().trim();
      if (s.includes('not running') || s.includes('waiting')) runState = 'stopped';
      else if (s.includes('running')) runState = 'running';
    }
    const loadedPathMatches = !receipt.definitionPath || managerState.loadedPath === receipt.definitionPath;
    return {
      installed,
      // `action` stays the ON-DISK plist action; `effectiveAction` is what
      // launchd actually loaded. A plist rewrite without a rebootstrap (disk
      // new, manager old) surfaces as action !== effectiveAction.
      action: definition.action,
      effectiveAction: managerState.effectiveAction,
      loadedActionMatches: loadedPathMatches && loadedActionMatchesReceipt(managerState.effectiveAction, receipt),
      loaded: managerState.loaded && loadedPathMatches,
      bootEnabled: managerState.bootEnabled,
      principal: managerState.principal,
      restartPolicy: managerState.restartPolicy,
      observedDefinitionSha256: definition.sha256,
      definitionMatches: definition.matches,
      runState,
      errors,
      raw,
    };
  }

  if (platform === 'linux') {
    // SIDE-EFFECT-FREE: `systemctl is-enabled` and `systemctl show` are
    // read-only. `daemon-reload` is NOT used here; reload lives in the
    // install path only.
    let enabled = '';
    let showOut = '';
    try {
      enabled = String(runCommand('systemctl', ['is-enabled', CONTROLLED_NODE_SERVICE.LINUX_UNIT]) ?? '').trim();
    } catch (err) {
      errors.push(`systemctl_is_enabled_failed:${(err as Error).message}`);
    }
    try {
      showOut = String(runCommand('systemctl', ['show', CONTROLLED_NODE_SERVICE.LINUX_UNIT, '--property=ActiveState,SubState,LoadState,FragmentPath,ExecMainStartTimestamp,ExecStart,User,Restart,UnitFileState']) ?? '');
    } catch (err) {
      errors.push(`systemctl_show_failed:${(err as Error).message}`);
    }
    const managerState = parseSystemctlShow(showOut);
    const definition = await inspectDefinitionFile(receipt);
    errors.push(...definition.errors);
    raw = `is-enabled:${enabled}\n${showOut}`;
    let runState: ServiceInspection['runState'] = 'unknown';
    if (showOut.includes('ActiveState=active')) runState = 'running';
    else if (/ActiveState=(inactive|failed|deactivating)/.test(showOut)) runState = 'stopped';
    // systemd must have loaded OUR unit file: a FragmentPath that no longer
    // points at the receipt's definition means the resident unit (and its
    // ExecStart) came from a different/stale file than the one we pinned.
    const fragmentMatches = !receipt.definitionPath || managerState.fragmentPath === receipt.definitionPath;
    const bootEnabled = enabled === 'enabled' || managerState.unitFileState === 'enabled';
    return {
      installed: enabled === 'enabled' && showOut.length > 0 && definition.present,
      // `action` is the ON-DISK unit's ExecStart; `effectiveAction` is the
      // ExecStart of the unit systemd currently has resident. Rewriting the
      // file does not reload the manager, so the two diverge until daemon-reload.
      action: definition.action,
      effectiveAction: managerState.effectiveAction,
      loadedActionMatches: fragmentMatches && loadedActionMatchesReceipt(managerState.effectiveAction, receipt),
      loaded: managerState.loadState === 'loaded' && fragmentMatches,
      bootEnabled,
      principal: managerState.principal,
      restartPolicy: managerState.restartPolicy,
      observedDefinitionSha256: definition.sha256,
      definitionMatches: definition.matches,
      runState,
      errors,
      raw,
    };
  }

  return blankInspection(receipt.platform, errors, raw);
}

function blankInspection(platform: NodeJS.Platform, errors: string[], raw: string): ServiceInspection {
  return {
    installed: false,
    action: null,
    effectiveAction: null,
    loadedActionMatches: false,
    loaded: false,
    bootEnabled: false,
    principal: null,
    restartPolicy: null,
    observedDefinitionSha256: null,
    definitionMatches: false,
    runState: 'unknown',
    errors,
    raw,
  };
}

export async function startService(
  receipt: ServiceReceipt,
  options: ServiceInstallOptions = {},
): Promise<void> {
  const platform = options.platform ?? receipt.platform;
  const runCommand = runCommandFromOptions(options);
  if (platform === 'win32') {
    runCommand('schtasks', ['/Run', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK]);
    return;
  }
  if (platform === 'darwin') {
    const plistPath = receipt.definitionPath ?? options.macosPlistPath ?? MACOS_PLIST_PATH;
    try {
      runCommand('launchctl', ['bootout', `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}`]);
    } catch {
      // Missing service is expected before the first bootstrap; bootstrap below is authoritative.
    }
    runCommand('launchctl', ['bootstrap', 'system', plistPath]);
    runCommand('launchctl', ['kickstart', '-k', `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}`]);
    return;
  }
  if (platform === 'linux') {
    runCommand('systemctl', ['restart', CONTROLLED_NODE_SERVICE.LINUX_UNIT]);
    return;
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/**
 * Install the boot-level autostart for the current OS. Requires elevation (the
 * install journal ensures elevation happens first). Returns the created service
 * identity. Throws on unsupported platform or a failed OS command.
 */
export async function installControlledNodeService(
  exePath: string,
  options: ServiceInstallOptions = {},
): Promise<string> {
  const receipt = await installDefinition(exePath, options);
  await inspectDefinition(receipt, options);
  await startService(receipt, options);
  return receipt.name;
}

/**
 * Create + lock the Windows credential directory to SYSTEM + Administrators only
 * — the Windows analog of the POSIX `0700` credential dir in `enrollment.ts`,
 * applied during the `credential_prepared` install-journal phase (10.10, BEFORE
 * redemption/persistence). No-op guard off Windows. Real `icacls` enforcement is
 * E2E on Windows; the arg construction is unit-tested via `windowsCredentialAclArgs`.
 */
export async function secureWindowsCredentialDir(dir: string = windowsCredentialDir()): Promise<string> {
  if (process.platform !== 'win32') throw new Error('secureWindowsCredentialDir is Windows-only');
  await mkdir(dir, { recursive: true });
  applyWindowsAclCommands(windowsCredentialAclCommands(dir));
  return dir;
}
