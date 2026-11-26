import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_STOP_ORIGIN,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopAccessMode,
  type RemoteDesktopQualityPreference,
  type RemoteDesktopStopOrigin,
} from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CLIENT_ERROR,
  RemoteDesktopClient,
  type RemoteDesktopClientHooks,
  type RemoteDesktopSnapshot,
} from './remote-desktop-client.js';
import type { RemoteDesktopChordKey } from './remote-desktop-keyboard.js';
import type { RemoteDesktopModifierKind } from './remote-desktop-keyboard.js';

export interface RemoteDesktopHostTarget {
  serverId: string;
  /** Additive canonical identity; current machine DTOs fall back to serverId. */
  remoteDesktopHostId?: string | null;
}

export type RemoteDesktopPresentationRef = object;
export type RemoteDesktopSnapshotListener = (snapshot: RemoteDesktopSnapshot) => void;
export interface RemoteDesktopConnectionSummary {
  hostKey: string;
  serverId: string;
  snapshot: Readonly<RemoteDesktopSnapshot>;
}
export type RemoteDesktopManagerListener = (connections: readonly RemoteDesktopConnectionSummary[]) => void;

interface RemoteDesktopConnectionClient {
  current(): Readonly<RemoteDesktopSnapshot>;
  start(reconnectAttempt?: number): Promise<void>;
  setMode(mode: RemoteDesktopAccessMode): void;
  selectDisplay(displayId: string): boolean;
  setDisplayMode(displayId: string, width: number, height: number): boolean;
  setDisplayScale(displayId: string, dpiScalePercent: number): boolean;
  requestUnlock(): boolean;
  /** Viewer quality preference; each viewer shapes only their own stream. */
  setQualityPreference?(
    preference: RemoteDesktopQualityPreference,
    options?: { latencyGuard?: boolean },
  ): boolean;
  setClipboardSync?(enabled: boolean): boolean;
  setAudioEnabled?(enabled: boolean): boolean;
  requestRemoteClipboard(): Promise<string | null>;
  acknowledgePresentedFrame(frameWidth: number, frameHeight: number): boolean;
  pointerMove(x: number, y: number): void;
  pointerButton(
    button: 'left' | 'middle' | 'right' | 'back' | 'forward',
    down: boolean,
    x?: number,
    y?: number,
  ): boolean;
  pointerClick(
    button: 'left' | 'middle' | 'right' | 'back' | 'forward',
    x?: number,
    y?: number,
  ): boolean;
  wheel(deltaX: number, deltaY: number, x?: number, y?: number): boolean;
  key(
    code: string,
    key: string,
    down: boolean,
    repeat: boolean,
    modifiers: { control: boolean; alt: boolean },
  ): boolean;
  tapChords(chords: readonly (readonly RemoteDesktopChordKey[])[]): boolean;
  text(value: string): boolean;
  pasteText?(value: string): boolean;
  releaseAll(): void;
  reconcileModifiers?(
    modifiers: Partial<Record<RemoteDesktopModifierKind, boolean>>,
    exceptCode?: string,
  ): void;
  noteMetaChordKey?(code: string, key: string, metaHeld: boolean): void;
  releasePointerButtons(): void;
  stop(origin: RemoteDesktopStopOrigin): void;
}

export interface RemoteDesktopManagedConnection extends RemoteDesktopConnectionClient {
  readonly hostKey: string;
  readonly serverId: string;
  subscribe(
    presentation: RemoteDesktopPresentationRef,
    listener: RemoteDesktopSnapshotListener,
    options?: { controlsInput?: boolean },
  ): () => void;
  retry(): void;
}

