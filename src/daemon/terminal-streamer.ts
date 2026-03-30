/**
 * Terminal streaming via tmux pipe-pane -O raw PTY stream.
 * Replaces polling capture-pane approach.
 *
 * Per-subscriber flow:
 *   1. capturePaneVisible() → fullFrame snapshot → sent to subscriber
 *   2. startPipePaneStream() → raw PTY bytes forwarded to subscribers
 *
 * Subscribers joining an already-running stream get a snapshot barrier:
 *   - rawBuffer during snapshotPending (up to 256KB, else fail_subscriber)
 *   - flush buffer after snapshot completes
 *
 * Dual-layer idle detection:
 *   - Any raw bytes → reset idle timer → emit session.state(running) if was idle
 *   - No raw bytes for IDLE_THRESHOLD_MS → emit session.state(idle)
 */

import type { Readable } from 'stream';
import { BACKEND, capturePaneVisible, capturePaneHistory, getPaneId, getPaneSize, sessionExists, startPipePaneStream, stopPipePaneStream } from '../agent/tmux.js';
import { getSession, upsertSession } from '../store/session-store.js';
import { processRawPtyData, resetParser } from './terminal-parser.js';
import { isWatching } from './jsonl-watcher.js';
import { isWatching as isCodexWatching } from './codex-watcher.js';
import { isWatching as isGeminiWatching } from './gemini-watcher.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import type { TerminalDiff, TerminalHistory } from '../shared/transport/terminal.js';

const IDLE_THRESHOLD_MS = 5_000; // 5s without raw bytes → idle (Stop hook fires immediately; this is fallback)
const MAX_RAW_BUFFER = 256 * 1024; // 256KB per-subscriber snapshot-pending buffer
const REBIND_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_REBIND_ATTEMPTS = 5;

export type { TerminalDiff, TerminalHistory } from '../shared/transport/terminal.js';

export interface StreamSubscriber {
  sessionName: string;
  /** Send a fullFrame snapshot or diff (snapshot uses fullFrame: true). */
  send: (diff: TerminalDiff) => void;
  /** Send raw PTY bytes directly to the terminal renderer. */
  sendRaw?: (data: Buffer) => void;
  /** Send a control message (e.g. terminal.stream_reset). */
  sendControl?: (msg: { type: string; [key: string]: unknown }) => void;
  sendHistory?: (history: TerminalHistory) => void;
  onError?: (err: Error) => void;
}

interface SubscriberState {
  snapshotPending: boolean;
  rawBuffer: Buffer[];
  rawBufferBytes: number;
}

interface PipeState {
  stream: Readable;
  cleanup: () => Promise<void>;
  retryCount: number;
}

// ── TerminalStreamer ───────────────────────────────────────────────────────────

export class TerminalStreamer {
  /** session → subscriber → state */
  private subscribers = new Map<string, Map<StreamSubscriber, SubscriberState>>();
  private pipes = new Map<string, PipeState>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Idle detection
  private lastRawAt = new Map<string, number>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleState = new Map<string, boolean>();

  // Size cache for snapshots (refreshed every 5s)
  private sizeCache = new Map<string, { cols: number; rows: number; ts: number }>();
  private static readonly SIZE_CACHE_MS = 5_000;

  private frameSeqs = new Map<string, number>();

  subscribe(subscriber: StreamSubscriber): () => void {
    const { sessionName } = subscriber;

    if (!this.subscribers.has(sessionName)) {
      this.subscribers.set(sessionName, new Map());
    }
    const subs = this.subscribers.get(sessionName)!;
    const hasPipe = this.pipes.has(sessionName);

    const subState: SubscriberState = {
      // If pipe already running, buffer raw bytes until snapshot delivered
      snapshotPending: hasPipe,
      rawBuffer: [],
      rawBufferBytes: 0,
    };
    subs.set(subscriber, subState);

    // Async: take snapshot then start pipe (for first subscriber) or flush buffer
    void this.bootstrapSubscriber(sessionName, subscriber, subState, hasPipe);

    return () => this.unsubscribe(subscriber);
  }

