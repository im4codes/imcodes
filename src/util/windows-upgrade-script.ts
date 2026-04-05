export interface WindowsUpgradeScriptInput {
  logFile: string;
  scriptDir: string;
  cleanupPath: string;
  npmCmd: string;
  pkgSpec: string;
  targetVer: string;
}

export function buildWindowsCleanupScript(scriptDir: string): string {
  return `@echo off\r
timeout /t 120 /nobreak >nul\r
rmdir /s /q "${scriptDir}"\r
`;
}

export function buildWindowsUpgradeBatch(input: WindowsUpgradeScriptInput): string {
  const { logFile, cleanupPath, npmCmd, pkgSpec, targetVer } = input;
  return `@echo off\r
setlocal EnableDelayedExpansion\r
echo === imcodes upgrade started at %date% %time% === >> "${logFile}"\r
timeout /t 2 /nobreak > nul\r
\r
echo Installing ${pkgSpec}... >> "${logFile}"\r
call "${npmCmd}" install -g ${pkgSpec} >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 (\r
  echo Install FAILED — keeping current daemon running. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "NPM_PREFIX="\r
for /f "usebackq delims=" %%p in (\`call "${npmCmd}" prefix -g 2^>nul\`) do if not defined NPM_PREFIX set "NPM_PREFIX=%%p"\r
if not defined NPM_PREFIX (\r
  echo Could not resolve npm global prefix after install. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "CLI_SHIM=%NPM_PREFIX%\\imcodes.cmd"\r
if not exist "%CLI_SHIM%" (\r
  echo imcodes shim missing after install: %CLI_SHIM% >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  start "" /min cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "INSTALLED_VER="\r
for /f "usebackq delims=" %%v in (\`call "%CLI_SHIM%" --version 2^>nul\`) do if not defined INSTALLED_VER set "INSTALLED_VER=%%v"\r
echo Install succeeded. Installed version: %INSTALLED_VER%, target: ${targetVer}, shim: %CLI_SHIM% >> "${logFile}"\r
if not "${targetVer}"=="latest" if /I not "%INSTALLED_VER%"=="${targetVer}" (\r
  echo Version mismatch after install — keeping current daemon running. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
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
echo Restarting daemon via CLI watchdog path... >> "${logFile}"\r
call "%CLI_SHIM%" restart >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 echo Restart command failed (exit %errorlevel%). >> "${logFile}"\r
timeout /t 8 /nobreak >nul\r
set "PIDFILE=%USERPROFILE%\\.imcodes\\daemon.pid"\r
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
