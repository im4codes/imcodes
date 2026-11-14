import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  extractArchiveToDir,
  parseDaemonRuntimeTarget,
} from './daemon-runtime-artifacts.mjs';
import { normalizeNodeExeBuildVersion, sha256File } from './node-exe-artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

let cachedCompatModule;
export async function loadDesktopCompatibilityModule() {
  if (cachedCompatModule) return cachedCompatModule;
  const distPath = join(REPO_ROOT, 'dist', 'shared', 'desktop-installer-compatibility.js');
  if (existsSync(distPath)) {
    cachedCompatModule = await import(distPath);
    return cachedCompatModule;
  }
  // When running under tsx/vitest, importing .ts directly succeeds.
  try {
    cachedCompatModule = await import('../shared/desktop-installer-compatibility.js');
    return cachedCompatModule;
  } catch (err) {
    throw new Error(
      `Desktop compatibility module not built at ${distPath}. Run "npm run build" first (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

export function resolveDesktopInstallerVersion(explicitVersion) {
  if (explicitVersion && String(explicitVersion).trim()) {
    return normalizeNodeExeBuildVersion(String(explicitVersion).trim());
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return normalizeNodeExeBuildVersion(String(pkg.version ?? '0.1.2'));
}

export function toDebianVersion(version) {
  // Debian versions must start with a digit and allow [A-Za-z0-9.+~-]
  const cleaned = String(version).replace(/[^A-Za-z0-9.+~-]/gu, '-');
  return /^[0-9]/u.test(cleaned) ? cleaned : `0.0.0-${cleaned}`;
}

export async function writeDesktopInstallerManifest(artifactPath, details) {
  const absArtifact = resolve(artifactPath);
  const sha256 = await sha256File(absArtifact);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...details,
    artifact: {
      filename: absArtifact.split(/[/\\]/u).pop(),
      size: readFileSync(absArtifact).length,
      sha256,
    },
  };
  const manifestPath = `${absArtifact}.manifest.json`;
  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, manifestPath);
  return { manifestPath, manifest };
}

/**
 * Copy or unpack a Phase 1 `daemon-runtime` directory/archive into `destReleaseDir`.
 * Refuses symlinks inside staged release trees to match Phase 1 bundle invariants.
 */
export function stageDaemonRuntimePayload({
  runtimeDir,
  runtimeArchive,
  target,
  destReleaseDir,
}) {
  const targetInfo = parseDaemonRuntimeTarget(target);
  const outDir = resolve(destReleaseDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  if (runtimeDir) {
    const absRuntime = resolve(runtimeDir);
    const currentSubdir = join(absRuntime, 'current');
    const sourceDir = existsSync(join(currentSubdir, targetInfo.nodeRelativePath))
      ? currentSubdir
      : absRuntime;
    if (!existsSync(join(sourceDir, targetInfo.nodeRelativePath))) {
      throw new Error(`daemon-runtime missing ${targetInfo.nodeRelativePath} in ${sourceDir}`);
    }
    cpSync(sourceDir, outDir, { recursive: true, dereference: false });
  } else if (runtimeArchive) {
    extractArchiveToDir(resolve(runtimeArchive), outDir, targetInfo);
  } else {
    throw new Error('Either --runtime-dir or --runtime-archive is required');
  }

  if (targetInfo.os !== 'win32') {
    const nodeBin = join(outDir, targetInfo.nodeRelativePath);
    if (existsSync(nodeBin)) chmodSync(nodeBin, 0o755);
  }
  return outDir;
}

export function renderLinuxControlledNodeSystemdUnit(stateRoot = '/var/lib/imcodes-node') {
  return `[Unit]
Description=IM.codes controlled node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${stateRoot}/imcodes-node
NotifyAccess=all
WatchdogSec=180
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

export function renderLinuxUserDaemonSystemdTemplate(
  runtimeRoot = '/opt/imcodes/daemon-runtime',
) {
  const nodeBin = `${runtimeRoot}/current/bin/node`;
  const entry = `${runtimeRoot}/current/package/dist/src/index.js`;
  return `[Unit]
Description=IM.codes Coding Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${entry} start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function renderLinuxAideskDesktopFile(execPath = '/var/lib/imcodes-node/imcodes-node') {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=aiDesk.to by IM.codes
Comment=aiDesk.to by IM.codes
Exec="${execPath}" --open-local-panel
Icon=aidesk
Terminal=false
Categories=Network;RemoteAccess;
StartupNotify=true
StartupWMClass=aidesk-local-ui
X-IMCodes-Managed=true
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderMacosControlledNodeLaunchDaemonPlist(
  label = 'cc.imcodes.node',
  executablePath = '/Library/Application Support/imcodes-node/imcodes-node',
  args = [],
) {
  const argLines = [executablePath, ...args].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/var/log/imcodes-node.err.log</string>
  <key>StandardOutPath</key>
  <string>/var/log/imcodes-node.out.log</string>
</dict>
</plist>
`;
}

export function renderMacosControlledNodeWatchdogLaunchDaemonPlist(
  label = 'cc.imcodes.node.watchdog',
  executablePath = '/Library/Application Support/imcodes-node/imcodes-node',
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
    <string>--health-watchdog</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>/var/log/imcodes-node-watchdog.err.log</string>
  <key>StandardOutPath</key>
  <string>/var/log/imcodes-node-watchdog.out.log</string>
</dict>
</plist>
`;
}

/**
 * Shared POSIX Phase A probe / install / rollback shell script used identically by:
 * - Linux `.deb` preinst/postinst
 * - Linux offline self-extracting `.sh`
 * - macOS `.pkg` preinstall/postinstall
 *
 * When full `package/dist/src/node/desktop-installer-probe.js` is bundled inside the
 * staged release, it calls our TypeScript probe+planner directly for exact parity; otherwise
 * it applies the exact same 5-scenario POSIX decision rules natively.
 */
export function renderPosixPhaseARunnerScript({
  platform,
  version,
  cliWrapperContent,
  minVersion = '',
}) {
  const isDarwin = platform === 'darwin';
  const defaultStateRoot = isDarwin
    ? '/Library/Application Support/imcodes-node'
    : '/var/lib/imcodes-node';
  const defaultRuntimeRoot = isDarwin
    ? '/Library/Application Support/imcodes/daemon-runtime'
    : '/opt/imcodes/daemon-runtime';
  const defaultCliPath = '/usr/local/bin/imcodes';
  const defaultDesktopPath = isDarwin
    ? '/Applications/aiDesk.to by IM.codes.app'
    : '/usr/share/applications/aidesk.desktop';

  const wrapperB64 = Buffer.from(cliWrapperContent, 'utf8').toString('base64');

  return `#!/bin/sh
set -eu

PHASE="postinstall"
ISOLATED_ROOT="\${IMCODES_ISOLATED_ROOT:-}"
TARGET_HOME="\${IMCODES_INSTALLER_HOME:-}"
MIN_VERSION="\${IMCODES_MIN_RUNTIME_VERSION:-${minVersion}}"
FORCE_TAKEOVER=0
CONFIRM_FDA_SWITCH=0
APPLY_SERVICES=1
APPLY_SERVICES_EXPLICIT=0
ALLOW_SYSTEM_ROOT=0
DRY_RUN=0
ROLLBACK_DIR=""
SNAPSHOT_DIR=""
STAGE_ARCHIVE=""
PROBE_RUNTIME_DIR=""
INSTALLER_VERSION=${JSON.stringify(version)}
PLATFORM=${JSON.stringify(platform)}
WRAPPER_B64=${JSON.stringify(wrapperB64)}
REAL_CALLER_HOME="\${HOME:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --isolated-root) ISOLATED_ROOT="$2"; shift 2 ;;
    --home) TARGET_HOME="$2"; shift 2 ;;
    --min-version) MIN_VERSION="$2"; shift 2 ;;
    --snapshot-dir) SNAPSHOT_DIR="$2"; shift 2 ;;
    --rollback)
      PHASE="rollback"
      case "\${2:-}" in
        ""|-*) ROLLBACK_DIR=""; shift ;;
        *) ROLLBACK_DIR="$2"; shift 2 ;;
      esac
      ;;
    --stage-archive) STAGE_ARCHIVE="$2"; shift 2 ;;
    --probe-runtime-dir) PROBE_RUNTIME_DIR="$2"; shift 2 ;;
    --force-takeover) FORCE_TAKEOVER=1; shift ;;
    --confirm-fda-switch) CONFIRM_FDA_SWITCH=1; shift ;;
    --no-service-control) APPLY_SERVICES=0; shift ;;
    --apply-services) APPLY_SERVICES=1; APPLY_SERVICES_EXPLICIT=1; shift ;;
    --allow-system-root) ALLOW_SYSTEM_ROOT=1; shift ;;
    --check|--dry-run) DRY_RUN=1; APPLY_SERVICES=0; shift ;;
    --version) printf '%s\\n' "$INSTALLER_VERSION"; exit 0 ;;
    *) shift ;;
  esac
done

normalize_lexical_posix() {
  raw="$1"
  case "$raw" in
    /*) abs=1 ;;
    *) raw="$(pwd -P)/$raw"; abs=1 ;;
  esac
  old_ifs="$IFS"
  IFS="/"
  set -- $raw
  IFS="$old_ifs"
  out=""
  for seg in "$@"; do
    case "$seg" in
      ""|".") continue ;;
      "..")
        case "$out" in
          "") ;;
          */*) out="\${out%/*}" ;;
          *) out="" ;;
        esac
        ;;
      *) out="$out/$seg" ;;
    esac
  done
  [ -n "$out" ] && printf '%s\\n' "$out" || printf '/\\n'
}

