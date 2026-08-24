import {
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  isRemoteDesktopShellLaunchContextCurrent,
  validateRemoteDesktopShellLaunchContext,
  type RemoteDesktopSignedShellRecoveryReason,
  type RemoteDesktopShellLaunchContext,
} from '../../shared/remote-desktop-access.js';

export const REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG = '--remote-desktop-signed-shell';
export const REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG = '--server-origin';
export const REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG = '--launch-context-b64';
export const REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG = '--bootstrap-host-id';
export const REMOTE_DESKTOP_SIGNED_SHELL_TERMINATE_ARG = '--terminate-remote-desktop-signed-shell';

export type { RemoteDesktopSignedShellRecoveryReason } from '../../shared/remote-desktop-access.js';

export type RemoteDesktopClipboardCleanupReason = Extract<RemoteDesktopSignedShellRecoveryReason,
  | 'clipboard_watchdog_failed'
  | 'clipboard_watchdog_crashed'
  | 'clipboard_cleanup_uncertain'
>;

export interface RemoteDesktopSignedShellExpectedContext {
  hostId: string;
  endpointGeneration: number;
}

export interface RemoteDesktopSignedShellLaunchCommand {
  executable: string;
  args: readonly string[];
  serverOrigin: string;
  /** Null for the logged-out, non-authorizing bootstrap surface. */
  context: RemoteDesktopShellLaunchContext | null;
  hostId: string;
}

export interface RemoteDesktopSignedShellLauncher {
  launch(command: RemoteDesktopSignedShellLaunchCommand): Promise<void> | void;
  terminate?(launchId: string): Promise<void> | void;
}

export interface RemoteDesktopSignedShellControllerDeps {
  executablePath: string;
  /** Public API origin only. It is not authority and may carry no credentials. */
  serverOrigin: string;
  launcher: RemoteDesktopSignedShellLauncher;
  expectedContext(): RemoteDesktopSignedShellExpectedContext | null;
  now?: () => number;
  onRecoveryRequired?: (reason: RemoteDesktopSignedShellRecoveryReason) => void;
  replayTombstoneLimit?: number;
}

export interface RemoteDesktopSignedShellLaunchResult {
  ok: true;
  launchId: string;
}

export type RemoteDesktopSignedShellStartResult =
  | RemoteDesktopSignedShellLaunchResult
  | { ok: false; reason: RemoteDesktopSignedShellRecoveryReason };

const DEFAULT_REPLAY_TOMBSTONE_LIMIT = 256;

function contextArg(context: RemoteDesktopShellLaunchContext): string {
  return Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
}

export function normalizeRemoteDesktopSignedShellServerOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:'
      || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isSafeInviteClipboardCopy(value: unknown): value is { kind: 'invite_link'; epochId: string; launchId: string; textHash: string; deadlineAt: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(',') === 'deadlineAt,epochId,kind,launchId,textHash'
    && candidate.kind === 'invite_link'
    && typeof candidate.epochId === 'string' && candidate.epochId.length > 0
    && typeof candidate.launchId === 'string' && candidate.launchId.length > 0
    && typeof candidate.textHash === 'string' && /^[a-f0-9]{64}$/.test(candidate.textHash)
    && typeof candidate.deadlineAt === 'number'
    && Number.isSafeInteger(candidate.deadlineAt);
}

/**
 * Node-side signed shell seam.
 *
 * This deliberately does not grant management authority and does not advertise
 * the signed-shell adapter capability. It only consumes an already-issued
 * launch context, starts a separately signed local shell process with that
 * non-secret context, and maps uncertain cleanup/lifecycle failures to a
 * privacy recovery signal for the Server-owned epoch machinery.
 */
export class RemoteDesktopSignedShellController {
  private readonly consumedLaunchIds = new Map<string, number>();
  private activeLaunchId: string | null = null;
  private recoveryRequired = false;

