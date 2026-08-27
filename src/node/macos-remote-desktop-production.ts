import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  assertMacosRemoteDesktopStoreTrusted,
  selectMacosRemoteDesktopArtifact,
  type VerifiedMacosRemoteDesktopArtifact,
} from './macos-remote-desktop-artifact.js';
import type {
  MacosRemoteDesktopHostCleanupReason,
  MacosRemoteDesktopHostCleanupOutcome,
  MacosRemoteDesktopHostCleanupRequest,
  MacosRemoteDesktopWorkerHostOptions,
} from './macos-remote-desktop-worker-host.js';
import { defaultCredentialPath } from './enrollment.js';
import {
  MACOS_LAUNCHCTL_PATH,
  macosUserSessionLaunchctlArgs,
  resolveMacosUserSession,
  type MacosUserSession,
} from './user-session-launcher.js';
import {
  startMacosVirtualDisplayAuthorityHost,
} from './macos-virtual-display-authority-host.js';
import { randomBytes } from 'node:crypto';

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024;

/**
 * Generation flag understood by the native command entry point
 * (`kGenerationArgument` in macos_native_command_v1.cc). Sending no generation
 * means "whatever is live", which is exactly what a stale cleanup must not do.
 */
export const MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT = '--generation' as const;

export const MACOS_REMOTE_DESKTOP_NATIVE_COMMAND = Object.freeze({
  readiness: '--imcodes-readiness-v1',
  requestPermissions: '--imcodes-request-permissions-v1',
  releaseInput: '--imcodes-release-input-v1',
  stopCapture: '--imcodes-stop-capture-v1',
} as const);

export const MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION = 1;

export const MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE = Object.freeze({
  ACTIVE_UNLOCKED: 'active_unlocked',
  LOCKED: 'locked',
  SLEEPING: 'sleeping',
  INACTIVE: 'inactive',
} as const);

type MacosRemoteDesktopNativeSessionState = typeof MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE[
  keyof typeof MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE
];

export interface MacosRemoteDesktopNativeReadinessSnapshot {
  version: typeof MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION;
  activeAquaUserUids: readonly number[];
  sessionState: MacosRemoteDesktopNativeSessionState;
  screenRecording: boolean;
  encoder: boolean;
  accessibility: boolean;
  clipboard: boolean;
  disclosure: boolean;
  lifecycleObservation: boolean;
  releaseInput: boolean;
  stopCapture: boolean;
  virtualDisplay: boolean;
}

type NativeReadiness = Awaited<ReturnType<
  MacosRemoteDesktopWorkerHostOptions['inspectReadiness']
>>;

export type MacosRemoteDesktopNativeCommandExecutor = (
  user: MacosUserSession,
  executablePath: string,
  args: readonly string[],
) => Promise<string>;

export type MacosRemoteDesktopNativeCleanupLauncher = (
  user: MacosUserSession,
  executablePath: string,
  args: readonly string[],
) => ChildProcess | void;

export interface MacosRemoteDesktopProductionDependencies {
  platform?: NodeJS.Platform;
  arch?: string;
  storeRoot?: string;
  selectArtifact?: typeof selectMacosRemoteDesktopArtifact;
  resolveUserSession?: typeof resolveMacosUserSession;
  executeNativeCommand?: MacosRemoteDesktopNativeCommandExecutor;
  launchNativeCleanup?: MacosRemoteDesktopNativeCleanupLauncher;
  onBackgroundError?: (error: unknown) => void;
}

