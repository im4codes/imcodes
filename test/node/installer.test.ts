import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CONTROLLED_NODE_SERVICE,
  windowsScheduledTaskArgs,
  encodeWindowsScheduledTaskXml,
  windowsScheduledTaskXml,
  windowsCredentialDir,
  applyWindowsAclCommands,
  windowsCredentialAclCommands,
  windowsExecutableFileAclCommands,
  windowsSecretFileAclCommands,
  macosLaunchDaemonPlist,
  linuxSystemdUnit,
  MACOS_PLIST_PATH,
  LINUX_UNIT_PATH,
  isProcessElevated,
  assertProcessElevated,
  installDefinition,
  inspectDefinition,
  inspectServiceState,
  startService,
  installControlledNodeService,
} from '../../src/node/installer.js';

const EXE = '/opt/imcodes-node/imcodes-node';
const WINDOWS_WATCHDOG_NOW = new Date(2026, 6, 14, 11, 36, 7);

describe('controlled-node installer artifacts (4.1-4.4)', () => {
  it('detects POSIX root without attempting privilege escalation', () => {
    expect(isProcessElevated({ platform: 'linux', getUid: () => 0 })).toBe(true);
    expect(isProcessElevated({ platform: 'darwin', getUid: () => 501 })).toBe(false);
  });

  it('detects Windows Administrator membership through a testable probe', () => {
    expect(isProcessElevated({ platform: 'win32', runCommand: () => 'True\r\n' })).toBe(true);
    expect(isProcessElevated({ platform: 'win32', runCommand: () => 'False\r\n' })).toBe(false);
    expect(isProcessElevated({ platform: 'win32', runCommand: () => { throw new Error('denied'); } })).toBe(false);
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
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).toBe('imcodes-node.service');
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).not.toBe('imcodes.service');
  });

  it('Windows task is boot-scoped SYSTEM and restarts after failure (4.1)', () => {
    const xml = windowsScheduledTaskXml('C:\\Program Files\\IM.codes\\node<&>.exe', WINDOWS_WATCHDOG_NOW);
    expect(xml).toContain('<BootTrigger>');
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<StartBoundary>2026-07-14T11:37:00</StartBoundary>');
    expect(xml).toContain('<Repetition>');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('<UserId>S-1-5-18</UserId>');
    expect(xml).not.toContain('<LogonType>');
    expect(xml).toContain('<RunLevel>HighestAvailable</RunLevel>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml.match(/<Interval>PT1M<\/Interval>/g)).toHaveLength(2);
    expect(xml).not.toContain('<Duration>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<Count>255</Count>');
    expect(xml).toContain('<Command>C:\\Program Files\\IM.codes\\node&lt;&amp;&gt;.exe</Command>');
    expect(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW))
      .toBe(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW));
  });

  it('installs the Windows task from a private temporary artifact with overwrite enabled', async () => {
    let artifactPath = '';
    let artifact = '';
    await expect(installControlledNodeService(EXE, {
      platform: 'win32',
      now: () => WINDOWS_WATCHDOG_NOW,
      runCommand: (file, args) => {
        expect(file).toBe('schtasks');
        if (args[0] === '/Create') {
          expect(args).toEqual(windowsScheduledTaskArgs(String(args[4])));
          expect(args).toContain('/F');
          artifactPath = String(args[4]);
          const bytes = readFileSync(artifactPath);
          expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
          artifact = bytes.subarray(2).toString('utf16le');
          return;
        }
        if (args[0] === '/Query') return '<Task />';
        expect([
          ['/Run', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK],
        ]).toContainEqual(args);
      },
    })).resolves.toBe(CONTROLLED_NODE_SERVICE.WINDOWS_TASK);

    expect(artifact).toBe(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW));
    expect(encodeWindowsScheduledTaskXml(windowsScheduledTaskXml(EXE, WINDOWS_WATCHDOG_NOW)).subarray(0, 2))
      .toEqual(Buffer.from([0xff, 0xfe]));
    expect(existsSync(artifactPath)).toBe(false);
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

  it('macOS artifact is a LaunchDaemon (root, boot), not a LaunchAgent (4.2)', () => {
    expect(MACOS_PLIST_PATH).toContain('/Library/LaunchDaemons/');
    expect(MACOS_PLIST_PATH).not.toContain('LaunchAgents');
    const plist = macosLaunchDaemonPlist(EXE);
    expect(plist).toContain('<string>cc.imcodes.node</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain(EXE);
    expect(macosLaunchDaemonPlist('/tmp/node<&>.bin')).toContain('/tmp/node&lt;&amp;&gt;.bin');
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

      expect(calls.filter(({ args }) => args[0] === 'bootout')).toEqual([
        { file: 'launchctl', args: ['bootout', 'system/cc.imcodes.node'] },
        { file: 'launchctl', args: ['bootout', 'system/cc.imcodes.node'] },
      ]);
      expect(calls.filter(({ args }) => args[0] === 'bootstrap')).toEqual([
        { file: 'launchctl', args: ['bootstrap', 'system', plistPath] },
        { file: 'launchctl', args: ['bootstrap', 'system', plistPath] },
      ]);
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
    expect(calls).toEqual([['/Query', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_TASK]]);
    expect(calls.flat()).not.toContain('/Create');
    expect(calls.flat()).not.toContain('/Run');
  });

  it('structured Windows inspection validates boot/SYSTEM/action and reads state without mutation', async () => {
    const action = 'C:\\Program Files\\IM.codes\\node.exe';
    const xml = windowsScheduledTaskXml(action);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
      definitionSha256: 'install-hash-is-semantic-on-windows',
    }, {
      platform: 'win32',
      runCommand: (file, args) => {
        calls.push({ file, args: [...args] });
        return file === 'schtasks' ? xml : 'Running';
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
    expect(calls.map(({ file }) => file)).toEqual(['schtasks', 'powershell.exe']);
    expect(calls.flatMap(({ args }) => args)).not.toContain('/Create');
    expect(calls.flatMap(({ args }) => args)).not.toContain('/Run');
  });

  it('accepts Task Scheduler normalized defaults and reordered restart fields', async () => {
    const action = 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe';
    const normalized = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Count>255</Count><Interval>PT1M</Interval></RestartOnFailure></Settings>
  <Triggers><BootTrigger /><TimeTrigger><StartBoundary>2026-07-14T11:37:00</StartBoundary><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger></Triggers>
  <Actions Context="System"><Exec><Command>${action}</Command></Exec></Actions>
</Task>`;
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
    }, {
      platform: 'win32',
      runCommand: (file) => (file === 'schtasks' ? normalized : 'Running'),
    });

    expect(inspection).toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: true,
      runState: 'running',
    });
  });

  it('rejects a legacy Windows task without an indefinite force-kill watchdog', async () => {
    const action = 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe';
    const legacyXml = windowsScheduledTaskXml(action, WINDOWS_WATCHDOG_NOW)
      .replace(/\s*<TimeTrigger>[\s\S]*?<\/TimeTrigger>/, '');
    const finiteWatchdogXml = windowsScheduledTaskXml(action, WINDOWS_WATCHDOG_NOW)
      .replace('</Repetition>', '<Duration>PT1H</Duration></Repetition>');
    const inspect = (xml: string) => inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK,
      platform: 'win32',
      action,
    }, {
      platform: 'win32',
      runCommand: (file) => (file === 'schtasks' ? xml : 'Running'),
    });

    await expect(inspect(legacyXml)).resolves.toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: false,
    });
    await expect(inspect(finiteWatchdogXml)).resolves.toMatchObject({
      bootEnabled: true,
      restartPolicy: 'on-failure',
      definitionMatches: false,
    });
  });

  it('Windows flags a registered task whose Command no longer matches the receipt action', async () => {
    const OLD = 'C:\\Program Files\\IM.codes\\node.old.exe';
    const receiptAction = 'C:\\Program Files\\IM.codes\\node.exe';
    // The registered task still runs the OLD exe (never re-created after drift).
    const staleXml = windowsScheduledTaskXml(OLD);
    const inspection = await inspectServiceState({
      name: CONTROLLED_NODE_SERVICE.WINDOWS_TASK, platform: 'win32', action: receiptAction,
      definitionSha256: 'semantic-on-windows',
    }, {
      platform: 'win32',
      runCommand: (file) => (file === 'schtasks' ? staleXml : 'Running'),
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
      const unitPath = join(dir, 'imcodes-node.service');
      await writeFile(plistPath, macosLaunchDaemonPlist(EXE));
      await writeFile(unitPath, linuxSystemdUnit(EXE));
      const commands: Array<{ file: string; args: readonly string[] }> = [];
      const mac = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.MACOS_LABEL, platform: 'darwin', definitionPath: plistPath,
        definitionSha256: createHash('sha256').update(macosLaunchDaemonPlist(EXE)).digest('hex'), action: EXE,
      }, {
        platform: 'darwin',
        runCommand: (file, args) => {
          commands.push({ file, args: [...args] });
          return [
            `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL} = {`,
            `\tpath = ${plistPath}`,
            '\tstate = running',
            `\tprogram = ${EXE}`,
            '\targuments = {',
            `\t\t${EXE}`,
            '\t}',
            '\tusername = root',
            '\tkeepalive = {',
            '\t}',
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
      const allArgs = commands.flatMap(({ args }) => args);
      for (const forbidden of ['bootout', 'bootstrap', 'kickstart', 'restart', 'daemon-reload', '/Run', '/Create']) {
        expect(allArgs).not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('macOS flags a stale loaded action: the on-disk plist matches the receipt but launchd still runs the old exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-inspect-'));
    try {
      const plistPath = join(dir, 'cc.imcodes.node.plist');
      // The durable plist already points at the NEW exe (matches the receipt)…
      await writeFile(plistPath, macosLaunchDaemonPlist(EXE));
      const OLD = '/opt/imcodes-node/imcodes-node.old';
      const inspection = await inspectServiceState({
        name: CONTROLLED_NODE_SERVICE.MACOS_LABEL, platform: 'darwin', definitionPath: plistPath,
        definitionSha256: createHash('sha256').update(macosLaunchDaemonPlist(EXE)).digest('hex'), action: EXE,
      }, {
        platform: 'darwin',
        // …but launchd was never rebootstrapped, so it still has the OLD exe loaded.
        runCommand: () => [
          `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL} = {`,
          '\tstate = running',
          `\tprogram = ${OLD}`,
          '\tusername = root',
          '}',
        ].join('\n'),
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
          : `ActiveState=active\nLoadState=loaded\nFragmentPath=${unitPath}\nExecStart={ path=${OLD} ; argv[]=${OLD} }\nUser=\nRestart=on-failure\nUnitFileState=enabled`),
      });
      expect(staleExec.definitionMatches).toBe(true);
      expect(staleExec.effectiveAction).toBe(OLD);
      expect(staleExec.loadedActionMatches).toBe(false);
      // Case 2: systemd loaded a DIFFERENT unit file entirely (stale FragmentPath).
      const staleFragment = await inspectServiceState(receipt, {
        platform: 'linux',
        runCommand: (_file, args) => (args[0] === 'is-enabled' ? 'enabled'
          : `ActiveState=active\nLoadState=loaded\nFragmentPath=/etc/systemd/system/other.service\nExecStart={ path=${EXE} ; argv[]=${EXE} }\nUser=imcodes\nRestart=on-failure\nUnitFileState=enabled`),
      });
      expect(staleFragment.loaded).toBe(false);
      expect(staleFragment.loadedActionMatches).toBe(false);
      expect(staleFragment.principal).toBe('imcodes'); // parses an explicit User=
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
