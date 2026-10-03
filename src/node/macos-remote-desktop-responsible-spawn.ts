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
import { dirname, join, resolve } from 'node:path';
import type {
  VerifiedMacosRemoteDesktopArtifact,
  VerifiedMacosRemoteDesktopComponent,
} from './macos-remote-desktop-artifact.js';
import {
  MACOS_AIDESK_APP_NAME,
  MACOS_AIDESK_EXECUTABLE,
  MACOS_AIDESK_BUNDLE_ID,
  MACOS_AIDESK_TEAM_ID,
} from './macos-computer-use.js';
import {
  MACOS_LAUNCHCTL_PATH,
  macosUserSessionLaunchctlArgs,
  type MacosUserSession,
} from './user-session-launcher.js';
import { appleDesignatedRequirement } from '../../shared/macos-code-requirement.js';

const MACOS_OPEN_PATH = '/usr/bin/open';
const MACOS_CODESIGN_PATH = '/usr/bin/codesign';
const COMMAND_OUTPUT_FILE = 'stdout';
const COMMAND_ERROR_FILE = 'stderr';

export const MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH =
  join('/Library/Application Support/aidesk', MACOS_AIDESK_APP_NAME);

export const MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT = appleDesignatedRequirement(
  MACOS_AIDESK_BUNDLE_ID,
  MACOS_AIDESK_TEAM_ID,
);

/**
 * First argument to aiDesk's main executable naming the node's component store
 * directory. Mirrors kAiDeskComponentDirectoryArgumentPrefix in
 * native/macos-remote-desktop/macos_permission_onboarding.h.
 */
export const MACOS_AIDESK_COMPONENT_DIRECTORY_ARGUMENT_PREFIX = '--aidesk-component-dir=';

/**
 * How to start a remote-desktop helper so aiDesk.to by IM.codes.app is its
 * responsible process: the app's main executable, and the leading arguments
 * that tell it where the helper lives.
 */
export interface MacosRemoteDesktopResponsibleLauncher {
  appPath: string;
  executablePath: string;
  /** Empty when the helper is sealed inside the app; the store directory otherwise. */
  arguments: readonly string[];
}

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
  /**
   * Start the helper and return once LaunchServices has launched it, without
   * waiting for it to exit. For commands that are MEANT to outlive the call --
   * the permission request stays up while the person works in System Settings
   * -- waiting could only end in a timeout that abandons the process anyway.
   */
  detached?: boolean;
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
): Promise<{ appPath: string; arguments: readonly string[] }> {
  // The aiDesk main executable routes the bounded --imcodes-* native command
  // family to the worker. Refuse every other component so the bytes verified
  // here are necessarily the bytes LaunchServices will execute.
  if (component.kind !== 'worker') {
    throw new Error('macos_remote_desktop_responsible_component_mismatch');
  }
  return await verifyResponsibleLaunch(appPath, [component], executeFile);
}

/**
 * The app that launches, and the arguments that point it at the helper.
 *
 * Prefers helpers sealed inside the app bundle. The app the node actually
 * receives carries only the launcher, so otherwise the helpers run from the
 * node's own root-owned component store: the app still starts them (keeping it
 * the responsible process for the one grant the person gave it), and the
 * store's helpers must match the verified set byte for byte and signature for
 * signature. aiDesk re-checks the directory ownership and helper signature
 * natively before it launches anything.
 */
async function verifyResponsibleLaunch(
  appPath: string,
  components: readonly VerifiedMacosRemoteDesktopComponent[],
  executeFile: typeof execFileText,
): Promise<{ appPath: string; arguments: readonly string[] }> {
  try {
    return {
      appPath: await verifyApplicationHelpers(appPath, components, executeFile),
      arguments: [],
    };
  } catch (bundleError) {
    const directory = await verifyStoreHelpers(components, executeFile).catch((storeError: unknown) => {
      // No store copy at all: the bundle's own refusal is the real reason.
      throw storeError instanceof Error
        && storeError.message === 'macos_remote_desktop_store_helper_unavailable'
        ? bundleError
        : storeError;
    });
    const canonicalAppPath = await verifyApplicationIdentity(appPath, executeFile);
    return {
      appPath: canonicalAppPath,
      arguments: [`${MACOS_AIDESK_COMPONENT_DIRECTORY_ARGUMENT_PREFIX}${directory}`],
    };
  }
}

/**
 * The executable a per-user LaunchAgent should run so that every process of the
 * session belongs to aiDesk.to by IM.codes.app -- or null when that app cannot
 * vouch for this exact component set.
 *
 * launchd starts the app's main executable; it execs the agent in
 * Contents/Helpers, which spawns the worker and disclosure beside it. All three
 * are therefore inside the one signed bundle the person granted Screen
 * Recording and Accessibility to, instead of each binary in the component store
 * asking for its own grant under its own name. Every helper that will run must
 * be byte-identical to the verified set, and the bundle must carry aiDesk's
 * signature; anything short of that falls back to the store, never to an
 * unverified copy.
 */
export async function resolveMacosRemoteDesktopBundledLaunchAgentExecutable(
  artifact: VerifiedMacosRemoteDesktopArtifact,
  options: {
    appPath?: string;
    executeFile?: typeof execFileText;
  } = {},
): Promise<string | null> {
  const launcher = await resolveMacosRemoteDesktopResponsibleLauncher(artifact, options);
  return launcher && launcher.arguments.length === 0 ? launcher.executablePath : null;
}

