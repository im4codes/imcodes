export interface WindowsUpgradeScriptInput {
  logFile: string;
  scriptDir: string;
  cleanupPath: string;
  npmCmd: string;
  pkgSpec: string;
  targetVer: string;
  /** Absolute path to daemon-launcher.vbs for hidden restart */
  vbsLauncherPath: string;
}

export function buildWindowsCleanupScript(scriptDir: string): string {
  return `@echo off\r
timeout /t 120 /nobreak >nul\r
rmdir /s /q "${scriptDir}"\r
`;
}

export function buildWindowsUpgradeBatch(input: WindowsUpgradeScriptInput): string {
  const { logFile, cleanupPath, npmCmd, pkgSpec, targetVer, vbsLauncherPath } = input;
  return `@echo off\r
setlocal EnableDelayedExpansion\r
echo === imcodes upgrade started at %date% %time% === >> "${logFile}"\r
timeout /t 2 /nobreak > nul\r
\r
rem ── Stop watchdog + daemon BEFORE npm install ──────────────────────────\r
rem npm install -g deletes the old package before writing the new one.\r
rem If the watchdog loop restarts the daemon during that window, it hits\r
rem MODULE_NOT_FOUND and dies.  Kill the entire watchdog tree first.\r
set "PIDFILE=%USERPROFILE%\\.imcodes\\daemon.pid"\r
if exist "%PIDFILE%" (\r
  set /p OLD_PID=<"%PIDFILE%"\r
  echo Stopping daemon PID !OLD_PID! and watchdog tree... >> "${logFile}"\r
  rem Find watchdog (parent of daemon) via wmic and tree-kill it\r
  for /f "tokens=2 delims==" %%a in ('wmic process where "ProcessId=!OLD_PID!" get ParentProcessId /format:list 2^>nul ^| find "="') do (\r
    set "WATCHDOG_PID=%%a"\r
  )\r
  if defined WATCHDOG_PID (\r
    rem Strip trailing carriage return from wmic output\r
    set "WATCHDOG_PID=!WATCHDOG_PID: =!"\r
    for /f "delims=" %%x in ("!WATCHDOG_PID!") do set "WATCHDOG_PID=%%x"\r
    taskkill /f /t /pid !WATCHDOG_PID! >nul 2>&1\r
    echo Killed watchdog tree PID !WATCHDOG_PID! >> "${logFile}"\r
  )\r
  rem Belt-and-suspenders: ensure daemon is dead even if tree-kill missed it\r
  taskkill /f /pid !OLD_PID! >nul 2>&1\r
  rem Also kill any other stale watchdog loops\r
  for /f "tokens=2 delims=," %%p in ('wmic process where "CommandLine like '%%daemon-watchdog%%' and Name='cmd.exe'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (\r
    taskkill /f /t /pid %%p >nul 2>&1\r
  )\r
  del "%PIDFILE%" >nul 2>&1\r
  timeout /t 2 /nobreak >nul\r
)\r
\r
echo Installing ${pkgSpec}... >> "${logFile}"\r
call "${npmCmd}" install -g ${pkgSpec} >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 (\r
  echo Install FAILED — restarting current daemon. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  rem Restart the old version so the daemon isn't left dead\r
  if exist "${vbsLauncherPath}" wscript "${vbsLauncherPath}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "NPM_PREFIX="\r
for /f "usebackq delims=" %%p in (\`call "${npmCmd}" prefix -g 2^>nul\`) do if not defined NPM_PREFIX set "NPM_PREFIX=%%p"\r
if not defined NPM_PREFIX (\r
  echo Could not resolve npm global prefix after install. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  if exist "${vbsLauncherPath}" wscript "${vbsLauncherPath}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "CLI_SHIM=%NPM_PREFIX%\\imcodes.cmd"\r
if not exist "%CLI_SHIM%" (\r
  echo imcodes shim missing after install: %CLI_SHIM% >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  if exist "${vbsLauncherPath}" wscript "${vbsLauncherPath}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "INSTALLED_VER="\r
for /f "usebackq delims=" %%v in (\`call "%CLI_SHIM%" --version 2^>nul\`) do if not defined INSTALLED_VER set "INSTALLED_VER=%%v"\r
echo Install succeeded. Installed version: %INSTALLED_VER%, target: ${targetVer}, shim: %CLI_SHIM% >> "${logFile}"\r
if not "${targetVer}"=="latest" if /I not "%INSTALLED_VER%"=="${targetVer}" (\r
  echo Version mismatch after install — restarting current version. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  if exist "${vbsLauncherPath}" wscript "${vbsLauncherPath}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
where imcodes >nul 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: imcodes not found on PATH >> "${logFile}"\r
  echo To fix: setx PATH "%NPM_PREFIX%;%%PATH%%" >> "${logFile}"\r
)\r
echo Regenerating daemon launch chain... >> "${logFile}"\r
call "%CLI_SHIM%" repair-watchdog >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 (\r
  echo WARNING: Launch chain regeneration failed >> "${logFile}"\r
)\r
rem ── Start fresh hidden watchdog via VBS (not imcodes restart) ──────────\r
rem Using VBS directly avoids depending on the new CLI's restart logic\r
rem which may differ across versions.  The watchdog loop inside the CMD\r
rem will start the daemon automatically.\r
echo Starting fresh watchdog via VBS launcher... >> "${logFile}"\r
if exist "${vbsLauncherPath}" (\r
  wscript "${vbsLauncherPath}"\r
) else (\r
  echo WARNING: VBS launcher not found, falling back to CLI restart >> "${logFile}"\r
  call "%CLI_SHIM%" restart >> "${logFile}" 2>&1\r
)\r
timeout /t 8 /nobreak >nul\r
if exist "%PIDFILE%" (\r
  set /p DAEMON_PID=<"%PIDFILE%"\r
  tasklist /fi "PID eq !DAEMON_PID!" /nh 2^>nul | find "!DAEMON_PID!" >nul\r
  if !errorlevel! equ 0 (\r
    echo Health check PASSED: daemon PID !DAEMON_PID! alive >> "${logFile}"\r
  ) else (\r
    echo Health check FAILED: PID !DAEMON_PID! not running >> "${logFile}"\r
  )\r
) else (\r
  echo Health check FAILED: daemon.pid not found >> "${logFile}"\r
)\r
start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
:done\r
echo === upgrade done at %date% %time% === >> "${logFile}"\r
`;
}
