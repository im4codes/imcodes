import { join } from 'node:path';
import {
  assertMacosUserSession,
  launchMacosUserSessionCommand,
  type MacosUserSession,
} from './user-session-launcher.js';

export const MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY = Object.freeze({
  bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
  label: 'cc.imcodes.node.remote-desktop-agent',
} as const);

export const MACOS_REMOTE_DESKTOP_RUNTIME_ROOT = '/private/var/run/imcodes-node/user-sessions';
export const MACOS_REMOTE_DESKTOP_SOCKET_NAME = 'remote-desktop-agent.sock';

const MACOS_UNIX_SOCKET_PATH_MAX_BYTES = 103;

export interface MacosRemoteDesktopUserSessionPaths {
  runtimeDirectory: string;
  socketPath: string;
  launchAgentPlistPath: string;
}

export interface MacosRemoteDesktopUserSessionLaunch {
  executable: string;
  args?: readonly string[];
}

export function macosRemoteDesktopUserSessionPaths(
  user: MacosUserSession,
  runtimeRoot = MACOS_REMOTE_DESKTOP_RUNTIME_ROOT,
): MacosRemoteDesktopUserSessionPaths {
  assertMacosUserSession(user);
  if (!runtimeRoot.startsWith('/')
    || runtimeRoot.includes('\0')
    || runtimeRoot.includes('\n')
    || runtimeRoot.includes('\r')) {
    throw new Error('macos_remote_desktop_invalid_runtime_root');
  }
  const runtimeDirectory = join(runtimeRoot, String(user.uid), 'remote-desktop');
  const socketPath = join(runtimeDirectory, MACOS_REMOTE_DESKTOP_SOCKET_NAME);
  if (Buffer.byteLength(socketPath) > MACOS_UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error('macos_remote_desktop_socket_path_too_long');
  }
  return {
    runtimeDirectory,
    socketPath,
    launchAgentPlistPath: join(
      user.home,
      'Library',
      'LaunchAgents',
      `${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label}.plist`,
    ),
  };
}

/**
 * Launch a caller-owned remote-desktop worker in the active GUI session.
 *
 * This groundwork API deliberately accepts no controlled-node credential,
 * route authority or Computer Use state. The later authenticated IPC layer owns
 * those values and their generation; this launcher only supplies stable paths.
 */
export function launchMacosRemoteDesktopUserSession(
  user: MacosUserSession,
  launch: MacosRemoteDesktopUserSessionLaunch,
  options: {
    runtimeRoot?: string;
    launchProcess?: typeof launchMacosUserSessionCommand;
  } = {},
): ReturnType<typeof launchMacosUserSessionCommand> {
  const paths = macosRemoteDesktopUserSessionPaths(user, options.runtimeRoot);
  const launchProcess = options.launchProcess ?? launchMacosUserSessionCommand;
  return launchProcess(user, {
    executable: launch.executable,
    args: launch.args,
    environment: [
      ['IMCODES_REMOTE_DESKTOP_RUNTIME_DIR', paths.runtimeDirectory],
      ['IMCODES_REMOTE_DESKTOP_SOCKET', paths.socketPath],
      ['IMCODES_REMOTE_DESKTOP_LAUNCH_AGENT_LABEL', MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label],
    ],
  });
}
