import { describe, it, expect } from 'vitest';
import {
  CONTROLLED_NODE_SERVICE,
  windowsScheduledTaskArgs,
  windowsCredentialDir,
  windowsCredentialAclArgs,
  macosLaunchDaemonPlist,
  linuxSystemdUnit,
  MACOS_PLIST_PATH,
  LINUX_UNIT_PATH,
} from '../../src/node/installer.js';

const EXE = '/opt/imcodes-node/imcodes-node';

describe('controlled-node installer artifacts (4.1-4.4)', () => {
  it('uses service identities DISTINCT from the full daemon (4.4)', () => {
    expect(CONTROLLED_NODE_SERVICE.WINDOWS_TASK).toBe('imcodes-node');
    expect(CONTROLLED_NODE_SERVICE.WINDOWS_TASK).not.toBe('imcodes-daemon');
    expect(CONTROLLED_NODE_SERVICE.MACOS_LABEL).toBe('cc.imcodes.node');
    expect(CONTROLLED_NODE_SERVICE.MACOS_LABEL).not.toBe('imcodes.daemon');
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).toBe('imcodes-node.service');
    expect(CONTROLLED_NODE_SERVICE.LINUX_UNIT).not.toBe('imcodes.service');
  });

  it('Windows task is boot-scoped SYSTEM with highest privilege (4.1)', () => {
    const args = windowsScheduledTaskArgs(EXE);
    expect(args).toContain('ONSTART');
    expect(args).toContain('SYSTEM');
    expect(args).toContain('HIGHEST');
    expect(args).toContain('imcodes-node');
    expect(args.join(' ')).toContain(EXE);
  });

  it('Windows credential dir is ProgramData-scoped (SYSTEM service), honoring %ProgramData% (10.10)', () => {
    expect(windowsCredentialDir({ ProgramData: 'D:\\PD' })).toBe('D:\\PD\\imcodes-node');
    expect(windowsCredentialDir({})).toBe('C:\\ProgramData\\imcodes-node');
    // Not a per-user path.
    expect(windowsCredentialDir({ ProgramData: 'C:\\ProgramData' })).not.toMatch(/Users/i);
  });

  it('Windows credential ACL grants only SYSTEM + Administrators and strips inheritance (10.10)', () => {
    const dir = 'C:\\ProgramData\\imcodes-node';
    const args = windowsCredentialAclArgs(dir);
    expect(args[0]).toBe(dir);
    expect(args).toContain('/inheritance:r'); // remove inherited/other-user access
    expect(args).toContain('SYSTEM:(OI)(CI)F');
    expect(args).toContain('Administrators:(OI)(CI)F');
    // No broad principals (Users/Everyone/Authenticated Users) are granted.
    const joined = args.join(' ');
    expect(joined).not.toMatch(/\bUsers:/);
    expect(joined).not.toMatch(/Everyone/i);
    expect(joined).not.toMatch(/Authenticated Users/i);
  });

  it('macOS artifact is a LaunchDaemon (root, boot), not a LaunchAgent (4.2)', () => {
    expect(MACOS_PLIST_PATH).toContain('/Library/LaunchDaemons/');
    expect(MACOS_PLIST_PATH).not.toContain('LaunchAgents');
    const plist = macosLaunchDaemonPlist(EXE);
    expect(plist).toContain('<string>cc.imcodes.node</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain(EXE);
  });

  it('Linux artifact is a systemd SYSTEM unit (not --user), restart-on-failure (4.3)', () => {
    expect(LINUX_UNIT_PATH).toBe('/etc/systemd/system/imcodes-node.service');
    expect(LINUX_UNIT_PATH).not.toContain('/user/');
    const unit = linuxSystemdUnit(EXE);
    expect(unit).toContain('WantedBy=multi-user.target'); // system, not user
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain(`ExecStart=${EXE}`);
  });
});
