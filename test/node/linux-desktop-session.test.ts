import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listX11DisplayNumbers,
  parsePasswdUserByUid,
  resolveActiveLinuxDesktopUser,
  resolveLinuxDesktopSessionEnv,
  allowLinuxComputerUseHelperFiles,
} from '../../src/node/linux-desktop-session.js';

describe('linux desktop session discovery', () => {
  it('parses passwd content by numeric uid correctly', () => {
    const fakePasswd = [
      'root:x:0:0:root:/root:/bin/bash',
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
      'ai:x:1000:1000:AI User,,,:/home/ai:/bin/bash',
      'guest:x:1001:1001:Guest,,,:/home/guest:/bin/sh',
    ].join('\n');

    expect(parsePasswdUserByUid(1000, fakePasswd)).toEqual({
      uid: 1000,
      gid: 1000,
      username: 'ai',
      home: '/home/ai',
    });
    expect(parsePasswdUserByUid(1001, fakePasswd)).toEqual({
      uid: 1001,
      gid: 1001,
      username: 'guest',
      home: '/home/guest',
    });
    expect(parsePasswdUserByUid(9999, fakePasswd)).toBeNull();
  });

  it('lists X11 display numbers from socket directory in numeric order', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'x11-sockets-test-'));
    try {
      writeFileSync(join(tempDir, 'X2'), '');
      writeFileSync(join(tempDir, 'X0'), '');
      writeFileSync(join(tempDir, 'X10'), '');
      writeFileSync(join(tempDir, 'not-a-socket'), '');
      expect(listX11DisplayNumbers(tempDir)).toEqual([0, 2, 10]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves active GUI user from run user dir when running as root', () => {
    const tempRunUser = mkdtempSync(join(tmpdir(), 'run-user-test-'));
    const tempSockets = mkdtempSync(join(tmpdir(), 'sockets-test-'));
    try {
      mkdirSync(join(tempRunUser, '1000'));
      writeFileSync(join(tempRunUser, '1000', 'bus'), '');
      const fakePasswd = 'ai:x:1000:1000:AI User,,,:/home/ai:/bin/bash';

      const user = resolveActiveLinuxDesktopUser({
        currentUid: 0,
        currentGid: 0,
        socketDir: tempSockets,
        runUserDir: tempRunUser,
        passwdContent: fakePasswd,
      });

      expect(user).toEqual({
        uid: 1000,
        gid: 1000,
        username: 'ai',
        home: '/home/ai',
      });
    } finally {
      rmSync(tempRunUser, { recursive: true, force: true });
      rmSync(tempSockets, { recursive: true, force: true });
    }
  });

  it('populates missing DISPLAY, XDG_RUNTIME_DIR, and DBUS_SESSION_BUS_ADDRESS in env', () => {
    const tempRunUser = mkdtempSync(join(tmpdir(), 'run-user-env-test-'));
    const tempSockets = mkdtempSync(join(tmpdir(), 'sockets-env-test-'));
    try {
      writeFileSync(join(tempSockets, 'X1'), '');
      mkdirSync(join(tempRunUser, '1000'));
      writeFileSync(join(tempRunUser, '1000', 'bus'), '');

      const baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
      const user = { uid: 1000, gid: 1000, username: 'ai', home: '/home/ai' };

      const resolved = resolveLinuxDesktopSessionEnv(baseEnv, {
        user,
        socketDir: tempSockets,
        runUserDir: tempRunUser,
      });

      expect(resolved.DISPLAY).toBe(':1');
      expect(resolved.XDG_RUNTIME_DIR).toBe(join(tempRunUser, '1000'));
      expect(resolved.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${join(tempRunUser, '1000', 'bus')}`);
      expect(resolved.USER).toBe('ai');
      expect(resolved.HOME).toBe('/home/ai');
    } finally {
      rmSync(tempRunUser, { recursive: true, force: true });
      rmSync(tempSockets, { recursive: true, force: true });
    }
  });

  it('preserves existing non-empty environment variables', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      DISPLAY: ':42',
      XDG_RUNTIME_DIR: '/custom/runtime',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus',
      XAUTHORITY: '/custom/.Xauthority',
    };
    const resolved = resolveLinuxDesktopSessionEnv(baseEnv);
    expect(resolved.DISPLAY).toBe(':42');
    expect(resolved.XDG_RUNTIME_DIR).toBe('/custom/runtime');
    expect(resolved.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/custom/bus');
    expect(resolved.XAUTHORITY).toBe('/custom/.Xauthority');
  });

  it('allowLinuxComputerUseHelperFiles gracefully handles non-existent or existing directories', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'linux-helper-files-test-'));
    try {
      const execPath = join(temp, 'imcodes-node');
      writeFileSync(execPath, '');
      mkdirSync(join(temp, 'computer-use-helper'));
      await expect(allowLinuxComputerUseHelperFiles(execPath)).resolves.toBeUndefined();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
