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
timeout /t 120 /nobreak >nul\r
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
echo === imcodes upgrade started at %date% %time% === >> "%LOG_FILE%"\r
timeout /t 2 /nobreak > nul\r
\r
rem ── Create upgrade lock — watchdog will pause while this file exists ──\r
echo upgrade > "%UPGRADE_LOCK%"\r
echo Upgrade lock created >> "%LOG_FILE%"\r
\r
rem ── Kill daemon + old watchdog so npm can overwrite files cleanly ─────\r
rem Three failure modes we must handle:\r
rem   1. Healthy daemon — kill PIDFILE and parent watchdog tree\r
rem   2. Daemon crashed but watchdog still spamming an error in a tight\r
rem      loop because the OLD watchdog.cmd had a UTF-8 BOM and/or no\r
rem      'call' prefix (cmd.exe quoted-command parse rule).  In this case\r
rem      there is NO daemon.pid but the watchdog cmd.exe processes are\r
rem      still running.  We must find them by command-line pattern.\r
rem   3. Multiple watchdog instances (race after past upgrades)\r
rem Tree-kill EVERY cmd.exe whose command line references daemon-watchdog.\r
rem This catches both the healthy case and the crash-loop case.\r
echo Killing all daemon-watchdog cmd.exe processes... >> "%LOG_FILE%"\r
for /f "tokens=2 delims==" %%w in ('wmic process where "Name='cmd.exe' and CommandLine like '%%daemon-watchdog%%'" get ProcessId /format:list 2^>nul ^| find "="') do (\r
  set "STALE_WD=%%w"\r
  set "STALE_WD=!STALE_WD: =!"\r
  if defined STALE_WD if not "!STALE_WD!"=="" (\r
    echo   tree-killing watchdog PID !STALE_WD! >> "%LOG_FILE%"\r
    taskkill /f /t /pid !STALE_WD! >nul 2>&1\r
  )\r
)\r
rem Also kill the daemon directly if PIDFILE has a fresh value.\r
set "PIDFILE=%USERPROFILE%\\.imcodes\\daemon.pid"\r
if exist "%PIDFILE%" (\r
  set /p OLD_PID=<"%PIDFILE%"\r
  if defined OLD_PID if not "!OLD_PID!"=="" (\r
    echo Stopping daemon PID !OLD_PID!... >> "%LOG_FILE%"\r
    taskkill /f /pid !OLD_PID! >nul 2>&1\r
  )\r
)\r
rem Belt-and-suspenders: if the watchdog file itself has a BOM (the bug we\r
rem just fixed), the new repair-watchdog step below will overwrite it with\r
rem clean bytes.  Until then, prevent the freshly-killed watchdog from being\r
rem respawned by anyone (e.g. a scheduled task) by leaving the lock in place.\r
timeout /t 2 /nobreak >nul\r
\r
if defined NODE_OPTIONS (\r
  set "NODE_OPTIONS=%NODE_OPTIONS% --max-old-space-size=16384"\r
) else (\r
  set "NODE_OPTIONS=--max-old-space-size=16384"\r
)\r
echo Using NODE_OPTIONS=%NODE_OPTIONS% >> "%LOG_FILE%"\r
\r
echo Installing ${pkgSpec}... >> "%LOG_FILE%"\r
call "${npmCmd}" install -g ${pkgSpec} >> "%LOG_FILE%" 2>&1\r
if %errorlevel% neq 0 (\r
  echo Install FAILED — removing lock, watchdog will restart current version. >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
\r
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
  echo Version mismatch after install — removing lock, watchdog will restart. >> "%LOG_FILE%"\r
  echo === upgrade aborted at %date% %time% === >> "%LOG_FILE%"\r
  del "%UPGRADE_LOCK%" >nul 2>&1\r
  if exist "%VBS_LAUNCHER%" wscript "%VBS_LAUNCHER%"\r
  wscript "%CLEANUP_VBS%" >nul 2>&1\r
  goto :done\r
)\r
where imcodes >nul 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: imcodes not found on PATH >> "%LOG_FILE%"\r
  echo To fix: setx PATH "%NPM_PREFIX%;%%PATH%%" >> "%LOG_FILE%"\r
)\r
echo Regenerating daemon launch chain... >> "%LOG_FILE%"\r
call "%CLI_SHIM%" repair-watchdog >> "%LOG_FILE%" 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: Launch chain regeneration failed >> "%LOG_FILE%"\r
)\r
\r
rem ── Start new watchdog (lock-aware), then remove lock ─────────────────\r
rem The new watchdog (generated by repair-watchdog) checks the lock file.\r
rem It will loop/wait while the lock exists, then start the daemon once\r
rem we delete it below.\r
echo Starting new watchdog via VBS... >> "%LOG_FILE%"\r
if exist "%VBS_LAUNCHER%" (\r
  wscript "%VBS_LAUNCHER%"\r
) else (\r
  echo WARNING: VBS launcher not found at %VBS_LAUNCHER% >> "%LOG_FILE%"\r
)\r
echo Removing upgrade lock... >> "%LOG_FILE%"\r
del "%UPGRADE_LOCK%" >nul 2>&1\r
\r
rem Wait for new watchdog to start the daemon, then health-check\r
timeout /t 10 /nobreak >nul\r
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
echo === upgrade done at %date% %time% === >> "%LOG_FILE%"\r
`;
}
