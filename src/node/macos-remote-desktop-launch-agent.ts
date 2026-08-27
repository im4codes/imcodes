import { constants as fsConstants } from 'node:fs';
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES } from './macos-remote-desktop-session-type.js';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import type { VerifiedMacosRemoteDesktopArtifact } from './macos-remote-desktop-artifact.js';
import type { MacosRemoteDesktopIpcLaunch } from './macos-remote-desktop-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  macosRemoteDesktopUserSessionPaths,
} from './macos-user-session.js';
import {
  assertMacosUserSession,
  resolveMacosUserSession,
  runMacosUserSessionCommand,
  type MacosUserSession,
} from './user-session-launcher.js';

export const MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT = Object.freeze({
  // Which session launchd loaded this agent into, and the kernel audit session
  // it belongs to. Both are needed because the session type alone cannot tell
  // two successive login windows apart.
  sessionType: 'IMCODES_REMOTE_DESKTOP_SESSION_TYPE',
  auditSessionId: 'IMCODES_REMOTE_DESKTOP_AUDIT_SESSION_ID',
  runtimeDirectory: 'IMCODES_REMOTE_DESKTOP_RUNTIME_DIR',
  socketPath: 'IMCODES_REMOTE_DESKTOP_SOCKET',
  label: 'IMCODES_REMOTE_DESKTOP_LAUNCH_AGENT_LABEL',
  workerGeneration: 'IMCODES_REMOTE_DESKTOP_WORKER_GENERATION',
  launchChallenge: 'IMCODES_REMOTE_DESKTOP_LAUNCH_CHALLENGE',
  bundleIdentifier: 'IMCODES_REMOTE_DESKTOP_BUNDLE_IDENTIFIER',
  teamId: 'IMCODES_REMOTE_DESKTOP_TEAM_ID',
} as const);

export const MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR = Object.freeze({
  INVALID_ARTIFACT: 'macos_remote_desktop_launch_agent_invalid_artifact',
  INVALID_LAUNCH: 'macos_remote_desktop_launch_agent_invalid_launch',
  INVALID_PLIST_PATH: 'macos_remote_desktop_launch_agent_invalid_plist_path',
  INVALID_LIFECYCLE_EVENT: 'macos_remote_desktop_launch_agent_invalid_lifecycle_event',
  STALE_GENERATION: 'macos_remote_desktop_launch_agent_stale_generation',
  CALLBACK_MUST_BE_SYNCHRONOUS: 'macos_remote_desktop_launch_agent_callback_must_be_synchronous',
  CRASH_LOOP: 'macos_remote_desktop_launch_agent_crash_loop',
  CLOSED: 'macos_remote_desktop_launch_agent_closed',
} as const);

export const MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS = Object.freeze({
  maxFieldBytes: 4_096,
  defaultMaxCrashRestarts: 3,
  defaultCrashWindowMs: 60_000,
  maxCrashRestarts: 10,
  maxCrashWindowMs: 10 * 60_000,
} as const);

const MACOS_LAUNCHCTL_PATH = '/bin/launchctl';
const LAUNCH_AGENT_FILE_MODE = 0o600;
const LAUNCH_AGENT_DIRECTORY_MODE = 0o700;
const LAUNCH_AGENT_ARGUMENT = '--macos-remote-desktop-launch-agent';
const LAUNCH_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/u;

export type MacosRemoteDesktopLaunchctlOperation = 'bootstrap' | 'kickstart' | 'bootout';

export type MacosRemoteDesktopLifecycleEvent =
  | { type: 'sleep' | 'wake' | 'lock' | 'unlock' | 'logout' | 'fast_user_switch' }
  | { type: 'agent_crash'; workerGeneration: number }
  | { type: 'service_generation'; serviceGeneration: number };

export type MacosRemoteDesktopLifecycleReason =
  | MacosRemoteDesktopLifecycleEvent['type']
  | 'start'
  | 'stop'
  | 'launch_failed';

export interface MacosRemoteDesktopLaunchAgentDefinition {
  user: MacosUserSession;
  label: typeof MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label;
  domainTarget: string;
  serviceTarget: string;
  plistPath: string;
  executablePath: string;
  programArguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  workerGeneration: number;
  challenge: string;
  socketPath: string;
  bundleIdentifier: typeof MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier;
  teamId: string;
  designatedRequirement: string;
  plist: string;
}