canonicalize_posix_path() {
  p="$(normalize_lexical_posix "$1")"
  hops=0
  while [ "$hops" -lt 32 ]; do
    if [ -L "$p" ]; then
      hops=$((hops + 1))
      link_t="$(readlink "$p" 2>/dev/null || true)"
      [ -n "$link_t" ] || { echo "Refusing unresolvable symlink target: $p" >&2; exit 2; }
      case "$link_t" in
        /*) p="$(normalize_lexical_posix "$link_t")" ;;
        *) p="$(normalize_lexical_posix "$(dirname -- "$p")/$link_t")" ;;
      esac
      continue
    fi
    break
  done
  if [ -L "$p" ] && [ "$hops" -ge 32 ]; then
    echo "Refusing symlink loop resolving path: $1" >&2
    exit 2
  fi
  cur="$p"
  tail_segs=""
  while [ "$cur" != "/" ] && [ ! -e "$cur" ] && [ ! -L "$cur" ]; do
    seg="$(basename -- "$cur")"
    if [ -n "$tail_segs" ]; then
      tail_segs="$seg/$tail_segs"
    else
      tail_segs="$seg"
    fi
    cur="$(dirname -- "$cur")"
  done
  if [ -L "$cur" ]; then
    lt="$(readlink "$cur" 2>/dev/null || true)"
    [ -n "$lt" ] || { echo "Refusing unresolvable symlink target: $cur" >&2; exit 2; }
    case "$lt" in
      /*) resolved_cur="$(canonicalize_posix_path "$lt")" ;;
      *) resolved_cur="$(canonicalize_posix_path "$(dirname -- "$cur")/$lt")" ;;
    esac
  elif [ -d "$cur" ]; then
    resolved_cur="$(cd "$cur" 2>/dev/null && pwd -P)" || { echo "Refusing unreadable directory during canonicalization: $cur" >&2; exit 2; }
  elif [ -e "$cur" ]; then
    c_dir="$(dirname -- "$cur")"
    c_base="$(basename -- "$cur")"
    c_real_dir="$(cd "$c_dir" 2>/dev/null && pwd -P)" || { echo "Refusing unreadable parent directory during canonicalization: $c_dir" >&2; exit 2; }
    resolved_cur="$c_real_dir/$c_base"
  else
    resolved_cur="$cur"
  fi
  if [ -n "$tail_segs" ]; then
    case "$resolved_cur" in
      /) normalize_lexical_posix "/$tail_segs" ;;
      *) normalize_lexical_posix "$resolved_cur/$tail_segs" ;;
    esac
  else
    normalize_lexical_posix "$resolved_cur"
  fi
}

is_same_or_child_path() {
  cand="$1"
  parent="$2"
  [ -n "$parent" ] || return 1
  [ "$cand" = "$parent" ] && return 0
  case "$parent" in
    /) case "$cand" in /*) return 0 ;; *) return 1 ;; esac ;;
    *) case "$cand" in "$parent"/*) return 0 ;; *) return 1 ;; esac ;;
  esac
}

resolve_real_user_home() {
  if [ "$PLATFORM" = "darwin" ] && [ "$(id -u)" -eq 0 ]; then
    cu="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
    if [ -n "$cu" ] && [ "$cu" != "root" ] && [ "$cu" != "loginwindow" ]; then
      dscl_home="$(dscl . -read "/Users/$cu" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
      if [ -n "$dscl_home" ] && [ -d "$dscl_home" ]; then
        printf '%s\\n' "$dscl_home"
        return 0
      fi
    fi
  elif [ -n "\${SUDO_USER:-}" ] && [ "\${SUDO_USER}" != "root" ]; then
    sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
    if [ -n "$sudo_home" ] && [ -d "$sudo_home" ]; then
      printf '%s\\n' "$sudo_home"
      return 0
    fi
  fi
  printf '%s\\n' "\${REAL_CALLER_HOME:-/tmp}"
}

REAL_HOME_BASE="$(resolve_real_user_home)"

if [ -n "$ISOLATED_ROOT" ]; then
  if [ "$ALLOW_SYSTEM_ROOT" -eq 1 ]; then
    echo "Refusing --allow-system-root when --isolated-root is active" >&2
    exit 2
  fi
  if [ "$APPLY_SERVICES_EXPLICIT" -eq 0 ]; then
    APPLY_SERVICES=0
  fi
  if [ -z "$TARGET_HOME" ]; then
    TARGET_HOME="$ISOLATED_ROOT/home"
  fi
  EFF_HOME="$TARGET_HOME"
elif [ -n "$TARGET_HOME" ]; then
  EFF_HOME="$TARGET_HOME"
else
  EFF_HOME="$REAL_HOME_BASE"
fi

canonicalize_entry_posix_path() {
  lex="$(normalize_lexical_posix "$1")"
  parent_canon="$(canonicalize_posix_path "$(dirname -- "$lex")")"
  base="$(basename -- "$lex")"
  if [ "$lex" = "/" ]; then
    printf '/\n'
  elif [ "$parent_canon" = "/" ]; then
    printf '/%s\n' "$base"
  else
    normalize_lexical_posix "$parent_canon/$base"
  fi
}

assert_safe_isolated_target() {
  raw_target="$1"
  mode="\${2:-container}"
  if [ "$mode" = "entry" ]; then
    canon_target="$(canonicalize_entry_posix_path "$raw_target")"
  else
    canon_target="$(canonicalize_posix_path "$raw_target")"
  fi
  for bad in \
    "/var/lib/imcodes-node" \
    "/opt/imcodes" \
    "/Library/Application Support/imcodes-node" \
    "/Library/Application Support/imcodes" \
    "/etc/systemd/system" \
    "/Library/LaunchDaemons" \
    "/Applications/aiDesk.to by IM.codes.app" \
    "/usr/local/bin/imcodes"
  do
    if is_same_or_child_path "$canon_target" "$bad"; then
      echo "Refusing unsafe isolated target inside system directory: $raw_target ($canon_target)" >&2
      exit 2
    fi
  done
  if [ -n "$REAL_HOME_BASE" ]; then
    canon_real_home="$(canonicalize_posix_path "$REAL_HOME_BASE")"
    if [ "$canon_target" = "$canon_real_home" ]; then
      echo "Refusing unsafe isolated target equal to real home: $raw_target" >&2
      exit 2
    fi
    for bad_sub in ".imcodes" ".config/systemd" ".local/share/applications" "Library/LaunchAgents"; do
      if is_same_or_child_path "$canon_target" "$canon_real_home/$bad_sub"; then
        echo "Refusing unsafe isolated target inside real home subdir: $raw_target ($canon_target)" >&2
        exit 2
      fi
    done
  fi
  if [ -n "$ISOLATED_ROOT" ]; then
    canon_iso="$(canonicalize_posix_path "$ISOLATED_ROOT")"
    canon_eff="$(canonicalize_posix_path "\${EFF_HOME:-$ISOLATED_ROOT/home}")"
    if ! is_same_or_child_path "$canon_target" "$canon_iso" && ! is_same_or_child_path "$canon_target" "$canon_eff"; then
      echo "Refusing isolated target escaping isolated root ($canon_iso) and isolated home ($canon_eff): $raw_target ($canon_target)" >&2
      exit 2
    fi
  fi
}

assert_within_base() {
  raw_target="$1"
  raw_base="$2"
  mode="\${3:-container}"
  if [ "$mode" = "entry" ]; then
    canon_target="$(canonicalize_entry_posix_path "$raw_target")"
  else
    canon_target="$(canonicalize_posix_path "$raw_target")"
  fi
  canon_base="$(canonicalize_posix_path "$raw_base")"
  if ! is_same_or_child_path "$canon_target" "$canon_base"; then
    echo "Refusing target escaping expected base ($canon_base): $raw_target ($canon_target)" >&2
    exit 2
  fi
}

if [ -n "$ISOLATED_ROOT" ]; then
  assert_safe_isolated_target "$ISOLATED_ROOT"
  assert_safe_isolated_target "$EFF_HOME"
  NODE_ROOT="$ISOLATED_ROOT/controlled-node"
  RUNTIME_ROOT="$ISOLATED_ROOT/daemon-runtime"
  CLI_PATH="$ISOLATED_ROOT/bin/imcodes"
  if [ "$PLATFORM" = "darwin" ]; then
    NODE_SERVICE_PATH="$NODE_ROOT/cc.imcodes.node.plist"
    NODE_WATCHDOG_SERVICE_PATH="$NODE_ROOT/cc.imcodes.node.watchdog.plist"
    DESKTOP_PATH="$ISOLATED_ROOT/Applications/aiDesk.to by IM.codes.app"
  else
    NODE_SERVICE_PATH="$NODE_ROOT/imcodes-node.service"
    NODE_WATCHDOG_SERVICE_PATH=""
    DESKTOP_PATH="$EFF_HOME/.local/share/applications/aidesk.desktop"
  fi
  if [ -z "$SNAPSHOT_DIR" ]; then
    SNAPSHOT_DIR="$ISOLATED_ROOT/rollback-snapshot"
  fi
else
  NODE_ROOT=${JSON.stringify(defaultStateRoot)}
  RUNTIME_ROOT=${JSON.stringify(defaultRuntimeRoot)}
  CLI_PATH=${JSON.stringify(defaultCliPath)}
  DESKTOP_PATH=${JSON.stringify(defaultDesktopPath)}
  if [ "$PLATFORM" = "darwin" ]; then
    NODE_SERVICE_PATH="/Library/LaunchDaemons/cc.imcodes.node.plist"
    NODE_WATCHDOG_SERVICE_PATH="/Library/LaunchDaemons/cc.imcodes.node.watchdog.plist"
  else
    NODE_SERVICE_PATH="/etc/systemd/system/imcodes-node.service"
    NODE_WATCHDOG_SERVICE_PATH=""
  fi
  if [ -z "$SNAPSHOT_DIR" ]; then
    SNAPSHOT_DIR="$NODE_ROOT/installer-rollback-$INSTALLER_VERSION"
  fi
fi

USER_STATE_DIR="$EFF_HOME/.imcodes"
if [ "$PLATFORM" = "darwin" ]; then
  AUTOSTART_PATH="$EFF_HOME/Library/LaunchAgents/imcodes.daemon.plist"
  USER_WANTS_LINK=""
else
  AUTOSTART_PATH="$EFF_HOME/.config/systemd/user/imcodes.service"
  USER_WANTS_LINK="$EFF_HOME/.config/systemd/user/default.target.wants/imcodes.service"
fi
RELEASE_DIR="$RUNTIME_ROOT/releases/$INSTALLER_VERSION"
CURRENT_LINK="$RUNTIME_ROOT/current"

if [ -n "$ISOLATED_ROOT" ]; then
  for check_p in "$NODE_ROOT" "$RUNTIME_ROOT" "$SNAPSHOT_DIR" "$RELEASE_DIR"; do
    [ -n "$check_p" ] && assert_safe_isolated_target "$check_p" container && assert_within_base "$check_p" "$ISOLATED_ROOT" container
  done
  for check_e in "$CLI_PATH" "$NODE_SERVICE_PATH" "$NODE_WATCHDOG_SERVICE_PATH" "$CURRENT_LINK"; do
    [ -n "$check_e" ] && assert_safe_isolated_target "$check_e" entry && assert_within_base "$check_e" "$ISOLATED_ROOT" entry
  done
  assert_safe_isolated_target "$USER_STATE_DIR" container && assert_within_base "$USER_STATE_DIR" "$EFF_HOME" container
  assert_safe_isolated_target "$AUTOSTART_PATH" entry && assert_within_base "$AUTOSTART_PATH" "$EFF_HOME" entry
  [ -n "$USER_WANTS_LINK" ] && assert_safe_isolated_target "$USER_WANTS_LINK" entry && assert_within_base "$USER_WANTS_LINK" "$EFF_HOME" entry
  if [ "$PLATFORM" = "darwin" ]; then
    assert_safe_isolated_target "$DESKTOP_PATH" entry && assert_within_base "$DESKTOP_PATH" "$ISOLATED_ROOT" entry
  else
    assert_safe_isolated_target "$DESKTOP_PATH" entry && assert_within_base "$DESKTOP_PATH" "$EFF_HOME" entry
  fi
  [ -n "$ROLLBACK_DIR" ] && assert_safe_isolated_target "$ROLLBACK_DIR" container && assert_within_base "$ROLLBACK_DIR" "$ISOLATED_ROOT" container
fi

can_control_posix_services() {
  if [ "$PLATFORM" = "linux" ]; then
    [ -z "$ISOLATED_ROOT" ] || [ -n "\${IMCODES_SYSTEMCTL_BIN:-}" ]
    return $?
  elif [ "$PLATFORM" = "darwin" ]; then
    [ -z "$ISOLATED_ROOT" ] || [ -n "\${IMCODES_LAUNCHCTL_BIN:-}" ]
    return $?
  fi
  return 1
}

run_systemctl_sys() {
  sys_bin="\${IMCODES_SYSTEMCTL_BIN:-}"
  if [ -n "$ISOLATED_ROOT" ] && [ -z "$sys_bin" ]; then
    return 1
  fi
  [ -n "$sys_bin" ] || sys_bin="systemctl"
  command -v "$sys_bin" >/dev/null 2>&1 || return 1
  "$sys_bin" "$@"
}

resolve_target_unix_user() {
  if [ -n "\${SUDO_USER:-}" ] && [ "\${SUDO_USER}" != "root" ]; then
    printf '%s\\n' "$SUDO_USER"
    return 0
  fi
  if [ "$PLATFORM" = "darwin" ]; then
    cu="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
    if [ -n "$cu" ] && [ "$cu" != "root" ] && [ "$cu" != "loginwindow" ]; then
      printf '%s\\n' "$cu"
      return 0
    fi
  fi
  if [ -d "$EFF_HOME" ]; then
    owner="$(stat -c '%U' "$EFF_HOME" 2>/dev/null || stat -f '%Su' "$EFF_HOME" 2>/dev/null || true)"
    if [ -n "$owner" ] && [ "$owner" != "root" ]; then
      printf '%s\\n' "$owner"
      return 0
    fi
  fi
  id -un 2>/dev/null || printf '%s\\n' "\${USER:-root}"
}

run_systemctl_user() {
  sys_bin="\${IMCODES_SYSTEMCTL_BIN:-}"
  if [ -n "$ISOLATED_ROOT" ] && [ -z "$sys_bin" ]; then
    return 1
  fi
  [ -n "$sys_bin" ] || sys_bin="systemctl"
  command -v "$sys_bin" >/dev/null 2>&1 || return 1
  t_user="$(resolve_target_unix_user)"
  t_uid="$(id -u "$t_user" 2>/dev/null || id -u)"
  xrd="/run/user/$t_uid"
  if [ "$(id -u)" -eq 0 ] && [ "$t_user" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$t_user" -- env HOME="$EFF_HOME" XDG_RUNTIME_DIR="$xrd" "$sys_bin" --user "$@"
      return $?
    elif command -v su >/dev/null 2>&1; then
      export IMCODES_SU_HOME="$EFF_HOME" IMCODES_SU_XRD="$xrd" IMCODES_SU_BIN="$sys_bin"
      su -s /bin/sh "$t_user" -c 'HOME="$IMCODES_SU_HOME" XDG_RUNTIME_DIR="$IMCODES_SU_XRD" "$IMCODES_SU_BIN" --user "$@"' sh "$@"
      return $?
    fi
  fi
  HOME="$EFF_HOME" "$sys_bin" --user "$@"
}

run_launchctl() {
  lctl_bin="\${IMCODES_LAUNCHCTL_BIN:-}"
  if [ -n "$ISOLATED_ROOT" ] && [ -z "$lctl_bin" ]; then
    return 1
  fi
  [ -n "$lctl_bin" ] || lctl_bin="launchctl"
  command -v "$lctl_bin" >/dev/null 2>&1 || return 1
  "$lctl_bin" "$@"
}

hash_file_sha256() {
  f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$f" | awk '{print $NF}'
  else
    cksum "$f" | awk '{print $1 ":" $2}'
  fi
}

is_git_checkout_path() {
  target="$1"
  [ -n "$target" ] || return 1
  real="$(canonicalize_posix_path "$target")"
  dir="$(dirname -- "$real" 2>/dev/null || printf '%s' "$real")"
  i=0
  while [ "$i" -lt 12 ]; do
    if [ -e "$dir/.git" ]; then
      return 0
    fi
    parent="$(dirname -- "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
    i=$((i + 1))
  done
  return 1
}

compare_semver() {
  v1="\${1#v}"
  v2="\${2#v}"
  v1="\${v1%%-*}"
  v2="\${v2%%-*}"
  a1="$(printf '%s' "$v1" | cut -d. -f1)"; a2="$(printf '%s' "$v1" | cut -d. -f2)"; a3="$(printf '%s' "$v1" | cut -d. -f3)"
  b1="$(printf '%s' "$v2" | cut -d. -f1)"; b2="$(printf '%s' "$v2" | cut -d. -f2)"; b3="$(printf '%s' "$v2" | cut -d. -f3)"
  a1="\${a1:-0}"; a2="\${a2:-0}"; a3="\${a3:-0}"
  b1="\${b1:-0}"; b2="\${b2:-0}"; b3="\${b3:-0}"
  case "$a1$a2$a3$b1$b2$b3" in *[!0-9]*) return 0 ;; esac
  if [ "$a1" -lt "$b1" ]; then echo -1; return 0; fi
  if [ "$a1" -gt "$b1" ]; then echo 1; return 0; fi
  if [ "$a2" -lt "$b2" ]; then echo -1; return 0; fi
  if [ "$a2" -gt "$b2" ]; then echo 1; return 0; fi
  if [ "$a3" -lt "$b3" ]; then echo -1; return 0; fi
  if [ "$a3" -gt "$b3" ]; then echo 1; return 0; fi
  echo 0
}

find_pkg_version_near() {
  d="$(dirname -- "$(canonicalize_posix_path "$1")")"
  i=0
  while [ "$i" -lt 6 ]; do
    if [ -f "$d/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"imcodes"' "$d/package.json" 2>/dev/null; then
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$d/package.json" | head -n 1
      return 0
    fi
    parent="$(dirname -- "$d")"
    [ "$parent" = "$d" ] && break
    d="$parent"
    i=$((i + 1))
  done
  return 1
}

read_snap_env_val() {
  env_file="$1"
  env_key="$2"
  [ -f "$env_file" ] || return 0
  grep "^$env_key=" "$env_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

probe_launchd_service_state() {
  lbl="$1"
  L_LOADED=0
  L_ACTIVE=0
  [ -n "$lbl" ] || return 0
  if can_control_posix_services; then
    p_rc=0
    p_out="$(run_launchctl print "$lbl" 2>/dev/null)" || p_rc=$?
    if [ "$p_rc" -eq 0 ]; then
      L_LOADED=1
      if printf '%s\\n' "$p_out" | grep -Eq 'state[[:space:]]*=[[:space:]]*running|pid[[:space:]]*=[[:space:]]*[1-9]'; then
        L_ACTIVE=1
      fi
    fi
  fi
}

capture_services_posix_vars() {
  SNAP_SERVICES_CAPTURED=1
  SNAP_SERVICES_APPLIED="\${SNAP_SERVICES_APPLIED:-0}"
  SNAP_NODE_FILE_EXISTS=0; SNAP_NODE_ENABLED=0; SNAP_NODE_ACTIVE=0
  SNAP_USER_FILE_EXISTS=0; SNAP_USER_ENABLED=0; SNAP_USER_ACTIVE=0
  SNAP_MAC_UID=""
  SNAP_MAC_NODE_FILE_EXISTS=0; SNAP_MAC_NODE_LOADED=0; SNAP_MAC_NODE_ACTIVE=0
  SNAP_MAC_WD_FILE_EXISTS=0; SNAP_MAC_WD_LOADED=0; SNAP_MAC_WD_ACTIVE=0
  SNAP_MAC_DAEMON_FILE_EXISTS=0; SNAP_MAC_DAEMON_LOADED=0; SNAP_MAC_DAEMON_ACTIVE=0
  if [ "$PLATFORM" = "linux" ]; then
    [ -e "$NODE_SERVICE_PATH" ] && SNAP_NODE_FILE_EXISTS=1
    [ -e "$AUTOSTART_PATH" ] && SNAP_USER_FILE_EXISTS=1
    if can_control_posix_services; then
      run_systemctl_sys is-enabled imcodes-node.service >/dev/null 2>&1 && SNAP_NODE_ENABLED=1 || true
      run_systemctl_sys is-active imcodes-node.service >/dev/null 2>&1 && SNAP_NODE_ACTIVE=1 || true
      run_systemctl_user is-enabled imcodes.service >/dev/null 2>&1 && SNAP_USER_ENABLED=1 || true
      run_systemctl_user is-active imcodes.service >/dev/null 2>&1 && SNAP_USER_ACTIVE=1 || true
    fi
  elif [ "$PLATFORM" = "darwin" ]; then
    t_user="$(resolve_target_unix_user)"
    SNAP_MAC_UID="$(id -u "$t_user" 2>/dev/null || id -u)"
    [ -e "$NODE_SERVICE_PATH" ] && SNAP_MAC_NODE_FILE_EXISTS=1
    [ -n "$NODE_WATCHDOG_SERVICE_PATH" ] && [ -e "$NODE_WATCHDOG_SERVICE_PATH" ] && SNAP_MAC_WD_FILE_EXISTS=1
    [ -e "$AUTOSTART_PATH" ] && SNAP_MAC_DAEMON_FILE_EXISTS=1
    probe_launchd_service_state "system/cc.imcodes.node"
    SNAP_MAC_NODE_LOADED="$L_LOADED"; SNAP_MAC_NODE_ACTIVE="$L_ACTIVE"
    probe_launchd_service_state "system/cc.imcodes.node.watchdog"
    SNAP_MAC_WD_LOADED="$L_LOADED"; SNAP_MAC_WD_ACTIVE="$L_ACTIVE"
    if [ -n "$SNAP_MAC_UID" ] && [ "$SNAP_MAC_UID" != "0" ]; then
      probe_launchd_service_state "gui/$SNAP_MAC_UID/imcodes.daemon"
      SNAP_MAC_DAEMON_LOADED="$L_LOADED"; SNAP_MAC_DAEMON_ACTIVE="$L_ACTIVE"
    fi
  fi
}

snapshot_services_posix() {
  svc_manifest="$SNAPSHOT_DIR/services.env"
  [ -f "$svc_manifest" ] && return 0
  if [ "\${SNAP_SERVICES_CAPTURED:-0}" -ne 1 ]; then
    capture_services_posix_vars
  fi
  if [ -n "$ISOLATED_ROOT" ]; then
    assert_safe_isolated_target "$SNAPSHOT_DIR"
  fi
  mkdir -p "$SNAPSHOT_DIR"
  svc_tmp="$svc_manifest.tmp.$$"
  : > "$svc_tmp"
  printf 'SERVICES_APPLIED=%s\\n' "\${SNAP_SERVICES_APPLIED:-0}" >> "$svc_tmp"
  if [ "$PLATFORM" = "linux" ]; then
    printf 'NODE_SVC_FILE_EXISTS=%s\\nNODE_SVC_ENABLED=%s\\nNODE_SVC_ACTIVE=%s\\n' "$SNAP_NODE_FILE_EXISTS" "$SNAP_NODE_ENABLED" "$SNAP_NODE_ACTIVE" >> "$svc_tmp"
    printf 'USER_SVC_FILE_EXISTS=%s\\nUSER_SVC_ENABLED=%s\\nUSER_SVC_ACTIVE=%s\\n' "$SNAP_USER_FILE_EXISTS" "$SNAP_USER_ENABLED" "$SNAP_USER_ACTIVE" >> "$svc_tmp"
  elif [ "$PLATFORM" = "darwin" ]; then
    printf 'MAC_UID=%s\\n' "$SNAP_MAC_UID" >> "$svc_tmp"
    printf 'MAC_NODE_FILE_EXISTS=%s\\nMAC_NODE_LOADED=%s\\nMAC_NODE_ACTIVE=%s\\n' "$SNAP_MAC_NODE_FILE_EXISTS" "$SNAP_MAC_NODE_LOADED" "$SNAP_MAC_NODE_ACTIVE" >> "$svc_tmp"
    printf 'MAC_WD_FILE_EXISTS=%s\\nMAC_WD_LOADED=%s\\nMAC_WD_ACTIVE=%s\\n' "$SNAP_MAC_WD_FILE_EXISTS" "$SNAP_MAC_WD_LOADED" "$SNAP_MAC_WD_ACTIVE" >> "$svc_tmp"
    printf 'MAC_DAEMON_FILE_EXISTS=%s\\nMAC_DAEMON_LOADED=%s\\nMAC_DAEMON_ACTIVE=%s\\n' "$SNAP_MAC_DAEMON_FILE_EXISTS" "$SNAP_MAC_DAEMON_LOADED" "$SNAP_MAC_DAEMON_ACTIVE" >> "$svc_tmp"
  fi
  mv -f "$svc_tmp" "$svc_manifest"
}

mark_services_applied_posix() {
  SNAP_SERVICES_APPLIED=1
  svc_manifest="$SNAPSHOT_DIR/services.env"
  [ -f "$svc_manifest" ] || snapshot_services_posix
  svc_tmp="$svc_manifest.tmp.$$"
  grep -v '^SERVICES_APPLIED=' "$svc_manifest" > "$svc_tmp" 2>/dev/null || true
  printf 'SERVICES_APPLIED=1\\n' >> "$svc_tmp"
  mv -f "$svc_tmp" "$svc_manifest"
}

snapshot_paths() {
  snapshot_services_posix
  mkdir -p "$SNAPSHOT_DIR/files"
  MANIFEST="$SNAPSHOT_DIR/snapshot.env"
  PRESERVED_MANIFEST="$SNAPSHOT_DIR/preserved.sha256"
  : > "$MANIFEST"
  : > "$PRESERVED_MANIFEST"
  for idx_target in \
    "CLI:$CLI_PATH" \
    "AUTOSTART:$AUTOSTART_PATH" \
    "CURRENT:$CURRENT_LINK" \
    "RELEASE:$RELEASE_DIR" \
    "NODE_BIN:$NODE_ROOT/imcodes-node" \
    "NODE_SVC:$NODE_SERVICE_PATH" \
    "NODE_WD_SVC:$NODE_WATCHDOG_SERVICE_PATH" \
    "DESKTOP:$DESKTOP_PATH" \
    "USER_WANTS:$USER_WANTS_LINK"
  do
    key="\${idx_target%%:*}"
    p="\${idx_target#*:}"
    [ -n "$p" ] || continue
    if [ -L "$p" ]; then
      sym="$(readlink "$p" 2>/dev/null || true)"
      printf '%s_KIND=symlink\n%s_PATH=%s\n%s_SYM=%s\n' "$key" "$key" "$p" "$key" "$sym" >> "$MANIFEST"
    elif [ -d "$p" ]; then
      rm -rf "$SNAPSHOT_DIR/files/$key"
      cp -Rp "$p" "$SNAPSHOT_DIR/files/$key"
      printf '%s_KIND=dir\n%s_PATH=%s\n' "$key" "$key" "$p" >> "$MANIFEST"
    elif [ -f "$p" ]; then
      cp -p "$p" "$SNAPSHOT_DIR/files/$key"
      printf '%s_KIND=file\n%s_PATH=%s\n' "$key" "$key" "$p" >> "$MANIFEST"
    else
      printf '%s_KIND=absent\n%s_PATH=%s\n' "$key" "$key" "$p" >> "$MANIFEST"
    fi
  done
  for pfile in "$NODE_ROOT/credential.json" "$USER_STATE_DIR/server.json"; do
    if [ -f "$pfile" ]; then
      printf '%s|%s\n' "$(hash_file_sha256 "$pfile")" "$pfile" >> "$PRESERVED_MANIFEST"
    fi
  done
}

restore_snapshot_posix() {
  snap="$1"
  [ -d "$snap" ] || { echo "Snapshot not found: $snap" >&2; exit 1; }
  if [ -n "$ISOLATED_ROOT" ]; then
    assert_safe_isolated_target "$snap"
  fi
  if [ -f "$snap/snapshot.json" ] && [ -x "$RELEASE_DIR/bin/node" ] && [ -f "$RELEASE_DIR/package/dist/src/node/desktop-installer-probe.js" ]; then
    if [ -z "$ISOLATED_ROOT" ]; then
      "$RELEASE_DIR/bin/node" "$RELEASE_DIR/package/dist/src/node/desktop-installer-probe.js" rollback --snapshot "$snap/snapshot.json" --allow-system-root --real-home "$REAL_HOME_BASE"
    else
      "$RELEASE_DIR/bin/node" "$RELEASE_DIR/package/dist/src/node/desktop-installer-probe.js" rollback --snapshot "$snap/snapshot.json" --isolated-root "$ISOLATED_ROOT" --real-home "$REAL_HOME_BASE"
    fi
    return 0
  fi
  MANIFEST="$snap/snapshot.env"
  [ -f "$MANIFEST" ] || { echo "Snapshot manifest missing in $snap" >&2; exit 1; }
  SVC_MANIFEST="$snap/services.env"
  svc_applied="$(read_snap_env_val "$SVC_MANIFEST" "SERVICES_APPLIED")"
  should_rollback_services=0
  if can_control_posix_services && { [ "$APPLY_SERVICES" -eq 1 ] || [ "$svc_applied" = "1" ]; }; then
    should_rollback_services=1
  fi

  # Step 1: Stop/unload services touched by this installer BEFORE deleting/restoring unit files or plists
  if [ "$should_rollback_services" -eq 1 ]; then
    if [ "$PLATFORM" = "linux" ]; then
      if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_SYSTEMCTL_BIN:-}" ]; then
        run_systemctl_sys stop imcodes-node.service >/dev/null 2>&1 || true
        run_systemctl_sys disable imcodes-node.service >/dev/null 2>&1 || true
      fi
      run_systemctl_user stop imcodes.service >/dev/null 2>&1 || true
      run_systemctl_user disable imcodes.service >/dev/null 2>&1 || true
    elif [ "$PLATFORM" = "darwin" ]; then
      if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_LAUNCHCTL_BIN:-}" ]; then
        run_launchctl bootout system/cc.imcodes.node >/dev/null 2>&1 || true
        run_launchctl bootout system/cc.imcodes.node.watchdog >/dev/null 2>&1 || true
        t_uid="$(read_snap_env_val "$SVC_MANIFEST" "MAC_UID")"
        if [ -z "$t_uid" ]; then
          t_user="$(resolve_target_unix_user)"
          t_uid="$(id -u "$t_user" 2>/dev/null || id -u)"
        fi
        if [ -n "$t_uid" ] && [ "$t_uid" != "0" ]; then
          run_launchctl bootout "gui/$t_uid/imcodes.daemon" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi

  # Step 2: Restore file/symlink/directory/absent snapshot entries
  for key in CLI AUTOSTART CURRENT RELEASE NODE_BIN NODE_SVC NODE_WD_SVC DESKTOP USER_WANTS; do
    kind="$(grep "^$key""_KIND=" "$MANIFEST" | cut -d= -f2- || true)"
    p="$(grep "^$key""_PATH=" "$MANIFEST" | cut -d= -f2- || true)"
    sym="$(grep "^$key""_SYM=" "$MANIFEST" | cut -d= -f2- || true)"
    [ -n "$p" ] || continue
    if [ -n "$ISOLATED_ROOT" ]; then
      if [ "$key" = "RELEASE" ]; then
        assert_safe_isolated_target "$p" container
      else
        assert_safe_isolated_target "$p" entry
      fi
    fi
    case "$kind" in
      absent)
        rm -rf "$p"
        ;;
      symlink)
        mkdir -p "$(dirname -- "$p")"
        rm -rf "$p"
        ln -s "$sym" "$p"
        ;;
      dir)
        mkdir -p "$(dirname -- "$p")"
        rm -rf "$p"
        cp -Rp "$snap/files/$key" "$p"
        ;;
      file)
        mkdir -p "$(dirname -- "$p")"
        tmp_r="$p.rollback.tmp.$$"
        cp -p "$snap/files/$key" "$tmp_r"
        mv -f "$tmp_r" "$p"
        ;;
    esac
  done
  if [ -f "$snap/preserved.sha256" ]; then
    while IFS='|' read -r expected_hash preserved_file; do
      [ -n "$preserved_file" ] || continue
      if [ ! -f "$preserved_file" ]; then
        echo "preserved_state_missing_during_rollback: $preserved_file" >&2
        exit 1
      fi
      actual_hash="$(hash_file_sha256 "$preserved_file")"
      if [ "$actual_hash" != "$expected_hash" ]; then
        echo "preserved_state_checksum_mismatch: $preserved_file" >&2
        exit 1
      fi
    done < "$snap/preserved.sha256"
  fi

  # Step 3: Reconcile daemon/node registration, enablement, and running state to captured pre-install snapshot
  if [ "$should_rollback_services" -eq 1 ]; then
    if [ "$PLATFORM" = "linux" ]; then
      n_exists="$(read_snap_env_val "$SVC_MANIFEST" "NODE_SVC_FILE_EXISTS")"
      n_en="$(read_snap_env_val "$SVC_MANIFEST" "NODE_SVC_ENABLED")"
      n_act="$(read_snap_env_val "$SVC_MANIFEST" "NODE_SVC_ACTIVE")"
      u_exists="$(read_snap_env_val "$SVC_MANIFEST" "USER_SVC_FILE_EXISTS")"
      u_en="$(read_snap_env_val "$SVC_MANIFEST" "USER_SVC_ENABLED")"
      u_act="$(read_snap_env_val "$SVC_MANIFEST" "USER_SVC_ACTIVE")"
      if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_SYSTEMCTL_BIN:-}" ]; then
        run_systemctl_sys daemon-reload >/dev/null 2>&1 || true
        if [ "$n_exists" = "1" ] && [ -f "$NODE_SERVICE_PATH" ]; then
          if [ "$n_en" = "1" ]; then
            run_systemctl_sys enable imcodes-node.service >/dev/null 2>&1 || true
          else
            run_systemctl_sys disable imcodes-node.service >/dev/null 2>&1 || true
          fi
          if [ "$n_act" = "1" ]; then
            run_systemctl_sys restart imcodes-node.service >/dev/null 2>&1 || run_systemctl_sys start imcodes-node.service >/dev/null 2>&1 || true
          else
            run_systemctl_sys stop imcodes-node.service >/dev/null 2>&1 || true
          fi
        else
          run_systemctl_sys reset-failed imcodes-node.service >/dev/null 2>&1 || true
        fi
      fi
      run_systemctl_user daemon-reload >/dev/null 2>&1 || true
      if [ "$u_exists" = "1" ] && [ -f "$AUTOSTART_PATH" ]; then
        if [ "$u_en" = "1" ]; then
          run_systemctl_user enable imcodes.service >/dev/null 2>&1 || true
        else
          run_systemctl_user disable imcodes.service >/dev/null 2>&1 || true
        fi
        if [ "$u_act" = "1" ]; then
          run_systemctl_user restart imcodes.service >/dev/null 2>&1 || run_systemctl_user start imcodes.service >/dev/null 2>&1 || true
        else
          run_systemctl_user stop imcodes.service >/dev/null 2>&1 || true
        fi
      else
        run_systemctl_user reset-failed imcodes.service >/dev/null 2>&1 || true
      fi
    elif [ "$PLATFORM" = "darwin" ]; then
      if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_LAUNCHCTL_BIN:-}" ]; then
        mn_load="$(read_snap_env_val "$SVC_MANIFEST" "MAC_NODE_LOADED")"
        mn_act="$(read_snap_env_val "$SVC_MANIFEST" "MAC_NODE_ACTIVE")"
        mw_load="$(read_snap_env_val "$SVC_MANIFEST" "MAC_WD_LOADED")"
        mw_act="$(read_snap_env_val "$SVC_MANIFEST" "MAC_WD_ACTIVE")"
        md_load="$(read_snap_env_val "$SVC_MANIFEST" "MAC_DAEMON_LOADED")"
        md_act="$(read_snap_env_val "$SVC_MANIFEST" "MAC_DAEMON_ACTIVE")"
        t_uid="$(read_snap_env_val "$SVC_MANIFEST" "MAC_UID")"
        if [ -z "$t_uid" ]; then
          t_user="$(resolve_target_unix_user)"
          t_uid="$(id -u "$t_user" 2>/dev/null || id -u)"
        fi
        if [ "$mn_load" = "1" ] && [ -f "$NODE_SERVICE_PATH" ]; then
          run_launchctl bootstrap system "$NODE_SERVICE_PATH" >/dev/null 2>&1 || true
          [ "$mn_act" = "1" ] && run_launchctl kickstart -k system/cc.imcodes.node >/dev/null 2>&1 || true
        fi
        if [ "$mw_load" = "1" ] && [ -n "$NODE_WATCHDOG_SERVICE_PATH" ] && [ -f "$NODE_WATCHDOG_SERVICE_PATH" ]; then
          run_launchctl bootstrap system "$NODE_WATCHDOG_SERVICE_PATH" >/dev/null 2>&1 || true
          [ "$mw_act" = "1" ] && run_launchctl kickstart -k system/cc.imcodes.node.watchdog >/dev/null 2>&1 || true
        fi
        if [ "$md_load" = "1" ] && [ -n "$t_uid" ] && [ "$t_uid" != "0" ] && [ -f "$AUTOSTART_PATH" ]; then
          run_launchctl bootstrap "gui/$t_uid" "$AUTOSTART_PATH" >/dev/null 2>&1 || true
          [ "$md_act" = "1" ] && run_launchctl kickstart -k "gui/$t_uid/imcodes.daemon" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
}

if [ "$PHASE" = "rollback" ]; then
  TARGET_ROLLBACK_DIR="\${ROLLBACK_DIR:-$SNAPSHOT_DIR}"
  restore_snapshot_posix "$TARGET_ROLLBACK_DIR"
  echo "ROLLBACK_OK snapshot=$TARGET_ROLLBACK_DIR"
  exit 0
fi

# Phase A read-only probe (prefer compiled TS engine when present in staged release)
SCENARIO=""
PRESERVE_CLI=0
PRESERVE_AUTOSTART=0
PRESERVE_FDA=0
CLEAN_EXPIRED_TMP=0
CHECK_LOCK=0
STOP_DAEMON=0
SWITCH_BUNDLED=0

PROBE_DIR="$RELEASE_DIR"
if [ -n "$PROBE_RUNTIME_DIR" ] && [ -x "$PROBE_RUNTIME_DIR/bin/node" ]; then
  PROBE_DIR="$PROBE_RUNTIME_DIR"
fi

if [ -x "$PROBE_DIR/bin/node" ] && [ -f "$PROBE_DIR/package/dist/src/node/desktop-installer-probe.js" ]; then
  PROBE_JSON="$("$PROBE_DIR/bin/node" "$PROBE_DIR/package/dist/src/node/desktop-installer-probe.js" plan \
    --platform "$PLATFORM" \
    --home "$EFF_HOME" \
    --user-state-dir "$USER_STATE_DIR" \
    --node-root "$NODE_ROOT" \
    --node-service "$NODE_SERVICE_PATH" \
    --runtime-root "$RUNTIME_ROOT" \
    --cli-path "$CLI_PATH" \
    --desktop-entry "$DESKTOP_PATH" \
    --autostart-path "$AUTOSTART_PATH" \
    $( [ -n "$ISOLATED_ROOT" ] && printf '%s %s' '--isolated-root' "$ISOLATED_ROOT" ) \
    $( [ -n "$MIN_VERSION" ] && printf '%s %s' '--min-version' "$MIN_VERSION" ) \
    $( [ "$FORCE_TAKEOVER" -eq 1 ] && printf '%s' '--force-takeover' ) \
    $( [ "$CONFIRM_FDA_SWITCH" -eq 1 ] && printf '%s' '--confirm-fda-switch' ))"
  SCENARIO="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.scenario)")"
  PRESERVE_CLI="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveDevCliLink?1:0)")"
  PRESERVE_AUTOSTART="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveUserDaemonAutostart?1:0)")"
  PRESERVE_FDA="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveLaunchAgentExecutable?1:0)")"
  CLEAN_EXPIRED_TMP="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.cleanExpiredTempArtifacts?1:0)")"
  CHECK_LOCK="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.checkSingleInstanceLock?1:0)")"
  STOP_DAEMON="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.stopUserDaemonTask?1:0)")"
  SWITCH_BUNDLED="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.switchToBundledRuntime?1:0)")"
else
  # Pure POSIX fallback when minimal/smoke runtime lacks full dist/ desktop-installer-probe.js
  autostart_dev=0
  autostart_broken=0
  installed_ver=""
  if [ -f "$AUTOSTART_PATH" ]; then
    if [ "$PLATFORM" = "darwin" ]; then
      arg0="$(awk '/<key>ProgramArguments<\\/key>/{f=1;next} f&&/<string>/{gsub(/.*<string>|<\\/string>.*/,"");print;exit}' "$AUTOSTART_PATH" 2>/dev/null || true)"
      arg1="$(awk '/<key>ProgramArguments<\\/key>/{f=1;next} f&&/<string>/{c++;if(c==2){gsub(/.*<string>|<\\/string>.*/,"");print;exit}}' "$AUTOSTART_PATH" 2>/dev/null || true)"
      if [ -n "$arg0" ] && { is_git_checkout_path "$arg0" || is_git_checkout_path "$arg1"; }; then
        autostart_dev=1
      elif [ -n "$arg0" ] && [ ! -e "$arg0" ]; then
        autostart_broken=1
      fi
    else
      exec_line="$(grep -m1 '^ExecStart=' "$AUTOSTART_PATH" 2>/dev/null | cut -d= -f2- || true)"
      set -- $exec_line
      e0="\${1:-}"; e1="\${2:-}"
      if { [ -n "$e0" ] && is_git_checkout_path "$e0"; } || { [ -n "$e1" ] && is_git_checkout_path "$e1"; }; then
        autostart_dev=1
      elif [ -n "$e0" ] && [ ! -e "$e0" ]; then
        autostart_broken=1
      elif [ -n "$e1" ] && [ ! -e "$e1" ]; then
        autostart_broken=1
      elif [ -n "$e1" ]; then
        installed_ver="$(find_pkg_version_near "$e1" || true)"
      fi
    fi
  fi
  if [ -z "$installed_ver" ] && [ -e "$CLI_PATH" ] && ! grep -q 'IMCODES_DAEMON_RUNTIME_DIR' "$CLI_PATH" 2>/dev/null; then
    installed_ver="$(find_pkg_version_near "$CLI_PATH" || true)"
  fi
  if [ -n "$MIN_VERSION" ] && [ -n "$installed_ver" ] && [ "$autostart_dev" -eq 0 ]; then
    if [ "$(compare_semver "$installed_ver" "$MIN_VERSION")" = "-1" ]; then
      autostart_broken=1
    fi
  fi

  if [ "$FORCE_TAKEOVER" -eq 0 ] && { { [ -e "$CLI_PATH" ] || [ -L "$CLI_PATH" ]; } && is_git_checkout_path "$CLI_PATH" || [ "$autostart_dev" -eq 1 ]; }; then
    SCENARIO="dev_symlink_exempt"
    PRESERVE_CLI=1
    PRESERVE_AUTOSTART=1
  elif [ "$PLATFORM" = "darwin" ] && [ "$CONFIRM_FDA_SWITCH" -eq 0 ] && [ -f "$AUTOSTART_PATH" ] && \
       grep -q "<key>ProgramArguments</key>" "$AUTOSTART_PATH" && \
       ! grep -q "/Library/Application Support/imcodes/daemon-runtime" "$AUTOSTART_PATH" && \
       ! grep -q "$RUNTIME_ROOT" "$AUTOSTART_PATH"; then
    SCENARIO="macos_launchagent_fda_preserve"
    PRESERVE_AUTOSTART=1
    PRESERVE_FDA=1
  elif [ "$autostart_broken" -eq 1 ] || { [ -f "$USER_STATE_DIR/last-upgrade-error.json" ] && grep -q -- "-2147020576" "$USER_STATE_DIR/last-upgrade-error.json"; } || [ "$FORCE_TAKEOVER" -eq 1 ]; then
    SCENARIO="legacy_broken_takeover"
    CLEAN_EXPIRED_TMP=1
    CHECK_LOCK=1
    STOP_DAEMON=1
    SWITCH_BUNDLED=1
  elif [ -f "$NODE_ROOT/credential.json" ] || [ -f "$USER_STATE_DIR/server.json" ] || [ -f "$AUTOSTART_PATH" ]; then
    SCENARIO="partial_preserve"
    [ -f "$AUTOSTART_PATH" ] && PRESERVE_AUTOSTART=1
    CHECK_LOCK=1
  else
    SCENARIO="clean"
    CHECK_LOCK=1
    SWITCH_BUNDLED=1
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "PHASE_A_PLAN scenario=$SCENARIO preserve_cli=$PRESERVE_CLI preserve_autostart=$PRESERVE_AUTOSTART preserve_fda=$PRESERVE_FDA check_lock=$CHECK_LOCK stop_daemon=$STOP_DAEMON"
  exit 0
