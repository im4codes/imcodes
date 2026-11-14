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
Description=IM.codes Controlled Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${stateRoot}/imcodes-node --run
WorkingDirectory=${stateRoot}
Restart=always
RestartSec=5
KillMode=process

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

export function renderMacosControlledNodeLaunchDaemonPlist(
  label,
  executablePath = '/Library/Application Support/imcodes-node/imcodes-node',
  args = ['--run'],
) {
  const argLines = [executablePath, ...args].map((a) => `    <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
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
FORCE_TAKEOVER=0
CONFIRM_FDA_SWITCH=0
APPLY_SERVICES=1
DRY_RUN=0
ROLLBACK_DIR=""
SNAPSHOT_DIR=""
STAGE_ARCHIVE=""
PROBE_RUNTIME_DIR=""
INSTALLER_VERSION=${JSON.stringify(version)}
PLATFORM=${JSON.stringify(platform)}
WRAPPER_B64=${JSON.stringify(wrapperB64)}

while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --isolated-root) ISOLATED_ROOT="$2"; shift 2 ;;
    --home) TARGET_HOME="$2"; shift 2 ;;
    --snapshot-dir) SNAPSHOT_DIR="$2"; shift 2 ;;
    --rollback) PHASE="rollback"; ROLLBACK_DIR="$2"; shift 2 ;;
    --stage-archive) STAGE_ARCHIVE="$2"; shift 2 ;;
    --probe-runtime-dir) PROBE_RUNTIME_DIR="$2"; shift 2 ;;
    --force-takeover) FORCE_TAKEOVER=1; shift ;;
    --confirm-fda-switch) CONFIRM_FDA_SWITCH=1; shift ;;
    --no-service-control) APPLY_SERVICES=0; shift ;;
    --check|--dry-run) DRY_RUN=1; APPLY_SERVICES=0; shift ;;
    --version) printf '%s\\n' "$INSTALLER_VERSION"; exit 0 ;;
    *) shift ;;
  esac
done

resolve_console_user_home() {
  if [ -n "$TARGET_HOME" ]; then
    printf '%s\\n' "$TARGET_HOME"
    return 0
  fi
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
  printf '%s\\n' "\${HOME:-/tmp}"
}

EFF_HOME="$(resolve_console_user_home)"
if [ -n "$ISOLATED_ROOT" ]; then
  APPLY_SERVICES=0
  case "$ISOLATED_ROOT" in
    /var/lib/imcodes-node*|/opt/imcodes*|"/Library/Application Support/imcodes"*)
      echo "Refusing unsafe isolated root inside system directory: $ISOLATED_ROOT" >&2
      exit 2
      ;;
  esac
  NODE_ROOT="$ISOLATED_ROOT/controlled-node"
  RUNTIME_ROOT="$ISOLATED_ROOT/daemon-runtime"
  CLI_PATH="$ISOLATED_ROOT/bin/imcodes"
  NODE_SERVICE_PATH="$NODE_ROOT/service-registered"
  if [ "$PLATFORM" = "darwin" ]; then
    DESKTOP_PATH="$ISOLATED_ROOT/Applications/aiDesk.to by IM.codes.app"
  else
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
  else
    NODE_SERVICE_PATH="/etc/systemd/system/imcodes-node.service"
  fi
  if [ -z "$SNAPSHOT_DIR" ]; then
    SNAPSHOT_DIR="$NODE_ROOT/installer-rollback-$INSTALLER_VERSION"
  fi
fi

USER_STATE_DIR="$EFF_HOME/.imcodes"
if [ "$PLATFORM" = "darwin" ]; then
  AUTOSTART_PATH="$EFF_HOME/Library/LaunchAgents/imcodes.daemon.plist"
else
  AUTOSTART_PATH="$EFF_HOME/.config/systemd/user/imcodes.service"
fi
RELEASE_DIR="$RUNTIME_ROOT/releases/$INSTALLER_VERSION"
CURRENT_LINK="$RUNTIME_ROOT/current"

is_git_checkout_path() {
  target="$1"
  [ -n "$target" ] || return 1
  if [ -e "$target" ]; then
    if command -v readlink >/dev/null 2>&1; then
      real="$(readlink -f "$target" 2>/dev/null || printf '%s' "$target")"
    else
      real="$target"
    fi
  else
    real="$target"
  fi
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

snapshot_paths() {
  mkdir -p "$SNAPSHOT_DIR/files"
  MANIFEST="$SNAPSHOT_DIR/snapshot.env"
  : > "$MANIFEST"
  for idx_target in "CLI:$CLI_PATH" "AUTOSTART:$AUTOSTART_PATH" "CURRENT:$CURRENT_LINK"; do
    key="\${idx_target%%:*}"
    p="\${idx_target#*:}"
    if [ -L "$p" ]; then
      sym="$(readlink "$p" 2>/dev/null || true)"
      printf '%s_KIND=symlink\n%s_PATH=%s\n%s_SYM=%s\n' "$key" "$key" "$p" "$key" "$sym" >> "$MANIFEST"
    elif [ -f "$p" ]; then
      cp -p "$p" "$SNAPSHOT_DIR/files/$key"
      printf '%s_KIND=file\n%s_PATH=%s\n' "$key" "$key" "$p" >> "$MANIFEST"
    else
      printf '%s_KIND=absent\n%s_PATH=%s\n' "$key" "$key" "$p" >> "$MANIFEST"
    fi
  done
}

restore_snapshot_posix() {
  snap="$1"
  [ -d "$snap" ] || { echo "Snapshot not found: $snap" >&2; exit 1; }
  if [ -f "$snap/snapshot.json" ] && [ -x "$RELEASE_DIR/bin/node" ] && [ -f "$RELEASE_DIR/package/dist/src/node/desktop-installer-probe.js" ]; then
    "$RELEASE_DIR/bin/node" "$RELEASE_DIR/package/dist/src/node/desktop-installer-probe.js" rollback --snapshot "$snap/snapshot.json" \
      $( [ -z "$ISOLATED_ROOT" ] && printf '%s' '--allow-system-root' )
    return 0
  fi
  MANIFEST="$snap/snapshot.env"
  [ -f "$MANIFEST" ] || { echo "Snapshot manifest missing in $snap" >&2; exit 1; }
  for key in CLI AUTOSTART CURRENT; do
    kind="$(grep "^$key""_KIND=" "$MANIFEST" | cut -d= -f2- || true)"
    p="$(grep "^$key""_PATH=" "$MANIFEST" | cut -d= -f2- || true)"
    sym="$(grep "^$key""_SYM=" "$MANIFEST" | cut -d= -f2- || true)"
    [ -n "$p" ] || continue
    case "$kind" in
      absent)
        rm -rf "$p"
        ;;
      symlink)
        mkdir -p "$(dirname -- "$p")"
        rm -rf "$p"
        ln -s "$sym" "$p"
        ;;
      file)
        mkdir -p "$(dirname -- "$p")"
        rm -rf "$p"
        cp -p "$snap/files/$key" "$p"
        ;;
    esac
  done
}

if [ "$PHASE" = "rollback" ]; then
  restore_snapshot_posix "$ROLLBACK_DIR"
  echo "ROLLBACK_OK snapshot=$ROLLBACK_DIR"
  exit 0
fi

# Phase A read-only probe (prefer compiled TS engine when present in staged release)
SCENARIO=""
PRESERVE_CLI=0
PRESERVE_AUTOSTART=0
PRESERVE_FDA=0
CLEAN_EXPIRED_TMP=0

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
    $( [ "$FORCE_TAKEOVER" -eq 1 ] && printf '%s' '--force-takeover' ) \
    $( [ "$CONFIRM_FDA_SWITCH" -eq 1 ] && printf '%s' '--confirm-fda-switch' ))"
  SCENARIO="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.scenario)")"
  PRESERVE_CLI="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveDevCliLink?1:0)")"
  PRESERVE_AUTOSTART="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveUserDaemonAutostart?1:0)")"
  PRESERVE_FDA="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.preserveLaunchAgentExecutable?1:0)")"
  CLEAN_EXPIRED_TMP="$(printf '%s' "$PROBE_JSON" | "$PROBE_DIR/bin/node" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.plan.cleanExpiredTempArtifacts?1:0)")"
else
  # Pure POSIX fallback when minimal/smoke runtime lacks full dist/ desktop-installer-probe.js
  if [ "$FORCE_TAKEOVER" -eq 0 ] && [ -e "$CLI_PATH" ] && is_git_checkout_path "$CLI_PATH"; then
    SCENARIO="dev_symlink_exempt"
    PRESERVE_CLI=1
    PRESERVE_AUTOSTART=1
  elif [ "$PLATFORM" = "darwin" ] && [ "$CONFIRM_FDA_SWITCH" -eq 0 ] && [ -f "$AUTOSTART_PATH" ] && \
       grep -q "<key>ProgramArguments</key>" "$AUTOSTART_PATH" && \
       ! grep -q "/Library/Application Support/imcodes/daemon-runtime" "$AUTOSTART_PATH"; then
    SCENARIO="macos_launchagent_fda_preserve"
    PRESERVE_AUTOSTART=1
    PRESERVE_FDA=1
  elif [ -f "$USER_STATE_DIR/last-upgrade-error.json" ] && grep -q -- "-2147020576" "$USER_STATE_DIR/last-upgrade-error.json"; then
    SCENARIO="legacy_broken_takeover"
    CLEAN_EXPIRED_TMP=1
  elif [ -f "$NODE_ROOT/credential.json" ] || [ -f "$USER_STATE_DIR/server.json" ] || [ -f "$AUTOSTART_PATH" ]; then
    SCENARIO="partial_preserve"
    [ -f "$AUTOSTART_PATH" ] && PRESERVE_AUTOSTART=1
  else
    SCENARIO="clean"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "PHASE_A_PLAN scenario=$SCENARIO preserve_cli=$PRESERVE_CLI preserve_autostart=$PRESERVE_AUTOSTART preserve_fda=$PRESERVE_FDA"
  exit 0
fi

if [ "$PHASE" = "preinst" ] || [ "$PHASE" = "preinstall" ]; then
  snapshot_paths
  exit 0
fi

# Postinstall / full isolated install: preserve an existing preinst snapshot from this install pass
if [ ! -f "$SNAPSHOT_DIR/snapshot.env" ]; then
  snapshot_paths
fi

if [ -n "$STAGE_ARCHIVE" ] && [ -f "$STAGE_ARCHIVE" ]; then
  mkdir -p "$RELEASE_DIR"
  tar -xzf "$STAGE_ARCHIVE" -C "$RELEASE_DIR"
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
  if ! printf '%s' "$WRAPPER_B64" | base64 -d > "$CLI_PATH" 2>/dev/null; then
    if ! printf '%s' "$WRAPPER_B64" | base64 -D > "$CLI_PATH" 2>/dev/null; then
      printf '%s' "$WRAPPER_B64" | base64 --decode > "$CLI_PATH"
    fi
  fi
  chmod 755 "$CLI_PATH"
fi

if [ "$PRESERVE_AUTOSTART" -eq 0 ]; then
  mkdir -p "$(dirname -- "$AUTOSTART_PATH")"
  if [ "$PLATFORM" = "darwin" ]; then
    cat > "$AUTOSTART_PATH" <<EOF
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
    cat > "$AUTOSTART_PATH" <<EOF
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
  fi
fi

if [ "$PLATFORM" = "linux" ] && [ ! -e "$DESKTOP_PATH" ]; then
  mkdir -p "$(dirname -- "$DESKTOP_PATH")"
  cat > "$DESKTOP_PATH" <<EOF
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
fi

if [ "$APPLY_SERVICES" -eq 1 ]; then
  if [ "$PLATFORM" = "linux" ] && [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
    if [ -f /etc/systemd/system/imcodes-node.service ]; then
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl enable imcodes-node.service >/dev/null 2>&1 || true
    fi
  elif [ "$PLATFORM" = "darwin" ] && [ "$(id -u)" -eq 0 ]; then
    if [ -f /Library/LaunchDaemons/cc.imcodes.node.plist ]; then
      launchctl bootstrap system /Library/LaunchDaemons/cc.imcodes.node.plist >/dev/null 2>&1 || true
    fi
    if [ "$PRESERVE_AUTOSTART" -eq 0 ] && [ -f "$AUTOSTART_PATH" ]; then
      cu="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
      if [ -n "$cu" ] && [ "$cu" != "root" ] && [ "$cu" != "loginwindow" ]; then
        cuid="$(id -u "$cu" 2>/dev/null || true)"
        if [ -n "$cuid" ]; then
          chown "$cu" "$AUTOSTART_PATH" >/dev/null 2>&1 || true
          launchctl bootstrap "gui/$cuid" "$AUTOSTART_PATH" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
fi

echo "INSTALL_OK scenario=$SCENARIO preserve_cli=$PRESERVE_CLI preserve_autostart=$PRESERVE_AUTOSTART preserve_fda=$PRESERVE_FDA snapshot=$SNAPSHOT_DIR"
`;
}
