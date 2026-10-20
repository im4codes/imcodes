#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLTK_ROOT=""; JSONCPP_ROOT=""; ARTIFACT_ROOT=""; JOBS="${AIDESK_UI_JOBS:-2}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fltk-root) FLTK_ROOT="${2:-}"; shift 2 ;;
    --jsoncpp-root) JSONCPP_ROOT="${2:-}"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="${2:-}"; shift 2 ;;
    --jobs) JOBS="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$FLTK_ROOT/CMakeLists.txt" && -f "$JSONCPP_ROOT/include/json/json.h" && -n "$ARTIFACT_ROOT" ]] || {
  echo 'usage: build-ui.sh --fltk-root DIR --jsoncpp-root DIR --artifact-root DIR [--jobs N]' >&2; exit 2;
}
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aidesk-ui-build-XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
cmake -S "$SCRIPT_DIR" -B "$BUILD_ROOT" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DAIDESK_FLTK_ROOT="$FLTK_ROOT" -DAIDESK_JSONCPP_ROOT="$JSONCPP_ROOT"
cmake --build "$BUILD_ROOT" --target aidesk-local-ui aidesk-ui-unit-tests --parallel "$JOBS"
ctest --test-dir "$BUILD_ROOT" --output-on-failure
rm -rf "$ARTIFACT_ROOT"; mkdir -p "$ARTIFACT_ROOT"
if [[ -d "$BUILD_ROOT/aidesk-local-ui.app" ]]; then
  cp -R "$BUILD_ROOT/aidesk-local-ui.app" "$ARTIFACT_ROOT/"
else
  cp "$BUILD_ROOT/aidesk-local-ui" "$ARTIFACT_ROOT/"
fi
cp "$SCRIPT_DIR/FLTK-LICENSE.txt" "$ARTIFACT_ROOT/"
echo "aidesk-ui=$ARTIFACT_ROOT"
