#!/usr/bin/env bash
# ONE real-display experiment, once per boot, fail-closed at every step.
#
# This script is NOT run by CI and must not be run casually. Each failed
# teardown on macOS 26.x strands a display until logout, so the whole design
# here is about making it impossible to strand a SECOND one while investigating
# the first.
#
# Ten guards, each present because a specific way of fooling ourselves was
# identified in review:
#   1. Tri-source baseline (SLS registered/active, CG online/main/mirror/bounds,
#      NSScreen). Any aiDesk remnant, or any disagreement between the three,
#      aborts before anything is created.
#   2. --probe-only never creates.
#   3. The display id comes ONLY from the helper's authenticated reply plus the
#      tri-source delta. Never grepped, never guessed.
#   4. Before any mutation: re-verify the target is not a baseline physical
#      display, not main, identity-matched, and that the last-surface guard
#      allows it.
#   5. At most ONE activation and ONE create. No companion, no second identity,
#      no automatic retry.
#   6. Activation is the real SLWindowMirroringManager extend: path.
#   7. First frame and logical input are verified with a bounded wait.
#   8. Teardown targets the same object/cookie/id, once, and is confirmed by all
#      three enumerators within 5s. registered-inactive counts as FAILURE and
#      sets reboot_required.
#   9. A trap plus an explicit state machine guarantees that once any step
#      fails, nothing further is created.
#  10. A per-boot stamp prevents a second experiment on the same boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER_BINARY=""
PROBE_ONLY=false
EXPERIMENT_ID=""
STATE="init"
CREATED_DISPLAY_ID=""
REBOOT_REQUIRED=false
WORK_DIR=""

BOOT_ID="$(sysctl -n kern.boottime 2>/dev/null | tr -cd '0-9')"
STAMP_DIR="${TMPDIR:-/tmp}/aidesk-virtual-display-experiment"
STAMP_FILE="$STAMP_DIR/boot-$BOOT_ID.stamp"

fail() { echo "EXPERIMENT_FAIL: $*" >&2; STATE="failed"; exit 1; }

# GUARD 9: whatever happens, we never create after a failure, and we always say
# whether a reboot is owed.
on_exit() {
  local status=$?
  if [[ -n "$CREATED_DISPLAY_ID" && "$STATE" != "torn_down" ]]; then
    REBOOT_REQUIRED=true
  fi
  echo "EXPERIMENT_STATE=$STATE created_display_id=${CREATED_DISPLAY_ID:-none} reboot_required=$REBOOT_REQUIRED"
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
  exit "$status"
}
trap on_exit EXIT
trap 'fail "interrupted"' INT TERM

usage() {
  cat <<'USAGE'
Usage: macos-remote-desktop-virtual-display-experiment.sh --helper <path> [--probe-only]

  --helper <path>   Signed resident virtual-display helper to drive.
  --probe-only      Enumerate and report only. Creates nothing. Always safe.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --helper) HELPER_BINARY="${2:-}"; shift 2 ;;
    --probe-only) PROBE_ONLY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument $1" ;;
  esac
done

[[ -n "$HELPER_BINARY" && -x "$HELPER_BINARY" ]] || fail "--helper must name an executable"
[[ "$(uname -s)" == "Darwin" ]] || fail "macOS only"
[[ "$(id -u)" != "0" ]] || fail "must not run as root: a root process has no Aqua session"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aidesk-vd-experiment-XXXXXX")"

# GUARD 1: the tri-source enumerator. Read-only; creates nothing.
ENUMERATOR="$WORK_DIR/enumerate"
cat > "$WORK_DIR/enumerate.m" <<'ENUM'
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
int main(void) { @autoreleasepool {
  void* sl = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
  if (!sl) { fprintf(stderr, "no_skylight\n"); return 2; }
  int (*GetList)(uint32_t, CGDirectDisplayID*, uint32_t*) = dlsym(sl, "SLSGetDisplayList");
  int (*GetOnline)(uint32_t, CGDirectDisplayID*, uint32_t*) = dlsym(sl, "SLSGetOnlineDisplayList");
  if (!GetList || !GetOnline) { fprintf(stderr, "no_symbols\n"); return 2; }
  uint32_t n = 0; CGDirectDisplayID ids[64];
  if (GetList(64, ids, &n) != 0) { fprintf(stderr, "sls_failed\n"); return 2; }
  uint32_t m = 0; CGDirectDisplayID online[64];
  GetOnline(64, online, &m);
  uint32_t c = 0; CGDirectDisplayID cg[64];
  CGGetOnlineDisplayList(64, cg, &c);
  const CGDirectDisplayID main_id = CGMainDisplayID();
  NSUInteger screens = [[NSScreen screens] count];
  printf("nsscreen_count=%lu cg_online_count=%u sls_registered_count=%u sls_online_count=%u main=%u\n",
         (unsigned long)screens, c, n, m, main_id);
  for (uint32_t i = 0; i < n; i++) {
    CGDirectDisplayID d = ids[i];
    int in_cg = 0; for (uint32_t j = 0; j < c; j++) if (cg[j] == d) in_cg = 1;
    int in_sls_online = 0; for (uint32_t j = 0; j < m; j++) if (online[j] == d) in_sls_online = 1;
    CGRect b = CGDisplayBounds(d);
    printf("display id=%u vendor=0x%x model=0x%x sls_online=%d cg_online=%d main=%d mirror_of=%u "
           "io_port=%d bounds=%.0fx%.0f@%.0f,%.0f\n",
           d, CGDisplayVendorNumber(d), CGDisplayModelNumber(d), in_sls_online, in_cg,
           d == main_id ? 1 : 0, CGDisplayMirrorsDisplay(d),
           CGDisplayIOServicePort(d) == 0 ? 0 : 1, b.size.width, b.size.height, b.origin.x, b.origin.y);
  }
  return 0; } }