interface ManagedEntry {
  readonly hostKey: string;
  serverId: string;
  client: RemoteDesktopConnectionClient;
  clientGeneration: number;
  snapshot: RemoteDesktopSnapshot;
  started: boolean;
  stopped: boolean;
  reconnectCount: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectStabilityTimer: ReturnType<typeof setTimeout> | null;
  readonly presentations: Map<RemoteDesktopPresentationRef, RemoteDesktopSnapshotListener>;
  readonly presentationConnections: WeakMap<RemoteDesktopPresentationRef, RemoteDesktopManagedConnection>;
  readonly clipboardSyncByPresentation: WeakMap<RemoteDesktopPresentationRef, boolean>;
  fallbackClipboardSync?: boolean;
  readonly audioEnabledByPresentation: WeakMap<RemoteDesktopPresentationRef, boolean>;
  fallbackAudioEnabled?: boolean;
  audioSyncActive?: boolean;
  deliveredClipboardUpdateId: number;
  lastSeenClientClipboardUpdateId: number;
  controllerClipboardUpdate?: RemoteDesktopSnapshot['remoteClipboardUpdate'];
  inputPresentation: RemoteDesktopPresentationRef | null;
  connection: RemoteDesktopManagedConnection;
}

/** Whether anyone can currently see this page, and when that becomes true again. */
export interface RemoteDesktopPageVisibility {
  isVisible(): boolean;
  /** Calls `listener` each time the page becomes visible; returns the unsubscribe. */
  onVisible(listener: () => void): () => void;
}

export interface RemoteDesktopConnectionManagerDependencies {
  createClient?(
    serverId: string,
    hooks: RemoteDesktopClientHooks,
  ): RemoteDesktopConnectionClient;
  visibility?: RemoteDesktopPageVisibility;
}

