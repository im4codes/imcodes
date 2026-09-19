/**
 * A Linux controlled node on a box with no graphical session at all (a plain
 * server: no X server, no desktop packages) has nothing for the remote-desktop
 * worker to capture. Rather than advertise a remote desktop that fails the
 * moment a session starts, the node offers to set one up, and does it itself
 * when the owner clicks 启用远程控制: a virtual X display plus a basic XFCE
 * session, as persistent systemd services.
 *
 * The recipe is scripts/install-linux-desktop-environment.sh, bundled into the
 * node verbatim -- one recipe for the operator-run script and the node, never
 * two copies to drift apart.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import desktopEnvironmentScript from '../../scripts/install-linux-desktop-environment.sh?raw';

const X11_SOCKET_DIR = '/tmp/.X11-unix';
/** apt, a full XFCE install and the session start can take a while on a slow mirror. */
const PROVISION_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL_BYTES = 4096;

export const LINUX_DESKTOP_PROVISION_FAILURE = {
  UNSUPPORTED_DISTRO: 'unsupported_distro',
  NO_DESKTOP_USER: 'no_desktop_user',
  INSTALL_FAILED: 'install_failed',
} as const;
export type LinuxDesktopProvisionFailure =
  typeof LINUX_DESKTOP_PROVISION_FAILURE[keyof typeof LINUX_DESKTOP_PROVISION_FAILURE];

export type LinuxDesktopProvisionResult =
  | { ok: true; user: string }
  | { ok: false; reason: LinuxDesktopProvisionFailure; detail?: string };

/** Is any X server listening on this box? (The worker looks for the same sockets.) */
export function linuxGraphicalDisplayAvailable(socketDir = X11_SOCKET_DIR): boolean {
  try {
    return readdirSync(socketDir).some((name) => /^X\d+$/.test(name));
  } catch {
    return false;
  }
}

/** The installer is apt-based (Debian/Ubuntu). */
export function linuxDesktopProvisionSupported(
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists('/usr/bin/apt-get') && exists('/usr/bin/systemctl');
}

/**
 * The account the desktop session runs as: the box's primary human login --
 * the lowest regular UID with a real shell and a home directory. A controlled
 * node runs as root and records no installing user, and a desktop must never
 * run as root.
 */
export function pickLinuxDesktopUser(
  passwd: string,
  isDirectory: (path: string) => boolean = (path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  },
): string | null {
  const candidates = passwd.split('\n').flatMap((line) => {
    const [name, , uidText, , , home, shell] = line.split(':');
    const uid = Number(uidText);
    if (!name || !home || !shell || !Number.isInteger(uid)) return [];
    if (uid < 1000 || uid >= 65534) return [];
    if (/(nologin|false)$/.test(shell)) return [];
    if (!isDirectory(home)) return [];
    return [{ name, uid }];
  });
  candidates.sort((a, b) => a.uid - b.uid);
  return candidates[0]?.name ?? null;
}

type RunScript = (scriptPath: string, args: readonly string[]) => Promise<{ code: number; output: string }>;

const runScript: RunScript = (scriptPath, args) => new Promise((resolve) => {
  execFile('bash', [scriptPath, ...args], {
    timeout: PROVISION_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  }, (error, stdout, stderr) => {
    const output = `${stdout}${stderr}`;
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, output: output.slice(-OUTPUT_TAIL_BYTES) });
  });
});

/**
 * Install and start the basic desktop. Idempotent (the script is), so a retry
 * after a partial failure simply finishes the job.
 */
export async function provisionLinuxDesktopEnvironment(deps: {
  supported?: () => boolean;
  readPasswd?: () => string;
  pickUser?: (passwd: string) => string | null;
  run?: RunScript;
} = {}): Promise<LinuxDesktopProvisionResult> {
  if (!(deps.supported ?? linuxDesktopProvisionSupported)()) {
    return { ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.UNSUPPORTED_DISTRO };
  }
  const passwd = (deps.readPasswd ?? (() => readFileSync('/etc/passwd', 'utf8')))();
  const user = (deps.pickUser ?? pickLinuxDesktopUser)(passwd);
  if (!user) return { ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.NO_DESKTOP_USER };

  const dir = await mkdtemp(join(tmpdir(), 'imcodes-desktop-'));
  try {
    const scriptPath = join(dir, 'install-linux-desktop-environment.sh');
    await writeFile(scriptPath, desktopEnvironmentScript, { mode: 0o700 });
    await chmod(scriptPath, 0o700);
    // Basic desktop only: Firefox comes from Mozilla's own repository, which
    // is slow or unreachable on many networks, and is one apt line away later.
    const { code, output } = await (deps.run ?? runScript)(scriptPath, ['--user', user, '--no-firefox']);
    if (code !== 0) {
      return { ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.INSTALL_FAILED, detail: output };
    }
    return { ok: true, user };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
