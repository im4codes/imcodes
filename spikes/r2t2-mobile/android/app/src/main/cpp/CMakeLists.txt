# JNI library for the Android harness: pinned llama.cpp (mtmd on) + shared core.
cmake_minimum_required(VERSION 3.22.1)
project(r2t2_harness C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp not found at ${LLAMA_CPP_DIR}; run spikes/r2t2-mobile/scripts/fetch-deps.sh")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)   # one .so for the app
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD ON CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(MTMD_VIDEO OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)
set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
option(R2T2_VULKAN "Build ggml-vulkan" OFF)
set(GGML_VULKAN ${R2T2_VULKAN} CACHE BOOL "" FORCE)
add_subdirectory("${LLAMA_CPP_DIR}" llama_cpp EXCLUDE_FROM_ALL)

add_library(r2t2_harness SHARED
    r2t2_jni.cpp
    ${R2T2_CORE_DIR}/r2t2_engine.cpp
    ${R2T2_CORE_DIR}/r2t2_stream.cpp
    ${R2T2_CORE_DIR}/r2t2_text.cpp
    ${R2T2_CORE_DIR}/r2t2_metrics.cpp
    ${R2T2_CORE_DIR}/r2t2_harness.cpp)
target_include_directories(r2t2_harness PRIVATE ${R2T2_CORE_DIR} "${LLAMA_CPP_DIR}/include" "${LLAMA_CPP_DIR}/tools/mtmd")
target_link_libraries(r2t2_harness PRIVATE mtmd llama log android)