fi

read_lock_field() {
  lock_file="$1"
  field_name="$2"
  [ -f "$lock_file" ] || return 1
  awk -v k="$field_name" '
    BEGIN { q = sprintf("%c", 34); txt = "" }
    { gsub(/\\015/, ""); txt = txt " " $0 }
    END {
      if (k == "pid") {
        if (match(txt, q "pid" q "[[:space:]]*:[[:space:]]*[0-9]+")) {
          seg = substr(txt, RSTART, RLENGTH)
          sub(/^.*:[[:space:]]*/, "", seg)
          print seg
        }
      } else {
        pat = q k q "[[:space:]]*:[[:space:]]*" q "[^" q "]*" q
        if (match(txt, pat)) {
          seg = substr(txt, RSTART, RLENGTH)
          sub("^" q k q "[[:space:]]*:[[:space:]]*" q, "", seg)
          sub(q "$", "", seg)
          print seg
        }
      }
    }
  ' "$lock_file"
}

read_lock_pid() {
  read_lock_field "$USER_STATE_DIR/daemon.lock.json" "pid"
}

read_lock_start_token() {
  read_lock_field "$USER_STATE_DIR/daemon.lock.json" "startToken"
}

expected_platform_token_scheme() {
  if [ "$PLATFORM" = "linux" ]; then
    printf 'linux'
  elif [ "$PLATFORM" = "darwin" ]; then
    printf 'ps'
  else
    printf 'unknown'
  fi
}