export interface MacosRemoteDesktopLifecycleSource {
  subscribe(listener: (event: MacosRemoteDesktopLifecycleEvent) => void): () => void;
}

export interface MacosRemoteDesktopLaunchAgentSupervisorDependencies {
  artifact: VerifiedMacosRemoteDesktopArtifact;
  beginIpcLaunch: () => MacosRemoteDesktopIpcLaunch;
  markAuthorityUnavailable: (reason: MacosRemoteDesktopLifecycleReason) => void;
  releaseInput: (reason: MacosRemoteDesktopLifecycleReason) => void;
  stopCapture: (reason: MacosRemoteDesktopLifecycleReason) => void;
  invalidateRoutes: (reason: MacosRemoteDesktopLifecycleReason) => void;
  resolveUserSession?: () => Promise<MacosUserSession>;
  installPlist?: (
    definition: MacosRemoteDesktopLaunchAgentDefinition,
  ) => Promise<void>;
  runLaunchctl?: (
    operation: MacosRemoteDesktopLaunchctlOperation,
    definition: MacosRemoteDesktopLaunchAgentDefinition,
  ) => Promise<void>;
  lifecycleSource?: MacosRemoteDesktopLifecycleSource;
  onBackgroundError?: (error: unknown) => void;
  now?: () => number;
  maxCrashRestarts?: number;
  crashWindowMs?: number;
}

export interface MacosRemoteDesktopLaunchAgentSnapshot {
  user: MacosUserSession;
  workerGeneration: number;
  serviceTarget: string;
  socketPath: string;
}

interface ActiveLaunch {
  definition: MacosRemoteDesktopLaunchAgentDefinition;
  launched: boolean;
}

function fail(code: string): never {
  throw new Error(code);
}

function isBoundedField(value: string): boolean {
  return value.length > 0
    && !/[\0\r\n]/u.test(value)
    && Buffer.byteLength(value) <= MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.maxFieldBytes;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function xmlEscape(value: string): string {
  if (!isBoundedField(value)) fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LAUNCH);
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistString(value: string, indent: string): string {
  return `${indent}<string>${xmlEscape(value)}</string>`;
}

function plistArray(values: readonly string[], indent: string): string[] {
  return [
    `${indent}<array>`,
    ...values.map((value) => plistString(value, `${indent}  `)),
    `${indent}</array>`,
  ];
}

function plistDictionary(values: Readonly<Record<string, string>>, indent: string): string[] {
  return [
    `${indent}<dict>`,
    ...Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).flatMap(
      ([name, value]) => [
        `${indent}  <key>${xmlEscape(name)}</key>`,
        plistString(value, `${indent}  `),
      ],
    ),
    `${indent}</dict>`,
  ];
}

