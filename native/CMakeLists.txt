cmake_minimum_required(VERSION 3.20)
project(webcad_kernel LANGUAGES CXX)

# Built only under Emscripten: the facade's whole purpose is to be the WASM
# boundary, and it links against an emscripten-built OCCT.
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake (see scripts/build-kernel.sh)")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# OCCT is built and installed by scripts/build-kernel.sh before this project is
# configured; OCCT_INSTALL_DIR points at that install tree.
if(NOT DEFINED OCCT_INSTALL_DIR)
  message(FATAL_ERROR "OCCT_INSTALL_DIR must be set")
endif()

# NO_CMAKE_FIND_ROOT_PATH is required: the Emscripten toolchain sets
# CMAKE_FIND_ROOT_PATH_MODE_PACKAGE to ONLY, which otherwise confines the search
# to the emscripten sysroot and hides this out-of-tree OCCT install.
find_package(OpenCASCADE REQUIRED CONFIG
  PATHS "${OCCT_INSTALL_DIR}/lib/cmake/opencascade" "${OCCT_INSTALL_DIR}"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH)

message(STATUS "OCCT ${OpenCASCADE_VERSION} from ${OpenCASCADE_DIR}")

add_executable(webcad_kernel
  src/registry.cpp
  src/kernel.cpp
  src/bindings.cpp)

target_include_directories(webcad_kernel PRIVATE
  "${OpenCASCADE_INCLUDE_DIR}")

# Only the toolkits MVP-0 needs. DataExchange (STEP) and Visualization are not
# linked at all - STEP arrives in MVP-2, and rendering happens in JS, not OCCT.
target_link_libraries(webcad_kernel PRIVATE
  TKMesh      # BRepMesh_IncrementalMesh
  TKBO        # BRepAlgoAPI_Fuse / _Cut / _Common
  TKPrim      # BRepPrimAPI_MakeBox / _MakeCylinder
  TKTopAlgo   # topology algorithms, BRepCheck
  TKGeomAlgo
  TKBRep
  TKGeomBase
  TKG3d
  TKG2d
  TKMath
  TKernel)

# Native WASM exceptions, required both here and when building OCCT: OCCT throws
# Standard_Failure, and the facade's status convention depends on catching it.
# Mixing exception models between the static libraries and this module would
# leave those throws uncatchable.
target_compile_options(webcad_kernel PRIVATE -fwasm-exceptions)

target_link_options(webcad_kernel PRIVATE
  -fwasm-exceptions
  -lembind
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,node
  # The kernel allocates freely as models grow. Note that growth detaches the
  # backing ArrayBuffer, which is why JS must never store a typed-array view.
  -sALLOW_MEMORY_GROWTH=1
  # Deliberately modest: a smaller initial heap keeps the first-load footprint
  # down, and it means growth is a path exercised in ordinary use rather than
  # one that only triggers on huge models. Since growth detaches the backing
  # ArrayBuffer and invalidates every typed-array view, that path being routine
  # is what keeps the never-store-a-view rule honest.
  -sINITIAL_MEMORY=16777216
  -sMAXIMUM_MEMORY=4294967296
  -sSTACK_SIZE=5242880
  # JS reads mesh data through these views over WASM memory.
  "-sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU32','HEAPU8']"
  -sALLOW_TABLE_GROWTH=1)

# Emit an ES module so the app and the node test runner load it the same way.
set_target_properties(webcad_kernel PROPERTIES
  SUFFIX ".mjs"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out")
