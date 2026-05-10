import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { ApiError } from '../api.js';
import { FileBrowser } from './file-browser-lazy.js';
import { isRunningSessionState } from '../thinking-utils.js';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  SESSION_GROUP_CLONE_MSG,
  defaultCloneTargetProjectName,
  mainSessionNameForProjectSlug,
  resolveCloneTargetProject,
  type SessionGroupCloneCleanupResource,
  type SessionGroupCloneErrorCode,
  type SessionGroupCloneEvent,
  type SessionGroupCloneSkippedMember,
  type SessionGroupCloneState,
  type SessionGroupCloneWarning,
} from '@shared/session-group-clone.js';
import { sanitizeProjectName } from '@shared/sanitize-project-name.js';

interface Props {
  ws: WsClient | null;
  serverId?: string;
  sourceSession: SessionInfo;
  sessions?: SessionInfo[];
  subSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  onClose: () => void;
}

type CloneSubmissionState = 'idle' | 'pending' | 'succeeded' | 'failed' | 'cleanup_required' | 'cancelled';

interface CloneUiState {
  submission: CloneSubmissionState;
  operationId: string | null;
  state: SessionGroupCloneState | null;
  clonedMainSessionName: string | null;
  totalSubSessions: number | null;
  subSessionsCreated: number | null;
  skippedMembers: SessionGroupCloneSkippedMember[];
  skippedCronJobs: number;
  skippedOrchestrationRuns: number;
  warnings: SessionGroupCloneWarning[];
  errorCode: SessionGroupCloneErrorCode | null;
  cleanupRequired: boolean;
  cleanupResources: SessionGroupCloneCleanupResource[];
}

const INITIAL_UI_STATE: CloneUiState = {
  submission: 'idle',
  operationId: null,
  state: null,
  clonedMainSessionName: null,
  totalSubSessions: null,
  subSessionsCreated: null,
  skippedMembers: [],
  skippedCronJobs: 0,
  skippedOrchestrationRuns: 0,
  warnings: [],
  errorCode: null,
  cleanupRequired: false,
  cleanupResources: [],
};

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `clone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getTranslationKey(base: string, code: string): string {
  return `${base}.${code}`;
}

function isCloneEvent(msg: ServerMessage): msg is SessionGroupCloneEvent {
  return msg.type === SESSION_GROUP_CLONE_MSG.EVENT;
}

function mergeWarnings(
  current: SessionGroupCloneWarning[],
  incoming: SessionGroupCloneWarning[] | undefined,
): SessionGroupCloneWarning[] {
  if (!incoming?.length) return current;
  const seen = new Set(current.map((warning) => JSON.stringify(warning)));
  const next = [...current];
  for (const warning of incoming) {
    const key = JSON.stringify(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(warning);
  }
  return next;
}

function mergeSkippedMembers(
  current: SessionGroupCloneSkippedMember[],
  incoming: SessionGroupCloneSkippedMember[] | undefined,
): SessionGroupCloneSkippedMember[] {
  if (!incoming?.length) return current;
  const seen = new Set(current.map((member) => `${member.sessionName}:${member.reason}`));
  const next = [...current];
  for (const member of incoming) {
    const key = `${member.sessionName}:${member.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(member);
  }
  return next;
}

function formatWarningDetail(
  warning: SessionGroupCloneWarning,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const label = t(getTranslationKey('session.clone.warningCode', warning.code));
  const details = [
    warning.sourceSessionName,
    warning.fieldPath,
  ].filter((value): value is string => !!value && value.trim().length > 0);
  return details.length > 0 ? `${label}: ${details.join(' / ')}` : label;
}

function formatSkippedMember(
  member: SessionGroupCloneSkippedMember,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return t('session.clone.skippedMemberDetail', {
    session: member.sessionName,
    reason: t(getTranslationKey('session.clone.skippedReason', member.reason)),
  });
}

function formatCleanupResource(
  resource: SessionGroupCloneCleanupResource,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return t('session.clone.cleanupResourceDetail', {
    kind: t(getTranslationKey('session.clone.cleanupResourceKind', resource.kind)),
    id: resource.id,
  });
}

function canUseKnownCloneCapability(ws: WsClient | null): boolean {
  if (!ws) return true;
  const snapshot = ws.getDaemonCapabilitySnapshot?.() ?? null;
  if (!snapshot) return true;
  if (ws.isDaemonCapabilityStale?.()) return true;
  return snapshot.capabilities.includes(SESSION_GROUP_CLONE_CAPABILITY_V1);
}

