import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MSG_DAEMON_OFFLINE } from '@shared/ack-protocol.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { SHARE_DAEMON_MESSAGE_TYPES } from '@shared/tab-sharing.js';
import type { WsClient, ServerMessage } from '../ws-client.js';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET,
  OPENSPEC_AUTO_DELIVER_MSG,
  isOpenSpecAutoDeliverTerminalStatus,
  type OpenSpecAutoDeliverLaunchPayload,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverProjection,
  type OpenSpecAutoDeliverStatusRequestPayload,
  type OpenSpecAutoDeliverStopPayload,
} from '../openspec-auto-deliver.js';
import { normalizeOpenSpecAutoDeliverProjection } from '../openspec-auto-deliver-normalize.js';

const OPEN_SPEC_AUTO_DELIVER_LAUNCH_TIMEOUT_MS = 30_000;
const OPEN_SPEC_AUTO_DELIVER_STOP_TIMEOUT_MS = 15_000;

interface Options {
  ws: WsClient | null;
  serverId?: string;
  sessionName?: string | null;
  openSpecOpen?: boolean;
}

interface LaunchOptions {
  changeName: string;
  presetId?: OpenSpecAutoDeliverPresetId;
  selectedTeamComboId?: string;
  materializedLimits?: OpenSpecAutoDeliverLaunchPayload['materializedLimits'];
}

interface State {
  projection: OpenSpecAutoDeliverProjection | null;
  launchPending: boolean;
  stopPending: boolean;
  lastError: string | null;
  launch: (options: LaunchOptions) => string | null;
  stop: (runId?: string) => string | null;
  requestStatus: () => string | null;
  clearError: () => void;
}

function makeRequestId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractProjection(msg: ServerMessage): OpenSpecAutoDeliverProjection | null {
  const raw = msg as Record<string, unknown>;
  if (
    raw.type !== OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
    && raw.type !== OPENSPEC_AUTO_DELIVER_MSG.CONFLICT_SUMMARY
    && raw.type !== OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION
    && raw.type !== OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK
    && raw.type !== OPENSPEC_AUTO_DELIVER_MSG.TERMINAL
  ) {
    return null;
  }
  return normalizeOpenSpecAutoDeliverProjection(raw.projection ?? raw.run);
}

function normalizeLaunchError(error: unknown): string {
  if (typeof error !== 'string') return 'openspec.auto.error.launch_failed';
  const trimmed = error.trim();
  if (!trimmed) return 'openspec.auto.error.launch_failed';
  if (trimmed.startsWith('openspec.auto.error.')) return trimmed;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (
    normalized === 'missing_change'
    || normalized === 'change_required'
    || normalized === 'no_change_selected'
  ) {
    return 'openspec.auto.error.missing_change';
  }
  if (
    normalized === 'active_run'
    || normalized === 'active_run_conflict'
    || normalized === 'auto_deliver_active'
    || normalized === 'openspec_auto_deliver_active'
  ) {
    return 'openspec.auto.error.active_run';
  }
  if (
    normalized === 'manual_team_busy'
    || normalized === 'team_lane_busy'
    || normalized === 'p2p_lane_busy'
    || normalized === 'active_manual_team_conflict'
    || normalized === 'manual_p2p_busy'
  ) {
    return 'openspec.auto.error.manual_team_busy';
  }
  if (
    normalized === 'unsupported_runtime'
    || normalized === 'unsupported_session_runtime'
    || normalized === 'transport_runtime_required'
  ) {
    return 'openspec.auto.error.unsupported_runtime';
  }
  if (
    normalized === 'daemon_offline'
    || normalized === 'daemon_unavailable'
    || normalized === 'daemon_disconnected'
  ) {
    return 'openspec.auto.error.daemon_offline';
  }
  if (
    normalized === 'launch_timeout'
    || normalized === 'request_timeout'
    || normalized === 'timeout'
  ) {
    return 'openspec.auto.error.launch_timeout';
  }
  return trimmed.includes('.') ? trimmed : 'openspec.auto.error.launch_failed';
}