probe_lock_process_liveness() {
  pid="$1"
  PROBE_STATUS="probe_failed"
  PROBE_TOKEN=""
  case "$pid" in
    ''|*[!0-9]*)
      PROBE_STATUS="dead"
      return 0
      ;;
  esac
  if [ "$pid" -le 0 ] 2>/dev/null; then
    PROBE_STATUS="dead"
    return 0
  fi

  if [ "$PLATFORM" = "linux" ]; then
    proc_dir="\${IMCODES_PROC_DIR:-/proc}"
    if [ ! -d "$proc_dir" ]; then
      PROBE_STATUS="probe_failed"
      return 0
    fi
    stat_file="$proc_dir/$pid/stat"
    if [ -f "$stat_file" ]; then
      stat_line="$(cat "$stat_file" 2>/dev/null || true)"
      if [ -z "$stat_line" ]; then
        PROBE_STATUS="probe_failed"
        return 0
      fi
      parsed="$(printf '%s\\n' "$stat_line" | awk '{
        idx = 0
        n = length($0)
        for (i = n; i >= 1; i--) {
          if (substr($0, i, 1) == ")") { idx = i; break }
        }
        if (idx == 0) exit 1
        rest = substr($0, idx + 1)
        sub(/^[[:space:]]+/, "", rest)
        cnt = split(rest, f, /[[:space:]]+/)
        if (cnt < 20) exit 1
        print f[1] "|" f[20]
      }' 2>/dev/null || true)"
      if [ -z "$parsed" ]; then
        PROBE_STATUS="probe_failed"
        return 0
      fi
      p_state="\${parsed%%|*}"
      p_ticks="\${parsed#*|}"
      case "$p_state" in
        Z*|X*|x*)
          PROBE_STATUS="dead"
          return 0
          ;;
      esac
      case "$p_ticks" in
        ''|*[!0-9]*)
          PROBE_STATUS="probe_failed"
          return 0
          ;;
      esac
      PROBE_STATUS="alive"
      PROBE_TOKEN="linux:$p_ticks"
      return 0
    fi
    if [ -d "$proc_dir/$pid" ] || kill -0 "$pid" 2>/dev/null; then
      PROBE_STATUS="probe_failed"
      return 0
    fi
    PROBE_STATUS="dead"
    return 0
  elif [ "$PLATFORM" = "darwin" ]; then
    ps_bin="\${IMCODES_PS_BIN:-ps}"
    if ! command -v "$ps_bin" >/dev/null 2>&1; then
      PROBE_STATUS="probe_failed"
      return 0
    fi
    ps_rc=0
    ps_out="$("$ps_bin" -o state= -o lstart= -p "$pid" 2>/dev/null)" || ps_rc=$?
    if [ "$ps_rc" -ne 0 ]; then
      if kill -0 "$pid" 2>/dev/null || ! "$ps_bin" -p "$$" -o pid= >/dev/null 2>&1; then
        PROBE_STATUS="probe_failed"
      else
        PROBE_STATUS="dead"
      fi
      return 0
    fi
    parsed="$(printf '%s\\n' "$ps_out" | awk '{
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line == "") exit 1
      if (!match(line, /^[^[:space:]]+/)) exit 1
      st = substr(line, RSTART, RLENGTH)
      ls = substr(line, RSTART + RLENGTH)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", ls)
      gsub(/[[:space:]]+/, " ", ls)
      if (ls == "") exit 1
      print st "|" ls
    }' 2>/dev/null || true)"
    if [ -z "$parsed" ]; then
      PROBE_STATUS="probe_failed"
      return 0
    fi
    p_state="\${parsed%%|*}"
    p_lstart="\${parsed#*|}"
    case "$p_state" in
      Z*|X*|x*)
        PROBE_STATUS="dead"
        return 0
        ;;
    esac
    PROBE_STATUS="alive"
    PROBE_TOKEN="ps:$p_lstart"
    return 0
  fi
  PROBE_STATUS="probe_failed"
  return 0
}

