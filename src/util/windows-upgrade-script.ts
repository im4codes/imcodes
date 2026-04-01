export interface WindowsUpgradeScriptInput {
  logFile: string;
  scriptDir: string;
  cleanupPath: string;
  npmCmd: string;
  pkgSpec: string;
  restartCmd: string;
  versionCmd: string;
  targetVer: string;
}

export function buildWindowsCleanupScript(scriptDir: string): string {
  return `@echo off\r
timeout /t 60 /nobreak >nul\r
rmdir /s /q "${scriptDir}"\r
`;
}

export function buildWindowsUpgradeBatch(input: WindowsUpgradeScriptInput): string {
  const { logFile, cleanupPath, npmCmd, pkgSpec, restartCmd, versionCmd, targetVer } = input;
  return `@echo off\r
echo === imcodes upgrade started at %date% %time% === >> "${logFile}"\r
timeout /t 2 /nobreak > nul\r
\r
echo Installing ${pkgSpec}... >> "${logFile}"\r
"${npmCmd}" install -g ${pkgSpec} >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 (\r
  echo Install FAILED — keeping current daemon running. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  start "" cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
\r
set "INSTALLED_VER="\r
for /f "usebackq delims=" %%v in (\`${versionCmd} 2^>nul\`) do if not defined INSTALLED_VER set "INSTALLED_VER=%%v"\r
echo Install succeeded. Installed version: %INSTALLED_VER%, target: ${targetVer} >> "${logFile}"\r
if not "${targetVer}"=="latest" if /I not "%INSTALLED_VER%"=="${targetVer}" (\r
  echo Version mismatch after install — keeping current daemon running. >> "${logFile}"\r
  echo === upgrade aborted at %date% %time% === >> "${logFile}"\r
  start "" cmd /c "${cleanupPath}" >nul 2>&1\r
  goto :done\r
)\r
echo Restarting daemon via CLI watchdog path... >> "${logFile}"\r
${restartCmd} >> "${logFile}" 2>&1\r
if %errorlevel% neq 0 echo Restart command failed (exit %errorlevel%). >> "${logFile}"\r
start "" cmd /c "${cleanupPath}" >nul 2>&1\r
:done\r
echo === upgrade done at %date% %time% === >> "${logFile}"\r
`;
}

