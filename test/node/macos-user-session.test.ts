import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  launchMacosRemoteDesktopUserSession,
  macosRemoteDesktopGraphicalSessionPaths,
  macosRemoteDesktopUserSessionPaths,
  MACOS_REMOTE_DESKTOP_GLOBAL_LAUNCH_AGENT_PATH,
  MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT,
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  MACOS_REMOTE_DESKTOP_RUNTIME_ROOT,
} from '../../src/node/macos-user-session.js';
import {
  macosUserSessionLaunchctlArgs,
  type MacosUserSession,
} from '../../src/node/user-session-launcher.js';

const USER: MacosUserSession = {
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/ab/session/T/',
};

describe('macOS remote-desktop user-session groundwork', () => {
  it('derives stable per-user runtime, socket, plist and LaunchAgent identity values', () => {
    expect(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY).toEqual({
      bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
      label: 'cc.imcodes.node.remote-desktop-agent',
    });
    expect(Object.keys(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY).sort()).toEqual([
      'bundleIdentifier',
      'label',
    ]);
    expect(macosRemoteDesktopUserSessionPaths(USER)).toEqual({
      runtimeDirectory: `${MACOS_REMOTE_DESKTOP_RUNTIME_ROOT}/501/remote-desktop`,
      socketPath: `${MACOS_REMOTE_DESKTOP_RUNTIME_ROOT}/501/remote-desktop/remote-desktop-agent.sock`,
      launchAgentPlistPath: '/Users/desktop-user/Library/LaunchAgents/cc.imcodes.node.remote-desktop-agent.plist',
    });
  });

  it('rejects a runtime root that would overflow Darwin sockaddr_un', () => {
    expect(() => macosRemoteDesktopUserSessionPaths(USER, `/private/${'x'.repeat(100)}`))
      .toThrow('macos_remote_desktop_socket_path_too_long');
  });

  it('derives graphical-instance paths from uid plus audit session, never HOME', () => {
    const first = macosRemoteDesktopGraphicalSessionPaths({
      uid: 501,
      auditSessionId: 100003,
    });
    const successor = macosRemoteDesktopGraphicalSessionPaths({
      uid: 501,
      auditSessionId: 100004,
    });
    expect(first).toEqual({
      runtimeDirectory: `${MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT}/501/100003`,
      socketPath: `${MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT}/501/100003/remote-desktop-agent.sock`,
    });
    expect(successor.socketPath).not.toBe(first.socketPath);
    expect(JSON.stringify({ first, successor })).not.toContain(USER.home);
    expect(MACOS_REMOTE_DESKTOP_GLOBAL_LAUNCH_AGENT_PATH)
      .toBe('/Library/LaunchAgents/cc.imcodes.node.remote-desktop-agent.plist');
  });

  it('launches with only remote-desktop paths and no Computer Use or request authority', () => {
    const child = new EventEmitter() as ChildProcess;
    const calls: unknown[][] = [];
    const launchProcess = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as unknown as NonNullable<Parameters<typeof launchMacosRemoteDesktopUserSession>[2]>['launchProcess'];

    const result = launchMacosRemoteDesktopUserSession(USER, {
      executable: '/Library/Application Support/imcodes-node/remote-desktop-agent',
      args: ['--generation', '7'],
      ...({ controlledNodeCredential: 'must-not-cross', computerUseRequest: 'must-not-cross' } as object),
    }, { launchProcess });

    expect(result).toBe(child);
    expect(calls).toHaveLength(1);
    const [calledUser, command] = calls[0] as [MacosUserSession, {
      executable: string;
      args: string[];
      environment: Array<[string, string]>;
    }];
    expect(calledUser).toEqual(USER);
    expect(command).toEqual({
      executable: '/Library/Application Support/imcodes-node/remote-desktop-agent',
      args: ['--generation', '7'],
      environment: [
        ['IMCODES_REMOTE_DESKTOP_RUNTIME_DIR', `${MACOS_REMOTE_DESKTOP_RUNTIME_ROOT}/501/remote-desktop`],
        ['IMCODES_REMOTE_DESKTOP_SOCKET', `${MACOS_REMOTE_DESKTOP_RUNTIME_ROOT}/501/remote-desktop/remote-desktop-agent.sock`],
        ['IMCODES_REMOTE_DESKTOP_LAUNCH_AGENT_LABEL', 'cc.imcodes.node.remote-desktop-agent'],
      ],
    });
    expect(JSON.stringify(command)).not.toContain('must-not-cross');
    expect(JSON.stringify(command)).not.toContain('COMPUTER_USE');
  });

  it('keeps Computer Use and remote-desktop invocation state in separate argv values', () => {
    const computerUseArgs = macosUserSessionLaunchctlArgs(USER, {
      executable: '/opt/imcodes/computer-use',
      args: ['--pipe', '/tmp/computer-use.sock'],
      environment: [['IMCODES_COMPUTER_USE_EXE', '/opt/imcodes/ocu']],
    });
    const remoteDesktopArgs = macosUserSessionLaunchctlArgs(USER, {
      executable: '/opt/imcodes/remote-desktop',
      args: ['--socket', '/tmp/remote-desktop.sock'],
      environment: [['IMCODES_REMOTE_DESKTOP_SOCKET', '/tmp/remote-desktop.sock']],
    });

    expect(computerUseArgs).toContain('IMCODES_COMPUTER_USE_EXE=/opt/imcodes/ocu');
    expect(computerUseArgs.join('\n')).not.toContain('REMOTE_DESKTOP');
    expect(remoteDesktopArgs).toContain('IMCODES_REMOTE_DESKTOP_SOCKET=/tmp/remote-desktop.sock');
    expect(remoteDesktopArgs.join('\n')).not.toContain('COMPUTER_USE');
    expect(computerUseArgs).not.toBe(remoteDesktopArgs);
  });
});
