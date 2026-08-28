import { describe, expect, it, vi } from 'vitest';
import {
  MACOS_USER_SESSION_ERROR,
  resolveMacosRemoteDesktopGraphicalSessionAuthority,
  resolveMacosUserSession,
  type MacosUserSession,
} from '../../src/node/user-session-launcher.js';

const AQUA_USER: MacosUserSession = {
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/ab/session/T/',
};

describe('macOS graphical-session authority', () => {
  it('creates explicit LoginWindow bootstrap authority without resolving an Aqua user', async () => {
    const resolveAquaUser = vi.fn(async () => AQUA_USER);
    const authority = await resolveMacosRemoteDesktopGraphicalSessionAuthority(
      { uid: 88, auditSessionId: 100000, pidVersion: 3, sessionType: 'LoginWindow' },
      { uid: 88, auditSessionId: 100000, sessionType: 'LoginWindow' },
      { resolveAquaUser },
    );
    expect(authority).toEqual({
      kind: 'loginwindow_bootstrap',
      sessionType: 'LoginWindow',
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 3,
    });
    expect(resolveAquaUser).not.toHaveBeenCalled();
    expect(JSON.stringify(authority)).not.toMatch(/HOME|TMPDIR|desktop-user|Users\//u);
  });

  it('binds Aqua authority to the actually resolved active user', async () => {
    const authority = await resolveMacosRemoteDesktopGraphicalSessionAuthority(
      { uid: 501, auditSessionId: 100003, pidVersion: 7, sessionType: 'Aqua' },
      { uid: 501, auditSessionId: 100003, sessionType: 'Aqua' },
      { resolveAquaUser: async () => AQUA_USER },
    );
    expect(authority).toEqual({
      kind: 'aqua_user',
      sessionType: 'Aqua',
      auditSessionId: 100003,
      pidVersion: 7,
      user: AQUA_USER,
    });
  });

  it.each([
    [{ uid: 501, auditSessionId: 100003, pidVersion: 7, sessionType: 'Aqua' as const },
      { uid: 502, auditSessionId: 100003, sessionType: 'Aqua' as const }],
    [{ uid: 501, auditSessionId: 100003, pidVersion: 7, sessionType: 'Aqua' as const },
      { uid: 501, auditSessionId: 100004, sessionType: 'LoginWindow' as const }],
    [{ uid: 0, auditSessionId: 100000, pidVersion: 7, sessionType: 'LoginWindow' as const },
      { uid: 0, auditSessionId: 100000, sessionType: 'LoginWindow' as const }],
    [{ uid: 501, auditSessionId: 100003, pidVersion: 7, sessionType: 'Aqua' as const },
      { uid: 501, auditSessionId: 100003, sessionType: 'LoginWindow' as const }],
  ])('rejects peer/declaration mismatch or root', async (peer, declaration) => {
    await expect(resolveMacosRemoteDesktopGraphicalSessionAuthority(
      peer,
      declaration,
      { resolveAquaUser: async () => AQUA_USER },
    )).rejects.toThrow(MACOS_USER_SESSION_ERROR.INVALID_CONSOLE_USER);
  });

  it('keeps the ordinary console resolver fail-closed for root and loginwindow', async () => {
    for (const name of ['root', 'loginwindow']) {
      await expect(resolveMacosUserSession({
        execFileText: async (file, args) => {
          if (file === '/usr/bin/stat' && args.includes('%Su')) return name;
          throw new Error('unexpected lookup');
        },
      })).rejects.toThrow(MACOS_USER_SESSION_ERROR.NO_ACTIVE_GUI_SESSION);
    }
  });
});
