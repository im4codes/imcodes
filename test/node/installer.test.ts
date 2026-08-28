import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CONTROLLED_NODE_SERVICE,
  windowsScheduledTaskArgs,
  windowsHealthWatchdogTaskArgs,
  encodeWindowsScheduledTaskXml,
  windowsScheduledTaskXml,
  windowsControlledNodeHealthPaths,
  windowsControlledNodeHealthWatchdogScript,
  windowsControlledNodeHealthWatchdogTaskXml,
  windowsCredentialDir,
  applyWindowsAclCommands,
  windowsComputerUseHelperAclCommands,
  windowsCredentialAclCommands,
  windowsExecutableFileAclCommands,
  windowsSecretFileAclCommands,
  macosLaunchDaemonPlist,
  macosHealthWatchdogLaunchDaemonPlist,
  linuxSystemdUnit,
  MACOS_PLIST_PATH,
  MACOS_WATCHDOG_PLIST_PATH,
  LINUX_UNIT_PATH,
  isProcessElevated,
  assertProcessElevated,
  windowsPowerShellExecutablePath,
  windowsSchtasksExecutablePath,
  installDefinition,
  inspectDefinition,
  inspectServiceState,
  startService,
  installControlledNodeService,
} from '../../src/node/installer.js';

const EXE = '/opt/imcodes-node/imcodes-node';
const WINDOWS_EXE = 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe';
const WINDOWS_WATCHDOG_NOW = new Date(2026, 6, 14, 11, 36, 7);
const WINDOWS_SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';

