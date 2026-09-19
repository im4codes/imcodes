import { timingSafeEqual } from 'node:crypto';
import {
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonMessage,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  parseWorkerConsentFrame,
  type WorkerConsentInboundFrame,
} from './remote-desktop-consent-ipc.js';
import {
  WORKER_PRIVACY_FRAME,
  parseWorkerPrivacyFrame,
  type WorkerPrivacyInboundFrame,
} from './remote-desktop-privacy-ipc.js';
import {
  validateRemoteDesktopWorkerCrash,
  type RemoteDesktopWorkerCrash,
} from '../../shared/remote-desktop-worker.js';

const DEFAULT_PREPARE_READY_TIMEOUT_MS = 15_000;
const DEFAULT_OFFER_ANSWER_TIMEOUT_MS = 15_000;
export const REMOTE_DESKTOP_WORKER_MAX_LINE_BYTES = 512 * 1024;

export const REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE = {
  PREPARE_READY: 'prepare_ready',
  OFFER_ANSWER: 'offer_answer',
} as const;

export type RemoteDesktopWorkerWatchdogStage =
  typeof REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE[
    keyof typeof REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE
  ];

export interface RemoteDesktopWorkerConnectionContext {
  connectionGeneration: number;
  workerPid: number | null;
}

/**
 * Authority state shared by every native-worker platform host. Platform-only
 * retry/display state belongs in `metadata`, never in this protocol core.
 */
export interface RemoteDesktopTrackedAuthority<Metadata> {
  readonly requestId: string;
  readonly sessionId: string;
  readonly capability: Buffer;
  readonly prepare: RemoteDesktopPrepare;
  readonly metadata: Metadata;
  prepareReady: boolean;
  offerPending: boolean;
  prepareReadyTimer: ReturnType<typeof setTimeout> | null;
  offerAnswerTimer: ReturnType<typeof setTimeout> | null;
  offerContext: RemoteDesktopWorkerConnectionContext | null;
}

export type RemoteDesktopWorkerInboundEvent<Metadata> =
  | { kind: 'crash'; value: RemoteDesktopWorkerCrash }
  | {
    kind: 'message';
    value: RemoteDesktopDaemonMessage;
    authority: RemoteDesktopTrackedAuthority<Metadata>;
  };

export interface RemoteDesktopWorkerWatchdogEvent<Metadata> {
  readonly stage: RemoteDesktopWorkerWatchdogStage;
  readonly authority: RemoteDesktopTrackedAuthority<Metadata>;
  readonly connectionGeneration: number;
  readonly workerPid: number | null;
  readonly terminal: RemoteDesktopDaemonMessage;
}

export interface RemoteDesktopWorkerHostCoreOptions<Metadata> {
  nonce: string;
  prepareReadyTimeoutMs?: number;
  offerAnswerTimeoutMs?: number;
  maxLineBytes?: number;
  onWatchdogTimeout: (event: RemoteDesktopWorkerWatchdogEvent<Metadata>) => void;
  onPrepareReady?: (
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    connectionGeneration: number,
  ) => void;
  onOfferSent?: (
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    connectionGeneration: number,
  ) => void;
  onAnswer?: (
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    connectionGeneration: number,
  ) => void;
  onAuthorityRemoved?: () => void;
}

export interface RemoteDesktopWorkerInboundResult<Metadata> {
  readonly overflow: boolean;
  readonly events: readonly RemoteDesktopWorkerInboundEvent<Metadata>[];
}

/**
 * Platform-neutral authority/framing lifecycle for a native desktop worker.
 *
 * It deliberately has no socket, process-launch, filesystem, signature, OS
 * session, or display-controller dependency. Platform hosts supply only an
 * authenticated connection generation and worker pid to the watchdog seam.
 */
