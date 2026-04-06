/**
 * OpenClaw TransportProvider
 *
 * Connects to a local OpenClaw gateway via WebSocket, completes the
 * connect-challenge handshake, and routes messages to/from OC agent sessions.
 *
 * Connection mode : persistent  (long-lived WebSocket, reconnects on drop)
 * Session ownership: provider   (OpenClaw owns history and session state)
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  TransportProvider,
  ProviderConfig,
  SessionConfig,
  ProviderCapabilities,
  ProviderError,
  RemoteSessionInfo,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';
import { normalizeOpenClawDisplayName } from '../openclaw-display.js';

// ── Internal frame types ─────────────────────────────────────────────────────

interface OcFrame {
  type: 'req' | 'res' | 'event';
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  payload?: unknown;
  event?: string;
}

interface OcResolvePair {
  resolve: (payload: unknown) => void;
  reject: (err: ProviderError) => void;
}

// How long to wait for a single RPC response before timing out (ms).
const RPC_TIMEOUT_MS = 30_000;

// Reconnect backoff: starts at 1 s, doubles each attempt, caps at 5 min.
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60 * 1_000;

// If we receive no tick within this window we consider the connection stale.
const TICK_STALE_MS = 90_000;

// ── Session key sanitisation ─────────────────────────────────────────────────
// OC keys use `:` (e.g. `agent:main:discord:channel:123`) which breaks tmux
// names, file paths, regexes, and `split('_')` patterns throughout IM.codes.
// Replace `:` with `___` at the provider boundary so internal code never sees `:`.

/** OC key → safe internal key */
function sanitizeKey(key: string): string { return key.replaceAll(':', '___'); }
/** Safe internal key → OC key */
function unsanitizeKey(key: string): string { return key.replaceAll('___', ':'); }
/** Returns true if a raw OC key contains `___`, which would cause unsanitize collision. */
function hasCollisionRisk(rawKey: string): boolean { return rawKey.includes('___'); }

// ── OpenClawProvider ─────────────────────────────────────────────────────────

