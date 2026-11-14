import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import {
  assertSafeIsolatedTargetPath,
  planDesktopInstallerCompatibility,
  renderWindowsImcodesCliWrapper,
  resolveImcodesCliTarget,
} from '../../shared/desktop-installer-compatibility.js';
import {
  assertSafeNodeIsolatedTargetPath,
  cleanupExpiredTempArtifacts,
  createRollbackSnapshot,
  installDaemonRuntimeCurrentLink,
  probeDesktopInstallEnvironment,
  restoreRollbackSnapshot,
} from '../../src/node/desktop-installer-probe.js';
import {
  inspectImcodesCliResolution,
  installImcodesCliWrapper,
} from '../../src/node/imcodes-cli-wrapper.js';
import { discoverCodingDaemonRuntime } from '../../src/node/local-daemon-control.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-p3-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function createMockDaemonRuntime(
  runtimeRoot: string,
  version: string,
  options: { useCurrentSubdir?: boolean } = {},
): string {
  const targetDir = options.useCurrentSubdir
    ? join(runtimeRoot, 'releases', version)
    : runtimeRoot;
  mkdirSync(join(targetDir, 'bin'), { recursive: true });
  mkdirSync(join(targetDir, 'package', 'dist', 'src'), { recursive: true });
  writeFileSync(
    join(targetDir, 'package', 'package.json'),
    JSON.stringify({ name: 'imcodes', version }),
    'utf8',
  );
  // Real shell script acting as bin/node so empty-PATH execution works deterministically.
  const nodeBin = join(targetDir, 'bin', 'node');
  writeFileSync(
    nodeBin,
    `#!/bin/sh\nentry="$1"\nshift\nprintf 'RUNTIME=%s VERSION=%s ARGS=%s\\n' "${targetDir}" "${version}" "$*"\n`,
    'utf8',
  );
  chmodSync(nodeBin, 0o755);
  writeFileSync(
    join(targetDir, 'package', 'dist', 'src', 'index.js'),
    `console.log(${JSON.stringify(version)});\n`,
    'utf8',
  );
  if (options.useCurrentSubdir) {
    installDaemonRuntimeCurrentLink(runtimeRoot, targetDir, 'linux');
  }
  return targetDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Phase A dual-path compatibility probe and 5-scenario state machine', () => {
  it('routes a clean environment to scenario 1 (clean full install expecting pending_setup)', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });

    const probe = probeDesktopInstallEnvironment({
      platform: 'linux',
      homeDir,
      controlledNodeRoot: join(root, 'var-lib-imcodes-node'),
      controlledNodeServicePath: join(root, 'etc-systemd', 'imcodes-node.service'),
      daemonRuntimeRoot: join(root, 'opt-imcodes', 'daemon-runtime'),
      cliPath: join(root, 'bin', 'imcodes'),
      env: {},
    });
    const plan = planDesktopInstallerCompatibility(probe);

    expect(plan.scenario).toBe('clean');
    expect(plan.installControlledNode).toBe(true);
    expect(plan.installRemoteDesktop).toBe(true);
    expect(plan.installComputerUse).toBe(true);
    expect(plan.installDaemonRuntime).toBe(true);
    expect(plan.installUserDaemonAutostart).toBe(true);
    expect(plan.installDesktopEntry).toBe(true);
    expect(plan.installCliWrapper).toBe(true);
    expect(plan.expectsPendingSetupWizard).toBe(true);
    expect(plan.skipNodeReEnroll).toBe(false);
  });

  it('routes a partial/semi-installed machine to scenario 2 preserving valid credentials and server.json', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    const stateDir = join(homeDir, '.imcodes');
    const nodeRoot = join(root, 'node-root');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(nodeRoot, { recursive: true });
    writeFileSync(
      join(nodeRoot, 'credential.json'),
      JSON.stringify({ nodeId: '1234567890', token: 'secret-token' }),
    );
    writeFileSync(
      join(stateDir, 'server.json'),
      JSON.stringify({ serverId: 'srv-1', workerUrl: 'https://app.im.codes', token: 'tok' }),
    );
    writeFileSync(join(stateDir, 'context.sqlite'), 'sqlite-bytes');

    const probe = probeDesktopInstallEnvironment({
      platform: 'linux',
      homeDir,
      controlledNodeRoot: nodeRoot,
      controlledNodeServicePath: join(root, 'missing-node.service'),
      daemonRuntimeRoot: join(root, 'opt-imcodes', 'daemon-runtime'),
      cliPath: join(root, 'bin', 'imcodes'),
      env: {},
    });
    const plan = planDesktopInstallerCompatibility(probe);

    expect(probe.controlledNode.hasValidCredential).toBe(true);
    expect(probe.userDaemon.hasValidServerJson).toBe(true);
    expect(probe.userDaemon.sqliteFiles).toEqual([join(stateDir, 'context.sqlite')]);
    expect(plan.scenario).toBe('partial_preserve');
    expect(plan.skipNodeReEnroll).toBe(true);
    expect(plan.preserveUserState).toBe(true);
    expect(plan.expectsPendingSetupWizard).toBe(false);
    expect(plan.installDaemonRuntime).toBe(true);
    expect(plan.installUserDaemonAutostart).toBe(true);
  });

  it('routes a developer symlink inside a git checkout to scenario 3 exempt by default, unless forceTakeover=true', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    const devRepo = join(root, 'codedeck');
    const binDir = join(root, 'usr-local-bin');
    mkdirSync(join(devRepo, '.git'), { recursive: true });
    mkdirSync(join(devRepo, 'dist', 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const devEntry = join(devRepo, 'dist', 'src', 'index.js');
    writeFileSync(devEntry, '#!/usr/bin/env node\nconsole.log("dev");\n', { mode: 0o755 });
    const cliPath = join(binDir, 'imcodes');
    symlinkSync(devEntry, cliPath);

    const probe = probeDesktopInstallEnvironment({
      platform: 'linux',
      homeDir,
      controlledNodeRoot: join(root, 'node-root'),
      controlledNodeServicePath: join(root, 'node.service'),
      daemonRuntimeRoot: join(root, 'daemon-runtime'),
      cliPath,
      env: {},
    });

    const exemptPlan = planDesktopInstallerCompatibility(probe);
    expect(probe.cli.isDevCheckout).toBe(true);
    expect(exemptPlan.scenario).toBe('dev_symlink_exempt');
    expect(exemptPlan.preserveDevCliLink).toBe(true);
    expect(exemptPlan.installCliWrapper).toBe(false);
    expect(exemptPlan.preserveUserDaemonAutostart).toBe(true);
    expect(exemptPlan.switchToBundledRuntime).toBe(false);

    // Real wrapper installer also refuses to overwrite dev symlink unless forced
    const installRes = installImcodesCliWrapper({
      platform: 'linux',
      wrapperPath: cliPath,
      runtimeRoot: join(root, 'daemon-runtime'),
    });
    expect(installRes.status).toBe('preserved_dev_symlink');
    expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);

    const forcedPlan = planDesktopInstallerCompatibility(probe, { forceTakeover: true });
    expect(forcedPlan.scenario).toBe('clean');
    expect(forcedPlan.installCliWrapper).toBe(true);
  });

  it('routes macOS LaunchAgent with existing Homebrew ProgramArguments[0] to scenario 4 preserving FDA unless confirmed', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    const plistDir = join(homeDir, 'Library', 'LaunchAgents');
    const homebrewBin = join(root, 'opt', 'homebrew', 'bin');
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(homebrewBin, { recursive: true });
    const fakeNode = join(homebrewBin, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\n', { mode: 0o755 });
    const plistPath = join(plistDir, 'imcodes.daemon.plist');
    writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fakeNode}</string>
    <string>/opt/homebrew/lib/node_modules/imcodes/dist/src/index.js</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>`,
      'utf8',
    );

    const probe = probeDesktopInstallEnvironment({
      platform: 'darwin',
      homeDir,
      controlledNodeRoot: join(root, 'node-root'),
      controlledNodeServicePath: join(root, 'cc.imcodes.node.plist'),
      daemonRuntimeRoot: join(root, 'daemon-runtime'),
      cliPath: join(root, 'bin', 'imcodes'),
      autostartPath: plistPath,
      env: {},
    });

    const preservePlan = planDesktopInstallerCompatibility(probe);
    expect(probe.userDaemon.launchAgentProgramArg0).toBe(fakeNode);
    expect(probe.userDaemon.launchAgentPointsToBundledRuntime).toBe(false);
    expect(preservePlan.scenario).toBe('macos_launchagent_fda_preserve');
    expect(preservePlan.preserveLaunchAgentExecutable).toBe(true);
    expect(preservePlan.installUserDaemonAutostart).toBe(false);
    expect(preservePlan.switchToBundledRuntime).toBe(false);

    const switchedPlan = planDesktopInstallerCompatibility(probe, { confirmFdaSwitch: true });
    expect(switchedPlan.scenario).toBe('partial_preserve');
  });

  it('routes stale/broken npm install + expired .tmp to scenario 5, cleans only expired .tmp, and supports full rollback', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    const stateDir = join(homeDir, '.imcodes');
    const nodeRoot = join(root, 'node-root');
    const runtimeRoot = join(root, 'daemon-runtime');
    const systemdDir = join(homeDir, '.config', 'systemd', 'user');
    const oldNpmRoot = join(root, 'npm-old', 'lib', 'node_modules', 'imcodes');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(nodeRoot, { recursive: true });
    mkdirSync(systemdDir, { recursive: true });
    mkdirSync(join(oldNpmRoot, 'dist', 'src'), { recursive: true });

    const serverJsonPath = join(stateDir, 'server.json');
    const serverContent = JSON.stringify({ serverId: 'srv-keep', workerUrl: 'https://app.im.codes', token: 'keep-me' });
    writeFileSync(serverJsonPath, serverContent);
    const sqlitePath = join(stateDir, 'memory.sqlite');
    const sqliteContent = Buffer.from('SQLite format 3\0important-data');
    writeFileSync(sqlitePath, sqliteContent);
    const lockPath = join(stateDir, 'daemon.lock.json');
    writeFileSync(lockPath, JSON.stringify({ pid: 43210 }));

    // Simulate legacy exit -2147020576 marker + stale npm autostart
    writeFileSync(
      join(stateDir, 'last-upgrade-error.json'),
      JSON.stringify({ exitCode: -2147020576, message: 'upgrade failed -2147020576' }),
    );
    writeFileSync(join(oldNpmRoot, 'package.json'), JSON.stringify({ name: 'imcodes', version: '2026.9.0' }));
    const oldEntry = join(oldNpmRoot, 'dist', 'src', 'index.js');
    writeFileSync(oldEntry, 'console.log("old");');
    const unitPath = join(systemdDir, 'imcodes.service');
    const originalUnit = `[Service]\nExecStart=${oldEntry} start --foreground\n`;
    writeFileSync(unitPath, originalUnit);

    const cliPath = join(root, 'bin', 'imcodes');
    mkdirSync(join(root, 'bin'), { recursive: true });
    const originalCli = '#!/bin/sh\necho old-npm\n';
    writeFileSync(cliPath, originalCli, { mode: 0o755 });

    // Create 1 expired .tmp file (> 24h old) and 1 fresh .tmp file (< 5m old)
    const nowMs = 1_794_640_000_000;
    const expiredTmp = join(stateDir, 'upgrade-stale.tmp');
    const freshTmp = join(stateDir, 'active-download.tmp');
    writeFileSync(expiredTmp, 'stale');
    writeFileSync(freshTmp, 'fresh');
    utimesSync(expiredTmp, (nowMs - 48 * 3600 * 1000) / 1000, (nowMs - 48 * 3600 * 1000) / 1000);
    utimesSync(freshTmp, (nowMs - 60 * 1000) / 1000, (nowMs - 60 * 1000) / 1000);

    const probe = probeDesktopInstallEnvironment({
      platform: 'linux',
      homeDir,
      controlledNodeRoot: nodeRoot,
      controlledNodeServicePath: join(root, 'imcodes-node.service'),
      daemonRuntimeRoot: runtimeRoot,
      cliPath,
      autostartPath: unitPath,
      minimumRuntimeVersion: '2026.11.0',
      nowMs,
      env: {},
    });
    const plan = planDesktopInstallerCompatibility(probe);

    expect(plan.scenario).toBe('legacy_broken_takeover');
    expect(plan.checkSingleInstanceLock).toBe(true);
    expect(plan.stopUserDaemonTask).toBe(true);
    expect(plan.createRollbackSnapshot).toBe(true);
    expect(plan.switchToBundledRuntime).toBe(true);
    expect(plan.cleanExpiredTempArtifacts).toBe(true);
    expect(probe.tempArtifacts.expiredPaths).toEqual([expiredTmp]);
    expect(probe.tempArtifacts.activePaths).toEqual([freshTmp]);

    // Take rollback snapshot before mutating
    const snapshotDir = join(root, 'rollback-snapshot');
    createRollbackSnapshot({
      platform: 'linux',
      scenario: plan.scenario,
      snapshotDir,
      trackedPaths: [cliPath, unitPath, join(runtimeRoot, 'current')],
      preservedPaths: [serverJsonPath, sqlitePath],
    });

    // Apply mutations (clean expired tmp, install daemon-runtime/current, overwrite wrapper & unit)
    const removed = cleanupExpiredTempArtifacts({
      platform: 'linux',
      scanRoots: [stateDir],
      nowMs,
    });
    expect(removed).toEqual([expiredTmp]);
    expect(existsSync(expiredTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(sha256(readFileSync(sqlitePath))).toBe(sha256(sqliteContent));

    createMockDaemonRuntime(runtimeRoot, '2026.11.0', { useCurrentSubdir: true });
    installImcodesCliWrapper({ platform: 'linux', wrapperPath: cliPath, runtimeRoot });
    writeFileSync(unitPath, `[Service]\nExecStart=${runtimeRoot}/current/bin/node ${runtimeRoot}/current/package/dist/src/index.js start --foreground\n`);

    // Rollback must cleanly restore previous CLI, systemd unit, remove newly created current link, and verify preserved state
    const restoreRes = restoreRollbackSnapshot(snapshotDir);
    expect(restoreRes.restoredCount).toBe(2);
    expect(restoreRes.removedCount).toBe(1);
    expect(restoreRes.verifiedPreservedCount).toBe(2);
    expect(readFileSync(cliPath, 'utf8')).toBe(originalCli);
    expect(readFileSync(unitPath, 'utf8')).toBe(originalUnit);
    expect(existsSync(join(runtimeRoot, 'current'))).toBe(false);
    expect(readFileSync(serverJsonPath, 'utf8')).toBe(serverContent);
  });

  it('rejects system/default state roots in isolated guard while allowing Windows temp directories under user profile', () => {
    expect(() => assertSafeIsolatedTargetPath('/var/lib/imcodes-node/credential.json', 'linux', '/home/k')).toThrow(
      /unsafe_installer_target_inside_system_root/,
    );
    expect(() => assertSafeIsolatedTargetPath('/home/k/.imcodes/server.json', 'linux', '/home/k')).toThrow(
      /unsafe_installer_target_inside_system_root/,
    );
    expect(() => assertSafeIsolatedTargetPath('/opt/imcodes/daemon-runtime', 'linux', '/home/k')).toThrow(
      /unsafe_installer_target_inside_system_root/,
    );
    expect(() =>
      assertSafeIsolatedTargetPath('C:\\ProgramData\\imcodes-node\\credential.json', 'win32', 'C:\\Users\\alice'),
    ).toThrow(/unsafe_installer_target_inside_system_root/);
    expect(() =>
      assertSafeIsolatedTargetPath('C:\\Users\\alice\\.imcodes\\server.json', 'win32', 'C:\\Users\\alice'),
    ).toThrow(/unsafe_installer_target_inside_system_root/);
    // %TEMP% under C:\Users\alice\AppData\Local\Temp must be permitted for isolated remote gates
    expect(() =>
      assertSafeIsolatedTargetPath(
        'C:\\Users\\alice\\AppData\\Local\\Temp\\imcodes-p3-test-123',
        'win32',
        'C:\\Users\\alice',
      ),
    ).not.toThrow();
  });
});

describe('AC 2: discoverCodingDaemonRuntime current/ alignment & imcodes CLI thin forwarder', () => {
  it('discoverCodingDaemonRuntime prefers <bundleDir>/current/ over direct <bundleDir>/', () => {
    const root = makeTempDir();
    const runtimeRoot = join(root, 'daemon-runtime');
    // Write a direct runtime at runtimeRoot (version 1.0.0)
    createMockDaemonRuntime(runtimeRoot, '1.0.0', { useCurrentSubdir: false });
    // Also write releases/2.0.0 + current symlink (version 2.0.0)
    const release2 = createMockDaemonRuntime(runtimeRoot, '2.0.0', { useCurrentSubdir: true });

    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: {},
      execPath: join(root, 'aidesk'),
      bundleDirs: [runtimeRoot],
      cliCandidates: [],
    });

    expect(discovered).not.toBeNull();
    expect(discovered?.version).toBe('2.0.0');
    expect(discovered?.bundleDir).toBe(join(runtimeRoot, 'current'));
    expect(discovered?.executable).toBe(join(runtimeRoot, 'current', 'bin', 'node'));
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(release2);
  });

  it('resolves CLI forwarder priority cleanly and executes POSIX wrapper under empty PATH', () => {
    const root = makeTempDir();
    const runtimeRoot = join(root, 'daemon-runtime');
    const binDir = join(root, 'bin');
    const fakeHome = join(root, 'home');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });

    createMockDaemonRuntime(runtimeRoot, '3.1.4', { useCurrentSubdir: true });
    const wrapperPath = join(binDir, 'imcodes');
    const installed = installImcodesCliWrapper({
      platform: 'linux',
      wrapperPath,
      runtimeRoot,
    });
    expect(installed.status).toBe('installed');

    // Run POSIX wrapper with completely empty PATH!
    const outCurrent = execFileSync(wrapperPath, ['--version', '--check'], {
      env: { PATH: '/nonexistent', HOME: fakeHome },
      encoding: 'utf8',
    });
    expect(outCurrent).toContain('VERSION=3.1.4');
    expect(outCurrent).toContain('ARGS=--version --check');

    // Inspect target resolution across all priority tiers
    const npmEntry = join(root, 'npm-global', 'lib', 'node_modules', 'imcodes', 'dist', 'src', 'index.js');
    mkdirSync(join(npmEntry, '..'), { recursive: true });
    writeFileSync(npmEntry, 'console.log("npm");');
    const devEntry = join(root, 'dev', 'dist', 'src', 'index.js');
    mkdirSync(join(devEntry, '..'), { recursive: true });
    writeFileSync(devEntry, 'console.log("dev");');

    expect(
      inspectImcodesCliResolution({
        platform: 'linux',
        runtimeRoot,
        wrapperPath,
        devEntryOverride: devEntry,
        npmFallbackEntry: npmEntry,
      })?.source,
    ).toBe('dev_override');

    expect(
      inspectImcodesCliResolution({
        platform: 'linux',
        runtimeRoot,
        wrapperPath,
        npmFallbackEntry: npmEntry,
      })?.source,
    ).toBe('daemon_runtime_current');

    // Remove current/ -> falls back to direct runtime, or if absent falls back to npm
    rmSync(join(runtimeRoot, 'current'), { force: true });
    expect(
      inspectImcodesCliResolution({
        platform: 'linux',
        runtimeRoot,
        wrapperPath,
        npmFallbackEntry: npmEntry,
      })?.source,
    ).toBe('npm_fallback');

    // Also validate Windows .cmd template includes all priority steps & no recursive self call
    const cmdText = renderWindowsImcodesCliWrapper({ runtimeRoot: 'C:\\Program Files\\IM.codes\\daemon-runtime' });
    expect(cmdText).toContain('IMCODES_CLI_DEV_ENTRY');
    expect(cmdText).toContain('%RT_ROOT%\\current\\node.exe');
    expect(cmdText).toContain('%RT_ROOT%\\node.exe');
    expect(cmdText).toContain('if /I "%APPDATA%\\npm\\imcodes.cmd"=="%~f0" goto :not_found');
    expect(resolveImcodesCliTarget({ platform: 'win32' })).toBeNull();
  });

  it('does not leak host system service paths when controlledNodeRoot is isolated', () => {
    const root = makeTempDir();
    const homeDir = join(root, 'home');
    const isoNodeRoot = join(root, 'isolated-node');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(isoNodeRoot, { recursive: true });

    const probe = probeDesktopInstallEnvironment({
      platform: 'linux',
      homeDir,
      controlledNodeRoot: isoNodeRoot,
      daemonRuntimeRoot: join(root, 'daemon-runtime'),
      cliPath: join(root, 'bin', 'imcodes'),
      env: {},
    });
    const plan = planDesktopInstallerCompatibility(probe);
    expect(probe.controlledNode.serviceRegistered).toBe(false);
    expect(plan.scenario).toBe('clean');
  });

  it('rejects traversal, system paths, real-home escapes, and symlinked ancestor escapes in isolated mode (F6)', () => {
    const root = makeTempDir();
    const isoRoot = join(root, 'isolated');
    const fakeHome = join(root, 'fake-home');
    mkdirSync(join(isoRoot, 'bin'), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });

    // Lexical traversal & forbidden roots across POSIX and Windows
    expect(() =>
      assertSafeIsolatedTargetPath(`${isoRoot}/../var/lib/imcodes-node`, 'linux', fakeHome, isoRoot),
    ).toThrow(/unsafe_installer_target_inside_system_root|unsafe_installer_target_outside_isolated_root/);
    expect(() =>
      assertSafeIsolatedTargetPath(`${fakeHome}/.imcodes/daemon.lock.json`, 'linux', fakeHome, isoRoot),
    ).toThrow(/unsafe_installer_target_inside_system_root|unsafe_installer_target_outside_isolated_root/);
    expect(() =>
      assertSafeIsolatedTargetPath('/Library/LaunchDaemons/cc.imcodes.node.plist', 'darwin', fakeHome, isoRoot),
    ).toThrow(/unsafe_installer_target_inside_system_root/);
    expect(() =>
      assertSafeIsolatedTargetPath('C:\\Users\\Alice\\Desktop\\..\\AppData\\Roaming\\imcodes', 'win32', 'C:\\Users\\Alice', 'C:\\Temp\\iso'),
    ).toThrow(/unsafe_installer_target_inside_system_root|unsafe_installer_target_outside_isolated_root/);

    // Ancestor symlink escaping into forbidden real-home or system path must be blocked
    const escapeTarget = join(fakeHome, '.imcodes');
    mkdirSync(escapeTarget, { recursive: true });
    const symlinkedAncestor = join(isoRoot, 'escaped-dir');
    symlinkSync(escapeTarget, symlinkedAncestor);
    expect(() =>
      assertSafeNodeIsolatedTargetPath(join(symlinkedAncestor, 'state.json'), 'linux', fakeHome, isoRoot, 'container'),
    ).toThrow(/unsafe_installer_target_inside_system_root|unsafe_installer_target_outside_isolated_root/);

    // Leaf symlink in entry mode inside isolatedRoot/bin (Scenario 3 dev-link) stays allowed when parent resolves safely
    const devEntry = join(root, 'dev-repo', 'dist', 'index.js');
    mkdirSync(join(devEntry, '..'), { recursive: true });
    writeFileSync(devEntry, '#!/usr/bin/env node\n');
    const entrySymlink = join(isoRoot, 'bin', 'imcodes');
    symlinkSync(devEntry, entrySymlink);
    expect(() =>
      assertSafeNodeIsolatedTargetPath(entrySymlink, 'linux', fakeHome, isoRoot, 'entry'),
    ).not.toThrow();

    // Missing homeDir defaults under isolatedRoot/home instead of real HOME
    const derivedProbe = probeDesktopInstallEnvironment({
      platform: 'linux',
      isolatedRoot: isoRoot,
      env: { HOME: fakeHome },
    });
    expect(derivedProbe.userDaemon.homeDir).toBe(join(isoRoot, 'home'));
  });

  it('replaces pre-existing global-npm symlink atomically without corrupting target and restores non-symlink dir current (F4)', () => {
    const root = makeTempDir();
    const binDir = join(root, 'bin');
    const npmPkgDir = join(root, 'npm-global', 'lib', 'node_modules', 'imcodes', 'dist');
    const runtimeRoot = join(root, 'daemon-runtime');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(npmPkgDir, { recursive: true });
    mkdirSync(join(runtimeRoot, 'releases', '0.9.5'), { recursive: true });

    const npmTarget = join(npmPkgDir, 'index.js');
    const originalNpmBytes = '#!/usr/bin/env node\nconsole.log("REAL_NPM_CLI_ORIGINAL");\n';
    writeFileSync(npmTarget, originalNpmBytes, 'utf8');
    chmodSync(npmTarget, 0o755);

    const cliPath = join(binDir, 'imcodes');
    symlinkSync(npmTarget, cliPath);

    // Pre-existing real directory (non-symlink) at daemon-runtime/current with nested file
    const currentDir = join(runtimeRoot, 'current');
    mkdirSync(join(currentDir, 'nested'), { recursive: true });
    writeFileSync(join(currentDir, 'nested', 'state.txt'), 'old-current-dir-content', 'utf8');

    const snapshotDir = join(root, 'snapshot');
    createRollbackSnapshot({
      platform: 'linux',
      scenario: 'partial_preserve',
      snapshotDir,
      trackedPaths: [cliPath, currentDir],
      preservedPaths: [],
      homeDir: root,
      isolatedRoot: root,
    });

    // Install atomic wrapper replacing symlink
    const installed = installImcodesCliWrapper({
      platform: 'linux',
      wrapperPath: cliPath,
      runtimeRoot,
    });
    expect(installed.status).toBe('installed');
    expect(lstatSync(cliPath).isSymbolicLink()).toBe(false);
    // Original npm package file MUST remain completely untouched!
    expect(readFileSync(npmTarget, 'utf8')).toBe(originalNpmBytes);

    // Mutate currentDir into symlink to 0.9.5
    rmSync(currentDir, { recursive: true, force: true });
    installDaemonRuntimeCurrentLink(runtimeRoot, '0.9.5');
    expect(lstatSync(currentDir).isSymbolicLink()).toBe(true);

    // Restore rollback snapshot -> symlink cliPath AND real dir currentDir restored intact
    const restored = restoreRollbackSnapshot(snapshotDir, { isolatedRoot: root });
    expect(restored.restoredCount).toBe(2);
    expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(cliPath)).toBe(npmTarget);
    expect(readFileSync(npmTarget, 'utf8')).toBe(originalNpmBytes);
    expect(lstatSync(currentDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(currentDir).isDirectory()).toBe(true);
    expect(readFileSync(join(currentDir, 'nested', 'state.txt'), 'utf8')).toBe('old-current-dir-content');
  });
});