export class RemoteDesktopWorkerHostCore<Metadata> {
  private readonly tracked = new Map<string, RemoteDesktopTrackedAuthority<Metadata>>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly consentSubscribers = new Set<(frame: WorkerConsentInboundFrame) => void>();
  private readonly privacySubscribers = new Set<(frame: WorkerPrivacyInboundFrame) => void>();
  private nextConnectionGeneration = 0;
  private activeConnectionGeneration = 0;
  private buffer = '';
  private privacyEpochArmed = false;

  constructor(private readonly options: RemoteDesktopWorkerHostCoreOptions<Metadata>) {}

  get size(): number {
    return this.tracked.size;
  }

  get isPrivacyEpochArmed(): boolean {
    return this.privacyEpochArmed;
  }

  /** Read-only compatibility view used by the platform host and its tests. */
  authorities(): ReadonlyMap<string, RemoteDesktopTrackedAuthority<Metadata>> {
    return this.tracked;
  }

  values(): IterableIterator<RemoteDesktopTrackedAuthority<Metadata>> {
    return this.tracked.values();
  }

  has(sessionId: string): boolean {
    return this.tracked.has(sessionId);
  }

  get(sessionId: string): RemoteDesktopTrackedAuthority<Metadata> | undefined {
    return this.tracked.get(sessionId);
  }

