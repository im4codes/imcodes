import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  imcodesHomeHash,
  isScopedImcodesHome,
  resolveDefaultImcodesHome,
  resolveImcodesHome,
} from './windows-daemon-lock.js';

export interface PosixDaemonServicePaths {
  stateHome: string;
  defaultHome: string;
  scoped: boolean;
  launchAgentLabel: string;
  launchAgentPath: string;
  legacyLaunchAgentPath: string;
  systemdUnitName: string;
  systemdUnitPath: string;
}

/**
 * Resolve service names and paths from the same state-home identity used by
 * the daemon lock.  The default installation keeps its historical names;
 * isolated homes receive a stable hash and can never overwrite or reload the
 * default service.
 */
export function resolvePosixDaemonServicePaths(
  env: NodeJS.ProcessEnv = process.env,
): PosixDaemonServicePaths {
  const stateHome = resolveImcodesHome({ env });
  const defaultHome = resolveDefaultImcodesHome(env);
  const scoped = isScopedImcodesHome(stateHome, env);
  const suffix = scoped ? `.${imcodesHomeHash(stateHome)}` : '';
  const launchAgentLabel = `imcodes.daemon${suffix}`;
  const systemdUnitName = `imcodes${suffix}.service`;
  return {
    stateHome,
    defaultHome,
    scoped,
    launchAgentLabel,
    launchAgentPath: join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`),
    legacyLaunchAgentPath: join(homedir(), 'Library', 'LaunchAgents', 'cc.imcodes.daemon.plist'),
    systemdUnitName,
    systemdUnitPath: join(homedir(), '.config', 'systemd', 'user', systemdUnitName),
  };
}

