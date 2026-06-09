import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MSG_DAEMON_OFFLINE } from '@shared/ack-protocol.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { SHARE_DAEMON_MESSAGE_TYPES } from '@shared/tab-sharing.js';
import type { WsClient, ServerMessage } from '../ws-client.js';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET,
  OPENSPEC_AUTO_DELIVER_MSG,
  isOpenSpecAutoDeliverTerminalStatus,
  type OpenSpecAutoDeliverContinuePayload,
  type OpenSpecAutoDeliverLaunchPayload,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverProjection,
  type OpenSpecAutoDeliverStatusRequestPayload,
  type OpenSpecAutoDeliverStopPayload,
} from '../openspec-auto-deliver.js';
import { normalizeOpenSpecAutoDeliverProjection } from '../openspec-auto-deliver-normalize.js';

const OPEN_SPEC_AUTO_DELIVER_LAUNCH_TIMEOUT_MS = 30_000;
const OPEN_SPEC_AUTO_DELIVER_STOP_TIMEOUT_MS = 15_000;
const OPEN_SPEC_AUTO_DELIVER_CONTINUE_TIMEOUT_MS = 30_000;

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
  locale?: string;
  autoCommitPush?: boolean;
}

interface State {
  projection: OpenSpecAutoDeliverProjection | null;
  launchPending: boolean;
  stopPending: boolean;
  continuePending: boolean;
  lastError: string | null;
  launch: (options: LaunchOptions) => string | null;
  stop: (runId?: string) => string | null;
  continueRun: (runId?: string) => string | null;
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

function projectionMatchesSession(projection: OpenSpecAutoDeliverProjection, sessionName: string | null | undefined): boolean {
  if (!sessionName) return true;
  if (projection.visibility === 'conflict') {
    return projection.owningMainSessionName !== sessionName;
  }
  const aliases = [
    projection.owningMainSessionName,
    projection.launchedFromSessionName,
    projection.targetImplementationSessionName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return aliases.length === 0 || aliases.includes(sessionName);
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
  const [continuePending, setContinuePending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const latestProjectionRef = useRef<OpenSpecAutoDeliverProjection | null>(null);
  const projectionCacheRef = useRef<Map<string, OpenSpecAutoDeliverProjection>>(new Map());
  const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLaunchRequestIdRef = useRef<string | null>(null);
  const activeStopRequestIdRef = useRef<string | null>(null);
  const activeStopRunIdRef = useRef<string | null>(null);
  const activeContinueRequestIdRef = useRef<string | null>(null);
  const activeContinueRunIdRef = useRef<string | null>(null);

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
    activeStopRunIdRef.current = null;
  }, []);

  const clearContinueTimeout = useCallback(() => {
    if (continueTimeoutRef.current) {
      clearTimeout(continueTimeoutRef.current);
      continueTimeoutRef.current = null;
    }
    activeContinueRequestIdRef.current = null;
    activeContinueRunIdRef.current = null;
  }, []);

  const applyProjection = useCallback((next: OpenSpecAutoDeliverProjection | null) => {
    if (!next) return;
    if (!projectionMatchesSession(next, sessionName)) return;
    const current = latestProjectionRef.current;
    if (
      current
      && current.runId === next.runId
      && next.projectionVersion < current.projectionVersion
    ) {
      return;
    }
    latestProjectionRef.current = next;
    const cacheKeys = [
      next.owningMainSessionName,
      next.launchedFromSessionName,
      next.targetImplementationSessionName,
      sessionName ?? undefined,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const key of cacheKeys) {
      projectionCacheRef.current.set(key, next);
    }
    clearLaunchTimeout();
    setProjection(next);
    setLaunchPending(false);
    if (isTerminalProjection(next)) {
      const pendingStopRunId = activeStopRunIdRef.current;
      if (!pendingStopRunId || pendingStopRunId === next.runId) {
        clearStopTimeout();
        setStopPending(false);
      }
    } else {
      const pendingContinueRunId = activeContinueRunIdRef.current;
      if (!pendingContinueRunId || pendingContinueRunId === next.runId) {
        clearContinueTimeout();
        setContinuePending(false);
      }
    }
  }, [clearContinueTimeout, clearLaunchTimeout, clearStopTimeout, sessionName]);

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

  const launch = useCallback(({ changeName, presetId = OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET, selectedTeamComboId, materializedLimits, locale, autoCommitPush }: LaunchOptions) => {
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
      ...(locale ? { locale } : {}),
      autoCommitPush: autoCommitPush === true,
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
    clearStopTimeout();
    activeStopRequestIdRef.current = requestId;
    activeStopRunIdRef.current = runId;
    setStopPending(true);
    setLastError(null);
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
    stopTimeoutRef.current = setTimeout(() => {
      if (activeStopRequestIdRef.current !== requestId) return;
      activeStopRequestIdRef.current = null;
      activeStopRunIdRef.current = null;
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

  const continueRun = useCallback((runId = projection?.runId) => {
    if (projection?.visibility === 'conflict') return null;
    if (!projection || projection.status === 'passed' || projection.canContinue === false) return null;
    const continueSessionName = projection.targetImplementationSessionName
      || projection.launchedFromSessionName
      || projection.owningMainSessionName
      || sessionName;
    if (!ws || !continueSessionName || !runId) {
      clearContinueTimeout();
      setContinuePending(false);
      if (runId) setLastError('openspec.auto.error.daemon_offline');
      return null;
    }
    const requestId = makeRequestId('openspec-auto-continue');
    const payload: OpenSpecAutoDeliverContinuePayload = {
      type: OPENSPEC_AUTO_DELIVER_MSG.CONTINUE,
      requestId,
      serverId,
      sessionName: continueSessionName,
      runId,
    };
    clearContinueTimeout();
    activeContinueRequestIdRef.current = requestId;
    activeContinueRunIdRef.current = runId;
    setContinuePending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearContinueTimeout();
      setContinuePending(false);
      setLastError(normalizeLaunchError(error instanceof Error ? error.message : error));
      return null;
    }
    continueTimeoutRef.current = setTimeout(() => {
      if (activeContinueRequestIdRef.current !== requestId) return;
      activeContinueRequestIdRef.current = null;
      activeContinueRunIdRef.current = null;
      continueTimeoutRef.current = null;
      setContinuePending(false);
      setLastError('openspec.auto.error.continue_timeout');
    }, OPEN_SPEC_AUTO_DELIVER_CONTINUE_TIMEOUT_MS);
    return requestId;
  }, [
    clearContinueTimeout,
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
        const ackRequestId = typeof raw.requestId === 'string' ? raw.requestId : null;
        if (activeStopRequestIdRef.current && ackRequestId !== activeStopRequestIdRef.current) {
          return;
        }
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
      if (raw.type === OPENSPEC_AUTO_DELIVER_MSG.CONTINUE_ACK) {
        const ackRequestId = typeof raw.requestId === 'string' ? raw.requestId : null;
        if (activeContinueRequestIdRef.current && ackRequestId !== activeContinueRequestIdRef.current) {
          return;
        }
        clearContinueTimeout();
        setContinuePending(false);
        const ackProjection = normalizeOpenSpecAutoDeliverProjection(raw.projection);
        if (ackProjection) applyProjection(ackProjection);
        if (raw.ok === false) {
          setLastError(normalizeLaunchError(raw.error));
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
        clearContinueTimeout();
        setStopPending(false);
        setContinuePending(false);
        return;
      }
    });
  }, [applyProjection, clearContinueTimeout, clearLaunchTimeout, clearStopTimeout, ws]);

  useEffect(() => {
    const cached = sessionName ? projectionCacheRef.current.get(sessionName) ?? null : null;
    latestProjectionRef.current = cached;
    clearLaunchTimeout();
    clearStopTimeout();
    clearContinueTimeout();
    setProjection(cached);
    setLastError(null);
    setLaunchPending(false);
    setStopPending(false);
    setContinuePending(false);
    requestStatus();
  }, [clearContinueTimeout, clearLaunchTimeout, clearStopTimeout, requestStatus, sessionName]);

  useEffect(() => {
    if (openSpecOpen) requestStatus();
  }, [openSpecOpen, requestStatus]);

  useEffect(() => () => {
    clearLaunchTimeout();
    clearStopTimeout();
    clearContinueTimeout();
  }, [clearContinueTimeout, clearLaunchTimeout, clearStopTimeout]);

  return useMemo(() => ({
    projection,
    launchPending,
    stopPending,
    continuePending,
    lastError,
    launch,
    stop,
    continueRun,
    requestStatus,
    clearError: () => setLastError(null),
  }), [continuePending, continueRun, launch, launchPending, lastError, projection, requestStatus, stop, stopPending]);
}
