cmake_minimum_required(VERSION 3.25)
project(heron_independent_codec VERSION 1.0.0 LANGUAGES C)
# Run node build.mjs once to verify lock and extract exact dev/runtime payloads.
# No find_package, global codec lookup, image all-features, or GPL optional codec.
add_executable(heron-codec codec.c)
target_compile_features(heron-codec PRIVATE c_std_11)
target_compile_options(heron-codec PRIVATE -O2 -Wall -Wextra -Wno-misleading-indentation -Wno-sign-compare -fstack-protector-strong)
target_compile_definitions(heron-codec PRIVATE _FORTIFY_SOURCE=2)
target_include_directories(heron-codec PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/构建头文件/usr/include" "${CMAKE_CURRENT_SOURCE_DIR}/构建头文件/usr/include/x86_64-linux-gnu")
foreach(lib IN ITEMS libpng16.so.16 libjpeg.so.62 libwebp.so.7)
  target_link_libraries(heron-codec PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/运行时/lib/${lib}")
endforeach()
target_link_libraries(heron-codec PRIVATE m)
target_link_options(heron-codec PRIVATE -Wl,-z,relro,-z,now)
set_target_properties(heron-codec PROPERTIES BUILD_RPATH "${CMAKE_CURRENT_SOURCE_DIR}/运行时/lib")
# CMake output is a build artifact; normalize all final deliverables to 0600.
