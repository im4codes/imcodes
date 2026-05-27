import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

type ExecFileSyncLike = (
  file: string,
  args?: readonly string[],
  options?: Parameters<typeof execFileSync>[2],
) => ReturnType<typeof execFileSync>;

export type SystemdLingerMethod = 'loginctl' | 'sudo-loginctl';

export interface EnableSystemdUserLingerResult {
  ok: boolean;
  user: string | null;
  method: SystemdLingerMethod | null;
  error: unknown;
}

export interface EnableSystemdUserLingerOptions {
  user?: string | null;
  currentUsername?: string | null;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSyncLike;
}

export function resolveSystemdLingerUser(options: Pick<EnableSystemdUserLingerOptions, 'currentUsername' | 'env'> = {}): string | null {
  const env = options.env ?? process.env;
  let currentUsername = options.currentUsername;
  if (currentUsername === undefined) {
    try {
      currentUsername = userInfo().username;
    } catch {
      currentUsername = null;
    }
  }

  if (currentUsername === 'root' && env.SUDO_USER) return env.SUDO_USER;
  return currentUsername || env.USER || env.LOGNAME || null;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatSystemdLingerManualCommand(user: string | null): string {
  return user ? `sudo loginctl enable-linger ${shellQuote(user)}` : 'sudo loginctl enable-linger <user>';
}

export function formatSystemdLingerFailureMessage(user: string | null): string {
  return [
    'Could not enable systemd user-linger automatically after trying loginctl and passwordless sudo.',
    `Run manually with sudo permissions: ${formatSystemdLingerManualCommand(user)}`,
  ].join(' ');
}

export function enableSystemdUserLinger(options: EnableSystemdUserLingerOptions = {}): EnableSystemdUserLingerResult {
  const user = options.user || resolveSystemdLingerUser(options);
  if (!user) {
    return {
      ok: false,
      user: null,
      method: null,
      error: new Error('could not determine current user'),
    };
  }

  const execFile = options.execFileSync ?? execFileSync;
  try {
    execFile('loginctl', ['enable-linger', user], { stdio: 'ignore' });
    return { ok: true, user, method: 'loginctl', error: null };
  } catch (loginctlError) {
    try {
      execFile('sudo', ['-n', 'loginctl', 'enable-linger', user], { stdio: 'ignore' });
      return { ok: true, user, method: 'sudo-loginctl', error: null };
    } catch (sudoError) {
      return {
        ok: false,
        user,
        method: null,
        error: sudoError || loginctlError,
      };
    }
  }
}
