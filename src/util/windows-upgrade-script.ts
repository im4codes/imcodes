export interface WindowsUpgradeScriptInput {
  logFile: string;
  scriptDir: string;
  cleanupPath: string;
  /** VBS wrapper that runs the cleanup cmd hidden (no flashing window) */
  cleanupVbsPath: string;
  npmCmd: string;
  pkgSpec: string;
  targetVer: string;
  /** Absolute path to daemon-launcher.vbs for hidden restart */
  vbsLauncherPath: string;
  /** Sentinel file — while it exists the watchdog loop pauses */
  upgradeLockFile: string;
}

export function buildWindowsCleanupScript(scriptDir: string): string {
  void scriptDir;
  return `@echo off\r
chcp 65001 >nul 2>&1\r
setlocal\r
rem ping-based sleep: works when launched via wscript (no console for stdin),\r
rem unlike "timeout /t N /nobreak" which aborts with "Input redirection is\r
rem not supported" and returns immediately.  -n 121 ≈ 120 s wait.\r
ping -n 121 127.0.0.1 >nul 2>&1\r
for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"\r
rmdir /s /q "%SCRIPT_DIR%"\r
`;
}

/** VBS wrapper that runs the cleanup cmd in a hidden window (no taskbar flash).
 *  `On Error Resume Next` ensures no error dialog pops up. */
export function buildWindowsCleanupVbs(cleanupPath: string): string {
  return `On Error Resume Next\r\nSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${cleanupPath}""", 0, False\r\n`;
}

/** VBS wrapper that runs the upgrade batch in a hidden window.
 *  Without this, child processes spawned by the batch (wmic, find, tasklist)
 *  may flash visible console windows on some Windows versions.
 *  `On Error Resume Next` ensures no error dialog pops up. */
export function buildWindowsUpgradeVbs(batchPath: string): string {
  return `On Error Resume Next\r\nSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${batchPath}""", 0, False\r\n`;
}

/**
 * Build the Windows upgrade batch script.
 *
 * DESIGN PRINCIPLE: the OLD daemon MUST stay alive even if the upgrade fails.
 *
 * Old flow (broken — this left users with no daemon when npm install crashed):
 *   1. Set upgrade.lock
 *   2. Kill old daemon + all watchdogs  ← destroys the only working instance!
 *   3. Run npm install
 *   4. If install fails: restart daemon somehow (but binary may be gone)
 *
 * New flow (safe):
 *   1. Set upgrade.lock          (watchdog pauses, but old daemon keeps running)
 *   2. Run npm install           (while old daemon is still alive and serving)
 *   3. Verify install succeeded  (shim exists, version matches)
 *   4. Kill old daemon + watchdogs — ONLY after install is proven good
 *   5. Regenerate launch chain
 *   6. Start new watchdog
 *   7. Delete upgrade.lock
 *   8. Health-check
 *
 * On ANY failure path (steps 2/3 abort), we simply delete the lock and
 * leave the old daemon untouched.  The only cleanup is removing the lock
 * so the watchdog loop resumes serving the OLD version.
 */