function normalizeStopError(error: unknown): string {
  if (typeof error !== 'string') return 'openspec.auto.error.launch_failed';
  const trimmed = error.trim();
  if (trimmed === 'openspec.auto.error.stop_timeout') return trimmed;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (
    normalized === 'daemon_offline'
    || normalized === 'daemon_unavailable'
    || normalized === 'daemon_disconnected'
    || normalized === 'websocket_not_connected'
    || normalized === 'ws_not_connected'
  ) {
    return 'openspec.auto.error.daemon_offline';
  }
  if (
    normalized === 'stop_timeout'
    || normalized === 'request_timeout'
    || normalized === 'timeout'
  ) {
    return 'openspec.auto.error.stop_timeout';
  }
  return normalizeLaunchError(error);
}

function isTerminalProjection(projection: OpenSpecAutoDeliverProjection): boolean {
  return projection.terminal === true || isOpenSpecAutoDeliverTerminalStatus(projection.status);
}

export function useOpenSpecAutoDeliver({
  ws,
  serverId,
  sessionName,
  openSpecOpen = false,
}: Options): State {
  const [projection, setProjection] = useState<OpenSpecAutoDeliverProjection | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const latestProjectionRef = useRef<OpenSpecAutoDeliverProjection | null>(null);
  const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLaunchRequestIdRef = useRef<string | null>(null);
  const activeStopRequestIdRef = useRef<string | null>(null);

  const clearLaunchTimeout = useCallback(() => {
    if (launchTimeoutRef.current) {
      clearTimeout(launchTimeoutRef.current);
      launchTimeoutRef.current = null;
    }
    activeLaunchRequestIdRef.current = null;
  }, []);

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    activeStopRequestIdRef.current = null;
  }, []);

  const applyProjection = useCallback((next: OpenSpecAutoDeliverProjection | null) => {
    if (!next) return;
    const current = latestProjectionRef.current;
    if (
      current
      && current.runId === next.runId
      && next.projectionVersion < current.projectionVersion
    ) {
      return;
    }
    latestProjectionRef.current = next;
    clearLaunchTimeout();
    setProjection(next);
    setLaunchPending(false);
    if (isTerminalProjection(next)) {
      clearStopTimeout();
      setStopPending(false);
    }
  }, [clearLaunchTimeout, clearStopTimeout]);

  const requestStatus = useCallback(() => {
    if (!ws || !sessionName) return null;
    const requestId = makeRequestId('openspec-auto-status');
    const payload: OpenSpecAutoDeliverStatusRequestPayload = {
      type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
      requestId,
      serverId,
      sessionName,
    };
    ws.send(payload);
    return requestId;
  }, [serverId, sessionName, ws]);

  const launch = useCallback(({ changeName, presetId = OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET, selectedTeamComboId, materializedLimits }: LaunchOptions) => {
    const trimmedChangeName = changeName.trim();
    if (!ws || !sessionName || !trimmedChangeName) {
      setLastError('openspec.auto.error.missing_change');
      return null;
    }
    const requestId = makeRequestId('openspec-auto-launch');
    const payload: OpenSpecAutoDeliverLaunchPayload = {
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId,
      serverId,
      sessionName,
      changeName: trimmedChangeName,
      presetId,
      ...(selectedTeamComboId ? { selectedTeamComboId } : {}),
      ...(materializedLimits ? { materializedLimits } : {}),
    };
    clearLaunchTimeout();
    activeLaunchRequestIdRef.current = requestId;
    setLaunchPending(true);
    setLastError(null);
    launchTimeoutRef.current = setTimeout(() => {
      if (activeLaunchRequestIdRef.current !== requestId) return;
      activeLaunchRequestIdRef.current = null;
      launchTimeoutRef.current = null;
      setLaunchPending(false);
      setLastError('openspec.auto.error.launch_timeout');
    }, OPEN_SPEC_AUTO_DELIVER_LAUNCH_TIMEOUT_MS);
    ws.send(payload);
    return requestId;
  }, [clearLaunchTimeout, serverId, sessionName, ws]);

  const stop = useCallback((runId = projection?.runId) => {
    if (projection?.visibility === 'conflict') return null;
    if (projection && isTerminalProjection(projection)) return null;
    if (projection?.canStop === false) return null;
    const stopSessionName = projection?.targetImplementationSessionName
      || projection?.launchedFromSessionName
      || projection?.owningMainSessionName
      || sessionName;
    if (!ws || !stopSessionName || !runId) {
      clearStopTimeout();
      setStopPending(false);
      if (runId) setLastError('openspec.auto.error.daemon_offline');
      return null;
    }
    const requestId = makeRequestId('openspec-auto-stop');
    const payload: OpenSpecAutoDeliverStopPayload = {
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId,
      serverId,
      sessionName: stopSessionName,
      runId,
    };
    try {
      const sendUrgent = (ws as { sendUrgent?: (msg: object) => void }).sendUrgent;
      if (sendUrgent) {
        sendUrgent.call(ws, payload);
      } else {
        ws.send(payload);
      }
    } catch (error) {
      clearStopTimeout();
      setStopPending(false);
      setLastError(normalizeStopError(error instanceof Error ? error.message : error));
      return null;
    }
    clearStopTimeout();
    activeStopRequestIdRef.current = requestId;
    setStopPending(true);
    setLastError(null);
    stopTimeoutRef.current = setTimeout(() => {
      if (activeStopRequestIdRef.current !== requestId) return;
      activeStopRequestIdRef.current = null;
      stopTimeoutRef.current = null;
      setStopPending(false);
      setLastError('openspec.auto.error.stop_timeout');
    }, OPEN_SPEC_AUTO_DELIVER_STOP_TIMEOUT_MS);
    return requestId;
  }, [
    clearStopTimeout,
    projection,
    projection?.launchedFromSessionName,
    projection?.owningMainSessionName,
    projection?.runId,
    projection?.targetImplementationSessionName,
    serverId,
    sessionName,
    ws,
  ]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      const raw = msg as Record<string, unknown>;
      const nextProjection = extractProjection(msg);
      if (nextProjection) {
        applyProjection(nextProjection);
        return;
      }
      if (raw.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR) {
        clearLaunchTimeout();
        setLastError(normalizeLaunchError(raw.error));
        setLaunchPending(false);
        const conflictProjection = normalizeOpenSpecAutoDeliverProjection(raw.projection ?? raw.conflict);
        if (conflictProjection) applyProjection(conflictProjection);
        return;
      }
      if (raw.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK) {
        clearStopTimeout();
        setStopPending(false);
        const ackProjection = normalizeOpenSpecAutoDeliverProjection(raw.projection);
        if (ackProjection) applyProjection(ackProjection);
        if (raw.ok === false) {
          setLastError(normalizeStopError(raw.error));
        } else {
          setLastError(null);
        }
        return;
      }
      if (
        (raw.type === SHARE_DAEMON_MESSAGE_TYPES.SESSION_EVENT && raw.event === 'disconnected')
        || raw.type === MSG_DAEMON_OFFLINE
        || raw.type === DAEMON_MSG.DISCONNECTED
      ) {
        clearStopTimeout();
        setStopPending(false);
        return;
      }
    });
  }, [applyProjection, clearLaunchTimeout, clearStopTimeout, ws]);

  useEffect(() => {
    latestProjectionRef.current = null;
    clearLaunchTimeout();
    clearStopTimeout();
    setProjection(null);
    setLastError(null);
    setLaunchPending(false);
    setStopPending(false);
    requestStatus();
  }, [clearLaunchTimeout, clearStopTimeout, requestStatus, sessionName]);

  useEffect(() => {
    if (openSpecOpen) requestStatus();
  }, [openSpecOpen, requestStatus]);

  useEffect(() => () => {
    clearLaunchTimeout();
    clearStopTimeout();
  }, [clearLaunchTimeout, clearStopTimeout]);

  return useMemo(() => ({
    projection,
    launchPending,
    stopPending,
    lastError,
    launch,
    stop,
    requestStatus,
    clearError: () => setLastError(null),
  }), [launch, launchPending, lastError, projection, requestStatus, stop, stopPending]);
}
