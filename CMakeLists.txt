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

# Native core shared library. Output named "_core" (no lib prefix) so the Python
# package's ctypes loader finds chromapakz/_core.{so,dylib}.
add_library(_core SHARED native/depthcodec.cpp)
set_target_properties(_core PROPERTIES PREFIX "" OUTPUT_NAME "_core")
target_include_directories(_core PRIVATE native)
target_link_libraries(_core PRIVATE PkgConfig::VPX)

# Command-line tool (dev/testing; not shipped in the Python wheel).
add_executable(dccli native/dccli.cpp native/depthcodec.cpp)
target_include_directories(dccli PRIVATE native)
target_link_libraries(dccli PRIVATE PkgConfig::VPX)

# scikit-build-core installs the core lib into the wheel's package directory.
install(TARGETS _core LIBRARY DESTINATION chromapakz RUNTIME DESTINATION chromapakz)
