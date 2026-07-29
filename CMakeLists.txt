cmake_minimum_required(VERSION 3.15)
project(chromapakz LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Royalty-free VP9 via libvpx (BSD). pkg-config provides include/lib flags.
find_package(PkgConfig REQUIRED)
pkg_check_modules(VPX REQUIRED IMPORTED_TARGET vpx)
find_package(Threads REQUIRED)

# ── libvpx linkage ───────────────────────────────────────────────────────────────────────────
# We link libvpx *statically* and hide its symbols. Dynamically linking it leaves ~13 undefined
# vpx_* symbols in _core.so, and ELF resolves those against the global symbol scope in load
# order — so any other extension that has already published a different libvpx globally wins.
# decord does exactly that (`ctypes.CDLL(libdecord.so, ctypes.RTLD_GLOBAL)`), dragging its own
# bundled ffmpeg/libvpx into the global namespace; `import decord` before `import chromapakz`
# then binds our encoder to decord's libvpx and the ABI mismatch breaks encoding. Static linking
# plus hidden visibility removes both directions of that interference.
option(CHROMAPAKZ_STATIC_VPX "Link libvpx statically so its symbols cannot be interposed" ON)

set(_vpx_static "")
if(CHROMAPAKZ_STATIC_VPX)
  set(_saved_suffixes ${CMAKE_FIND_LIBRARY_SUFFIXES})
  set(CMAKE_FIND_LIBRARY_SUFFIXES ${CMAKE_STATIC_LIBRARY_SUFFIX})
  find_library(VPX_STATIC_LIBRARY NAMES vpx
               HINTS ${VPX_LIBDIR} ${VPX_LIBRARY_DIRS} ${VPX_STATIC_LIBRARY_DIRS})
  set(CMAKE_FIND_LIBRARY_SUFFIXES ${_saved_suffixes})
  if(VPX_STATIC_LIBRARY)
    # Some distros ship a non-PIC libvpx.a, which cannot go into a shared library. Probe before
    # committing, so a dev box with such a package still builds (the wheel path installs a PIC
    # build via scripts/install-libvpx.sh, and tests/py_symbol_isolation.py fails the build if a
    # released artifact ever ends up on the dynamic fallback).
    include(CheckCXXSourceCompiles)
    set(CMAKE_REQUIRED_INCLUDES ${VPX_INCLUDE_DIRS})
    set(CMAKE_REQUIRED_LIBRARIES ${VPX_STATIC_LIBRARY})
    set(CMAKE_REQUIRED_FLAGS "-fPIC -shared")
    check_cxx_source_compiles(
      "#include <vpx/vpx_encoder.h>\n#include <vpx/vp8cx.h>\n\
       extern \"C\" const void* probe(void){ return vpx_codec_vp9_cx(); }\n"
      VPX_STATIC_LINKS_INTO_SHARED)
    unset(CMAKE_REQUIRED_INCLUDES)
    unset(CMAKE_REQUIRED_LIBRARIES)
    unset(CMAKE_REQUIRED_FLAGS)
    if(VPX_STATIC_LINKS_INTO_SHARED)
      set(_vpx_static "${VPX_STATIC_LIBRARY}")
    else()
      message(WARNING
        "${VPX_STATIC_LIBRARY} cannot be linked into a shared library (most likely built without "
        "-fPIC); falling back to dynamic libvpx. See the CHROMAPAKZ_STATIC_VPX notes above — this "
        "build is vulnerable to libvpx symbol interposition.")
    endif()
  else()
    message(WARNING
      "No static libvpx (libvpx${CMAKE_STATIC_LIBRARY_SUFFIX}) found next to the pkg-config vpx "
      "module; falling back to dynamic linking. The resulting _core can be hijacked by another "
      "Python extension that loads its own libvpx with RTLD_GLOBAL (e.g. decord). Install a "
      "static libvpx, or configure with -DCHROMAPAKZ_STATIC_VPX=OFF to silence this.")
  endif()
endif()

add_library(chromapakz_vpx INTERFACE)
if(_vpx_static)
  target_include_directories(chromapakz_vpx SYSTEM INTERFACE ${VPX_INCLUDE_DIRS})
  target_link_libraries(chromapakz_vpx INTERFACE ${_vpx_static} Threads::Threads)
  if(NOT WIN32)
    target_link_libraries(chromapakz_vpx INTERFACE m)
  endif()
else()
  target_link_libraries(chromapakz_vpx INTERFACE PkgConfig::VPX)
endif()

# Native core shared library. Output named "_core" (no lib prefix) so the Python
# package's ctypes loader finds chromapakz/_core.{so,dylib}.
add_library(_core SHARED native/chromapakz.cpp)
set_target_properties(_core PROPERTIES
  PREFIX "" OUTPUT_NAME "_core"
  C_VISIBILITY_PRESET hidden
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON)
target_include_directories(_core PRIVATE native)
target_link_libraries(_core PRIVATE chromapakz_vpx)

# Keep the statically linked libvpx objects out of the dynamic symbol table. Our own sources are
# already hidden by the visibility presets above; archive members are compiled without them, so
# the linker has to strip them explicitly or _core would re-export vpx_* to the global namespace
# and become the source of the very conflict this guards against.
if(_vpx_static)
  if(APPLE)
    # ld64 honours globs in an exported-symbols list; everything unlisted becomes local.
    target_link_options(_core PRIVATE
      "-Wl,-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/native/exported_symbols.txt")
    set_property(TARGET _core APPEND PROPERTY LINK_DEPENDS
      "${CMAKE_CURRENT_SOURCE_DIR}/native/exported_symbols.txt")
  elseif(UNIX)
    target_link_options(_core PRIVATE "-Wl,--exclude-libs,ALL")
  endif()
endif()

# Command-line tool (dev/testing; not shipped in the Python wheel).
add_executable(dccli native/dccli.cpp native/chromapakz.cpp)
target_include_directories(dccli PRIVATE native)
target_link_libraries(dccli PRIVATE chromapakz_vpx)

# scikit-build-core installs the core lib into the wheel's package directory.
install(TARGETS _core LIBRARY DESTINATION chromapakz RUNTIME DESTINATION chromapakz)
