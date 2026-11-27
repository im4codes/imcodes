cmake_minimum_required(VERSION 3.20)
project(imcodes_speech_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

add_executable(imcodes-speech-win imcodes-speech-win.cpp)

target_compile_definitions(imcodes-speech-win PRIVATE
  UNICODE
  _UNICODE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
)

option(IMCODES_REQUIRE_SHERPA_ONNX "Fail configure if sherpa-onnx C API SDK is missing" OFF)
if(NOT IMCODES_REQUIRE_SHERPA_ONNX AND DEFINED ENV{IMCODES_REQUIRE_SHERPA_ONNX} AND NOT "$ENV{IMCODES_REQUIRE_SHERPA_ONNX}" STREQUAL "")
  set(IMCODES_REQUIRE_SHERPA_ONNX ON)
endif()

set(SHERPA_ONNX_DIR "" CACHE PATH "Path to prebuilt sherpa-onnx Windows SDK directory")
if(NOT SHERPA_ONNX_DIR AND DEFINED ENV{SHERPA_ONNX_DIR})
  set(SHERPA_ONNX_DIR "$ENV{SHERPA_ONNX_DIR}")
endif()

# Always re-resolve the import library against the active SHERPA_ONNX_DIR so switching
# SDK directories in a reused build tree cannot link a cached library from a prior SDK.
unset(SHERPA_ONNX_C_API_LIB CACHE)

if(SHERPA_ONNX_DIR AND EXISTS "${SHERPA_ONNX_DIR}/include/sherpa-onnx/c-api/c-api.h")
  target_compile_definitions(imcodes-speech-win PRIVATE IMCODES_HAS_SHERPA_ONNX=1)
  target_include_directories(imcodes-speech-win PRIVATE "${SHERPA_ONNX_DIR}/include")
  find_library(SHERPA_ONNX_C_API_LIB
    NAMES sherpa-onnx-c-api
    PATHS "${SHERPA_ONNX_DIR}/lib"
    NO_DEFAULT_PATH
  )
  if(NOT SHERPA_ONNX_C_API_LIB)
    message(FATAL_ERROR "sherpa-onnx-c-api library not found under ${SHERPA_ONNX_DIR}/lib")
  endif()
  target_link_libraries(imcodes-speech-win PRIVATE "${SHERPA_ONNX_C_API_LIB}")
elseif(IMCODES_REQUIRE_SHERPA_ONNX OR SHERPA_ONNX_DIR)
  message(FATAL_ERROR "SHERPA_ONNX_DIR ('${SHERPA_ONNX_DIR}') missing include/sherpa-onnx/c-api/c-api.h")
else()
  message(WARNING "SHERPA_ONNX_DIR not set; building stub without embedded sherpa-onnx ASR")
endif()

target_link_libraries(imcodes-speech-win PRIVATE
  dxgi
  ole32
  mmdevapi
  avrt
  user32
  advapi32
  normaliz
)

if(MSVC)
  target_compile_options(imcodes-speech-win PRIVATE /W4 /utf-8 /EHsc)
endif()