export interface MacosRemoteDesktopNativeCommandInvocation {
  executable: typeof MACOS_LAUNCHCTL_PATH;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

const UNAVAILABLE_READINESS: NativeReadiness = Object.freeze({
  screenRecording: false,
  encoder: false,
  accessibility: false,
  clipboard: false,
  disclosure: false,
});

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function safeUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Parse the active-user native readiness contract without requesting TCC or
 * inferring state from the operating system. Unknown versions, fields or
 * values fail closed so a newer native worker cannot accidentally widen an
 * older daemon's advertisement.
 */
export function parseMacosRemoteDesktopNativeReadiness(
  encoded: string,
): MacosRemoteDesktopNativeReadinessSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'version',
    'activeAquaUserUids',
    'sessionState',
    'screenRecording',
    'encoder',
    'accessibility',
    'clipboard',
    'disclosure',
    'lifecycleObservation',
    'releaseInput',
    'stopCapture',
    'virtualDisplay',
  ])
    || record.version !== MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION
    || !Array.isArray(record.activeAquaUserUids)
    || record.activeAquaUserUids.some((uid) => !safeUid(uid))
    || new Set(record.activeAquaUserUids).size !== record.activeAquaUserUids.length
    || !Object.values(MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE).includes(
      record.sessionState as MacosRemoteDesktopNativeSessionState,
    )
    || [
      record.screenRecording,
      record.encoder,
      record.accessibility,
      record.clipboard,
      record.disclosure,
      record.lifecycleObservation,
      record.releaseInput,
      record.stopCapture,
      record.virtualDisplay,
    ].some((field) => typeof field !== 'boolean')) {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  return Object.freeze({
    version: MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
    activeAquaUserUids: Object.freeze([...(record.activeAquaUserUids as number[])]),
    sessionState: record.sessionState as MacosRemoteDesktopNativeSessionState,
    screenRecording: record.screenRecording as boolean,
    encoder: record.encoder as boolean,
    accessibility: record.accessibility as boolean,
    clipboard: record.clipboard as boolean,
    disclosure: record.disclosure as boolean,
    lifecycleObservation: record.lifecycleObservation as boolean,
    releaseInput: record.releaseInput as boolean,
    stopCapture: record.stopCapture as boolean,
    virtualDisplay: record.virtualDisplay as boolean,
  });
}

export function defaultMacosRemoteDesktopArtifactStoreRoot(arch: 'arm64' | 'x64'): string {
  return join(
    dirname(defaultCredentialPath('darwin')),
    'remote-desktop-worker',
    `darwin-${arch}`,
  );
}

export function macosRemoteDesktopNativeCommandInvocation(
  user: MacosUserSession,
  executablePath: string,
  args: readonly string[],
): MacosRemoteDesktopNativeCommandInvocation {
  return Object.freeze({
    executable: MACOS_LAUNCHCTL_PATH,
    args: Object.freeze(macosUserSessionLaunchctlArgs(user, {
      executable: executablePath,
      args,
    })),
    env: Object.freeze({}),
  });
}

