import { writeFile, mkdir, stat, truncate } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TASK_NAME = 'imcodes-daemon';

/** Sentinel file that tells the watchdog loop to pause.
 *  Created by the upgrade batch before npm install, deleted after restart. */
export const UPGRADE_LOCK_FILE = join(homedir(), '.imcodes', 'upgrade.lock');

export interface LaunchPaths {
  nodeExe: string;
  imcodesScript: string;
  watchdogPath: string;
  vbsPath: string;
  logPath: string;
}

/** Resolve all paths needed for the Windows daemon launch chain. */
export function resolveLaunchPaths(): LaunchPaths {
  const baseDir = join(homedir(), '.imcodes');
  return {
    nodeExe: process.execPath,
    imcodesScript: join(__dirname, '..', 'index.js'),
    watchdogPath: join(baseDir, 'daemon-watchdog.cmd'),
    vbsPath: join(baseDir, 'daemon-launcher.vbs'),
    logPath: join(baseDir, 'watchdog.log'),
  };
}

/** Write the daemon-watchdog.cmd that loops and restarts the daemon.
 *  Uses the npm global shim (`imcodes.cmd`) instead of hard-coding
 *  node.exe + script paths — this way the watchdog always launches
 *  whatever version is currently installed, even after npm upgrades. */
export async function writeWatchdogCmd(paths: LaunchPaths): Promise<void> {
  await mkdir(dirname(paths.watchdogPath), { recursive: true });
  // Resolve the npm global shim path (e.g. C:\Users\X\AppData\Roaming\npm\imcodes.cmd)
  const npmGlobalBin = dirname(paths.imcodesScript).replace(/[/\\]node_modules[/\\]imcodes[/\\]dist[/\\]src$/i, '');
  const shimPath = join(npmGlobalBin, 'imcodes.cmd');
  // Prefer the shim if it exists; fall back to direct node+script for dev setups
  const launchCmd = existsSync(shimPath)
    ? `"${shimPath}" start --foreground`
    : `"${paths.nodeExe}" "${paths.imcodesScript}" start --foreground`;
  const lockFile = UPGRADE_LOCK_FILE.replace(/\//g, '\\');
  const watchdog = [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    ':loop',
    `if exist "${lockFile}" (`,
    `  echo Upgrade in progress, waiting... >> "${paths.logPath}"`,
    '  timeout /t 5 /nobreak >nul',
    '  goto loop',
    ')',
    `${launchCmd} >> "${paths.logPath}" 2>&1`,
    'timeout /t 5 /nobreak >nul',
    'goto loop',
    '',
  ].join('\r\n');
  // Write as UTF-8 + BOM so cmd.exe parses non-ASCII paths correctly
  // (e.g. usernames with Chinese characters).  Without the BOM cmd.exe
  // reads the file using the system codepage and mangles UTF-8 bytes.
  await writeFile(paths.watchdogPath, encodeCmdAsUtf8Bom(watchdog));
}

/** Encode a .cmd file as UTF-8 with BOM so cmd.exe handles non-ASCII paths. */
export function encodeCmdAsUtf8Bom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf8')]);
}

/** Write the daemon-launcher.vbs that starts the watchdog CMD hidden.
 *
 *  IMPORTANT: VBS files MUST be saved as UTF-16 LE with BOM on Windows.
 *  wscript reads BOM-less files as ANSI (the system codepage, e.g. GBK on
 *  Chinese Windows), so a UTF-8 file with non-ASCII characters in the
 *  watchdog path (e.g. a username with Chinese characters) gets garbled
 *  and wscript can't find the .cmd file.
 *
 *  Also: `On Error Resume Next` ensures wscript NEVER pops up an error
 *  dialog (e.g. if the watchdog .cmd is missing).  Errors fail silently. */
export async function writeVbsLauncher(paths: LaunchPaths): Promise<void> {
  await mkdir(dirname(paths.vbsPath), { recursive: true });
  const vbs = `On Error Resume Next\r\nSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${paths.watchdogPath}""", 0, False\r\n`;
  await writeFile(paths.vbsPath, encodeVbsAsUtf16(vbs));
}

/** Encode a VBS source string as UTF-16 LE with BOM (the only encoding
 *  Windows wscript reliably parses for non-ASCII paths). */
export function encodeVbsAsUtf16(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(content, 'utf16le')]);
}

/** Update the existing scheduled task to point at the current VBS launcher.
 *  Returns false if the task doesn't exist. */
export function updateSchtasks(paths: LaunchPaths): boolean {
  try {
    execSync([
      'schtasks', '/Change',
      '/TN', TASK_NAME,
      '/TR', `wscript "${paths.vbsPath}"`,
    ].join(' '), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Truncate the watchdog log if it exceeds 1 MB. */
export async function rotateWatchdogLog(paths: LaunchPaths): Promise<void> {
  try {
    const st = await stat(paths.logPath);
    if (st.size > 1_048_576) {
      await truncate(paths.logPath, 0);
    }
  } catch {
    // Log file doesn't exist yet — nothing to rotate.
  }
}

/** Regenerate all Windows daemon launch artifacts with current paths. */
export async function regenerateAllArtifacts(): Promise<void> {
  const paths = resolveLaunchPaths();
  await writeWatchdogCmd(paths);
  await writeVbsLauncher(paths);
  updateSchtasks(paths);
  await rotateWatchdogLog(paths);
}