function buildPlist(
  user: MacosUserSession,
  executablePath: string,
  environment: Readonly<Record<string, string>>,
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    plistString(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label, '  '),
    '  <key>ProgramArguments</key>',
    ...plistArray([executablePath, LAUNCH_AGENT_ARGUMENT], '  '),
    '  <key>EnvironmentVariables</key>',
    ...plistDictionary(environment, '  '),
    '  <key>WorkingDirectory</key>',
    plistString(user.home, '  '),
    '  <key>LimitLoadToSessionType</key>',
    // Aqua AND LoginWindow: without the second entry launchd simply never
    // loads the agent at the login screen, so a headless Mac that reboots is
    // unreachable until somebody physically logs in.
    ...plistArray(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES, '  '),
    '  <key>ProcessType</key>',
    plistString('Interactive', '  '),
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    plistString('/dev/null', '  '),
    '  <key>StandardErrorPath</key>',
    plistString('/dev/null', '  '),
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

function validateArtifact(
  artifact: VerifiedMacosRemoteDesktopArtifact,
): {
  executablePath: string;
  teamId: string;
  designatedRequirement: string;
} {
  const manifest = artifact.manifest;
  // The complete-set authority must be present and well-formed BEFORE it is
  // handed across the launch boundary. Passing a blank through would be worse
  // than not passing one: the native side would reject the launch context and
  // the failure would look like a launch bug rather than a missing release id.
  if (typeof artifact.releaseName !== 'string'
    // 96, not 64: the published release name is `sha256-` + 64 hex = 71
    // characters. A 64-cap silently rejected every real release.
    || !/^[A-Za-z0-9._-]{1,96}$/u.test(artifact.releaseName)
    || !/^[0-9a-f]{64}$/u.test(artifact.setSha256)
    || !/^[0-9a-f]{64}$/u.test(manifest.components.virtualDisplayHelper?.sha256 ?? '')) {
    throw new Error(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
  }
  const launchAgentIdentity = manifest.codeSignature.bundles.launchAgent;
  const launchAgentComponent = artifact.components.launchAgent;
  // Built from the PINNED team, not from the manifest. Deriving the expected
  // requirement from `manifest.codeSignature.teamId` meant the artifact chose
  // the bar it would then be measured against, so a self-consistent foreign
  // team passed. This boundary also accepts an already-typed artifact object,
  // which TypeScript cannot prove came from verification.
  const expectedRequirement = [
    `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}"`,
    'and anchor apple generic',
    `and certificate leaf[subject.OU] = "${REMOTE_DESKTOP_MACOS_TEAM_ID}"`,
  ].join(' ');
  if (manifest.os !== 'darwin'
    || manifest.codeSignature.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || launchAgentIdentity.bundleIdentifier
      !== MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier
    || launchAgentIdentity.designatedRequirement !== expectedRequirement
    || launchAgentComponent.bundleIdentifier !== launchAgentIdentity.bundleIdentifier
    || launchAgentComponent.designatedRequirement !== launchAgentIdentity.designatedRequirement
    || launchAgentComponent.fileName !== manifest.components.launchAgent.fileName
    || launchAgentComponent.sha256 !== manifest.components.launchAgent.sha256
    || launchAgentComponent.size !== manifest.components.launchAgent.size
    || launchAgentComponent.executablePath
      !== join(artifact.artifactDirectory, manifest.components.launchAgent.fileName)
    || !launchAgentComponent.executablePath.startsWith('/')
    || !isBoundedField(launchAgentComponent.executablePath)) {
    fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
  }
  return {
    executablePath: launchAgentComponent.executablePath,
    teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
    designatedRequirement: launchAgentIdentity.designatedRequirement,
  };
}

export function buildMacosRemoteDesktopLaunchAgentDefinition(
  user: MacosUserSession,
  artifact: VerifiedMacosRemoteDesktopArtifact,
  launch: MacosRemoteDesktopIpcLaunch,
): MacosRemoteDesktopLaunchAgentDefinition {
  assertMacosUserSession(user);
  const codeIdentity = validateArtifact(artifact);
  const paths = macosRemoteDesktopUserSessionPaths(user);
  if (!isSafePositiveInteger(launch.workerGeneration)
    || !LAUNCH_CHALLENGE_RE.test(launch.challenge)
    || launch.socketPath !== paths.socketPath) {
    fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LAUNCH);
  }
  const environment = Object.freeze({
    HOME: user.home,
    TMPDIR: user.tempDir,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.runtimeDirectory]: paths.runtimeDirectory,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.socketPath]: paths.socketPath,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.label]:
      MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.workerGeneration]:
      String(launch.workerGeneration),
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.launchChallenge]: launch.challenge,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.bundleIdentifier]:
      MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
    [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.teamId]: codeIdentity.teamId,
  });
  const domainTarget = `gui/${user.uid}`;
  const serviceTarget = `${domainTarget}/${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label}`;
  const programArguments = Object.freeze([codeIdentity.executablePath, LAUNCH_AGENT_ARGUMENT]);
  return Object.freeze({
    user: Object.freeze({ ...user }),
    label: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label,
    domainTarget,
    serviceTarget,
    plistPath: paths.launchAgentPlistPath,
    executablePath: codeIdentity.executablePath,
    programArguments,
    environment,
    workerGeneration: launch.workerGeneration,
    challenge: launch.challenge,
    socketPath: paths.socketPath,
    bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
    teamId: codeIdentity.teamId,
    designatedRequirement: codeIdentity.designatedRequirement,
    plist: buildPlist(user, codeIdentity.executablePath, environment),
  });
}