ENUM
xcrun clang -fobjc-arc -Wno-deprecated-declarations -framework AppKit -framework CoreGraphics \
  "$WORK_DIR/enumerate.m" -o "$ENUMERATOR" >/dev/null 2>&1 || fail "could not build the read-only enumerator"

snapshot() { "$ENUMERATOR" || fail "enumeration failed"; }

AIDESK_VENDOR="0x4149"
AIDESK_MODEL="0x4445"

BASELINE="$WORK_DIR/baseline.txt"
snapshot > "$BASELINE"
echo "--- BASELINE ---"; cat "$BASELINE"

# GUARD 1 (cont): any aiDesk remnant means the machine is already dirty. A
# stranded display holds our vendor/product/serial triple, so a new create would
# collide anyway -- and if it somehow succeeded we would be leaking a second one.
if grep -q "vendor=$AIDESK_VENDOR model=$AIDESK_MODEL" "$BASELINE"; then
  REBOOT_REQUIRED=true
  fail "aiDesk display already registered; reboot before experimenting"
fi
# GUARD 1 (cont): the three enumerators must agree about how many displays are
# online. Disagreement means the topology is in a state none of our reasoning
# covers, and proceeding would make the result uninterpretable either way.
NS_COUNT="$(sed -n 's/.*nsscreen_count=\([0-9]*\).*/\1/p' "$BASELINE")"
CG_COUNT="$(sed -n 's/.*cg_online_count=\([0-9]*\).*/\1/p' "$BASELINE")"
SLS_ONLINE="$(sed -n 's/.*sls_online_count=\([0-9]*\).*/\1/p' "$BASELINE")"
[[ "$NS_COUNT" == "$CG_COUNT" && "$CG_COUNT" == "$SLS_ONLINE" ]] \
  || fail "enumerators disagree (NSScreen=$NS_COUNT CG=$CG_COUNT SLS=$SLS_ONLINE)"
[[ "$CG_COUNT" -ge 1 ]] || fail "no baseline display; refusing to experiment headless"
STATE="baseline_clean"

# GUARD 2: probe-only stops here, having created nothing.
if $PROBE_ONLY; then
  "$HELPER_BINARY" --imcodes-virtual-display-probe || fail "helper probe failed"
  STATE="probe_only_complete"
  echo "PROBE_ONLY_OK: nothing was created"
  exit 0
fi

# GUARD 10: one experiment per boot. A second run on the same boot would be
# reasoning against a topology the first run already perturbed.
mkdir -p "$STAMP_DIR"
if [[ -e "$STAMP_FILE" ]]; then
  fail "an experiment already ran on this boot ($STAMP_FILE); reboot first"
fi
: > "$STAMP_FILE"
STATE="stamped"

# GUARD 3: identity and authentication material come from the host, and the
# display id will come from the helper's authenticated reply -- never from
# grepping the enumeration for something that looks new.
EXPERIMENT_ID="$(uuidgen)"
EPOCH="$(od -An -N8 -tu8 /dev/urandom | tr -d ' \n')"
COOKIE_SEED="$(od -An -N8 -tu8 /dev/urandom | tr -d ' \n')"
GENERATION=1
[[ -n "$EPOCH" && "$EPOCH" != "0" ]] || fail "could not generate an unpredictable epoch"
echo "EXPERIMENT_ID=$EXPERIMENT_ID epoch=<redacted> generation=$GENERATION"

cat <<'MANUAL'

STOP. The remaining steps mutate the real display topology.

They are deliberately NOT automated. Run them one at a time, reading the
enumeration between each, and abort at the first surprise:

  A. Launch the helper with the binding on fd 3 (epoch/cookie/uid/generation/
     release). It must NOT be able to bind itself from the first frame.
  B. Send exactly ONE `hold`. Take the display id from the REPLY, and confirm it
     against the tri-source delta from the baseline. If the reply id and the
     delta disagree, stop: one of them is lying and neither may be trusted.
  C. GUARD 4 -- before any mutation re-verify, against the live enumeration:
       * the id is NOT in the baseline set (not a physical display),
       * it is not main,
       * vendor/model match the aiDesk identity exactly,
       * last-surface still allows a later removal:
         cg_online_count - already_disconnecting - 1 >= 1.
  D. GUARD 6 -- activate through the real SLWindowMirroringManager extend: path
     only. An origin or mirror change is NOT activation and must not be reported
     as one.
  E. GUARD 7 -- verify first frame and one logical input event, each with a
     bounded wait. No frame within the bound is a failure, not a retry.
  F. GUARD 8 -- ONE teardown attempt, against the same object/cookie/id.
     Confirm with SLS + CG + NSScreen for up to 5 seconds.
       * absent in all three            -> removed
       * registered-inactive anywhere   -> FAILURE, reboot_required=true
     Do not attempt a second teardown and do NOT create a companion: the paired
     workaround was measured to strand BOTH displays on this OS.
  G. GUARD 5 -- if anything above failed, stop. Do not create a second display,
     do not mint a second identity, do not retry. Record the outcome and reboot.

  Ordering note: test the signed-helper CG + extend + runloop release path
  FIRST. Only if it fails, AND no second display was created, may the
  SLVirtualDisplay -destroy path be tried against the SAME object. A failure is
  never a reason to create another display.

MANUAL

STATE="manual_handoff"
echo "MANUAL_STEPS_REQUIRED: nothing was created by this script"
