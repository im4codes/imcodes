#!/usr/bin/env bash
# Build mobile apps for iOS and/or Android.
# Usage:
#   ./scripts/build-mobile.sh ios      # build + open Xcode
#   ./scripts/build-mobile.sh android  # build + open Android Studio
#   ./scripts/build-mobile.sh all      # both platforms

set -euo pipefail

PLATFORM="${1:-all}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"

log() { echo "[build-mobile] $*"; }
err() { echo "[build-mobile] ERROR: $*" >&2; exit 1; }

check_dep() {
  command -v "$1" &>/dev/null || err "$1 is required but not installed. $2"
}

build_web() {
  log "Building web assets..."
  cd "$WEB_DIR"
  npm run build
  log "Web build complete → dist/"
}

sync_capacitor() {
  log "Syncing Capacitor..."
  cd "$WEB_DIR"
  npx cap sync "$1"
}

build_ios() {
  check_dep xcodebuild "Install Xcode from the Mac App Store."
  check_dep xcrun "Xcode Command Line Tools required."

  log "Building iOS..."
  build_web
  sync_capacitor ios

  # Build for simulator
  xcodebuild \
    -workspace "$WEB_DIR/ios/App/App.xcworkspace" \
    -scheme App \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=iPhone 15 Pro" \
    -derivedDataPath "$WEB_DIR/ios/build" \
    build 2>&1 | tail -30

  log "iOS build complete."
  log "To run in simulator: npx cap run ios"
  log "To open Xcode: npx cap open ios"
}

build_android() {
  check_dep java "Install JDK 17+: https://adoptium.net/"

  if [[ -z "${ANDROID_HOME:-}" ]]; then
    # Try common locations
    if [[ -d "$HOME/Library/Android/sdk" ]]; then
      export ANDROID_HOME="$HOME/Library/Android/sdk"
    elif [[ -d "$HOME/Android/Sdk" ]]; then
      export ANDROID_HOME="$HOME/Android/Sdk"
    else
      err "ANDROID_HOME not set. Install Android Studio and set ANDROID_HOME."
    fi
  fi

  log "Building Android (ANDROID_HOME=$ANDROID_HOME)..."
  build_web
  sync_capacitor android

  cd "$WEB_DIR/android"
  ./gradlew assembleDebug 2>&1 | tail -30

  APK_PATH="$WEB_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
  if [[ -f "$APK_PATH" ]]; then
    log "Android build complete: $APK_PATH"
    log "To install on connected device: adb install $APK_PATH"
    log "To open Android Studio: npx cap open android"
  else
    err "APK not found at expected path: $APK_PATH"
  fi
}

case "$PLATFORM" in
  ios)    build_ios ;;
  android) build_android ;;
  all)
    build_web
    sync_capacitor ios 2>/dev/null || log "Skipping iOS sync (Xcode not available)"
    sync_capacitor android 2>/dev/null || log "Skipping Android sync (Android SDK not available)"
    log "Sync complete. Run './scripts/build-mobile.sh ios' or './scripts/build-mobile.sh android' to build."
    ;;
  *)
    echo "Usage: $0 ios|android|all" >&2
    exit 1
    ;;
esac
