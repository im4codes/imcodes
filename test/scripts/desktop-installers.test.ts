import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { detectInstalledAgentsWithMetadata } from '../../src/agent/agent-availability.js';
import { planDesktopInstallerCompatibility } from '../../shared/desktop-installer-compatibility.js';
import { probeDesktopInstallEnvironment } from '../../src/node/desktop-installer-probe.js';
// @ts-expect-error ESM script module
import { buildLinuxInstallers } from '../../scripts/build-linux-installer.mjs';
// @ts-expect-error ESM script module
import { buildMacosInstaller, refreshMacosPkgManifest } from '../../scripts/build-macos-installer.mjs';
// @ts-expect-error ESM script module
import {
  buildWindowsInstaller,
  parseCliArgs,
  renderWindowsInnoSetupIss,
  renderWindowsPhaseAInstallerPs1,
  resolveWindowsSigningConfig,
} from '../../scripts/build-windows-installer.mjs';
// @ts-expect-error ESM script module
import {
  renderLinuxControlledNodeSystemdUnit,
  renderMacosControlledNodeLaunchDaemonPlist,
  renderMacosControlledNodeWatchdogLaunchDaemonPlist,
  renderPosixPhaseARunnerScript,
  stageDaemonRuntimePayload,
} from '../../scripts/desktop-installer-shared.mjs';
// @ts-expect-error ESM script module
import { createArchiveFromDir } from '../../scripts/daemon-runtime-artifacts.mjs';
// @ts-expect-error ESM script module
import { selectDeveloperIdSigningIdentity } from '../../scripts/macos-release-signing.mjs';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-inst-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readStartTokenForPid(pid: number): string {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = stat.lastIndexOf(')');
    const fields = stat.slice(lastParen + 1).trim().split(/\s+/);
    const ticks = fields[19];
    if (!ticks || !/^\d+$/.test(ticks)) {
      throw new Error(`Failed to extract /proc/${pid}/stat starttime`);
    }
    return `linux:${ticks}`;
  }
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    .trim()
    .replace(/\s+/g, ' ');
  return `ps:${lstart}`;
}

async function spawnWorkerNode(script = 'setInterval(() => {}, 1000);') {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  if (!child.pid) throw new Error('failed to spawn worker node');
  await new Promise((r) => setTimeout(r, 80));
  return child;
}

