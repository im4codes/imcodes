/**
 * usePeerAuditController — orchestrates the peer-audit UI flow.
 *
 * States (see types.ts):
 *   idle -> loading -> chooser | consent -> starting -> pending -> result -> idle
 *
 * Invariants:
 * - Authority: the audited session's instance id + runtime epoch MUST come
 *   from daemon-authoritative session_list / subsession.sync. The hook
 *   refuses to start without identity (returns error: identity_missing).
 * - Single-flight: only one in-flight start() per hook instance; concurrent
 *   clicks while in starting/pending are rejected with already_pending.
 * - Auto mode/color: this hook NEVER mutates supervision mode or loop counters.
 * - Target persistence: only the auditor target is patched; the adapter
 *   contract guarantees no other supervision field is touched.
 * - aria-busy: aria-busy=true is set during starting and pending.
 * - Result de-duplication: the adapter-supplied subscribeResults fires at most
 *   once per attemptId; the hook ignores subsequent results.
 * - candidateListRevision: passed through to the adapter from the
 *   most-recent list_candidates response (never derived from a candidate
 *   identity field).
 */

import { useCallback, useEffect, useReducer, useRef } from 'preact/hooks';
import type {
  PeerAuditAdapter,
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditControllerApi,
  PeerAuditErrorReason,
  PeerAuditRememberedTarget,
  PeerAuditSelectionIntent,
  PeerAuditState,
  PeerAuditAuditedSessionIdentity,
} from './types.js';

interface ControllerInput {
  adapter: PeerAuditAdapter;
  /** Authority for the audited session. Required. */
  auditedSessionIdentity: PeerAuditAuditedSessionIdentity | null;
  /**
   * Display name only — must NOT be used as identity. Comes from session_list
   * projection.
   */
  auditedSessionName: string | null;
  auditedModel: {
    normalizedModelId: string;
    providerFamily: string;
  } | null;
  rememberedTarget: PeerAuditRememberedTarget | null;
  hasUserConsentedTo: (fingerprint: string) => boolean;
  recordUserConsent?: (fingerprint: string) => void;
}

type ChooserReason = Extract<PeerAuditState, { kind: 'chooser' }>['reason'];
type ConsentProviderFamily = Extract<PeerAuditState, { kind: 'consent' }>['providerFamily'];

type InternalAction =
  | { type: 'open_loading' }
  | { type: 'open_chooser'; reason: ChooserReason; candidates: PeerAuditCandidateList | null }
  | { type: 'open_consent'; providerFamily: ConsentProviderFamily; normalizedModelId: string; auditorLabel: string }
  | { type: 'starting'; attemptId: string; auditorLabel: string }
  | { type: 'pending_tick'; elapsedMs: number }
  | { type: 'status'; resultEventId: string; phase: Extract<PeerAuditState, { kind: 'pending' }>['phase'] }
  | { type: 'pending_from_start'; attemptId: string; resultEventId: string; auditorLabel: string }
  | {
      type: 'result';
      attempt: Extract<PeerAuditState, { kind: 'result' }>;
    }
  | { type: 'local_result'; attempt: Extract<PeerAuditState, { kind: 'result' }> }
  | { type: 'error'; reason: PeerAuditErrorReason; message: string }
  | { type: 'acknowledge' };

interface InternalState {
  state: PeerAuditState;
  seenAttemptIds: ReadonlySet<string>;
  bufferedResults: ReadonlyMap<string, Extract<PeerAuditState, { kind: 'result' }>>;
  bufferedStatuses: ReadonlyMap<string, Extract<PeerAuditState, { kind: 'pending' }>['phase']>;
  inFlightToken: number;
}

const INITIAL: InternalState = {
  state: { kind: 'idle' },
  seenAttemptIds: new Set<string>(),
  bufferedResults: new Map(),
  bufferedStatuses: new Map(),
  inFlightToken: 0,
};