  constructor(private readonly deps: RemoteDesktopSignedShellControllerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  recoveryPending(): boolean {
    return this.recoveryRequired;
  }

  activeLaunch(): string | null {
    return this.activeLaunchId;
  }

  /**
   * Start the logged-out shell once the authenticated node channel has supplied
   * the canonical host.  This launch carries no account session, launch proof,
   * privacy epoch or guest material; it may only sign in and request the real
   * one-use context from the Server.
   */
  async startBootstrap(): Promise<RemoteDesktopSignedShellStartResult> {
    const expected = this.deps.expectedContext();
    const serverOrigin = normalizeRemoteDesktopSignedShellServerOrigin(this.deps.serverOrigin);
    if (!expected || !serverOrigin) return this.recover('shell_launch_failed');
    const args = [
      REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
      REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
      serverOrigin,
      REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG,
      expected.hostId,
    ];
    try {
      await this.deps.launcher.launch({
        executable: this.deps.executablePath,
        args,
        serverOrigin,
        context: null,
        hostId: expected.hostId,
      });
    } catch {
      return this.recover('shell_launch_failed');
    }
    this.recoveryRequired = false;
    return { ok: true, launchId: '' };
  }

  private recover(reason: RemoteDesktopSignedShellRecoveryReason): { ok: false; reason: RemoteDesktopSignedShellRecoveryReason } {
    this.recoveryRequired = true;
    try { this.deps.onRecoveryRequired?.(reason); } catch { /* diagnostics must not change fail-closed state */ }
    return { ok: false, reason };
  }

  private replayTombstoneLimit(): number {
    const limit = this.deps.replayTombstoneLimit ?? DEFAULT_REPLAY_TOMBSTONE_LIMIT;
    return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_REPLAY_TOMBSTONE_LIMIT;
  }

  private pruneReplayTombstones(now = this.now()): void {
    for (const [launchId, expiresAt] of this.consumedLaunchIds) {
      if (expiresAt <= now) this.consumedLaunchIds.delete(launchId);
    }
    const limit = this.replayTombstoneLimit();
    while (this.consumedLaunchIds.size > limit) {
      const oldest = this.consumedLaunchIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.consumedLaunchIds.delete(oldest);
    }
  }

  replayTombstoneCount(): number {
    this.pruneReplayTombstones();
    return this.consumedLaunchIds.size;
  }

  consumeLaunchContext(raw: unknown): RemoteDesktopShellLaunchContext | null {
    const parsed = validateRemoteDesktopShellLaunchContext(raw);
    if (!parsed.ok) return null;
    const now = this.now();
    this.pruneReplayTombstones(now);
    const expected = this.deps.expectedContext();
    if (!expected || !isRemoteDesktopShellLaunchContextCurrent(parsed.value, expected, now)) return null;
    if (this.consumedLaunchIds.has(parsed.value.launchId)) return null;
    return parsed.value;
  }

  async start(raw: unknown): Promise<RemoteDesktopSignedShellStartResult> {
    const parsed = validateRemoteDesktopShellLaunchContext(raw);
    if (!parsed.ok) return this.recover('launch_context_invalid');
    const now = this.now();
    this.pruneReplayTombstones(now);
    const expected = this.deps.expectedContext();
    if (!expected || !isRemoteDesktopShellLaunchContextCurrent(parsed.value, expected, now)) {
      return this.recover('launch_context_stale');
    }
    if (this.consumedLaunchIds.has(parsed.value.launchId)) return this.recover('launch_context_replay');

    const serverOrigin = normalizeRemoteDesktopSignedShellServerOrigin(this.deps.serverOrigin);
    if (!serverOrigin) return this.recover('shell_launch_failed');
    this.consumedLaunchIds.set(parsed.value.launchId, parsed.value.expiresAt);
    this.pruneReplayTombstones(now);
    const args = [
      REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
      REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
      serverOrigin,
      REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG,
      contextArg(parsed.value),
    ];
    try {
      await this.deps.launcher.launch({
        executable: this.deps.executablePath,
        args,
        serverOrigin,
        context: parsed.value,
        hostId: parsed.value.hostId,
      });
    } catch {
      return this.recover('shell_launch_failed');
    }
    this.activeLaunchId = parsed.value.launchId;
    this.recoveryRequired = false;
    return { ok: true, launchId: parsed.value.launchId };
  }

  async terminate(): Promise<void> {
    const launchId = this.activeLaunchId;
    this.activeLaunchId = null;
    if (!launchId) return;
    await this.deps.launcher.terminate?.(launchId);
  }

  markShellCrashed(): void {
    if (this.activeLaunchId) void this.recover('shell_crashed');
  }

  markLogoutUncertain(): void {
    if (this.activeLaunchId) void this.recover('shell_logout');
  }

  validateInviteClipboardCopyRequest(value: unknown): boolean {
    if (!isSafeInviteClipboardCopy(value)) return false;
    if (value.launchId !== this.activeLaunchId) return false;
    if (value.deadlineAt - this.now() > REMOTE_DESKTOP_PRIVACY_LIMITS.CLIPBOARD_CLEANUP_MS) return false;
    return value.deadlineAt > this.now();
  }

  markClipboardCleanupUncertain(reason: RemoteDesktopClipboardCleanupReason): void {
    if (this.activeLaunchId) void this.recover(reason);
  }
}