# Returns LOCK_OWNERSHIP = dead | stale | owned | unknown
evaluate_lock_ownership() {
  pid="$1"
  lock_token="$2"
  probe_lock_process_liveness "$pid"
  if [ "$PROBE_STATUS" = "dead" ]; then
    LOCK_OWNERSHIP="dead"
    return 0
  fi
  if [ "$PROBE_STATUS" != "alive" ]; then
    LOCK_OWNERSHIP="unknown"
    return 0
  fi
  case "$lock_token" in
    *:*)
      tok_scheme="\${lock_token%%:*}"
      tok_val="\${lock_token#*:}"
      ;;
    *)
      LOCK_OWNERSHIP="unknown"
      return 0
      ;;
  esac
  if [ -z "$tok_val" ]; then
    LOCK_OWNERSHIP="unknown"
    return 0
  fi
  case "$tok_scheme" in
    linux|ps|windows) ;;
    *)
      LOCK_OWNERSHIP="unknown"
      return 0
      ;;
  esac
  exp_scheme="$(expected_platform_token_scheme)"
  if [ "$tok_scheme" != "$exp_scheme" ]; then
    LOCK_OWNERSHIP="unknown"
    return 0
  fi
  if [ "$lock_token" = "$PROBE_TOKEN" ]; then
    LOCK_OWNERSHIP="owned"
    return 0
  fi
  LOCK_OWNERSHIP="stale"
  return 0
}

