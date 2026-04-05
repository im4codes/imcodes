import type { AgentStatus } from './detect.js';
import type { AgentMessage } from '../../shared/agent-message.js';

export const RUNTIME_TYPES = {
  PROCESS: 'process',
  TRANSPORT: 'transport',
} as const;

export type RuntimeType = typeof RUNTIME_TYPES[keyof typeof RUNTIME_TYPES];

export interface SessionRuntime {
  /** 'process' for tmux-backed, 'transport' for network-backed */
  readonly type: RuntimeType;

  /** Send a message to the agent. Returns a status string or void. */
  send(message: string): Promise<void> | 'sent' | 'queued';

  /** Get current agent status */
  getStatus(): AgentStatus;

  /** Kill/terminate the session */
  kill(): Promise<void>;

  // Optional capabilities — not all runtimes support these

  /** Get message history (per-request providers need self-managed history) */
  getHistory?(): AgentMessage[];

  /** Pause the session (meaningful for process, not for per-request) */
  pause?(): Promise<void>;

  /** Resume a paused session */
  resume?(): Promise<void>;
}