  private async bootstrapSubscriber(
    sessionName: string,
    subscriber: StreamSubscriber,
    subState: SubscriberState,
    hasPipe: boolean,
  ): Promise<void> {
    // 1. Take snapshot
    try {
      const size = await this.getSize(sessionName);
      const raw = await capturePaneVisible(sessionName);
      const lines = raw.split('\n').slice(0, size.rows);
      while (lines.length < size.rows) lines.push('');

      const diff: TerminalDiff = {
        sessionName,
        timestamp: Date.now(),
        lines: lines.map((l, i) => [i, l] as [number, string]),
        cols: size.cols,
        rows: size.rows,
        frameSeq: this.nextFrameSeq(sessionName),
        fullFrame: true,
        snapshotRequested: false,
        scrolled: false,
        newLineCount: 0,
      };

      // Check subscriber is still active
      if (!this.subscribers.get(sessionName)?.has(subscriber)) return;
      subscriber.send(diff);
    } catch (err) {
      logger.warn({ sessionName, err }, 'Snapshot failed during subscribe');
      // Continue — raw stream may still recover state
    }

    // ConPTY: replay raw screen buffer after snapshot for accurate terminal state
    if (BACKEND === 'conpty') {
      try {
        const { conptyGetScreenBuffer } = await import('../agent/conpty.js');
        const screen = conptyGetScreenBuffer(sessionName);
        if (screen && this.subscribers.get(sessionName)?.has(subscriber)) {
          try { subscriber.sendRaw?.(Buffer.from(screen)); } catch { /* ignore */ }
        }
      } catch { /* conpty not available */ }
    }

    // 2. Flush buffered raw bytes immediately after snapshot — never block live
    //    PTY forwarding for history capture (which can be slow under load).
    subState.snapshotPending = false;
    for (const chunk of subState.rawBuffer) {
      if (!this.subscribers.get(sessionName)?.has(subscriber)) break;
      try { subscriber.sendRaw?.(chunk); } catch { /* ignore */ }
    }
    subState.rawBuffer = [];
    subState.rawBufferBytes = 0;

    // 3. Send scrollback history asynchronously (best-effort, never blocks raw stream)
    if (subscriber.sendHistory) {
      void (async () => {
        try {
          const historyContent = await capturePaneHistory(sessionName);
          if (historyContent && this.subscribers.get(sessionName)?.has(subscriber)) {
            subscriber.sendHistory!({ sessionName, content: historyContent });
          }
        } catch { /* best-effort */ }
      })();
    }

    // 4. Start pipe if this was the first subscriber
    if (!hasPipe && this.subscribers.get(sessionName)?.has(subscriber)) {
      await this.startPipe(sessionName, 0);
    }
  }

  unsubscribe(subscriber: StreamSubscriber): void {
    const { sessionName } = subscriber;
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;

    subs.delete(subscriber);

    if (subs.size === 0) {
      this.subscribers.delete(sessionName);
      void this.stopPipe(sessionName);
      this.clearIdleTimer(sessionName);
      this.lastRawAt.delete(sessionName);
      this.idleState.delete(sessionName);
      this.sizeCache.delete(sessionName);
      this.frameSeqs.delete(sessionName);
      resetParser(sessionName);
    }
  }

