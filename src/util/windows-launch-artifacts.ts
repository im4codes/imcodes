import { writeFile, mkdir, stat, truncate } from 'fs/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path, { join, dirname } from 'path';
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
 *  2. For paths that ALWAYS live under the user's profile (the lock file,
 *     watchdog log) we use environment-variable expansion
 *     (%USERPROFILE%, %APPDATA%) which cmd.exe resolves at runtime using
 *     the OS's native wide-character API — no encoding round-trip.
 *
 *  3. For the npm-installed shim path we cannot blindly assume
 *     `%APPDATA%\npm\imcodes.cmd` — that's only correct when the user's
 *     npm global prefix happens to match the default.  With nvm / fnm /
 *     volta / a custom `npm config set prefix`, npm writes to a totally
 *     different location, and hardcoding `%APPDATA%\npm` makes the
 *     watchdog launch an OLD stale shim left over from a previous default-
 *     prefix install (or do nothing).  Symptom in the wild: user runs
 *     `imcodes` upgrade, npm install succeeds against the real prefix,
 *     daemon "restart" launches the stale `%APPDATA%\npm\imcodes.cmd`
 *     and the version stays pinned at whatever was last default-prefix-
 *     installed.  See commit log around 4/29/2026.
 *
 *     Resolution: derive the real prefix from THIS module's own install
 *     path (`paths.imcodesScript`) — that's exactly where npm just put us
 *     — and only use the `%APPDATA%\npm\` form when it provably matches.
 *     Falls back to direct node+script for dev installs where there's no
 *     shim at all. */
export async function writeWatchdogCmd(paths: LaunchPaths): Promise<void> {
  await mkdir(dirname(paths.watchdogPath), { recursive: true });
  // The watchdog .cmd is a Windows-only artifact and the input path uses
  // backslashes. Use `path.win32.*` explicitly so the resolution behaves
  // identically when this code is unit-tested on POSIX dev machines —
  // otherwise POSIX `path.dirname` doesn't recognise backslashes and
  // collapses the whole string to ".", silently breaking the npm-prefix
  // detection below.
  const npmGlobalBin = path.win32.dirname(paths.imcodesScript).replace(/[/\\]node_modules[/\\]imcodes[/\\]dist[/\\]src$/i, '');
  const shimPath = path.win32.join(npmGlobalBin, 'imcodes.cmd');
  const useShim = existsSync(shimPath);

  // Pick how to spell the shim path inside the watchdog .cmd:
  //   - If the resolved shim is the default `%APPDATA%\npm\imcodes.cmd`
  //     we keep the env-var form so non-ASCII usernames don't get
  //     mangled by any UTF-8 ↔ ANSI round-trip in the .cmd file.
  //   - Otherwise (custom prefix, nvm, fnm, volta, system nodejs install)
  //     we MUST emit the absolute path — otherwise the watchdog launches
  //     a stale shim at the default location and the user's npm-installed
  //     upgrade is silently bypassed.
  const appdataNpm = process.env.APPDATA ? path.win32.join(process.env.APPDATA, 'npm') : null;
  const isDefaultPrefix = appdataNpm
    ? npmGlobalBin.toLowerCase() === appdataNpm.toLowerCase()
    : false;
  const shimLaunchTarget = isDefaultPrefix
    ? '%APPDATA%\\npm\\imcodes.cmd'
    : shimPath;

  // Build the launch line.  Either form gets prefixed with `call ` so cmd.exe
  // returns to the loop after the daemon exits (without `call`, control would
  // hand off to the .cmd shim and never come back).
  const launchCmd = useShim
    ? `call "${shimLaunchTarget}" start --foreground`
    : `call "${paths.nodeExe}" "${paths.imcodesScript}" start --foreground`;

  // CRITICAL: use `ping`-based sleep instead of `timeout /t N /nobreak`.
  // `timeout` requires a real console for stdin (it polls keypresses to
  // detect interrupt).  When this watchdog is launched via wscript →
  // WshShell.Run, the spawned cmd has NO console, so `timeout` aborts
  // immediately with "Input redirection is not supported, exiting the
  // process immediately." — meaning the watchdog spins at full CPU and
  // logs thousands of "Upgrade in progress, waiting..." lines per minute.
  // `ping -n N+1 127.0.0.1 >nul` waits ~N seconds with no console need.
  //
  // We also separate the lock-wait state from the post-daemon retry:
  // logging ONCE on entry/exit instead of every poll, and polling at 30 s
  // intervals during lock-wait (vs 5 s after a clean daemon exit).
  const watchdog = [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    ':loop',
    'if exist "%USERPROFILE%\\.imcodes\\upgrade.lock" goto wait_lock',
    `${launchCmd} >> "%USERPROFILE%\\.imcodes\\watchdog.log" 2>&1`,
    'ping -n 6 127.0.0.1 >nul 2>&1',
    'goto loop',
    ':wait_lock',
    'echo [%date% %time%] Upgrade in progress, waiting for lock to clear... >> "%USERPROFILE%\\.imcodes\\watchdog.log"',
    ':wait_loop',
    'ping -n 31 127.0.0.1 >nul 2>&1',
    'if exist "%USERPROFILE%\\.imcodes\\upgrade.lock" goto wait_loop',
    'echo [%date% %time%] Upgrade lock cleared, resuming. >> "%USERPROFILE%\\.imcodes\\watchdog.log"',
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