function defaultExecuteNativeCommand(
  user: MacosUserSession,
  executablePath: string,
  args: readonly string[],
): Promise<string> {
  const invocation = macosRemoteDesktopNativeCommandInvocation(user, executablePath, args);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      // The active-user command gets only HOME/TMPDIR from the explicit
      // launchctl argv. Daemon credentials and ambient service secrets cannot
      // cross this process boundary through the environment.
      env: invocation.env,
    }, (error, stdout) => {
      if (error) {
        reject(new Error('macos_remote_desktop_native_command_failed'));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function defaultLaunchNativeCleanup(
  user: MacosUserSession,
  executablePath: string,
  args: readonly string[],
): ChildProcess {
  const invocation = macosRemoteDesktopNativeCommandInvocation(user, executablePath, args);
  const child = spawn(
    invocation.executable,
    invocation.args,
    {
      detached: true,
      stdio: 'ignore',
      env: invocation.env,
    },
  );
  child.unref();
  return child;
}

async function selectVerifiedCurrentOrLastKnownGood(
  storeRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  selectArtifact: typeof selectMacosRemoteDesktopArtifact,
  onBackgroundError?: (error: unknown) => void,
): Promise<VerifiedMacosRemoteDesktopArtifact | null> {
  const dependencies = { runtime: { platform, arch } } as const;
  try {
    const current = await selectArtifact(storeRoot, 'current', dependencies);
    if (current) return current;
  } catch (error) {
    onBackgroundError?.(error);
  }
  try {
    return await selectArtifact(storeRoot, 'lastKnownGood', dependencies);
  } catch (error) {
    onBackgroundError?.(error);
    return null;
  }
}

function verifiedReadiness(
  snapshot: MacosRemoteDesktopNativeReadinessSnapshot,
  user: MacosUserSession,
): NativeReadiness {
  if (snapshot.activeAquaUserUids.length !== 1
    || snapshot.activeAquaUserUids[0] !== user.uid
    || snapshot.sessionState !== MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.ACTIVE_UNLOCKED
    || !snapshot.lifecycleObservation
    || !snapshot.releaseInput
    || !snapshot.stopCapture) {
    return UNAVAILABLE_READINESS;
  }
  return Object.freeze({
    screenRecording: snapshot.screenRecording,
    encoder: snapshot.encoder,
    accessibility: snapshot.accessibility,
    clipboard: snapshot.clipboard,
    disclosure: snapshot.disclosure,
    virtualDisplay: snapshot.virtualDisplay,
  });
}

/**
 * Construct the stock controlled-node macOS adapter dependencies. The factory
 * performs no IO and returns no adapter on unsupported targets. Artifact,
 * active-Aqua-user and native readiness evidence are resolved only when the
 * platform host starts.
 *
 * The currently shipped native entry point does not yet implement the three
 * machine-readable commands above. That is intentional: command failure maps
 * to an unavailable profile, so wiring this factory cannot advertise guessed
 * TCC, encoder, disclosure, lifecycle or cleanup readiness.
 */
export function createMacosRemoteDesktopProductionDependencies(
  dependencies: MacosRemoteDesktopProductionDependencies = {},
): MacosRemoteDesktopWorkerHostOptions | undefined {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) return undefined;

  const storeRoot = dependencies.storeRoot ?? defaultMacosRemoteDesktopArtifactStoreRoot(arch);
  const selectArtifact = dependencies.selectArtifact ?? selectMacosRemoteDesktopArtifact;
  const resolveUser = dependencies.resolveUserSession ?? resolveMacosUserSession;
  const executeNativeCommand = dependencies.executeNativeCommand ?? defaultExecuteNativeCommand;
  const launchNativeCleanup = dependencies.launchNativeCleanup ?? defaultLaunchNativeCleanup;
  let activeArtifact: VerifiedMacosRemoteDesktopArtifact | null = null;
  let activeUser: MacosUserSession | null = null;

  /**
   * Run one cleanup command against an EXACT worker generation and resolve on
   * the child's real exit status.
   *
   * Spawn acceptance is not completion: the previous version returned as soon
   * as the process was created, so teardown could stop the LaunchAgent and
   * unlink its control socket before the command had connected. It also sent no
   * generation at all, which the native side reads as "whatever is live" -- a
   * delayed cleanup for generation N could then act on N+1.
   */
  const launchCleanup = async (
    command: string,
    workerGeneration: number,
  ): Promise<MacosRemoteDesktopHostCleanupOutcome> => {
    const artifact = activeArtifact;
    const user = activeUser;
    if (!artifact || !user) {
      return { ok: false, error: new Error('macos_remote_desktop_cleanup_no_active_artifact') };
    }
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration <= 0) {
      return { ok: false, error: new Error('macos_remote_desktop_cleanup_invalid_generation') };
    }
    try {
      const child = launchNativeCleanup(
        user,
        artifact.components.launchAgent.executablePath,
        [command, MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT, String(workerGeneration)],
      );
      if (!child) {
        return { ok: false, error: new Error('macos_remote_desktop_cleanup_not_launched') };
      }
      return await new Promise<MacosRemoteDesktopHostCleanupOutcome>((resolve) => {
        let done = false;
        const settle = (outcome: MacosRemoteDesktopHostCleanupOutcome) => {
          if (done) return;
          done = true;
          resolve(outcome);
        };
        child.once('error', (error) => {
          dependencies.onBackgroundError?.(error);
          settle({ ok: false, error });
        });
        child.once('exit', (code, signal) => {
          if (code === 0) {
            settle({ ok: true });
            return;
          }
          settle({
            ok: false,
            error: new Error(
              `macos_remote_desktop_cleanup_exit:${command}:${String(code ?? signal)}`,
            ),
          });
        });
      });
    } catch (error) {
      dependencies.onBackgroundError?.(error);
      return { ok: false, error };
    }
  };

  // Monotonic across this daemon process. It rotates whenever a new resident
  // agent is admitted, which is what lets an agent refuse a grant minted for a
  // previous incarnation of itself.
  let serviceGeneration = 0;

  return {
    runtime: { platform, arch },
    /**
     * The stock virtual-display authority.
     *
     * Without this the default runtime supplied no factory at all, so the host
     * held no lease and every display request answered `agent_unavailable` --
     * the whole chain type-checked and was dead.
     *
     * Everything it needs comes from the host's own context: the SAME verified
     * artifact this generation launched from, the Aqua user it runs as, and
     * the SAME identity verifier the IPC server admits the worker with. None
     * of it is re-derived here, so there is no second source that could drift.
     */
    async startVirtualDisplayAuthority(context, hooks) {
      // No agent verifier means nothing could check who dialled the
      // rendezvous. Refused rather than started open.
      if (!context.verification) return null;
      try {
        return await startMacosVirtualDisplayAuthorityHost({
          artifact: context.artifact,
          verification: context.verification,
          nextServiceGeneration: () => {
            serviceGeneration += 1;
            return serviceGeneration;
          },
          // 43 base64url characters, matching the launch-challenge grammar the
          // native grant parser accepts.
          mintChallenge: () => randomBytes(32).toString('base64url'),
          onAuthorityLost: hooks.onAuthorityLost,
          onBackgroundError: dependencies.onBackgroundError,
        });
      } catch (error) {
        dependencies.onBackgroundError?.(error);
        return null;
      }
    },
    async resolveVerifiedArtifact(): Promise<VerifiedMacosRemoteDesktopArtifact | null> {
      activeArtifact = await selectVerifiedCurrentOrLastKnownGood(
        storeRoot,
        platform,
        arch,
        selectArtifact,
        dependencies.onBackgroundError,
      );
      return activeArtifact;
    },
    async resolveUserSession(): Promise<MacosUserSession> {
      activeUser = await resolveUser();
      return activeUser;
    },
    async inspectReadiness(
      artifact: VerifiedMacosRemoteDesktopArtifact,
      user: MacosUserSession,
    ): Promise<NativeReadiness> {
      if (artifact !== activeArtifact || user !== activeUser) return UNAVAILABLE_READINESS;
      try {
        // Nearest boundary to the exec. Selection already validated the store,
        // but the path it returned is only as trustworthy as the store at the
        // moment it is USED -- and readiness is the last thing that happens
        // before this executable is run for real.
        await assertMacosRemoteDesktopStoreTrusted(storeRoot, artifact.releaseName, {
          runtime: { platform, arch },
        });
        const encoded = await executeNativeCommand(
          user,
          artifact.components.launchAgent.executablePath,
          [MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness],
        );
        return verifiedReadiness(parseMacosRemoteDesktopNativeReadiness(encoded), user);
      } catch (error) {
        dependencies.onBackgroundError?.(error);
        return UNAVAILABLE_READINESS;
      }
    },
    releaseInput(
      request: MacosRemoteDesktopHostCleanupRequest,
    ): Promise<MacosRemoteDesktopHostCleanupOutcome> {
      return launchCleanup(
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput,
        request.workerGeneration,
      );
    },
    stopCapture(
      request: MacosRemoteDesktopHostCleanupRequest,
    ): Promise<MacosRemoteDesktopHostCleanupOutcome> {
      return launchCleanup(
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture,
        request.workerGeneration,
      );
    },
    onBackgroundError: dependencies.onBackgroundError,
  };
}