function reducer(state: InternalState, action: InternalAction): InternalState {
  switch (action.type) {
    case 'open_loading':
      return { ...state, state: { kind: 'loading' } };
    case 'open_chooser':
      return {
        ...state,
        state: { kind: 'chooser', reason: action.reason, candidates: action.candidates },
      };
    case 'open_consent':
      return {
        ...state,
        state: {
          kind: 'consent',
          providerFamily: action.providerFamily,
          normalizedModelId: action.normalizedModelId,
          auditorLabel: action.auditorLabel,
        },
      };
    case 'starting':
      return {
        ...state,
        state: { kind: 'starting', attemptId: action.attemptId, auditorLabel: action.auditorLabel },
      };
    case 'pending_tick':
      if (state.state.kind !== 'pending') return state;
      return { ...state, state: { ...state.state, elapsedMs: action.elapsedMs } };
    case 'status':
      if (state.state.kind === 'starting') {
        const buffered = new Map(state.bufferedStatuses);
        buffered.set(action.resultEventId, action.phase);
        while (buffered.size > 16) buffered.delete(buffered.keys().next().value!);
        return { ...state, bufferedStatuses: buffered };
      }
      if (state.state.kind !== 'pending' || state.state.resultEventId !== action.resultEventId) return state;
      return { ...state, state: { ...state.state, phase: action.phase } };
    case 'pending_from_start':
      if (state.bufferedResults.has(action.resultEventId)) {
        const buffered = state.bufferedResults.get(action.resultEventId)!;
        return {
          ...state,
          state: { ...buffered, attemptId: action.attemptId },
          seenAttemptIds: new Set([...state.seenAttemptIds, action.resultEventId]),
          bufferedResults: new Map(),
          bufferedStatuses: new Map(),
        };
      }
      return {
        ...state,
        state: {
          kind: 'pending',
          attemptId: action.attemptId,
          resultEventId: action.resultEventId,
          auditorLabel: action.auditorLabel,
          elapsedMs: 0,
          phase: state.bufferedStatuses.get(action.resultEventId) ?? 'preparing',
        },
        bufferedResults: new Map(),
        bufferedStatuses: new Map(),
      };
    case 'result':
      if (state.seenAttemptIds.has(action.attempt.attemptId)) return state;
      if (state.state.kind === 'starting') {
        const buffered = new Map(state.bufferedResults);
        buffered.set(action.attempt.attemptId, action.attempt);
        while (buffered.size > 16) buffered.delete(buffered.keys().next().value!);
        return { ...state, bufferedResults: buffered };
      }
      if (state.state.kind !== 'pending' || action.attempt.attemptId !== state.state.resultEventId) return state;
      return {
        ...state,
        state: { ...action.attempt, attemptId: state.state.attemptId },
        seenAttemptIds: new Set([...state.seenAttemptIds, action.attempt.attemptId]),
        bufferedResults: new Map(),
        bufferedStatuses: new Map(),
      };
    case 'local_result':
      return { ...state, state: action.attempt };
    case 'error':
      return {
        ...state,
        state: { kind: 'error', reason: action.reason, message: action.message },
      };
    case 'acknowledge':
      return { ...state, state: { kind: 'idle' } };
    default:
      return state;
  }
}

function isRememberedFastPathEligible(
  remembered: PeerAuditRememberedTarget | null,
  auditedModel: ControllerInput['auditedModel'],
): { eligible: boolean; reason?: 'same_model' | 'unknown_model' | 'missing'; candidate?: PeerAuditCandidate } {
  if (!remembered) return { eligible: false, reason: 'missing' };
  if (remembered.normalizedModelId === 'unknown') return { eligible: false, reason: 'unknown_model' };
  if (!auditedModel) return { eligible: false, reason: 'unknown_model' };
  if (remembered.normalizedModelId === auditedModel.normalizedModelId) {
    return { eligible: false, reason: 'same_model' };
  }
  return {
    eligible: true,
    candidate: {
      name: remembered.sessionName,
      label: remembered.sessionName,
      sessionInstanceId: remembered.sessionInstanceId,
      runtimeEpoch: remembered.runtimeEpoch,
      normalizedModelId: remembered.normalizedModelId,
      providerFamily: remembered.providerFamily,
      liveState: 'idle',
      dispositionCapability: 'sent',
      eligible: true,
      reason: 'eligible',
    },
  };
}

function makeSelectionIntent(reason: 'remembered_fast_path' | 'explicit_picker'): PeerAuditSelectionIntent {
  return reason;
}

