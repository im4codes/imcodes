cmake_minimum_required(VERSION 3.20)
project(imcodes_speech_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

option(IMCODES_REQUIRE_ONNXRUNTIME "Fail configure if ONNX Runtime DirectML SDK is missing" OFF)
if(NOT IMCODES_REQUIRE_ONNXRUNTIME AND DEFINED ENV{IMCODES_REQUIRE_ONNXRUNTIME} AND NOT "$ENV{IMCODES_REQUIRE_ONNXRUNTIME}" STREQUAL "")
  set(IMCODES_REQUIRE_ONNXRUNTIME ON)
endif()

if(NOT ONNXRUNTIME_DIR)
  if(DEFINED ENV{IMCODES_ONNXRUNTIME_WIN_DIR} AND NOT "$ENV{IMCODES_ONNXRUNTIME_WIN_DIR}" STREQUAL "")
    set(ONNXRUNTIME_DIR "$ENV{IMCODES_ONNXRUNTIME_WIN_DIR}" CACHE PATH "Path to ONNX Runtime C++ SDK root" FORCE)
  elseif(DEFINED ENV{ONNXRUNTIME_DIR} AND NOT "$ENV{ONNXRUNTIME_DIR}" STREQUAL "")
    set(ONNXRUNTIME_DIR "$ENV{ONNXRUNTIME_DIR}" CACHE PATH "Path to ONNX Runtime C++ SDK root" FORCE)
  endif()
endif()

set(IMCODES_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(IMCODES_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(IMCODES_ORT_ENABLE_DML ON CACHE BOOL "" FORCE)

add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../onnx-qwen3-asr" "${CMAKE_CURRENT_BINARY_DIR}/onnx-qwen3-asr")

if((IMCODES_REQUIRE_ONNXRUNTIME OR ONNXRUNTIME_DIR) AND NOT IMCODES_ORT_FOUND)
  message(FATAL_ERROR "ONNX Runtime Windows SDK missing or incomplete under '${ONNXRUNTIME_DIR}'")
endif()

if(WIN32 AND IMCODES_REQUIRE_ONNXRUNTIME AND NOT IMCODES_ORT_HAS_DML)
  message(FATAL_ERROR "ONNX Runtime Windows DirectML header (dml_provider_factory.h) missing under '${ONNXRUNTIME_DIR}'")
endif()

add_executable(imcodes-speech-win imcodes-speech-win.cpp)

target_include_directories(imcodes-speech-win PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../common"
)

target_compile_definitions(imcodes-speech-win PRIVATE
  UNICODE
  _UNICODE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
)

target_link_libraries(imcodes-speech-win PRIVATE
  imcodes_qwen3_onnx_core
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