describe('controlled-node installer artifacts (4.1-4.4)', () => {
  it('detects POSIX root without attempting privilege escalation', () => {
    expect(isProcessElevated({ platform: 'linux', getUid: () => 0 })).toBe(true);
    expect(isProcessElevated({ platform: 'darwin', getUid: () => 501 })).toBe(false);
  });

  it('detects Windows Administrator membership through a testable probe', () => {
    expect(isProcessElevated({ platform: 'win32', runCommand: () => 'True\r\n' })).toBe(true);
    expect(isProcessElevated({ platform: 'win32', runCommand: () => 'False\r\n' })).toBe(false);
  });

  it('probes the absolute System32 PowerShell before the PATH-resolved name', () => {
    // A downloaded installer can be started with a PATH that lacks System32,
    // so the absolute path must be tried first rather than depended upon as a
    // fallback that only runs after a confusing failure.
    const seen: string[] = [];
    expect(isProcessElevated({
      platform: 'win32',
      runCommand: (file) => { seen.push(file); return 'True\r\n'; },
    })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  });

  it('resolves trusted Windows system executables without consulting PATH', () => {
    expect(windowsSchtasksExecutablePath({
      SystemRoot: 'D:\\TrustedWindows',
      WINDIR: 'E:\\IgnoredWindows',
    })).toBe('D:\\TrustedWindows\\System32\\schtasks.exe');
    expect(windowsSchtasksExecutablePath({
      WINDIR: 'E:\\Windows',
    })).toBe('E:\\Windows\\System32\\schtasks.exe');
    expect(windowsSchtasksExecutablePath({})).toBe(WINDOWS_SCHTASKS);
    expect(windowsPowerShellExecutablePath({
      SystemRoot: 'D:\\TrustedWindows',
      WINDIR: 'E:\\IgnoredWindows',
    })).toBe('D:\\TrustedWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('falls back to the PATH name when the absolute probe cannot run', () => {
    const seen: string[] = [];
    expect(isProcessElevated({
      platform: 'win32',
      runCommand: (file) => {
        seen.push(file);
        if (seen.length === 1) throw new Error('ENOENT');
        return 'True\r\n';
      },
    })).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe('powershell.exe');
  });

  it('refuses to report an administrator as unprivileged when PowerShell cannot run', () => {
    // Returning false here would be a lie with a specific, damaging
    // consequence: a user who DID run as administrator is told to run as
    // administrator, and has no way to discover the real fault.
    expect(() => isProcessElevated({
      platform: 'win32',
      runCommand: () => { throw new Error('denied'); },
    })).toThrow(/PowerShell could not be executed/);
  });

  it('fails with the existing Administrator/root precondition when not elevated', () => {
    expect(() => assertProcessElevated({ platform: 'linux', getUid: () => 1000 }))
      .toThrow(/Administrator\/root/);
    expect(() => assertProcessElevated({ platform: 'linux', getUid: () => 0 })).not.toThrow();
  });

  it('uses service identities DISTINCT from the full daemon (4.4)', () => {
    expect(CONTROLLED_NODE_SERVICE.WINDOWS_TASK).toBe('imcodes-node');
    expect(CONTROLLED_NODE_SERVICE.WINDOWS_TASK).not.toBe('imcodes-daemon');
    expect(CONTROLLED_NODE_SERVICE.MACOS_LABEL).toBe('cc.imcodes.node');
    expect(CONTROLLED_NODE_SERVICE.MACOS_LABEL).not.toBe('imcodes.daemon');
    expect(CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL).toBe('cc.imcodes.node.watchdog');
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).toBe('imcodes-node.service');
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).not.toBe('imcodes.service');
  });

  it('Windows uses a boot task plus an independent authenticated-health watchdog (4.1)', () => {
    const xml = windowsScheduledTaskXml('C:\\Program Files\\IM.codes\\node<&>.exe', WINDOWS_WATCHDOG_NOW);
    expect(xml).toContain('<BootTrigger>');
    expect(xml).not.toContain('<TimeTrigger>');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('<UserId>S-1-5-18</UserId>');
    expect(xml).not.toContain('<LogonType>');
    expect(xml).toContain('<RunLevel>HighestAvailable</RunLevel>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml.match(/<Interval>PT1M<\/Interval>/g)).toHaveLength(1);
    expect(xml).not.toContain('<Duration>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<Count>255</Count>');
    expect(xml).toContain('<Command>C:\\Program Files\\IM.codes\\node&lt;&amp;&gt;.exe</Command>');
    expect(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW))
      .toBe(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW));

    const healthPaths = windowsControlledNodeHealthPaths(WINDOWS_EXE);
    expect(healthPaths).toEqual({
      scriptPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node-health-watchdog.ps1',
      leasePath: 'C:\\ProgramData\\imcodes-node\\health-lease.json',
      logPath: 'C:\\ProgramData\\imcodes-node\\health-watchdog.log',
      upgradeMarkerPath: 'C:\\ProgramData\\imcodes-node\\upgrade-in-progress.json',
    });
    const watchdogXml = windowsControlledNodeHealthWatchdogTaskXml(
      healthPaths.scriptPath,
      WINDOWS_WATCHDOG_NOW,
    );
    expect(watchdogXml).toContain('<TimeTrigger>');
    expect(watchdogXml).toContain('<StartBoundary>2026-07-14T11:37:00</StartBoundary>');
    expect(watchdogXml).toContain('<Repetition><Interval>PT1M</Interval></Repetition>');
    expect(watchdogXml).not.toContain('<Duration>');
    expect(watchdogXml).toContain('<UserId>S-1-5-18</UserId>');
    expect(watchdogXml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(watchdogXml).toContain('<ExecutionTimeLimit>PT2M</ExecutionTimeLimit>');
    expect(watchdogXml).toContain('<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>');
    expect(watchdogXml).toContain('-File "C:\\ProgramData\\imcodes-node\\imcodes-node-health-watchdog.ps1"');

    const watchdogScript = windowsControlledNodeHealthWatchdogScript(WINDOWS_EXE);
    expect(watchdogScript).toContain('$lease.updatedAt');
    expect(watchdogScript).toContain('$lease.pid');
    expect(watchdogScript).toContain('[int]$lease.pid -eq [int]$process.ProcessId');
    expect(watchdogScript).toContain('$ageMs -le ($staleSeconds * 1000)');
    expect(watchdogScript).toContain('$process.CreationDate');
    expect(watchdogScript).toContain('$processAgeSeconds -lt $staleSeconds');
    expect(watchdogScript).toContain('$staleSeconds = 180');
    expect(watchdogScript).toContain("$upgradeMarkerPath = 'C:\\ProgramData\\imcodes-node\\upgrade-in-progress.json'");
    expect(watchdogScript).toContain('$upgradeMarkerMaxAgeMs = 900000');
    expect(watchdogScript).toContain('$upgradeAgeMs -le $upgradeMarkerMaxAgeMs');
    expect(watchdogScript).toContain('Remove-Item -Force -LiteralPath $upgradeMarkerPath');
    expect(watchdogScript).toContain('Start-ScheduledTask -TaskName $nodeTask');
    expect(watchdogScript).toContain("-notmatch '--computer-use-helper'");
    expect(watchdogScript).not.toContain('43.248.99.95');
    expect(watchdogScript).not.toContain('Get-NetTCPConnection');
  });

  it('installs the Windows task from a private temporary artifact with overwrite enabled', async () => {
    const artifactPaths: string[] = [];
    let mainArtifact = '';
    let watchdogArtifact = '';
    let watchdogScriptPath = '';
    let watchdogScript = '';
    await expect(installControlledNodeService(WINDOWS_EXE, {
      platform: 'win32',
      now: () => WINDOWS_WATCHDOG_NOW,
      writeWindowsWatchdogScript: async (path, content) => {
        watchdogScriptPath = path;
        watchdogScript = content;
      },
      runCommand: (file, args) => {
        expect(file).toBe(WINDOWS_SCHTASKS);
        if (args[0] === '/Create') {
          const taskName = String(args[2]);
          const expectedArgs = taskName === CONTROLLED_NODE_SERVICE.WINDOWS_TASK
            ? windowsScheduledTaskArgs(String(args[4]))
            : windowsHealthWatchdogTaskArgs(String(args[4]));
          expect(args).toEqual(expectedArgs);
          expect(args).toContain('/F');
          const artifactPath = String(args[4]);
          artifactPaths.push(artifactPath);
          const bytes = readFileSync(artifactPath);
          expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
          const artifact = bytes.subarray(2).toString('utf16le');
          if (taskName === CONTROLLED_NODE_SERVICE.WINDOWS_TASK) mainArtifact = artifact;
          else watchdogArtifact = artifact;
          return;
        }
        if (args[0] === '/Query') return '<Task />';
        expect([
          ['/Run', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK],
        ]).toContainEqual(args);
      },
    })).resolves.toBe(CONTROLLED_NODE_SERVICE.WINDOWS_TASK);

    const healthPaths = windowsControlledNodeHealthPaths(WINDOWS_EXE);
    expect(mainArtifact).toBe(windowsScheduledTaskXml(WINDOWS_EXE, WINDOWS_WATCHDOG_NOW));
    expect(watchdogArtifact).toBe(windowsControlledNodeHealthWatchdogTaskXml(
      healthPaths.scriptPath,
      WINDOWS_WATCHDOG_NOW,
    ));
    expect(watchdogScriptPath).toBe(healthPaths.scriptPath);
    expect(watchdogScript).toBe(windowsControlledNodeHealthWatchdogScript(WINDOWS_EXE));
    expect(encodeWindowsScheduledTaskXml(windowsScheduledTaskXml(WINDOWS_EXE, WINDOWS_WATCHDOG_NOW)).subarray(0, 2))
      .toEqual(Buffer.from([0xff, 0xfe]));
    expect(artifactPaths).toHaveLength(2);
    expect(artifactPaths.every((path) => !existsSync(path))).toBe(true);
  });

  it('Windows credential dir is ProgramData-scoped (SYSTEM service), honoring %ProgramData% (10.10)', () => {
    expect(windowsCredentialDir({ ProgramData: 'D:\\PD' })).toBe('D:\\PD\\imcodes-node');
    expect(windowsCredentialDir({})).toBe('C:\\ProgramData\\imcodes-node');
    // Not a per-user path.
    expect(windowsCredentialDir({ ProgramData: 'C:\\ProgramData' })).not.toMatch(/Users/i);
  });

  it('Windows credential ACL grants only SYSTEM + Administrators and strips inheritance (10.10)', () => {
    const dir = 'C:\\ProgramData\\imcodes-node';
    const commands = windowsCredentialAclCommands(dir);
    expect(commands).toEqual([
      [dir, '/grant:r', '*S-1-5-18:(OI)(CI)F'],
      [dir, '/grant:r', '*S-1-5-32-544:(OI)(CI)F'],
      [dir, '/inheritance:r'],
      [dir, '/setowner', '*S-1-5-18'],
    ]);
    // `icacls /setowner` is an exclusive command form on Windows. Combining it
    // with grants/inheritance caused first-run installation to stop at elevated.
    expect(commands.find((args) => args.includes('/setowner'))).toHaveLength(3);
    // No broad principals (Users/Everyone/Authenticated Users) are granted.
    const joined = commands.flat().join(' ');
    expect(joined).not.toMatch(/\bUsers:/);
    expect(joined).not.toMatch(/Everyone/i);
    expect(joined).not.toMatch(/Authenticated Users/i);
    const exeCommands = windowsExecutableFileAclCommands(`${dir}\\imcodes-node.exe`);
    expect(exeCommands).toEqual([
      [`${dir}\\imcodes-node.exe`, '/grant:r', '*S-1-5-18:F'],
      [`${dir}\\imcodes-node.exe`, '/grant:r', '*S-1-5-32-544:F'],
      [`${dir}\\imcodes-node.exe`, '/grant:r', '*S-1-5-11:RX'],
      [`${dir}\\imcodes-node.exe`, '/inheritance:r'],
      [`${dir}\\imcodes-node.exe`, '/setowner', '*S-1-5-18'],
    ]);
    expect(windowsComputerUseHelperAclCommands(`${dir}\\computer-use-helper`)).toEqual([
      [`${dir}\\computer-use-helper`, '/grant:r', '*S-1-5-18:(OI)(CI)F'],
      [`${dir}\\computer-use-helper`, '/grant:r', '*S-1-5-32-544:(OI)(CI)F'],
      [`${dir}\\computer-use-helper`, '/grant:r', '*S-1-5-11:(OI)(CI)RX'],
      [`${dir}\\computer-use-helper`, '/inheritance:r'],
      [`${dir}\\computer-use-helper`, '/setowner', '*S-1-5-18', '/T'],
    ]);

    const fileCommands = windowsSecretFileAclCommands(`${dir}\\credential.json`);
    expect(fileCommands).toEqual([
      [`${dir}\\credential.json`, '/grant:r', '*S-1-5-18:F'],
      [`${dir}\\credential.json`, '/grant:r', '*S-1-5-32-544:F'],
      [`${dir}\\credential.json`, '/inheritance:r'],
      [`${dir}\\credential.json`, '/setowner', '*S-1-5-18'],
    ]);
    expect(fileCommands.flat().join(' ')).not.toMatch(/\bUsers:/);
  });

  it('runs each Windows ACL operation as its own icacls process', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const commands = windowsCredentialAclCommands('C:\\ProgramData\\imcodes-node');
    applyWindowsAclCommands(commands, (file, args) => calls.push({ file, args }));

    expect(calls).toEqual(commands.map((args) => ({ file: 'icacls', args })));
    expect(calls).toHaveLength(4);
  });

  it('macOS artifacts provide boot persistence plus a periodic authenticated-health watchdog (4.2)', () => {
    expect(MACOS_PLIST_PATH).toContain('/Library/LaunchDaemons/');
    expect(MACOS_PLIST_PATH).not.toContain('LaunchAgents');
    expect(MACOS_WATCHDOG_PLIST_PATH).toContain('/Library/LaunchDaemons/');
    const plist = macosLaunchDaemonPlist(EXE);
    expect(plist).toContain('<string>cc.imcodes.node</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain(EXE);
    expect(macosLaunchDaemonPlist('/tmp/node<&>.bin')).toContain('/tmp/node&lt;&amp;&gt;.bin');
    const watchdog = macosHealthWatchdogLaunchDaemonPlist(EXE);
    expect(watchdog).toContain('<string>cc.imcodes.node.watchdog</string>');
    expect(watchdog).toContain('<string>--health-watchdog</string>');
    expect(watchdog).toContain('<key>StartInterval</key><integer>60</integer>');
    expect(watchdog).not.toContain('<key>KeepAlive</key>');
  });

  it('macOS start reloads the current durable plist instead of trusting a loaded label', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-installer-test-'));
    const plistPath = join(dir, 'Library', 'LaunchDaemons', 'cc.imcodes.node.plist');
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runCommand = (file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] });
    };

    try {
      await installControlledNodeService(EXE, { platform: 'darwin', macosPlistPath: plistPath, runCommand });
      await installControlledNodeService(EXE, { platform: 'darwin', macosPlistPath: plistPath, runCommand });

      expect(calls.filter(({ args }) => args[0] === 'bootout' && args[1] === 'system/cc.imcodes.node')).toEqual([
        { file: 'launchctl', args: ['bootout', 'system/cc.imcodes.node'] },
        { file: 'launchctl', args: ['bootout', 'system/cc.imcodes.node'] },
      ]);
      expect(calls.filter(({ args }) => args[0] === 'bootstrap' && args[2] === plistPath)).toEqual([
        { file: 'launchctl', args: ['bootstrap', 'system', plistPath] },
        { file: 'launchctl', args: ['bootstrap', 'system', plistPath] },
      ]);
      expect(calls.filter(({ args }) => args[0] === 'bootstrap' && String(args[2]).includes('watchdog'))).toHaveLength(2);
      expect(calls.filter(({ args }) => args[0] === 'kickstart')).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not hide a launchctl bootstrap failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-installer-test-'));
    const plistPath = join(dir, 'cc.imcodes.node.plist');
    try {
      await expect(installControlledNodeService(EXE, {
        platform: 'darwin',
        macosPlistPath: plistPath,
        runCommand: (_file, args) => {
          if (args[0] === 'bootout') return;
          throw new Error('bootstrap permission denied');
        },
      })).rejects.toThrow('bootstrap permission denied');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Linux artifact is a systemd SYSTEM unit (not --user), restart-on-failure (4.3)', () => {
    expect(LINUX_UNIT_PATH).toBe('/etc/systemd/system/imcodes-node.service');
    expect(LINUX_UNIT_PATH).not.toContain('/user/');
    const unit = linuxSystemdUnit(EXE);
    expect(unit).toContain('WantedBy=multi-user.target'); // system, not user
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('NotifyAccess=all');
    expect(unit).toContain('WatchdogSec=180');
    expect(unit).toContain(`ExecStart=${EXE}`);
  });

  it('Linux definition install is durable and start is a separate operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-installer-test-'));
    const unitPath = join(dir, 'imcodes-node.service');
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    try {
      const receipt = await installDefinition(EXE, {
        platform: 'linux',
        linuxUnitPath: unitPath,
        runCommand: (file, args) => { calls.push({ file, args: [...args] }); },
      });
      expect(receipt).toMatchObject({
        name: CONTROLLED_NODE_SERVICE.LINUX_UNIT,
        platform: 'linux',
        definitionPath: unitPath,
        action: EXE,
      });
      expect(readFileSync(unitPath, 'utf8')).toBe(linuxSystemdUnit(EXE));
      expect(calls).toEqual([
        { file: 'systemctl', args: ['daemon-reload'] },
        { file: 'systemctl', args: ['enable', CONTROLLED_NODE_SERVICE.LINUX_UNIT] },
      ]);

      await inspectDefinition(receipt, { platform: 'linux' });
      await startService(receipt, {
        platform: 'linux',
        runCommand: (file, args) => { calls.push({ file, args: [...args] }); },
      });
      expect(calls.at(-1)).toEqual({ file: 'systemctl', args: ['restart', CONTROLLED_NODE_SERVICE.LINUX_UNIT] });
      expect(calls.flatMap(({ args }) => args)).not.toContain('--now');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('durable definition install ignores stale pid temp files from a crashed retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-installer-test-'));
    const unitPath = join(dir, 'imcodes-node.service');
    try {
      await writeFile(`${unitPath}.${process.pid}.tmp`, 'stale temp');
      await expect(installDefinition(EXE, {
        platform: 'linux',
        linuxUnitPath: unitPath,
        runCommand: () => {},
      })).resolves.toMatchObject({ definitionPath: unitPath });
      expect(readFileSync(unitPath, 'utf8')).toBe(linuxSystemdUnit(EXE));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Windows definition inspection is side-effect-free', async () => {
    const calls: string[][] = [];
    const receipt = await inspectDefinition({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action: 'C:\\Program Files\\IM.codes\\node.exe',
    }, {
      platform: 'win32',
      runCommand: (_file, args) => { calls.push([...args]); return '<Task />'; },
    });
    expect(receipt.action).toBe('C:\\Program Files\\IM.codes\\node.exe');
    expect(calls).toEqual([
      ['/Query', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK],
      ['/Query', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK],
    ]);
    expect(calls.flat()).not.toContain('/Create');
    expect(calls.flat()).not.toContain('/Run');
  });

  it('structured Windows inspection validates boot/SYSTEM/action and reads state without mutation', async () => {
    const action = 'C:\\Program Files\\IM.codes\\node.exe';
    const xml = windowsScheduledTaskXml(action);
    const watchdogXml = windowsControlledNodeHealthWatchdogTaskXml(
      windowsControlledNodeHealthPaths(action).scriptPath,
    );
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
      definitionSha256: 'install-hash-is-semantic-on-windows',
    }, {
      platform: 'win32',
      readWindowsWatchdogScript: async () => windowsControlledNodeHealthWatchdogScript(action),
      runCommand: (file, args) => {
        calls.push({ file, args: [...args] });
        if (file !== WINDOWS_SCHTASKS) return 'Running';
        return args.includes(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK) ? watchdogXml : xml;
      },
    });
    expect(inspection).toMatchObject({
      installed: true,
      action,
      // schtasks' /XML query IS the manager's live registration, so the
      // effective action equals the registered Command.
      effectiveAction: action,
      loadedActionMatches: true,
      loaded: true,
      bootEnabled: true,
      principal: 'S-1-5-18',
      restartPolicy: 'on-failure',
      definitionMatches: true,
      runState: 'running',
      errors: [],
    });
    expect(calls.map(({ file }) => file)).toEqual([WINDOWS_SCHTASKS, WINDOWS_SCHTASKS, 'powershell.exe']);
    expect(calls.flatMap(({ args }) => args)).not.toContain('/Create');
    expect(calls.flatMap(({ args }) => args)).not.toContain('/Run');
  });

  it('accepts Task Scheduler normalized defaults and reordered restart fields', async () => {
    const action = 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe';
    const normalized = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Count>255</Count><Interval>PT1M</Interval></RestartOnFailure></Settings>
  <Triggers><BootTrigger /></Triggers>
  <Actions Context="System"><Exec><Command>${action}</Command></Exec></Actions>
</Task>`;
    const normalizedWatchdog = windowsControlledNodeHealthWatchdogTaskXml(
      windowsControlledNodeHealthPaths(action).scriptPath,
      WINDOWS_WATCHDOG_NOW,
    );
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
    }, {
      platform: 'win32',
      readWindowsWatchdogScript: async () => windowsControlledNodeHealthWatchdogScript(action),
      runCommand: (file, args) => {
        if (file !== WINDOWS_SCHTASKS) return 'Running';
        return args.includes(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK)
          ? normalizedWatchdog
          : normalized;
      },
    });

    expect(inspection).toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: true,
      runState: 'running',
    });
  });

  it('rejects a missing or finite health watchdog and the legacy process-only minute trigger', async () => {
    const action = 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe';
    const mainXml = windowsScheduledTaskXml(action, WINDOWS_WATCHDOG_NOW);
    const healthPaths = windowsControlledNodeHealthPaths(action);
    const validWatchdogXml = windowsControlledNodeHealthWatchdogTaskXml(
      healthPaths.scriptPath,
      WINDOWS_WATCHDOG_NOW,
    );
    const finiteWatchdogXml = validWatchdogXml
      .replace('</Repetition>', '<Duration>PT1H</Duration></Repetition>');
    const legacyHotfixXml = windowsControlledNodeHealthWatchdogTaskXml(
      'C:\\ProgramData\\imcodes-node\\imcodes-node-watchdog.ps1',
      WINDOWS_WATCHDOG_NOW,
    );
    const legacyProcessOnlyXml = mainXml.replace(
      '</Triggers>',
      '<TimeTrigger><StartBoundary>2026-07-14T11:37:00</StartBoundary><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger></Triggers>',
    );
    const inspect = (
      mainTaskXml: string,
      watchdogTaskXml?: string,
      watchdogScript = windowsControlledNodeHealthWatchdogScript(action),
    ) => inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
    }, {
      platform: 'win32',
      readWindowsWatchdogScript: async () => watchdogScript,
      runCommand: (file, args) => {
        if (file !== WINDOWS_SCHTASKS) return 'Running';
        if (args.includes(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK)) {
          if (watchdogTaskXml === undefined) throw new Error('watchdog missing');
          return watchdogTaskXml;
        }
        return mainTaskXml;
      },
    });

    await expect(inspect(mainXml)).resolves.toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: false,
      errors: ['watchdog_task_query_failed:watchdog missing'],
    });
    await expect(inspect(mainXml, finiteWatchdogXml)).resolves.toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: false,
    });
    await expect(inspect(mainXml, legacyHotfixXml)).resolves.toMatchObject({
      definitionMatches: false,
    });
    await expect(inspect(legacyProcessOnlyXml, validWatchdogXml)).resolves.toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: false,
    });
    await expect(inspect(mainXml, validWatchdogXml)).resolves.toMatchObject({
      definitionMatches: true,
    });
    await expect(inspect(mainXml, validWatchdogXml, '# stale watchdog')).resolves.toMatchObject({
      definitionMatches: false,
      errors: ['watchdog_script_mismatch'],
    });
  });

  it('Windows flags a registered task whose Command no longer matches the receipt action', async () => {
    const OLD = 'C:\\Program Files\\IM.codes\\node.old.exe';
    const receiptAction = 'C:\\Program Files\\IM.codes\\node.exe';
    // The registered task still runs the OLD exe (never re-created after drift).
    const staleXml = windowsScheduledTaskXml(OLD);
    const watchdogXml = windowsControlledNodeHealthWatchdogTaskXml(
      windowsControlledNodeHealthPaths(receiptAction).scriptPath,
    );
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK, platform: 'win32', action: receiptAction,
      definitionSha256: 'semantic-on-windows',
    }, {
      platform: 'win32',
      readWindowsWatchdogScript: async () => windowsControlledNodeHealthWatchdogScript(receiptAction),
      runCommand: (file, args) => {
        if (file !== WINDOWS_SCHTASKS) return 'Running';
        return args.includes(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK) ? watchdogXml : staleXml;
      },
    });
    expect(inspection.installed).toBe(true);
    expect(inspection.effectiveAction).toBe(OLD);
    expect(inspection.loadedActionMatches).toBe(false);
    expect(inspection.definitionMatches).toBe(false);
    // Still a boot-scoped SYSTEM task — only the action drifted.
    expect(inspection.bootEnabled).toBe(true);
    expect(inspection.principal).toBe('S-1-5-18');
  });

  it('structured macOS/Linux inspection reads the manager-loaded action + posture and never starts itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-inspect-'));
    try {
      const plistPath = join(dir, 'cc.imcodes.node.plist');
      const watchdogPath = join(dir, 'cc.imcodes.node.watchdog.plist');
      const unitPath = join(dir, 'imcodes-node.service');
      await writeFile(plistPath, macosLaunchDaemonPlist(EXE));
      await writeFile(watchdogPath, macosHealthWatchdogLaunchDaemonPlist(EXE));
      await writeFile(unitPath, linuxSystemdUnit(EXE));
      const commands: Array<{ file: string; args: readonly string[] }> = [];
      const mac = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.MACOS_LABEL, platform: 'darwin', definitionPath: plistPath,
        definitionSha256: createHash('sha256').update(macosLaunchDaemonPlist(EXE)).digest('hex'),
        watchdogDefinitionPath: watchdogPath,
        watchdogDefinitionSha256: createHash('sha256').update(macosHealthWatchdogLaunchDaemonPlist(EXE)).digest('hex'),
        action: EXE,
      }, {
        platform: 'darwin',
        runCommand: (file, args) => {
          commands.push({ file, args: [...args] });
          const watchdog = args.includes(`system/${CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL}`);
          return [
            `system/${watchdog ? CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL : CONTROLLED_NODE_SERVICE.MACOS_LABEL} = {`,
            `\tpath = ${watchdog ? watchdogPath : plistPath}`,
            '\tstate = running',
            `\tprogram = ${EXE}`,
            '\targuments = {',
            `\t\t${EXE}`,
            ...(watchdog ? ['\t\t--health-watchdog'] : []),
            '\t}',
            '\tusername = root',
            ...(!watchdog ? ['\tkeepalive = {', '\t}'] : []),
            '}',
          ].join('\n');
        },
      });
      const linuxShow = [
        'ActiveState=active',
        'SubState=running',
        'LoadState=loaded',
        `FragmentPath=${unitPath}`,
        `ExecStart={ path=${EXE} ; argv[]=${EXE} ; ignore_errors=no ; pid=4321 ; status=0/0 }`,
        'User=',
        'Restart=on-failure',
        'UnitFileState=enabled',
        'WatchdogUSec=3min',
        'NotifyAccess=all',
      ].join('\n');
      const linux = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.LINUX_UNIT, platform: 'linux', definitionPath: unitPath,
        definitionSha256: createHash('sha256').update(linuxSystemdUnit(EXE)).digest('hex'), action: EXE,
      }, {
        platform: 'linux',
        runCommand: (file, args) => {
          commands.push({ file, args: [...args] });
          return args[0] === 'is-enabled' ? 'enabled' : linuxShow;
        },
      });
      expect(mac).toMatchObject({
        installed: true, definitionMatches: true, runState: 'running',
        effectiveAction: EXE, loadedActionMatches: true, loaded: true,
        bootEnabled: true, principal: 'root', restartPolicy: 'keepalive',
      });
      expect(linux).toMatchObject({
        installed: true, definitionMatches: true, runState: 'running',
        effectiveAction: EXE, loadedActionMatches: true, loaded: true,
        bootEnabled: true, principal: 'root', restartPolicy: 'on-failure',
      });
      // The Linux read MUST ask systemd for the loaded ExecStart + FragmentPath.
      const showCall = commands.find(({ file, args }) => file === 'systemctl' && args[0] === 'show');
      expect(showCall?.args.join(' ')).toContain('ExecStart');
      expect(showCall?.args.join(' ')).toContain('FragmentPath');
      expect(showCall?.args.join(' ')).toContain('WatchdogUSec');
      const allArgs = commands.flatMap(({ args }) => args);
      for (const forbidden of ['bootout', 'bootstrap', 'kickstart', 'restart', 'daemon-reload', '/Run', '/Create']) {
        expect(allArgs).not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects legacy macOS/Linux persistence that only supervises process existence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-inspect-'));
    try {
      const plistPath = join(dir, 'cc.imcodes.node.plist');
      const unitPath = join(dir, 'imcodes-node.service');
      await writeFile(plistPath, macosLaunchDaemonPlist(EXE));
      await writeFile(unitPath, linuxSystemdUnit(EXE));
      const mac = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.MACOS_LABEL,
        platform: 'darwin',
        definitionPath: plistPath,
        definitionSha256: createHash('sha256').update(macosLaunchDaemonPlist(EXE)).digest('hex'),
        action: EXE,
      }, {
        platform: 'darwin',
        runCommand: (_file, args) => {
          if (args.includes(`system/${CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL}`)) {
            throw new Error('legacy install has no watchdog');
          }
          return `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL} = {\npath = ${plistPath}\nstate = running\nprogram = ${EXE}\nusername = root\nkeepalive = {\n}\n}`;
        },
      });
      expect(mac.definitionMatches).toBe(false);
      expect(mac.errors.join(' ')).toContain('watchdog_');

      const linux = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.LINUX_UNIT,
        platform: 'linux',
        definitionPath: unitPath,
        definitionSha256: createHash('sha256').update(linuxSystemdUnit(EXE)).digest('hex'),
        action: EXE,
      }, {
        platform: 'linux',
        runCommand: (_file, args) => (args[0] === 'is-enabled' ? 'enabled'
          : `ActiveState=active\nLoadState=loaded\nFragmentPath=${unitPath}\nExecStart={ path=${EXE} ; argv[]=${EXE} }\nUser=\nRestart=on-failure\nUnitFileState=enabled\nWatchdogUSec=0\nNotifyAccess=none`),
      });
      expect(linux.definitionMatches).toBe(false);
      expect(linux.loadedActionMatches).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('macOS flags a stale loaded action: the on-disk plist matches the receipt but launchd still runs the old exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-inspect-'));
    try {
      const plistPath = join(dir, 'cc.imcodes.node.plist');
      const watchdogPath = join(dir, 'cc.imcodes.node.watchdog.plist');
      // The durable plist already points at the NEW exe (matches the receipt)…
      await writeFile(plistPath, macosLaunchDaemonPlist(EXE));
      await writeFile(watchdogPath, macosHealthWatchdogLaunchDaemonPlist(EXE));
      const OLD = '/opt/imcodes-node/imcodes-node.old';
      const inspection = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.MACOS_LABEL, platform: 'darwin', definitionPath: plistPath,
        definitionSha256: createHash('sha256').update(macosLaunchDaemonPlist(EXE)).digest('hex'),
        watchdogDefinitionPath: watchdogPath,
        watchdogDefinitionSha256: createHash('sha256').update(macosHealthWatchdogLaunchDaemonPlist(EXE)).digest('hex'),
        action: EXE,
      }, {
        platform: 'darwin',
        // …but launchd was never rebootstrapped, so it still has the OLD exe loaded.
        runCommand: (_file, args) => {
          const watchdog = args.includes(`system/${CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL}`);
          return [
          `system/${watchdog ? CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL : CONTROLLED_NODE_SERVICE.MACOS_LABEL} = {`,
          `\tpath = ${watchdog ? watchdogPath : plistPath}`,
          '\tstate = running',
          `\tprogram = ${watchdog ? EXE : OLD}`,
          ...(watchdog ? ['\targuments = {', `\t\t${EXE}`, '\t\t--health-watchdog', '\t}'] : []),
          '\tusername = root',
          '}',
          ].join('\n');
        },
      });
      expect(inspection.definitionMatches).toBe(true); // disk is already correct
      expect(inspection.action).toBe(EXE); // on-disk action
      expect(inspection.effectiveAction).toBe(OLD); // manager still lags
      expect(inspection.loadedActionMatches).toBe(false); // → not healthy
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Linux flags drift when the loaded ExecStart or FragmentPath diverges from the receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-inspect-'));
    try {
      const unitPath = join(dir, 'imcodes-node.service');
      await writeFile(unitPath, linuxSystemdUnit(EXE)); // disk already matches the receipt
      const OLD = '/opt/imcodes-node/imcodes-node.old';
      const receipt = {
        name: CONTROLLED_NODE_SERVICE.LINUX_UNIT, platform: 'linux' as const, definitionPath: unitPath,
        definitionSha256: createHash('sha256').update(linuxSystemdUnit(EXE)).digest('hex'), action: EXE,
      };
      // Case 1: FragmentPath matches, but the resident ExecStart is the OLD exe
      // (no daemon-reload since the file was rewritten).
      const staleExec = await inspectServiceState(receipt, {
        platform: 'linux',
        runCommand: (_file, args) => (args[0] === 'is-enabled' ? 'enabled'
          : `ActiveState=active\nLoadState=loaded\nFragmentPath=${unitPath}\nExecStart={ path=${OLD} ; argv[]=${OLD} }\nUser=\nRestart=on-failure\nUnitFileState=enabled\nWatchdogUSec=3min\nNotifyAccess=all`),
      });
      expect(staleExec.definitionMatches).toBe(true);
      expect(staleExec.effectiveAction).toBe(OLD);
      expect(staleExec.loadedActionMatches).toBe(false);
      // Case 2: systemd loaded a DIFFERENT unit file entirely (stale FragmentPath).
      const staleFragment = await inspectServiceState(receipt, {
        platform: 'linux',
        runCommand: (_file, args) => (args[0] === 'is-enabled' ? 'enabled'
          : `ActiveState=active\nLoadState=loaded\nFragmentPath=/etc/systemd/system/other.service\nExecStart={ path=${EXE} ; argv[]=${EXE} }\nUser=imcodes\nRestart=on-failure\nUnitFileState=enabled\nWatchdogUSec=3min\nNotifyAccess=all`),
      });
      expect(staleFragment.loaded).toBe(false);
      expect(staleFragment.loadedActionMatches).toBe(false);
      expect(staleFragment.principal).toBe('imcodes'); // parses an explicit User=
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
