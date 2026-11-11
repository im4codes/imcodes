import { useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import type { SessionInfo } from '../types.js';
import type { SharedPayload } from '../services/share-receiver.js';
import { formatLabel } from '../format-label.js';
import { formatTransferBytes } from '../util/transfer-format.js';
import { isNavigableMainSession } from '../session-list-merge.js';

export interface ShareTargetServerItem {
  id: string;
  name: string;
}

export interface ShareTargetModalProps {
  payload: SharedPayload;
  servers: readonly ShareTargetServerItem[];
  selectedServerId: string | null;
  sessions: readonly SessionInfo[];
  activeSession: string | null;
  sessionsLoading?: boolean;
  onSelectServer: (serverId: string) => void;
  onSelectSession: (serverId: string, sessionName: string) => void;
  onClose: () => void;
}

export function ShareTargetModal({
  payload,
  servers,
  selectedServerId,
  sessions,
  activeSession,
  sessionsLoading = false,
  onSelectServer,
  onSelectSession,
  onClose,
}: ShareTargetModalProps) {
  const { t } = useTranslation();

  const effectiveServerId = selectedServerId ?? servers[0]?.id ?? '';

  useEffect(() => {
    if (!selectedServerId && servers.length > 0 && servers[0]?.id) {
      onSelectServer(servers[0].id);
    }
  }, [onSelectServer, selectedServerId, servers]);

  const orderedMainSessions = useMemo(() => {
    const main = sessions.filter(isNavigableMainSession);
    if (!activeSession) return main;
    const activeIdx = main.findIndex((s) => s.name === activeSession);
    if (activeIdx <= 0) return main;
    const activeItem = main[activeIdx]!;
    return [activeItem, ...main.slice(0, activeIdx), ...main.slice(activeIdx + 1)];
  }, [activeSession, sessions]);

  const hasUsableContent = payload.files.length > 0 || Boolean(payload.text && payload.text.trim());

  const errorMessage = useMemo(() => {
    if (!payload.error) return null;
    if (payload.error === FS_READ_ERROR_CODES.FILE_TOO_LARGE) {
      return t('shareTarget.error.file_too_large', { max: 50 });
    }
    if (payload.error === 'read_failed') {
      return t('shareTarget.error.read_failed');
    }
    if (payload.error === 'partial_files_skipped') {
      return t('shareTarget.error.partial_files_skipped');
    }
    return t('shareTarget.error.generic');
  }, [payload.error, t]);

  return (
    <div
      class="modal-backdrop"
      data-testid="share-target-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9500,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shareTarget.title')}
        data-testid="share-target-modal"
        style={{
          width: '100%',
          maxWidth: 460,
          maxHeight: '85vh',
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
          color: '#e2e8f0',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid #1e293b',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {t('shareTarget.title')}
          </div>
          <button
            type="button"
            class="btn"
            aria-label={t('common.close')}
            data-testid="share-target-close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 18,
              lineHeight: 1,
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: 16,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {errorMessage && (
            <div
              role="alert"
              data-testid="share-target-error"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.14)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#fca5a5',
                fontSize: 13,
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* Shared files summary */}
          {payload.files.length > 0 && (
            <div
              data-testid="share-target-files-section"
              style={{
                background: '#1e293b',
                borderRadius: 8,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                {t('shareTarget.files_summary', { count: payload.files.length })}
              </div>
              <div
                data-testid="share-target-file-list"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  maxHeight: 110,
                  overflowY: 'auto',
                }}
              >
                {payload.files.map((file, idx) => (
                  <div
                    key={`${file.name}-${idx}`}
                    data-testid="share-target-file-item"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: '#f8fafc',
                      }}
                    >
                      📎 {file.name}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
                      {formatTransferBytes(file.size)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Optional shared text preview */}
          {payload.text && (
            <div
              data-testid="share-target-text-preview"
              style={{
                background: '#1e293b',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 12,
                color: '#cbd5e1',
                maxHeight: 72,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {payload.text}
            </div>
          )}

          {/* Server selector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              for="share-target-server-select"
              style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}
            >
              {t('shareTarget.server_label')}
            </label>
            <select
              id="share-target-server-select"
              data-testid="share-target-server-select"
              value={effectiveServerId}
              disabled={servers.length === 0}
              onInput={(e) => {
                const nextServerId = ((e.currentTarget ?? e.target) as HTMLSelectElement).value;
                if (nextServerId && nextServerId !== selectedServerId) {
                  onSelectServer(nextServerId);
                }
              }}
              onChange={(e) => {
                const nextServerId = ((e.currentTarget ?? e.target) as HTMLSelectElement).value;
                if (nextServerId && nextServerId !== selectedServerId) {
                  onSelectServer(nextServerId);
                }
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                background: '#1e293b',
                border: '1px solid #334155',
                color: '#f8fafc',
                fontSize: 13,
              }}
            >
              {servers.length === 0 ? (
                <option value="">{t('shareTarget.no_servers')}</option>
              ) : (
                servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Main sessions list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
              {t('shareTarget.main_sessions_label')}
            </div>

            {sessionsLoading && orderedMainSessions.length === 0 ? (
              <div
                data-testid="share-target-sessions-loading"
                style={{
                  padding: '20px 12px',
                  textAlign: 'center',
                  color: '#94a3b8',
                  fontSize: 13,
                }}
              >
                {t('shareTarget.loading_sessions')}
              </div>
            ) : orderedMainSessions.length === 0 ? (
              <div
                data-testid="share-target-no-sessions"
                style={{
                  padding: '20px 12px',
                  textAlign: 'center',
                  color: '#64748b',
                  fontSize: 13,
                  background: '#1e293b',
                  borderRadius: 8,
                }}
              >
                {t('shareTarget.no_sessions')}
              </div>
            ) : (
              <div
                data-testid="share-target-session-list"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  maxHeight: 260,
                  overflowY: 'auto',
                }}
              >
                {orderedMainSessions.map((session) => {
                  const isCurrent = session.name === activeSession;
                  const displayTitle = session.label
                    ? formatLabel(session.label)
                    : (session.project || session.name);
                  return (
                    <button
                      key={session.name}
                      type="button"
                      data-testid={`share-target-session-${session.name}`}
                      disabled={!hasUsableContent || !effectiveServerId}
                      onClick={() => {
                        if (!effectiveServerId || !hasUsableContent) return;
                        onSelectSession(effectiveServerId, session.name);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: isCurrent ? 'rgba(59, 130, 246, 0.16)' : '#1e293b',
                        border: isCurrent ? '1px solid #3b82f6' : '1px solid #334155',
                        color: '#f8fafc',
                        cursor: hasUsableContent && effectiveServerId ? 'pointer' : 'not-allowed',
                        opacity: hasUsableContent && effectiveServerId ? 1 : 0.5,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontWeight: 600,
                            fontSize: 13,
                          }}
                        >
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {displayTitle}
                          </span>
                          {isCurrent && (
                            <span
                              data-testid="share-target-current-badge"
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 999,
                                background: '#2563eb',
                                color: '#ffffff',
                                fontWeight: 600,
                                flexShrink: 0,
                              }}
                            >
                              {t('shareTarget.current_session')}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: '#94a3b8',
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {session.project ? `${session.project} · ` : ''}{session.agentType}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, color: '#60a5fa', flexShrink: 0 }}>
                        →
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {t('shareTarget.composer_hint')}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 16px',
            borderTop: '1px solid #1e293b',
          }}
        >
          <button
            type="button"
            class="btn btn-secondary"
            data-testid="share-target-cancel"
            onClick={onClose}
            style={{ fontSize: 12 }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