function isPidAliveNode(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HAS_DPKG_DEB = (() => {
  try {
    return spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function findDeadPid(start = 9999999): number {
  let candidate = start;
  while (isPidAliveNode(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function createFakeRuntimeDir(
  root: string,
  os: 'linux' | 'darwin' | 'win32',
  version = '0.9.5',
): string {
  const rtDir = join(root, `runtime-${os}`);
  const nodeRel = os === 'win32' ? 'node.exe' : join('bin', 'node');
  const nodePath = join(rtDir, nodeRel);
  mkdirSync(join(nodePath, '..'), { recursive: true });
  mkdirSync(join(rtDir, 'package', 'dist', 'src'), { recursive: true });
  if (os === 'win32') {
    writeFileSync(nodePath, 'fake-node-exe', 'utf8');
  } else {
    writeFileSync(
      nodePath,
      `#!/bin/sh\nprintf 'IMCODES_CLI_EXEC version=%s entry=%s args=%s\\n' "${version}" "$1" "$2"\n`,
      'utf8',
    );
    chmodSync(nodePath, 0o755);
  }
  writeFileSync(
    join(rtDir, 'package', 'package.json'),
    JSON.stringify({ name: 'imcodes', version }),
  );
  writeFileSync(
    join(rtDir, 'package', 'dist', 'src', 'index.js'),
    `console.log("imcodes ${version}");\n`,
  );
  return rtDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AC 3: Three-platform installer builders & CI wiring', () => {
  it('builds Linux .deb + offline .sh, verifies .deb contents, and executes all Phase A + rollback scenarios in isolated temp dir', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const fakeNodeExe = join(root, 'imcodes-node-linux');
    writeFileSync(fakeNodeExe, '#!/bin/sh\necho node-exe\n', { mode: 0o755 });
    const outDir = join(root, 'out');

    const res = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeNodeExe,
      outDir,
      skipDeb: !HAS_DPKG_DEB,
    });

    expect(existsSync(res.shPath)).toBe(true);
    expect(existsSync(`${res.shPath}.manifest.json`)).toBe(true);
    const shManifest = JSON.parse(readFileSync(`${res.shPath}.manifest.json`, 'utf8')) as {
      artifact: { sha256: string };
    };
    expect(shManifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);

    if (HAS_DPKG_DEB) {
      expect(existsSync(res.debPath)).toBe(true);
      expect(existsSync(`${res.debPath}.manifest.json`)).toBe(true);

      // Verify .deb structure via dpkg-deb
      const debInfo = execFileSync('dpkg-deb', ['--info', res.debPath], { encoding: 'utf8' });
      expect(debInfo).toContain('Package: imcodes-desktop');
      expect(debInfo).toContain('Architecture: amd64');
      const debContents = execFileSync('dpkg-deb', ['--contents', res.debPath], { encoding: 'utf8' });
      expect(debContents).toContain('./opt/imcodes/daemon-runtime/releases/0.9.5/bin/node');
      expect(debContents).toContain('./usr/lib/systemd/user/imcodes.service');
      expect(debContents).toContain('./usr/share/applications/aidesk.desktop');
      expect(debContents).toContain('./var/lib/imcodes-node/imcodes-node');
    }

    // Scenario 1: Clean isolated install via offline .sh + empty PATH CLI + rollback
    const isoRoot = join(root, 'iso-clean');
    const isoHome = join(root, 'home-clean');
    mkdirSync(isoHome, { recursive: true });
    const dryOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoRoot, '--home', isoHome, '--check'],
      { encoding: 'utf8' },
    );
    expect(dryOut).toContain('PHASE_A_PLAN scenario=clean');

    const installOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoRoot, '--home', isoHome, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(installOut).toContain('INSTALL_OK scenario=clean');
    expect(readlinkSync(join(isoRoot, 'daemon-runtime', 'current'))).toBe(
      join(isoRoot, 'daemon-runtime', 'releases', '0.9.5'),
    );
    const cliOut = execFileSync(join(isoRoot, 'bin', 'imcodes'), ['--version'], {
      env: { PATH: '/nonexistent', HOME: isoHome },
      encoding: 'utf8',
    });
    expect(cliOut).toContain('IMCODES_CLI_EXEC version=0.9.5');

    // Rollback clean install -> removes newly created CLI wrapper, systemd unit, and current symlink
    execFileSync(
      res.shPath,
      ['--isolated-root', isoRoot, '--home', isoHome, '--rollback', join(isoRoot, 'rollback-snapshot')],
      { encoding: 'utf8' },
    );
    expect(existsSync(join(isoRoot, 'bin', 'imcodes'))).toBe(false);
    expect(existsSync(join(isoHome, '.config', 'systemd', 'user', 'imcodes.service'))).toBe(false);
    expect(existsSync(join(isoRoot, 'daemon-runtime', 'current'))).toBe(false);

    // Scenario 2: Partial semi-installed (existing server.json + credential.json + sqlite preserved)
    const isoPartial = join(root, 'iso-partial');
    const homePartial = join(root, 'home-partial');
    mkdirSync(join(homePartial, '.imcodes'), { recursive: true });
    mkdirSync(join(isoPartial, 'controlled-node'), { recursive: true });
    const serverJson = join(homePartial, '.imcodes', 'server.json');
    const credJson = join(isoPartial, 'controlled-node', 'credential.json');
    const sqliteFile = join(homePartial, '.imcodes', 'context.sqlite');
    writeFileSync(serverJson, '{"serverId":"srv-p","workerUrl":"https://app.im.codes","token":"tok"}');
    writeFileSync(credJson, '{"nodeId":"9999999999","token":"node-tok"}');
    writeFileSync(sqliteFile, 'sqlite-keep');
    const partialOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoPartial, '--home', homePartial, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(partialOut).toContain('INSTALL_OK scenario=partial_preserve');
    expect(readFileSync(credJson, 'utf8')).toBe('{"nodeId":"9999999999","token":"node-tok"}');
    expect(readFileSync(sqliteFile, 'utf8')).toBe('sqlite-keep');

    // Scenario 3: Dev symlink exemption
    const isoDev = join(root, 'iso-dev');
    const homeDev = join(root, 'home-dev');
    const devRepo = join(root, 'dev-repo');
    mkdirSync(join(devRepo, '.git'), { recursive: true });
    mkdirSync(join(devRepo, 'dist', 'src'), { recursive: true });
    mkdirSync(join(isoDev, 'bin'), { recursive: true });
    mkdirSync(homeDev, { recursive: true });
    const devEntry = join(devRepo, 'dist', 'src', 'index.js');
    writeFileSync(devEntry, '#!/bin/sh\necho dev\n', { mode: 0o755 });
    const devCli = join(isoDev, 'bin', 'imcodes');
    symlinkSync(devEntry, devCli);
    const devOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoDev, '--home', homeDev, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(devOut).toContain('INSTALL_OK scenario=dev_symlink_exempt preserve_cli=1 preserve_autostart=1');
    expect(lstatSync(devCli).isSymbolicLink()).toBe(true);

    // Scenario 5: Legacy broken (-2147020576) + expired .tmp cleanup + rollback
    const isoLegacy = join(root, 'iso-legacy');
    const homeLegacy = join(root, 'home-legacy');
    const stateLegacy = join(homeLegacy, '.imcodes');
    mkdirSync(join(homeLegacy, '.config', 'systemd', 'user'), { recursive: true });
    mkdirSync(stateLegacy, { recursive: true });
    const keepSrv = join(stateLegacy, 'server.json');
    const keepLock = join(stateLegacy, 'daemon.lock.json');
    const staleTmp = join(stateLegacy, 'broken-upgrade.tmp');
    writeFileSync(keepSrv, '{"serverId":"keep"}');
    writeFileSync(keepLock, JSON.stringify({ pid: findDeadPid() }));
    writeFileSync(join(stateLegacy, 'last-upgrade-error.json'), '{"exitCode":-2147020576}');
    writeFileSync(staleTmp, 'old');
    const threeDaysAgo = (Date.now() - 72 * 3600 * 1000) / 1000;
    utimesSync(staleTmp, threeDaysAgo, threeDaysAgo);
    const legacyEnv = { ...process.env };
    if (process.platform !== 'linux') {
      const emptyProc = join(root, 'empty-proc');
      mkdirSync(emptyProc, { recursive: true });
      legacyEnv.IMCODES_PROC_DIR = emptyProc;
    }
    const legacyOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoLegacy, '--home', homeLegacy, '--no-service-control'],
      { env: legacyEnv, encoding: 'utf8' },
    );
    expect(legacyOut).toContain('INSTALL_OK scenario=legacy_broken_takeover');
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(keepLock)).toBe(true);
    expect(readFileSync(keepSrv, 'utf8')).toBe('{"serverId":"keep"}');
  }, 60_000);

  it('stages macOS .pkg preserving .app seal, validates FDA LaunchAgent preservation, and supports Developer ID Installer signing identity selection', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const appBundle = join(root, 'aiDesk.to by IM.codes.app');
    mkdirSync(join(appBundle, 'Contents', 'MacOS'), { recursive: true });
    const appBinary = join(appBundle, 'Contents', 'MacOS', 'aidesk-agent');
    writeFileSync(appBinary, 'signed-app-binary-bytes');
    const originalDigest = sha256File(appBinary);

    const stageOut = await buildMacosInstaller({
      arch: 'arm64',
      version: '0.9.5',
      runtimeDir,
      appBundle,
      stageDir: join(root, 'mac-stage'),
      emitStageOnly: true,
    });

    const stagedAppBinary = join(
      stageOut.stageDir,
      'app-root',
      'Applications',
      'aiDesk.to by IM.codes.app',
      'Contents',
      'MacOS',
      'aidesk-agent',
    );
    expect(sha256File(stagedAppBinary)).toBe(originalDigest);
    expect(readFileSync(join(stageOut.stageDir, 'app-component.plist'), 'utf8')).toContain(
      '<key>BundleIsRelocatable</key>\n    <false/>',
    );
    expect(readFileSync(stageOut.distributionXmlPath, 'utf8')).toContain('to.aidesk.app');

    // Run generated macOS postinstall script against an isolated HOME having Homebrew LaunchAgent ProgramArguments[0]
    const isoMacRoot = join(root, 'iso-mac');
    const isoMacHome = join(root, 'home-mac');
    const plistDir = join(isoMacHome, 'Library', 'LaunchAgents');
    mkdirSync(plistDir, { recursive: true });
    const plistPath = join(plistDir, 'imcodes.daemon.plist');
    const renderPlist = (programArgs: string[]) =>
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((arg) => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
    const originalPlist = renderPlist(['/opt/homebrew/bin/node']);
    writeFileSync(plistPath, originalPlist);
    const macRunner = join(stageOut.scriptsDir, 'phase-a-runner.sh');
    const macDry = execFileSync(
      macRunner,
      ['--isolated-root', isoMacRoot, '--home', isoMacHome, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(macDry).toContain('scenario=macos_launchagent_fda_preserve');
    expect(macDry).toContain('preserve_fda=1');

    // Also verify POSIX fallback ignores Homebrew `.git` and `node_modules` boundaries even when `.git` exists on disk
    const fakeBrew = join(root, 'fake-homebrew');
    const fakeBrewPkg = join(fakeBrew, 'lib', 'node_modules', 'imcodes', 'dist', 'src');
    mkdirSync(join(fakeBrew, '.git'), { recursive: true });
    mkdirSync(join(fakeBrew, 'Cellar'), { recursive: true });
    mkdirSync(join(fakeBrew, 'bin'), { recursive: true });
    mkdirSync(fakeBrewPkg, { recursive: true });
    const fakeBrewNode = join(fakeBrew, 'bin', 'node');
    const fakeBrewEntry = join(fakeBrewPkg, 'index.js');
    writeFileSync(fakeBrewNode, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(fakeBrewEntry, 'console.log("brew");\n');
    writeFileSync(plistPath, renderPlist([fakeBrewNode, fakeBrewEntry, 'start', '--foreground']));
    const macBrewDry = execFileSync(
      macRunner,
      ['--isolated-root', isoMacRoot, '--home', isoMacHome, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(macBrewDry).toContain('scenario=macos_launchagent_fda_preserve');
    expect(macBrewDry).toContain('preserve_fda=1');

    // Positive control on the same multiline plist parser: symlinked npm-link checkout triggers dev_symlink_exempt,
    // proving arg0/arg1 are genuinely parsed by macRunner's awk and evaluated by is_git_checkout_path.
    const devRepo = join(root, 'codedeck-mac-dev');
    mkdirSync(join(devRepo, '.git'), { recursive: true });
    mkdirSync(join(devRepo, 'dist', 'src'), { recursive: true });
    writeFileSync(join(devRepo, 'dist', 'src', 'index.js'), 'console.log("dev");\n');
    const linkedPkg = join(fakeBrew, 'lib', 'node_modules', 'imcodes-linked');
    symlinkSync(devRepo, linkedPkg);
    writeFileSync(
      plistPath,
      renderPlist([fakeBrewNode, join(linkedPkg, 'dist', 'src', 'index.js'), 'start', '--foreground']),
    );
    const macDevDry = execFileSync(
      macRunner,
      ['--isolated-root', isoMacRoot, '--home', isoMacHome, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(macDevDry).toContain('scenario=dev_symlink_exempt');
    expect(macDevDry).toContain('preserve_autostart=1');

    // Verify Developer ID Installer selection works alongside Application selection
    const team = 'M675E26Q67';
    const keychainOut = [
      `  1) ${'A'.repeat(40)} "Developer ID Application: Test (${team})"`,
      `  2) ${'B'.repeat(40)} "Developer ID Installer: Test (${team})"`,
    ].join('\n');
    expect(
      selectDeveloperIdSigningIdentity(keychainOut, { teamId: team, certificateType: 'installer' }).sha1,
    ).toBe('B'.repeat(40));
  });

  it('generates Windows Inno Setup .iss, PowerShell Phase A probe/rollback helper, and imcodes.cmd forwarder', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'win32', '0.9.5');
    const fakeExe = join(root, 'imcodes-node.exe');
    writeFileSync(fakeExe, 'MZ-fake');
    const outDir = join(root, 'win-out');

    const res = await buildWindowsInstaller({
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeExe,
      outDir,
    });

    const issText = readFileSync(res.issPath, 'utf8');
    expect(issText).toContain('PrivilegesRequired=admin');
    expect(issText).toContain('SetupIconFile=stage\\controlled-node\\aidesk.ico');
    expect(issText).toContain('UninstallDisplayIcon={commonappdata}\\imcodes-node\\aidesk.ico');
    expect(issText).toContain('Compression=lzma2/fast');
    expect(issText).toContain('SolidCompression=yes');
    expect(issText).toContain('LZMAUseSeparateProcess=yes');
    expect(issText).toContain('LZMANumBlockThreads=4');
    expect(issText).toContain('imcodes-windows-installer.ps1');
    expect(issText).toContain('imcodes-node.exe');
    expect(issText).toContain('controlled-node\\aidesk.ico');
    expect(issText).toContain('[UninstallRun]');
    expect(existsSync(res.ps1Path)).toBe(true);
    expect(existsSync(res.cmdPath)).toBe(true);
    expect(existsSync(`${res.issPath}.manifest.json`)).toBe(true);
    const ps1Text = readFileSync(res.ps1Path, 'utf8');
    expect(ps1Text).toContain('legacy_broken_takeover');
    expect(ps1Text).toContain('$sc.IconLocation = $IconLocation');
    expect(ps1Text).toContain('function Sync-WindowsAideskShortcut');
    expect(ps1Text).toContain("Join-Path $NodeRoot 'aidesk.ico'");
  });

  it('integrates Linux, macOS, and Windows unified installer steps into .github/workflows/build-node-exe.yml and ci.yml', () => {
    for (const spec of [
      {
        file: '.github/workflows/build-node-exe.yml',
        jobKey: 'build',
        uploadName: 'Upload executable artifact',
      },
      {
        file: '.github/workflows/ci.yml',
        jobKey: 'controlled-node-executables',
        uploadName: 'Upload controlled-node executable',
      },
    ]) {
      const raw = readFileSync(spec.file, 'utf8');
      const parsed = parseYaml(raw) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string; with?: { path?: string } }> }>;
      };
      const steps = parsed.jobs[spec.jobKey].steps;
      const names = steps.map((s) => s.name ?? '');
      expect(names.some((n) => n.includes('Linux unified installers')), spec.file).toBe(true);
      expect(names.some((n) => n.includes('macOS .pkg installer')), spec.file).toBe(true);
      expect(names.some((n) => n.includes('Windows Inno Setup')), spec.file).toBe(true);
      const uploadStep = steps.find((s) => s.name === spec.uploadName);
      expect(uploadStep?.with?.path, spec.file).toContain('dist-node-exe/installers/**');
      expect(uploadStep?.with?.path, spec.file).toContain('dist-node-exe/desktop-release*.manifest.json');

      // F7: macOS CI workflow refreshes pkg manifest after signing and notarizing
      const macStep = steps.find((s) => (s.name ?? '').includes('macOS .pkg installer'));
      expect(macStep?.run, spec.file).toContain('--refresh-manifest');
      expect(macStep?.run, spec.file).toContain('--notarized');

      // F8: Linux CI workflow avoids dpkg-deb --contents | head SIGPIPE under pipefail
      const linuxStep = steps.find((s) => (s.name ?? '').includes('Linux unified installers'));
      expect(linuxStep?.run, spec.file).not.toMatch(/dpkg-deb --contents[^\n]*\|\s*head/u);
      expect(linuxStep?.run, spec.file).toContain('DEB_CONTENTS_TMP=');
    }

    const ciWinSteps = (
      parseYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
        jobs: { 'controlled-node-executables': { steps: Array<{ name?: string; run?: string }> } };
      }
    ).jobs['controlled-node-executables'].steps;
    const ciWinStep = ciWinSteps.find((s) => (s.name ?? '').includes('Windows Inno Setup'));
    expect(ciWinStep?.run).toContain('--require-iscc');
    expect(ciWinStep?.run).toContain('--runtime-dir');
    expect(ciWinStep?.run).toContain('daemon-runtime-stage');
    expect(ciWinStep?.run).not.toContain('--runtime-archive');
    expect(readFileSync('.dockerignore', 'utf8')).toContain('server/controlled-node-artifacts/installers');
  });

  it('consumes a retained staged --runtime-dir via CLI args without requiring or extracting a zip archive', async () => {
    const root = makeTempDir();
    const stageRoot = createFakeRuntimeDir(root, 'win32', '0.9.6');
    writeFileSync(join(stageRoot, 'daemon-runtime.files.json'), JSON.stringify({ target: 'win32-x64', files: [] }));
    const fakeExe = join(root, 'imcodes-node.exe');
    writeFileSync(fakeExe, 'MZ-fake');
    const outDir = join(root, 'win-out-cli');
    const workDir = join(root, 'win-work-cli');

    const { buildWindowsInstaller, parseCliArgs } = await import('../../scripts/build-windows-installer.mjs');
    const parsed = parseCliArgs([
      '--version',
      '0.9.6',
      '--runtime-dir',
      stageRoot,
      '--node-exe',
      fakeExe,
      '--out-dir',
      outDir,
    ]);
    expect(parsed.runtimeDir).toBe(stageRoot);
    expect(parsed.runtimeArchive).toBeUndefined();

    const res = await buildWindowsInstaller({ ...parsed, workDir });
    const stagedRuntimeDir = join(workDir, 'stage', 'daemon-runtime');
    expect(existsSync(join(stagedRuntimeDir, 'node.exe'))).toBe(true);
    expect(existsSync(join(stagedRuntimeDir, 'package', 'dist', 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(stagedRuntimeDir, 'daemon-runtime.files.json'))).toBe(true);
    expect(readFileSync(res.issPath, 'utf8')).toContain('daemon-runtime');
  });

  it('embeds self-contained preinst in .deb and cleans up offline .sh extraction TMPDIR (F1, F9)', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    // Populate >1,500 files so dpkg-deb --contents output exceeds pipe buffer (F8 SIGPIPE test too!)
    const bigAssets = join(runtimeDir, 'many-assets');
    mkdirSync(bigAssets, { recursive: true });
    for (let i = 0; i < 1400; i++) {
      writeFileSync(join(bigAssets, `asset-${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const fakeNode = join(root, 'imcodes-node');
    writeFileSync(fakeNode, '#!/bin/sh\necho "NODE_SERVICE_OK $*"\n');
    chmodSync(fakeNode, 0o755);
    const outDir = join(root, 'out');
    const customTmp = join(root, 'sh-tmp');
    mkdirSync(customTmp, { recursive: true });

    const res = await buildLinuxInstallers({
      version: '0.9.5',
      arch: 'x64',
      runtimeDir,
      nodeExe: fakeNode,
      outDir,
      skipDeb: !HAS_DPKG_DEB,
    });

    if (HAS_DPKG_DEB) {
      // F1: Extract DEBIAN control scripts & verify preinst runs cleanly BEFORE payload unpack!
      const debCtrl = join(root, 'deb-ctrl');
      execFileSync('dpkg-deb', ['-e', res.debPath, debCtrl], { encoding: 'utf8' });
      const preinst = readFileSync(join(debCtrl, 'preinst'), 'utf8');
      expect(preinst).not.toContain('/usr/share/imcodes/phase-a-runner.sh');
      expect(preinst).toContain('base64 -d');

      const debIso = join(root, 'deb-iso');
      execFileSync(
        join(debCtrl, 'preinst'),
        ['install'],
        {
          env: { ...process.env, IMCODES_ISOLATED_ROOT: debIso },
          encoding: 'utf8',
        },
      );
      expect(existsSync(join(debIso, 'rollback-snapshot', 'snapshot.env'))).toBe(true);

      // Unpack .deb payload and verify postinst + large dpkg-deb --contents temp-file pattern (F8)
      const debUnpack = join(root, 'deb-unpack');
      execFileSync('dpkg-deb', ['-x', res.debPath, debUnpack], { encoding: 'utf8' });
      expect(existsSync(join(debUnpack, 'opt', 'imcodes', 'daemon-runtime', 'releases', '0.9.5', 'bin', 'node'))).toBe(true);
      execFileSync(
        'bash',
        ['-euo', 'pipefail', '-c', 'TMPF="$(mktemp)"; dpkg-deb --contents "$1" > "$TMPF"; head -n 40 "$TMPF" >/dev/null; rm -f "$TMPF"', '_', res.debPath],
        { encoding: 'utf8' },
      );
    }

    // F9: Offline .sh cleans TMPDIR extraction directory after --check, --dry-run, and default derived --home (F6)
    const isoSh = join(root, 'sh-iso');
    execFileSync(res.shPath, ['--isolated-root', isoSh, '--check'], {
      env: { ...process.env, TMPDIR: customTmp },
      encoding: 'utf8',
    });
    expect(readdirSync(customTmp).filter((e) => e.startsWith('imcodes-sh.'))).toEqual([]);

    const shNoHomeOut = execFileSync(res.shPath, ['--isolated-root', isoSh, '--dry-run'], {
      env: { ...process.env, TMPDIR: customTmp },
      encoding: 'utf8',
    });
    expect(shNoHomeOut).toContain('scenario=clean');
    expect(readdirSync(customTmp).filter((e) => e.startsWith('imcodes-sh.'))).toEqual([]);
  });

  it('aligns service/watchdog entrypoints with installer templates (F2)', () => {
    // F2: Verify rendered service templates match src/node/installer.ts
    const systemdUnit = renderLinuxControlledNodeSystemdUnit('/var/lib/imcodes-node');
    expect(systemdUnit).toContain('ExecStart=/var/lib/imcodes-node/imcodes-node\n');
    expect(systemdUnit).not.toContain('--run');
    expect(systemdUnit).toContain('NotifyAccess=all');
    expect(systemdUnit).toContain('WatchdogSec=180');
    expect(systemdUnit).toContain('Restart=on-failure');

    const macDaemonPlist = renderMacosControlledNodeLaunchDaemonPlist();
    expect(macDaemonPlist).toContain('<string>/Library/Application Support/imcodes-node/imcodes-node</string>');
    expect(macDaemonPlist).not.toContain('--run');
    expect(macDaemonPlist).toContain('/var/log/imcodes-node.out.log');

    const macWatchdogPlist = renderMacosControlledNodeWatchdogLaunchDaemonPlist();
    expect(macWatchdogPlist).toContain('<string>--health-watchdog</string>');
    expect(macWatchdogPlist).toContain('<key>StartInterval</key>');
  });

  it.runIf(process.platform === 'linux')(
    'enforces minVersion takeover, live Linux /proc lock handling, symlink/dir rollback, and isolated path guards (F2, F3, F4, F6)',
    async () => {
      const root = makeTempDir();
      const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
      const fakeNode = join(root, 'imcodes-node');
      writeFileSync(fakeNode, '#!/bin/sh\necho "NODE_SERVICE_OK"\n');
      chmodSync(fakeNode, 0o755);
      const outDir = join(root, 'out');
      const res = await buildLinuxInstallers({
        version: '0.9.5',
        arch: 'x64',
        runtimeDir,
        nodeExe: fakeNode,
        outDir,
        skipDeb: true,
      });

    // Build scenario: old npm CLI at 0.9.4 (< minVersion 0.9.5), global symlink at bin/imcodes, real dir at current, existing file in releases/0.9.5
    const isoRoot = join(root, 'iso-takeover');
    const isoHome = join(root, 'home-takeover');
    const npmPkgDir = join(isoRoot, 'npm-global', 'lib', 'node_modules', 'imcodes');
    mkdirSync(join(npmPkgDir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(npmPkgDir, 'package.json'), JSON.stringify({ name: 'imcodes', version: '0.9.4' }));
    const npmEntry = join(npmPkgDir, 'dist', 'src', 'index.js');
    const npmOrigBytes = '#!/bin/sh\necho "OLD_NPM_BYTES_0_9_4"\n';
    writeFileSync(npmEntry, npmOrigBytes);
    chmodSync(npmEntry, 0o755);
    mkdirSync(join(isoRoot, 'bin'), { recursive: true });
    const cliPath = join(isoRoot, 'bin', 'imcodes');
    symlinkSync(npmEntry, cliPath);

    // Pre-existing non-symlink current dir + pre-existing same-version releases/0.9.5 file
    const runtimeRoot = join(isoRoot, 'daemon-runtime');
    const currentDir = join(runtimeRoot, 'current');
    mkdirSync(join(currentDir, 'legacy'), { recursive: true });
    writeFileSync(join(currentDir, 'legacy', 'marker.txt'), 'real-dir-current');
    mkdirSync(join(runtimeRoot, 'releases', '0.9.5'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'releases', '0.9.5', 'old-same-ver.txt'), 'same-ver-old');

    // Legacy user systemd service
    const systemdUserDir = join(isoHome, '.config', 'systemd', 'user');
    mkdirSync(systemdUserDir, { recursive: true });
    const userSvcPath = join(systemdUserDir, 'imcodes.service');
    writeFileSync(userSvcPath, '[Service]\nExecStart=/usr/bin/node /bad/missing/index.js\n');

    // Mock systemctl binary to record system & user calls
    const systemctlLog = join(root, 'systemctl.log');
    const mockSystemctl = join(root, 'mock-systemctl');
    writeFileSync(mockSystemctl, `#!/bin/sh\necho "SYSTEMCTL:$*" >> "${systemctlLog}"\nexit 0\n`);
    chmodSync(mockSystemctl, 0o755);

    // F3: Live daemon lock with verified startToken whose stop hook fails MUST abort BEFORE modifying CLI symlink or current/!
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    mkdirSync(join(isoHome, '.imcodes'), { recursive: true });
    const lockPath = join(isoHome, '.imcodes', 'daemon.lock.json');
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: sleeper.pid, startToken: readStartTokenForPid(sleeper.pid!) }),
    );
    const failStopHook = join(root, 'fail-stop.sh');
    writeFileSync(failStopHook, '#!/bin/sh\nexit 1\n');
    chmodSync(failStopHook, 0o755);

    try {
      let aborted = false;
      try {
        execFileSync(
          res.shPath,
          ['--isolated-root', isoRoot, '--home', isoHome, '--min-version', '0.9.5', '--apply-services'],
          { env: { ...process.env, IMCODES_STOP_DAEMON_HOOK: failStopHook }, encoding: 'utf8' },
        );
      } catch {
        aborted = true;
      }
      expect(aborted).toBe(true);
      // Pre-install state remains completely intact after fail-closed lock abort
      expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(currentDir, 'legacy', 'marker.txt'), 'utf8')).toBe('real-dir-current');

      // Now install cleanly using controllable stop hook (kills sleeper or succeeds)
      const okStopHook = join(root, 'ok-stop.sh');
      writeFileSync(okStopHook, '#!/bin/sh\nkill -TERM "$1" 2>/dev/null || true\nsleep 0.2\nexit 0\n');
      chmodSync(okStopHook, 0o755);

      const installOut = execFileSync(
        res.shPath,
        ['--isolated-root', isoRoot, '--home', isoHome, '--min-version', '0.9.5', '--apply-services'],
        {
          env: {
            ...process.env,
            IMCODES_STOP_DAEMON_HOOK: okStopHook,
            IMCODES_SYSTEMCTL_BIN: mockSystemctl,
          },
          encoding: 'utf8',
        },
      );
      expect(installOut).toContain('INSTALL_OK');
      expect(installOut).toContain('scenario=legacy_broken_takeover');
      // F4: Symlink was replaced atomically without modifying npmEntry bytes
      expect(lstatSync(cliPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(npmEntry, 'utf8')).toBe(npmOrigBytes);
      // F2: Service files & systemctl activation logged
      const sysCalls = readFileSync(systemctlLog, 'utf8');
      expect(sysCalls).toContain('enable imcodes-node.service');
      expect(sysCalls).toContain('--user enable imcodes.service');
      expect(lstatSync(join(systemdUserDir, 'default.target.wants', 'imcodes.service')).isSymbolicLink()).toBe(true);

      // Rollback restores npm symlink, real dir current, AND same-version releases/0.9.5!
      execFileSync(
        res.shPath,
        ['--isolated-root', isoRoot, '--home', isoHome, '--rollback'],
        { encoding: 'utf8' },
      );
      expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(cliPath)).toBe(npmEntry);
      expect(readFileSync(npmEntry, 'utf8')).toBe(npmOrigBytes);
      expect(lstatSync(currentDir).isDirectory()).toBe(true);
      expect(readFileSync(join(currentDir, 'legacy', 'marker.txt'), 'utf8')).toBe('real-dir-current');
      expect(readFileSync(join(runtimeRoot, 'releases', '0.9.5', 'old-same-ver.txt'), 'utf8')).toBe('same-ver-old');

      // F6: Traversal to system root, real HOME subdir, and --allow-system-root rejected under isolated root
      expect(() =>
        execFileSync(res.shPath, ['--isolated-root', isoRoot, '--home', `${isoRoot}/../../../../var/lib/imcodes-node`, '--dry-run'], {
          encoding: 'utf8',
        }),
      ).toThrow();
      const linkHome = join(root, 'link-home');
      const fakeRealHome = join(root, 'fake-real-home');
      mkdirSync(join(fakeRealHome, '.imcodes'), { recursive: true });
      symlinkSync(join(fakeRealHome, '.imcodes'), linkHome);
      expect(() =>
        execFileSync(res.shPath, ['--isolated-root', isoRoot, '--home', linkHome, '--dry-run'], {
          env: { ...process.env, HOME: fakeRealHome },
          encoding: 'utf8',
        }),
      ).toThrow();
      expect(() =>
        execFileSync(res.shPath, ['--isolated-root', isoRoot, '--allow-system-root', '--dry-run'], {
          encoding: 'utf8',
        }),
      ).toThrow();
    } finally {
      try {
        sleeper.kill('SIGKILL');
      } catch {}
    }
  }, 60_000);

  it('updates macOS pkg manifest sha256 and signing flags via refreshMacosPkgManifest (F7)', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const fakeNode = join(root, 'imcodes-node');
    writeFileSync(fakeNode, '#!/bin/sh\necho node\n');
    chmodSync(fakeNode, 0o755);
    const outDir = join(root, 'mac-out');
    const pkgPath = join(outDir, 'imcodes-desktop-0.9.5-arm64.pkg');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(pkgPath, 'unsigned-pkg-bytes');

    const stageRes = await buildMacosInstaller({
      version: '0.9.5',
      arch: 'arm64',
      runtimeDir,
      nodeExe: fakeNode,
      outDir,
      stageDir: join(root, 'mac-stage'),
      emitStageOnly: true,
    });
    expect(
      readFileSync(
        join(stageRes.stageDir, 'runtime-root', 'Library', 'LaunchDaemons', 'cc.imcodes.node.watchdog.plist'),
        'utf8',
      ),
    ).toContain('--health-watchdog');

    // Simulate signing mutating pkg bytes, then refreshing manifest
    writeFileSync(pkgPath, 'signed-and-notarized-pkg-bytes');
    const expectedSha = sha256File(pkgPath);
    const updatedManifest = await refreshMacosPkgManifest({
      pkgPath,
      version: '0.9.5',
      arch: 'arm64',
      signed: true,
      notarized: true,
      hasAppBundle: false,
      hasNodeBinary: false,
    });
    expect(updatedManifest.manifest.artifact.sha256).toBe(expectedSha);
    expect(updatedManifest.manifest.signed).toBe(true);
    expect(updatedManifest.manifest.notarized).toBe(true);
    const persisted = JSON.parse(readFileSync(`${pkgPath}.manifest.json`, 'utf8'));
    expect(persisted.artifact.sha256).toBe(expectedSha);
    expect(persisted.notarized).toBe(true);
  });

  it('wires Windows PreInstall, Watchdog XML, and linear goto imcodes.cmd wrapper (F2, F5)', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'win32', '0.9.5');
    const fakeExe = join(root, 'imcodes-node.exe');
    writeFileSync(fakeExe, 'MZ-fake');
    const outDir = join(root, 'win-out');

    const res = await buildWindowsInstaller({
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeExe,
      outDir,
    });

    const issText = readFileSync(res.issPath, 'utf8');
    expect(issText).toContain('Flags: dontcopy');
    expect(issText).toContain('CurStepChanged(CurStep: TSetupStep)');
    expect(issText).toContain('-Mode PreInstall');
    expect(issText).toContain('-ApplyServices');

    const ps1Text = readFileSync(res.ps1Path, 'utf8');
    expect(ps1Text).toContain(
      "ValidateSet('Probe', 'Plan', 'PreInstall', 'PostInstall', 'InstallOpenCode', 'CleanupTmp', 'Rollback')",
    );
    expect(ps1Text).toContain('imcodes-node-watchdog');
    expect(ps1Text).toContain('Resolve-CanonicalWindowsPath');
    // PowerShell 5.1 NativeCommandError regression: must remove junctions/symlinks/dirs via Remove-PathSafely, never cmd /c rmdir 2>$null
    expect(ps1Text).toContain('function Remove-PathSafely');
    expect(ps1Text).toContain('function New-WindowsReparsePoint');
    expect(ps1Text).toContain("$reparseKind = if ($item.PSIsContainer) { 'junction' } else { 'symlink' }");
    expect(ps1Text).not.toContain('cmd /c rmdir');

    const cmdText = readFileSync(res.cmdPath, 'utf8');
    expect(cmdText).toContain('goto :check_bundled');
    expect(cmdText).toContain('goto :check_npm');
    expect(cmdText).toContain('IMCODES_EXIT=%ERRORLEVEL%');
    // F5: No parenthesized compound if (...) else (...) block prematurely expanding %RESOLVED_NODE%
    expect(cmdText).not.toMatch(/^\s*\(\s*$/m);

    // F3-R2 / F4-R2 / F6-R2 structural checks in Windows PowerShell runner
    expect(ps1Text).toContain('function Get-WindowsLockOwnership');
    expect(ps1Text).toContain('StartTime.ToUniversalTime().Ticks');
    const lockOwnershipBlock = ps1Text.slice(
      ps1Text.indexOf('function Get-WindowsLockOwnership'),
      ps1Text.indexOf('function Get-WindowsServicesSnapshot'),
    );
    expect(lockOwnershipBlock).not.toContain('Win32_Process');
    expect(ps1Text).toContain('function Get-WindowsServicesSnapshot');
    expect(ps1Text).toContain('function Invoke-Schtasks');
    expect(ps1Text).toContain('[string]$SchtasksExe = \'\'');
    expect(ps1Text).toContain('userDaemonWasRunning');
    expect(ps1Text).toContain('canonical_path_symlink_loop');
    // Streaming share-safe SHA-256 + SQLite WAL exclusion + managed node/sidecar stop + logging diagnostics
    expect(ps1Text).not.toContain('ReadAllBytes');
    expect(ps1Text).toContain('[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete');
    expect(ps1Text).toContain('function Test-DatabaseFileName');
    expect(ps1Text).toContain('preservedDatabases');
    expect(ps1Text).toContain('function Stop-ControlledNodeAndSidecarsForInstall');
    expect(ps1Text).toContain('upgrade-in-progress.json');
    expect(ps1Text).toContain('function Write-InstallerLog');
    expect(ps1Text).toContain('[string]$LogPath = \'\'');
    expect(issText).toContain('installer-preinstall.log');
    expect(issText).toContain('installer-postinstall.log');
    expect(issText).toContain('installer-rollback.log');
    expect(issText).toContain('function ReadInstallerLogTail');
    // PowerShell 5.1 non-BOM UTF-8 guard: generated .ps1 must remain pure ASCII
    expect(ps1Text).not.toMatch(/[^\x00-\x7f]/);
  });

  it('stages Windows remote-desktop-worker/win32-x64, virtual-display extract/pnputil hook, and valid Windows watchdog script', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'win32', '0.9.5');
    const fakeExe = join(root, 'imcodes-node.exe');
    writeFileSync(fakeExe, 'MZ-fake');

    // Simulate CI passing --remote-desktop-dir .../win32-x64 directly
    const rdPlatformSrc = join(root, 'ci-rd', 'win32-x64');
    mkdirSync(rdPlatformSrc, { recursive: true });
    writeFileSync(join(rdPlatformSrc, 'imcodes-remote-desktop-worker.exe'), 'MZ-worker');
    const signerHex = 'a'.repeat(64);
    writeFileSync(
      join(rdPlatformSrc, 'imcodes-remote-desktop-worker.exe.manifest.json'),
      JSON.stringify({ authenticodeSignerSha256: signerHex }),
    );
    writeFileSync(join(rdPlatformSrc, 'imcodes-virtual-display.zip'), 'PK-zip');

    // Simulate CI passing --local-ui-dir .../win32-x64 directly
    const uiPlatformSrc = join(root, 'ci-ui', 'win32-x64');
    mkdirSync(uiPlatformSrc, { recursive: true });
    writeFileSync(join(uiPlatformSrc, 'aidesk-local-ui.exe'), 'MZ-ui');

    const workDir = join(root, 'win-work');
    const outDir = join(root, 'win-out');
    const res = await buildWindowsInstaller({
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeExe,
      remoteDesktopDir: rdPlatformSrc,
      localUiDir: uiPlatformSrc,
      workDir,
      keepWorkDir: true,
      outDir,
    });

    expect(
      existsSync(join(workDir, 'stage', 'controlled-node', 'remote-desktop-worker', 'win32-x64', 'imcodes-remote-desktop-worker.exe')),
    ).toBe(true);
    expect(
      existsSync(join(workDir, 'stage', 'controlled-node', 'remote-desktop-worker', 'win32-x64', 'imcodes-virtual-display.zip')),
    ).toBe(true);
    expect(
      existsSync(join(workDir, 'stage', 'controlled-node', 'aidesk-local-ui', 'win32-x64', 'aidesk-local-ui.exe')),
    ).toBe(true);
    expect(
      existsSync(join(workDir, 'stage', 'controlled-node', 'aidesk.ico')),
    ).toBe(true);

    const ps1Text = readFileSync(res.ps1Path, 'utf8');
    expect(ps1Text).toContain('function Ensure-WindowsReleasePublisherTrust');
    expect(ps1Text).toContain(`[string]$TrustedSignerSha256 = "${signerHex}"`);
    expect(ps1Text).toContain("'TrustedPeople', 'TrustedPublisher'");
    expect(ps1Text).toContain('function Install-RemoteDesktopVirtualDisplay');
    expect(ps1Text).toContain('ZipFile]::ExtractToDirectory');
    expect(ps1Text).toContain('pnputil.exe');
    expect(ps1Text).toContain('imcodes-virtual-display.inf');
    expect(ps1Text).toContain('imcodes-node-health-watchdog.ps1');
    expect(ps1Text).not.toContain('--health-watchdog');
    expect(ps1Text).not.toContain("\\$ErrorActionPreference = 'Stop'");
    expect(ps1Text.slice(ps1Text.indexOf('function Get-WindowsLockOwnership'), ps1Text.indexOf('function Get-WindowsServicesSnapshot'))).not.toContain('Win32_Process');
    expect(ps1Text).not.toMatch(/[^\x00-\x7f]/);

    // Also verify parent directory containing win32-x64/ works without double-nesting win32-x64/win32-x64
    const workDir2 = join(root, 'win-work2');
    await buildWindowsInstaller({
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeExe,
      remoteDesktopDir: join(root, 'ci-rd'),
      workDir: workDir2,
      keepWorkDir: true,
      outDir: join(root, 'win-out2'),
    });
    expect(
      existsSync(join(workDir2, 'stage', 'controlled-node', 'remote-desktop-worker', 'win32-x64', 'imcodes-remote-desktop-worker.exe')),
    ).toBe(true);
    expect(
      existsSync(join(workDir2, 'stage', 'controlled-node', 'remote-desktop-worker', 'win32-x64', 'win32-x64')),
    ).toBe(false);
  });

  it.runIf(process.platform === 'linux')(
    'verifies Linux /proc lock startToken ownership: ignores stale PID reuse, stops matching owner, and fails closed on unknown/unprobeable tokens (F3-R2)',
    async () => {
      const root = makeTempDir();
      const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
      const outDir = join(root, 'out-lock');
      const res = await buildLinuxInstallers({
        arch: 'x64',
        version: '0.9.5',
        runtimeDir,
        outDir,
        skipDeb: true,
      });

      // 1) Counterexample regression: unrelated node worker + mismatched startToken=linux:0 must NOT be signaled or passed to stop hook
      const unrelated = await spawnWorkerNode('setInterval(() => {}, 1000); // unrelated-worker');
      const hookLog = join(root, 'hook-calls.log');
      const spyStopHook = join(root, 'spy-stop-hook.sh');
      writeFileSync(spyStopHook, `#!/bin/sh\necho "HOOK:$1" >> "${hookLog}"\nexit 0\n`);
      chmodSync(spyStopHook, 0o755);

      const setupTakeoverRoot = (name: string, lockPayload: unknown) => {
        const iso = join(root, `iso-${name}`);
        const home = join(root, `home-${name}`);
        const stateDir = join(home, '.imcodes');
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(
          join(stateDir, 'last-upgrade-error.json'),
          JSON.stringify({ exitCode: -2147020576 }),
        );
        writeFileSync(join(stateDir, 'daemon.lock.json'), JSON.stringify(lockPayload));
        return { iso, home, stateDir };
      };

      try {
        const stalePre = setupTakeoverRoot('stale-pre', { version: 1, pid: unrelated.pid, startToken: 'linux:0' });
        const preOut = execFileSync(
          res.shPath,
          ['--phase', 'preinstall', '--isolated-root', stalePre.iso, '--home', stalePre.home, '--no-service-control'],
          { env: { ...process.env, IMCODES_STOP_DAEMON_HOOK: spyStopHook }, encoding: 'utf8' },
        );
        expect(preOut).toBe('');
        expect(isPidAliveNode(unrelated.pid!)).toBe(true);
        expect(existsSync(hookLog)).toBe(false);

        const staleFull = setupTakeoverRoot('stale-full', { version: 1, pid: unrelated.pid, startToken: 'linux:0' });
        const fullOut = execFileSync(
          res.shPath,
          ['--isolated-root', staleFull.iso, '--home', staleFull.home, '--no-service-control'],
          { encoding: 'utf8' },
        );
        expect(fullOut).toContain('INSTALL_OK scenario=legacy_broken_takeover');
        expect(isPidAliveNode(unrelated.pid!)).toBe(true);

        // 2) Fail-closed on missing startToken / unknown scheme / cross-scheme / unreadable /proc (even if cmdline contains node/index.js)
        const failWorker = await spawnWorkerNode('setInterval(() => {}, 1000); // /fake/imcodes/index.js');
        try {
          for (const [label, lockObj, extraEnv] of [
            ['missing-token', { version: 1, pid: failWorker.pid }, {}],
            ['unknown-scheme', { version: 1, pid: failWorker.pid, startToken: 'runtime:1234' }, {}],
            ['cross-scheme', { version: 1, pid: failWorker.pid, startToken: 'windows:1234' }, {}],
            [
              'probe-failed',
              { version: 1, pid: failWorker.pid, startToken: readStartTokenForPid(failWorker.pid!) },
              { IMCODES_PROC_DIR: join(root, 'missing-proc') },
            ],
          ] as Array<[string, unknown, Record<string, string>]>) {
            const fc = setupTakeoverRoot(label, lockObj);
            let aborted = false;
            try {
              execFileSync(
                res.shPath,
                ['--phase', 'preinstall', '--isolated-root', fc.iso, '--home', fc.home, '--no-service-control'],
                { env: { ...process.env, ...extraEnv }, encoding: 'utf8' },
              );
            } catch {
              aborted = true;
            }
            expect(aborted).toBe(true);
            expect(isPidAliveNode(failWorker.pid!)).toBe(true);
            expect(existsSync(join(fc.iso, 'daemon-runtime', 'rollback', 'latest', 'snapshot.env'))).toBe(false);
          }
        } finally {
          try {
            failWorker.kill('SIGKILL');
          } catch {}
        }

        // 3) Positive owner match: real matching startToken stops owner cleanly without any hook
        const owner = await spawnWorkerNode('setInterval(() => {}, 1000);');
        try {
          const ownCtx = setupTakeoverRoot('owner-match', {
            version: 1,
            pid: owner.pid,
            startToken: readStartTokenForPid(owner.pid!),
          });
          const ownOut = execFileSync(
            res.shPath,
            ['--isolated-root', ownCtx.iso, '--home', ownCtx.home, '--no-service-control'],
            { encoding: 'utf8' },
          );
          expect(ownOut).toContain('INSTALL_OK scenario=legacy_broken_takeover');
          await new Promise((r) => setTimeout(r, 80));
          expect(isPidAliveNode(owner.pid!)).toBe(false);
        } finally {
          try {
            owner.kill('SIGKILL');
          } catch {}
        }

        // 4) Dead PID and Zombie (Z) proc state proceed without error
        const deadCtx = setupTakeoverRoot('dead-pid', { version: 1, pid: 9999999, startToken: 'linux:123' });
        expect(
          execFileSync(
            res.shPath,
            ['--isolated-root', deadCtx.iso, '--home', deadCtx.home, '--no-service-control'],
            { encoding: 'utf8' },
          ),
        ).toContain('INSTALL_OK');

        const fakeProcDir = join(root, 'fake-proc-z');
        mkdirSync(join(fakeProcDir, String(unrelated.pid!)), { recursive: true });
        writeFileSync(
          join(fakeProcDir, String(unrelated.pid!), 'stat'),
          `${unrelated.pid!} (node) Z 1 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 999999 0 0`,
        );
        const zombieCtx = setupTakeoverRoot('zombie-pid', {
          version: 1,
          pid: unrelated.pid,
          startToken: 'linux:123',
        });
        expect(
          execFileSync(
            res.shPath,
            ['--isolated-root', zombieCtx.iso, '--home', zombieCtx.home, '--no-service-control'],
            { env: { ...process.env, IMCODES_PROC_DIR: fakeProcDir }, encoding: 'utf8' },
          ),
        ).toContain('INSTALL_OK');
        expect(isPidAliveNode(unrelated.pid!)).toBe(true);
      } finally {
        try {
          unrelated.kill('SIGKILL');
        } catch {}
      }
  }, 60_000);

  it('verifies macOS ps lock startToken ownership: ignores mismatch, fails closed on unknown scheme, and stops matching owner (F3-R2)', async () => {
    const root = makeTempDir();
    const setupTakeoverRoot = (name: string, lockPayload: unknown) => {
      const iso = join(root, `iso-${name}`);
      const home = join(root, `home-${name}`);
      const stateDir = join(home, '.imcodes');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'last-upgrade-error.json'),
        JSON.stringify({ exitCode: -2147020576 }),
      );
      writeFileSync(join(stateDir, 'daemon.lock.json'), JSON.stringify(lockPayload));
      return { iso, home, stateDir };
    };

    const unrelated = await spawnWorkerNode('setInterval(() => {}, 1000); // mac-unrelated-worker');
    try {
      const macRtLock = createFakeRuntimeDir(root, 'darwin', '0.9.5');
      const macStageLock = await buildMacosInstaller({
        arch: 'arm64',
        version: '0.9.5',
        runtimeDir: macRtLock,
        stageDir: join(root, 'mac-lock-stage'),
        emitStageOnly: true,
      });
      const macLockRunner = join(macStageLock.scriptsDir, 'phase-a-runner.sh');
      const fakePs = join(root, 'fake-ps');
      writeFileSync(
        fakePs,
        `#!/bin/sh
for a in "$@"; do last="$a"; done
if [ "$last" = "9999999" ]; then exit 1; fi
if [ -r "/proc/$last/stat" ]; then
  st="$(awk '{ idx=0; for(i=length($0);i>=1;i--) if(substr($0,i,1)==")"){idx=i;break}; rest=substr($0,idx+1); sub(/^[[:space:]]+/,"",rest); split(rest,f,/[[:space:]]+/); print f[1] }' "/proc/$last/stat" 2>/dev/null || true)"
else
  st="$(ps -o state= -p "$last" 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$st" ] || exit 1
fi
case "$st" in
  Z*|X*) echo "Z    Sat Nov 14  1:02:03 2026" ;;
  *) echo "Ss   Sat Nov 14  1:02:03 2026" ;;
esac
`,
        { mode: 0o755 },
      );
      const macMismatch = setupTakeoverRoot('mac-mismatch', {
        version: 1,
        pid: unrelated.pid,
        startToken: 'ps:Sat Nov 14 00:00:00 2026',
      });
      expect(
        execFileSync(
          macLockRunner,
          ['--isolated-root', macMismatch.iso, '--home', macMismatch.home, '--confirm-fda-switch', '--no-service-control'],
          { env: { ...process.env, IMCODES_PS_BIN: fakePs }, encoding: 'utf8' },
        ),
      ).toContain('INSTALL_OK');
      expect(isPidAliveNode(unrelated.pid!)).toBe(true);

      const macUnknown = setupTakeoverRoot('mac-unknown', {
        version: 1,
        pid: unrelated.pid,
        startToken: 'linux:123',
      });
      expect(() =>
        execFileSync(
          macLockRunner,
          ['--isolated-root', macUnknown.iso, '--home', macUnknown.home, '--confirm-fda-switch', '--no-service-control'],
          { env: { ...process.env, IMCODES_PS_BIN: fakePs }, encoding: 'utf8' },
        ),
      ).toThrow();
      expect(isPidAliveNode(unrelated.pid!)).toBe(true);

      const macOwner = await spawnWorkerNode('setInterval(() => {}, 1000);');
      try {
        const macOwnCtx = setupTakeoverRoot('mac-owner', {
          version: 1,
          pid: macOwner.pid,
          startToken: 'ps:Sat Nov 14 1:02:03 2026',
        });
        expect(
          execFileSync(
            macLockRunner,
            ['--isolated-root', macOwnCtx.iso, '--home', macOwnCtx.home, '--confirm-fda-switch', '--no-service-control'],
            { env: { ...process.env, IMCODES_PS_BIN: fakePs }, encoding: 'utf8' },
          ),
        ).toContain('INSTALL_OK');
        await new Promise((r) => setTimeout(r, 80));
        expect(isPidAliveNode(macOwner.pid!)).toBe(false);
      } finally {
        try {
          macOwner.kill('SIGKILL');
        } catch {}
      }
    } finally {
      try {
        unrelated.kill('SIGKILL');
      } catch {}
    }
  });

  const createStatefulSystemctl = (
    binDir: string,
    statePath: string,
    logPath: string,
    initial: Record<string, { enabled: boolean; active: boolean }>,
  ) => {
    let initialContent = '';
    for (const [k, v] of Object.entries(initial)) {
      initialContent += `${k} ${v.enabled ? '1' : '0'} ${v.active ? '1' : '0'}\n`;
    }
    writeFileSync(statePath, initialContent);
    const bin = join(binDir, `fake-systemctl-${Math.random().toString(36).slice(2, 8)}.sh`);
    writeFileSync(
      bin,
      `#!/bin/sh
set -e
state_file=${JSON.stringify(statePath)}
log_file=${JSON.stringify(logPath)}

echo "$*" >> "$log_file"

is_user=0
if [ "$1" = "--user" ]; then
  is_user=1
  shift
fi

cmd="$1"
unit="$2"

if [ -n "$unit" ]; then
  if [ "$is_user" -eq 1 ]; then
    key="user:$unit"
  else
    key="sys:$unit"
  fi
else
  key=""
fi

if [ "$cmd" = "daemon-reload" ] || [ "$cmd" = "reset-failed" ]; then
  exit 0
fi

cur_enabled=0
cur_active=0
found=0

if [ -f "$state_file" ] && [ -n "$key" ]; then
  while read -r k en ac || [ -n "$k" ]; do
    if [ "$k" = "$key" ]; then
      cur_enabled="$en"
      cur_active="$ac"
      found=1
      break
    fi
  done < "$state_file"
fi

if [ "$cmd" = "is-enabled" ]; then
  if [ "$found" -eq 1 ] && [ "$cur_enabled" = "1" ]; then
    exit 0
  else
    exit 1
  fi
fi

if [ "$cmd" = "is-active" ]; then
  if [ "$found" -eq 1 ] && [ "$cur_active" = "1" ]; then
    exit 0
  else
    exit 3
  fi
fi

if [ "$cmd" = "enable" ]; then
  cur_enabled=1
elif [ "$cmd" = "disable" ]; then
  cur_enabled=0
elif [ "$cmd" = "start" ] || [ "$cmd" = "restart" ]; then
  cur_active=1
elif [ "$cmd" = "stop" ]; then
  cur_active=0
fi

tmp_file="\${state_file}.tmp.$$"
: > "$tmp_file"
if [ -f "$state_file" ]; then
  while read -r k en ac || [ -n "$k" ]; do
    if [ -n "$k" ] && [ "$k" != "$key" ]; then
      echo "$k $en $ac" >> "$tmp_file"
    fi
  done < "$state_file"
fi
if [ -n "$key" ]; then
  echo "$key $cur_enabled $cur_active" >> "$tmp_file"
fi
mv "$tmp_file" "$state_file"
exit 0
`,
      { mode: 0o755 },
    );
    return bin;
  };

  const readSystemctlState = (statePath: string) => {
    const result: Record<string, { enabled: boolean; active: boolean }> = {};
    if (!existsSync(statePath)) return result;
    const lines = readFileSync(statePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [key, enabled, active] = line.split(' ');
      result[key] = { enabled: enabled === '1', active: active === '1' };
    }
    return result;
  };

  const createFakeLaunchctl = (
    binDir: string,
    statePath: string,
    logPath: string,
    initial: Record<string, { loaded: boolean; active: boolean; plist?: string }>,
  ) => {
    let initialContent = '';
    for (const [k, v] of Object.entries(initial)) {
      initialContent += `${k} ${v.loaded ? '1' : '0'} ${v.active ? '1' : '0'} ${v.plist || ''}\n`;
    }
    writeFileSync(statePath, initialContent);
    const bin = join(binDir, `fake-launchctl-${Math.random().toString(36).slice(2, 8)}.sh`);
    writeFileSync(
      bin,
      `#!/bin/sh
set -e
state_file=${JSON.stringify(statePath)}
log_file=${JSON.stringify(logPath)}

echo "$*" >> "$log_file"

cmd="$1"

if [ "$cmd" = "print" ]; then
  lbl="$2"
  found=0
  ld=0
  ac=0
  if [ -f "$state_file" ]; then
    while read -r k l a p || [ -n "$k" ]; do
      if [ "$k" = "$lbl" ]; then
        found=1
        ld="$l"
        ac="$a"
        break
      fi
    done < "$state_file"
  fi
  if [ "$found" -ne 1 ] || [ "$ld" -ne 1 ]; then
    exit 113
  fi
  if [ "$ac" = "1" ]; then
    echo "state = running"
  else
    echo "state = not running"
  fi
  exit 0
fi

if [ "$cmd" = "bootout" ]; then
  lbl="$2"
  tmp_file="\${state_file}.tmp.$$"
  : > "$tmp_file"
  if [ -f "$state_file" ]; then
    while read -r k l a p || [ -n "$k" ]; do
      if [ -n "$k" ] && [ "$k" != "$lbl" ]; then
        if [ -n "$p" ]; then
          echo "$k $l $a $p" >> "$tmp_file"
        else
          echo "$k $l $a" >> "$tmp_file"
        fi
      fi
    done < "$state_file"
  fi
  mv "$tmp_file" "$state_file"
  exit 0
fi

if [ "$cmd" = "bootstrap" ]; then
  domain="$2"
  plist="$3"
  extracted_lbl=$(awk '
    /<key>Label<\\/key>/ {
      rest = substr($0, index($0, "<key>Label</key>") + 16);
      if (match(rest, /<string>[^<]+<\\/string>/)) {
        val = substr(rest, RSTART + 8, RLENGTH - 17);
        print val;
        exit;
      }
      saw_label = 1;
      next;
    }
    saw_label && match($0, /<string>[^<]+<\\/string>/) {
      val = substr($0, RSTART + 8, RLENGTH - 17);
      print val;
      exit;
    }
  ' "$plist" 2>/dev/null)
  if [ -n "$extracted_lbl" ]; then
    lbl="$domain/$extracted_lbl"
  else
    lbl="$domain/unknown"
  fi
  tmp_file="\${state_file}.tmp.$$"
  : > "$tmp_file"
  if [ -f "$state_file" ]; then
    while read -r k l a p || [ -n "$k" ]; do
      if [ -n "$k" ] && [ "$k" != "$lbl" ]; then
        if [ -n "$p" ]; then
          echo "$k $l $a $p" >> "$tmp_file"
        else
          echo "$k $l $a" >> "$tmp_file"
        fi
      fi
    done < "$state_file"
  fi
  echo "$lbl 1 0 $plist" >> "$tmp_file"
  mv "$tmp_file" "$state_file"
  exit 0
fi

if [ "$cmd" = "kickstart" ]; then
  for last_arg in "$@"; do :; done
  lbl="$last_arg"
  tmp_file="\${state_file}.tmp.$$"
  : > "$tmp_file"
  if [ -f "$state_file" ]; then
    while read -r k l a p || [ -n "$k" ]; do
      if [ "$k" = "$lbl" ]; then
        if [ -n "$p" ]; then
          echo "$k $l 1 $p" >> "$tmp_file"
        else
          echo "$k $l 1" >> "$tmp_file"
        fi
      elif [ -n "$k" ]; then
        if [ -n "$p" ]; then
          echo "$k $l $a $p" >> "$tmp_file"
        else
          echo "$k $l $a" >> "$tmp_file"
        fi
      fi
    done < "$state_file"
  fi
  mv "$tmp_file" "$state_file"
  exit 0
fi

exit 0
`,
      { mode: 0o755 },
    );
    return bin;
  };

  const readLaunchState = (statePath: string) => {
    const result: Record<string, { loaded: boolean; active: boolean; plist?: string }> = {};
    if (!existsSync(statePath)) return result;
    const lines = readFileSync(statePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [lbl, loaded, active, plist] = line.split(' ');
      result[lbl] = { loaded: loaded === '1', active: active === '1', plist: plist || '' };
    }
    return result;
  };

  it('snapshots and reconciles Linux systemctl services on rollback on clean system (F4-R2)', async () => {
    const root = makeTempDir('f4-r2-clean-');
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const nodeBin = join(root, 'imcodes-node');
    writeFileSync(nodeBin, '#!/bin/sh\necho node\n', { mode: 0o755 });
    const res = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir,
      nodeExe: nodeBin,
      outDir: join(root, 'out-svc'),
      skipDeb: true,
    });

    const st1 = join(root, 'st-clean.txt');
    const log1 = join(root, 'log-clean.txt');
    const sc1 = createStatefulSystemctl(root, st1, log1, {});
    const iso1 = join(root, 'iso-clean');
    const home1 = join(root, 'home-clean');
    execFileSync(
      res.shPath,
      ['--isolated-root', iso1, '--home', home1, '--apply-services'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc1 }, encoding: 'utf8' },
    );
    expect(readSystemctlState(st1)['user:imcodes.service']).toEqual({ enabled: true, active: true });
    execFileSync(
      res.shPath,
      ['--isolated-root', iso1, '--home', home1, '--rollback'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc1 }, encoding: 'utf8' },
    );
    const afterClean = readSystemctlState(st1);
    expect(afterClean['user:imcodes.service']).toEqual({ enabled: false, active: false });
    expect(existsSync(join(home1, '.config', 'systemd', 'user', 'imcodes.service'))).toBe(false);
    expect(existsSync(join(home1, '.config', 'systemd', 'user', 'default.target.wants', 'imcodes.service'))).toBe(false);
    expect(existsSync(join(iso1, 'controlled-node', 'imcodes-node'))).toBe(false);
    expect(readFileSync(log1, 'utf8')).toContain('reset-failed imcodes.service');
  }, 60_000);

  it('snapshots and reconciles Linux systemctl services on rollback with pre-existing stopped unit (F4-R2)', async () => {
    const root = makeTempDir('f4-r2-stopped-');
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const nodeBin = join(root, 'imcodes-node');
    writeFileSync(nodeBin, '#!/bin/sh\necho node\n', { mode: 0o755 });
    const res = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir,
      nodeExe: nodeBin,
      outDir: join(root, 'out-svc'),
      skipDeb: true,
    });

    const st2 = join(root, 'st-stopped.txt');
    const log2 = join(root, 'log-stopped.txt');
    const sc2 = createStatefulSystemctl(root, st2, log2, {
      'user:imcodes.service': { enabled: false, active: false },
    });
    const iso2 = join(root, 'iso-stopped');
    const home2 = join(root, 'home-stopped');
    mkdirSync(join(home2, '.config', 'systemd', 'user'), { recursive: true });
    const oldUnit = '[Unit]\nDescription=OldStopped\n[Service]\nExecStart=/old/node /old/missing.js\n';
    writeFileSync(join(home2, '.config', 'systemd', 'user', 'imcodes.service'), oldUnit);
    execFileSync(
      res.shPath,
      ['--isolated-root', iso2, '--home', home2, '--force-takeover', '--apply-services'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc2 }, encoding: 'utf8' },
    );
    expect(readSystemctlState(st2)['user:imcodes.service']).toEqual({ enabled: true, active: true });
    execFileSync(
      res.shPath,
      ['--isolated-root', iso2, '--home', home2, '--rollback'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc2 }, encoding: 'utf8' },
    );
    const afterStopped = readSystemctlState(st2);
    expect(afterStopped['user:imcodes.service']).toEqual({ enabled: false, active: false });
    expect(readFileSync(join(home2, '.config', 'systemd', 'user', 'imcodes.service'), 'utf8')).toBe(oldUnit);
  }, 60_000);

  it('snapshots and reconciles Linux systemctl services on rollback with pre-existing active unit (F4-R2)', async () => {
    const root = makeTempDir('f4-r2-active-');
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const nodeBin = join(root, 'imcodes-node');
    writeFileSync(nodeBin, '#!/bin/sh\necho node\n', { mode: 0o755 });
    const res = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir,
      nodeExe: nodeBin,
      outDir: join(root, 'out-svc'),
      skipDeb: true,
    });

    const st3 = join(root, 'st-active.txt');
    const log3 = join(root, 'log-active.txt');
    const sc3 = createStatefulSystemctl(root, st3, log3, {
      'user:imcodes.service': { enabled: true, active: true },
    });
    const iso3 = join(root, 'iso-active');
    const home3 = join(root, 'home-active');
    mkdirSync(join(home3, '.config', 'systemd', 'user'), { recursive: true });
    const oldActiveUnit = '[Unit]\nDescription=OldActive\n[Service]\nExecStart=/old/active/node\n';
    writeFileSync(join(home3, '.config', 'systemd', 'user', 'imcodes.service'), oldActiveUnit);
    execFileSync(
      res.shPath,
      ['--isolated-root', iso3, '--home', home3, '--force-takeover', '--apply-services'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc3 }, encoding: 'utf8' },
    );
    execFileSync(
      res.shPath,
      ['--isolated-root', iso3, '--home', home3, '--rollback'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc3 }, encoding: 'utf8' },
    );
    const afterActive = readSystemctlState(st3);
    expect(afterActive['user:imcodes.service']).toEqual({ enabled: true, active: true });
    expect(readFileSync(join(home3, '.config', 'systemd', 'user', 'imcodes.service'), 'utf8')).toBe(oldActiveUnit);
  }, 60_000);

  it('snapshots and reconciles macOS launchctl services across active and stopped states on rollback (F4-R2)', async () => {
    const root = makeTempDir('f4-r2-macos-');
    const macRt = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const nodeBin = join(root, 'imcodes-node');
    writeFileSync(nodeBin, '#!/bin/sh\necho node\n', { mode: 0o755 });
    const macStage = await buildMacosInstaller({
      arch: 'arm64',
      version: '0.9.5',
      runtimeDir: macRt,
      nodeExe: nodeBin,
      stageDir: join(root, 'mac-svc-stage'),
      emitStageOnly: true,
    });
    const macRunner = join(macStage.scriptsDir, 'phase-a-runner.sh');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const daemonLabel = `gui/${uid}/imcodes.daemon`;
    const launchStateFile = join(root, 'launchctl-state.txt');
    const launchLogFile = join(root, 'launchctl-log.txt');
    const fakeLaunchctl = createFakeLaunchctl(root, launchStateFile, launchLogFile, {
      [daemonLabel]: { loaded: true, active: true, plist: '' },
    });

    const isoMac = join(root, 'iso-mac-svc');
    const homeMac = join(root, 'home-mac-svc');
    const macPlistDir = join(homeMac, 'Library', 'LaunchAgents');
    mkdirSync(macPlistDir, { recursive: true });
    const oldMacPlist =
      '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>imcodes.daemon</string><key>ProgramArguments</key><array><string>/old/bin/imcodes</string></array></dict></plist>\n';
    writeFileSync(join(macPlistDir, 'imcodes.daemon.plist'), oldMacPlist);
    execFileSync(
      macRunner,
      ['--isolated-root', isoMac, '--home', homeMac, '--confirm-fda-switch', '--force-takeover', '--apply-services'],
      { env: { ...process.env, IMCODES_LAUNCHCTL_BIN: fakeLaunchctl }, encoding: 'utf8' },
    );
    execFileSync(
      macRunner,
      ['--isolated-root', isoMac, '--home', homeMac, '--rollback'],
      { env: { ...process.env, IMCODES_LAUNCHCTL_BIN: fakeLaunchctl }, encoding: 'utf8' },
    );
    const macStateAfter = readLaunchState(launchStateFile);
    expect(macStateAfter[daemonLabel]?.loaded).toBe(true);
    expect(macStateAfter[daemonLabel]?.active).toBe(true);
    expect(macStateAfter['system/cc.imcodes.node']).toBeUndefined();
    expect(macStateAfter['system/cc.imcodes.node.watchdog']).toBeUndefined();
    expect(readFileSync(join(macPlistDir, 'imcodes.daemon.plist'), 'utf8')).toBe(oldMacPlist);
    expect(readFileSync(launchLogFile, 'utf8')).toContain(`bootout ${daemonLabel}`);
  }, 60_000);

  it('rejects POSIX ancestor/leaf symlink cycles and ..-after-symlink escapes cleanly without hanging on Linux and macOS runners (F6-R3)', async () => {
    const root = makeTempDir('imcodes-f6-r3-');
    const linuxRt = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const linuxBuild = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir: linuxRt,
      nodeExe: join(linuxRt, 'bin', 'node'),
      outDir: join(root, 'out-lin'),
      skipDeb: true,
    });
    const macRt = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const macStage = await buildMacosInstaller({
      arch: 'arm64',
      version: '0.9.5',
      runtimeDir: macRt,
      nodeExe: join(macRt, 'bin', 'node'),
      outDir: join(root, 'out-mac'),
      stageDir: join(root, 'mac-f6-stage'),
      emitStageOnly: true,
    });

    const runners = [
      { platform: 'linux', runner: linuxBuild.shPath },
      { platform: 'darwin', runner: join(macStage.scriptsDir, 'phase-a-runner.sh') },
    ] as const;

    for (const { platform, runner } of runners) {
      const iso = join(root, `iso-${platform}`);
      const callerHome = join(root, `caller-home-${platform}`);
      const callerSub = join(callerHome, 'sub');
      const realHome = join(iso, 'real-home');
      mkdirSync(realHome, { recursive: true });
      mkdirSync(callerSub, { recursive: true });

      // Leaf cycle: leaf-a <-> leaf-b
      symlinkSync(join(iso, 'leaf-b'), join(iso, 'leaf-a'));
      symlinkSync(join(iso, 'leaf-a'), join(iso, 'leaf-b'));

      // Ancestor suffix cycle (R3 counterexample): anc-a -> anc-b/child, anc-b -> anc-a/child
      symlinkSync(join('anc-b', 'child'), join(iso, 'anc-a'));
      symlinkSync(join('anc-a', 'child'), join(iso, 'anc-b'));

      // Multi-hop relative ancestor cycle: dir1/hop2 -> ../hop1/child, hop1 -> dir1/hop2
      mkdirSync(join(iso, 'dir1'), { recursive: true });
      symlinkSync(join('dir1', 'hop2'), join(iso, 'hop1'));
      symlinkSync(join('..', 'hop1', 'child'), join(iso, 'dir1', 'hop2'));

      // `..` after symlink escaping into protected real home subdir (lexically looks like <iso>/.imcodes)
      symlinkSync(callerSub, join(iso, 'sym-real'));

      // Bounded intra-isolated symlink chain positive control
      symlinkSync('real-home', join(iso, 'link-2'));
      symlinkSync('link-2', join(iso, 'link-1'));

      const negativeCases = [
        { label: `${platform}:leaf-cycle`, homeArg: join(iso, 'leaf-a'), expectMsg: /symlink loop/i },
        { label: `${platform}:ancestor-suffix-cycle`, homeArg: join(iso, 'anc-a'), expectMsg: /symlink loop/i },
        { label: `${platform}:ancestor-suffix-nested`, homeArg: join(iso, 'anc-a', 'nested'), expectMsg: /symlink loop/i },
        { label: `${platform}:multihop-rel-cycle`, homeArg: join(iso, 'hop1'), expectMsg: /symlink loop/i },
        {
          label: `${platform}:dotdot-after-symlink-escape`,
          homeArg: `${join(iso, 'sym-real')}/../.imcodes`,
          expectMsg: /real home subdir|unsafe isolated target/i,
        },
      ];

      for (const tc of negativeCases) {
        const started = Date.now();
        const res = spawnSync(
          runner,
          ['--isolated-root', iso, '--home', tc.homeArg, '--no-service-control', '--dry-run'],
          {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, HOME: callerHome },
          },
        );
        const elapsedMs = Date.now() - started;
        expect(res.signal, tc.label).toBeNull();
        expect(res.status, tc.label).not.toBe(0);
        expect(elapsedMs, tc.label).toBeLessThan(4000);
        expect(res.stderr, tc.label).toMatch(tc.expectMsg);
        expect(existsSync(join(iso, 'rollback-snapshots')), tc.label).toBe(false);
        expect(existsSync(join(iso, 'daemon-runtime')), tc.label).toBe(false);
      }

      const posRes = spawnSync(
        runner,
        ['--isolated-root', iso, '--home', join(iso, 'link-1'), '--no-service-control', '--dry-run'],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, HOME: callerHome },
        },
      );
      expect(posRes.signal, `${platform}:positive-bounded-chain`).toBeNull();
      expect(posRes.status, `${platform}:positive-bounded-chain:${posRes.stderr}`).toBe(0);
    }
  }, 30_000);

  it('stages and builds Linux/macOS/Windows installers cleanly from --runtime-archive (tar.gz and zip)', async () => {
    const root = makeTempDir('imcodes-runtime-archive-');

    // Linux tar.gz -> stageDaemonRuntimePayload + buildLinuxInstallers
    const linuxRtDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const linuxArchive = join(root, 'daemon-runtime-linux-x64.tar.gz');
    createArchiveFromDir(linuxRtDir, linuxArchive, 'tar.gz');
    const stagedLinux = stageDaemonRuntimePayload({
      runtimeArchive: linuxArchive,
      target: 'linux-x64',
      destReleaseDir: join(root, 'staged-linux'),
    });
    expect(existsSync(join(stagedLinux, 'bin', 'node'))).toBe(true);
    expect(existsSync(join(stagedLinux, 'package', 'dist', 'src', 'index.js'))).toBe(true);

    const linuxBuilt = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeArchive: linuxArchive,
      outDir: join(root, 'out-linux-archive'),
      skipDeb: true,
    });
    expect(existsSync(linuxBuilt.shPath)).toBe(true);

    // macOS tar.gz -> buildMacosInstaller
    const macRtDir = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const macArchive = join(root, 'daemon-runtime-darwin-arm64.tar.gz');
    createArchiveFromDir(macRtDir, macArchive, 'tar.gz');
    const macBuilt = await buildMacosInstaller({
      arch: 'arm64',
      version: '0.9.5',
      runtimeArchive: macArchive,
      stageDir: join(root, 'mac-archive-stage'),
      emitStageOnly: true,
    });
    expect(existsSync(join(
      macBuilt.stageDir,
      'runtime-root',
      'Library',
      'Application Support',
      'imcodes',
      'daemon-runtime',
      'releases',
      '0.9.5',
      'bin',
      'node',
    ))).toBe(true);

    // Windows zip -> stageDaemonRuntimePayload + buildWindowsInstaller
    const winRtDir = createFakeRuntimeDir(root, 'win32', '0.9.5');
    const winArchive = join(root, 'daemon-runtime-win32-x64.zip');
    createArchiveFromDir(winRtDir, winArchive, 'zip');
    const winWorkDir = join(root, 'work-win-archive');
    await buildWindowsInstaller({
      version: '0.9.5',
      runtimeArchive: winArchive,
      outDir: join(root, 'out-win-archive'),
      workDir: winWorkDir,
      keepWorkDir: true,
    });
    expect(existsSync(join(winWorkDir, 'stage', 'daemon-runtime', 'node.exe'))).toBe(true);

    // Malformed archive missing expected target binary must fail loudly with diagnostic context
    const emptyArchiveSrc = join(root, 'empty-runtime');
    mkdirSync(join(emptyArchiveSrc, 'package'), { recursive: true });
    writeFileSync(join(emptyArchiveSrc, 'package', 'package.json'), '{}');
    const badArchive = join(root, 'bad-linux.tar.gz');
    createArchiveFromDir(emptyArchiveSrc, badArchive, 'tar.gz');
    expect(() => stageDaemonRuntimePayload({
      runtimeArchive: badArchive,
      target: 'linux-x64',
      destReleaseDir: join(root, 'staged-bad'),
    })).toThrow(/daemon-runtime archive missing bin\/node/);
  });

  it('validates Windows signing config fail-closed across options, CLI flags, and env', () => {
    const thumbprint = '63163EEE65A565328BEDACCB0981C1DE6883FD8C';
    const sha256Upper = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    const sha256Lower = sha256Upper.toLowerCase();

    const prevThumbprint = process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
    const prevSha256 = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
    const prevTimestampUrl = process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;
    try {
      delete process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
      delete process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
      delete process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;

      expect(resolveWindowsSigningConfig({})).toBeNull();

      const cliParsed = parseCliArgs([
        '--signing-thumbprint',
        ` ${thumbprint} `,
        '--expected-signer-sha256',
        ` ${sha256Upper} `,
        '--timestamp-url',
        ' http://timestamp.example.test ',
      ]);
      expect(resolveWindowsSigningConfig(cliParsed)).toEqual({
        thumbprint,
        expectedSha256: sha256Lower,
        timestampUrl: 'http://timestamp.example.test',
      });

      expect(() =>
        resolveWindowsSigningConfig({ signingThumbprint: thumbprint }),
      ).toThrow(/IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256/);
      expect(() =>
        resolveWindowsSigningConfig({ expectedSignerSha256: sha256Upper }),
      ).toThrow(/IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256/);
      expect(() =>
        resolveWindowsSigningConfig({
          signingThumbprint: 'not-a-thumbprint',
          expectedSignerSha256: sha256Upper,
        }),
      ).toThrow(/40-char SHA-1 hex/);
      expect(() =>
        resolveWindowsSigningConfig({
          signingThumbprint: thumbprint,
          expectedSignerSha256: 'not-a-sha256',
        }),
      ).toThrow(/64-char SHA-256 hex/);
    } finally {
      if (prevThumbprint === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
      else process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT = prevThumbprint;
      if (prevSha256 === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
      else process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 = prevSha256;
      if (prevTimestampUrl === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;
      else process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL = prevTimestampUrl;
    }
  });

  it.runIf(process.platform !== 'win32')(
    'passes -ExpectedSignerSha256 and -TimestampUrl in -Mode Sign, verifies, fails closed when missing, and keeps unsigned builds clean',
    async () => {
      const root = makeTempDir();
      const runtimeDir = createFakeRuntimeDir(root, 'win32', '0.9.5');
      const shimDir = join(root, 'bin');
      mkdirSync(shimDir, { recursive: true });
      const logPath = join(root, 'ps-calls.jsonl');

      const fakeIscc = join(shimDir, 'ISCC.exe');
      writeFileSync(
        fakeIscc,
        `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const outArg = process.argv.find((a) => a.startsWith('/O'));
if (!outArg) process.exit(2);
const outDir = outArg.slice(2);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'imcodes-desktop-0.9.5-win32-x64.exe'), 'MZ-compiled');
`,
      );
      chmodSync(fakeIscc, 0o755);

      const fakePs = join(shimDir, 'powershell.exe');
      writeFileSync(
        fakePs,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const logFile = process.env.TEST_PS_LOG;
if (logFile) appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
      );
      chmodSync(fakePs, 0o755);

      const prevPath = process.env.PATH;
      const prevPsLog = process.env.TEST_PS_LOG;
      const prevThumb = process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
      const prevSha = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
      const prevTs = process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;

      const thumbprint = '63163EEE65A565328BEDACCB0981C1DE6883FD8C';
      const sha256Upper = 'FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210';
      const sha256Lower = sha256Upper.toLowerCase();

      try {
        process.env.PATH = `${shimDir}:${prevPath ?? ''}`;
        process.env.TEST_PS_LOG = logPath;

        // 1. Signed build via env vars passes -ExpectedSignerSha256 and -TimestampUrl in -Mode Sign + Verify
        process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT = ` ${thumbprint} `;
        process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 = ` ${sha256Upper} `;
        delete process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;

        const signedRes = await buildWindowsInstaller({
          version: '0.9.5',
          runtimeDir,
          outDir: join(root, 'out-signed'),
          isccPath: fakeIscc,
        });
        expect(signedRes.signed).toBe(true);
        const signedManifest = JSON.parse(readFileSync(`${signedRes.exePath}.manifest.json`, 'utf8'));
        expect(signedManifest.signed).toBe(true);

        const psCalls = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(psCalls).toHaveLength(2);
        expect(psCalls[0]).toEqual([
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(__dirname, '..', '..', 'scripts', 'windows-sign-release-artifact.ps1'),
          '-Mode',
          'Sign',
          '-ArtifactPath',
          signedRes.exePath,
          '-CodeSigningCertificateThumbprint',
          thumbprint,
          '-ExpectedSignerSha256',
          sha256Lower,
          '-TimestampUrl',
          'http://timestamp.digicert.com',
        ]);
        expect(psCalls[1]).toEqual([
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(__dirname, '..', '..', 'scripts', 'windows-sign-release-artifact.ps1'),
          '-Mode',
          'Verify',
          '-ArtifactPath',
          signedRes.exePath,
          '-ExpectedSignerSha256',
          sha256Lower,
        ]);

        // 2. Fail-closed when thumbprint is set without expected SHA-256 (must not call powershell.exe)
        writeFileSync(logPath, '');
        delete process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
        await expect(
          buildWindowsInstaller({
            version: '0.9.5',
            runtimeDir,
            outDir: join(root, 'out-missing-sha'),
            isccPath: fakeIscc,
          }),
        ).rejects.toThrow(/IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256/);
        expect(readFileSync(logPath, 'utf8')).toBe('');

        // 3. Unsigned build when neither thumbprint nor expected SHA-256 is configured
        delete process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
        const unsignedRes = await buildWindowsInstaller({
          version: '0.9.5',
          runtimeDir,
          outDir: join(root, 'out-unsigned'),
          isccPath: fakeIscc,
        });
        expect(unsignedRes.signed).toBe(false);
        expect(readFileSync(logPath, 'utf8')).toBe('');
        const unsignedManifest = JSON.parse(readFileSync(`${unsignedRes.exePath}.manifest.json`, 'utf8'));
        expect(unsignedManifest.signed).toBe(false);
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
        if (prevPsLog === undefined) delete process.env.TEST_PS_LOG;
        else process.env.TEST_PS_LOG = prevPsLog;
        if (prevThumb === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
        else process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT = prevThumb;
        if (prevSha === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
        else process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 = prevSha;
        if (prevTs === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL;
        else process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL = prevTs;
      }
    },
  );

  it('wires IMCODES_WINDOWS_SIGNING_CERT_SHA256 before build-windows-installer in CI workflows', () => {
    for (const rel of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const yamlText = readFileSync(join(__dirname, '..', '..', rel), 'utf8');
      const thumbIdx = yamlText.indexOf('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT=');
      const shaIdx = yamlText.indexOf('IMCODES_WINDOWS_SIGNING_CERT_SHA256=');
      const buildIdx = yamlText.indexOf('build-windows-installer.mjs');
      expect(thumbIdx, `${rel} missing IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT`).toBeGreaterThan(-1);
      expect(shaIdx, `${rel} missing IMCODES_WINDOWS_SIGNING_CERT_SHA256`).toBeGreaterThan(-1);
      expect(buildIdx, `${rel} missing build-windows-installer.mjs`).toBeGreaterThan(shaIdx);
    }
  });

  it('stages Linux remote-desktop and computer-use sidecars under linux-<arch> without double-nesting and wires .deb tmux/prerm/postrm', async () => {
    const root = makeTempDir();
    const runtimeDir = createFakeRuntimeDir(root, 'linux', '0.9.5');
    const fakeNodeExe = join(root, 'imcodes-node-linux');
    writeFileSync(fakeNodeExe, '#!/bin/sh\necho node-exe\n', { mode: 0o755 });

    // Simulate CI passing leaf .../linux-x64 sidecar directories
    const rdLeafDir = join(root, 'rd-src', 'linux-x64');
    const cuLeafDir = join(root, 'cu-src', 'linux-x64');
    mkdirSync(rdLeafDir, { recursive: true });
    mkdirSync(cuLeafDir, { recursive: true });
    writeFileSync(join(rdLeafDir, 'imcodes-linux-remote-desktop-worker'), '#!/bin/sh\necho rd\n', { mode: 0o755 });
    writeFileSync(join(cuLeafDir, 'open-computer-use'), '#!/bin/sh\necho cu\n', { mode: 0o755 });

    const outDir = join(root, 'out-leaf');
    const res = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir,
      nodeExe: fakeNodeExe,
      remoteDesktopDir: rdLeafDir,
      computerUseDir: cuLeafDir,
      outDir,
      skipDeb: !HAS_DPKG_DEB,
    });

    const isoRoot = join(root, 'iso-leaf');
    const isoHome = join(root, 'home-leaf');
    mkdirSync(isoHome, { recursive: true });
    execFileSync(
      res.shPath,
      ['--isolated-root', isoRoot, '--home', isoHome, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(existsSync(join(isoRoot, 'controlled-node', 'remote-desktop-worker', 'linux-x64', 'imcodes-linux-remote-desktop-worker'))).toBe(true);
    expect(existsSync(join(isoRoot, 'controlled-node', 'computer-use-helper', 'linux-x64', 'open-computer-use'))).toBe(true);
    expect(existsSync(join(isoRoot, 'controlled-node', 'remote-desktop-worker', 'imcodes-linux-remote-desktop-worker'))).toBe(false);
    expect(existsSync(join(isoRoot, 'controlled-node', 'remote-desktop-worker', 'linux-x64', 'linux-x64'))).toBe(false);

    // Also verify passing parent sidecar dir produces identical non-nested layout
    const outParent = join(root, 'out-parent');
    const resParent = await buildLinuxInstallers({
      arch: 'x64',
      version: '0.9.6',
      runtimeDir,
      nodeExe: fakeNodeExe,
      remoteDesktopDir: join(root, 'rd-src'),
      computerUseDir: join(root, 'cu-src'),
      outDir: outParent,
      skipDeb: true,
    });
    const isoParent = join(root, 'iso-parent');
    const homeParent = join(root, 'home-parent');
    mkdirSync(homeParent, { recursive: true });
    execFileSync(
      resParent.shPath,
      ['--isolated-root', isoParent, '--home', homeParent, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(existsSync(join(isoParent, 'controlled-node', 'remote-desktop-worker', 'linux-x64', 'imcodes-linux-remote-desktop-worker'))).toBe(true);
    expect(existsSync(join(isoParent, 'controlled-node', 'remote-desktop-worker', 'linux-x64', 'linux-x64'))).toBe(false);

    if (HAS_DPKG_DEB) {
      const debInfo = execFileSync('dpkg-deb', ['--info', res.debPath], { encoding: 'utf8' });
      expect(debInfo).toContain('Depends: systemd | bash, coreutils, tmux');
      const debContents = execFileSync('dpkg-deb', ['--contents', res.debPath], { encoding: 'utf8' });
      expect(debContents).toContain('./var/lib/imcodes-node/remote-desktop-worker/linux-x64/imcodes-linux-remote-desktop-worker');
      expect(debContents).toContain('./var/lib/imcodes-node/computer-use-helper/linux-x64/open-computer-use');
      const ctrlDir = join(root, 'deb-ctrl');
      execFileSync('dpkg-deb', ['--control', res.debPath, ctrlDir], { encoding: 'utf8' });
      expect(readFileSync(join(ctrlDir, 'preinst'), 'utf8')).toContain('--phase preinst');
      expect(readFileSync(join(ctrlDir, 'postinst'), 'utf8')).toContain('--phase postinst');
      expect(readFileSync(join(ctrlDir, 'prerm'), 'utf8')).toContain('--phase prerm-remove');
      expect(readFileSync(join(ctrlDir, 'postrm'), 'utf8')).toContain('/opt/imcodes/daemon-runtime/current');
      expect(readFileSync(join(ctrlDir, 'postrm'), 'utf8')).toContain('/usr/local/bin/imcodes');
    }
  });

  it('handles .deb clean scenario across preinstall->postinstall, systemd/bus-free run_systemctl_user, upgrade restart & prerm-remove', () => {
    const root = makeTempDir();
    const runnerPath = join(root, 'phase-a-runner.sh');
    const runnerText = renderPosixPhaseARunnerScript({
      platform: 'linux',
      version: '0.9.5',
      cliWrapperContent: '#!/bin/sh\necho imcodes-wrapper\n',
      minVersion: '0.9.0',
    });
    writeFileSync(runnerPath, runnerText, { mode: 0o755 });

    // POSIX sh syntax check
    execFileSync('/bin/sh', ['-n', runnerPath], { encoding: 'utf8' });

    // Test 1: .deb clean install sequence where preinstall sees absent node service before dpkg unpacks it,
    // and postinstall sees pre-unpacked node service file on disk yet still reports scenario=clean.
    const debIso = join(root, 'deb-iso');
    const debHome = join(root, 'deb-home');
    const payloadV1 = join(root, 'payload-v1');
    const rtV1 = join(payloadV1, 'daemon-runtime');
    mkdirSync(join(rtV1, 'bin'), { recursive: true });
    mkdirSync(join(rtV1, 'package', 'dist', 'src'), { recursive: true });
    writeFileSync(join(rtV1, 'bin', 'node'), '#!/bin/sh\necho 0.9.5\n', { mode: 0o755 });
    writeFileSync(join(rtV1, 'package', 'package.json'), '{"name":"imcodes","version":"0.9.5"}');
    writeFileSync(join(rtV1, 'package', 'dist', 'src', 'index.js'), '');
    mkdirSync(join(debHome), { recursive: true });

    execFileSync(
      '/bin/sh',
      [
        runnerPath,
        '--phase', 'preinst',
        '--isolated-root', debIso,
        '--home', debHome,
        '--payload', payloadV1,
        '--no-service-control',
      ],
      { encoding: 'utf8' },
    );
    expect(readFileSync(join(debIso, 'rollback-snapshot', 'snapshot.env'), 'utf8')).toContain('NODE_SVC_KIND=absent');

    // Simulate dpkg unpacking imcodes-node.service onto disk between preinst and postinst
    mkdirSync(join(debIso, 'controlled-node'), { recursive: true });
    writeFileSync(join(debIso, 'controlled-node', 'imcodes-node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
    const fakeNodeSvc = join(debIso, 'imcodes-node.service');
    writeFileSync(fakeNodeSvc, '[Unit]\nDescription=unpacked-by-deb\n');
    const preUnpackedRelease = join(debIso, 'daemon-runtime', 'releases', '0.9.5');
    mkdirSync(join(preUnpackedRelease, 'bin'), { recursive: true });
    mkdirSync(join(preUnpackedRelease, 'package', 'dist', 'src'), { recursive: true });
    writeFileSync(join(preUnpackedRelease, 'bin', 'node'), '#!/bin/sh\necho 0.9.5\n', { mode: 0o755 });
    writeFileSync(join(preUnpackedRelease, 'package', 'package.json'), '{"name":"imcodes","version":"0.9.5"}');
    writeFileSync(join(preUnpackedRelease, 'package', 'dist', 'src', 'index.js'), '');

    const postOut = execFileSync(
      '/bin/sh',
      [
        runnerPath,
        '--phase', 'postinst',
        '--isolated-root', debIso,
        '--home', debHome,
        '--node-service', fakeNodeSvc,
        '--no-service-control',
      ],
      { encoding: 'utf8' },
    );
    expect(postOut).toContain('INSTALL_OK scenario=clean');
    expect(existsSync(join(debHome, '.imcodes'))).toBe(true);
    expect(existsSync(join(debHome, '.config', 'systemd', 'user', 'imcodes.service'))).toBe(true);

    // Test 2: Exercise run_systemctl_user root->runuser fallback (when /run/user/$uid/bus is missing)
    // and ensure `shift 3` preserves exact `--user` args instead of leaking helper args.
    const upgRoot = join(root, 'upg');
    const fakeBin = join(upgRoot, 'bin');
    const logFile = join(upgRoot, 'svc.log');
    const homeDir = join(upgRoot, 'home');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(homeDir, '.imcodes'), { recursive: true });

    const sysctlMock = join(fakeBin, 'systemctl');
    writeFileSync(
      sysctlMock,
      `#!/bin/sh
echo "SYSTEMCTL $*" >> "${logFile}"
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, 'runuser'),
      `#!/bin/sh
echo "RUNUSER $*" >> "${logFile}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, 'id'),
      `#!/bin/sh
if [ "$1" = "-u" ] && [ "$#" -eq 1 ]; then echo "0"; exit 0; fi
if [ "$1" = "-u" ] && [ "$#" -eq 2 ]; then echo "59999"; exit 0; fi
exec /usr/bin/id "$@"
`,
      { mode: 0o755 },
    );

    const testEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      IMCODES_SYSTEMCTL_BIN: sysctlMock,
      SUDO_USER: 'tester',
    };

    execFileSync('/bin/sh', ['-c', `
      set -eu
      HELPER_FILE="${join(upgRoot, 'helper.sh')}"
      sed -n '/^resolve_target_unix_user() {/,/^}/p; /^run_systemctl_user() {/,/^}/p' "${runnerPath}" > "$HELPER_FILE"
      ISOLATED_ROOT=""
      TARGET_USER="tester"
      EFF_HOME="${homeDir}"
      . "$HELPER_FILE"
      run_systemctl_user daemon-reload
      run_systemctl_user enable imcodes.service
    `], { env: testEnv, encoding: 'utf8' });

    const runLog = readFileSync(logFile, 'utf8');
    expect(runLog).toContain('RUNUSER -u tester -- sh -c');
    expect(runLog).toContain('SYSTEMCTL --user daemon-reload');
    expect(runLog).toContain('SYSTEMCTL --user enable imcodes.service');
    const systemctlLines = runLog.split('\n').filter((line) => line.startsWith('SYSTEMCTL '));
    expect(systemctlLines).toEqual([
      'SYSTEMCTL --user daemon-reload',
      'SYSTEMCTL --user enable imcodes.service',
    ]);

    // Verify runner script includes persisted user service stop/restart, linger, prerm-remove, and rollback ownership repair
    expect(runnerText).toContain('USER_SVC_STOPPED_BY_INSTALLER=1');
    expect(runnerText).toContain('prerm-remove');
    expect(runnerText).toContain('loginctl enable-linger');
    expect(runnerText).toContain('shift 3');
    expect(runnerText).toContain('\\( -user 0 -o -group 0 \\)');

    // Verify refresh_node_staged_receipt updates stale stagedReceipt hashes after package replacement
    // while leaving unrelated/un-receipted journals untouched
    const receiptRoot = join(root, 'receipt-refresh');
    const recNodeRoot = join(receiptRoot, 'node');
    const recCurBin = join(receiptRoot, 'current', 'bin');
    mkdirSync(recNodeRoot, { recursive: true });
    mkdirSync(recCurBin, { recursive: true });
    symlinkSync(process.execPath, join(recCurBin, 'node'));
    const recNodeExe = join(recNodeRoot, 'imcodes-node');
    writeFileSync(recNodeExe, 'upgraded-node-binary-v2\n', { mode: 0o755 });
    const recJournalPath = join(recNodeRoot, 'install-journal.json');
    writeFileSync(recJournalPath, JSON.stringify({
      version: 1,
      phase: 'service_healthy',
      updatedAt: 1000,
      installId: 'inst-1',
      nodeTokenHash: '0'.repeat(64),
      sourceExePath: recNodeExe,
      stagedExePath: recNodeExe,
      stagedReceipt: {
        path: recNodeExe,
        size: 10,
        sha256: 'a'.repeat(64),
        sourceIdentity: { size: 10, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { size: 10, mtimeMs: 1, ctimeMs: 1 },
      },
      serverId: 'srv-1',
      serviceName: 'imcodes-node.service',
      healthyAt: 1000,
    }));
    execFileSync('/bin/sh', ['-c', `
      set -eu
      HELPER_FILE="${join(receiptRoot, 'receipt-helper.sh')}"
      sed -n '/^refresh_node_staged_receipt() {/,/^}/p' "${runnerPath}" > "$HELPER_FILE"
      NODE_ROOT="${recNodeRoot}"
      CURRENT_LINK="${join(receiptRoot, 'current')}"
      . "$HELPER_FILE"
      refresh_node_staged_receipt
    `], { encoding: 'utf8' });
    const updatedJournal = JSON.parse(readFileSync(recJournalPath, 'utf8')) as {
      stagedReceipt: { path: string; size: number; sha256: string; stagedIdentity: { ino?: number } };
    };
    expect(updatedJournal.stagedReceipt.path).toBe(recNodeExe);
    expect(updatedJournal.stagedReceipt.size).toBe(Buffer.byteLength('upgraded-node-binary-v2\n'));
    expect(updatedJournal.stagedReceipt.sha256).toBe(sha256File(recNodeExe));
    expect(updatedJournal.stagedReceipt.stagedIdentity.ino).toBe(lstatSync(recNodeExe).ino);

    // Replacing the binary with identical bytes at a new inode (dpkg/cp upgrade) must also refresh stagedIdentity.ino
    writeFileSync(`${recNodeExe}.new`, 'upgraded-node-binary-v2\n', { mode: 0o755 });
    execFileSync('/bin/mv', ['-f', `${recNodeExe}.new`, recNodeExe]);
    const newIno = lstatSync(recNodeExe).ino;
    execFileSync('/bin/sh', ['-c', `
      set -eu
      HELPER_FILE="${join(receiptRoot, 'receipt-helper.sh')}"
      NODE_ROOT="${recNodeRoot}"
      CURRENT_LINK="${join(receiptRoot, 'current')}"
      . "$HELPER_FILE"
      refresh_node_staged_receipt
    `], { encoding: 'utf8' });
    const refreshedSameBytes = JSON.parse(readFileSync(recJournalPath, 'utf8')) as {
      stagedReceipt: { stagedIdentity: { ino?: number } };
    };
    expect(refreshedSameBytes.stagedReceipt.stagedIdentity.ino).toBe(newIno);
  });

  it('builds darwin-x64 installer stage with hostArchitectures=x86_64, stops/restarts running bundled daemon in partial_preserve, and injects PATH into imcodes.daemon.plist', async () => {
    const root = makeTempDir('imcodes-darwin-x64-');
    const macRt = createFakeRuntimeDir(root, 'darwin', '0.9.5');
    const stageRes = await buildMacosInstaller({
      arch: 'x64',
      version: '0.9.5',
      runtimeDir: macRt,
      stageDir: join(root, 'mac-x64-stage'),
      emitStageOnly: true,
    });
    const distXml = readFileSync(stageRes.distributionXmlPath, 'utf8');
    expect(distXml).toContain('hostArchitectures="x86_64"');
    expect(distXml).not.toContain('hostArchitectures="arm64"');

    // Verify phase-a-runner.sh parses single-line bundled LaunchAgent plist, stops live daemon,
    // writes PATH including /opt/homebrew/bin:/usr/local/bin into imcodes.daemon.plist, and restarts it via launchctl.
    const runner = join(stageRes.scriptsDir, 'phase-a-runner.sh');
    const iso = join(root, 'iso-x64');
    const home = join(root, 'home-x64');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const stateDir = join(home, '.imcodes');
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(iso, 'daemon-runtime', 'current', 'bin'), { recursive: true });
    writeFileSync(join(iso, 'daemon-runtime', 'current', 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });

    // Single-line LaunchAgent plist pointing to isolated bundled runtime
    const singleLinePlist =
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>imcodes.daemon</string><key>ProgramArguments</key><array><string>${iso}/daemon-runtime/current/bin/node</string><string>${iso}/daemon-runtime/current/package/dist/src/index.js</string></array></dict></plist>\n`;
    writeFileSync(join(plistDir, 'imcodes.daemon.plist'), singleLinePlist);

    const worker = await spawnWorkerNode();
    try {
      const startToken = readStartTokenForPid(worker.pid!);
      writeFileSync(join(stateDir, 'daemon.lock.json'), JSON.stringify({ pid: worker.pid, startToken }));
      const launchLog = join(root, 'launchctl-x64.log');
      const fakeLaunchctl = join(root, 'fake-launchctl.sh');
      writeFileSync(fakeLaunchctl, `#!/bin/sh\necho "$*" >> ${JSON.stringify(launchLog)}\nexit 0\n`, { mode: 0o755 });

      const env = { ...process.env, IMCODES_LAUNCHCTL_BIN: fakeLaunchctl };
      if (process.platform !== 'darwin') {
        const fakePs = join(root, 'fake-ps.sh');
        const lstart = startToken.replace(/^ps:/, '');
        writeFileSync(
          fakePs,
          `#!/bin/sh\necho "S ${lstart}"\n`,
          { mode: 0o755 },
        );
        // On non-darwin tests we only verify plist/ENV structure since runner's platform is darwin
      }
      if (process.platform === 'darwin') {
        const exited = new Promise<void>((resolve) => {
          if (worker.exitCode !== null || worker.signalCode !== null) {
            resolve();
            return;
          }
          worker.once('exit', () => resolve());
        });
        const preOut = execFileSync(
          runner,
          ['--phase', 'preinstall', '--isolated-root', iso, '--home', home, '--apply-services'],
          { env, encoding: 'utf8' },
        );
        expect(preOut).toBe('');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
        expect(isPidAliveNode(worker.pid!)).toBe(false);

        const postOut = execFileSync(
          runner,
          ['--phase', 'postinstall', '--isolated-root', iso, '--home', home, '--apply-services'],
          { env, encoding: 'utf8' },
        );
        expect(postOut).toContain('INSTALL_OK scenario=partial_preserve');
        const writtenPlist = readFileSync(join(plistDir, 'imcodes.daemon.plist'), 'utf8');
        expect(writtenPlist).toContain('<key>PATH</key>');
        expect(writtenPlist).toContain('/opt/homebrew/bin:/usr/local/bin:');
        expect(writtenPlist).toContain('<key>StandardOutPath</key>');
        const logText = readFileSync(launchLog, 'utf8');
        expect(logText).toContain('bootout gui/');
        expect(logText).toContain('bootstrap gui/');
        expect(logText).toContain('kickstart -k gui/');
      } else {
        const dryOut = execFileSync(
          runner,
          ['--isolated-root', iso, '--home', home, '--check'],
          { encoding: 'utf8' },
        );
        expect(dryOut).toContain('PHASE_A_PLAN scenario=partial_preserve preserve_cli=0 preserve_autostart=0');
      }
      } finally {
        try {
          worker.kill('SIGKILL');
        } catch {}
      }
    });

  it('prevents Windows watchdog race, broken backslash escapes, silent PreInstall stalls, and worker manifest skew', () => {
    const ps1Text = renderWindowsPhaseAInstallerPs1({
      version: '2026.11.7132-dev.7022',
      cliWrapperContent: '@echo off\r\n',
    });

    // 1. Valid $RootPath.TrimEnd('\') + '\' and no broken empty TrimEnd('') in rendered PS1
    expect(ps1Text).toContain("$prefix = $RootPath.TrimEnd('\\') + '\\'");
    expect(ps1Text).not.toContain("TrimEnd('')");
    expect(ps1Text).not.toMatch(/[^\x00-\x7f]/);

    // 2. BOM-free upgrade-in-progress.json + independent cmdlet disable/stop + schtasks fallback + active watchdog kill
    const stopBlock = ps1Text.slice(
      ps1Text.indexOf('function Stop-ControlledNodeAndSidecarsForInstall'),
      ps1Text.indexOf('function Save-RollbackSnapshot'),
    );
    expect(stopBlock).toContain('New-Object System.Text.UTF8Encoding($false)');
    expect(stopBlock).toContain('Write-TextAtomic $markerPath $markerJson $utf8NoBom');
    expect(stopBlock).toContain('$useCustomSchtasks = Test-UsingCustomSchtasksExe');
    expect(stopBlock).toContain("Get-Command -Name 'Get-ScheduledTask'");
    expect(stopBlock).toContain("Get-Command -Name 'Disable-ScheduledTask'");
    expect(stopBlock).toContain("Get-Command -Name 'Stop-ScheduledTask'");
    expect(stopBlock).toContain('$taskDisabled = $false');
    expect(stopBlock).toContain('$taskStopped = $false');
    expect(stopBlock).toContain('Disable-ScheduledTask -TaskName $tn -ErrorAction Stop');
    expect(stopBlock).toContain('if (-not $taskDisabled)');
    expect(stopBlock).toContain("Invoke-Schtasks @('/Change', '/TN', $tn, '/DISABLE')");
    expect(stopBlock).toContain('Write-InstallerLog ("schtasks /Change /DISABLE failed for " + $tn');
    expect(stopBlock).toContain('Stop-ScheduledTask -TaskName $tn -ErrorAction Stop');
    expect(stopBlock).toContain('if (-not $taskStopped)');
    expect(stopBlock).toContain("Invoke-Schtasks @('/End', '/TN', $tn)");
    expect(stopBlock).toContain('Write-InstallerLog ("schtasks /End note for " + $tn');
    expect(stopBlock).toContain('Stop-ActiveNodeWatchdogProcesses $NodeRoot');

    const watchdogKillBlock = ps1Text.slice(
      ps1Text.indexOf('function Stop-ActiveNodeWatchdogProcesses'),
      ps1Text.indexOf('function Stop-ControlledNodeAndSidecarsForInstall'),
    );
    expect(watchdogKillBlock).toContain("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='pwsh.exe'\"");
    expect(watchdogKillBlock).toContain('imcodes-node-health-watchdog.ps1');
    expect(watchdogKillBlock).toContain('$rootTrimmed');
    expect(watchdogKillBlock).toContain('$proc.ProcessId');

    // 3. PostInstall checks remote-desktop-worker.exe SHA-256 against manifest and fails closed on missing/invalid hash
    const manifestIntegrityBlock = ps1Text.slice(
      ps1Text.indexOf('function Test-RemoteDesktopWorkerManifestIntegrity'),
      ps1Text.indexOf('Install-RemoteDesktopVirtualDisplay', ps1Text.indexOf('function Test-RemoteDesktopWorkerManifestIntegrity')),
    );
    expect(manifestIntegrityBlock).toContain("$expectedSha -cnotmatch '^[a-f0-9]{64}$'");
    expect(manifestIntegrityBlock).toContain('remote_desktop_worker_manifest_invalid');
    expect(manifestIntegrityBlock).toContain('remote_desktop_worker_manifest_mismatch');
    expect(manifestIntegrityBlock).toContain('Write-InstallerLog ("ERROR: " + $msg)');
    const postInstallTail = ps1Text.slice(ps1Text.lastIndexOf('Install-RemoteDesktopVirtualDisplay'));
    expect(postInstallTail.indexOf('Install-RemoteDesktopVirtualDisplay')).toBeLessThan(
      postInstallTail.indexOf('Test-RemoteDesktopWorkerManifestIntegrity'),
    );
    expect(postInstallTail.indexOf('Test-RemoteDesktopWorkerManifestIntegrity')).toBeLessThan(
      postInstallTail.indexOf('Register-WindowsServices'),
    );

    // 4. Inno Setup updates StatusLabel before PreInstall and extracts controlled-node binaries before daemon-runtime
    const issText = renderWindowsInnoSetupIss({
      version: '2026.11.7132-dev.7022',
      hasNodeExe: true,
      hasRemoteDesktop: true,
      hasComputerUse: true,
      hasLocalUi: true,
    });
    const ssInstallBlock = issText.slice(issText.indexOf('if CurStep = ssInstall then begin'));
    expect(ssInstallBlock).toContain("WizardForm.StatusLabel.Caption := 'Stopping background services and preparing upgrade...';");
    expect(ssInstallBlock).toContain('WizardForm.StatusLabel.Refresh;');
    expect(ssInstallBlock.indexOf('WizardForm.StatusLabel.Caption')).toBeLessThan(ssInstallBlock.indexOf("Exec('powershell.exe'"));

    const filesSection = issText.slice(issText.indexOf('[Files]'), issText.indexOf('[Run]'));
    const idxNodeExe = filesSection.indexOf('controlled-node\\imcodes-node.exe');
    const idxWorker = filesSection.indexOf('controlled-node\\remote-desktop-worker\\*');
    const idxHelper = filesSection.indexOf('controlled-node\\computer-use-helper\\*');
    const idxLocalUi = filesSection.indexOf('controlled-node\\aidesk-local-ui\\*');
    const idxDaemonRuntime = filesSection.indexOf('daemon-runtime\\*');
    expect(idxNodeExe).toBeGreaterThan(-1);
    expect(idxWorker).toBeGreaterThan(-1);
    expect(idxHelper).toBeGreaterThan(-1);
    expect(idxLocalUi).toBeGreaterThan(-1);
    expect(idxNodeExe).toBeLessThan(idxDaemonRuntime);
    expect(idxWorker).toBeLessThan(idxDaemonRuntime);
    expect(idxHelper).toBeLessThan(idxDaemonRuntime);
    expect(idxLocalUi).toBeLessThan(idxDaemonRuntime);
  });

  it.runIf(process.platform === 'win32')(
    'verifies Stop-ScheduledTask fallback to schtasks /End and PostInstall fail-closed manifest integrity on Windows PowerShell',
    () => {
      const root = makeTempDir();
      const ps1Path = join(root, 'imcodes-windows-installer.ps1');
      writeFileSync(
        ps1Path,
        renderWindowsPhaseAInstallerPs1({ version: '2026.11.7132-dev.7022', cliWrapperContent: '@echo off\r\n' }),
        'utf8',
      );
      const isoRoot = join(root, 'iso');
      const nodeRoot = join(isoRoot, 'ProgramData', 'imcodes-node');
      const runtimeRoot = join(isoRoot, 'ProgramFiles', 'IM.codes', 'daemon-runtime');
      const rdDir = join(nodeRoot, 'remote-desktop-worker', 'win32-x64');
      mkdirSync(rdDir, { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      const workerExe = join(rdDir, 'imcodes-remote-desktop-worker.exe');
      const workerManifest = join(rdDir, 'imcodes-remote-desktop-worker.exe.manifest.json');
      writeFileSync(workerExe, 'MZ-worker-payload');

      // 1. Behavioral test for Stop-ScheduledTask missing AND throwing fallback to Invoke-Schtasks /End
      const harnessPath = join(root, 'test-stop-fallback.ps1');
      writeFileSync(
        harnessPath,
        `
$ErrorActionPreference = 'Stop'
$src = Get-Content -LiteralPath '${ps1Path.replace(/'/g, "''")}' -Raw
$idx = $src.IndexOf('function Stop-ActiveNodeWatchdogProcesses')
$endIdx = $src.IndexOf('function Save-RollbackSnapshot')
$fnCode = $src.Substring($idx, $endIdx - $idx)
$script:NodeRoot = '${nodeRoot.replace(/'/g, "''")}'
$script:RuntimeRoot = '${runtimeRoot.replace(/'/g, "''")}'
$script:ApplyServices = $true
$script:logs = @()
$script:schtasksCalls = @()
function Write-TextAtomic([string]$TargetPath, [string]$Content, [System.Text.Encoding]$Encoding) {
  [System.IO.File]::WriteAllText($TargetPath, $Content, $Encoding)
}
function Invoke-ServiceAction([string]$Action, [hashtable]$Payload) { return $false }
function Test-CanControlNativeWindowsTasks { return $true }
function Test-UsingCustomSchtasksExe { return $false }
function Test-PathUnderManagedRoot([string]$CandidatePath, [string]$RootPath) { return $false }
function Write-InstallerLog([string]$Message) { $script:logs += $Message }
function Invoke-Schtasks([string[]]$Arguments) {
  $script:schtasksCalls += ($Arguments -join ' ')
  return [ordered]@{ exitCode = 0; output = 'OK' }
}
Invoke-Expression $fnCode

# Case A: Stop-ScheduledTask throws even though Disable-ScheduledTask succeeds -> must fall back to schtasks /End
function Get-ScheduledTask { param([string]$TaskName) return [pscustomobject]@{ TaskName = $TaskName } }
function Disable-ScheduledTask { param([string]$TaskName) }
function Stop-ScheduledTask { param([string]$TaskName) throw 'stop_failed_simulated' }
Stop-ControlledNodeAndSidecarsForInstall
$bomCheck = [System.IO.File]::ReadAllBytes('${join(nodeRoot, 'upgrade-in-progress.json').replace(/'/g, "''")}')
if ($bomCheck.Length -ge 3 -and $bomCheck[0] -eq 0xEF -and $bomCheck[1] -eq 0xBB -and $bomCheck[2] -eq 0xBF) { throw 'bom_present' }
if (-not ($script:schtasksCalls -contains '/End /TN imcodes-node-watchdog')) { throw 'missing_end_watchdog_on_throw' }
if (-not ($script:schtasksCalls -contains '/End /TN imcodes-node')) { throw 'missing_end_node_on_throw' }

# Case B: Stop-ScheduledTask missing (Get-Command returns $null) -> must fall back to schtasks /End
$script:schtasksCalls = @()
function Get-Command { param([string]$Name) if ($Name -eq 'Stop-ScheduledTask') { return $null }; return [pscustomobject]@{ Name = $Name } }
Stop-ControlledNodeAndSidecarsForInstall
if (-not ($script:schtasksCalls -contains '/End /TN imcodes-node-watchdog')) { throw 'missing_end_watchdog_on_missing_cmdlet' }
if (-not ($script:schtasksCalls -contains '/End /TN imcodes-node')) { throw 'missing_end_node_on_missing_cmdlet' }
`,
        'utf8',
      );
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], {
        encoding: 'utf8',
      });

      // 2. PostInstall fails closed on missing sha256, invalid sha256, and mismatched sha256
      for (const [label, payload, expectedErr] of [
        ['missing-sha', JSON.stringify({ workerVersion: '1.0.0' }), 'remote_desktop_worker_manifest_invalid'],
        ['invalid-sha', JSON.stringify({ sha256: 'not-a-valid-hex' }), 'remote_desktop_worker_manifest_invalid'],
        ['mismatch-sha', JSON.stringify({ sha256: '0'.repeat(64) }), 'remote_desktop_worker_manifest_mismatch'],
      ] as Array<[string, string, string]>) {
        writeFileSync(workerManifest, payload, 'utf8');
        const logPath = join(root, `postinstall-${label}.log`);
        let failed = false;
        try {
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              ps1Path,
              '-Mode',
              'PostInstall',
              '-IsolatedRoot',
              isoRoot,
              '-Version',
              '2026.11.7132-dev.7022',
              '-RuntimeRoot',
              runtimeRoot,
              '-NodeRoot',
              nodeRoot,
              '-LogPath',
              logPath,
            ],
            { encoding: 'utf8' },
          );
        } catch {
          failed = true;
        }
        expect(failed, `${label} must fail PostInstall`).toBe(true);
        expect(readFileSync(logPath, 'utf8')).toContain(expectedErr);
      }
    },
  );

  it('installs OpenCode CLI idempotently and non-blockingly in POSIX (linux + darwin) postinstall before service start', async () => {
    for (const os of ['linux', 'darwin'] as const) {
      const root = makeTempDir(`imcodes-oc-${os}-`);
      const rtDir = createFakeRuntimeDir(root, os, '0.9.5');
      mkdirSync(join(rtDir, 'package', 'dist', 'src', 'node'), { recursive: true });
      writeFileSync(join(rtDir, 'package', 'dist', 'src', 'node', 'install-opencode-cli.js'), '// stub\n', 'utf8');

      const runnerPath = join(root, `phase-a-${os}.sh`);
      const scriptText = renderPosixPhaseARunnerScript({
        platform: os,
        version: '0.9.5',
        cliWrapperContent: '#!/bin/sh\necho ok\n',
      });
      writeFileSync(runnerPath, scriptText, { mode: 0o755 });

      expect(scriptText).toContain('install_opencode_cli_best_effort');
      expect(scriptText).toContain('run_as_target_unix_user');
      expect(scriptText).toContain('install-opencode-cli.js" --home "$EFF_HOME" --strict');
      expect(scriptText.lastIndexOf('install_opencode_cli_best_effort\n\nif [ "$CLEAN_EXPIRED_TMP"')).toBeLessThan(
        scriptText.lastIndexOf('if [ "$PRESERVE_AUTOSTART" -eq 0 ]; then'),
      );
      expect(scriptText.lastIndexOf('install_opencode_cli_best_effort\n\nif [ "$CLEAN_EXPIRED_TMP"')).toBeLessThan(
        scriptText.lastIndexOf('if [ "$APPLY_SERVICES" -eq 1 ]; then'),
      );

      // Build fake staged release dir + hook logging invocation order
      const traceFile = join(root, 'trace.log');
      const fakeHook = join(root, 'oc-hook.sh');
      writeFileSync(
        fakeHook,
        `#!/bin/sh
echo "OC_HOOK args=$*" >> "${traceFile}"
home_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home_arg="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$home_arg/.opencode/bin"
printf '#!/bin/sh\necho 2.4.2\n' > "$home_arg/.opencode/bin/opencode"
chmod 755 "$home_arg/.opencode/bin/opencode"
`,
        { mode: 0o755 },
      );

      const failHook = join(root, 'oc-fail-hook.sh');
      writeFileSync(
        failHook,
        `#!/bin/sh
echo "OC_FAIL_HOOK" >> "${traceFile}"
exit 42
`,
        { mode: 0o755 },
      );

      const fakeSvcBin = join(root, os === 'linux' ? 'fake-systemctl.sh' : 'fake-launchctl.sh');
      writeFileSync(
        fakeSvcBin,
        `#!/bin/sh
echo "SVC args=$*" >> "${traceFile}"
exit 0
`,
        { mode: 0o755 },
      );

      // Case 1: isolated mode with no hook/registry does NOT invoke node installer or create .opencode
      const isoDefault = join(root, 'iso-default');
      const homeDefault = join(root, 'home-default');
      mkdirSync(join(isoDefault, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoDefault, 'daemon-runtime', 'releases', '0.9.5')]);
      const outDefault = execFileSync(
        runnerPath,
        ['--isolated-root', isoDefault, '--home', homeDefault, '--confirm-fda-switch', '--no-service-control'],
        { env: { ...process.env, IMCODES_OPENCODE_INSTALL_HOOK: '', IMCODES_OPENCODE_REGISTRY: '' }, encoding: 'utf8' },
      );
      expect(outDefault).toContain('INSTALL_OK');
      expect(existsSync(join(homeDefault, '.opencode'))).toBe(false);

      // Case 2: hook runs BEFORE service start/restart and installs ~/.opencode/bin/opencode
      const isoHook = join(root, 'iso-hook');
      const homeHook = join(root, 'home-hook');
      mkdirSync(join(isoHook, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoHook, 'daemon-runtime', 'releases', '0.9.5')]);
      const outHook = execFileSync(
        runnerPath,
        ['--isolated-root', isoHook, '--home', homeHook, '--confirm-fda-switch', '--apply-services'],
        {
          env: {
            ...process.env,
            IMCODES_OPENCODE_INSTALL_HOOK: fakeHook,
            ...(os === 'linux' ? { IMCODES_SYSTEMCTL_BIN: fakeSvcBin } : { IMCODES_LAUNCHCTL_BIN: fakeSvcBin }),
          },
          encoding: 'utf8',
        },
      );
      expect(outHook).toContain('INSTALL_OK');
      expect(existsSync(join(homeHook, '.opencode', 'bin', 'opencode'))).toBe(true);
      const traceLines = readFileSync(traceFile, 'utf8').trim().split('\n');
      const ocIdx = traceLines.findIndex((l) => l.startsWith('OC_HOOK'));
      const svcStartIdx = traceLines.findIndex(
        (l) => l.startsWith('SVC') && (l.includes('restart') || l.includes('start') || l.includes('bootstrap') || l.includes('kickstart')),
      );
      expect(ocIdx).toBeGreaterThanOrEqual(0);
      expect(svcStartIdx).toBeGreaterThan(ocIdx);

      // Case 3: IMCODES_SKIP_OPENCODE=1 skips hook cleanly
      const isoSkip = join(root, 'iso-skip');
      const homeSkip = join(root, 'home-skip');
      mkdirSync(join(isoSkip, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoSkip, 'daemon-runtime', 'releases', '0.9.5')]);
      execFileSync(
        runnerPath,
        ['--isolated-root', isoSkip, '--home', homeSkip, '--confirm-fda-switch', '--no-service-control'],
        { env: { ...process.env, IMCODES_SKIP_OPENCODE: '1', IMCODES_OPENCODE_INSTALL_HOOK: fakeHook }, encoding: 'utf8' },
      );
      expect(existsSync(join(homeSkip, '.opencode'))).toBe(false);

      // Case 4: failing OpenCode install stays strictly non-blocking
      const isoFail = join(root, 'iso-fail');
      const homeFail = join(root, 'home-fail');
      mkdirSync(join(isoFail, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoFail, 'daemon-runtime', 'releases', '0.9.5')]);
      const outFail = execFileSync(
        runnerPath,
        ['--isolated-root', isoFail, '--home', homeFail, '--confirm-fda-switch', '--no-service-control'],
        { env: { ...process.env, IMCODES_OPENCODE_INSTALL_HOOK: failHook }, encoding: 'utf8' },
      );
      expect(outFail).toContain('INSTALL_OK');

      // Case 5: default node invocation wires --home "$EFF_HOME" --strict --no-fallback --isolated-test cleanly and stays isolated
      let externalHits = 0;
      const forbiddenExternalSrv = createServer((_req, res) => {
        externalHits += 1;
        res.statusCode = 500;
        res.end('should-never-hit');
      });
      await new Promise<void>((resolve) => forbiddenExternalSrv.listen(0, '127.0.0.1', resolve));
      const externalPort = (forbiddenExternalSrv.address() as { port: number }).port;
      try {
        const isoNode = join(root, 'iso-node');
        const homeNode = join(root, 'home-node');
        mkdirSync(join(isoNode, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
        mkdirSync(join(homeNode, '.imcodes'), { recursive: true });
        writeFileSync(
          join(homeNode, '.imcodes', 'install.json'),
          JSON.stringify({ registry: `http://127.0.0.1:${externalPort}` }),
          'utf8',
        );
        execFileSync('cp', ['-R', `${rtDir}/.`, join(isoNode, 'daemon-runtime', 'releases', '0.9.5')]);
        const nodeExecTrace = join(root, `node-exec-${os}.log`);
        const isoNodeBin = join(isoNode, 'daemon-runtime', 'releases', '0.9.5', 'bin', 'node');
        const compiledOcJs = join(process.cwd(), 'dist', 'src', 'node', 'install-opencode-cli.js');
        if (existsSync(compiledOcJs)) {
          writeFileSync(
            join(isoNode, 'daemon-runtime', 'releases', '0.9.5', 'package', 'dist', 'src', 'node', 'install-opencode-cli.js'),
            readFileSync(compiledOcJs),
          );
          writeFileSync(
            isoNodeBin,
            `#!/bin/sh\necho "NODE_EXEC args=$*" >> "${nodeExecTrace}"\nPATH="" exec "${process.execPath}" "$@"\n`,
            { mode: 0o755 },
          );
        } else {
          writeFileSync(
            isoNodeBin,
            `#!/bin/sh\necho "NODE_EXEC args=$*" >> "${nodeExecTrace}"\nexit 1\n`,
            { mode: 0o755 },
          );
        }
        const resNode = spawnSync(
          runnerPath,
          ['--isolated-root', isoNode, '--home', homeNode, '--confirm-fda-switch', '--no-service-control'],
          {
            env: {
              ...process.env,
              IMCODES_OPENCODE_INSTALL_HOOK: '',
              IMCODES_OPENCODE_REGISTRY: 'http://127.0.0.1:9',
            },
            encoding: 'utf8',
          },
        );
        expect(resNode.status).toBe(0);
        expect(resNode.stdout).toContain('INSTALL_OK');
        expect(resNode.stderr).toContain('WARNING: OpenCode CLI install failed (non-blocking)');
        const nodeTraceText = readFileSync(nodeExecTrace, 'utf8');
        expect(nodeTraceText).toContain('install-opencode-cli.js');
        expect(nodeTraceText).toContain('--strict');
        expect(nodeTraceText).toContain('--isolated-test');
        expect(nodeTraceText).toContain('--no-fallback');
        expect(externalHits).toBe(0);
      } finally {
        await new Promise<void>((resolve) => forbiddenExternalSrv.close(() => resolve()));
      }

      // Case 6: root installer drops privileges via runuser to target user, and warns/skips when no non-root target user resolves
      const realIdBin = execFileSync('which', ['id'], { encoding: 'utf8' }).trim();
      const fakePrivBin = join(root, 'fake-priv-bin');
      mkdirSync(fakePrivBin, { recursive: true });
      const privTrace = join(root, 'priv-trace.log');
      writeFileSync(
        join(fakePrivBin, 'id'),
        `#!/bin/sh
if [ "$1" = "-u" ] && [ "$#" -eq 1 ]; then
  echo 0
  exit 0
fi
exec "${realIdBin}" "$@"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(fakePrivBin, 'runuser'),
        `#!/bin/sh
if [ "$1" = "-u" ]; then
  target="$2"
  shift 2
  [ "$1" = "--" ] && shift
  echo "RUNUSER_DROP user=$target cmd=$*" >> "${privTrace}"
  exec "$@"
fi
exit 1
`,
        { mode: 0o755 },
      );
      const isoPriv = join(root, 'iso-priv');
      const homePriv = join(root, 'home-priv');
      mkdirSync(join(isoPriv, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoPriv, 'daemon-runtime', 'releases', '0.9.5')]);
      const outPriv = execFileSync(
        runnerPath,
        ['--isolated-root', isoPriv, '--home', homePriv, '--confirm-fda-switch', '--no-service-control'],
        {
          env: {
            ...process.env,
            PATH: `${fakePrivBin}:${process.env.PATH ?? ''}`,
            SUDO_USER: process.env.USER || execFileSync(realIdBin, ['-un'], { encoding: 'utf8' }).trim(),
            IMCODES_OPENCODE_INSTALL_HOOK: fakeHook,
          },
          encoding: 'utf8',
        },
      );
      expect(outPriv).toContain('INSTALL_OK');
      expect(existsSync(join(homePriv, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(readFileSync(privTrace, 'utf8')).toContain('RUNUSER_DROP user=');

      // Missing non-root target user warns & skips cleanly when running as simulated uid 0
      const fakeRootOnlyBin = join(root, 'fake-root-only-bin');
      mkdirSync(fakeRootOnlyBin, { recursive: true });
      const realStatBin = execFileSync('which', ['stat'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(fakeRootOnlyBin, 'id'),
        `#!/bin/sh
if [ "$1" = "-u" ]; then echo 0; exit 0; fi
if [ "$1" = "-un" ]; then echo root; exit 0; fi
exec "${realIdBin}" "$@"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(fakeRootOnlyBin, 'stat'),
        `#!/bin/sh
case "$*" in
  *"%U"*|*"%Su"*) echo root; exit 0 ;;
esac
exec "${realStatBin}" "$@"
`,
        { mode: 0o755 },
      );
      const isoNoUser = join(root, 'iso-no-user');
      const homeNoUser = join(root, 'home-no-user');
      mkdirSync(join(isoNoUser, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoNoUser, 'daemon-runtime', 'releases', '0.9.5')]);
      const resNoUser = spawnSync(
        runnerPath,
        ['--isolated-root', isoNoUser, '--home', homeNoUser, '--confirm-fda-switch', '--no-service-control'],
        {
          env: {
            ...process.env,
            PATH: `${fakeRootOnlyBin}:${process.env.PATH ?? ''}`,
            SUDO_USER: '',
            USER: 'root',
            LOGNAME: 'root',
            IMCODES_OPENCODE_INSTALL_HOOK: fakeHook,
          },
          encoding: 'utf8',
        },
      );
      expect(resNoUser.status).toBe(0);
      expect(resNoUser.stdout).toContain('INSTALL_OK');
      expect(resNoUser.stderr).toContain('unable to resolve non-root target user');
      expect(existsSync(join(homeNoUser, '.opencode'))).toBe(false);

      // Case 7: symlinked .opencode/bin escaping isolated home is refused non-blockingly without writing outside target
      const isoSym = join(root, 'iso-sym');
      const homeSym = join(root, 'home-sym');
      const outsideSymDir = makeTempDir(`imcodes-oc-outside-${os}-`);
      mkdirSync(join(isoSym, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      mkdirSync(join(homeSym, '.opencode'), { recursive: true });
      symlinkSync(outsideSymDir, join(homeSym, '.opencode', 'bin'));
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoSym, 'daemon-runtime', 'releases', '0.9.5')]);
      const resSym = spawnSync(
        runnerPath,
        ['--isolated-root', isoSym, '--home', homeSym, '--confirm-fda-switch', '--no-service-control'],
        {
          env: { ...process.env, IMCODES_OPENCODE_INSTALL_HOOK: fakeHook },
          encoding: 'utf8',
        },
      );
      expect(resSym.status).toBe(0);
      expect(resSym.stdout).toContain('INSTALL_OK');
      expect(resSym.stderr).toContain('refusing symlinked OpenCode target path');
      expect(readdirSync(outsideSymDir)).toEqual([]);

      // Leaf binary symlink escaping home into sentinel file is rejected BEFORE hook runs
      const isoLeaf = join(root, 'iso-leaf');
      const homeLeaf = join(root, 'home-leaf');
      const sentinelDir = makeTempDir(`imcodes-oc-sentinel-${os}-`);
      const sentinelFile = join(sentinelDir, 'sentinel.txt');
      writeFileSync(sentinelFile, 'SENTINEL_UNTOUCHED', 'utf8');
      mkdirSync(join(isoLeaf, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      mkdirSync(join(homeLeaf, '.opencode', 'bin'), { recursive: true });
      symlinkSync(sentinelFile, join(homeLeaf, '.opencode', 'bin', 'opencode'));
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoLeaf, 'daemon-runtime', 'releases', '0.9.5')]);
      const resLeaf = spawnSync(
        runnerPath,
        ['--isolated-root', isoLeaf, '--home', homeLeaf, '--confirm-fda-switch', '--no-service-control'],
        {
          env: { ...process.env, IMCODES_OPENCODE_INSTALL_HOOK: fakeHook },
          encoding: 'utf8',
        },
      );
      expect(resLeaf.status).toBe(0);
      expect(resLeaf.stdout).toContain('INSTALL_OK');
      expect(resLeaf.stderr).toContain('refusing symlinked OpenCode target path');
      expect(readFileSync(sentinelFile, 'utf8')).toBe('SENTINEL_UNTOUCHED');

      // Case 8: LaunchAgent plist / Linux systemd inherited PATH extension keeps pre-existing agents AND discovers opencode
      if (os === 'darwin') {
        const plistPath = join(homeHook, 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
        const plistXml = readFileSync(plistPath, 'utf8');
        const pathMatch = plistXml.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
        expect(pathMatch).toBeTruthy();
        const plistSparsePath = pathMatch![1];
        expect(plistSparsePath).toContain('/opt/homebrew/bin:/usr/local/bin:');
        expect(plistSparsePath).toContain(join(homeHook, '.opencode', 'bin'));
        const macProbe = await detectInstalledAgentsWithMetadata({
          deps: {
            platform: 'darwin',
            homeDir: homeHook,
            env: { PATH: plistSparsePath },
          },
        });
        expect(macProbe.agents.opencode).toEqual({ installed: true });
      } else {
        // Case 8 (Linux): keep direct bundled Node ExecStart so both Node & POSIX upgrade probes recognize
        // imcodes.service (no environment.d / systemctl set-environment writes), while daemon home lookup discovers ~/.opencode/bin
        const isoSys = join(root, 'iso-sys');
        const homeSys = join(root, 'home-sys');
        const nixAgentDir = join(root, 'nix-agents-bin');
        mkdirSync(nixAgentDir, { recursive: true });
        writeFileSync(join(nixAgentDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const envDSentinelDir = makeTempDir('imcodes-envd-sentinel-');
        const envDSentinel = join(envDSentinelDir, 'sentinel.conf');
        writeFileSync(envDSentinel, 'ENVD_UNTOUCHED', 'utf8');
        mkdirSync(join(homeSys, '.config', 'environment.d'), { recursive: true });
        symlinkSync(envDSentinel, join(homeSys, '.config', 'environment.d', '99-imcodes-opencode.conf'));

        mkdirSync(join(isoSys, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
        execFileSync('cp', ['-R', `${rtDir}/.`, join(isoSys, 'daemon-runtime', 'releases', '0.9.5')]);
        execFileSync(
          runnerPath,
          ['--isolated-root', isoSys, '--home', homeSys, '--confirm-fda-switch', '--apply-services'],
          {
            env: { ...process.env, IMCODES_OPENCODE_INSTALL_HOOK: fakeHook, IMCODES_SYSTEMCTL_BIN: fakeSvcBin },
            encoding: 'utf8',
          },
        );
        expect(readFileSync(envDSentinel, 'utf8')).toBe('ENVD_UNTOUCHED');

        const svcPath = join(homeSys, '.config', 'systemd', 'user', 'imcodes.service');
        const unitText = readFileSync(svcPath, 'utf8');
        expect(unitText).not.toContain('Environment="PATH=');
        const expectedNode = join(isoSys, 'daemon-runtime', 'current', 'bin', 'node');
        const expectedEntry = join(isoSys, 'daemon-runtime', 'current', 'package', 'dist', 'src', 'index.js');
        expect(unitText).toContain(`ExecStart=${expectedNode} ${expectedEntry} start --foreground`);

        // Re-running BOTH Node probe/planner and POSIX fallback plan on generated unit preserves bundled upgrade behavior
        const nodeProbe = probeDesktopInstallEnvironment({
          platform: 'linux',
          isolatedRoot: isoSys,
          homeDir: homeSys,
          daemonRuntimeRoot: join(isoSys, 'daemon-runtime'),
          autostartPath: svcPath,
          cliPath: join(isoSys, 'bin', 'imcodes'),
          env: { PATH: `${nixAgentDir}:/usr/bin`, HOME: homeSys },
        });
        const nodePlan = planDesktopInstallerCompatibility(nodeProbe);
        expect(nodePlan.preserveUserDaemonAutostart).toBe(false);
        expect(nodePlan.stopUserDaemonTask).toBe(true);
        expect(nodePlan.switchToBundledRuntime).toBe(true);

        const posixPlanOut = execFileSync(
          runnerPath,
          ['--phase', 'plan', '--isolated-root', isoSys, '--home', homeSys],
          { encoding: 'utf8' },
        );
        expect(posixPlanOut).toContain('preserve_autostart=0');
        expect(posixPlanOut).toContain('stop_daemon=1');

        // Sparse user-service PATH without ~/.opencode/bin discovers BOTH existing agent (codex) AND ~/.opencode/bin/opencode
        const linuxProbe = await detectInstalledAgentsWithMetadata({
          deps: {
            platform: 'linux',
            homeDir: homeSys,
            env: { PATH: `${nixAgentDir}:/usr/bin` },
          },
        });
        expect(linuxProbe.agents.codex).toEqual({ installed: true });
        expect(linuxProbe.agents.opencode).toEqual({ installed: true });
      }
    }
  }, 60_000);

  it('wires OpenCode CLI auto-install cleanly into Windows installer ps1 and single-transaction PostInstall Inno Setup', async () => {
    const ps1 = renderWindowsPhaseAInstallerPs1({ version: '2026.11.7132-dev.7022', cliWrapperContent: '@echo off\r\n' });
    expect(ps1).toContain('function Install-OpenCodeCliBestEffort');
    expect(ps1).toContain('function Test-IsElevatedOrSystemProcess');
    expect(ps1).toContain('function Test-PathHasReparsePoint');
    expect(ps1.indexOf("if ($Mode -eq 'InstallOpenCode')")).toBeLessThan(
      ps1.indexOf('$plan = Invoke-PhaseAProbe'),
    );
    expect(ps1).toContain("$containerTargets = if ($Mode -eq 'InstallOpenCode')");
    expect(ps1).not.toContain('IMCodesUnElevRunner');
    expect(ps1).not.toContain('Sync-OpenCodeProcessPath');
    expect(ps1).not.toContain('$DeferUserDaemon');
    expect(ps1).not.toContain('$ActivateUserDaemon');
    expect(ps1).toContain('Assert-SafeTargetPath $ocBinDir $RealProfile -EntryMode');
    expect(ps1).toContain('install-opencode-cli.js');
    expect(ps1).toContain('--isolated-test');
    expect(ps1).toContain('--strict');
    expect(ps1).not.toContain('install-opencode-cli.js --home $HomeDir 2>&1 | Out-Null');
    expect(ps1).toContain('IMCODES_SKIP_OPENCODE');
    expect(ps1).toContain('Add-UserPathEntry');
    expect(ps1.indexOf('Install-OpenCodeCliBestEffort\nRemove-Item')).toBeLessThan(
      ps1.indexOf('Register-WindowsServices $plan $stoppedDaemon'),
    );

    const iss = renderWindowsInnoSetupIss({ version: '2026.11.7132-dev.7022' });
    const runSection = iss.slice(iss.indexOf('[Run]'), iss.indexOf('[UninstallRun]'));
    const ocIdx = runSection.indexOf('-Mode InstallOpenCode');
    const postIdx = runSection.indexOf('-Mode PostInstall');
    expect(ocIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(ocIdx);
    expect(runSection).not.toContain('-Mode ApplyServices');
    expect(runSection).not.toContain('-DeferUserDaemon');
    expect(runSection).not.toContain('-ActivateUserDaemon');
    expect(runSection).toContain('-SkipOpenCode');
    expect(runSection).toContain('-ApplyServices');
    expect(runSection).toContain('runasoriginaluser');

    // Sparse Windows service PATH still resolves %USERPROFILE%\.opencode\bin\opencode.exe via home lookup
    const winHome = 'C:\\Users\\alice';
    const expectedWinOc = 'C:\\Users\\alice\\.opencode\\bin\\opencode.exe';
    const winProbe = await detectInstalledAgentsWithMetadata({
      deps: {
        platform: 'win32',
        homeDir: winHome,
        env: { PATH: 'C:\\Windows\\System32' },
        isElevated: false,
        isExecutableFile: async (p) => p.toLowerCase() === expectedWinOc.toLowerCase(),
      },
    });
    expect(winProbe.agents.opencode).toEqual({ installed: true });
  });

  it.skipIf(process.platform !== 'win32')(
    'runs Windows PostInstall OpenCode hook before Register-WindowsServices and handles opt-out & non-blocking failure',
    () => {
      const root = makeTempDir('imcodes-win-oc-');
      const ps1Path = join(root, 'imcodes-windows-installer.ps1');
      writeFileSync(
        ps1Path,
        renderWindowsPhaseAInstallerPs1({ version: '2026.11.7132-dev.7022', cliWrapperContent: '@echo off\r\n' }),
        'utf8',
      );
      const isoRoot = join(root, 'iso');
      const nodeRoot = join(isoRoot, 'ProgramData', 'imcodes-node');
      const runtimeRoot = join(isoRoot, 'ProgramFiles', 'IM.codes', 'daemon-runtime');
      mkdirSync(nodeRoot, { recursive: true });
      mkdirSync(join(runtimeRoot, 'releases', '2026.11.7132-dev.7022'), { recursive: true });

      const tracePath = join(root, 'win-trace.txt');
      const ocHook = join(root, 'oc-hook.ps1');
      writeFileSync(
        ocHook,
        `param([string]$HomeDir)\nAdd-Content -LiteralPath '${tracePath.replace(/'/g, "''")}' -Value "OC:$HomeDir"\n`,
        'utf8',
      );
      const ocFailHook = join(root, 'oc-fail.ps1');
      writeFileSync(
        ocFailHook,
        `param([string]$HomeDir)\nAdd-Content -LiteralPath '${tracePath.replace(/'/g, "''")}' -Value "OC_FAIL:$HomeDir"\nexit 5\n`,
        'utf8',
      );

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
          '-Mode', 'PostInstall', '-IsolatedRoot', isoRoot, '-Version', '2026.11.7132-dev.7022',
          '-RuntimeRoot', runtimeRoot, '-NodeRoot', nodeRoot, '-OpenCodeInstallHook', ocHook,
        ],
        { encoding: 'utf8' },
      );
      expect(readFileSync(tracePath, 'utf8')).toContain('OC:');

      const logFailPath = join(root, 'win-oc-fail.log');
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
          '-Mode', 'PostInstall', '-IsolatedRoot', isoRoot, '-Version', '2026.11.7132-dev.7022',
          '-RuntimeRoot', runtimeRoot, '-NodeRoot', nodeRoot, '-OpenCodeInstallHook', ocFailHook, '-LogPath', logFailPath,
        ],
        { encoding: 'utf8' },
      );
      expect(readFileSync(tracePath, 'utf8')).toContain('OC_FAIL:');
      expect(readFileSync(logFailPath, 'utf8')).toContain('WARNING: OpenCode CLI install hook failed');

      // Failing offline isolated install with install-opencode-cli.js logs warning cleanly in PostInstall log
      const runtimeBinDir = join(runtimeRoot, 'releases', '2026.11.7132-dev.7022');
      const runtimeNode = join(runtimeBinDir, 'node.exe');
      const runtimeOcJs = join(runtimeBinDir, 'package', 'dist', 'src', 'node', 'install-opencode-cli.js');
      mkdirSync(join(runtimeBinDir, 'package', 'dist', 'src', 'node'), { recursive: true });
      writeFileSync(runtimeNode, readFileSync(process.execPath));
      writeFileSync(
        runtimeOcJs,
        `console.error('[opencode-install] WARNING: attempt from http://127.0.0.1:9 failed'); process.exit(process.argv.includes('--strict') ? 1 : 0);\n`,
        'utf8',
      );
      const logOfflinePath = join(root, 'win-oc-offline.log');
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
          '-Mode', 'InstallOpenCode', '-IsolatedRoot', isoRoot, '-Version', '2026.11.7132-dev.7022',
          '-RuntimeRoot', runtimeRoot, '-NodeRoot', nodeRoot, '-LogPath', logOfflinePath,
        ],
        {
          env: { ...process.env, IMCODES_OPENCODE_REGISTRY: 'http://127.0.0.1:9' },
          encoding: 'utf8',
        },
      );
      const offlineLog = readFileSync(logOfflinePath, 'utf8');
      expect(offlineLog).toContain('WARNING: OpenCode CLI install failed exit=1');

      // Clean install 2-step sequence matching Inno [Run]:
      // Step 1: non-elevated InstallOpenCode runs WITHOUT touching NodeRoot/snapshot.json
      // Step 2: PostInstall -SkipOpenCode -ApplyServices runs once and calls ActivateUserDaemon once without injecting .opencode\bin into process PATH
      const cleanIso = join(root, 'iso-clean-seq');
      const cleanNode = join(cleanIso, 'ProgramData', 'imcodes-node');
      const cleanRt = join(cleanIso, 'ProgramFiles', 'IM.codes', 'daemon-runtime');
      const cleanRel = join(cleanRt, 'releases', '2026.11.7132-dev.7022');
      mkdirSync(cleanNode, { recursive: true });
      mkdirSync(join(cleanRel, 'package', 'dist', 'src'), { recursive: true });
      writeFileSync(join(cleanRel, 'node.exe'), readFileSync(process.execPath));
      writeFileSync(join(cleanRel, 'package', 'dist', 'src', 'index.js'), 'console.log("daemon");\n');
      const svcTracePath = join(root, 'win-clean-svc-trace.txt');
      const svcHookPath = join(root, 'win-svc-hook.ps1');
      writeFileSync(
        svcHookPath,
        `param([string]$Action, [string]$PayloadJson)
$hasOcInProcPath = ($env:PATH -like '*\\.opencode\\bin*')
Add-Content -LiteralPath '${svcTracePath.replace(/'/g, "''")}' -Value "$Action|ocProcPath=$hasOcInProcPath"
`,
        'utf8',
      );
      const ocPopulateHook = join(root, 'win-oc-populate.ps1');
      writeFileSync(
        ocPopulateHook,
        `param([string]$HomeDir)
$b = Join-Path (Join-Path $HomeDir '.opencode') 'bin'
New-Item -ItemType Directory -Force -Path $b | Out-Null
[System.IO.File]::WriteAllText((Join-Path $b 'opencode.exe'), 'MZ-fake-opencode')
`,
        'utf8',
      );
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
          '-Mode', 'InstallOpenCode', '-IsolatedRoot', cleanIso,
          '-Version', '2026.11.7132-dev.7022', '-RuntimeRoot', cleanRt,
          '-OpenCodeInstallHook', ocPopulateHook,
        ],
        { encoding: 'utf8' },
      );
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
          '-Mode', 'PostInstall', '-SkipOpenCode', '-ApplyServices', '-IsolatedRoot', cleanIso,
          '-Version', '2026.11.7132-dev.7022', '-RuntimeRoot', cleanRt, '-NodeRoot', cleanNode, '-ServiceHookScript', svcHookPath,
        ],
        { encoding: 'utf8' },
      );
      const svcTraceLines = readFileSync(svcTracePath, 'utf8').trim().split(/\r?\n/);
      const activateLines = svcTraceLines.filter((l) => l.startsWith('ActivateUserDaemon|'));
      expect(activateLines).toHaveLength(1);
      expect(activateLines[0]).toContain('ocProcPath=False');

      // Protected/PermissionDenied NodeRoot MUST NOT abort InstallOpenCode, while PostInstall still runs Invoke-PhaseAProbe
      const lockedIso = join(root, 'iso-locked-node');
      const lockedNode = join(lockedIso, 'ProgramData', 'imcodes-node');
      const lockedRt = join(lockedIso, 'ProgramFiles', 'IM.codes', 'daemon-runtime');
      mkdirSync(lockedNode, { recursive: true });
      mkdirSync(join(lockedRt, 'releases', '2026.11.7132-dev.7022'), { recursive: true });
      const lockedTrace = join(root, 'locked-oc-trace.txt');
      const lockedHook = join(root, 'locked-oc-hook.ps1');
      writeFileSync(
        lockedHook,
        `param([string]$HomeDir)\nAdd-Content -LiteralPath '${lockedTrace.replace(/'/g, "''")}' -Value "LOCKED_OK:$HomeDir"\n`,
        'utf8',
      );
      const acct = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME ?? ''}`;
      if (acct) {
        execFileSync('icacls.exe', [lockedNode, '/deny', `${acct}:(OI)(CI)F`], { stdio: 'ignore' });
      }
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
            '-Mode', 'InstallOpenCode', '-IsolatedRoot', lockedIso,
            '-Version', '2026.11.7132-dev.7022', '-RuntimeRoot', lockedRt, '-NodeRoot', lockedNode,
            '-OpenCodeInstallHook', lockedHook,
          ],
          { encoding: 'utf8' },
        );
        expect(readFileSync(lockedTrace, 'utf8')).toContain('LOCKED_OK:');
      } finally {
        if (acct) {
          execFileSync('icacls.exe', [lockedNode, '/remove:d', acct], { stdio: 'ignore' });
        }
      }
    },
  );

  it('wires default agent CLIs (codex, claude, agy) into POSIX and Windows installer templates cleanly', () => {
    for (const os of ['linux', 'darwin'] as const) {
      const root = makeTempDir(`imcodes-default-clis-${os}-`);
      const rtDir = createFakeRuntimeDir(root, os, '0.9.5');
      mkdirSync(join(rtDir, 'package', 'dist', 'src', 'node'), { recursive: true });
      writeFileSync(join(rtDir, 'package', 'dist', 'src', 'node', 'install-opencode-cli.js'), '// stub\n', 'utf8');
      writeFileSync(join(rtDir, 'package', 'dist', 'src', 'node', 'install-default-agent-clis.js'), '// stub\n', 'utf8');

      const runnerPath = join(root, `phase-a-${os}.sh`);
      const scriptText = renderPosixPhaseARunnerScript({
        platform: os,
        version: '0.9.5',
        cliWrapperContent: '#!/bin/sh\necho ok\n',
      });
      writeFileSync(runnerPath, scriptText, { mode: 0o755 });

      expect(scriptText).toContain('install_default_agent_clis_best_effort()');
      expect(scriptText).toContain('install-default-agent-clis.js" --home "$EFF_HOME" --skip-opencode');
      expect(scriptText).toContain('IMCODES_SKIP_AGENT_CLIS');

      const traceFile = join(root, 'default-clis-trace.log');
      const defaultHook = join(root, 'default-clis-hook.sh');
      writeFileSync(
        defaultHook,
        `#!/bin/sh
