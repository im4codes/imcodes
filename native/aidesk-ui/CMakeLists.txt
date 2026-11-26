cmake_minimum_required(VERSION 3.21)
project(aidesk_native_ui LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(AIDESK_FLTK_ROOT "" CACHE PATH "Pinned FLTK 1.4.5 source root")
set(AIDESK_JSONCPP_ROOT "" CACHE PATH "Pinned jsoncpp source root")
if(NOT EXISTS "${AIDESK_FLTK_ROOT}/CMakeLists.txt")
  message(FATAL_ERROR "AIDESK_FLTK_ROOT must point at pinned FLTK 1.4.5 source")
endif()
if(NOT EXISTS "${AIDESK_JSONCPP_ROOT}/include/json/json.h")
  message(FATAL_ERROR "AIDESK_JSONCPP_ROOT must point at pinned jsoncpp source")
endif()

set(FLTK_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_FLUID OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_FORMS OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_GL OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_FLTK_OPTIONS OFF CACHE BOOL "" FORCE)
set(OPTION_USE_SYSTEM_LIBJPEG ON CACHE BOOL "" FORCE)
set(OPTION_USE_SYSTEM_LIBPNG ON CACHE BOOL "" FORCE)
set(OPTION_USE_SYSTEM_ZLIB ON CACHE BOOL "" FORCE)
add_subdirectory("${AIDESK_FLTK_ROOT}" fltk EXCLUDE_FROM_ALL)

file(GLOB JSONCPP_SOURCES CONFIGURE_DEPENDS "${AIDESK_JSONCPP_ROOT}/src/lib_json/*.cpp")
add_library(aidesk_jsoncpp STATIC ${JSONCPP_SOURCES})
target_include_directories(aidesk_jsoncpp PUBLIC "${AIDESK_JSONCPP_ROOT}/include")
target_compile_definitions(aidesk_jsoncpp PRIVATE JSON_USE_EXCEPTION=0)

set(REPOSITORY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../..")
set(COMMON_ROOT "${REPOSITORY_ROOT}/native/remote-desktop-common")
set(AIDESK_UI_SOURCES
  aidesk_ui.cc
  aidesk_ui_strings.cc
  local_management_session.cc
  "${COMMON_ROOT}/json_protocol.cc"
  "${COMMON_ROOT}/local_management_ipc.cc"
)
if(APPLE)
  list(APPEND AIDESK_UI_SOURCES accessibility_bridge_macos.mm)
elseif(WIN32)
  list(APPEND AIDESK_UI_SOURCES accessibility_bridge_windows.cc)
else()
  list(APPEND AIDESK_UI_SOURCES accessibility_bridge_linux.cc)
endif()

add_library(aidesk_ui_lib STATIC ${AIDESK_UI_SOURCES})
target_include_directories(aidesk_ui_lib PRIVATE "${COMMON_ROOT}")
target_link_libraries(aidesk_ui_lib PUBLIC fltk aidesk_jsoncpp)
if(APPLE)
  set_source_files_properties(accessibility_bridge_macos.mm PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
  target_link_libraries(aidesk_ui_lib PUBLIC "-framework AppKit" "-framework Foundation")
elseif(WIN32)
  target_link_libraries(aidesk_ui_lib PUBLIC oleacc user32 shell32 comctl32)
else()
  find_package(Threads REQUIRED)
  target_link_libraries(aidesk_ui_lib PUBLIC Threads::Threads)
endif()

add_executable(aidesk-local-ui WIN32 MACOSX_BUNDLE aidesk_ui_main.cc)
target_link_libraries(aidesk-local-ui PRIVATE aidesk_ui_lib)
set_target_properties(aidesk-local-ui PROPERTIES
  OUTPUT_NAME "aidesk-local-ui"
  MACOSX_BUNDLE_BUNDLE_NAME "aiDesk.to by IM.codes"
  MACOSX_BUNDLE_GUI_IDENTIFIER "to.aidesk.app.local-ui"
)

add_executable(aidesk-ui-unit-tests aidesk_ui_unit_test.cc)
target_link_libraries(aidesk-ui-unit-tests PRIVATE aidesk_ui_lib)
if(MINGW)
  target_link_options(aidesk-local-ui PRIVATE -static -static-libgcc -static-libstdc++)
  target_link_options(aidesk-ui-unit-tests PRIVATE -static -static-libgcc -static-libstdc++)
endif()
enable_testing()
add_test(NAME aidesk-ui-unit-tests COMMAND aidesk-ui-unit-tests)
