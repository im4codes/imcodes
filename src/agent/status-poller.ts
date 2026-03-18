import { capturePane } from './tmux.js';
import { detectStatusMulti } from './detect.js';
import { getDriver } from './session-manager.js';
import type { AgentStatus, AgentType } from './detect.js';
import type { SessionRecord } from '../store/session-store.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import logger from '../util/logger.js';

export type IdleCallback = (session: SessionRecord) => Promise<void>;

export interface StatusPollerOptions {
  pollIntervalMs?: number; // default 2000ms
}

/**
 * StatusPoller monitors sessions for idle transitions via multi-sample polling.
 * Used for brain-worker orchestration (detecting when a worker finishes its task).
 *
 * For push notifications the hook server (hook-server.ts) is used instead.
 */
export class StatusPoller {
  private sessions: Map<string, SessionRecord> = new Map();
  private idleCallbacks: IdleCallback[] = [];
  private lastStatus: Map<string, AgentStatus> = new Map();
  private pollTimer?: NodeJS.Timeout;
  private opts: Required<StatusPollerOptions>;

  constructor(opts?: StatusPollerOptions) {
    this.opts = { pollIntervalMs: opts?.pollIntervalMs ?? 2000 };
  }

  addSession(session: SessionRecord): void {
    this.sessions.set(session.name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    this.lastStatus.delete(name);
  }

  onIdle(cb: IdleCallback): void {
    this.idleCallbacks.push(cb);
  }

  start(): void {
    this.pollTimer = setInterval(() => { void this.pollSessions(); }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async pollSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        const driver = getDriver(session.agentType as AgentType);
        const lines = await capturePane(session.name);
        const status = await detectStatusMulti(
          () => capturePane(session.name),
          session.agentType as AgentType,
        );

        const prev = this.lastStatus.get(session.name);
        this.lastStatus.set(session.name, status);

        if (status === 'idle' && prev !== 'idle') {
          logger.debug({ session: session.name }, 'Polling detected idle');
          await this.triggerIdle(session);
        }

        // Emit thinking event on transition to thinking (terminal-based, real-time)
        if (status === 'thinking' && prev !== 'thinking') {
          timelineEmitter.emit(session.name, 'assistant.thinking', { text: '' }, { source: 'terminal-parse', confidence: 'medium' });
        }

        if (driver.isOverlay(lines)) {
          logger.debug({ session: session.name }, 'Overlay detected');
        }
      } catch (e) {
        logger.warn({ session: session.name, err: e }, 'Status poll error');
      }
    }
  }

  private async triggerIdle(session: SessionRecord): Promise<void> {
    for (const cb of this.idleCallbacks) {
      try {
        await cb(session);
      } catch (e) {
        logger.error({ session: session.name, err: e }, 'Idle callback error');
      }
    }
  }
}
