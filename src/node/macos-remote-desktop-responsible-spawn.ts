import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VerifiedMacosRemoteDesktopComponent } from './macos-remote-desktop-artifact.js';
import {
  MACOS_AIDESK_APP_NAME,
  MACOS_AIDESK_BUNDLE_ID,
  MACOS_AIDESK_TEAM_ID,
} from './macos-computer-use.js';
import {
  MACOS_LAUNCHCTL_PATH,
  macosUserSessionLaunchctlArgs,
  type MacosUserSession,
} from './user-session-launcher.js';

const MACOS_OPEN_PATH = '/usr/bin/open';
const MACOS_CODESIGN_PATH = '/usr/bin/codesign';
const COMMAND_OUTPUT_FILE = 'stdout';
const COMMAND_ERROR_FILE = 'stderr';

export const MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH =
  join('/Library/Application Support/aidesk', MACOS_AIDESK_APP_NAME);

export const MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT = [
  `identifier "${MACOS_AIDESK_BUNDLE_ID}"`,
  'and anchor apple generic',
  `and certificate leaf[subject.OU] = "${MACOS_AIDESK_TEAM_ID}"`,
].join(' ');

export interface MacosRemoteDesktopResponsibleCommandResult {
  stdout: string;
  stderr: string;
}

export interface MacosRemoteDesktopResponsibleCommandOptions {
  user: MacosUserSession;
  component: VerifiedMacosRemoteDesktopComponent;
  args: readonly string[];
  appPath?: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface MacosRemoteDesktopResponsibleSpawnDependencies {
  executeFile?: typeof execFileText;
}

interface CommandOutputPaths {
  directory: string;
  stdout: string;
  stderr: string;
}

function execFileText(
  executable: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBufferBytes: number;
  },
): Promise<MacosRemoteDesktopResponsibleCommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, [...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function requireUnlinkedDirectory(path: string, error: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error(error);
}

async function requireUnlinkedRegularFile(path: string, error: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(error);
}

function isInside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return child === parent || (child.startsWith(parent) && relative.startsWith('/'));
}

async function verifyResponsibleApplication(
  appPath: string,
  component: VerifiedMacosRemoteDesktopComponent,
  executeFile: typeof execFileText,
): Promise<string> {
  // The aiDesk main executable routes the bounded --imcodes-* native command
  // family to this embedded worker. Refuse every other component so the bytes
  // verified here are necessarily the bytes LaunchServices will execute.
  if (component.kind !== 'worker') {
    throw new Error('macos_remote_desktop_responsible_component_mismatch');
  }
  const requestedAppPath = resolve(appPath);
  await requireUnlinkedDirectory(
    requestedAppPath,
    'macos_remote_desktop_responsible_app_unavailable',
  );
  // realpath canonicalizes harmless ancestor aliases such as /var ->
  // /private/var. lstat above still rejects an app path that is itself a
  // symlink, while all subsequent checks and the launch use one canonical
  // bundle path.
  const canonicalAppPath = await realpath(requestedAppPath);

  const helperPath = join(canonicalAppPath, 'Contents', 'Helpers', component.fileName);
  await requireUnlinkedRegularFile(
    helperPath,
    'macos_remote_desktop_responsible_helper_unavailable',
  );
  const resolvedHelperPath = await realpath(helperPath);
  if (!isInside(`${canonicalAppPath}/Contents/Helpers`, resolvedHelperPath)
    || resolvedHelperPath !== helperPath) {
    throw new Error('macos_remote_desktop_responsible_helper_replaced');
  }
  if (await sha256File(helperPath) !== component.sha256) {
    throw new Error('macos_remote_desktop_responsible_helper_hash_mismatch');
  }

  const signatureOptions = { timeoutMs: 15_000, maxBufferBytes: 16 * 1024 };
  await executeFile(MACOS_CODESIGN_PATH, [
    '--verify',
    '--deep',
    '--strict',
    `-R=${MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT}`,
    canonicalAppPath,
  ], signatureOptions).catch(() => {
    throw new Error('macos_remote_desktop_responsible_app_identity_mismatch');
  });
  await executeFile(MACOS_CODESIGN_PATH, [
    '--verify',
    '--strict',
    `-R=${component.designatedRequirement}`,
    helperPath,
  ], signatureOptions).catch(() => {
    throw new Error('macos_remote_desktop_responsible_helper_identity_mismatch');
  });
  return canonicalAppPath;
}

async function createCommandOutputPaths(user: MacosUserSession): Promise<CommandOutputPaths> {
  const directory = await mkdtemp(join(user.tempDir, '.imcodes-remote-desktop-command-'));
  await chmod(directory, 0o700);
  await chown(directory, user.uid, user.gid);
  const stdout = join(directory, COMMAND_OUTPUT_FILE);
  const stderr = join(directory, COMMAND_ERROR_FILE);
  await writeFile(stdout, '', { mode: 0o600 });
  await writeFile(stderr, '', { mode: 0o600 });
  await chown(stdout, user.uid, user.gid);
  await chown(stderr, user.uid, user.gid);
  return { directory, stdout, stderr };
}

export function macosRemoteDesktopResponsibleCommandInvocation(
  user: MacosUserSession,
  appPath: string,
  args: readonly string[],
  output: Pick<CommandOutputPaths, 'stdout' | 'stderr'>,
): Readonly<{
  executable: typeof MACOS_LAUNCHCTL_PATH;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}> {
  return Object.freeze({
    executable: MACOS_LAUNCHCTL_PATH,
    args: Object.freeze(macosUserSessionLaunchctlArgs(user, {
      executable: MACOS_OPEN_PATH,
      args: [
        '-W',
        '-n',
        '-g',
        '--stdout',
        output.stdout,
        '--stderr',
        output.stderr,
        '--env',
        `HOME=${user.home}`,
        '--env',
        `TMPDIR=${user.tempDir}`,
        appPath,
        '--args',
        ...args,
      ],
    })),
    env: Object.freeze({}),
  });
}

export async function executeMacosRemoteDesktopResponsibleCommand(
  options: MacosRemoteDesktopResponsibleCommandOptions,
  dependencies: MacosRemoteDesktopResponsibleSpawnDependencies = {},
): Promise<MacosRemoteDesktopResponsibleCommandResult> {
  const executeFile = dependencies.executeFile ?? execFileText;
  const appPath = await verifyResponsibleApplication(
    options.appPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,
    options.component,
    executeFile,
  );
  const output = await createCommandOutputPaths(options.user);
  try {
    const invocation = macosRemoteDesktopResponsibleCommandInvocation(
      options.user,
      appPath,
      options.args,
      output,
    );
    await executeFile(invocation.executable, invocation.args, {
      env: invocation.env,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
    });
    const [stdout, stderr] = await Promise.all([
      readFile(output.stdout, 'utf8'),
      readFile(output.stderr, 'utf8'),
    ]);
    if (Buffer.byteLength(stdout) > options.maxBufferBytes
      || Buffer.byteLength(stderr) > options.maxBufferBytes) {
      throw new Error('macos_remote_desktop_native_command_output_too_large');
    }
    return { stdout, stderr };
  } finally {
    await rm(output.directory, { recursive: true, force: true }).catch(() => {});
  }
}