function documentPageVisibility(): RemoteDesktopPageVisibility {
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return {
    isVisible: visible,
    onVisible: (listener) => {
      if (typeof document === 'undefined') return () => {};
      const handler = () => { if (visible()) listener(); };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

const RECONNECTABLE_FAILURES = new Set<string>([
  REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
  REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE,
  REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED,
  REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED,
  REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
  REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
]);

export function remoteDesktopHostKey(target: RemoteDesktopHostTarget): string {
  const canonicalHostId = target.remoteDesktopHostId?.trim();
  return canonicalHostId || target.serverId.trim();
}

/**
 * Workspace lifetime owner for remote desktop transport state. Presentations
 * only subscribe and forward input; mounting or unmounting one never owns the
 * PeerConnection, media tracks, data channels, reconnect loop, or Stop.
 */
export class RemoteDesktopConnectionManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly createClient: NonNullable<RemoteDesktopConnectionManagerDependencies['createClient']>;
  private readonly visibility: RemoteDesktopPageVisibility;
  /** Connections that failed while the page was hidden, retried once it is seen. */
  private readonly waitingForVisible = new Set<ManagedEntry>();
  private stopWatchingVisibility: (() => void) | null = null;
  private readonly managerListeners = new Set<RemoteDesktopManagerListener>();

  constructor(dependencies: RemoteDesktopConnectionManagerDependencies = {}) {
    this.createClient = dependencies.createClient
      ?? ((serverId, hooks) => new RemoteDesktopClient(serverId, hooks));
    this.visibility = dependencies.visibility ?? documentPageVisibility();
  }

  connection(target: RemoteDesktopHostTarget): RemoteDesktopManagedConnection {
    const hostKey = remoteDesktopHostKey(target);
    const existing = this.entries.get(hostKey);
    if (existing) {
      if (existing.serverId !== target.serverId) {
        this.replaceExecutionEndpoint(existing, target.serverId);
      }
      return existing.connection;
    }

    const entry = this.createEntry(hostKey, target.serverId);
    this.entries.set(hostKey, entry);
    this.notifyManagerListeners();
    return entry.connection;
  }

  presentation(
    target: RemoteDesktopHostTarget,
    presentation: RemoteDesktopPresentationRef,
  ): RemoteDesktopManagedConnection {
    const connection = this.connection(target);
    const entry = this.entries.get(connection.hostKey);
    if (!entry) return connection;
    const existing = entry.presentationConnections.get(presentation);
    if (existing) return existing;
    const scoped = this.createConnection(entry, presentation);
    entry.presentationConnections.set(presentation, scoped);
    return scoped;
  }

  stop(target: RemoteDesktopHostTarget | string, origin: RemoteDesktopStopOrigin): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (!entry || entry.stopped) return;
    entry.stopped = true;
    this.clearReconnectTimers(entry);
    this.entries.delete(hostKey);
    // RemoteDesktopClient.stop owns the exact release_all -> Stop ordering.
    entry.client.stop(origin);
    entry.presentations.clear();
    this.notifyManagerListeners();
  }

  releaseInput(target: RemoteDesktopHostTarget | string): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (!entry || entry.stopped || !entry.inputPresentation) return;
    entry.client.releaseAll();
    entry.inputPresentation = null;
    entry.controllerClipboardUpdate = undefined;
    entry.client.setClipboardSync?.(false);
    this.publish(entry, entry.snapshot);
  }

  stopAll(origin: RemoteDesktopStopOrigin): void {
    for (const hostKey of [...this.entries.keys()]) this.stop(hostKey, origin);
  }

  listConnections(): readonly RemoteDesktopConnectionSummary[] {
    return [...this.entries.values()].map((entry) => ({
      hostKey: entry.hostKey,
      serverId: entry.serverId,
      snapshot: entry.snapshot,
    }));
  }

  subscribe(listener: RemoteDesktopManagerListener): () => void {
    this.managerListeners.add(listener);
    listener(this.listConnections());
    return () => this.managerListeners.delete(listener);
  }

  pause(target: RemoteDesktopHostTarget | string): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (entry && !entry.stopped) entry.connection.setMode('view');
  }

  resume(target: RemoteDesktopHostTarget | string): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (entry && !entry.stopped) entry.connection.setMode('control');
  }

  /**
   * A native foreground transition is an explicit opportunity to recover an
   * exhausted transient outage. It never replaces a live or still-budgeted
   * connection, so repeated resume events cannot duplicate an active route.
   */
  resumeExhaustedConnections(): void {
    for (const entry of this.entries.values()) {
      if (entry.stopped
        || entry.reconnectTimer
        || entry.reconnectCount < REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS
        || !this.isReconnectableFailure(entry.snapshot)) continue;
      this.retry(entry);
    }
  }

  private createEntry(hostKey: string, serverId: string): ManagedEntry {
    const entry = {
      hostKey,
      serverId,
      client: null as unknown as RemoteDesktopConnectionClient,
      clientGeneration: 1,
      snapshot: null as unknown as RemoteDesktopSnapshot,
      started: false,
      stopped: false,
      reconnectCount: 0,
      reconnectTimer: null,
      reconnectStabilityTimer: null,
      presentations: new Map<RemoteDesktopPresentationRef, RemoteDesktopSnapshotListener>(),
      presentationConnections: new WeakMap<RemoteDesktopPresentationRef, RemoteDesktopManagedConnection>(),
      clipboardSyncByPresentation: new WeakMap<RemoteDesktopPresentationRef, boolean>(),
      audioEnabledByPresentation: new WeakMap<RemoteDesktopPresentationRef, boolean>(),
      deliveredClipboardUpdateId: 0,
      lastSeenClientClipboardUpdateId: 0,
      inputPresentation: null,
      connection: null as unknown as RemoteDesktopManagedConnection,
    } satisfies ManagedEntry;
    entry.client = this.newClient(entry, entry.clientGeneration);
    entry.snapshot = entry.client.current() as RemoteDesktopSnapshot;
    entry.connection = this.createConnection(entry);
    return entry;
  }

  private newClient(entry: ManagedEntry, generation: number): RemoteDesktopConnectionClient {
    return this.createClient(entry.serverId, {
      onSnapshot: (snapshot) => this.receiveSnapshot(entry, generation, snapshot),
      onDaemonReconnected: () => this.receiveDaemonReconnected(entry, generation),
    });
  }

  private snapshotForPresentation(
    entry: ManagedEntry,
    presentation: RemoteDesktopPresentationRef,
  ): RemoteDesktopSnapshot {
    if (entry.inputPresentation === presentation) {
      return {
        ...entry.snapshot,
        remoteClipboardUpdate: entry.controllerClipboardUpdate,
      };
    }
    return {
      ...entry.snapshot,
      inputEnabled: false,
      remoteClipboardUpdate: undefined,
    };
  }

  private applyActiveClipboardSyncPreference(entry: ManagedEntry): void {
    const pref = entry.inputPresentation
      ? (entry.clipboardSyncByPresentation.get(entry.inputPresentation) ?? entry.fallbackClipboardSync)
      : entry.fallbackClipboardSync;
    if (pref !== undefined) {
      entry.client.setClipboardSync?.(pref);
    }
  }

  private computeDesiredAudioEnabled(entry: ManagedEntry): boolean | undefined {
    let seenPreference = false;
    for (const presentation of entry.presentations.keys()) {
      const pref = entry.audioEnabledByPresentation.get(presentation);
      if (pref !== undefined) {
        seenPreference = true;
        if (pref) return true;
      }
    }
    if (seenPreference) return false;
    if (entry.fallbackAudioEnabled !== undefined) return entry.fallbackAudioEnabled;
    return entry.audioSyncActive ? false : undefined;
  }

  private syncAudioEnabled(entry: ManagedEntry): boolean {
    const desired = this.computeDesiredAudioEnabled(entry);
    if (desired === undefined) return false;
    if (desired === entry.audioSyncActive) {
      return entry.client.current().audioEnabled === desired;
    }
    entry.audioSyncActive = desired;
    return entry.client.setAudioEnabled?.(desired) ?? false;
  }

  private applyActiveAudioPreference(entry: ManagedEntry): void {
    if (entry.audioSyncActive !== undefined) {
      entry.client.setAudioEnabled?.(entry.audioSyncActive);
    }
  }

  private createConnection(
    entry: ManagedEntry,
    boundPresentation?: RemoteDesktopPresentationRef,
  ): RemoteDesktopManagedConnection {
    const canControl = () => !boundPresentation || entry.inputPresentation === boundPresentation;
    return {
      get hostKey() { return entry.hostKey; },
      get serverId() { return entry.serverId; },
      current: () => boundPresentation
        ? this.snapshotForPresentation(entry, boundPresentation)
        : {
          ...entry.snapshot,
          remoteClipboardUpdate: entry.inputPresentation ? entry.controllerClipboardUpdate : undefined,
        },
      start: async () => this.start(entry),
      subscribe: (presentation, listener, options) => {
        if (entry.stopped) return () => {};
        const effectivePresentation = boundPresentation ?? presentation;
        const previousInputPresentation = entry.inputPresentation;
        if (options?.controlsInput && entry.inputPresentation !== effectivePresentation) {
          if (entry.inputPresentation) entry.client.releaseAll();
          entry.controllerClipboardUpdate = undefined;
          entry.inputPresentation = effectivePresentation;
          this.applyActiveClipboardSyncPreference(entry);
    this.applyActiveAudioPreference(entry);
        }
        entry.presentations.set(effectivePresentation, listener);
        if (entry.audioEnabledByPresentation.has(effectivePresentation)) {
          this.syncAudioEnabled(entry);
        }
        if (options?.controlsInput && previousInputPresentation && previousInputPresentation !== effectivePresentation) {
          const prevListener = entry.presentations.get(previousInputPresentation);
          if (prevListener) prevListener(this.snapshotForPresentation(entry, previousInputPresentation));
        }
        listener(this.snapshotForPresentation(entry, effectivePresentation));
        return () => {
          if (entry.presentations.get(effectivePresentation) === listener) {
            if (entry.inputPresentation === effectivePresentation) {
              entry.client.releaseAll();
              entry.inputPresentation = null;
              entry.controllerClipboardUpdate = undefined;
              entry.client.setClipboardSync?.(false);
            }
            entry.presentations.delete(effectivePresentation);
            if (entry.audioSyncActive) this.syncAudioEnabled(entry);
          }
        };
      },
      retry: () => this.retry(entry),
      setMode: (mode) => { if (canControl()) entry.client.setMode(mode); },
      selectDisplay: (displayId) => canControl() && entry.client.selectDisplay(displayId),
      setDisplayMode: (displayId, width, height) => (
        canControl() && entry.client.setDisplayMode(displayId, width, height)
      ),
      setDisplayScale: (displayId, dpiScalePercent) => (
        canControl() && entry.client.setDisplayScale(displayId, dpiScalePercent)
      ),
      requestUnlock: () => canControl() && entry.client.requestUnlock(),
      // Not gated on control: a viewer chooses their own stream quality.
      setQualityPreference: (preference, options) => (
        entry.client.setQualityPreference?.(preference, options) ?? false
      ),
      requestRemoteClipboard: () => canControl()
        ? entry.client.requestRemoteClipboard()
        : Promise.resolve(null),
      acknowledgePresentedFrame: (frameWidth, frameHeight) => (
        entry.client.acknowledgePresentedFrame?.(frameWidth, frameHeight) ?? false
      ),
      pointerMove: (x, y) => { if (canControl()) entry.client.pointerMove(x, y); },
      pointerButton: (button, down, x, y) => (
        canControl() && entry.client.pointerButton(button, down, x, y)
      ),
      pointerClick: (button, x, y) => (
        canControl() && entry.client.pointerClick(button, x, y)
      ),
      wheel: (deltaX, deltaY, x, y) => (
        canControl() && entry.client.wheel(deltaX, deltaY, x, y)
      ),
      key: (code, key, down, repeat, modifiers) => (
        canControl() && entry.client.key(code, key, down, repeat, modifiers)
      ),
      tapChords: (chords) => canControl() && entry.client.tapChords(chords),
      text: (value) => canControl() && entry.client.text(value),
      pasteText: (value) => canControl()
        && (entry.client.pasteText?.(value) ?? entry.client.text(value)),
      setClipboardSync: (enabled) => {
        if (boundPresentation) {
          entry.clipboardSyncByPresentation.set(boundPresentation, enabled);
        } else {
          entry.fallbackClipboardSync = enabled;
        }
        return canControl() && (entry.client.setClipboardSync?.(enabled) ?? false);
      },
      setAudioEnabled: (enabled) => {
        if (boundPresentation) {
          entry.audioEnabledByPresentation.set(boundPresentation, enabled);
        } else {
          entry.fallbackAudioEnabled = enabled;
        }
        const next = this.computeDesiredAudioEnabled(entry) ?? enabled;
        entry.audioSyncActive = next;
        return entry.client.setAudioEnabled?.(next) ?? false;
      },
      releaseAll: () => entry.client.releaseAll(),
      reconcileModifiers: (modifiers, exceptCode) => (
        entry.client.reconcileModifiers?.(modifiers, exceptCode)
      ),
      noteMetaChordKey: (code, key, metaHeld) => (
        entry.client.noteMetaChordKey?.(code, key, metaHeld)
      ),
      releasePointerButtons: () => entry.client.releasePointerButtons(),
      stop: (origin) => this.stop(entry.hostKey, origin),
    };
  }

  private async start(entry: ManagedEntry): Promise<void> {
    if (entry.started || entry.stopped) return;
    entry.started = true;
    await this.startCurrentClient(entry, 0);
  }

  private async startCurrentClient(entry: ManagedEntry, reconnectAttempt: number): Promise<void> {
    const generation = entry.clientGeneration;
    const client = entry.client;
    try {
      await client.start(reconnectAttempt);
    } catch {
      if (entry.stopped || generation !== entry.clientGeneration) return;
      this.receiveSnapshot(entry, generation, {
        ...client.current(),
        state: REMOTE_DESKTOP_STATE.FAILED,
        inputEnabled: false,
        error: REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
      });
    }
  }

  private receiveSnapshot(
    entry: ManagedEntry,
    generation: number,
    next: RemoteDesktopSnapshot,
  ): void {
    if (entry.stopped || generation !== entry.clientGeneration) return;
    const incomingUpdate = next.remoteClipboardUpdate;
    if (incomingUpdate && incomingUpdate.id > entry.lastSeenClientClipboardUpdateId) {
      entry.lastSeenClientClipboardUpdateId = incomingUpdate.id;
      if (entry.inputPresentation !== null
        && next.inputEnabled
        && next.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL) {
        entry.deliveredClipboardUpdateId += 1;
        entry.controllerClipboardUpdate = {
          id: entry.deliveredClipboardUpdateId,
          text: incomingUpdate.text,
          inputEpoch: incomingUpdate.inputEpoch ?? next.inputEpoch,
          connectionGeneration: generation,
        };
      }
    }
    if (!next.inputEnabled || next.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL) {
      entry.controllerClipboardUpdate = undefined;
    }
    const cleanNext: RemoteDesktopSnapshot = next.remoteClipboardUpdate
      ? { ...next, remoteClipboardUpdate: undefined }
      : next;
    const connected = next.state === REMOTE_DESKTOP_STATE.DIRECT
      || next.state === REMOTE_DESKTOP_STATE.RELAYED;
    if (!connected && entry.reconnectStabilityTimer) {
      clearTimeout(entry.reconnectStabilityTimer);
      entry.reconnectStabilityTimer = null;
    }
    if (connected && entry.reconnectCount > 0 && !entry.reconnectStabilityTimer) {
      entry.reconnectStabilityTimer = setTimeout(() => {
        entry.reconnectStabilityTimer = null;
        if (entry.stopped || generation !== entry.clientGeneration) return;
        entry.reconnectCount = 0;
        this.publish(entry, { ...entry.snapshot, reconnectCount: 0 });
      }, REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS);
    }

    const reconnectable = this.isReconnectableFailure(next);
    if (reconnectable && entry.reconnectTimer) return;
    if (reconnectable && !this.visibility.isVisible()) {
      entry.controllerClipboardUpdate = undefined;
      // A hidden page never presents a video frame, and the Server does not
      // call a route connected until one has been presented, so every
      // attempt made now would run into the negotiation timeout and use up
      // the retry budget -- leaving a background tab "failed" by the time
      // anyone looks at it. Wait until the page is seen, then start over.
      this.publish(entry, {
        ...cleanNext,
        state: REMOTE_DESKTOP_STATE.RECONNECTING,
        inputEnabled: false,
        reconnectCount: entry.reconnectCount,
      });
      this.retryWhenVisible(entry);
      return;
    }
    if (reconnectable && entry.reconnectCount < REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS) {
      entry.controllerClipboardUpdate = undefined;
      entry.reconnectCount += 1;
      const reconnectAttempt = entry.reconnectCount;
      this.publish(entry, {
        ...cleanNext,
        state: REMOTE_DESKTOP_STATE.RECONNECTING,
        inputEnabled: false,
        reconnectCount: reconnectAttempt,
      });
      entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        if (!entry.stopped) this.replaceClient(entry, reconnectAttempt);
      }, REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS * (2 ** (reconnectAttempt - 1)));
      return;
    }
    this.publish(entry, { ...cleanNext, reconnectCount: entry.reconnectCount });
  }

  private receiveDaemonReconnected(entry: ManagedEntry, generation: number): void {
    if (entry.stopped || generation !== entry.clientGeneration) return;
    // The signaling socket is attached to this exact server bridge, so its
    // RECONNECTED broadcast is authoritative for this host. A connected route
    // may be undergoing the server's shielded in-place renegotiation and must
    // not be duplicated. Only an already-failed or backoff-waiting client is
    // replaced; otherwise this event merely starts a fresh outage budget.
    if (entry.reconnectTimer || this.isReconnectableFailure(entry.snapshot)) {
      this.retry(entry);
      return;
    }
    if (entry.reconnectCount === 0) return;
    if (entry.reconnectStabilityTimer) {
      clearTimeout(entry.reconnectStabilityTimer);
      entry.reconnectStabilityTimer = null;
    }
    entry.reconnectCount = 0;
    this.publish(entry, { ...entry.snapshot, reconnectCount: 0 });
  }

  private isReconnectableFailure(snapshot: RemoteDesktopSnapshot): boolean {
    const reason = snapshot.terminalReason ?? snapshot.error;
    if (reason === REMOTE_DESKTOP_CLIENT_ERROR.WEBRTC_UNAVAILABLE) return false;
    return snapshot.state === REMOTE_DESKTOP_STATE.FAILED
      && snapshot.retryable !== false
      && Boolean(snapshot.retryable === true || (reason && RECONNECTABLE_FAILURES.has(reason)));
  }

  private retry(entry: ManagedEntry): void {
    if (entry.stopped) return;
    this.clearReconnectTimers(entry);
    entry.reconnectCount = 0;
    this.publish(entry, {
      ...entry.snapshot,
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
      stream: null,
      audioStream: null,
      reconnectCount: 0,
      error: undefined,
      terminalReason: undefined,
      retryable: undefined,
    });
    this.replaceClient(entry, 1);
  }

  private replaceClient(entry: ManagedEntry, reconnectAttempt: number): void {
    const previous = entry.client;
    entry.clientGeneration += 1;
    entry.lastSeenClientClipboardUpdateId = 0;
    entry.controllerClipboardUpdate = undefined;
    previous.stop(REMOTE_DESKTOP_STOP_ORIGIN.MANAGER_RECONNECT);
    entry.client = this.newClient(entry, entry.clientGeneration);
    this.applyActiveClipboardSyncPreference(entry);
    this.applyActiveAudioPreference(entry);
    if (entry.started) void this.startCurrentClient(entry, reconnectAttempt);
  }

  private replaceExecutionEndpoint(entry: ManagedEntry, serverId: string): void {
    if (entry.stopped || entry.serverId === serverId) return;
    this.clearReconnectTimers(entry);
    const previous = entry.client;
    entry.clientGeneration += 1;
    entry.lastSeenClientClipboardUpdateId = 0;
    entry.controllerClipboardUpdate = undefined;
    entry.serverId = serverId;
    previous.stop(REMOTE_DESKTOP_STOP_ORIGIN.EXECUTION_ENDPOINT_CHANGE);
    entry.client = this.newClient(entry, entry.clientGeneration);
    this.applyActiveClipboardSyncPreference(entry);
    this.applyActiveAudioPreference(entry);
    entry.snapshot = entry.client.current() as RemoteDesktopSnapshot;
    this.publish(entry, entry.snapshot);
    if (entry.started) void this.startCurrentClient(entry, 0);
  }

  private publish(entry: ManagedEntry, snapshot: RemoteDesktopSnapshot): void {
    entry.snapshot = snapshot.remoteClipboardUpdate
      ? { ...snapshot, remoteClipboardUpdate: undefined }
      : snapshot;
    for (const [presentation, listener] of entry.presentations.entries()) {
      listener(this.snapshotForPresentation(entry, presentation));
    }
    this.notifyManagerListeners();
  }

  private notifyManagerListeners(): void {
    const snapshot = this.listConnections();
    for (const listener of this.managerListeners) listener(snapshot);
  }

  private clearReconnectTimers(entry: ManagedEntry): void {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.reconnectStabilityTimer) clearTimeout(entry.reconnectStabilityTimer);
    entry.reconnectTimer = null;
    entry.reconnectStabilityTimer = null;
    if (this.waitingForVisible.delete(entry) && this.waitingForVisible.size === 0) {
      this.stopWatchingVisibility?.();
      this.stopWatchingVisibility = null;
    }
  }

  private retryWhenVisible(entry: ManagedEntry): void {
    this.waitingForVisible.add(entry);
    this.stopWatchingVisibility ??= this.visibility.onVisible(() => {
      for (const waiting of [...this.waitingForVisible]) this.retry(waiting);
    });
  }
}
