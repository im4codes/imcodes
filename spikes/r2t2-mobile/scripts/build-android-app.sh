#!/usr/bin/env bash
# Build the Android harness APK (arm64-v8a, CPU; add VULKAN=1 for ggml-vulkan).
#   scripts/build-android-app.sh            # -> android/app/build/outputs/apk/debug/app-debug.apk
#   scripts/build-android-app.sh --install  # also `adb install -r` to the connected phone
source "$(dirname "$0")/common.sh"
[ -d "$LLAMA_DIR/.git" ] && [ -f "$CACHE_DIR/kleidiai/CMakeLists.txt" ] || "$SPIKE_DIR/scripts/fetch-deps.sh"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@17 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home   # AGP 8.13 needs JDK 17+
fi
cd "$SPIKE_DIR/android"
[ -f local.properties ] || echo "sdk.dir=$SDK" > local.properties
vk=(); [ "${VULKAN:-0}" = 1 ] && vk=(-Pr2t2.vulkan=1)
./gradlew --no-daemon --max-workers="$JOBS" ${vk[@]+"${vk[@]}"} assembleDebug
apk="$SPIKE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
echo "built: $apk"
if [ "${1:-}" = "--install" ]; then "$SDK/platform-tools/adb" install -r "$apk"; fi
