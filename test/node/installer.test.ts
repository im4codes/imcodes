import { describe, it, expect } from 'vitest';
import {
  CONTROLLED_NODE_SERVICE,
  windowsScheduledTaskArgs,
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
