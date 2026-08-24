import {
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopAccessMode,
} from '@shared/remote-desktop.js';
import {
  RemoteDesktopClient,
  type RemoteDesktopClientHooks,
  type RemoteDesktopSnapshot,
} from './remote-desktop-client.js';

export interface RemoteDesktopHostTarget {
  serverId: string;
  /** Additive canonical identity; current machine DTOs fall back to serverId. */
  remoteDesktopHostId?: string | null;
}

export type RemoteDesktopPresentationRef = object;
export type RemoteDesktopSnapshotListener = (snapshot: RemoteDesktopSnapshot) => void;

interface RemoteDesktopConnectionClient {
  current(): Readonly<RemoteDesktopSnapshot>;
  start(reconnectAttempt?: number): Promise<void>;
  setMode(mode: RemoteDesktopAccessMode): void;
  selectDisplay(displayId: string): boolean;
  setDisplayMode(displayId: string, width: number, height: number): boolean;
  setDisplayScale(displayId: string, dpiScalePercent: number): boolean;
  requestUnlock(): boolean;
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
  text(value: string): boolean;
  releaseAll(): void;
  releasePointerButtons(): void;
  stop(): void;
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
  inputPresentation: RemoteDesktopPresentationRef | null;
  connection: RemoteDesktopManagedConnection;
}

export interface RemoteDesktopConnectionManagerDependencies {
  createClient?(
    serverId: string,
    hooks: RemoteDesktopClientHooks,
  ): RemoteDesktopConnectionClient;
}

const RECONNECTABLE_FAILURES = new Set<string>([
  REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
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

  constructor(dependencies: RemoteDesktopConnectionManagerDependencies = {}) {
    this.createClient = dependencies.createClient
      ?? ((serverId, hooks) => new RemoteDesktopClient(serverId, hooks));
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

  stop(target: RemoteDesktopHostTarget | string): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (!entry || entry.stopped) return;
    entry.stopped = true;
    this.clearReconnectTimers(entry);
    this.entries.delete(hostKey);
    // RemoteDesktopClient.stop owns the exact release_all -> Stop ordering.
    entry.client.stop();
    entry.presentations.clear();
  }

  releaseInput(target: RemoteDesktopHostTarget | string): void {
    const hostKey = typeof target === 'string' ? target : remoteDesktopHostKey(target);
    const entry = this.entries.get(hostKey);
    if (!entry || entry.stopped || !entry.inputPresentation) return;
    entry.client.releaseAll();
    entry.inputPresentation = null;
  }

  stopAll(): void {
    for (const hostKey of [...this.entries.keys()]) this.stop(hostKey);
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
    });
  }

  private createConnection(
    entry: ManagedEntry,
    boundPresentation?: RemoteDesktopPresentationRef,
  ): RemoteDesktopManagedConnection {
    const canControl = () => !boundPresentation || entry.inputPresentation === boundPresentation;
    return {
      get hostKey() { return entry.hostKey; },
      get serverId() { return entry.serverId; },
      current: () => entry.snapshot,
      start: async () => this.start(entry),
      subscribe: (presentation, listener, options) => {
        if (entry.stopped) return () => {};
        const effectivePresentation = boundPresentation ?? presentation;
        if (options?.controlsInput && entry.inputPresentation !== effectivePresentation) {
          if (entry.inputPresentation) entry.client.releaseAll();
          entry.inputPresentation = effectivePresentation;
        }
        entry.presentations.set(effectivePresentation, listener);
        listener(entry.snapshot);
        return () => {
          if (entry.presentations.get(effectivePresentation) === listener) {
            if (entry.inputPresentation === effectivePresentation) {
              entry.client.releaseAll();
              entry.inputPresentation = null;
            }
            entry.presentations.delete(effectivePresentation);
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
      requestRemoteClipboard: () => canControl()
        ? entry.client.requestRemoteClipboard()
        : Promise.resolve(null),
      acknowledgePresentedFrame: (frameWidth, frameHeight) => (
        entry.client.acknowledgePresentedFrame(frameWidth, frameHeight)
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
      text: (value) => canControl() && entry.client.text(value),
      releaseAll: () => entry.client.releaseAll(),
      releasePointerButtons: () => entry.client.releasePointerButtons(),
      stop: () => this.stop(entry.hostKey),
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

    const reason = next.terminalReason ?? next.error;
    const reconnectable = next.state === REMOTE_DESKTOP_STATE.FAILED
      && Boolean(reason && RECONNECTABLE_FAILURES.has(reason));
    if (reconnectable && entry.reconnectTimer) return;
    if (reconnectable && entry.reconnectCount < REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS) {
      entry.reconnectCount += 1;
      const reconnectAttempt = entry.reconnectCount;
      this.publish(entry, {
        ...next,
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
    this.publish(entry, { ...next, reconnectCount: entry.reconnectCount });
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
      reconnectCount: 0,
      error: undefined,
      terminalReason: undefined,
    });
    this.replaceClient(entry, 1);
  }

  private replaceClient(entry: ManagedEntry, reconnectAttempt: number): void {
    const previous = entry.client;
    entry.clientGeneration += 1;
    previous.stop();
    entry.client = this.newClient(entry, entry.clientGeneration);
    if (entry.started) void this.startCurrentClient(entry, reconnectAttempt);
  }

  private replaceExecutionEndpoint(entry: ManagedEntry, serverId: string): void {
    if (entry.stopped || entry.serverId === serverId) return;
    this.clearReconnectTimers(entry);
    const previous = entry.client;
    entry.clientGeneration += 1;
    entry.serverId = serverId;
    previous.stop();
    entry.client = this.newClient(entry, entry.clientGeneration);
    entry.snapshot = entry.client.current() as RemoteDesktopSnapshot;
    this.publish(entry, entry.snapshot);
    if (entry.started) void this.startCurrentClient(entry, 0);
  }

  private publish(entry: ManagedEntry, snapshot: RemoteDesktopSnapshot): void {
    entry.snapshot = snapshot;
    for (const listener of entry.presentations.values()) listener(snapshot);
  }

  private clearReconnectTimers(entry: ManagedEntry): void {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.reconnectStabilityTimer) clearTimeout(entry.reconnectStabilityTimer);
    entry.reconnectTimer = null;
    entry.reconnectStabilityTimer = null;
  }
}