  beginPreparing(sessionId: string): () => void {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    this.preparing.set(sessionId, barrier);
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      finish();
      if (this.preparing.get(sessionId) === barrier) this.preparing.delete(sessionId);
    };
  }

  async waitForPreparing(sessionId: string): Promise<void> {
    await this.preparing.get(sessionId);
  }

  track(
    prepare: RemoteDesktopPrepare,
    metadata: Metadata,
  ): RemoteDesktopTrackedAuthority<Metadata> {
    const previous = this.tracked.get(prepare.sessionId);
    if (previous) {
      this.clearTrackedTimers(previous);
      previous.capability.fill(0);
    }
    const authority: RemoteDesktopTrackedAuthority<Metadata> = {
      requestId: prepare.requestId,
      sessionId: prepare.sessionId,
      capability: Buffer.from(prepare.capability, 'utf8'),
      prepare,
      metadata,
      prepareReady: false,
      offerPending: false,
      prepareReadyTimer: null,
      offerAnswerTimer: null,
      offerContext: null,
    };
    this.tracked.set(prepare.sessionId, authority);
    return authority;
  }

  /** Detach without destroying authority bytes for an authenticated retry. */
  detach(sessionId: string): RemoteDesktopTrackedAuthority<Metadata> | undefined {
    const authority = this.tracked.get(sessionId);
    if (!authority) return undefined;
    this.clearTrackedTimers(authority);
    this.tracked.delete(sessionId);
    return authority;
  }

  restore(authority: RemoteDesktopTrackedAuthority<Metadata>): void {
    const previous = this.tracked.get(authority.sessionId);
    if (previous && previous !== authority) {
      this.clearTrackedTimers(previous);
      previous.capability.fill(0);
    }
    this.tracked.set(authority.sessionId, authority);
  }

  untrack(sessionId: string): void {
    const authority = this.tracked.get(sessionId);
    if (!authority) return;
    this.clearTrackedTimers(authority);
    authority.capability.fill(0);
    this.tracked.delete(sessionId);
    this.options.onAuthorityRemoved?.();
  }

  failAll(
    reason: typeof REMOTE_DESKTOP_TERMINAL_REASON[
      keyof typeof REMOTE_DESKTOP_TERMINAL_REASON
    ],
    onTerminal: (message: RemoteDesktopDaemonMessage) => void,
  ): void {
    if (this.tracked.size === 0) return;
    for (const authority of this.tracked.values()) {
      this.clearTrackedTimers(authority);
      onTerminal(this.terminalFor(authority, reason));
      authority.capability.fill(0);
    }
    this.tracked.clear();
    this.options.onAuthorityRemoved?.();
  }

  beginConnection(): number {
    const generation = ++this.nextConnectionGeneration;
    this.activeConnectionGeneration = generation;
    this.buffer = '';
    return generation;
  }

  endConnection(generation: number): boolean {
    if (this.activeConnectionGeneration !== generation) return false;
    this.resetConnection();
    return true;
  }

  /** Explicit host teardown owns all connection-local state, regardless of socket generation. */
  resetConnection(): void {
    this.activeConnectionGeneration = 0;
    this.buffer = '';
    this.privacyEpochArmed = false;
  }

  isCurrentConnection(generation: number): boolean {
    return generation !== 0 && this.activeConnectionGeneration === generation;
  }

  markPrivacyShielded(): void {
    this.privacyEpochArmed = true;
  }

  frameOutbound(message: unknown): string {
    return `${JSON.stringify(message)}\n`;
  }

  onPrivacyFrame(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void {
    this.privacySubscribers.add(handler);
    return () => { this.privacySubscribers.delete(handler); };
  }

  onConsentFrame(handler: (frame: WorkerConsentInboundFrame) => void): () => void {
    this.consentSubscribers.add(handler);
    return () => { this.consentSubscribers.delete(handler); };
  }

  pushInbound(
    chunk: string,
    connectionGeneration: number,
  ): RemoteDesktopWorkerInboundResult<Metadata> {
    if (!this.isCurrentConnection(connectionGeneration)) {
      return { overflow: false, events: [] };
    }
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > (this.options.maxLineBytes
      ?? REMOTE_DESKTOP_WORKER_MAX_LINE_BYTES)) {
      this.buffer = '';
      return { overflow: true, events: [] };
    }
    const events: RemoteDesktopWorkerInboundEvent<Metadata>[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (validateRemoteDesktopWorkerCrash(value, this.options.nonce)) {
        events.push({ kind: 'crash', value });
        continue;
      }
      const privacy = parseWorkerPrivacyFrame(value);
      if (privacy) {
        if (privacy.type === WORKER_PRIVACY_FRAME.RELEASED) this.privacyEpochArmed = false;
        for (const subscriber of [...this.privacySubscribers]) {
          try { subscriber(privacy); } catch { /* isolate subscribers */ }
        }
        continue;
      }
      const consent = parseWorkerConsentFrame(value);
      if (consent) {
        for (const subscriber of [...this.consentSubscribers]) {
          try { subscriber(consent); } catch { /* isolate subscribers */ }
        }
        continue;
      }
      const parsed = validateRemoteDesktopDaemonMessage(value);
      if (!parsed.ok) continue;
      const authority = this.tracked.get(parsed.value.sessionId);
      if (!authority || !this.capabilityMatches(authority, parsed.value.capability)) continue;
      const wasPrepareReady = authority.prepareReady;
      authority.prepareReady = true;
      this.clearPrepareReadyTimer(authority);
      if (!wasPrepareReady) {
        try {
          this.options.onPrepareReady?.(authority, connectionGeneration);
        } catch { /* diagnostics cannot affect signaling */ }
      }
      if (parsed.value.type === REMOTE_DESKTOP_MSG.ANSWER) {
        authority.offerPending = false;
        authority.offerContext = null;
        this.clearOfferAnswerTimer(authority);
        try {
          this.options.onAnswer?.(authority, connectionGeneration);
        } catch { /* diagnostics cannot affect signaling */ }
      } else if (!wasPrepareReady && authority.offerPending && authority.offerContext) {
        this.armOfferAnswerTimer(authority, authority.offerContext);
      }
      events.push({ kind: 'message', value: parsed.value, authority });
    }
    return { overflow: false, events };
  }

  armPrepareReadyTimer(
    sessionId: string,
    context: RemoteDesktopWorkerConnectionContext,
  ): void {
    const authority = this.tracked.get(sessionId);
    if (!authority || !this.isCurrentConnection(context.connectionGeneration)) return;
    this.clearPrepareReadyTimer(authority);
    if (authority.prepareReady) return;
    authority.prepareReadyTimer = setTimeout(() => {
      authority.prepareReadyTimer = null;
      if (this.tracked.get(sessionId) !== authority
        || !this.isCurrentConnection(context.connectionGeneration)) return;
      this.timeout(
        REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE.PREPARE_READY,
        authority,
        context,
      );
    }, this.options.prepareReadyTimeoutMs ?? DEFAULT_PREPARE_READY_TIMEOUT_MS);
    authority.prepareReadyTimer.unref?.();
  }

  markOfferPending(
    sessionId: string,
    context: RemoteDesktopWorkerConnectionContext,
  ): void {
    const authority = this.tracked.get(sessionId);
    if (!authority) return;
    authority.offerPending = true;
    authority.offerContext = context;
    this.clearOfferAnswerTimer(authority);
    if (authority.prepareReady) this.armOfferAnswerTimer(authority, context);
    try {
      this.options.onOfferSent?.(authority, context.connectionGeneration);
    } catch { /* diagnostics cannot affect signaling */ }
  }

  clearTrackedTimers(authority: RemoteDesktopTrackedAuthority<Metadata>): void {
    this.clearPrepareReadyTimer(authority);
    this.clearOfferAnswerTimer(authority);
  }

  private armOfferAnswerTimer(
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    context: RemoteDesktopWorkerConnectionContext,
  ): void {
    if (!authority.prepareReady || !authority.offerPending
      || !this.isCurrentConnection(context.connectionGeneration)) return;
    this.clearOfferAnswerTimer(authority);
    authority.offerAnswerTimer = setTimeout(() => {
      authority.offerAnswerTimer = null;
      if (this.tracked.get(authority.sessionId) !== authority
        || !this.isCurrentConnection(context.connectionGeneration)) return;
      this.timeout(
        REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE.OFFER_ANSWER,
        authority,
        context,
      );
    }, this.options.offerAnswerTimeoutMs ?? DEFAULT_OFFER_ANSWER_TIMEOUT_MS);
    authority.offerAnswerTimer.unref?.();
  }

  private timeout(
    stage: RemoteDesktopWorkerWatchdogStage,
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    context: RemoteDesktopWorkerConnectionContext,
  ): void {
    const terminal = this.terminalFor(
      authority,
      REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    );
    this.untrack(authority.sessionId);
    try {
      this.options.onWatchdogTimeout({
        stage,
        authority,
        connectionGeneration: context.connectionGeneration,
        workerPid: context.workerPid,
        terminal,
      });
    } catch {
      // Diagnostics/platform recovery cannot resurrect retired authority.
    }
  }

  private clearPrepareReadyTimer(authority: RemoteDesktopTrackedAuthority<Metadata>): void {
    if (authority.prepareReadyTimer) clearTimeout(authority.prepareReadyTimer);
    authority.prepareReadyTimer = null;
  }

  private clearOfferAnswerTimer(authority: RemoteDesktopTrackedAuthority<Metadata>): void {
    if (authority.offerAnswerTimer) clearTimeout(authority.offerAnswerTimer);
    authority.offerAnswerTimer = null;
  }

  private capabilityMatches(
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    capabilityValue: string,
  ): boolean {
    const capability = Buffer.from(capabilityValue, 'utf8');
    return capability.length === authority.capability.length
      && timingSafeEqual(capability, authority.capability);
  }

  private terminalFor(
    authority: RemoteDesktopTrackedAuthority<Metadata>,
    reason: typeof REMOTE_DESKTOP_TERMINAL_REASON[
      keyof typeof REMOTE_DESKTOP_TERMINAL_REASON
    ],
  ): RemoteDesktopDaemonMessage {
    return {
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      capability: authority.capability.toString('utf8'),
      reason,
    };
  }
}
