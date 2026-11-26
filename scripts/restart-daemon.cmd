@echo off
rem Rebuild, relink, and restart the local imcodes daemon service (dev only).
rem Windows counterpart of scripts/restart-daemon.sh.
rem
rem CRITICAL: this file MUST be pure ASCII (no Unicode em-dashes, box-drawing
rem chars, smart quotes, etc.) and use REM (not the ::-as-comment hack).
rem cmd.exe parses .cmd files using the current OEM codepage BEFORE the chcp
rem 65001 line takes effect, so any multi-byte UTF-8 sequence in the comments
rem at the top of the file gets reinterpreted as OEM bytes and can break the
rem parser (we lost a full restart trying to debug U+2014 in a comment).
rem
rem Steps:
rem   1. npm install / build / link --force (foreground - daemon stays alive
rem      because Node modules were already loaded into V8; npm just overwrites
rem      .js files on disk for the next launch).
rem   2. Spawn the actual "imcodes restart" fully detached via
rem      wscript -- VBS -- CMD. This matters when the calling shell is itself
rem      running inside a transport session managed by the daemon (Claude Code
rem      via imcodes, etc.). A synchronous restart from such a session would
rem      kill the daemon, which kills the session, which kills this script
rem      before the new daemon can come up. wscript runs hidden in its own
rem      process group, so the restart always completes.
rem
rem      NOTE: We use "imcodes restart" (the standalone command), NOT
rem      "imcodes service restart --no-build" like the .sh does. The latter
rem      explicitly rejects win32 with "Unsupported platform" -- it only
rem      knows launchctl/systemd. The standalone "imcodes restart" routes to
rem      ensureDaemonRunning() in src/util/windows-daemon.ts which does the
rem      proper Windows pidfile/watchdog dance.
rem
rem   For a heavier "install from local clone (npm install -g .) + bounce"
rem   that mirrors the production daemon.upgrade flow more closely (with
rem   upgrade.lock to pause the watchdog, NODE_OPTIONS save/restore, etc.),
rem   see ~/.imcodes/tmp/manual-upgrade.mjs.
rem
rem Usage:  scripts\restart-daemon.cmd
rem Logs:   %TEMP%\imcodes-restart-daemon.log
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

cd /d "%~dp0\.."

if not exist "package-lock.json" goto :install_fallback
set "LOCK_HASH="
for /f "usebackq delims=" %%H in (`node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('package-lock.json')).digest('hex')"`) do set "LOCK_HASH=%%H"
set "PREV_HASH="
if exist "node_modules\.restart-daemon-lock.sha256" set /p PREV_HASH=<"node_modules\.restart-daemon-lock.sha256"
if exist "node_modules" if defined LOCK_HASH if "!PREV_HASH!"=="!LOCK_HASH!" (
  echo [restart-daemon] dependencies unchanged; skipping npm ci
  goto :after_install
)
node -e "const fs=require('node:fs');try{if(fs.lstatSync('node_modules').isSymbolicLink())process.exit(0)}catch{}process.exit(1)"
if not errorlevel 1 (
  echo [restart-daemon] unlinking shared node_modules link before npm ci
  rmdir "node_modules"
  if errorlevel 1 (
    echo [restart-daemon] failed to unlink node_modules link
    exit /b 1
  )
  mkdir "node_modules" >nul 2>&1
)
echo [restart-daemon] npm ci
call npm ci
if errorlevel 1 (
  echo [restart-daemon] npm ci FAILED
  exit /b 1
)
if not exist "node_modules" mkdir "node_modules" >nul 2>&1
if defined LOCK_HASH > "node_modules\.restart-daemon-lock.sha256" echo !LOCK_HASH!
goto :after_install

:install_fallback
echo [restart-daemon] npm install
call npm install
if errorlevel 1 (
  echo [restart-daemon] npm install FAILED
  exit /b 1
)

:after_install
echo [restart-daemon] npm run build
call npm run build
if errorlevel 1 (
  echo [restart-daemon] build FAILED
  exit /b 1
)

echo [restart-daemon] npm link --force
call npm link --force
if errorlevel 1 (
  echo [restart-daemon] npm link FAILED
  exit /b 1
)

rem Build the detached restart artifacts.
rem Per-run tmp dir so concurrent restarts don't trample each other.
set "STAMP=%RANDOM%-%RANDOM%"
set "TMP_DIR=%TEMP%\imcodes-restart-daemon-%STAMP%"
mkdir "%TMP_DIR%" >nul 2>&1
set "RESTART_CMD=%TMP_DIR%\restart.cmd"
set "RESTART_VBS=%TMP_DIR%\restart.vbs"
set "LOG_FILE=%TEMP%\imcodes-restart-daemon.log"

rem Write the inner CMD line by line. Avoids the ()-block escaping pain.
rem Notes on escaping:
rem   - %% in the outer file becomes a literal % in the written file, then
rem     the inner cmd expands %date% / %time% at run time.
rem   - ^>, ^&, ^| are escaped so they pass through outer parsing and land
rem     literally in the file (the inner cmd then interprets them as
rem     redirect/pipe).
rem   - %LOG_FILE% / %TMP_DIR% expand at outer parse time so the inner cmd
rem     gets the absolute paths baked in (it has its own setlocal).
rem   - Sleeps use ping, not "timeout /t", because under wscript->cmd there
rem     is no console for stdin and timeout aborts immediately with
rem     "Input redirection is not supported".
> "%RESTART_CMD%" echo @echo off
>> "%RESTART_CMD%" echo chcp 65001 ^>nul 2^>^&1
>> "%RESTART_CMD%" echo setlocal
>> "%RESTART_CMD%" echo echo === detached restart at %%date%% %%time%% ^>^> "%LOG_FILE%"
>> "%RESTART_CMD%" echo ping -n 4 127.0.0.1 ^>nul 2^>^&1
>> "%RESTART_CMD%" echo call imcodes restart ^>^> "%LOG_FILE%" 2^>^&1
>> "%RESTART_CMD%" echo echo === detached restart done at %%date%% %%time%% ^>^> "%LOG_FILE%"
>> "%RESTART_CMD%" echo ping -n 61 127.0.0.1 ^>nul 2^>^&1
>> "%RESTART_CMD%" echo rmdir /s /q "%TMP_DIR%" ^>nul 2^>^&1
>> "%RESTART_CMD%" echo endlocal
>> "%RESTART_CMD%" echo exit /b 0

rem VBS wrapper: WshShell.Run with mode 0 (hidden) + False (no wait).
rem """ inside an echoed line passes through as literal """, which VBS then
rem parses as one " inside a string literal -- i.e. the file ends up with
rem WshShell.Run "<cmd-path>", 0, False
> "%RESTART_VBS%" echo On Error Resume Next
>> "%RESTART_VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%RESTART_VBS%" echo WshShell.Run """%RESTART_CMD%""", 0, False

echo [restart-daemon] Detaching restart; logs: %LOG_FILE%
start "" /b wscript "%RESTART_VBS%"
echo [restart-daemon] Restart dispatched. Daemon will come back on its own.

endlocal
exit /b 0
