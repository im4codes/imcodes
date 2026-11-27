cmake_minimum_required(VERSION 3.20)
project(imcodes_speech_linux LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(IMCODES_REQUIRE_ONNXRUNTIME "Fail configure if ONNX Runtime Linux SDK is missing" OFF)
if(NOT IMCODES_REQUIRE_ONNXRUNTIME AND DEFINED ENV{IMCODES_REQUIRE_ONNXRUNTIME} AND NOT "$ENV{IMCODES_REQUIRE_ONNXRUNTIME}" STREQUAL "")
  set(IMCODES_REQUIRE_ONNXRUNTIME ON)
endif()

if(NOT ONNXRUNTIME_DIR)
  if(DEFINED ENV{IMCODES_ONNXRUNTIME_LINUX_DIR} AND NOT "$ENV{IMCODES_ONNXRUNTIME_LINUX_DIR}" STREQUAL "")
    set(ONNXRUNTIME_DIR "$ENV{IMCODES_ONNXRUNTIME_LINUX_DIR}" CACHE PATH "Path to ONNX Runtime C++ SDK root" FORCE)
  elseif(DEFINED ENV{ONNXRUNTIME_DIR} AND NOT "$ENV{ONNXRUNTIME_DIR}" STREQUAL "")
    set(ONNXRUNTIME_DIR "$ENV{ONNXRUNTIME_DIR}" CACHE PATH "Path to ONNX Runtime C++ SDK root" FORCE)
  endif()
endif()

set(IMCODES_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(IMCODES_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(IMCODES_ORT_ENABLE_CUDA ON CACHE BOOL "" FORCE)

add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../onnx-qwen3-asr" "${CMAKE_CURRENT_BINARY_DIR}/onnx-qwen3-asr")

if((IMCODES_REQUIRE_ONNXRUNTIME OR ONNXRUNTIME_DIR) AND NOT IMCODES_ORT_FOUND)
  message(FATAL_ERROR "ONNX Runtime Linux SDK missing or incomplete under '${ONNXRUNTIME_DIR}'")
endif()

add_executable(imcodes-speech-linux imcodes-speech-linux.cpp)

target_include_directories(imcodes-speech-linux PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../common"
)

target_link_libraries(imcodes-speech-linux PRIVATE
  imcodes_qwen3_onnx_core
  ${CMAKE_DL_LIBS}
)

target_link_options(imcodes-speech-linux PRIVATE "-Wl,-rpath,$ORIGIN")
target_compile_options(imcodes-speech-linux PRIVATE -Wall -Wextra -Wpedantic)
