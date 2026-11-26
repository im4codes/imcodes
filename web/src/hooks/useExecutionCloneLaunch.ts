import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  ACK_FAILURE_ACK_TIMEOUT,
  ACK_FAILURE_DAEMON_OFFLINE,
  ACK_TIMEOUT_MS,
  ACK_TIMEOUT_RETRY_LIMIT,
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
} from '@shared/ack-protocol.js';
import { genericExecutionCloneParentRunId } from '@shared/execution-clone.js';
import type { WsClient } from '../ws-client.js';
import { revealExecutionCloneGroup } from '../execution-clone-ui.js';

export type ExecutionCloneLaunchPhase = 'idle' | 'pending' | 'success' | 'error';

export interface ExecutionCloneLaunchState {
  phase: ExecutionCloneLaunchPhase;
  requestedCount: number;
  error?: string;
}

export interface ExecutionCloneLaunchInput {
  text: string;
  templateSessionName: string;
  maxParallelClones: number;
  maxQueuedClones: number;
  cloneHardTimeoutMs: number;
  cloneRetentionMs: number;
}

interface PendingLaunch {
  commandId: string;
  requestedCount: number;
  parentRunId: string;
}

const IDLE_STATE: ExecutionCloneLaunchState = {
  phase: 'idle',
  requestedCount: 0,
};

/** The server can retry an unacked command for ~48s; leave a small UI margin. */
export const EXECUTION_CLONE_LAUNCH_TIMEOUT_MS =
  ACK_TIMEOUT_MS * (ACK_TIMEOUT_RETRY_LIMIT + 1) + 5_000;
const EXECUTION_CLONE_FEEDBACK_CLEAR_MS = 8_000;

export function useExecutionCloneLaunch(options: {
  ws: WsClient | null;
  connected: boolean;
  sessionName: string;
  ownerSessionName: string;
}): {
  state: ExecutionCloneLaunchState;
  launch: (input: ExecutionCloneLaunchInput) => boolean;
} {
  const { ws, connected, sessionName, ownerSessionName } = options;
  const [state, setState] = useState<ExecutionCloneLaunchState>(IDLE_STATE);
  const pendingRef = useRef<PendingLaunch | null>(null);
  const launchIdentityRef = useRef({ ws, sessionName, ownerSessionName });
  const ackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFeedbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAckTimeout = useCallback(() => {
    if (!ackTimeoutRef.current) return;
    clearTimeout(ackTimeoutRef.current);
    ackTimeoutRef.current = null;
  }, []);
  const clearFeedbackTimeout = useCallback(() => {
    if (!clearFeedbackRef.current) return;
    clearTimeout(clearFeedbackRef.current);
    clearFeedbackRef.current = null;
  }, []);
  const scheduleFeedbackClear = useCallback(() => {
    clearFeedbackTimeout();
    clearFeedbackRef.current = setTimeout(() => {
      clearFeedbackRef.current = null;
      setState(IDLE_STATE);
    }, EXECUTION_CLONE_FEEDBACK_CLEAR_MS);
  }, [clearFeedbackTimeout]);
  const finishError = useCallback((error: string) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    clearAckTimeout();
    setState({
      phase: 'error',
      requestedCount: pending.requestedCount,
      error,
    });
    scheduleFeedbackClear();
  }, [clearAckTimeout, scheduleFeedbackClear]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const commandId = typeof (msg as { commandId?: unknown }).commandId === 'string'
        ? (msg as { commandId: string }).commandId
        : '';
      if (commandId !== pending.commandId) return;

      if (msg.type === MSG_COMMAND_FAILED) {
        const failedSession = typeof msg.session === 'string' ? msg.session : '';
        if (failedSession && failedSession !== sessionName) return;
        finishError(msg.reason);
        return;
      }
      if (msg.type !== MSG_COMMAND_ACK) return;
      const ackSession = typeof msg.session === 'string' ? msg.session : '';
      if (ackSession && ackSession !== sessionName) return;
      const status = typeof msg.status === 'string' ? msg.status : '';
      if (status === 'error' || status === 'conflict') {
        const error = typeof (msg as { error?: unknown }).error === 'string'
          ? (msg as { error: string }).error
          : status;
        finishError(error);
        return;
      }

      pendingRef.current = null;
      clearAckTimeout();
      clearFeedbackTimeout();
      setState({
        phase: 'success',
        requestedCount: pending.requestedCount,
      });
      revealExecutionCloneGroup({
        ownerSessionName,
        parentRunId: pending.parentRunId,
      });
      scheduleFeedbackClear();
    });
  }, [
    clearAckTimeout,
    clearFeedbackTimeout,
    finishError,
    ownerSessionName,
    scheduleFeedbackClear,
    sessionName,
    ws,
  ]);

  useEffect(() => {
    const previous = launchIdentityRef.current;
    launchIdentityRef.current = { ws, sessionName, ownerSessionName };
    if (
      previous.ws === ws
      && previous.sessionName === sessionName
      && previous.ownerSessionName === ownerSessionName
    ) {
      return;
    }
    if (pendingRef.current) finishError(ACK_FAILURE_DAEMON_OFFLINE);
  }, [finishError, ownerSessionName, sessionName, ws]);

  useEffect(() => () => {
    pendingRef.current = null;
    clearAckTimeout();
    clearFeedbackTimeout();
  }, [clearAckTimeout, clearFeedbackTimeout]);

  const launch = useCallback((input: ExecutionCloneLaunchInput): boolean => {
    if (pendingRef.current) return false;
    clearFeedbackTimeout();
    const requestedCount = Math.max(1, input.maxParallelClones);
    if (!ws || !connected) {
      setState({
        phase: 'error',
        requestedCount,
        error: ACK_FAILURE_DAEMON_OFFLINE,
      });
      scheduleFeedbackClear();
      return false;
    }

    const commandId = globalThis.crypto?.randomUUID?.()
      ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending: PendingLaunch = {
      commandId,
      requestedCount,
      parentRunId: genericExecutionCloneParentRunId(commandId),
    };
    pendingRef.current = pending;
    setState({ phase: 'pending', requestedCount });
    ackTimeoutRef.current = setTimeout(() => {
      if (pendingRef.current?.commandId !== commandId) return;
      finishError(ACK_FAILURE_ACK_TIMEOUT);
    }, EXECUTION_CLONE_LAUNCH_TIMEOUT_MS);

    let sent = false;
    try {
      sent = ws.sendExecutionClones({
        sessionName,
        text: input.text,
        commandId,
        dedicatedExecutionRouting: {
          enabled: true,
          templateSessionName: input.templateSessionName,
          maxParallelClones: input.maxParallelClones,
          maxQueuedClones: input.maxQueuedClones,
          cloneHardTimeoutMs: input.cloneHardTimeoutMs,
          cloneRetentionMs: input.cloneRetentionMs,
        },
      });
    } catch (error) {
      finishError(error instanceof Error ? error.message : String(error));
      return false;
    }
    if (!sent) finishError(ACK_FAILURE_DAEMON_OFFLINE);
    return sent;
  }, [
    clearFeedbackTimeout,
    connected,
    finishError,
    scheduleFeedbackClear,
    sessionName,
    ws,
  ]);

  return { state, launch };
}