STOPPED_ACTIVE_DAEMON=0
verify_and_stop_active_lock() {
  [ "$CHECK_LOCK" -eq 1 ] || [ "$STOP_DAEMON" -eq 1 ] || return 0
  lock_file="$USER_STATE_DIR/daemon.lock.json"
  [ -f "$lock_file" ] || return 0
  lock_pid="$(read_lock_pid || true)"
  [ -n "$lock_pid" ] || return 0
  lock_token="$(read_lock_start_token || true)"
  evaluate_lock_ownership "$lock_pid" "$lock_token"
  if [ "$LOCK_OWNERSHIP" = "dead" ]; then
    return 0
  fi
  if [ "$LOCK_OWNERSHIP" = "stale" ]; then
    echo "INFO: ignoring stale daemon lock pid=$lock_pid (startToken mismatch with live process $PROBE_TOKEN)" >&2
    return 0
  fi
  if [ "$LOCK_OWNERSHIP" = "unknown" ]; then
    if [ "$STOP_DAEMON" -eq 1 ] || [ "$PRESERVE_AUTOSTART" -eq 0 ] || [ "$SWITCH_BUNDLED" -eq 1 ]; then
      echo "ERROR: cannot verify ownership of live daemon lock pid=$lock_pid (status=$PROBE_STATUS); aborting without mutation" >&2
      exit 3
    fi
    return 0
  fi
  # LOCK_OWNERSHIP = owned: live verified imcodes daemon process.
  if [ "$STOP_DAEMON" -eq 1 ] || [ "$PRESERVE_AUTOSTART" -eq 0 ] || [ "$SWITCH_BUNDLED" -eq 1 ]; then
    if [ -n "\${IMCODES_STOP_DAEMON_HOOK:-}" ]; then
      evaluate_lock_ownership "$lock_pid" "$lock_token"
      if [ "$LOCK_OWNERSHIP" = "dead" ] || [ "$LOCK_OWNERSHIP" = "stale" ]; then
        return 0
      fi
      if [ "$LOCK_OWNERSHIP" != "owned" ]; then
        echo "ERROR: lock ownership verification failed before stop hook for pid=$lock_pid; aborting without mutation" >&2
        exit 3
      fi
      "$IMCODES_STOP_DAEMON_HOOK" "$lock_pid" "$AUTOSTART_PATH" || true
    else
      if [ "$APPLY_SERVICES" -eq 1 ]; then
        if [ "$PLATFORM" = "linux" ]; then
          SNAP_SERVICES_APPLIED=1
          run_systemctl_user stop imcodes.service >/dev/null 2>&1 || true
        elif [ "$PLATFORM" = "darwin" ]; then
          t_user="$(resolve_target_unix_user)"
          t_uid="$(id -u "$t_user" 2>/dev/null || id -u)"
          if [ -n "$t_uid" ] && [ "$t_uid" != "0" ]; then
            SNAP_SERVICES_APPLIED=1
            run_launchctl bootout "gui/$t_uid/imcodes.daemon" >/dev/null 2>&1 || true
          fi
        fi
      fi
      evaluate_lock_ownership "$lock_pid" "$lock_token"
      if [ "$LOCK_OWNERSHIP" = "dead" ] || [ "$LOCK_OWNERSHIP" = "stale" ]; then
        STOPPED_ACTIVE_DAEMON=1
        return 0
      fi
      if [ "$LOCK_OWNERSHIP" != "owned" ]; then
        echo "ERROR: lock ownership verification failed before signal for pid=$lock_pid; aborting without mutation" >&2
        exit 3
      fi
      kill -TERM "$lock_pid" 2>/dev/null || true
    fi
    wait_i=0
    while [ "$wait_i" -lt 25 ]; do
      evaluate_lock_ownership "$lock_pid" "$lock_token"
      if [ "$LOCK_OWNERSHIP" = "dead" ] || [ "$LOCK_OWNERSHIP" = "stale" ]; then
        STOPPED_ACTIVE_DAEMON=1
        return 0
      fi
      if [ "$LOCK_OWNERSHIP" = "unknown" ]; then
        echo "ERROR: lock ownership became unverifiable while waiting for pid=$lock_pid; aborting without mutation" >&2
        exit 3
      fi
      sleep 0.2 2>/dev/null || sleep 1
      wait_i=$((wait_i + 1))
    done
    evaluate_lock_ownership "$lock_pid" "$lock_token"
    if [ "$LOCK_OWNERSHIP" = "dead" ] || [ "$LOCK_OWNERSHIP" = "stale" ]; then
      STOPPED_ACTIVE_DAEMON=1
      return 0
    fi
    echo "ERROR: active imcodes daemon lock pid=$lock_pid did not exit after stop; aborting without mutation" >&2
    exit 3
  fi
}