export function macosRemoteDesktopLaunchctlArgs(
  operation: MacosRemoteDesktopLaunchctlOperation,
  definition: Pick<
    MacosRemoteDesktopLaunchAgentDefinition,
    'domainTarget' | 'serviceTarget' | 'plistPath'
  >,
): readonly string[] {
  if (operation === 'bootstrap') {
    return Object.freeze(['bootstrap', definition.domainTarget, definition.plistPath]);
  }
  if (operation === 'kickstart') {
    return Object.freeze(['kickstart', '-k', definition.serviceTarget]);
  }
  return Object.freeze(['bootout', definition.serviceTarget]);
}

async function defaultRunLaunchctl(
  operation: MacosRemoteDesktopLaunchctlOperation,
  definition: MacosRemoteDesktopLaunchAgentDefinition,
): Promise<void> {
  await runMacosUserSessionCommand(definition.user, {
    executable: MACOS_LAUNCHCTL_PATH,
    args: macosRemoteDesktopLaunchctlArgs(operation, definition),
  });
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_PLIST_PATH);
  }
}

async function defaultInstallPlist(
  definition: MacosRemoteDesktopLaunchAgentDefinition,
): Promise<void> {
  const launchAgentsDirectory = dirname(definition.plistPath);
  const libraryDirectory = dirname(launchAgentsDirectory);
  if (dirname(libraryDirectory) !== definition.user.home) {
    fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_PLIST_PATH);
  }
  await assertDirectory(definition.user.home);
  await mkdir(libraryDirectory, { recursive: false, mode: LAUNCH_AGENT_DIRECTORY_MODE })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  await assertDirectory(libraryDirectory);
  await mkdir(launchAgentsDirectory, { recursive: false, mode: LAUNCH_AGENT_DIRECTORY_MODE })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  await assertDirectory(launchAgentsDirectory);
  await chmod(launchAgentsDirectory, LAUNCH_AGENT_DIRECTORY_MODE);
  await chown(launchAgentsDirectory, definition.user.uid, definition.user.gid);

  try {
    const existing = await lstat(definition.plistPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_PLIST_PATH);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${definition.plistPath}.tmp-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    LAUNCH_AGENT_FILE_MODE,
  );
  try {
    await handle.writeFile(definition.plist, 'utf8');
    await handle.chown(definition.user.uid, definition.user.gid);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, definition.plistPath);
    await chmod(definition.plistPath, LAUNCH_AGENT_FILE_MODE);
    await chown(definition.plistPath, definition.user.uid, definition.user.gid);
    const directoryHandle = await open(launchAgentsDirectory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function validateLifecycleEvent(event: MacosRemoteDesktopLifecycleEvent): void {
  if (event.type === 'agent_crash') {
    if (Object.keys(event).length !== 2 || !isSafePositiveInteger(event.workerGeneration)) {
      fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LIFECYCLE_EVENT);
    }
    return;
  }
  if (event.type === 'service_generation') {
    if (Object.keys(event).length !== 2 || !isSafePositiveInteger(event.serviceGeneration)) {
      fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LIFECYCLE_EVENT);
    }
    return;
  }
  if (Object.keys(event).length !== 1 || ![
    'sleep', 'wake', 'lock', 'unlock', 'logout', 'fast_user_switch',
  ].includes(event.type)) {
    fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LIFECYCLE_EVENT);
  }
}

function ensureSynchronousCallback(
  callback: (reason: MacosRemoteDesktopLifecycleReason) => void,
  reason: MacosRemoteDesktopLifecycleReason,
): unknown {
  const result = callback(reason) as unknown;
  if (result !== null && typeof result === 'object'
    && typeof (result as { then?: unknown }).then === 'function') {
    return new Error(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.CALLBACK_MUST_BE_SYNCHRONOUS);
  }
  return null;
}

