cmake_minimum_required(VERSION 3.20)
cmake_policy(SET CMP0091 NEW)
project(aidesk_local_ui_windows LANGUAGES CXX RC)

# aidesk-local-ui.exe: the local management panel as aiDesk's own Windows window (WebView2). Built with the fixed WebView2 SDK
# (webview2.lock.json, fetched and sha256-verified by scripts/fetch-webview2-sdk.mjs) and the static loader: nothing is downloaded
# when it runs, and no WebView2Loader.dll ships next to it.
#
#   node scripts/fetch-webview2-sdk.mjs --out build/webview2          -> prints {"root": "..."}
#   node scripts/aidesk-icon.mjs ico build/aidesk.ico
#   cmake -S native/aidesk-panel-host-windows -B build/host -DAIDESK_WEBVIEW2_ROOT=<root> -DAIDESK_ICON=<abs>/aidesk.ico
#   cmake --build build/host --config Release

if(NOT WIN32)
  message(FATAL_ERROR "aidesk-local-ui (WebView2 host) builds for Windows only")
endif()

set(AIDESK_WEBVIEW2_ROOT "" CACHE PATH "Extracted Microsoft.Web.WebView2 package root")
set(AIDESK_WEBVIEW2_ARCH "x64" CACHE STRING "WebView2 loader architecture directory (x64 or arm64)")
set(AIDESK_ICON "" CACHE FILEPATH "Application icon (.ico)")
if(NOT AIDESK_WEBVIEW2_ROOT OR NOT EXISTS "${AIDESK_WEBVIEW2_ROOT}/build/native/include/WebView2.h")
  message(FATAL_ERROR "AIDESK_WEBVIEW2_ROOT must point at the extracted WebView2 SDK (node scripts/fetch-webview2-sdk.mjs)")
endif()
if(NOT AIDESK_ICON OR NOT EXISTS "${AIDESK_ICON}")
  message(FATAL_ERROR "AIDESK_ICON must point at the .ico built by scripts/aidesk-icon.mjs ico")
endif()
set(AIDESK_WEBVIEW2_LOADER "${AIDESK_WEBVIEW2_ROOT}/build/native/${AIDESK_WEBVIEW2_ARCH}/WebView2LoaderStatic.lib")
if(NOT EXISTS "${AIDESK_WEBVIEW2_LOADER}")
  message(FATAL_ERROR "missing static WebView2 loader: ${AIDESK_WEBVIEW2_LOADER}")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# The static C runtime: the executable runs on a machine without the Visual C++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

file(TO_CMAKE_PATH "${AIDESK_ICON}" AIDESK_ICON_FOR_RC)
file(TO_CMAKE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/panel_host.manifest" AIDESK_MANIFEST_FOR_RC)
configure_file(panel_host.rc.in "${CMAKE_CURRENT_BINARY_DIR}/panel_host.rc" @ONLY)

add_executable(aidesk-local-ui WIN32 panel_host.cc "${CMAKE_CURRENT_BINARY_DIR}/panel_host.rc")
target_include_directories(aidesk-local-ui PRIVATE "${AIDESK_WEBVIEW2_ROOT}/build/native/include")
target_compile_definitions(aidesk-local-ui PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(aidesk-local-ui PRIVATE "${AIDESK_WEBVIEW2_LOADER}" user32 ole32 shell32 shlwapi advapi32 version)
if(MSVC)
  target_compile_options(aidesk-local-ui PRIVATE /W4 /WX /utf-8 /guard:cf)
  target_link_options(aidesk-local-ui PRIVATE /MANIFEST:NO /SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT /guard:cf)
else()
  target_compile_options(aidesk-local-ui PRIVATE -Wall -Wextra -municode)
  target_link_options(aidesk-local-ui PRIVATE -municode -static)
endif()