  /** Request an on-demand snapshot for all subscribers of a session. */
  requestSnapshot(sessionName: string): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs || subs.size === 0) return;

    void (async () => {
      try {
        const size = await this.getSize(sessionName);
        const raw = await capturePaneVisible(sessionName);
        const lines = raw.split('\n').slice(0, size.rows);
        while (lines.length < size.rows) lines.push('');

        const diff: TerminalDiff = {
          sessionName,
          timestamp: Date.now(),
          lines: lines.map((l, i) => [i, l] as [number, string]),
          cols: size.cols,
          rows: size.rows,
          frameSeq: this.nextFrameSeq(sessionName),
          fullFrame: true,
          snapshotRequested: true,
          scrolled: false,
          newLineCount: 0,
        };

        for (const [sub] of subs) {
          try { sub.send(diff); } catch { /* ignore */ }
        }

        // ConPTY: ring buffer snapshot is approximate (no cursor/ANSI state).
        // Replay recent raw PTY output so xterm.js can render the real screen.
        if (BACKEND === 'conpty') {
          try {
            const { conptyGetScreenBuffer } = await import('../agent/conpty.js');
            const screen = conptyGetScreenBuffer(sessionName);
            if (screen) {
              const buf = Buffer.from(screen);
              for (const [sub] of subs) {
                try { sub.sendRaw?.(buf); } catch { /* ignore */ }
              }
            }
          } catch { /* conpty not available */ }
        }

        timelineEmitter.emit(sessionName, 'terminal.snapshot', { lines, cols: size.cols, rows: size.rows });
      } catch (err) {
        logger.warn({ sessionName, err }, 'requestSnapshot failed');
      }
    })();
  }

  /** Invalidate size cache (call after resize events). */
  invalidateSize(sessionName: string): void {
    this.sizeCache.delete(sessionName);
  }

  /** No-op in new design (no polling loop to nudge). Kept for API compat. */
  nudge(_sessionName: string): void {
    // Raw stream is always live — no nudge needed
  }

  /** Called by session-manager when a session restarts with a new pane. */
  async rebindSession(sessionName: string): Promise<void> {
    if (!this.subscribers.has(sessionName)) return;
    await this.stopPipe(sessionName);
    await this.startPipe(sessionName, 0);
    // Re-snapshot all subscribers
    this.requestSnapshot(sessionName);
  }

  destroy(): void {
    for (const [sessionName] of this.subscribers) {
      void this.stopPipe(sessionName);
      this.clearIdleTimer(sessionName);
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.subscribers.clear();
    this.pipes.clear();
    this.retryTimers.clear();
    this.lastRawAt.clear();
    this.idleTimers.clear();
    this.idleState.clear();
  }

  // ── Pipe lifecycle ──────────────────────────────────────────────────────────

  private async startPipe(sessionName: string, retryCount: number): Promise<void> {
    const session = getSession(sessionName);
    let paneId = session?.paneId;
    if (!paneId) {
      // Session created before paneId persistence — fetch dynamically from tmux
      const fetched = getPaneId(sessionName);
      paneId = fetched != null ? await fetched.catch(() => undefined) : undefined;
      if (paneId && session != null) {
        upsertSession({ ...session, paneId });
      }
    }
    if (!paneId) {
      logger.error({ sessionName }, 'Cannot start pipe-pane: paneId not available — restart session to fix');
      // Do not remove subscribers: they can still receive on-demand snapshots
      return;
    }

    try {
      const { stream, cleanup } = await startPipePaneStream(sessionName, paneId);

      const pipeState: PipeState = { stream, cleanup, retryCount };
      this.pipes.set(sessionName, pipeState);

      stream.on('data', (chunk: unknown) => {
        this.onRawData(sessionName, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      });

      stream.on('error', (err) => {
        logger.warn({ sessionName, err }, 'Pipe stream error');
        this.handlePipeClose(sessionName);
      });

      stream.on('close', () => {
        // Unexpected close (e.g. FIFO fd error)
        if (this.pipes.has(sessionName)) {
          this.handlePipeClose(sessionName);
        }
      });

      logger.info({ sessionName, paneId }, 'Pipe-pane stream started');
    } catch (err) {
      logger.error({ sessionName, err }, 'Failed to start pipe-pane stream');
      if (retryCount < MAX_REBIND_ATTEMPTS) {
        this.scheduleRebind(sessionName, retryCount + 1);
      } else {
        this.errorAllSubscribers(sessionName, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async stopPipe(sessionName: string): Promise<void> {
    const timer = this.retryTimers.get(sessionName);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(sessionName);
    }

    const pipeState = this.pipes.get(sessionName);
    if (!pipeState) return;
    this.pipes.delete(sessionName);

    pipeState.stream.destroy();
    try { await pipeState.cleanup(); } catch (err) {
      logger.warn({ sessionName, err }, 'Pipe cleanup error');
    }
    try { await stopPipePaneStream(sessionName); } catch { /* best-effort */ }
  }

  private handlePipeClose(sessionName: string): void {
    this.pipes.delete(sessionName);

    // If still have active subscribers, attempt rebind
    const subs = this.subscribers.get(sessionName);
    if (subs && subs.size > 0) {
      logger.info({ sessionName }, 'Pipe closed unexpectedly — scheduling rebind');
      this.scheduleRebind(sessionName, 0);
    }
  }

  /** Called after a session is newly created to start the pipe for any waiting subscribers. */
  retryPipeIfSubscribers(sessionName: string): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs || subs.size === 0) return;
    if (this.pipes.has(sessionName)) return;
    if (this.retryTimers.has(sessionName)) return;
    void this.startPipe(sessionName, 0);
  }

  private scheduleRebind(sessionName: string, attempt: number): void {
    const delay = REBIND_DELAYS_MS[Math.min(attempt, REBIND_DELAYS_MS.length - 1)];
    const timer = setTimeout(async () => {
      this.retryTimers.delete(sessionName);

      // Check if still have subscribers
      const subs = this.subscribers.get(sessionName);
      if (!subs || subs.size === 0) return;

      if (attempt >= MAX_REBIND_ATTEMPTS) {
        logger.error({ sessionName }, 'Pipe rebind: max retries exceeded');
        this.errorAllSubscribers(sessionName, new Error('Terminal stream unavailable after max retries'));
        return;
      }

      // Check if session still alive
      const alive = await sessionExists(sessionName).catch(() => false);
      if (!alive) {
        logger.warn({ sessionName }, 'Session gone, stopping pipe rebind');
        this.errorAllSubscribers(sessionName, new Error('Session no longer exists'));
        return;
      }

      logger.info({ sessionName, attempt }, 'Rebinding pipe-pane stream');
      await this.startPipe(sessionName, attempt);
    }, delay);

    this.retryTimers.set(sessionName, timer);
  }

  // ── Raw data handling ───────────────────────────────────────────────────────

  private onRawData(sessionName: string, data: Buffer): void {
    const hasStructuredWatcher = isWatching(sessionName) || isCodexWatching(sessionName) || isGeminiWatching(sessionName);

    // Idle detection: skip for sessions with a structured watcher (CC/Codex).
    // Those sessions get authoritative idle/running signals via hooks and JSONL events,
    // so raw bytes (cursor blink, prompt redraws) must not cause spurious oscillation.
    if (!hasStructuredWatcher) {
      const wasIdle = this.idleState.get(sessionName) ?? false;
      this.lastRawAt.set(sessionName, Date.now());
      if (wasIdle) {
        this.idleState.set(sessionName, false);
        timelineEmitter.emit(sessionName, 'session.state', { state: 'running' });
        const sess = getSession(sessionName);
        if (sess) upsertSession({ ...sess, state: 'running', updatedAt: Date.now() });
      }
      this.resetIdleTimer(sessionName);
    }

    // Text extraction — skip if a structured watcher is active (higher quality source),
    // or if this is a sub-session (deck_sub_*): sub-sessions always use JSONL or TerminalView,
    // never terminal-parse for chat timeline events. This prevents garbled output during
    // the window between daemon restart and the codex watcher being re-established.
    const isSubSession = sessionName.startsWith('deck_sub_');
    if (!hasStructuredWatcher && !isSubSession) {
      processRawPtyData(sessionName, data);
    }

    // Forward to subscribers
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;

    for (const [sub, state] of subs) {
      if (state.snapshotPending) {
        // Buffer raw bytes while snapshot is pending
        state.rawBuffer.push(data);
        state.rawBufferBytes += data.length;
        if (state.rawBufferBytes > MAX_RAW_BUFFER) {
          this.failSubscriber(sessionName, sub, state);
        }
      } else {
        try {
          sub.sendRaw?.(data);
        } catch (err) {
          sub.onError?.(err instanceof Error ? err : new Error(String(err)));
          this.removeSubscriber(sessionName, sub);
        }
      }
    }
  }

  private failSubscriber(sessionName: string, sub: StreamSubscriber, state: SubscriberState): void {
    // Discard buffer and remove subscriber
    state.rawBuffer = [];
    state.rawBufferBytes = 0;
    this.removeSubscriber(sessionName, sub);

    // Notify client to reset and resubscribe
    try {
      sub.sendControl?.({ type: 'terminal.stream_reset', session: sessionName, reason: 'raw_buffer_overflow' });
    } catch {
      sub.onError?.(new Error('raw_buffer_overflow'));
    }
  }

  private removeSubscriber(sessionName: string, sub: StreamSubscriber): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;
    subs.delete(sub);
    if (subs.size === 0) {
      this.subscribers.delete(sessionName);
      void this.stopPipe(sessionName);
      this.clearIdleTimer(sessionName);
      this.lastRawAt.delete(sessionName);
      this.idleState.delete(sessionName);
    }
  }

  private errorAllSubscribers(sessionName: string, err: Error): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;
    for (const [sub] of subs) {
      try { sub.onError?.(err); } catch { /* ignore */ }
    }
    this.subscribers.delete(sessionName);
    void this.stopPipe(sessionName);
    this.clearIdleTimer(sessionName);
  }

  // ── Idle detection ──────────────────────────────────────────────────────────

  private resetIdleTimer(sessionName: string): void {
    this.clearIdleTimer(sessionName);
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionName);
      const currentlyIdle = this.idleState.get(sessionName) ?? false;
      const sess = getSession(sessionName);
      if (sess?.agentType === 'codex' && isCodexWatching(sessionName)) {
        return; // Codex has stronger structured idle signals via JSONL/hook
      }
      if (sess?.agentType === 'gemini' && isGeminiWatching(sessionName)) {
        return; // Gemini has stronger structured idle signals via JSON watcher
      }
      if (!currentlyIdle) {
        this.idleState.set(sessionName, true);
        timelineEmitter.emit(sessionName, 'session.state', { state: 'idle' });
        if (sess) upsertSession({ ...sess, state: 'idle', updatedAt: Date.now() });
      }
    }, IDLE_THRESHOLD_MS);
    this.idleTimers.set(sessionName, timer);
  }

  private clearIdleTimer(sessionName: string): void {
    const timer = this.idleTimers.get(sessionName);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionName);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async getSize(sessionName: string): Promise<{ cols: number; rows: number }> {
    const cached = this.sizeCache.get(sessionName);
    if (cached && Date.now() - cached.ts < TerminalStreamer.SIZE_CACHE_MS) {
      return { cols: cached.cols, rows: cached.rows };
    }
    try {
      const size = await getPaneSize(sessionName);
      this.sizeCache.set(sessionName, { ...size, ts: Date.now() });
      return size;
    } catch {
      return { cols: 80, rows: 24 };
    }
  }

  private nextFrameSeq(sessionName: string): number {
    const seq = (this.frameSeqs.get(sessionName) ?? 0) + 1;
    this.frameSeqs.set(sessionName, seq);
    return seq;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const terminalStreamer = new TerminalStreamer();
