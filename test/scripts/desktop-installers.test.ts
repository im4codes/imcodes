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
    expect(ps1Text).not.toContain('Win32_Process');
    expect(ps1Text).toContain('function Get-WindowsServicesSnapshot');
    expect(ps1Text).toContain('function Invoke-Schtasks');
    expect(ps1Text).toContain('[string]$SchtasksExe = \'\'');
    expect(ps1Text).toContain('userDaemonWasRunning');
    expect(ps1Text).toContain('canonical_path_symlink_loop');
  });

  it('verifies lock startToken ownership on POSIX: ignores stale PID reuse, stops matching owner, and fails closed on unknown/unprobeable tokens (F3-R2)', async () => {
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

      // 5) macOS ps: startToken scheme coverage via fake ps binary (mismatch untouched, missing fails closed, matching stops)
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
if [ "$last" = "9999999" ] || [ ! -r "/proc/$last/stat" ]; then exit 1; fi
st="$(awk '{ idx=0; for(i=length($0);i>=1;i--) if(substr($0,i,1)==")"){idx=i;break}; rest=substr($0,idx+1); sub(/^[[:space:]]+/,"",rest); split(rest,f,/[[:space:]]+/); print f[1] }' "/proc/$last/stat" 2>/dev/null || true)"
if [ "$st" = "Z" ] || [ "$st" = "X" ]; then
  echo "Z    Sat Nov 14  1:02:03 2026"
else
  echo "Ss   Sat Nov 14  1:02:03 2026"
fi
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

  it('snapshots and reconciles Linux systemctl & macOS launchctl services across clean, active, and stopped states on rollback (F4-R2)', async () => {
    const root = makeTempDir();
    // Create a fake stateful systemctl binary backed by JSON state in SYSTEMCTL_STATE_FILE
    const createStatefulSystemctl = (statePath: string, logPath: string, initial: Record<string, { enabled: boolean; active: boolean }>) => {
      writeFileSync(statePath, JSON.stringify(initial, null, 2));
      const bin = join(root, `fake-systemctl-${Math.random().toString(36).slice(2, 8)}.mjs`);
      writeFileSync(
        bin,
        `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(statePath)};
const logFile = ${JSON.stringify(logPath)};
appendFileSync(logFile, args.join(' ') + '\\n');
const isUser = args[0] === '--user';
const filtered = isUser ? args.slice(1) : args;
const cmd = filtered[0] || '';
const unit = filtered[1] || '';
const key = (isUser ? 'user:' : 'sys:') + unit;
const st = JSON.parse(readFileSync(stateFile, 'utf8'));
if (cmd === 'is-enabled') process.exit(st[key]?.enabled ? 0 : 1);
if (cmd === 'is-active') process.exit(st[key]?.active ? 0 : 3);
if (cmd === 'daemon-reload' || cmd === 'reset-failed') process.exit(0);
st[key] = st[key] || { enabled: false, active: false };
if (cmd === 'enable') st[key].enabled = true;
else if (cmd === 'disable') st[key].enabled = false;
else if (cmd === 'start' || cmd === 'restart') st[key].active = true;
else if (cmd === 'stop') st[key].active = false;
writeFileSync(stateFile, JSON.stringify(st, null, 2));
process.exit(0);
`,
        { mode: 0o755 },
      );
      return bin;
    };

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

    // Case 1: Clean system -> install -> rollback must leave zero enabled/active units and zero unit files
    const st1 = join(root, 'st-clean.json');
    const log1 = join(root, 'log-clean.txt');
    const sc1 = createStatefulSystemctl(st1, log1, {});
    const iso1 = join(root, 'iso-clean');
    const home1 = join(root, 'home-clean');
    execFileSync(
      res.shPath,
      ['--isolated-root', iso1, '--home', home1, '--apply-services'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc1 }, encoding: 'utf8' },
    );
    expect(JSON.parse(readFileSync(st1, 'utf8'))['user:imcodes.service']).toEqual({ enabled: true, active: true });
    execFileSync(
      res.shPath,
      ['--isolated-root', iso1, '--home', home1, '--rollback'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc1 }, encoding: 'utf8' },
    );
    const afterClean = JSON.parse(readFileSync(st1, 'utf8'));
    expect(afterClean['user:imcodes.service']).toEqual({ enabled: false, active: false });
    expect(existsSync(join(home1, '.config', 'systemd', 'user', 'imcodes.service'))).toBe(false);
    expect(existsSync(join(home1, '.config', 'systemd', 'user', 'default.target.wants', 'imcodes.service'))).toBe(false);
    expect(existsSync(join(iso1, 'controlled-node', 'imcodes-node'))).toBe(false);
    expect(readFileSync(log1, 'utf8')).toContain('reset-failed imcodes.service');

    // Case 2: Pre-existing DISABLED & STOPPED unit -> install -> rollback MUST restore old file and stay disabled & stopped (never started!)
    const st2 = join(root, 'st-stopped.json');
    const log2 = join(root, 'log-stopped.txt');
    const sc2 = createStatefulSystemctl(st2, log2, {
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
    expect(JSON.parse(readFileSync(st2, 'utf8'))['user:imcodes.service']).toEqual({ enabled: true, active: true });
    execFileSync(
      res.shPath,
      ['--isolated-root', iso2, '--home', home2, '--rollback'],
      { env: { ...process.env, IMCODES_SYSTEMCTL_BIN: sc2 }, encoding: 'utf8' },
    );
    const afterStopped = JSON.parse(readFileSync(st2, 'utf8'));
    expect(afterStopped['user:imcodes.service']).toEqual({ enabled: false, active: false });
    expect(readFileSync(join(home2, '.config', 'systemd', 'user', 'imcodes.service'), 'utf8')).toBe(oldUnit);

    // Case 3: Pre-existing ENABLED & ACTIVE unit -> install -> rollback MUST restore old file, enable, and restart/start
    const st3 = join(root, 'st-active.json');
    const log3 = join(root, 'log-active.txt');
    const sc3 = createStatefulSystemctl(st3, log3, {
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
    const afterActive = JSON.parse(readFileSync(st3, 'utf8'));
    expect(afterActive['user:imcodes.service']).toEqual({ enabled: true, active: true });
    expect(readFileSync(join(home3, '.config', 'systemd', 'user', 'imcodes.service'), 'utf8')).toBe(oldActiveUnit);

    // Case 4: macOS runner launchctl stateful rollback (using IMCODES_LAUNCHCTL_BIN)
    const macRt = createFakeRuntimeDir(root, 'darwin', '0.9.5');
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
    const launchStateFile = join(root, 'launchctl-state.json');
    const launchLogFile = join(root, 'launchctl-log.txt');
    writeFileSync(
      launchStateFile,
      JSON.stringify({ [daemonLabel]: { loaded: true, active: true, plist: '' } }),
    );
    const fakeLaunchctl = join(root, 'fake-launchctl.mjs');
    writeFileSync(
      fakeLaunchctl,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stFile = ${JSON.stringify(launchStateFile)};
appendFileSync(${JSON.stringify(launchLogFile)}, args.join(' ') + '\\n');
const st = JSON.parse(readFileSync(stFile, 'utf8'));
const cmd = args[0];
if (cmd === 'print') {
  const lbl = args[1];
  const entry = st[lbl];
  if (!entry?.loaded) process.exit(113);
  console.log('state = ' + (entry.active ? 'running' : 'not running'));
  process.exit(0);
}
if (cmd === 'bootout') {
  const lbl = args[1];
  delete st[lbl];
} else if (cmd === 'bootstrap') {
  const domain = args[1];
  const plist = args[2];
  const text = readFileSync(plist, 'utf8');
  const m = text.match(/<key>Label<\\/key>\\s*<string>([^<]+)<\\/string>/);
  const lbl = domain + '/' + (m ? m[1] : 'unknown');
  st[lbl] = { loaded: true, active: false, plist };
} else if (cmd === 'kickstart') {
  const lbl = args[args.length - 1];
  if (st[lbl]) st[lbl].active = true;
}
writeFileSync(stFile, JSON.stringify(st, null, 2));
process.exit(0);
`,
      { mode: 0o755 },
    );

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
    const macStateAfter = JSON.parse(readFileSync(launchStateFile, 'utf8'));
    expect(macStateAfter[daemonLabel]?.loaded).toBe(true);
    expect(macStateAfter[daemonLabel]?.active).toBe(true);
    expect(macStateAfter['system/cc.imcodes.node']).toBeUndefined();
    expect(macStateAfter['system/cc.imcodes.node.watchdog']).toBeUndefined();
    expect(readFileSync(join(macPlistDir, 'imcodes.daemon.plist'), 'utf8')).toBe(oldMacPlist);
    expect(readFileSync(launchLogFile, 'utf8')).toContain(`bootout ${daemonLabel}`);
  });
});