export class OpenClawProvider implements TransportProvider {
  readonly id = 'openclaw';
  readonly connectionMode = CONNECTION_MODES.PERSISTENT;
  readonly sessionOwnership = SESSION_OWNERSHIP.PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: false,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
  };

  // ── Private state ──────────────────────────────────────────────────────────

  private config: ProviderConfig | null = null;
  private ws: WebSocket | null = null;

  /** Pending RPC calls keyed by request id. */
  private pending = new Map<string, OcResolvePair>();

  /** Registered callbacks. */
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];

  /** Accumulator: partial text per runId while streaming. */
  private runAccumulator = new Map<string, { sessionId: string; messageId: string; text: string }>();

  /** Reconnect state. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private intentionalDisconnect = false;

  /** Tick / heartbeat state. */
  private lastTickAt = 0;
  private tickStaleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether connect() has resolved successfully at least once. */
  private connected = false;

  /** OC agent ID (e.g. 'main'). Resolved from config on connect. */
  private agentId = 'main';

  // ── TransportProvider — core ───────────────────────────────────────────────

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    this.agentId = (config.agentId as string) || 'main';
    this.intentionalDisconnect = false;
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearTimers();
    this.rejectAllPending('Provider disconnected');
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.runAccumulator.clear();
    logger.info({ provider: this.id }, 'Disconnected from OpenClaw gateway');
  }

  async send(sessionId: string, message: string, _attachments?: unknown[], extraSystemPrompt?: string): Promise<void> {
    const ocKey = unsanitizeKey(sessionId);
    try {
      // Prefer sessions.send (v2026.3.24+): auto canonicalKey, messageSeq, subagent reactivation
      await this.rpc('sessions.send', {
        key: ocKey,
        message,
        thinking: 'off',
        idempotencyKey: randomUUID(),
        ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
      });
      logger.info({ provider: this.id, ocKey }, 'sessions.send succeeded');
    } catch (err) {
      logger.debug({ provider: this.id, ocKey, err: (err as Error).message }, 'sessions.send failed, falling back to agent RPC');
      // Fallback to agent RPC (v2026.3.7+)
      await this.rpc('agent', {
        sessionKey: ocKey,
        message,
        agentId: this.agentId,
        thinking: 'off',
        idempotencyKey: randomUUID(),
        ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
      });
      logger.info({ provider: this.id, ocKey }, 'agent RPC fallback succeeded');
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const ocKey = unsanitizeKey(sessionId);
    try {
      await this.rpc('sessions.send', {
        key: ocKey,
        message: '/stop',
        thinking: 'off',
        idempotencyKey: randomUUID(),
      });
    } catch {
      await this.rpc('agent', {
        sessionKey: ocKey,
        message: '/stop',
        agentId: this.agentId,
        thinking: 'off',
        idempotencyKey: randomUUID(),
      });
    }
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { const i = this.deltaCallbacks.indexOf(cb); if (i >= 0) this.deltaCallbacks.splice(i, 1); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { const i = this.completeCallbacks.indexOf(cb); if (i >= 0) this.completeCallbacks.splice(i, 1); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { const i = this.errorCallbacks.indexOf(cb); if (i >= 0) this.errorCallbacks.splice(i, 1); };
  }

  async createSession(config: SessionConfig): Promise<string> {
    // bindExistingKey may already be sanitized (from UI), unsanitize for OC RPC
    const ocKey = unsanitizeKey(config.bindExistingKey ?? config.sessionKey);
    const agentId = config.agentId ?? this.agentId;
    if (!config.skipCreate) {
      try {
        // Prefer sessions.create (v2026.3.24+)
        await this.rpc('sessions.create', {
          key: ocKey,
          agentId,
          label: config.label ?? ocKey,
        });
      } catch {
        // Fallback: OC auto-creates sessions on first agent RPC, so just log
        logger.info({ provider: this.id, sessionKey: ocKey }, 'sessions.create unavailable, session will be created on first message');
      }
    }
    // OC namespaces sessions as `agent:{agentId}:{key}`. When binding an existing
    // key the caller already provides the full canonical key; for new sessions we
    // must construct it so the providerRoute matches events coming back from OC.
    const canonicalKey = config.bindExistingKey
      ? ocKey
      : `agent:${agentId}:${ocKey}`;
    logger.info({ provider: this.id, sessionKey: ocKey, canonicalKey }, 'Session created');
    // Return sanitized key — all internal code sees `___` instead of `:`
    return sanitizeKey(canonicalKey);
  }

  async endSession(sessionId: string): Promise<void> {
    const ocKey = unsanitizeKey(sessionId);
    try {
      await this.rpc('sessions.delete', { key: ocKey });
      logger.info({ provider: this.id, ocKey }, 'OC session deleted');
    } catch (err) {
      logger.debug({ provider: this.id, ocKey, err: (err as Error).message }, 'sessions.delete failed (may not be supported)');
    }
  }

  // ── Optional capabilities ──────────────────────────────────────────────────

  async restoreSession(sessionId: string): Promise<boolean> {
    try {
      const sessions = await this.listSessions();
      return sessions.some((s) => s.key === sessionId);
    } catch {
      return false;
    }
  }

  /** Convert internal sanitized key back to OC key for RPC calls. */
  toProviderKey(sessionId: string): string { return unsanitizeKey(sessionId); }

  async listSessions(): Promise<RemoteSessionInfo[]> {
    try {
      const payload = await this.rpc('sessions.list', {}) as { sessions?: Array<{
        key: string;
        label?: string;
        displayName?: string;
        agentId?: string;
        updatedAt?: number | null;
        percentUsed?: number;
      }> };
      const all = payload?.sessions ?? [];
      return all
        .filter((s) => {
          if (!s || typeof s.key !== 'string' || !s.key) return false;
          if (s.updatedAt == null) return false;
          if (s.key.includes(':cron:')) return false;
          if (hasCollisionRisk(s.key)) { logger.warn({ key: s.key }, 'Skipping OC session — raw key contains ___'); return false; }
          return true;
        })
        .map((s) => ({
          key: sanitizeKey(s.key),
          displayName: normalizeOpenClawDisplayName(s.displayName ?? s.label),
          agentId: s.agentId,
          updatedAt: s.updatedAt ?? undefined,
          percentUsed: s.percentUsed,
        }));
    } catch (err) {
      // Gateway may fail on sessions with incomplete metadata — return empty
      logger.warn({ provider: this.id, err }, 'sessions.list failed — returning empty');
      return [];
    }
  }

  // ── WebSocket management ───────────────────────────────────────────────────

  private async openSocket(): Promise<void> {
    const url = (this.config?.url as string | undefined) ?? 'ws://127.0.0.1:18789';
    const token = (this.config?.token as string | undefined) ?? (this.config?.apiKey as string | undefined) ?? '';

    logger.info({ provider: this.id, url }, 'Connecting to OpenClaw gateway');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      // We gate the promise on the handshake completing.
      let handshakeDone = false;

      const failHandshake = (err: unknown): void => {
        if (!handshakeDone) {
          handshakeDone = true;
          ws.removeAllListeners();
          ws.close();
          reject(this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, String(err), false, err));
        }
      };

      ws.once('error', failHandshake);

      ws.on('message', (raw: Buffer | string) => {
        let frame: OcFrame;
        try {
          frame = JSON.parse(raw.toString()) as OcFrame;
        } catch {
          logger.warn({ provider: this.id, raw: raw.toString() }, 'Unparseable frame from gateway');
          return;
        }

        // ── Handshake sequence ──────────────────────────────────────────────
        if (!handshakeDone) {
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            const challengePayload = frame.payload as { nonce?: string } | undefined;
            logger.debug({ provider: this.id, nonce: challengePayload?.nonce }, 'Received connect.challenge');
            const connectReq: OcFrame = {
              type: 'req',
              id: randomUUID(),
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'gateway-client',
                  version: '0.1.0',
                  platform: process.platform,
                  mode: 'backend',
                  displayName: 'imcodes-daemon',
                },
                auth: { token },
                role: 'operator',
                scopes: ['operator.write', 'operator.read', 'operator.admin'],
              },
            };
            ws.send(JSON.stringify(connectReq));
            return;
          }

          // hello-ok may arrive as top-level `type: "hello-ok"` OR nested
          // inside a res frame as `payload.type: "hello-ok"` (OC v2026.3.7+).
          const frameType = frame.type as string;
          const payloadType = (frame.payload as Record<string, unknown> | undefined)?.type;
          const isHelloOk =
            frameType === 'hello-ok' ||
            (frameType === 'event' && frame.event === 'hello-ok') ||
            (frameType === 'res' && frame.ok === true && payloadType === 'hello-ok');

          if (isHelloOk) {
            handshakeDone = true;
            this.connected = true;
            this.backoffMs = BACKOFF_INITIAL_MS;
            ws.removeListener('error', failHandshake);
            ws.on('error', (err) => this.handleWsError(err));
            ws.on('close', (code, reason) => this.handleWsClose(code, reason));
            this.resetTickTimer();
            logger.info({ provider: this.id, url }, 'OpenClaw handshake complete');
            resolve();
            return;
          }

          // Non-hello res frames during handshake — keep waiting.
          if (frame.type === 'res' && frame.ok === true) {
            return;
          }

          if (frame.type === 'res' && frame.ok === false) {
            failHandshake(new Error(`Gateway rejected connect: ${JSON.stringify(frame.payload)}`));
            return;
          }

          return;
        }

        // ── Post-handshake frame dispatch ───────────────────────────────────
        this.handleFrame(frame);
      });
    });
  }

  private handleFrame(frame: OcFrame): void {
    switch (frame.type) {
      case 'event':
        this.handleEventFrame(frame);
        break;
      case 'res':
        this.handleResFrame(frame);
        break;
      default:
        break;
    }
  }

  private handleEventFrame(frame: OcFrame): void {
    const event = frame.event;

    if (event === 'tick') {
      this.lastTickAt = Date.now();
      this.resetTickTimer();
      return;
    }

    if (event === 'agent') {
      const p = frame.payload as AgentEventPayload;
      logger.info({ provider: this.id, runId: p?.runId, stream: p?.stream, phase: (p?.data as any)?.phase }, 'Received agent event');
      this.handleAgentEvent(p);
      return;
    }

    if (event === 'chat') {
      this.handleChatEvent(frame.payload as ChatEventPayload);
      return;
    }
  }

  private handleResFrame(frame: OcFrame): void {
    const id = frame.id;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        `RPC failed: ${JSON.stringify(frame.payload)}`,
        true,
        frame.payload,
      ));
    }
  }

  private handleAgentEvent(payload: AgentEventPayload): void {
    if (!payload) return;

    const { runId, stream, data } = payload;

    if (stream === 'lifecycle') {
      const phase = (data as { phase?: string })?.phase;

      if (phase === 'start') {
        const existing = this.runAccumulator.get(runId);
        if (existing) {
          logger.debug({ provider: this.id, runId, sessionId: existing.sessionId }, 'Agent run start ignored — accumulator already exists');
          return;
        }
        // Initialise accumulator for this run.
        // We need sessionId; OpenClaw includes it in the payload as `key` or `sessionKey`.
        // Sanitize `:` → `___` so internal code never sees colons.
        const sessionId = sanitizeKey(payload.key ?? payload.sessionKey ?? runId);
        const messageId = randomUUID();
        this.runAccumulator.set(runId, { sessionId, messageId, text: '' });
        logger.info({ provider: this.id, runId, sessionId, rawKey: payload.key, rawSessionKey: payload.sessionKey }, 'Agent run started');
        return;
      }

      if (phase === 'end') {
        const acc = this.runAccumulator.get(runId);
        if (acc) {
          this.runAccumulator.delete(runId);
          const message: AgentMessage = {
            id: acc.messageId,
            sessionId: acc.sessionId,
            kind: 'text',
            role: 'assistant',
            content: acc.text,
            timestamp: Date.now(),
            status: 'complete',
          };
          this.completeCallbacks.forEach((cb) => cb(acc.sessionId, message));
          logger.debug({ provider: this.id, runId, sessionId: acc.sessionId }, 'Agent run complete');
        }
        return;
      }

      if (phase === 'error') {
        const acc = this.runAccumulator.get(runId);
        const sessionId = acc?.sessionId ?? sanitizeKey(payload.key ?? payload.sessionKey ?? runId);
        this.runAccumulator.delete(runId);
        // Extract actual error message from OC data (e.g. "AI service overloaded", "OAuth token expired")
        const errorData = data as { error?: string; message?: string } | undefined;
        const errorMsg = errorData?.error ?? errorData?.message ?? `Agent run error for session ${sessionId}`;
        logger.warn({ provider: this.id, runId, sessionId, error: errorMsg }, 'OC agent run error');
        const err = this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          errorMsg,
          true,
          data,
        );
        this.errorCallbacks.forEach((cb) => cb(sessionId, err));
        return;
      }
    }

    if (stream === 'error') {
      // Standalone error stream (separate from lifecycle.error)
      const acc = this.runAccumulator.get(runId);
      const sessionId = acc?.sessionId ?? sanitizeKey(payload.key ?? payload.sessionKey ?? runId);
      const errorData = data as { error?: string; message?: string } | undefined;
      const errorMsg = errorData?.error ?? errorData?.message ?? 'Unknown agent error';
      logger.warn({ provider: this.id, runId, sessionId, error: errorMsg }, 'OC agent stream error');
      const err = this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, errorMsg, true, data);
      this.errorCallbacks.forEach((cb) => cb(sessionId, err));
      return;
    }

    if (stream === 'assistant') {
      const assistantData = data as { delta?: string; text?: string } | undefined;
      if (!assistantData) return;

      const acc = this.runAccumulator.get(runId);
      if (!acc) {
        // Received delta before lifecycle start — create accumulator on the fly.
        const sessionId = sanitizeKey(payload.key ?? payload.sessionKey ?? runId);
        const messageId = randomUUID();
        const initialText = assistantData.text ?? assistantData.delta ?? '';
        this.runAccumulator.set(runId, { sessionId, messageId, text: initialText });
        // Emit the cumulative text (same as acc.text) so transport-relay can
        // replace-in-place via stable eventId (typewriter effect).
        const delta: MessageDelta = {
          messageId,
          type: 'text',
          delta: initialText,
          role: 'assistant',
        };
        this.deltaCallbacks.forEach((cb) => cb(sessionId, delta));
        return;
      }

      // Update accumulated text.
      // OC gateway is inconsistent: sometimes `text` is cumulative (starts with acc.text),
      // sometimes it's just the incremental piece (same as `delta`).
      // Detect which case we're in and handle accordingly.
      if (assistantData.text !== undefined && assistantData.text.startsWith(acc.text)) {
        // `text` is cumulative — use it directly as the new accumulator
        acc.text = assistantData.text;
      } else if (assistantData.delta !== undefined) {
        // Incremental delta — append to accumulator
        acc.text += assistantData.delta;
      } else if (assistantData.text !== undefined) {
        // `text` is present but not cumulative and no delta — append text as incremental
        acc.text += assistantData.text;
      }

      const delta: MessageDelta = {
        messageId: acc.messageId,
        type: 'text',
        delta: acc.text,
        role: 'assistant',
      };
      this.deltaCallbacks.forEach((cb) => cb(acc.sessionId, delta));
    }
  }

  private handleChatEvent(payload: ChatEventPayload): void {
    if (!payload) return;
    const { state, key } = payload;

    if (state === 'error') {
      const sessionId = sanitizeKey(key ?? 'unknown');
      const err = this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        `Chat error for session ${sessionId}`,
        true,
        payload,
      );
      this.errorCallbacks.forEach((cb) => cb(sessionId, err));
    }
    // state === 'done' is handled via lifecycle/end; nothing extra needed here.
  }

  // ── RPC helper ─────────────────────────────────────────────────────────────

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.makeError(
        PROVIDER_ERROR_CODES.CONNECTION_LOST,
        'WebSocket not open',
        true,
      ));
    }

    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const frame: OcFrame = { type: 'req', id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          `RPC timeout: ${method}`,
          true,
        ));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (payload) => { clearTimeout(timer); resolve(payload); },
        reject:  (err)     => { clearTimeout(timer); reject(err); },
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  // ── Error helpers ──────────────────────────────────────────────────────────

  private makeError(
    code: string,
    message: string,
    recoverable: boolean,
    details?: unknown,
  ): ProviderError {
    return { code, message, recoverable, details };
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  private handleWsError(err: Error): void {
    logger.warn({ provider: this.id, err: err.message }, 'WebSocket error');
  }

  private handleWsClose(code: number, reason: Buffer): void {
    if (this.intentionalDisconnect) return;

    logger.warn(
      { provider: this.id, code, reason: reason.toString() },
      'WebSocket closed unexpectedly — scheduling reconnect',
    );
    this.connected = false;
    this.rejectAllPending('WebSocket closed');
    this.clearTimers();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);

    logger.info({ provider: this.id, delayMs: delay }, 'Reconnecting to OpenClaw gateway');
    this.reconnectTimer = setTimeout(async () => {
      if (this.intentionalDisconnect) return;
      try {
        await this.openSocket();
        logger.info({ provider: this.id }, 'Reconnected to OpenClaw gateway');
      } catch (err) {
        logger.warn({ provider: this.id, err }, 'Reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Tick / heartbeat ───────────────────────────────────────────────────────

  private resetTickTimer(): void {
    if (this.tickStaleTimer) clearTimeout(this.tickStaleTimer);
    this.tickStaleTimer = setTimeout(() => {
      if (this.intentionalDisconnect) return;
      const age = Date.now() - this.lastTickAt;
      logger.warn({ provider: this.id, ageMs: age }, 'No tick received — connection appears stale, reconnecting');
      this.ws?.close();
    }, TICK_STALE_MS);
  }

  // ── Cleanup helpers ────────────────────────────────────────────────────────

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.tickStaleTimer) { clearTimeout(this.tickStaleTimer); this.tickStaleTimer = null; }
  }

  private rejectAllPending(reason: string): void {
    const err = this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, reason, true);
    for (const pair of this.pending.values()) {
      pair.reject(err);
    }
    this.pending.clear();
  }
}

// ── Internal payload shapes (not exported — only used internally) ─────────────

interface AgentEventPayload {
  runId: string;
  seq?: number;
  stream: string;
  data?: unknown;
  /** Session key — gateway may supply it as `key` or `sessionKey`. */
  key?: string;
  sessionKey?: string;
}

interface ChatEventPayload {
  key?: string;
  state?: string;
  [k: string]: unknown;
}