echo "DEFAULT_CLIS_HOOK args=$*" >> "${traceFile}"
home_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home_arg="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$home_arg/.codex/bin" "$home_arg/.local/bin"
printf '#!/bin/sh\necho 0.172.0\n' > "$home_arg/.codex/bin/codex"
printf '#!/bin/sh\necho 2.1.332\n' > "$home_arg/.local/bin/claude"
chmod 755 "$home_arg/.codex/bin/codex" "$home_arg/.local/bin/claude"
`,
        { mode: 0o755 },
      );

      // Hook runs non-blockingly and populates .codex/bin/codex + .local/bin/claude even when IMCODES_SKIP_OPENCODE=1
      const isoRun = join(root, 'iso-run');
      const homeRun = join(root, 'home-run');
      mkdirSync(join(isoRun, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoRun, 'daemon-runtime', 'releases', '0.9.5')]);
      const outRun = execFileSync(
        runnerPath,
        ['--isolated-root', isoRun, '--home', homeRun, '--confirm-fda-switch', '--no-service-control'],
        {
          env: {
            ...process.env,
            IMCODES_SKIP_OPENCODE: '1',
            IMCODES_DEFAULT_CLIS_INSTALL_HOOK: defaultHook,
          },
          encoding: 'utf8',
        },
      );
      expect(outRun).toContain('INSTALL_OK');
      expect(existsSync(join(homeRun, '.opencode', 'bin', 'opencode'))).toBe(false);
      expect(existsSync(join(homeRun, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(homeRun, '.local', 'bin', 'claude'))).toBe(true);
      expect(readFileSync(traceFile, 'utf8')).toContain('--skip-opencode');

      // IMCODES_SKIP_AGENT_CLIS=1 skips all CLI installs cleanly
      const isoSkipAll = join(root, 'iso-skip-all');
      const homeSkipAll = join(root, 'home-skip-all');
      mkdirSync(join(isoSkipAll, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoSkipAll, 'daemon-runtime', 'releases', '0.9.5')]);
      execFileSync(
        runnerPath,
        ['--isolated-root', isoSkipAll, '--home', homeSkipAll, '--confirm-fda-switch', '--no-service-control'],
        {
          env: {
            ...process.env,
            IMCODES_SKIP_AGENT_CLIS: '1',
            IMCODES_DEFAULT_CLIS_INSTALL_HOOK: defaultHook,
          },
          encoding: 'utf8',
        },
      );
      expect(existsSync(join(homeSkipAll, '.codex'))).toBe(false);
      expect(existsSync(join(homeSkipAll, '.local', 'bin', 'claude'))).toBe(false);
      expect(existsSync(join(homeSkipAll, '.local', 'bin', 'agy'))).toBe(false);

      // Compiled install-default-agent-clis.js wires --home "$EFF_HOME" --skip-opencode --registry ... --no-fallback --isolated-test
      const isoNode = join(root, 'iso-default-node');
      const homeNode = join(root, 'home-default-node');
      mkdirSync(join(isoNode, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoNode, 'daemon-runtime', 'releases', '0.9.5')]);
      const nodeTrace = join(root, `default-node-${os}.log`);
      writeFileSync(
        join(isoNode, 'daemon-runtime', 'releases', '0.9.5', 'bin', 'node'),
        `#!/bin/sh\necho "NODE_CALL args=$*" >> "${nodeTrace}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const outNode = execFileSync(
        runnerPath,
        ['--isolated-root', isoNode, '--home', homeNode, '--confirm-fda-switch', '--no-service-control'],
        {
          env: {
            ...process.env,
            IMCODES_SKIP_OPENCODE: '1',
            IMCODES_DEFAULT_CLIS_INSTALL_HOOK: '',
            IMCODES_NPM_REGISTRY: 'http://127.0.0.1:9',
            IMCODES_AGY_MANIFEST_BASE_URL: 'http://127.0.0.1:9',
          },
          encoding: 'utf8',
        },
      );
      expect(outNode).toContain('INSTALL_OK');
      const nodeTraceText = readFileSync(nodeTrace, 'utf8');
      expect(nodeTraceText).toContain('install-default-agent-clis.js');
      expect(nodeTraceText).toContain('--skip-opencode');
      expect(nodeTraceText).toContain('--isolated-test');
      expect(nodeTraceText).toContain('--no-fallback');

      // Symlinked .codex target refuses installation cleanly without failing installer
      const isoSym = join(root, 'iso-sym');
      const homeSym = join(root, 'home-sym');
      mkdirSync(join(isoSym, 'daemon-runtime', 'releases', '0.9.5'), { recursive: true });
      mkdirSync(homeSym, { recursive: true });
      const decoy = join(root, 'decoy');
      mkdirSync(decoy, { recursive: true });
      symlinkSync(decoy, join(homeSym, '.codex'));
      execFileSync('cp', ['-R', `${rtDir}/.`, join(isoSym, 'daemon-runtime', 'releases', '0.9.5')]);
      const symRes = spawnSync(
        runnerPath,
        ['--isolated-root', isoSym, '--home', homeSym, '--confirm-fda-switch', '--no-service-control'],
        { env: { ...process.env, IMCODES_DEFAULT_CLIS_INSTALL_HOOK: defaultHook }, encoding: 'utf8' },
      );
      expect(symRes.status).toBe(0);
      expect(symRes.stderr).toContain('refusing symlinked agent CLI target path');
      expect(existsSync(join(decoy, 'bin', 'codex'))).toBe(false);
    }

    const ps1 = renderWindowsPhaseAInstallerPs1({ version: '2026.11.7132-dev.7022', cliWrapperContent: '@echo off\r\n' });
    expect(ps1).toContain('function Install-DefaultAgentClisBestEffort');
    expect(ps1).toContain('install-default-agent-clis.js');
    expect(ps1).toContain('DefaultAgentClisInstallHook');
    expect(ps1).toContain('IMCODES_SKIP_AGENT_CLIS');
    expect(ps1).toContain("$codexBinDir = Join-Path $codexBaseDir 'bin'");
    expect(ps1).toContain("$localBinDir = Join-Path $localBaseDir 'bin'");
  });
});
