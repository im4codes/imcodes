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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/** Windows `schtasks /Create` args for a boot-time SYSTEM autostart. */
export function windowsScheduledTaskArgs(exePath: string): string[] {
  return [
    '/Create', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
    '/TR', `"${exePath}"`,
    '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F',
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
export function windowsCredentialAclArgs(dir: string): string[] {
  return [
    dir,
    '/inheritance:r',
    '/grant:r', 'SYSTEM:(OI)(CI)F',
    '/grant:r', 'Administrators:(OI)(CI)F',
  ];
}

/** macOS LaunchDaemon plist (boot-scoped, root, keep-alive). */
export function macosLaunchDaemonPlist(exePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CONTROLLED_NODE_SERVICE.MACOS_LABEL}</string>
  <key>ProgramArguments</key><array><string>${exePath}</string></array>
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

/**
 * Install the boot-level autostart for the current OS. Requires elevation (the
 * install journal ensures elevation happens first). Returns the created service
 * identity. Throws on unsupported platform or a failed OS command.
 */
export async function installControlledNodeService(exePath: string): Promise<string> {
  if (process.platform === 'win32') {
    execFileSync('schtasks', windowsScheduledTaskArgs(exePath), { stdio: 'ignore' });
    return CONTROLLED_NODE_SERVICE.WINDOWS_TASK;
  }
  if (process.platform === 'darwin') {
    await mkdir(dirname(MACOS_PLIST_PATH), { recursive: true });
    await writeFile(MACOS_PLIST_PATH, macosLaunchDaemonPlist(exePath), { mode: 0o644 });
    execFileSync('launchctl', ['bootstrap', 'system', MACOS_PLIST_PATH], { stdio: 'ignore' });
    return CONTROLLED_NODE_SERVICE.MACOS_LABEL;
  }
  if (process.platform === 'linux') {
    await mkdir(dirname(LINUX_UNIT_PATH), { recursive: true });
    await writeFile(LINUX_UNIT_PATH, linuxSystemdUnit(exePath), { mode: 0o644 });
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['enable', '--now', CONTROLLED_NODE_SERVICE.LINUX_UNIT], { stdio: 'ignore' });
    return CONTROLLED_NODE_SERVICE.LINUX_UNIT;
  }
  throw new Error(`unsupported platform: ${process.platform}`);
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
  execFileSync('icacls', windowsCredentialAclArgs(dir), { stdio: 'ignore' });
  return dir;
}
