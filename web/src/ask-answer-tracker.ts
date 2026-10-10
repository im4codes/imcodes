// Tracks AskUserQuestion answers that left the browser but have not been
// confirmed by the daemon yet, so a refused / lost answer is surfaced to the user
// (with their text) instead of vanishing behind an already-dismissed card.

import { MSG_COMMAND_ACK, MSG_COMMAND_FAILED } from '@shared/ack-protocol.js';
import { ASK_ANSWER_ACK_ERRORS } from '@shared/ask-answer.js';

export interface PendingAskAnswer {
  commandId: string;
  sessionName: string;
  toolUseId: string;
  answer: string;
}

/** Why a sent answer is not known to have reached the model. */
export type AskAnswerFailureReason =
  /** Another command already answered this question; nothing to resend. */
  | 'already_answered'
  /** No confirmation arrived in time. */
  | 'unconfirmed'
  /** The daemon / bridge refused or could not deliver it. */
  | 'failed';

export interface AskAnswerFailure {
  sessionName: string;
  toolUseId: string;
  answer: string;
  reason: AskAnswerFailureReason;
}

export type AskAnswerSignal =
  | { commandId: string; kind: 'confirmed' }
  | { commandId: string; kind: 'failed'; reason: AskAnswerFailureReason };

/**
 * Interpret a daemon/bridge frame as the outcome of an answer command.
 * Returns null for frames that say nothing about answers.
 */
export function readAskAnswerSignal(msg: unknown): AskAnswerSignal | null {
  if (!msg || typeof msg !== 'object') return null;
  const frame = msg as Record<string, unknown>;
  if (frame.type === MSG_COMMAND_ACK && typeof frame.commandId === 'string') {
    if (frame.status === 'accepted') return { commandId: frame.commandId, kind: 'confirmed' };
    if (frame.status === 'error') {
      return {
        commandId: frame.commandId,
        kind: 'failed',
        reason: frame.error === ASK_ANSWER_ACK_ERRORS.ALREADY_ANSWERED ? 'already_answered' : 'failed',
      };
    }
    return null;
  }
  if (frame.type === MSG_COMMAND_FAILED && typeof frame.commandId === 'string') {
    return { commandId: frame.commandId, kind: 'failed', reason: 'failed' };
  }
  // The answer's own timeline echo proves delivery even if the ack was lost.
  if (frame.type === 'timeline.event') {
    const payload = (frame.event as { payload?: Record<string, unknown> } | undefined)?.payload;
    const echoed = payload?.askAnswerCommandId;
    if ((frame.event as { type?: unknown } | undefined)?.type === 'user.message' && typeof echoed === 'string') {
      return { commandId: echoed, kind: 'confirmed' };
    }
  }
  return null;
}

export class AskAnswerTracker {
  private readonly pending = new Map<string, { answer: PendingAskAnswer; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly waitMs: number,
    private readonly onFailure: (failure: AskAnswerFailure) => void,
  ) {}

  track(answer: PendingAskAnswer): void {
    this.drop(answer.commandId);
    const timer = setTimeout(() => this.fail(answer.commandId, 'unconfirmed'), this.waitMs);
    this.pending.set(answer.commandId, { answer, timer });
  }

  /** Apply a frame; returns true when it concerned a tracked answer. */
  handle(msg: unknown): boolean {
    const signal = readAskAnswerSignal(msg);
    if (!signal || !this.pending.has(signal.commandId)) return false;
    if (signal.kind === 'confirmed') this.drop(signal.commandId);
    else this.fail(signal.commandId, signal.reason);
    return true;
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private drop(commandId: string): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
  }

  private fail(commandId: string, reason: AskAnswerFailureReason): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    this.drop(commandId);
    const { sessionName, toolUseId, answer } = entry.answer;
    this.onFailure({ sessionName, toolUseId, answer, reason });
  }
}
