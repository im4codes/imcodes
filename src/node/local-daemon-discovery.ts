import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROLLED_NODE_LOCAL_DAEMONS_MAX,
  CONTROLLED_NODE_LOCAL_DAEMON_CREDENTIAL_MAX_BYTES,
  isPlausibleServerId,
} from '../../shared/controlled-node-host-link.js';

/**
 * Which IM.codes daemons are bound on this computer.
 *
 * A daemon keeps its binding in `~/.imcodes/server.json` of the user it runs
 * as. The controlled node runs with system rights, so it can look in every
 * user's home. Only the daemon's `serverId` leaves this function -- never its
 * token.
 *
 * Every bound daemon is reported, whichever address it was bound through: one
 * deployment is often reachable under more than one domain, and comparing
 * origins here dropped exactly those daemons (vm-124: its daemon bound through
 * im-proxy.koca.win, its node through im.zhinet.work, so they were never
 * linked). The server links only an id it knows as one of this node owner's
 * own daemons, so an id bound to another deployment matches nothing there.
 */

/** Profile folders under the Windows Users directory that are never a person. */
const WINDOWS_NON_USER_PROFILES = new Set(['public', 'default', 'default user', 'all users']);

export interface LocalDaemonDiscoveryOptions {
  platform?: NodeJS.Platform;
  /** Every home directory to look in; defaults to this platform's user homes. */
  homes?: readonly string[];
}

async function childDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/** The home directories a daemon could be bound in, for this platform. */
export async function localUserHomes(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const homes = new Set<string>([homedir()]);
  if (platform === 'linux') {
    homes.add('/root');
    for (const home of await childDirectories('/home')) homes.add(home);
  } else if (platform === 'darwin') {
    homes.add('/var/root');
    for (const home of await childDirectories('/Users')) {
      if (!home.endsWith('/Shared')) homes.add(home);
    }
  } else if (platform === 'win32') {
    const usersRoot = join(process.env.SystemDrive ?? 'C:', '\\Users');
    for (const home of await childDirectories(usersRoot)) {
      const name = home.slice(usersRoot.length + 1).toLowerCase();
      if (!WINDOWS_NON_USER_PROFILES.has(name)) homes.add(home);
    }
  }
  return [...homes];
}

async function readBoundServerId(home: string): Promise<string | null> {
  const path = join(home, '.imcodes', 'server.json');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > CONTROLLED_NODE_LOCAL_DAEMON_CREDENTIAL_MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const { serverId, workerUrl } = parsed;
    return isPlausibleServerId(serverId) && typeof workerUrl === 'string' ? serverId : null;
  } catch {
    return null;
  }
}

/** Sorted, de-duplicated serverIds of the daemons bound on this computer. */
export async function discoverLocalDaemonServerIds(
  options: LocalDaemonDiscoveryOptions = {},
): Promise<string[]> {
  const homes = options.homes ?? await localUserHomes(options.platform);
  const found = new Set<string>();
  for (const home of homes) {
    const serverId = await readBoundServerId(home);
    if (serverId) found.add(serverId);
    if (found.size >= CONTROLLED_NODE_LOCAL_DAEMONS_MAX) break;
  }
  return [...found].sort();
}
