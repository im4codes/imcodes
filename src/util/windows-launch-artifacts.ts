import { writeFile, mkdir, stat, truncate } from 'fs/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

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
 *
 *  IMPORTANT: this file is parsed by cmd.exe.  Two non-obvious rules:
 *
 *  1. cmd.exe does NOT understand a UTF-8 BOM at the start of a .cmd file.
 *     The BOM bytes (EF BB BF) are treated as part of the first command,
 *     so `[BOM]@echo off` becomes the unknown command "[BOM]@echo".
 *     => never write a BOM here.
 *
 *  2. To support non-ASCII paths (e.g. usernames with Chinese characters)
 *     we never hard-code absolute paths.  Instead we use environment-variable
 *     expansion (%USERPROFILE%, %APPDATA%) which cmd.exe resolves at runtime
 *     using the OS's native wide-character API — no encoding round-trip.
 *
 *  3. Uses the npm global shim (`imcodes.cmd`) by default so the watchdog
 *     always launches whatever version is currently installed, even after
 *     npm upgrades.  Falls back to direct node+script for dev installs
 *     where the shim isn't on %APPDATA%\npm. */
export async function writeWatchdogCmd(paths: LaunchPaths): Promise<void> {
  await mkdir(dirname(paths.watchdogPath), { recursive: true });
  // Detect whether the npm global shim exists.  When yes, the watchdog can
  // use the parameter-free env-var path; when no (e.g. tests, dev installs)
  // we fall back to a direct node+script invocation with absolute paths.
  const npmGlobalBin = dirname(paths.imcodesScript).replace(/[/\\]node_modules[/\\]imcodes[/\\]dist[/\\]src$/i, '');
  const shimPath = join(npmGlobalBin, 'imcodes.cmd');
  const useShim = existsSync(shimPath);

  // Build the launch line.  Either form gets prefixed with `call ` so cmd.exe
  // returns to the loop after the daemon exits (without `call`, control would
  // hand off to the .cmd shim and never come back).
  const launchCmd = useShim
    ? `call "%APPDATA%\\npm\\imcodes.cmd" start --foreground`
    : `call "${paths.nodeExe}" "${paths.imcodesScript}" start --foreground`;

  const watchdog = [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    ':loop',
    'if exist "%USERPROFILE%\\.imcodes\\upgrade.lock" (',
    '  echo Upgrade in progress, waiting... >> "%USERPROFILE%\\.imcodes\\watchdog.log"',
    '  timeout /t 5 /nobreak >nul',
    '  goto loop',
    ')',
    `${launchCmd} >> "%USERPROFILE%\\.imcodes\\watchdog.log" 2>&1`,
    'timeout /t 5 /nobreak >nul',
    'goto loop',
    '',
  ].join('\r\n');

  // CRITICAL: write as plain UTF-8 with NO BOM. cmd.exe does not understand
  // BOMs in batch files — the BOM bytes get prepended to the first command
  // and cmd reports "[BOM]@echo is not a recognized command".
  await writeFile(paths.watchdogPath, watchdog, 'utf8');
}

/** @deprecated cmd.exe does not understand UTF-8 BOMs in batch files; the BOM
 *  bytes break the very first command of the script.  Kept here only so
 *  upgrade scripts that already imported it continue to compile — they should
 *  switch to plain `writeFile(..., 'utf8')` instead. */
export function encodeCmdAsUtf8Bom(content: string): Buffer {
  return Buffer.from(content, 'utf8');
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
    ].join(' '), { stdio: 'ignore', windowsHide: true });
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

/** Regenerate all Windows daemon launch artifacts with current paths.
 *
 *  Tree-kills any existing daemon-watchdog cmd.exe processes BEFORE writing
 *  the new files.  This is critical when the user is recovering from a
 *  crash-loop caused by an OLD watchdog file with a UTF-8 BOM (cmd.exe
 *  parses [BOM]@echo as the unknown command "[BOM]@echo" forever).
 *  Without the kill, the old watchdog still has the bad file mapped and
 *  will overwrite our PID file with stale data.
 *
 *  Process matching is by command-line pattern via wmic, which is
 *  language-independent — works on en-US, zh-CN, ja-JP and any other Windows
 *  locale. */
export async function regenerateAllArtifacts(): Promise<void> {
  killAllStaleWatchdogsBeforeRegen();
  const paths = resolveLaunchPaths();
  await writeWatchdogCmd(paths);
  await writeVbsLauncher(paths);
  updateSchtasks(paths);
  await rotateWatchdogLog(paths);
}

function killAllStaleWatchdogsBeforeRegen(): void {
  if (process.platform !== 'win32') return;
  // PowerShell first (works on every Windows including ones where wmic is gone)
  // CRITICAL: use a temp .ps1 file, NOT `-Command "..."` — nested double
  // quotes inside the script body get truncated by cmd.exe→powershell
  // command-line parsing.  See windows-daemon.ts findStaleWatchdogPids.
  let pids: number[] = [];
  let scriptDir: string | null = null;
  try {
    scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-regen-'));
    const scriptPath = join(scriptDir, 'find-stale.ps1');
    writeFileSync(
      scriptPath,
      "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*daemon-watchdog*' } | " +
        "ForEach-Object { $_.ProcessId }\r\n",
    );
    const out = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) pids.push(pid);
    }
  } catch { /* fall through */ } finally {
    if (scriptDir) {
      try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (pids.length === 0) {
    try {
      const out = execSync(
        'wmic process where "Name=\'cmd.exe\' and CommandLine like \'%daemon-watchdog%\'" get ProcessId /format:list',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      pids = out
        .split(/\r?\n/)
        .map((line) => line.match(/^ProcessId=(\d+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => parseInt(m[1], 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
    } catch { /* both methods failed */ }
  }
  for (const pid of pids) {
    try { execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true }); } catch { /* already dead */ }
  }
}