export function usePeerAuditController(input: ControllerInput): PeerAuditControllerApi {
  const [internal, dispatch] = useReducer(reducer, INITIAL);
  const inputRef = useRef(input);
  inputRef.current = input;
  const tickRef = useRef<number | null>(null);
  const startTokenRef = useRef(0);
  const cancelledStartTokenRef = useRef<number | null>(null);
  const resultUnsubRef = useRef<(() => void) | null>(null);
  // Cache the latest candidate-list revision returned by listCandidates so
  // dispatch passes it back to startQuickAudit (Round 1 §"Use actual
  // candidateRevision, not candidate.sessionInstanceId").
  const revisionRef = useRef<string | null>(null);
  const candidateListRef = useRef<PeerAuditCandidateList | null>(null);
  const targetConfigRevisionRef = useRef<string | null>(null);
  const pendingConsentRef = useRef<{
    candidate: PeerAuditCandidate;
    intent: PeerAuditSelectionIntent;
    revision: string;
    targetConfigRevision: string;
    fingerprint: string;
  } | null>(null);

  const pendingAttemptId = internal.state.kind === 'pending' ? internal.state.attemptId : null;
  useEffect(() => {
    if (internal.state.kind !== 'pending') {
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    const startedAt = Date.now();
    tickRef.current = window.setInterval(() => {
      dispatch({ type: 'pending_tick', elapsedMs: Date.now() - startedAt });
    }, 1000);
    return () => {
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [internal.state.kind, pendingAttemptId]);

  useEffect(() => {
    if (!input.auditedSessionIdentity || !input.auditedSessionName) return;
    const unsub = input.adapter.subscribeResults({
      auditedSessionName: input.auditedSessionName,
      onResult: (attempt) => {
        dispatch({ type: 'result', attempt });
      },
      onStatus: (status) => {
        dispatch({ type: 'status', ...status });
      },
      onError: (reason, message) => {
        dispatch({ type: 'error', reason, message });
      },
    });
    resultUnsubRef.current = unsub;
    return () => {
      if (resultUnsubRef.current) resultUnsubRef.current();
      resultUnsubRef.current = null;
    };
  }, [input.adapter, input.auditedSessionName, input.auditedSessionIdentity?.sessionInstanceId, input.auditedSessionIdentity?.runtimeEpoch]);

  const dispatchAudit = useCallback(
    async (
      candidate: PeerAuditCandidate,
      intent: PeerAuditSelectionIntent,
      auditorLabel: string,
      candidateListRevision: string | null,
      targetConfigRevision: string | null,
    ) => {
      const identity = inputRef.current.auditedSessionIdentity;
      const name = inputRef.current.auditedSessionName;
      if (!identity || !name) {
        dispatch({ type: 'error', reason: 'identity_missing', message: 'audited session identity not yet authoritative' });
        return;
      }
      if (!candidateListRevision || !targetConfigRevision) {
        dispatch({ type: 'error', reason: 'preflight_failed', message: 'candidate or target configuration revision missing' });
        return;
      }
      const token = ++startTokenRef.current;
      const placeholderAttemptId = `pending-${token}`;
      dispatch({ type: 'starting', attemptId: placeholderAttemptId, auditorLabel });
      const res = await inputRef.current.adapter.startQuickAudit({
        auditedSessionName: name,
        auditedSessionIdentity: identity,
        auditor: {
          sessionName: candidate.name,
          sessionInstanceId: candidate.sessionInstanceId,
          runtimeEpoch: candidate.runtimeEpoch,
        },
        selectionIntent: intent,
        candidateListRevision,
        targetConfigRevision,
        commandId: `quick_${crypto.randomUUID()}`,
      });
      if (cancelledStartTokenRef.current === token) {
        cancelledStartTokenRef.current = null;
        if (res.ok) {
          dispatch({
            type: 'pending_from_start',
            attemptId: res.attemptId,
            resultEventId: res.resultEventId,
            auditorLabel,
          });
          const cancelled = await inputRef.current.adapter.cancelAttempt({
            auditedSessionName: name,
            auditedSessionIdentity: identity,
            attemptId: res.attemptId,
          });
          if (!cancelled.ok) dispatch({ type: 'error', reason: cancelled.reason, message: cancelled.message });
        } else {
          dispatch({ type: 'error', reason: res.reason, message: res.message });
        }
        return;
      }
      if (token !== startTokenRef.current) return;
      if (res.ok) {
        dispatch({
          type: 'pending_from_start',
          attemptId: res.attemptId,
          resultEventId: res.resultEventId,
          auditorLabel,
        });
      } else {
        if (res.reason === 'candidate_refresh_required' || res.reason === 'config_conflict') {
          // Refresh candidates + target revision, open chooser. NEVER
          // auto-replay the previous selection: a config_conflict means
          // another tab may have just chosen a different auditor, and
          // blindly replaying would race on the same revision.
          try {
            const list = await inputRef.current.adapter.listCandidates({
              auditedSessionName: name,
              auditedSessionIdentity: identity,
            });
            candidateListRef.current = list;
            revisionRef.current = list.revision;
            targetConfigRevisionRef.current = list.targetConfigRevision;
            dispatch({
              type: 'open_chooser',
              reason: 'config_repair',
              candidates: list,
            });
          } catch (refreshErr) {
            // Refresh-failure must still drop to a stable chooser state, not
            // an opaque error — the user must see the refresh failed so they
            // can re-select or back out, and Auto mode/loop counters must NOT
            // be touched.
            dispatch({ type: 'open_chooser', reason: 'config_repair', candidates: null });
          }
        } else {
          dispatch({ type: 'error', reason: res.reason, message: res.message });
        }
      }
    },
    [],
  );

  const dispatchOrConfirm = useCallback((
    candidate: PeerAuditCandidate,
    intent: PeerAuditSelectionIntent,
    revision: string,
  ) => {
    const audited = inputRef.current.auditedModel;
    const fingerprint = JSON.stringify({
      sessionInstanceId: candidate.sessionInstanceId,
      normalizedModelId: candidate.normalizedModelId,
      providerFamily: candidate.providerFamily,
    });
    const crossProvider = audited?.providerFamily !== 'unknown'
      && candidate.providerFamily !== 'unknown'
      && audited?.providerFamily !== candidate.providerFamily;
    if (crossProvider && !inputRef.current.hasUserConsentedTo(fingerprint)) {
      const targetConfigRevision = targetConfigRevisionRef.current;
      if (!targetConfigRevision) {
        dispatch({ type: 'error', reason: 'preflight_failed', message: 'target configuration revision missing' });
        return;
      }
      pendingConsentRef.current = { candidate, intent, revision, targetConfigRevision, fingerprint };
      dispatch({
        type: 'open_consent',
        providerFamily: candidate.providerFamily,
        normalizedModelId: candidate.normalizedModelId,
        auditorLabel: candidate.label,
      });
      return;
    }
    void dispatchAudit(candidate, intent, candidate.label, revision, targetConfigRevisionRef.current);
  }, [dispatchAudit]);

  const start = useCallback(
    (params: {
      auditedSessionName: string;
      auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
      rememberedTarget: PeerAuditRememberedTarget | null;
      auditedModel: { normalizedModelId: string; providerFamily: string } | null;
    }) => {
      const { auditedSessionName, auditedSessionIdentity, auditedModel, rememberedTarget } = {
        ...inputRef.current,
        ...params,
      };
      if (!auditedSessionIdentity) {
        dispatch({ type: 'error', reason: 'identity_missing', message: 'audited session identity not yet authoritative' });
        return;
      }
      if (internal.state.kind === 'starting' || internal.state.kind === 'pending') {
        dispatch({ type: 'error', reason: 'already_pending', message: 'audit already in flight' });
        return;
      }
      const fast = isRememberedFastPathEligible(rememberedTarget, auditedModel);
      if (fast.eligible && fast.candidate) {
        const exactRememberedCandidate = (list: PeerAuditCandidateList) => list.candidates.find((candidate) => candidate.eligible
          && candidate.name === fast.candidate!.name
          && candidate.sessionInstanceId === fast.candidate!.sessionInstanceId
          && candidate.runtimeEpoch === fast.candidate!.runtimeEpoch
          && candidate.normalizedModelId === fast.candidate!.normalizedModelId
          && candidate.providerFamily === fast.candidate!.providerFamily);
        const cached = candidateListRef.current;
        if (!cached) {
          dispatch({ type: 'open_loading' });
          void inputRef.current.adapter
            .listCandidates({ auditedSessionName, auditedSessionIdentity })
            .then((list) => {
              candidateListRef.current = list;
              revisionRef.current = list.revision;
              targetConfigRevisionRef.current = list.targetConfigRevision;
              const authoritative = exactRememberedCandidate(list);
              if (authoritative) {
                dispatchOrConfirm(authoritative, makeSelectionIntent('remembered_fast_path'), list.revision);
              } else {
                const sameInstance = list.candidates.find((candidate) => candidate.name === fast.candidate!.name
                  && candidate.sessionInstanceId === fast.candidate!.sessionInstanceId);
                dispatch({
                  type: 'open_chooser',
                  reason: sameInstance ? 'model_changed_since_click' : 'stale_target',
                  candidates: list,
                });
              }
            })
            .catch(() => {
              dispatch({ type: 'open_chooser', reason: 'no_candidate', candidates: null });
            });
          return;
        }
        const authoritative = exactRememberedCandidate(cached);
        if (authoritative) {
          dispatchOrConfirm(authoritative, makeSelectionIntent('remembered_fast_path'), cached.revision);
        } else {
          const sameInstance = cached.candidates.find((candidate) => candidate.name === fast.candidate!.name
            && candidate.sessionInstanceId === fast.candidate!.sessionInstanceId);
          dispatch({
            type: 'open_chooser',
            reason: sameInstance ? 'model_changed_since_click' : 'stale_target',
            candidates: cached,
          });
        }
        return;
      }
      dispatch({ type: 'open_loading' });
      void inputRef.current.adapter
        .listCandidates({ auditedSessionName, auditedSessionIdentity })
        .then((list) => {
          candidateListRef.current = list;
          revisionRef.current = list.revision;
          targetConfigRevisionRef.current = list.targetConfigRevision;
          const reason: ChooserReason =
            fast.reason === 'same_model'
              ? 'same_model_remembered'
              : fast.reason === 'unknown_model'
                ? 'unknown_model_remembered'
                : 'missing_target';
          dispatch({
            type: 'open_chooser',
            reason: list.candidates.some((candidate) => candidate.eligible) ? reason : 'no_candidate',
            candidates: list,
          });
        })
        .catch(() => {
          dispatch({ type: 'open_chooser', reason: 'no_candidate', candidates: null });
        });
    },
    [dispatchOrConfirm, internal.state.kind],
  );

  const confirmConsent = useCallback(() => {
    if (internal.state.kind !== 'consent') return;
    const pending = pendingConsentRef.current;
    if (!pending) {
      dispatch({ type: 'error', reason: 'preflight_failed', message: 'fast-path no longer eligible' });
      return;
    }
    inputRef.current.recordUserConsent?.(pending.fingerprint);
    pendingConsentRef.current = null;
    void dispatchAudit(pending.candidate, pending.intent, internal.state.auditorLabel, pending.revision, pending.targetConfigRevision);
  }, [dispatchAudit, internal.state]);

  const cancelConsent = useCallback(() => {
    if (internal.state.kind !== 'consent') return;
    pendingConsentRef.current = null;
    dispatch({ type: 'acknowledge' });
  }, [internal.state.kind]);

  const selectCandidate = useCallback(
    (candidate: PeerAuditCandidate) => {
      if (internal.state.kind !== 'chooser') return;
      const intent = makeSelectionIntent('explicit_picker');
      const identity = inputRef.current.auditedSessionIdentity;
      const name = inputRef.current.auditedSessionName;
      const listRevision = revisionRef.current;
      if (!identity || !name || !listRevision) {
        dispatch({ type: 'error', reason: 'identity_missing', message: 'audited session identity or candidate revision missing' });
        return;
      }
      dispatchOrConfirm(candidate, intent, listRevision);
    },
    [dispatchOrConfirm, internal.state.kind],
  );

  const cancelChooser = useCallback(() => {
    if (internal.state.kind !== 'chooser') return;
    dispatch({ type: 'acknowledge' });
  }, [internal.state.kind]);

  const acknowledgeResult = useCallback(() => {
    dispatch({ type: 'acknowledge' });
  }, []);

  const cancelPending = useCallback(() => {
    const identity = inputRef.current.auditedSessionIdentity;
    const name = inputRef.current.auditedSessionName;
    if (!identity || !name) return;
    if (internal.state.kind !== 'pending' && internal.state.kind !== 'starting') return;
    const attemptId = internal.state.attemptId;
    if (internal.state.kind === 'starting') {
      cancelledStartTokenRef.current = startTokenRef.current;
    } else {
      void inputRef.current.adapter.cancelAttempt({
        auditedSessionName: name,
        auditedSessionIdentity: identity,
        attemptId,
      }).then((result) => {
        if (!result.ok) dispatch({ type: 'error', reason: result.reason, message: result.message });
      });
    }
  }, [internal.state]);

  return {
    state: internal.state,
    start,
    confirmConsent,
    cancelConsent,
    selectCandidate,
    cancelChooser,
    acknowledgeResult,
    cancelPending,
  };
}