/**
 * The launcher for the session's LaunchAgent: aiDesk's main executable plus the
 * arguments that locate the launch agent, worker and disclosure (sealed inside
 * the app, or in the node's component store). Null when aiDesk cannot vouch for
 * this exact set either way.
 */
export async function resolveMacosRemoteDesktopResponsibleLauncher(
  artifact: VerifiedMacosRemoteDesktopArtifact,
  options: {
    appPath?: string;
    executeFile?: typeof execFileText;
  } = {},
): Promise<MacosRemoteDesktopResponsibleLauncher | null> {
  try {
    const launch = await verifyResponsibleLaunch(
      options.appPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,
      [artifact.components.launchAgent, artifact.components.worker, artifact.components.disclosure],
      options.executeFile ?? execFileText,
    );
    const executablePath = join(launch.appPath, 'Contents', 'MacOS', MACOS_AIDESK_EXECUTABLE);
    await requireUnlinkedRegularFile(executablePath, 'macos_remote_desktop_responsible_app_unavailable');
    return Object.freeze({
      appPath: launch.appPath,
      executablePath,
      arguments: Object.freeze([...launch.arguments]),
    });
  } catch {
    return null;
  }
}

const SIGNATURE_CHECK_OPTIONS = { timeoutMs: 15_000, maxBufferBytes: 16 * 1024 };

async function verifyApplicationIdentity(
  appPath: string,
  executeFile: typeof execFileText,
): Promise<string> {
  const requestedAppPath = resolve(appPath);
  await requireUnlinkedDirectory(requestedAppPath, 'macos_remote_desktop_responsible_app_unavailable');
  const canonicalAppPath = await realpath(requestedAppPath);
  await executeFile(MACOS_CODESIGN_PATH, [
    '--verify',
    '--deep',
    '--strict',
    `-R=${MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT}`,
    canonicalAppPath,
  ], SIGNATURE_CHECK_OPTIONS).catch(() => {
    throw new Error('macos_remote_desktop_responsible_app_identity_mismatch');
  });
  return canonicalAppPath;
}

function isRootOwnedAndSealed(metadata: { uid: number; mode: number }): boolean {
  return metadata.uid === 0 && (metadata.mode & 0o022) === 0;
}

/**
 * The verified components as they sit in the node's component store: one
 * canonical root-owned directory, nobody else able to write it or any ancestor,
 * each helper root-owned, byte-identical to the verified set and carrying its
 * designated requirement. Returns that directory.
 */
async function verifyStoreHelpers(
  components: readonly VerifiedMacosRemoteDesktopComponent[],
  executeFile: typeof execFileText,
): Promise<string> {
  const first = components[0];
  if (!first) throw new Error('macos_remote_desktop_store_helper_unavailable');
  const directory = await realpath(dirname(resolve(first.executablePath))).catch(() => {
    throw new Error('macos_remote_desktop_store_helper_unavailable');
  });
  for (let cursor = directory; ; cursor = dirname(cursor)) {
    const metadata = await lstat(cursor).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || !isRootOwnedAndSealed(metadata)) {
      throw new Error('macos_remote_desktop_store_directory_unsealed');
    }
    if (cursor === '/') break;
  }
  for (const component of components) {
    const helperPath = join(directory, component.fileName);
    if (resolve(component.executablePath) !== helperPath) {
      throw new Error('macos_remote_desktop_store_helper_outside_directory');
    }
    const metadata = await lstat(helperPath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || !isRootOwnedAndSealed(metadata)) {
      throw new Error('macos_remote_desktop_store_helper_unsealed');
    }
    if (await sha256File(helperPath) !== component.sha256) {
      throw new Error('macos_remote_desktop_store_helper_hash_mismatch');
    }
    await executeFile(MACOS_CODESIGN_PATH, [
      '--verify',
      '--strict',
      `-R=${component.designatedRequirement}`,
      helperPath,
    ], SIGNATURE_CHECK_OPTIONS).catch(() => {
      throw new Error('macos_remote_desktop_store_helper_identity_mismatch');
    });
  }
  return directory;
}

async function verifyApplicationHelpers(
  appPath: string,
  components: readonly VerifiedMacosRemoteDesktopComponent[],
  executeFile: typeof execFileText,
): Promise<string> {
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

  const helperPaths: string[] = [];
  for (const component of components) {
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
    helperPaths.push(helperPath);
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
  for (const [index, component] of components.entries()) {
    await executeFile(MACOS_CODESIGN_PATH, [
      '--verify',
      '--strict',
      `-R=${component.designatedRequirement}`,
      helperPaths[index]!,
    ], signatureOptions).catch(() => {
      throw new Error('macos_remote_desktop_responsible_helper_identity_mismatch');
    });
  }
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
  options: { detached?: boolean } = {},
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
        // Detached launches get no output files: the caller does not read them,
        // and removing them while the helper still holds them open is a race.
        ...(options.detached ? [] : ['-W']),
        '-n',
        '-g',
        ...(options.detached ? [] : ['--stdout', output.stdout, '--stderr', output.stderr]),
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
  const launch = await verifyResponsibleApplication(
    options.appPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,
    options.component,
    executeFile,
  );
  const output = await createCommandOutputPaths(options.user);
  try {
    const invocation = macosRemoteDesktopResponsibleCommandInvocation(
      options.user,
      launch.appPath,
      [...launch.arguments, ...options.args],
      output,
      { detached: options.detached === true },
    );
    await executeFile(invocation.executable, invocation.args, {
      env: invocation.env,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
    });
    if (options.detached) return { stdout: '', stderr: '' };
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
