import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface LinuxDesktopUser {
  uid: number;
  gid: number;
  username: string;
  home: string;
}

export const X11_UNIX_SOCKET_DIR = '/tmp/.X11-unix';
const X11_SOCKET_PATTERN = /^X(\d+)$/;

export function listX11DisplayNumbers(socketDir: string = X11_UNIX_SOCKET_DIR): number[] {
  try {
    return readdirSync(socketDir)
      .map((name) => X11_SOCKET_PATTERN.exec(name)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .filter((v) => Number.isSafeInteger(v) && v >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function parsePasswdUserByUid(uid: number, passwdContent?: string): LinuxDesktopUser | null {
  try {
    const content = passwdContent !== undefined ? passwdContent : readFileSync('/etc/passwd', 'utf8');
    for (const line of content.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 6 && Number(parts[2]) === uid) {
        return {
          uid,
          gid: Number(parts[3]),
          username: parts[0] || 'user',
          home: parts[5] || `/home/${parts[0]}`,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Identify the active interactive GUI user on Linux.
 * When running as root (e.g. systemd service), returns the user who owns the display/session.
 * When running as a normal user, returns the current process user.
 */
export function resolveActiveLinuxDesktopUser(options: {
  currentUid?: number;
  currentGid?: number;
  socketDir?: string;
  runUserDir?: string;
  passwdContent?: string;
} = {}): LinuxDesktopUser | null {
  const currentUid = options.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const currentGid = options.currentGid ?? (typeof process.getgid === 'function' ? process.getgid() : -1);

  if (currentUid > 0) {
    const fromPasswd = parsePasswdUserByUid(currentUid, options.passwdContent);
    if (fromPasswd) return fromPasswd;
    const username = process.env.USER || process.env.LOGNAME || 'user';
    const home = process.env.HOME || `/home/${username}`;
    return { uid: currentUid, gid: currentGid > 0 ? currentGid : currentUid, username, home };
  }

  // Running as root: probe the active display socket owner.
  const socketDir = options.socketDir ?? X11_UNIX_SOCKET_DIR;
  const displayNumbers = listX11DisplayNumbers(socketDir);
  for (const num of displayNumbers) {
    try {
      const stats = statSync(join(socketDir, `X${num}`));
      if (stats.uid > 0) {
        const user = parsePasswdUserByUid(stats.uid, options.passwdContent);
        if (user) return user;
      }
    } catch {
      /* ignore */
    }
  }

  // Next, probe /run/user/<uid> directories for active desktop sessions.
  const runUserDir = options.runUserDir ?? '/run/user';
  try {
    const entries = readdirSync(runUserDir)
      .map(Number)
      .filter((uid) => Number.isSafeInteger(uid) && uid >= 1000)
      .sort((a, b) => a - b);
    for (const uid of entries) {
      const busPath = join(runUserDir, String(uid), 'bus');
      if (existsSync(busPath)) {
        const user = parsePasswdUserByUid(uid, options.passwdContent);
        if (user) return user;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

export function resolveLinuxDesktopSessionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: {
    user?: LinuxDesktopUser | null;
    socketDir?: string;
    runUserDir?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const user = options.user !== undefined ? options.user : resolveActiveLinuxDesktopUser(options);

  // 1. DISPLAY
  if (!env.DISPLAY?.trim()) {
    const socketDir = options.socketDir ?? X11_UNIX_SOCKET_DIR;
    const numbers = listX11DisplayNumbers(socketDir);
    env.DISPLAY = numbers.length > 0 ? `:${numbers[0]}` : ':0';
  }

  // 2. XDG_RUNTIME_DIR
  if (!env.XDG_RUNTIME_DIR?.trim() && user) {
    const candidate = join(options.runUserDir ?? '/run/user', String(user.uid));
    if (existsSync(candidate)) {
      env.XDG_RUNTIME_DIR = candidate;
    }
  }

  // 3. DBUS_SESSION_BUS_ADDRESS
  if (!env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    if (env.XDG_RUNTIME_DIR) {
      const busSocket = join(env.XDG_RUNTIME_DIR, 'bus');
      if (existsSync(busSocket)) {
        env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busSocket}`;
      }
    }
  }

  // 4. XAUTHORITY
  if (!env.XAUTHORITY?.trim() && user?.home) {
    const userXauth = join(user.home, '.Xauthority');
    if (existsSync(userXauth)) {
      env.XAUTHORITY = userXauth;
    } else if (env.XDG_RUNTIME_DIR) {
      const runtimeXauth = join(env.XDG_RUNTIME_DIR, 'Xauthority');
      if (existsSync(runtimeXauth)) {
        env.XAUTHORITY = runtimeXauth;
      }
    }
  }

  // 5. USER & HOME
  if (user) {
    if (!env.USER) env.USER = user.username;
    if (!env.HOME) env.HOME = user.home;
  }

  return env;
}

/**
 * Ensure the directory housing imcodes-node and its computer-use-helper sidecar
 * has search/traverse permissions for local users so an interactive user can run them.
 */
export async function allowLinuxComputerUseHelperFiles(execPath: string = process.execPath): Promise<void> {
  if (process.platform !== 'linux') return;
  const dir = dirname(execPath);
  try {
    await chmod(dir, 0o755);
  } catch {
    /* best effort */
  }
  const helperDir = join(dir, 'computer-use-helper');
  if (existsSync(helperDir)) {
    try {
      await chmod(helperDir, 0o755);
    } catch {
      /* best effort */
    }
  }
}