export class MacosRemoteDesktopLaunchAgentSupervisor {
  private readonly resolveUserSession: () => Promise<MacosUserSession>;
  private readonly installPlist: (
    definition: MacosRemoteDesktopLaunchAgentDefinition,
  ) => Promise<void>;
  private readonly runLaunchctl: (
    operation: MacosRemoteDesktopLaunchctlOperation,
    definition: MacosRemoteDesktopLaunchAgentDefinition,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly maxCrashRestarts: number;
  private readonly crashWindowMs: number;
  private active: ActiveLaunch | null = null;
  private lastCleanedWorkerGeneration: number | null = null;
  private lastWorkerGeneration = 0;
  private serviceGeneration = 0;
  private transitionEpoch = 0;
  private transition = Promise.resolve();
  private crashTimes: number[] = [];
  private suspended = false;
  private locked = false;
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies) {
    validateArtifact(dependencies.artifact);
    this.resolveUserSession = dependencies.resolveUserSession ?? (() => resolveMacosUserSession());
    this.installPlist = dependencies.installPlist ?? defaultInstallPlist;
    this.runLaunchctl = dependencies.runLaunchctl ?? defaultRunLaunchctl;
    this.now = dependencies.now ?? Date.now;
    this.maxCrashRestarts = dependencies.maxCrashRestarts
      ?? MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.defaultMaxCrashRestarts;
    this.crashWindowMs = dependencies.crashWindowMs
      ?? MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.defaultCrashWindowMs;
    if (!Number.isInteger(this.maxCrashRestarts)
      || this.maxCrashRestarts < 0
      || this.maxCrashRestarts > MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.maxCrashRestarts
      || !Number.isInteger(this.crashWindowMs)
      || this.crashWindowMs <= 0
      || this.crashWindowMs > MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.maxCrashWindowMs) {
      fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_LAUNCH);
    }
  }

  snapshot(): MacosRemoteDesktopLaunchAgentSnapshot | null {
    const active = this.active;
    if (!active?.launched) return null;
    return Object.freeze({
      user: Object.freeze({ ...active.definition.user }),
      workerGeneration: active.definition.workerGeneration,
      serviceTarget: active.definition.serviceTarget,
      socketPath: active.definition.socketPath,
    });
  }

  start(): Promise<MacosRemoteDesktopLaunchAgentSnapshot> {
    this.assertOpen();
    if (this.unsubscribe === null && this.dependencies.lifecycleSource) {
      this.unsubscribe = this.dependencies.lifecycleSource.subscribe((event) => {
        void this.handleLifecycleEvent(event).catch((error) => {
          this.dependencies.onBackgroundError?.(error);
        });
      });
    }
    const epoch = ++this.transitionEpoch;
    const cleanupError = this.synchronouslyInvalidate('start', true);
    return this.enqueue(async () => {
      if (cleanupError) throw cleanupError;
      const snapshot = await this.launchFreshGeneration(epoch);
      if (!snapshot) fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.STALE_GENERATION);
      return snapshot;
    });
  }

  handleLifecycleEvent(event: MacosRemoteDesktopLifecycleEvent): Promise<void> {
    this.assertOpen();
    validateLifecycleEvent(event);
    if (event.type === 'agent_crash') {
      const activeGeneration = this.active?.definition.workerGeneration;
      if (event.workerGeneration !== activeGeneration) return Promise.resolve();
    }
    if (event.type === 'service_generation') {
      if (event.serviceGeneration <= this.serviceGeneration) return Promise.resolve();
      this.serviceGeneration = event.serviceGeneration;
    }

    const previous = this.active;
    const epoch = ++this.transitionEpoch;
    const cleanupError = this.synchronouslyInvalidate(event.type, previous !== null);
    this.updateLifecycleState(event);
    const relaunch = this.shouldRelaunch(event);
    const crashLoop = event.type === 'agent_crash' && !this.allowCrashRestart();

    return this.enqueue(async () => {
      if (previous) await this.bootoutIgnoringMissing(previous.definition);
      if (cleanupError) throw cleanupError;
      if (crashLoop) fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.CRASH_LOOP);
      if (relaunch && epoch === this.transitionEpoch) {
        await this.launchFreshGeneration(epoch);
      }
    });
  }

  stop(): Promise<void> {
    if (this.closed) return this.transition;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const previous = this.active;
    ++this.transitionEpoch;
    const cleanupError = this.synchronouslyInvalidate('stop', previous !== null);
    return this.enqueue(async () => {
      if (previous) await this.bootoutIgnoringMissing(previous.definition);
      if (cleanupError) throw cleanupError;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }

  private async launchFreshGeneration(
    epoch: number,
  ): Promise<MacosRemoteDesktopLaunchAgentSnapshot | null> {
    const user = await this.resolveUserSession();
    assertMacosUserSession(user);
    if (epoch !== this.transitionEpoch || this.closed || this.suspended || this.locked) return null;

    const launch = this.dependencies.beginIpcLaunch();
    if (launch.workerGeneration <= this.lastWorkerGeneration) {
      fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.STALE_GENERATION);
    }
    this.lastWorkerGeneration = launch.workerGeneration;
    const definition = buildMacosRemoteDesktopLaunchAgentDefinition(
      user,
      this.dependencies.artifact,
      launch,
    );
    const active: ActiveLaunch = { definition, launched: false };
    this.active = active;
    try {
      await this.bootoutIgnoringMissing(definition);
      if (epoch !== this.transitionEpoch || this.active !== active) return null;
      await this.installPlist(definition);
      if (epoch !== this.transitionEpoch || this.active !== active) return null;
      await this.runLaunchctl('bootstrap', definition);
      if (epoch !== this.transitionEpoch || this.active !== active) return null;
      await this.runLaunchctl('kickstart', definition);
      if (epoch !== this.transitionEpoch || this.active !== active) return null;
      active.launched = true;
      return this.snapshot();
    } catch (error) {
      if (this.active === active) {
        const cleanupError = this.synchronouslyInvalidate('launch_failed', true);
        await this.bootoutIgnoringMissing(definition);
        if (cleanupError) throw cleanupError;
      }
      throw error;
    }
  }

  private synchronouslyInvalidate(
    reason: MacosRemoteDesktopLifecycleReason,
    forceUnavailable: boolean,
  ): unknown {
    const activeGeneration = this.active?.definition.workerGeneration ?? null;
    if (activeGeneration !== null && activeGeneration === this.lastCleanedWorkerGeneration) {
      this.active = null;
      return null;
    }
    if (activeGeneration === null && !forceUnavailable) return null;

    this.active = null;
    if (activeGeneration !== null) this.lastCleanedWorkerGeneration = activeGeneration;
    let firstError: unknown = null;
    for (const callback of [
      this.dependencies.markAuthorityUnavailable,
      this.dependencies.releaseInput,
      this.dependencies.stopCapture,
      this.dependencies.invalidateRoutes,
    ]) {
      try {
        firstError ??= ensureSynchronousCallback(callback, reason);
      } catch (error) {
        firstError ??= error;
      }
    }
    return firstError;
  }

  private updateLifecycleState(event: MacosRemoteDesktopLifecycleEvent): void {
    if (event.type === 'sleep') this.suspended = true;
    if (event.type === 'wake') this.suspended = false;
    if (event.type === 'lock') this.locked = true;
    if (event.type === 'unlock') this.locked = false;
    if (event.type === 'logout' || event.type === 'fast_user_switch') {
      this.suspended = false;
      this.locked = false;
    }
  }

  private shouldRelaunch(event: MacosRemoteDesktopLifecycleEvent): boolean {
    if (this.suspended || this.locked) return false;
    return event.type === 'wake'
      || event.type === 'unlock'
      || event.type === 'fast_user_switch'
      || event.type === 'agent_crash'
      || event.type === 'service_generation';
  }

  private allowCrashRestart(): boolean {
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((time) => now - time <= this.crashWindowMs);
    this.crashTimes.push(now);
    return this.crashTimes.length <= this.maxCrashRestarts;
  }

  private async bootoutIgnoringMissing(
    definition: MacosRemoteDesktopLaunchAgentDefinition,
  ): Promise<void> {
    try {
      await this.runLaunchctl('bootout', definition);
    } catch {
      // A missing or already-dead service is the desired state before bootstrap.
    }
  }

  private assertOpen(): void {
    if (this.closed) fail(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.CLOSED);
  }
}
