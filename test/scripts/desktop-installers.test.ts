import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error ESM script module
import { buildLinuxInstallers } from '../../scripts/build-linux-installer.mjs';
// @ts-expect-error ESM script module
import { buildMacosInstaller, refreshMacosPkgManifest } from '../../scripts/build-macos-installer.mjs';
// @ts-expect-error ESM script module
import { buildWindowsInstaller } from '../../scripts/build-windows-installer.mjs';
// @ts-expect-error ESM script module
import {
  renderLinuxControlledNodeSystemdUnit,
  renderMacosControlledNodeLaunchDaemonPlist,
  renderMacosControlledNodeWatchdogLaunchDaemonPlist,
} from '../../scripts/desktop-installer-shared.mjs';
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
    });

    expect(existsSync(res.debPath)).toBe(true);
    expect(existsSync(res.shPath)).toBe(true);
    expect(existsSync(`${res.debPath}.manifest.json`)).toBe(true);
    expect(existsSync(`${res.shPath}.manifest.json`)).toBe(true);
    const shManifest = JSON.parse(readFileSync(`${res.shPath}.manifest.json`, 'utf8')) as {
      artifact: { sha256: string };
    };
    expect(shManifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);

    // Verify .deb structure via dpkg-deb
    const debInfo = execFileSync('dpkg-deb', ['--info', res.debPath], { encoding: 'utf8' });
    expect(debInfo).toContain('Package: imcodes-desktop');
    expect(debInfo).toContain('Architecture: amd64');
    const debContents = execFileSync('dpkg-deb', ['--contents', res.debPath], { encoding: 'utf8' });
    expect(debContents).toContain('./opt/imcodes/daemon-runtime/releases/0.9.5/bin/node');
    expect(debContents).toContain('./usr/lib/systemd/user/imcodes.service');
    expect(debContents).toContain('./usr/share/applications/aidesk.desktop');
    expect(debContents).toContain('./var/lib/imcodes-node/imcodes-node');

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
    writeFileSync(keepLock, '{"pid":123}');
    writeFileSync(join(stateLegacy, 'last-upgrade-error.json'), '{"exitCode":-2147020576}');
    writeFileSync(staleTmp, 'old');
    const threeDaysAgo = (Date.now() - 72 * 3600 * 1000) / 1000;
    utimesSync(staleTmp, threeDaysAgo, threeDaysAgo);
    const legacyOut = execFileSync(
      res.shPath,
      ['--isolated-root', isoLegacy, '--home', homeLegacy, '--no-service-control'],
      { encoding: 'utf8' },
    );
    expect(legacyOut).toContain('INSTALL_OK scenario=legacy_broken_takeover');
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(keepLock)).toBe(true);
    expect(readFileSync(keepSrv, 'utf8')).toBe('{"serverId":"keep"}');
  });

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
    const originalPlist = `<plist><dict><key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string></array></dict></plist>\n`;
    writeFileSync(plistPath, originalPlist);
    const macRunner = join(stageOut.scriptsDir, 'phase-a-runner.sh');
    const macDry = execFileSync(
      macRunner,
      ['--isolated-root', isoMacRoot, '--home', isoMacHome, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(macDry).toContain('scenario=macos_launchagent_fda_preserve');
    expect(macDry).toContain('preserve_fda=1');

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
    expect(issText).toContain('imcodes-windows-installer.ps1');
    expect(issText).toContain('imcodes-node.exe');
    expect(issText).toContain('[UninstallRun]');
    expect(existsSync(res.ps1Path)).toBe(true);
    expect(existsSync(res.cmdPath)).toBe(true);
    expect(existsSync(`${res.issPath}.manifest.json`)).toBe(true);
    expect(readFileSync(res.ps1Path, 'utf8')).toContain('legacy_broken_takeover');
  });

  it('integrates Linux, macOS, and Windows unified installer steps into .github/workflows/build-node-exe.yml', () => {
    const raw = readFileSync('.github/workflows/build-node-exe.yml', 'utf8');
    const parsed = parseYaml(raw) as {
      jobs: { build: { steps: Array<{ name?: string; run?: string; with?: { path?: string } }> } };
    };
    const names = parsed.jobs.build.steps.map((s) => s.name ?? '');
    expect(names.some((n) => n.includes('Linux unified installers'))).toBe(true);
    expect(names.some((n) => n.includes('macOS .pkg installer'))).toBe(true);
    expect(names.some((n) => n.includes('Windows Inno Setup'))).toBe(true);
    const uploadStep = parsed.jobs.build.steps.find((s) => s.name === 'Upload executable artifact');
    expect(uploadStep?.with?.path).toContain('dist-node-exe/installers/**');

    // F7: macOS CI workflow refreshes pkg manifest after signing and notarizing
    const macStep = parsed.jobs.build.steps.find((s) => (s.name ?? '').includes('macOS .pkg installer'));
    expect(macStep?.run).toContain('--refresh-manifest');
    expect(macStep?.run).toContain('--notarized');

    // F8: Linux CI workflow avoids dpkg-deb --contents | head SIGPIPE under pipefail
    const linuxStep = parsed.jobs.build.steps.find((s) => (s.name ?? '').includes('Linux unified installers'));
    expect(linuxStep?.run).not.toMatch(/dpkg-deb --contents[^\n]*\|\s*head/u);
    expect(linuxStep?.run).toContain('DEB_CONTENTS_TMP=');
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
    });

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

  it('aligns service/watchdog entrypoints, enforces minVersion takeover, live lock handling, symlink/dir rollback, and isolated path guards (F2, F3, F4, F6)', async () => {
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

    // F3: Live daemon lock that refuses to stop MUST abort BEFORE modifying CLI symlink or current/!
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    mkdirSync(join(isoHome, '.imcodes'), { recursive: true });
    const lockPath = join(isoHome, '.imcodes', 'daemon.lock.json');
    writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() }));
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
  });

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
    expect(ps1Text).toContain("ValidateSet('Probe', 'Plan', 'PreInstall', 'PostInstall', 'CleanupTmp', 'Rollback')");
    expect(ps1Text).toContain('imcodes-node-watchdog');
    expect(ps1Text).toContain('Resolve-CanonicalWindowsPath');

    const cmdText = readFileSync(res.cmdPath, 'utf8');
    expect(cmdText).toContain('goto :check_bundled');
    expect(cmdText).toContain('goto :check_npm');
    expect(cmdText).toContain('IMCODES_EXIT=%ERRORLEVEL%');
    // F5: No parenthesized compound if (...) else (...) block prematurely expanding %RESOLVED_NODE%
    expect(cmdText).not.toMatch(/^\s*\(\s*$/m);
  });
});
