# Host (macOS/Linux) build of the shared R2T2 core + CLI against the pinned
# llama.cpp checkout. The iOS app links the official release xcframework and
# the Android app builds llama.cpp from the same checkout with the NDK; all
# three compile the same core/ sources.
cmake_minimum_required(VERSION 3.18)
project(r2t2_mobile_spike LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_LIST_DIR}/.cache/llama.cpp" CACHE PATH "pinned llama.cpp checkout")
if(NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp not found at ${LLAMA_CPP_DIR}; run scripts/fetch-deps.sh")
endif()

set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD ON CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(MTMD_VIDEO OFF CACHE BOOL "" FORCE)
add_subdirectory("${LLAMA_CPP_DIR}" llama_cpp EXCLUDE_FROM_ALL)

add_library(r2t2_core STATIC
    core/r2t2_engine.cpp
    core/r2t2_stream.cpp
    core/r2t2_text.cpp
    core/r2t2_metrics.cpp
    core/r2t2_harness.cpp)
target_include_directories(r2t2_core PUBLIC core "${LLAMA_CPP_DIR}/include" "${LLAMA_CPP_DIR}/tools/mtmd")
target_link_libraries(r2t2_core PUBLIC mtmd llama)

add_executable(r2t2-cli cli/r2t2_cli.cpp)
target_link_libraries(r2t2-cli PRIVATE r2t2_core)

add_executable(r2t2-text-test tests/text_test.cpp)
target_link_libraries(r2t2-text-test PRIVATE r2t2_core)
