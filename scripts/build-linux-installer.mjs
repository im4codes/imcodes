#!/usr/bin/env node
/**
 * Build unified Linux Desktop 3-in-1 installers:
 * 1) Debian `.deb` package (`dpkg-deb --build --root-owner-group`)
 * 2) Universal offline self-extracting `.sh` installer
 * Both share the exact Phase A dual-path compatibility runner and emit `.manifest.json` sidecars.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { parseDaemonRuntimeTarget } from './daemon-runtime-artifacts.mjs';
import {
  loadDesktopCompatibilityModule,
  REPO_ROOT,
  renderLinuxAideskDesktopFile,
  renderLinuxControlledNodeSystemdUnit,
  renderLinuxUserDaemonSystemdTemplate,
  renderPosixPhaseARunnerScript,
  resolveDesktopInstallerVersion,
  stageDaemonRuntimePayload,
  toDebianVersion,
  writeDesktopInstallerManifest,
} from './desktop-installer-shared.mjs';

export function buildDebianControlText({ version, arch, installedSizeKb = 0 }) {
  const debArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const debVersion = toDebianVersion(version);
  return `Package: imcodes-desktop
Version: ${debVersion}
Section: utils
Priority: optional
Architecture: ${debArch}
Maintainer: IM.codes <support@im.codes>
Installed-Size: ${installedSizeKb}
Depends: systemd | bash, coreutils
Description: IM.codes Desktop 3-in-1 (Coding Daemon runtime, controlled node, remote desktop)
`;
}

export function renderLinuxOfflineInstallerHeader({ version, runnerScriptText }) {
  const runnerB64 = Buffer.from(runnerScriptText, 'utf8').toString('base64');
  return `#!/bin/sh
set -eu

INSTALLER_VERSION=${JSON.stringify(version)}
RUNNER_B64=${JSON.stringify(runnerB64)}

WORK_TMP="$(mktemp -d "\${TMPDIR:-/tmp}/imcodes-installer.XXXXXX")"
trap 'rm -rf "$WORK_TMP"' EXIT

RUNNER_PATH="$WORK_TMP/phase-a-runner.sh"
if ! printf '%s' "$RUNNER_B64" | base64 -d > "$RUNNER_PATH" 2>/dev/null; then
  printf '%s' "$RUNNER_B64" | base64 --decode > "$RUNNER_PATH"
fi
chmod 755 "$RUNNER_PATH"

ARCHIVE_LINE="$(awk '/^__ARCHIVE_BELOW__$/ {print NR + 1; exit 0;}' "$0")"
if [ -z "$ARCHIVE_LINE" ]; then
  echo "imcodes-installer: corrupted archive marker" >&2
  exit 1
fi

tail -n "+$ARCHIVE_LINE" "$0" | tar -xz -C "$WORK_TMP"

# Handle rollback or version queries before any installation steps
STATUS=0
for arg in "$@"; do
  case "$arg" in
    --rollback|--version|--check|--dry-run)
      if [ "$arg" = "--version" ]; then
        printf '%s\\n' "$INSTALLER_VERSION"
        exit 0
      fi
      "$RUNNER_PATH" --probe-runtime-dir "$WORK_TMP/payload/daemon-runtime" "$@"
      exit $?
      ;;
  esac
done

# Parse isolated root if provided so we stage payload cleanly after Phase A snapshot
ISOLATED_ROOT="\${IMCODES_ISOLATED_ROOT:-}"
prev=""
for arg in "$@"; do
  case "$prev" in
    --isolated-root) ISOLATED_ROOT="$arg"; prev=""; continue ;;
  esac
  case "$arg" in
    --isolated-root=*) ISOLATED_ROOT="\${arg#--isolated-root=}" ;;
    --isolated-root) prev="--isolated-root" ;;
  esac
done

# 1. Run preinstall lock verification + full pre-payload snapshot BEFORE mutating runtime directories
"$RUNNER_PATH" --phase preinstall --probe-runtime-dir "$WORK_TMP/payload/daemon-runtime" "$@"

if [ -n "$ISOLATED_ROOT" ]; then
  DEST_RUNTIME_ROOT="$ISOLATED_ROOT/daemon-runtime"
  DEST_NODE_ROOT="$ISOLATED_ROOT/controlled-node"
else
  DEST_RUNTIME_ROOT="/opt/imcodes/daemon-runtime"
  DEST_NODE_ROOT="/var/lib/imcodes-node"
fi

# 2. Copy read-only daemon-runtime into releases/<ver> and optional controlled-node binaries
# (never overwriting credential.json or install-identity.json)
RELEASE_DIR="$DEST_RUNTIME_ROOT/releases/$INSTALLER_VERSION"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR" "$DEST_NODE_ROOT"
cp -R "$WORK_TMP/payload/daemon-runtime/." "$RELEASE_DIR/"
chmod -R a+rX,go-w "$RELEASE_DIR" 2>/dev/null || true

if [ -d "$WORK_TMP/payload/controlled-node" ]; then
  for item in imcodes-node remote-desktop-worker computer-use-helper; do
    if [ -e "$WORK_TMP/payload/controlled-node/$item" ]; then
      rm -rf "$DEST_NODE_ROOT/$item"
      cp -R "$WORK_TMP/payload/controlled-node/$item" "$DEST_NODE_ROOT/$item"
    fi
  done
fi

# 3. Execute Phase A compatibility routing + current link + CLI wrapper + autostart + services
"$RUNNER_PATH" --phase postinstall --probe-runtime-dir "$WORK_TMP/payload/daemon-runtime" "$@"
exit $?
__ARCHIVE_BELOW__
`;
}

function parseCliArgs(argv) {
  const args = {
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    outDir: join(REPO_ROOT, 'dist-node-exe', 'installers'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--arch') args.arch = argv[++i];
    else if (token === '--version') args.version = argv[++i];
    else if (token === '--min-version') args.minVersion = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (token === '--runtime-archive') args.runtimeArchive = argv[++i];
    else if (token === '--node-exe') args.nodeExe = argv[++i];
    else if (token === '--remote-desktop-dir') args.remoteDesktopDir = argv[++i];
    else if (token === '--computer-use-dir') args.computerUseDir = argv[++i];
    else if (token === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (token === '--skip-deb') args.skipDeb = true;
    else if (token === '--skip-sh') args.skipSh = true;
    else throw new Error(`Unknown flag: ${token}`);
  }
  return args;
}

export async function buildLinuxInstallers(options) {
  const arch = options.arch === 'arm64' ? 'arm64' : 'x64';
  const targetInfo = parseDaemonRuntimeTarget('linux', arch);
  const version = resolveDesktopInstallerVersion(options.version);
  const outDir = resolve(options.outDir ?? join(REPO_ROOT, 'dist-node-exe', 'installers'));
  mkdirSync(outDir, { recursive: true });

  const compat = await loadDesktopCompatibilityModule();
  const cliWrapperContent = compat.renderPosixImcodesCliWrapper({ platform: 'linux' });
  const runnerScriptText = renderPosixPhaseARunnerScript({
    platform: 'linux',
    version,
    cliWrapperContent,
    minVersion: options.minVersion ?? '',
  });

  const workDir = mkdtempSync(join(tmpdir(), `imcodes-linux-pkg-${arch}-`));
  try {
    const payloadRoot = join(workDir, 'payload');
    const releaseDir = join(payloadRoot, 'daemon-runtime');
    stageDaemonRuntimePayload({
      runtimeDir: options.runtimeDir,
      runtimeArchive: options.runtimeArchive,
      target: targetInfo.target,
      destReleaseDir: releaseDir,
    });

    const nodeStageDir = join(payloadRoot, 'controlled-node');
    mkdirSync(nodeStageDir, { recursive: true });
    let hasNodeBinary = false;
    if (options.nodeExe && existsSync(options.nodeExe)) {
      const destNodeExe = join(nodeStageDir, 'imcodes-node');
      cpSync(resolve(options.nodeExe), destNodeExe);
      chmodSync(destNodeExe, 0o755);
      hasNodeBinary = true;
    }
    if (options.remoteDesktopDir && existsSync(options.remoteDesktopDir)) {
      cpSync(resolve(options.remoteDesktopDir), join(nodeStageDir, 'remote-desktop-worker'), {
        recursive: true,
      });
    }
    if (options.computerUseDir && existsSync(options.computerUseDir)) {
      cpSync(resolve(options.computerUseDir), join(nodeStageDir, 'computer-use-helper'), {
        recursive: true,
      });
    }

    const results = { version, arch, outDir };

    // 1. Offline self-extracting `.sh`
    if (!options.skipSh) {
      const tarPath = join(workDir, 'payload.tar.gz');
      execFileSync('tar', ['-czf', tarPath, '-C', workDir, 'payload'], { stdio: 'inherit' });
      const shPath = join(outDir, `imcodes-desktop-${version}-linux-${arch}.sh`);
      const header = Buffer.from(
        renderLinuxOfflineInstallerHeader({ version, runnerScriptText }),
        'utf8',
      );
      const archiveBytes = readFileSync(tarPath);
      writeFileSync(shPath, Buffer.concat([header, archiveBytes]));
      chmodSync(shPath, 0o755);
      await writeDesktopInstallerManifest(shPath, {
        platform: 'linux',
        arch,
        format: 'sh',
        version,
        hasNodeBinary,
      });
      results.shPath = shPath;
    }

    // 2. Debian `.deb` via dpkg-deb
    if (!options.skipDeb) {
      const debStage = join(workDir, 'deb-root');
      const debOptRelease = join(debStage, 'opt', 'imcodes', 'daemon-runtime', 'releases', version);
      mkdirSync(debOptRelease, { recursive: true });
      cpSync(releaseDir, debOptRelease, { recursive: true });

      const debVarNode = join(debStage, 'var', 'lib', 'imcodes-node');
      if (hasNodeBinary || options.remoteDesktopDir || options.computerUseDir) {
        mkdirSync(debVarNode, { recursive: true });
        cpSync(nodeStageDir, debVarNode, { recursive: true });
      }
      if (hasNodeBinary) {
        const sysUnitDir = join(debStage, 'etc', 'systemd', 'system');
        mkdirSync(sysUnitDir, { recursive: true });
        writeFileSync(
          join(sysUnitDir, 'imcodes-node.service'),
          renderLinuxControlledNodeSystemdUnit('/var/lib/imcodes-node'),
          'utf8',
        );
      }

      const userUnitDir = join(debStage, 'usr', 'lib', 'systemd', 'user');
      mkdirSync(userUnitDir, { recursive: true });
      writeFileSync(
        join(userUnitDir, 'imcodes.service'),
        renderLinuxUserDaemonSystemdTemplate('/opt/imcodes/daemon-runtime'),
        'utf8',
      );

      const desktopDir = join(debStage, 'usr', 'share', 'applications');
      mkdirSync(desktopDir, { recursive: true });
      writeFileSync(
        join(desktopDir, 'aidesk.desktop'),
        renderLinuxAideskDesktopFile('/var/lib/imcodes-node/imcodes-node'),
        'utf8',
      );

      const shareDir = join(debStage, 'usr', 'share', 'imcodes');
      mkdirSync(shareDir, { recursive: true });
      writeFileSync(join(shareDir, 'phase-a-runner.sh'), runnerScriptText, { mode: 0o755 });

      const debianMetaDir = join(debStage, 'DEBIAN');
      mkdirSync(debianMetaDir, { recursive: true });
      const duKbRaw = execFileSync('du', ['-sk', debStage], { encoding: 'utf8' }).trim().split(/\s+/u)[0];
      const installedSizeKb = Number.parseInt(duKbRaw || '0', 10) || 0;
      writeFileSync(
        join(debianMetaDir, 'control'),
        buildDebianControlText({ version, arch, installedSizeKb }),
        'utf8',
      );
      const runnerB64 = Buffer.from(runnerScriptText, 'utf8').toString('base64');
      const preinstScript = [
        '#!/bin/sh',
        'set -eu',
        'PRE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/imcodes-deb-preinst.XXXXXX")"',
        'trap \'rm -rf "$PRE_TMP"\' EXIT',
        `RUNNER_B64=${JSON.stringify(runnerB64)}`,
        'if ! printf \'%s\' "$RUNNER_B64" | base64 -d > "$PRE_TMP/runner.sh" 2>/dev/null; then',
        '  printf \'%s\' "$RUNNER_B64" | base64 --decode > "$PRE_TMP/runner.sh"',
        'fi',
        'chmod 700 "$PRE_TMP/runner.sh"',
        '/bin/sh "$PRE_TMP/runner.sh" --phase preinst',
        '',
      ].join('\n');
      writeFileSync(
        join(debianMetaDir, 'preinst'),
        preinstScript,
        { mode: 0o755 },
      );
      const postinstScript = [
        '#!/bin/sh',
        'set -eu',
        'if [ -n "${IMCODES_ISOLATED_ROOT:-}" ] && [ -x "${IMCODES_ISOLATED_ROOT}/usr/share/imcodes/phase-a-runner.sh" ]; then',
        '  exec /bin/sh "${IMCODES_ISOLATED_ROOT}/usr/share/imcodes/phase-a-runner.sh" --phase postinst "$@"',
        'fi',
        'exec /bin/sh /usr/share/imcodes/phase-a-runner.sh --phase postinst "$@"',
        '',
      ].join('\n');
      writeFileSync(
        join(debianMetaDir, 'postinst'),
        postinstScript,
        { mode: 0o755 },
      );
      writeFileSync(
        join(debianMetaDir, 'prerm'),
        `#!/bin/sh\nset -e\nif [ "$1" = "remove" ] && command -v systemctl >/dev/null 2>&1; then\n  systemctl stop imcodes-node.service >/dev/null 2>&1 || true\n  systemctl disable imcodes-node.service >/dev/null 2>&1 || true\nfi\n`,
        { mode: 0o755 },
      );

      const debPath = join(outDir, `imcodes-desktop-${version}-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`);
      execFileSync('dpkg-deb', ['--build', '--root-owner-group', debStage, debPath], {
        stdio: 'inherit',
      });
      await writeDesktopInstallerManifest(debPath, {
        platform: 'linux',
        arch,
        format: 'deb',
        version,
        debianPackage: basename(debPath),
        hasNodeBinary,
      });
      results.debPath = debPath;
    }

    return results;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('build-linux-installer.mjs');
if (isMain) {
  buildLinuxInstallers(parseCliArgs(process.argv.slice(2)))
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
