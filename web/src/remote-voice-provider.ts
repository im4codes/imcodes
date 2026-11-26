import {
  REMOTE_VOICE_WS_PATH,
  isValidRemoteVoiceModelRegistration,
  sanitizeRemoteVoiceProviderErrorCode,
  type RemoteVoiceInboundFrame,
  type RemoteVoiceProviderRegisterFrame,
  type RemoteVoiceServerFrame,
} from '@shared/remote-voice.js';
import { fetchRemoteVoiceWsTicket, getApiBaseUrl } from './api.js';
import {
  getPcAppBridge,
  isPcAppInlineVoiceSupported,
  type PcAppBridge,
  type PcAppRemoteVoiceEvent,
  type PcAppRemoteVoiceProviderInfo,
} from './native-platform.js';

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 40_000;

export interface RemoteVoiceProviderDeps {
  isSupported?: () => boolean;
  getBridge?: () => PcAppBridge | null;
  fetchTicket?: () => Promise<{ ticket: string }>;
  getWsBaseUrl?: () => string;
  createSocket?: (url: string) => WebSocket;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

let _localPcAppDeviceId: string | null = null;

export function getLocalPcAppRemoteDeviceId(): string | null {
  return _localPcAppDeviceId;
}

export function setLocalPcAppRemoteDeviceIdForTesting(deviceId: string | null): void {
  _localPcAppDeviceId = deviceId;
}

function buildRemoteVoiceWsUrl(wsBaseUrl: string, ticket: string): string {
  const cleanBase = wsBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${cleanBase}${REMOTE_VOICE_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

export class RemoteVoiceProviderController {
  private readonly deps: RemoteVoiceProviderDeps;
  private running = false;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private connectionGen = 0;
  private unsubIpc: (() => void) | null = null;
  private removeWakeListeners: (() => void) | null = null;
  private currentInfo: PcAppRemoteVoiceProviderInfo | null = null;
  private activeSessionId: string | null = null;
  private lastActivityAt = 0;

  constructor(deps: RemoteVoiceProviderDeps = {}) {
    this.deps = deps;
  }

  private getVoiceBridge(): NonNullable<PcAppBridge['voice']> | null {
    const supported = this.deps.isSupported ? this.deps.isSupported() : isPcAppInlineVoiceSupported();
    if (!supported) return null;
    const bridge = this.deps.getBridge ? this.deps.getBridge() : getPcAppBridge();
    const voice = bridge?.voice;
    if (!voice || typeof voice.getRemoteProviderInfo !== 'function') return null;
    return voice;
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private abortActiveSession(): void {
    if (!this.activeSessionId) return;
    const sid = this.activeSessionId;
    this.activeSessionId = null;
    void this.getVoiceBridge()?.stopRemoteSession?.({ sessionId: sid, abort: true }).catch(() => {});
  }

  private detachSocket(options?: { closeCode?: number; closeReason?: string }): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.abortActiveSession();
    if (ws && options?.closeCode !== undefined) {
      try {
        ws.close(options.closeCode, options.closeReason);
      } catch {
        // Ignore close errors.
      }
    }
  }

  private closeSocket(): void {
    this.detachSocket({ closeCode: 1000, closeReason: 'provider_stopped' });
  }

  private safeSend(frame: RemoteVoiceInboundFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Close/error handlers trigger reconnect when needed.
    }
  }

  private sendRegistration(): void {
    const info = this.currentInfo;
    if (!info || !info.ready) return;
    if (!isValidRemoteVoiceModelRegistration(info.model, info.modelLabel)) return;
    const frame: RemoteVoiceProviderRegisterFrame = {
      type: 'voice.provider.register',
      deviceId: info.deviceId,
      ...(info.deviceName ? { deviceName: info.deviceName } : {}),
      ...(info.hostname ? { hostname: info.hostname } : {}),
      ...(info.localServerId ? { localServerId: info.localServerId } : {}),
      model: info.model,
      modelLabel: info.modelLabel,
      ready: info.ready,
      busy: info.busy,
    };
    this.safeSend(frame);
  }

  private handleIpcEvent(ev: PcAppRemoteVoiceEvent): void {
    if (!this.running || !ev || typeof ev.type !== 'string') return;
    if (ev.type === 'provider.info') {
      this.currentInfo = ev.info;
      if (ev.info?.deviceId) {
        _localPcAppDeviceId = ev.info.deviceId;
      }
      if (!ev.info || !ev.info.ready) {
        // Unregister immediately when switched to system speech or model becomes unavailable.
        this.closeSocket();
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendRegistration();
      } else if (
        (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING)
        && this.reconnectTimer === null
      ) {
        if (this.ws) {
          this.detachSocket();
        }
        this.reconnectAttempt = 0;
        void this.connectOnce();
      }
      return;
    }

    if (!this.activeSessionId || ev.sessionId !== this.activeSessionId) return;

    if (ev.type === 'voice.session.ready') {
      this.safeSend({ type: 'voice.session.ready', sessionId: ev.sessionId });
      return;
    }
    if (ev.type === 'voice.session.result') {
      // Forward transcripts directly over WS — never log remote speech content.
      this.safeSend({
        type: 'voice.session.result',
        sessionId: ev.sessionId,
        text: ev.text,
        isFinal: ev.isFinal,
      });
      return;
    }
    if (ev.type === 'voice.session.end') {
      this.activeSessionId = null;
      this.safeSend({ type: 'voice.session.end', sessionId: ev.sessionId });
      return;
    }
    if (ev.type === 'voice.session.error') {
      this.activeSessionId = null;
      this.safeSend({
        type: 'voice.session.error',
        sessionId: ev.sessionId,
        code: sanitizeRemoteVoiceProviderErrorCode(ev.code),
      });
    }
  }

  private async handleServerFrame(raw: unknown, expectedWs: WebSocket, expectedGen: number): Promise<void> {
    let parsed: RemoteVoiceServerFrame;
    try {
      parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as RemoteVoiceServerFrame;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
    if (parsed.type === 'pong') return;
    if (parsed.type === 'voice.provider.ping') {
      this.safeSend({ type: 'voice.provider.pong' });
      return;
    }
    const voice = this.getVoiceBridge();
    if (!voice) return;

    if (parsed.type === 'voice.session.start') {
      this.activeSessionId = parsed.sessionId;
      const res = await voice.startRemoteSession?.({
        sessionId: parsed.sessionId,
        ...(parsed.locale ? { locale: parsed.locale } : {}),
      }).catch(() => ({ ok: false, error: 'not_ready' }));
      const stillValid = this.running
        && this.ws === expectedWs
        && expectedGen === this.connectionGen
        && this.activeSessionId === parsed.sessionId;
      if (!stillValid) {
        if (res?.ok) {
          void voice.stopRemoteSession?.({ sessionId: parsed.sessionId, abort: true }).catch(() => {});
        }
        return;
      }
      if (!res || !res.ok) {
        this.activeSessionId = null;
        const code = res?.error === 'busy' ? 'provider_busy' : 'provider_not_ready';
        this.safeSend({ type: 'voice.session.error', sessionId: parsed.sessionId, code });
      }
      return;
    }

    if (parsed.type === 'voice.session.audio') {
      if (this.activeSessionId !== parsed.sessionId) return;
      const res = await voice.pushRemotePcm?.({
        sessionId: parsed.sessionId,
        pcmBase64: parsed.pcmBase64,
      }).catch(() => ({ ok: false, error: 'worker_write_failed' }));
      if (!this.running || this.ws !== expectedWs || expectedGen !== this.connectionGen) return;
      if (res && !res.ok && res.error === 'session_not_found') {
        this.safeSend({
          type: 'voice.session.error',
          sessionId: parsed.sessionId,
          code: 'session_not_found',
        });
      }
      return;
    }

    if (parsed.type === 'voice.session.stop') {
      await voice.stopRemoteSession?.({ sessionId: parsed.sessionId, abort: false }).catch(() => {});
      return;
    }

    if (parsed.type === 'voice.session.abort') {
      if (this.activeSessionId === parsed.sessionId) {
        this.activeSessionId = null;
      }
      await voice.stopRemoteSession?.({ sessionId: parsed.sessionId, abort: true }).catch(() => {});
    }
  }

  private reconnectHalfOpenSocket(ws: WebSocket, gen: number): void {
    if (!this.running || this.ws !== ws || gen !== this.connectionGen) return;
    this.detachSocket({ closeCode: 4000, closeReason: 'heartbeat_timeout' });
    this.reconnectAttempt = 0;
    void this.connectOnce();
  }

  private handleWakeOrOnline(): void {
    if (!this.running || !this.currentInfo || !this.currentInfo.ready) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (ws) {
        this.detachSocket();
      } else {
        this.clearTimers();
      }
      this.reconnectAttempt = 0;
      void this.connectOnce();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      const pongTimeoutMs = this.deps.pongTimeoutMs ?? PONG_TIMEOUT_MS;
      if (Date.now() - this.lastActivityAt >= pongTimeoutMs) {
        this.reconnectHalfOpenSocket(ws, this.connectionGen);
      } else {
        this.safeSend({ type: 'ping' });
      }
    }
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.connectionGen) return;
    if (!this.currentInfo || !this.currentInfo.ready) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running || gen !== this.connectionGen) return;
      void this.connectOnce();
    }, delay);
  }

  private async connectOnce(): Promise<void> {
    if (!this.running) return;
    if (!this.currentInfo || !this.currentInfo.ready) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.ws) {
      this.detachSocket();
    }

    const gen = ++this.connectionGen;
    let ticket: string;
    try {
      const res = await (this.deps.fetchTicket ? this.deps.fetchTicket() : fetchRemoteVoiceWsTicket());
      ticket = res.ticket;
    } catch {
      this.scheduleReconnect(gen);
      return;
    }

    if (!this.running || gen !== this.connectionGen) return;
    if (!this.currentInfo || !this.currentInfo.ready) return;

    const wsBase = this.deps.getWsBaseUrl ? this.deps.getWsBaseUrl() : getApiBaseUrl();
    const wsUrl = buildRemoteVoiceWsUrl(wsBase, ticket);
    let ws: WebSocket;
    try {
      ws = this.deps.createSocket ? this.deps.createSocket(wsUrl) : new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    this.ws = ws;

    const pingIntervalMs = this.deps.pingIntervalMs ?? PING_INTERVAL_MS;
    const pongTimeoutMs = this.deps.pongTimeoutMs ?? PONG_TIMEOUT_MS;

    ws.addEventListener('open', () => {
      if (!this.running || this.ws !== ws || gen !== this.connectionGen) {
        try { ws.close(1000, 'stale'); } catch { /* ignore */ }
        return;
      }
      this.reconnectAttempt = 0;
      this.lastActivityAt = Date.now();
      this.sendRegistration();
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (!this.running || this.ws !== ws || gen !== this.connectionGen) {
          this.clearTimers();
          return;
        }
        if (Date.now() - this.lastActivityAt >= pongTimeoutMs) {
          this.reconnectHalfOpenSocket(ws, gen);
          return;
        }
        this.safeSend({ type: 'ping' });
      }, pingIntervalMs);
    });

    ws.addEventListener('message', (event) => {
      if (!this.running || this.ws !== ws || gen !== this.connectionGen) return;
      this.lastActivityAt = Date.now();
      void this.handleServerFrame((event as MessageEvent).data, ws, gen);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.detachSocket();
      this.scheduleReconnect(gen);
    });

    ws.addEventListener('error', () => {
      // Close event handles cleanup & reconnect.
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    const voice = this.getVoiceBridge();
    if (!voice) return;
    this.running = true;
    this.reconnectAttempt = 0;

    if (typeof voice.subscribeRemoteEvents === 'function') {
      this.unsubIpc = voice.subscribeRemoteEvents((ev) => this.handleIpcEvent(ev));
    }

    const onOnline = () => { this.handleWakeOrOnline(); };
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.handleWakeOrOnline();
      }
    };
    const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
    const hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    if (hasWindow) window.addEventListener('online', onOnline);
    if (hasDocument) document.addEventListener('visibilitychange', onVisibilityChange);
    this.removeWakeListeners = () => {
      if (hasWindow && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', onOnline);
      }
      if (hasDocument && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };

    try {
      let info = await voice.getRemoteProviderInfo!();
      if (!this.running) return;
      if (info?.busy && this.activeSessionId === null && typeof voice.stopRemoteSession === 'function') {
        await voice.stopRemoteSession({ sessionId: '*', abort: true }).catch(() => {});
        if (!this.running) return;
        info = await voice.getRemoteProviderInfo!();
        if (!this.running) return;
      }
      this.currentInfo = info;
      if (info?.deviceId) {
        _localPcAppDeviceId = info.deviceId;
      }
      if (info && info.ready) {
        await this.connectOnce();
      }
    } catch {
      // Wait for provider.info events or next lifecycle start.
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.connectionGen += 1;
    this.closeSocket();
    this.unsubIpc?.();
    this.unsubIpc = null;
    this.removeWakeListeners?.();
    this.removeWakeListeners = null;
  }
}

export const remoteVoiceProvider = new RemoteVoiceProviderController();