if [ "$PHASE" = "preinst" ] || [ "$PHASE" = "preinstall" ]; then
  capture_services_posix_vars
  verify_and_stop_active_lock
  snapshot_paths
  exit 0
fi

# Postinstall / full isolated install: capture pre-stop service state & verify/stop live daemon lock BEFORE snapshot or payload writes
capture_services_posix_vars
verify_and_stop_active_lock
if [ ! -f "$SNAPSHOT_DIR/snapshot.env" ]; then
  snapshot_paths
fi

if [ -n "$STAGE_ARCHIVE" ] && [ -f "$STAGE_ARCHIVE" ]; then
  stage_tmp="$RUNTIME_ROOT/.staging-$$"
  rm -rf "$stage_tmp"
  mkdir -p "$stage_tmp" "$RUNTIME_ROOT/releases"
  tar -xzf "$STAGE_ARCHIVE" -C "$stage_tmp"
  rm -rf "$RELEASE_DIR"
  mv "$stage_tmp" "$RELEASE_DIR"
fi

# Never overwrite existing credential.json, server.json, or *.sqlite
mkdir -p "$RUNTIME_ROOT/releases" "$NODE_ROOT" "$USER_STATE_DIR"
if [ -d "$RELEASE_DIR" ]; then
  rm -rf "$CURRENT_LINK"
  ln -s "$RELEASE_DIR" "$CURRENT_LINK"