export function buildWindowsUpgradeBatch(input: WindowsUpgradeScriptInput): string {
  const { logFile, cleanupVbsPath, npmCmd, pkgSpec, targetVer, vbsLauncherPath, upgradeLockFile } = input;
  void logFile;
  void cleanupVbsPath;
  void vbsLauncherPath;
  void upgradeLockFile;
  return `@echo off\r
chcp 65001 >nul 2>&1\r
setlocal EnableDelayedExpansion\r
for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"\r
set "LOG_FILE=%SCRIPT_DIR%\\upgrade.log"\r
set "CLEANUP_VBS=%SCRIPT_DIR%\\cleanup.vbs"\r
set "VBS_LAUNCHER=%USERPROFILE%\\.imcodes\\daemon-launcher.vbs"\r
set "UPGRADE_LOCK=%USERPROFILE%\\.imcodes\\upgrade.lock"\r
set "PIDFILE=%USERPROFILE%\\.imcodes\\daemon.pid"\r
echo === imcodes upgrade started at %date% %time% === >> "%LOG_FILE%"\r
rem ping-based sleep: timeout fails under wscript (no stdin console)\r
ping -n 3 127.0.0.1 >nul 2>&1\r
\r
rem ── Step 1: Create upgrade lock — watchdog will pause (daemon keeps running) ──\r
echo upgrade > "%UPGRADE_LOCK%"\r
echo Upgrade lock created (old daemon still running, watchdog paused) >> "%LOG_FILE%"\r
\r
rem Capture the OLD daemon's PID so we can kill it LATER (only after install OK)\r
set "OLD_DAEMON_PID="\r
if exist "%PIDFILE%" (\r
  set /p OLD_DAEMON_PID=<"%PIDFILE%"\r
  echo Old daemon PID: !OLD_DAEMON_PID! (will be killed only after install succeeds) >> "%LOG_FILE%"\r
)\r
\r
rem Save the daemon's original NODE_OPTIONS so we can restore it BEFORE\r
rem any branch that re-spawns the daemon launcher (success path or abort\r
rem paths).  Otherwise our --max-old-space-size flag accumulates one copy\r
rem per upgrade cycle in the new daemon's env (the spawned launcher\r
rem inherits our setlocal env), and after N upgrades NODE_OPTIONS contains\r
rem N copies of the flag.  V8 then tries to reserve a heap matching the\r
rem LAST occurrence (e.g. 16 GB), and on RAM/VAS-tight systems npm install\r
rem crashes with\r
rem   "Fatal JavaScript out of memory: MemoryChunk allocation failed during\r
rem    deserialization".\r
rem We also drop the heap from 16 GB to 4 GB: npm install rarely needs\r
rem more than ~1-2 GB, and 16 GB virtual reservation can fail the OS\r
rem commit check while the OLD daemon is still resident.\r
set "ORIG_NODE_OPTIONS=%NODE_OPTIONS%"\r
set "NODE_OPTIONS=--max-old-space-size=4096"\r
echo Using NODE_OPTIONS=%NODE_OPTIONS% (orig: %ORIG_NODE_OPTIONS%) >> "%LOG_FILE%"\r
\r
rem ── Step 2: Run npm install WHILE OLD DAEMON IS STILL ALIVE ──────────────\r
rem On Windows, node's .js modules aren't locked by the running daemon\r
rem (node reads them into memory at load time), so npm CAN overwrite them\r
rem safely while the old daemon keeps serving requests.  This is the key\r
rem to guaranteeing the old daemon survives install failures.\r
echo Installing ${pkgSpec}... >> "%LOG_FILE%"\r
call "${npmCmd}" install -g ${pkgSpec} >> "%LOG_FILE%" 2>&1\r
set "INSTALL_EXIT=%errorlevel%"\r
\r
rem Restore the daemon's original NODE_OPTIONS NOW (right after npm install)\r
rem so EVERY subsequent path — abort branches that wscript-relaunch the\r
rem daemon, plus the success branch that spawns the new watchdog — runs\r
rem with the daemon's original env.  Otherwise our temporary heap flag\r
rem leaks into the new daemon and accumulates one copy per upgrade.\r
set "NODE_OPTIONS=%ORIG_NODE_OPTIONS%"\r
if %INSTALL_EXIT% neq 0 (\r
  echo Install FAILED with exit code %INSTALL_EXIT% — old daemon untouched. >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  rem No need to restart daemon — it was never killed.  But as a safety net\r
  rem in case npm install corrupted files that a future daemon restart would\r
  rem need, re-launch via VBS (it will no-op if daemon is already running).\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
\r
rem ── Step 3: Verify the install (shim exists, version matches) ──────────\r
set "NPM_PREFIX="\r
for /f "usebackq delims=" %%p in (\`call "${npmCmd}" prefix -g 2^>nul\`) do if not defined NPM_PREFIX set "NPM_PREFIX=%%p"\r
if not defined NPM_PREFIX (\r
  echo Could not resolve npm global prefix after install. >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
\r
set "CLI_SHIM=%NPM_PREFIX%\\imcodes.cmd"\r
if not exist "%CLI_SHIM%" (\r
  echo imcodes shim missing after install: %CLI_SHIM% >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
\r
set "INSTALLED_VER="\r
for /f "usebackq delims=" %%v in (\`call "%CLI_SHIM%" --version 2^>nul\`) do if not defined INSTALLED_VER set "INSTALLED_VER=%%v"\r
echo Install succeeded. Installed version: %INSTALLED_VER%, target: ${targetVer}, shim: %CLI_SHIM% >> "%LOG_FILE%"\r
if not "${targetVer}"=="latest" if /I not "%INSTALLED_VER%"=="${targetVer}" (\r
  echo Version mismatch after install — removing lock, old daemon keeps serving. >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
\r
where imcodes >nul 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: imcodes not found on PATH >> "%LOG_FILE%"\r
  echo To fix: setx PATH "%NPM_PREFIX%;%%PATH%%" >> "%LOG_FILE%"\r
)\r
\r
rem ── Step 4: Kill old daemon + stale watchdogs — ONLY now (install OK) ───\r
rem Find watchdog cmd.exe processes by command-line pattern.  Try PowerShell\r
rem first (deprecated-wmic-safe), fall back to wmic for legacy installs.\r
echo Killing old daemon-watchdog cmd.exe processes (install succeeded)... >> "%LOG_FILE%"\r
set "PS_SCRIPT=%SCRIPT_DIR%\\find-stale-watchdog.ps1"\r
> "%PS_SCRIPT%" echo Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" ^| Where-Object { $_.CommandLine -like '*daemon-watchdog*' } ^| ForEach-Object { $_.ProcessId }\r
for /f "usebackq delims=" %%w in (\`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PS_SCRIPT%" 2^>nul\`) do (\r
  set "STALE_WD=%%w"\r
  set "STALE_WD=!STALE_WD: =!"\r
  if defined STALE_WD if not "!STALE_WD!"=="" (\r
    echo   tree-killing watchdog PID !STALE_WD! ^(via powershell^) >> "%LOG_FILE%"\r
    taskkill /f /t /pid !STALE_WD! >nul 2>&1\r
  )\r
)\r
for /f "tokens=2 delims==" %%w in ('wmic process where "Name='cmd.exe' and CommandLine like '%%daemon-watchdog%%'" get ProcessId /format:list 2^>nul ^| find "="') do (\r
  set "STALE_WD=%%w"\r
  set "STALE_WD=!STALE_WD: =!"\r
  if defined STALE_WD if not "!STALE_WD!"=="" (\r
    echo   tree-killing watchdog PID !STALE_WD! ^(via wmic^) >> "%LOG_FILE%"\r
    taskkill /f /t /pid !STALE_WD! >nul 2>&1\r
  )\r
)\r
if defined OLD_DAEMON_PID if not "!OLD_DAEMON_PID!"=="" (\r
  echo Stopping old daemon PID !OLD_DAEMON_PID!... >> "%LOG_FILE%"\r
  taskkill /f /pid !OLD_DAEMON_PID! >nul 2>&1\r
)\r
ping -n 3 127.0.0.1 >nul 2>&1\r
\r
rem ── Step 5: Regenerate launch chain with the new binary's paths ────────\r
echo Regenerating daemon launch chain... >> "%LOG_FILE%"\r
call "%CLI_SHIM%" repair-watchdog >> "%LOG_FILE%" 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: Launch chain regeneration failed >> "%LOG_FILE%"\r
)\r
\r
rem ── Step 6: Start new watchdog ─────────────────────────────────────────\r
rem The new watchdog (generated by repair-watchdog) checks the lock file.\r
rem It will loop/wait while the lock exists, then start the daemon once\r
rem we delete it below.\r
rem NODE_OPTIONS was restored to the daemon's original value right after\r
rem npm install, so the new daemon inherits a clean env (no accumulated\r
rem --max-old-space-size flags).\r
echo Starting new watchdog via VBS (NODE_OPTIONS=%NODE_OPTIONS%)... >> "%LOG_FILE%"\r
if exist "%VBS_LAUNCHER%" (\r
  wscript "%VBS_LAUNCHER%"\r
) else (\r
  echo WARNING: VBS launcher not found at %VBS_LAUNCHER% >> "%LOG_FILE%"\r
)\r
\r
rem ── Step 7: Remove lock → watchdog starts the new daemon ───────────────\r
echo Removing upgrade lock... >> "%LOG_FILE%"\r
del "%UPGRADE_LOCK%" >nul 2>&1\r
\r
rem ── Step 8: Health-check the new daemon ────────────────────────────────\r
ping -n 11 127.0.0.1 >nul 2>&1\r
if exist "%PIDFILE%" (\r
  set /p DAEMON_PID=<"%PIDFILE%"\r
  tasklist /fi "PID eq !DAEMON_PID!" /nh 2^>nul | find "!DAEMON_PID!" >nul\r
  if !errorlevel! equ 0 (\r
    echo Health check PASSED: daemon PID !DAEMON_PID! alive >> "%LOG_FILE%"\r
  ) else (\r
    echo Health check FAILED: PID !DAEMON_PID! not running >> "%LOG_FILE%"\r
  )\r
) else (\r
  echo Health check FAILED: daemon.pid not found >> "%LOG_FILE%"\r
)\r
wscript "%CLEANUP_VBS%" >nul 2>&1\r
:done\r
rem ── Final safety net: make absolutely sure the lock is removed ─────────\r
rem If any of the above paths ended without deleting the lock (shouldn't\r
rem happen, but defend in depth), remove it here so the watchdog can\r
rem resume serving.  This protects against batch script crashes too.\r
rem\r
rem We try del first, then PowerShell Remove-Item as fallback — observed\r
rem in the wild that del can silently fail (sharing violation, transient\r
rem AV scan, weird ACL inheritance) even when the file is owned by us.\r
if exist "%UPGRADE_LOCK%" (\r
  echo Final safety: removing lingering upgrade.lock >> "%LOG_FILE%"\r
  del /f /q "%UPGRADE_LOCK%" >nul 2>&1\r
)\r
if exist "%UPGRADE_LOCK%" (\r
  echo del failed; falling back to PowerShell Remove-Item >> "%LOG_FILE%"\r
  powershell -NoProfile -NonInteractive -Command "Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath \"%UPGRADE_LOCK%\"" >nul 2>&1\r
)\r
if exist "%UPGRADE_LOCK%" (\r
  echo WARNING: upgrade.lock still present after both deletion attempts — watchdog will spin >> "%LOG_FILE%"\r
)\r
echo === upgrade done at %date% %time% === >> "%LOG_FILE%"\r
`;
}
