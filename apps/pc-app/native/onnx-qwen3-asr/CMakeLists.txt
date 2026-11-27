cmake_minimum_required(VERSION 3.16)
project(imcodes_qwen3_onnx LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(IMCODES_ORT_ENABLE_DML "Enable DirectML Execution Provider on Windows" OFF)
option(IMCODES_ORT_ENABLE_CUDA "Enable CUDA Execution Provider on Linux" OFF)
option(IMCODES_BUILD_TESTS "Build Qwen3-ASR ONNX unit tests" ON)
option(IMCODES_BUILD_CLI "Build Qwen3-ASR ONNX CLI benchmark/verification tool" ON)

set(ONNXRUNTIME_DIR "" CACHE PATH "Path to ONNX Runtime C++ SDK root")

add_library(imcodes_qwen3_onnx_core STATIC
  mel_features.cpp
  qwen3_tokenizer.cpp
  text_guards.cpp
  qwen3_onnx_engine.cpp
  ort_ep_dml.cpp
  streaming_pipeline.cpp
)

target_include_directories(imcodes_qwen3_onnx_core
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

if(MSVC)
  target_compile_options(imcodes_qwen3_onnx_core PRIVATE /W4 /utf-8)
else()
  target_compile_options(imcodes_qwen3_onnx_core PRIVATE -Wall -Wextra -Wpedantic)
endif()
if(WIN32)
  target_compile_definitions(imcodes_qwen3_onnx_core PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(imcodes_qwen3_onnx_core PUBLIC normaliz)
elseif(APPLE)
  target_compile_definitions(imcodes_qwen3_onnx_core PUBLIC IMCODES_USE_COREFOUNDATION=1)
  target_link_libraries(imcodes_qwen3_onnx_core PUBLIC "-framework CoreFoundation")
endif()

set(IMCODES_ORT_FOUND FALSE)
set(IMCODES_ORT_HAS_DML FALSE)
set(IMCODES_ORT_HAS_CUDA FALSE)
unset(IMCODES_ORT_INCLUDE_DIR CACHE)
unset(IMCODES_ORT_LIBRARY CACHE)
if(ONNXRUNTIME_DIR AND EXISTS "${ONNXRUNTIME_DIR}")
  find_path(IMCODES_ORT_INCLUDE_DIR
    NAMES onnxruntime_cxx_api.h
    PATHS
      "${ONNXRUNTIME_DIR}/include"
      "${ONNXRUNTIME_DIR}/include/onnxruntime"
      "${ONNXRUNTIME_DIR}/include/onnxruntime/core/session"
      "${ONNXRUNTIME_DIR}/build/native/include"
      "${ONNXRUNTIME_DIR}/buildTransitive/native/include"
    NO_DEFAULT_PATH
  )
  find_library(IMCODES_ORT_LIBRARY
    NAMES onnxruntime
    PATHS
      "${ONNXRUNTIME_DIR}/lib"
      "${ONNXRUNTIME_DIR}/lib64"
      "${ONNXRUNTIME_DIR}/build/native/lib/x64"
      "${ONNXRUNTIME_DIR}/build/native/lib/arm64"
      "${ONNXRUNTIME_DIR}/runtimes/win-x64/native"
      "${ONNXRUNTIME_DIR}/runtimes/win-arm64/native"
      "${ONNXRUNTIME_DIR}/runtimes/linux-x64/native"
      "${ONNXRUNTIME_DIR}/runtimes/osx-arm64/native"
    NO_DEFAULT_PATH
  )
  if(IMCODES_ORT_INCLUDE_DIR AND IMCODES_ORT_LIBRARY)
    set(IMCODES_ORT_FOUND TRUE)
    target_compile_definitions(imcodes_qwen3_onnx_core PUBLIC IMCODES_HAS_ONNXRUNTIME=1)
    target_include_directories(imcodes_qwen3_onnx_core PUBLIC "${IMCODES_ORT_INCLUDE_DIR}")
    target_link_libraries(imcodes_qwen3_onnx_core PUBLIC "${IMCODES_ORT_LIBRARY}")
    get_filename_component(IMCODES_ORT_LIB_DIR "${IMCODES_ORT_LIBRARY}" DIRECTORY)
    if(APPLE)
      target_link_options(imcodes_qwen3_onnx_core PUBLIC "-Wl,-rpath,${IMCODES_ORT_LIB_DIR}")
    elseif(UNIX)
      target_link_options(imcodes_qwen3_onnx_core PUBLIC "-Wl,-rpath,${IMCODES_ORT_LIB_DIR}")
    endif()
    if(WIN32 AND IMCODES_ORT_ENABLE_DML AND EXISTS "${IMCODES_ORT_INCLUDE_DIR}/dml_provider_factory.h")
      set(IMCODES_ORT_HAS_DML TRUE)
      target_compile_definitions(imcodes_qwen3_onnx_core PUBLIC IMCODES_ORT_HAS_DML=1)
    endif()
    if(UNIX AND NOT APPLE AND IMCODES_ORT_ENABLE_CUDA)
      set(IMCODES_ORT_HAS_CUDA TRUE)
      target_compile_definitions(imcodes_qwen3_onnx_core PUBLIC IMCODES_ORT_HAS_CUDA=1)
    endif()
  endif()
endif()

get_directory_property(_imcodes_has_parent PARENT_DIRECTORY)
if(_imcodes_has_parent)
  set(IMCODES_ORT_FOUND "${IMCODES_ORT_FOUND}" PARENT_SCOPE)
  set(IMCODES_ORT_HAS_DML "${IMCODES_ORT_HAS_DML}" PARENT_SCOPE)
  set(IMCODES_ORT_HAS_CUDA "${IMCODES_ORT_HAS_CUDA}" PARENT_SCOPE)
endif()

if(UNIX AND NOT APPLE)
  find_package(Threads REQUIRED)
  target_link_libraries(imcodes_qwen3_onnx_core PUBLIC Threads::Threads)
endif()

if(IMCODES_BUILD_TESTS)
  enable_testing()
  add_executable(qwen3_onnx_tests
    tests/qwen3_onnx_tests.cpp
  )
  target_link_libraries(qwen3_onnx_tests PRIVATE imcodes_qwen3_onnx_core)
  if(MSVC)
    target_compile_options(qwen3_onnx_tests PRIVATE /W4 /utf-8)
  else()
    target_compile_options(qwen3_onnx_tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME qwen3_onnx_tests COMMAND qwen3_onnx_tests)
endif()

if(IMCODES_BUILD_CLI)
  add_executable(qwen3_onnx_cli
    tools/qwen3_onnx_cli.cpp
  )
  target_link_libraries(qwen3_onnx_cli PRIVATE imcodes_qwen3_onnx_core)
  if(MSVC)
    target_compile_options(qwen3_onnx_cli PRIVATE /W4 /utf-8)
  else()
    target_compile_options(qwen3_onnx_cli PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endif()