function cloneErrorCodeFromError(error: unknown): SessionGroupCloneErrorCode {
  if (error instanceof ApiError) {
    if (error.code) return error.code as SessionGroupCloneErrorCode;
    if (error.status === 403) return 'forbidden';
    if (error.status === 404) return 'source_not_found';
  }
  return 'internal_error';
}

export function CloneSessionGroupDialog({
  ws,
  serverId,
  sourceSession,
  sessions,
  subSessions,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const idempotencyKeyRef = useRef(createIdempotencyKey());
  const acceptedOperationIdRef = useRef<string | null>(null);
  const successHandledRef = useRef(false);
  const [targetProjectName, setTargetProjectName] = useState(() => {
    const visibleSessionNames = new Set<string>([
      sourceSession.name,
      ...(sessions ?? []).map((session) => session.name),
      ...(subSessions ?? []).map((session) => session.sessionName),
    ]);
    try {
      return defaultCloneTargetProjectName(
        sourceSession.project,
        (sessionName) => !visibleSessionNames.has(sessionName),
      );
    } catch {
      return `${sourceSession.project}_1`;
    }
  });
  const [useCwdOverride, setUseCwdOverride] = useState(false);
  const [cwdOverride, setCwdOverride] = useState('');
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [uiState, setUiState] = useState<CloneUiState>(INITIAL_UI_STATE);

  const idempotencyKey = idempotencyKeyRef.current;
  const directChildSessions = useMemo(
    () => (subSessions ?? []).filter((session) => session.parentSession === sourceSession.name),
    [sourceSession.name, subSessions],
  );
  const sourceRunning = isRunningSessionState(sourceSession.state)
    || directChildSessions.some((session) => isRunningSessionState(session.state));
  const capabilityReady = canUseKnownCloneCapability(ws);
  const targetProjectTrimmed = targetProjectName.trim();
  const previewSessionName = targetProjectTrimmed
    ? mainSessionNameForProjectSlug(sanitizeProjectName(targetProjectTrimmed))
    : '';
  const busy = uiState.submission === 'pending';
  const terminal = uiState.submission === 'succeeded'
    || uiState.submission === 'failed'
    || uiState.submission === 'cleanup_required'
    || uiState.submission === 'cancelled';

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (!isCloneEvent(msg)) return;
      if (msg.idempotencyKey !== idempotencyKey) return;
      const activeOperationId = acceptedOperationIdRef.current;
      if (activeOperationId && msg.operationId !== activeOperationId) return;
      acceptedOperationIdRef.current = msg.operationId;

      setUiState((current) => {
        const skippedMembers = mergeSkippedMembers(
          mergeSkippedMembers(current.skippedMembers, msg.skippedMembers),
          msg.result?.skippedMembers,
        );
        const warnings = mergeWarnings(
          mergeWarnings(current.warnings, msg.warnings),
          msg.result?.warnings,
        );
        const clonedMainSessionName = msg.result?.clonedMainSession
          ?? msg.clonedMainSessionName
          ?? current.clonedMainSessionName;
        const errorCode = msg.errorCode ?? current.errorCode;
        const cleanupRequired = msg.cleanupRequired
          || msg.state === 'cleanup_required'
          || errorCode === 'cleanup_required'
          || current.cleanupRequired;
        const submission: CloneSubmissionState =
          msg.state === 'succeeded' ? 'succeeded'
            : msg.state === 'cleanup_required' ? 'cleanup_required'
              : msg.state === 'cancelled' ? 'cancelled'
                : msg.state === 'failed' ? 'failed'
                  : 'pending';

        return {
          submission,
          operationId: msg.operationId,
          state: msg.state,
          clonedMainSessionName,
          totalSubSessions: msg.totalSubSessions ?? current.totalSubSessions,
          subSessionsCreated: msg.subSessionsCreated ?? current.subSessionsCreated,
          skippedMembers,
          skippedCronJobs: msg.result?.skippedCronJobs ?? msg.skippedCronJobs ?? current.skippedCronJobs,
          skippedOrchestrationRuns: msg.result?.skippedOrchestrationRuns ?? msg.skippedOrchestrationRuns ?? current.skippedOrchestrationRuns,
          warnings,
          errorCode,
          cleanupRequired,
          cleanupResources: msg.cleanupResources ?? current.cleanupResources,
        };
      });

      if (msg.state === 'succeeded') {
        const clonedMainSession = msg.result?.clonedMainSession ?? msg.clonedMainSessionName;
        if (clonedMainSession && !successHandledRef.current) {
          successHandledRef.current = true;
          try { ws.requestSessionList(); } catch {}
          try { ws.p2pStatus?.({ sessionName: clonedMainSession }); } catch {}
          try { ws.p2pListDiscussions?.({ sessionName: clonedMainSession }); } catch {}
          try {
            window.dispatchEvent(new CustomEvent('deck:navigate', {
              detail: { serverId, session: clonedMainSession },
            }));
          } catch {
            // CustomEvent can be unavailable in very old embedded webviews.
          }
        }
      }
    });
  }, [idempotencyKey, serverId, ws]);

  const submit = () => {
    if (busy) return;
    const trimmed = targetProjectName.trim();
    if (!trimmed) {
      setLocalError(t('session.clone.blankProject'));
      return;
    }
    if (!ws) {
      setLocalError(t('session.clone.notConnected'));
      return;
    }
    if (!ws.connected) {
      setLocalError(t('session.clone.daemonOffline'));
      return;
    }
    if (!serverId?.trim()) {
      setLocalError(t('session.clone.missingServer'));
      return;
    }
    if (!capabilityReady) {
      setLocalError(t('session.clone.capabilityMissing', { capability: SESSION_GROUP_CLONE_CAPABILITY_V1 }));
      return;
    }
    if (useCwdOverride && !cwdOverride.trim()) {
      setLocalError(t('session.clone.cwdRequired'));
      return;
    }

    try {
      resolveCloneTargetProject(trimmed);
    } catch {
      setLocalError(t('session.clone.blankProject'));
      return;
    }

    setLocalError(null);
    setUiState({
      ...INITIAL_UI_STATE,
      submission: 'pending',
    });
    try {
      void Promise.resolve(ws.cloneSessionGroup({
        serverId,
        sourceMainSessionName: sourceSession.name,
        targetProjectName: trimmed,
        cwdOverride: useCwdOverride ? cwdOverride.trim() : null,
        idempotencyKey,
      })).catch((error) => {
        setUiState({
          ...INITIAL_UI_STATE,
          submission: 'failed',
          errorCode: cloneErrorCodeFromError(error),
        });
      });
    } catch (error) {
      setUiState({
        ...INITIAL_UI_STATE,
        submission: 'failed',
        errorCode: cloneErrorCodeFromError(error),
      });
    }
  };

  const errorText = uiState.errorCode
    ? t(getTranslationKey('session.clone.errorCode', uiState.errorCode), {
        capability: SESSION_GROUP_CLONE_CAPABILITY_V1,
      })
    : null;
  const operationLabel = uiState.state
    ? t(getTranslationKey('session.clone.state', uiState.state))
    : null;
  const copiedCountText = uiState.totalSubSessions !== null || uiState.subSessionsCreated !== null
    ? t('session.clone.subSessionProgress', {
        created: uiState.subSessionsCreated ?? 0,
        total: uiState.totalSubSessions ?? 0,
      })
    : null;

  return (
    <div class="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="clone-session-group-title">
      <div class="dialog" style={{ width: 'min(560px, calc(100vw - 24px))' }}>
        <div class="dialog-header">
          <h2 id="clone-session-group-title">{t('session.clone.title')}</h2>
          <button type="button" class="dialog-close" onClick={onClose} aria-label={t('common.close')}>x</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{t('session.clone.source')}</label>
            <input type="text" value={sourceSession.name} disabled readOnly />
          </div>

          <div class="form-group">
            <label>{t('session.clone.targetProjectName')}</label>
            <input
              type="text"
              value={targetProjectName}
              disabled={busy}
              placeholder={t('session.clone.targetProjectPlaceholder')}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              data-lpignore="true"
              data-1p-ignore
              onInput={(event) => {
                setTargetProjectName((event.target as HTMLInputElement).value);
                setLocalError(null);
              }}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, auto) 1fr',
              gap: 8,
              alignItems: 'center',
              marginBottom: 16,
              fontSize: 12,
              color: '#94a3b8',
            }}
          >
            <div>{t('session.clone.finalSessionName')}</div>
            <code style={{ color: '#e2e8f0', overflowWrap: 'anywhere' }}>
              {previewSessionName || t('session.clone.previewUnavailable')}
            </code>
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              color: '#cbd5e1',
              fontSize: 13,
              lineHeight: 1.4,
              marginBottom: 10,
            }}
          >
            <input
              type="checkbox"
              checked={useCwdOverride}
              disabled={busy}
              onChange={(event) => {
                setUseCwdOverride((event.target as HTMLInputElement).checked);
                setLocalError(null);
              }}
              style={{ marginTop: 2 }}
            />
            <span>{t(useCwdOverride ? 'session.clone.overrideDirectories' : 'session.clone.preserveDirectories')}</span>
          </label>

          {useCwdOverride && (
            <div class="form-group">
              <label>{t('session.clone.cwdOverride')}</label>
              <div class="input-with-browse">
                <input
                  type="text"
                  value={cwdOverride}
                  disabled={busy}
                  placeholder={t('session.clone.cwdOverridePlaceholder')}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellcheck={false}
                  data-lpignore="true"
                  data-1p-ignore
                  onInput={(event) => {
                    setCwdOverride((event.target as HTMLInputElement).value);
                    setLocalError(null);
                  }}
                />
                {ws && (
                  <button
                    type="button"
                    class="btn-browse"
                    disabled={busy}
                    title={t('session.clone.browseCwd')}
                    aria-label={t('session.clone.browseCwd')}
                    onClick={() => setShowDirBrowser(true)}
                  >
                    ...
                  </button>
                )}
              </div>
            </div>
          )}

          {showDirBrowser && ws && (
            <FileBrowser
              ws={ws}
              mode="dir-only"
              layout="modal"
              initialPath={cwdOverride || sourceSession.projectDir || '~'}
              onConfirm={(paths) => {
                setCwdOverride(paths[0] ?? '');
                setShowDirBrowser(false);
              }}
              onClose={() => setShowDirBrowser(false)}
            />
          )}

          <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
            {t('session.clone.daemonHostValidation')}
          </div>

          {sourceRunning && (
            <div style={{ border: '1px solid #92400e', background: '#291505', color: '#fbbf24', borderRadius: 6, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              {t('session.clone.runningWarning')}
            </div>
          )}

          {!capabilityReady && (
            <div style={{ border: '1px solid #7f1d1d', background: '#1f0808', color: '#fca5a5', borderRadius: 6, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              {t('session.clone.capabilityMissing', { capability: SESSION_GROUP_CLONE_CAPABILITY_V1 })}
            </div>
          )}

          {(operationLabel || copiedCountText || uiState.operationId) && (
            <div role="status" aria-live="polite" style={{ border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', color: '#cbd5e1', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              {operationLabel && <div>{t('session.clone.progress', { state: operationLabel })}</div>}
              {copiedCountText && <div>{copiedCountText}</div>}
              {uiState.operationId && <div>{t('session.clone.operationId', { operationId: uiState.operationId })}</div>}
            </div>
          )}

          {uiState.submission === 'succeeded' && uiState.clonedMainSessionName && (
            <div style={{ border: '1px solid #166534', background: '#052e16', color: '#bbf7d0', borderRadius: 6, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              {t('session.clone.success', { session: uiState.clonedMainSessionName })}
            </div>
          )}

          {(uiState.cleanupRequired || uiState.submission === 'cleanup_required') && (
            <div style={{ border: '1px solid #92400e', background: '#291505', color: '#fbbf24', borderRadius: 6, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              <strong>{t('session.clone.cleanupRequired')}</strong>
              <div>{t('session.clone.cleanupRequiredBody')}</div>
              {uiState.cleanupResources.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {uiState.cleanupResources.slice(0, 8).map((resource) => (
                    <div key={`${resource.kind}-${resource.id}`}>{formatCleanupResource(resource, t)}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(localError || errorText) && (
            <div style={{ border: '1px solid #7f1d1d', background: '#1f0808', color: '#fca5a5', borderRadius: 6, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              {localError ?? errorText}
            </div>
          )}

          {uiState.warnings.length > 0 && (
            <div style={{ color: '#fbbf24', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              <div>{t('session.clone.warningsTitle', { count: uiState.warnings.length })}</div>
              {uiState.warnings.slice(0, 6).map((warning, index) => (
                <div key={`${warning.code}-${warning.fieldPath ?? ''}-${index}`}>
                  {formatWarningDetail(warning, t)}
                </div>
              ))}
            </div>
          )}

          {(uiState.skippedMembers.length > 0 || uiState.skippedCronJobs > 0 || uiState.skippedOrchestrationRuns > 0) && (
            <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              {uiState.skippedMembers.length > 0 && (
                <>
                  <div>{t('session.clone.skippedMembersTitle', { count: uiState.skippedMembers.length })}</div>
                  {uiState.skippedMembers.slice(0, 6).map((member) => (
                    <div key={`${member.sessionName}-${member.reason}`}>{formatSkippedMember(member, t)}</div>
                  ))}
                </>
              )}
              {uiState.skippedCronJobs > 0 && <div>{t('session.clone.skippedCronJobs', { count: uiState.skippedCronJobs })}</div>}
              {uiState.skippedOrchestrationRuns > 0 && <div>{t('session.clone.skippedOrchestrationRuns', { count: uiState.skippedOrchestrationRuns })}</div>}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" class="btn btn-secondary" onClick={onClose}>
              {terminal ? t('common.close') : t('common.cancel')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || terminal}
              onClick={submit}
            >
              {busy ? t('session.clone.submitting') : t('session.clone.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