fi

if [ "$CLEAN_EXPIRED_TMP" -eq 1 ]; then
  for scan_dir in "$USER_STATE_DIR" "$NODE_ROOT" "$RUNTIME_ROOT"; do
    [ -d "$scan_dir" ] || continue
    find "$scan_dir" -maxdepth 1 -type f \\( -name '*.tmp' -o -name '*.tmp.*' -o -name '.staging-*' -o -name '.partial-*' \\) \
      ! -name 'daemon.lock.json' ! -name 'server.json' ! -name 'credential.json' ! -name '*.sqlite*' \
      -mtime +1 -delete 2>/dev/null || true
  done
fi

if [ "$PRESERVE_CLI" -eq 0 ]; then
  mkdir -p "$(dirname -- "$CLI_PATH")"
  cli_tmp="$CLI_PATH.tmp.$$"
  if ! printf '%s' "$WRAPPER_B64" | base64 -d > "$cli_tmp" 2>/dev/null; then
    if ! printf '%s' "$WRAPPER_B64" | base64 -D > "$cli_tmp" 2>/dev/null; then
      printf '%s' "$WRAPPER_B64" | base64 --decode > "$cli_tmp"
    fi
  fi
  chmod 755 "$cli_tmp"
  # Atomic rename replaces symlink directory entry cleanly without touching symlink target bytes
  mv -f "$cli_tmp" "$CLI_PATH"
fi

if [ "$PRESERVE_AUTOSTART" -eq 0 ]; then
  mkdir -p "$(dirname -- "$AUTOSTART_PATH")"
  auto_tmp="$AUTOSTART_PATH.tmp.$$"
  if [ "$PLATFORM" = "darwin" ]; then
    cat > "$auto_tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CURRENT_LINK/bin/node</string>
    <string>$CURRENT_LINK/package/dist/src/index.js</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
  else
    cat > "$auto_tmp" <<EOF
[Unit]
Description=IM.codes Coding Daemon
After=network-online.target

[Service]
Type=simple
ExecStart=$CURRENT_LINK/bin/node $CURRENT_LINK/package/dist/src/index.js start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    mkdir -p "$(dirname -- "$USER_WANTS_LINK")"
    ln -sfn "$AUTOSTART_PATH" "$USER_WANTS_LINK"
  fi
  mv -f "$auto_tmp" "$AUTOSTART_PATH"
fi

if [ "$PLATFORM" = "linux" ]; then
  if [ -x "$NODE_ROOT/imcodes-node" ] && [ ! -e "$NODE_SERVICE_PATH" ]; then
    mkdir -p "$(dirname -- "$NODE_SERVICE_PATH")"
    svc_tmp="$NODE_SERVICE_PATH.tmp.$$"
    cat > "$svc_tmp" <<EOF
[Unit]
Description=IM.codes controlled node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_ROOT/imcodes-node
NotifyAccess=all
WatchdogSec=180
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    mv -f "$svc_tmp" "$NODE_SERVICE_PATH"
  fi
  if [ ! -e "$DESKTOP_PATH" ]; then
    mkdir -p "$(dirname -- "$DESKTOP_PATH")"
    desk_tmp="$DESKTOP_PATH.tmp.$$"
    cat > "$desk_tmp" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=aiDesk.to by IM.codes
Comment=aiDesk.to by IM.codes
Exec="$NODE_ROOT/imcodes-node" --open-local-panel
Icon=aidesk
Terminal=false
Categories=Network;RemoteAccess;
StartupNotify=true
StartupWMClass=aidesk-local-ui
X-IMCodes-Managed=true
EOF
    mv -f "$desk_tmp" "$DESKTOP_PATH"
  fi
elif [ "$PLATFORM" = "darwin" ] && [ -x "$NODE_ROOT/imcodes-node" ]; then
  if [ ! -e "$NODE_SERVICE_PATH" ]; then
    mkdir -p "$(dirname -- "$NODE_SERVICE_PATH")"
    cat > "$NODE_SERVICE_PATH.tmp.$$" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cc.imcodes.node</string>
  <key>ProgramArguments</key><array><string>$NODE_ROOT/imcodes-node</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/var/log/imcodes-node.err.log</string>
  <key>StandardOutPath</key><string>/var/log/imcodes-node.out.log</string>
</dict>
</plist>
EOF
    mv -f "$NODE_SERVICE_PATH.tmp.$$" "$NODE_SERVICE_PATH"
  fi
  if [ -n "$NODE_WATCHDOG_SERVICE_PATH" ] && [ ! -e "$NODE_WATCHDOG_SERVICE_PATH" ]; then
    mkdir -p "$(dirname -- "$NODE_WATCHDOG_SERVICE_PATH")"
    cat > "$NODE_WATCHDOG_SERVICE_PATH.tmp.$$" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cc.imcodes.node.watchdog</string>
  <key>ProgramArguments</key><array><string>$NODE_ROOT/imcodes-node</string><string>--health-watchdog</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>/var/log/imcodes-node-watchdog.err.log</string>
  <key>StandardOutPath</key><string>/var/log/imcodes-node-watchdog.out.log</string>
</dict>
</plist>
EOF
    mv -f "$NODE_WATCHDOG_SERVICE_PATH.tmp.$$" "$NODE_WATCHDOG_SERVICE_PATH"
  fi
fi

if [ "$APPLY_SERVICES" -eq 1 ]; then
  mark_services_applied_posix
  if [ "$PLATFORM" = "linux" ]; then
    if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_SYSTEMCTL_BIN:-}" ]; then
      if [ -f "$NODE_SERVICE_PATH" ]; then
        run_systemctl_sys daemon-reload >/dev/null 2>&1 || true
        run_systemctl_sys enable imcodes-node.service >/dev/null 2>&1 || true
        run_systemctl_sys restart imcodes-node.service >/dev/null 2>&1 || run_systemctl_sys start imcodes-node.service >/dev/null 2>&1 || true
      fi
    fi
    if [ -f "$AUTOSTART_PATH" ] && { [ "$PRESERVE_AUTOSTART" -eq 0 ] || [ "$STOPPED_ACTIVE_DAEMON" -eq 1 ]; }; then
      t_user="$(resolve_target_unix_user)"
      if [ "$(id -u)" -eq 0 ] && [ "$t_user" != "root" ]; then
        chown -R "$t_user" "$(dirname -- "$AUTOSTART_PATH")" >/dev/null 2>&1 || true
      fi
      run_systemctl_user daemon-reload >/dev/null 2>&1 || true
      run_systemctl_user enable imcodes.service >/dev/null 2>&1 || true
      run_systemctl_user restart imcodes.service >/dev/null 2>&1 || run_systemctl_user start imcodes.service >/dev/null 2>&1 || true
      run_systemctl_user is-active imcodes.service >/dev/null 2>&1 || true
    fi
  elif [ "$PLATFORM" = "darwin" ]; then
    if [ "$(id -u)" -eq 0 ] || [ -n "\${IMCODES_LAUNCHCTL_BIN:-}" ]; then
      if [ -f "$NODE_SERVICE_PATH" ]; then
        run_launchctl bootout system/cc.imcodes.node >/dev/null 2>&1 || true
        run_launchctl bootstrap system "$NODE_SERVICE_PATH" >/dev/null 2>&1 || true
        run_launchctl kickstart -k system/cc.imcodes.node >/dev/null 2>&1 || true
      fi
      if [ -n "$NODE_WATCHDOG_SERVICE_PATH" ] && [ -f "$NODE_WATCHDOG_SERVICE_PATH" ]; then
        run_launchctl bootout system/cc.imcodes.node.watchdog >/dev/null 2>&1 || true
        run_launchctl bootstrap system "$NODE_WATCHDOG_SERVICE_PATH" >/dev/null 2>&1 || true
        run_launchctl kickstart -k system/cc.imcodes.node.watchdog >/dev/null 2>&1 || true
      fi
      if [ -f "$AUTOSTART_PATH" ] && { [ "$PRESERVE_AUTOSTART" -eq 0 ] || [ "$STOPPED_ACTIVE_DAEMON" -eq 1 ]; }; then
        t_user="$(resolve_target_unix_user)"
        t_uid="$(id -u "$t_user" 2>/dev/null || id -u)"
        if [ -n "$t_uid" ] && [ "$t_uid" != "0" ]; then
          [ "$(id -u)" -eq 0 ] && chown "$t_user" "$AUTOSTART_PATH" >/dev/null 2>&1 || true
          run_launchctl bootout "gui/$t_uid/imcodes.daemon" >/dev/null 2>&1 || true
          run_launchctl bootstrap "gui/$t_uid" "$AUTOSTART_PATH" >/dev/null 2>&1 || true
          run_launchctl kickstart -k "gui/$t_uid/imcodes.daemon" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
fi

echo "INSTALL_OK scenario=$SCENARIO preserve_cli=$PRESERVE_CLI preserve_autostart=$PRESERVE_AUTOSTART preserve_fda=$PRESERVE_FDA check_lock=$CHECK_LOCK stop_daemon=$STOP_DAEMON snapshot=$SNAPSHOT_DIR"
`;
}
