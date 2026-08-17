@echo off
setlocal EnableExtensions
rem ============================================================================
rem  run-worker-policy-unittest.bat
rem
rem  Fast, isolated build + run of the worker_policy unit tests for the Windows
rem  remote-desktop worker.  This compiles worker_policy.cc and
rem  worker_policy_unittest.cc straight with cl against the vendored googletest,
rem  so it only needs Build Tools (vcvars64) and a libwebrtc checkout -- it does
rem  NOT run the full GN/Ninja build.  Use it for a quick signal on
rem  worker_policy changes.
rem
rem  The canonical, CI/qualification path is the full native build, which
rem  compiles and runs every rtc_test target in BUILD.gn:
rem
rem      build-worker.ps1 -RunNativeTests
rem
rem  Usage:
rem      run-worker-policy-unittest.bat [webRtcSrcRoot] [scratchDir]
rem
rem    webRtcSrcRoot   libwebrtc source root   (default: E:\imcodes-webrtc\src)
rem    scratchDir      obj/output directory    (default: E:\imcodes-staging\wpu_build)
rem
rem  worker_policy.cc / *_unittest.cc and googletest are expected under the
rem  libwebrtc root at third_party\imcodes_remote_desktop and
rem  third_party\googletest\src\googletest -- the same layout build-worker.ps1
rem  copies into the pinned checkout.
rem
rem  C++17 is required: worker_policy.h uses inline variables and nested
rem  namespaces, and the vendored googletest hard-errors on anything below
rem  C++17, so the cl line passes /std:c++17 explicitly.
rem ============================================================================

set "WEBRTC_SRC=%1"
if "%WEBRTC_SRC%"=="" set "WEBRTC_SRC=E:\imcodes-webrtc\src"
set "WORK_DIR=%2"
if "%WORK_DIR%"=="" set "WORK_DIR=E:\imcodes-staging\wpu_build"

set "GTEST=%WEBRTC_SRC%\third_party\googletest\src\googletest"
set "WORKER=%WEBRTC_SRC%\third_party\imcodes_remote_desktop"

call "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"
cd /d "%WORK_DIR%"

cl /nologo /std:c++17 /O2 /MT /DUNIT_TEST /DNOMINMAX /DWIN32_LEAN_AND_MEAN /I "%WEBRTC_SRC%" /I "%GTEST%\include" /I "%GTEST%" /Fewp_unittests.exe "%WORKER%\worker_policy.cc" "%WORKER%\worker_policy_unittest.cc" "%GTEST%\src\gtest-all.cc" "%GTEST%\src\gtest_main.cc" /link dxgi.lib wtsapi32.lib user32.lib gdi32.lib shell32.lib
set "COMPILE_EXIT=%errorlevel%"
echo COMPILE_EXIT=%COMPILE_EXIT%
if not "%COMPILE_EXIT%"=="0" (
  echo worker_policy unit test build FAILED (exit %COMPILE_EXIT%)
  exit /b %COMPILE_EXIT%
)

wp_unittests.exe
set "RUN_EXIT=%errorlevel%"
echo RUN_EXIT=%RUN_EXIT%
exit /b %RUN_EXIT%
