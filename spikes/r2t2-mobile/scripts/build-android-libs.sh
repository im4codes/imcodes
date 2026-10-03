#!/usr/bin/env bash
# Android NDK arm64-v8a build of pinned llama.cpp (LLAMA_BUILD_MTMD=ON) plus the
# shared core and an `r2t2-cli` that runs directly in `adb shell`.
#
#   scripts/build-android-libs.sh              # CPU (NEON dotprod/fp16 + KleidiAI)
#   VULKAN=1 scripts/build-android-libs.sh     # + ggml-vulkan (optional)
#
# Output: .cache/android-libs/arm64-v8a/{lib,bin,include}
source "$(dirname "$0")/common.sh"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK="${ANDROID_NDK_HOME:-$SDK/ndk/$ANDROID_NDK_VERSION}"
[ -f "$NDK/build/cmake/android.toolchain.cmake" ] || {
  echo "NDK $ANDROID_NDK_VERSION not found at $NDK." >&2
  echo "Install: sdkmanager --sdk_root=\"$SDK\" \"ndk;$ANDROID_NDK_VERSION\"" >&2; exit 1; }
[ -d "$LLAMA_DIR/.git" ] && [ -f "$CACHE_DIR/kleidiai/CMakeLists.txt" ] || "$SPIKE_DIR/scripts/fetch-deps.sh"
variant=cpu; extra=()
if [ "${VULKAN:-0}" = 1 ]; then
  variant=vulkan
  glslc=$(ls "$NDK"/shader-tools/*/glslc | head -1)
  extra+=(-DGGML_VULKAN=ON -DVulkan_GLSLC_EXECUTABLE="$glslc")
fi
build="$CACHE_DIR/build-android-$variant"
prefix="$CACHE_DIR/android-libs/arm64-v8a${VULKAN:+-vulkan}"
cmake -S "$SPIKE_DIR" -B "$build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_INSTALL_RPATH='$ORIGIN/../lib' -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 -DGGML_CPU_KLEIDIAI=ON -DGGML_OPENMP=OFF \
  -DFETCHCONTENT_SOURCE_DIR_KLEIDIAI="$CACHE_DIR/kleidiai" -DLLAMA_CPP_DIR="$LLAMA_DIR" ${extra[@]+"${extra[@]}"}
cmake --build "$build" -j "$JOBS" --target r2t2-cli r2t2-text-test
rm -rf "$prefix" && mkdir -p "$prefix/lib" "$prefix/bin" "$prefix/include"
find "$build" -name "*.so" -exec cp {} "$prefix/lib/" \;
cp "$build/r2t2-cli" "$build/r2t2-text-test" "$prefix/bin/"
cp "$LLAMA_DIR/include/llama.h" "$LLAMA_DIR/tools/mtmd/mtmd.h" "$LLAMA_DIR/tools/mtmd/mtmd-helper.h" "$LLAMA_DIR"/ggml/include/*.h "$prefix/include/"
"$NDK/toolchains/llvm/prebuilt/"*/bin/llvm-readelf -d "$prefix/bin/r2t2-cli" | grep -E "NEEDED|RUNPATH"
ls -la "$prefix/lib" "$prefix/bin"
cat <<MSG
Run on a device without the app:
  adb push $prefix /data/local/tmp/r2t2
  adb push $MODEL_GGUF $MMPROJ_GGUF $SPIKE_DIR/samples/zh_upstream_test.wav /data/local/tmp/r2t2/
  adb shell 'cd /data/local/tmp/r2t2 && LD_LIBRARY_PATH=lib ./bin/r2t2-cli --model $R2T2_MODEL_FILE --mmproj $R2T2_MMPROJ_FILE \\
      --wav zh_upstream_test.wav --mode both --language Chinese --threads 4 --cpu --json run.json'
MSG
