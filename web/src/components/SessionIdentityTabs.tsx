import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  SESSION_SETTING_IDENTITY_SCOPES,
  SESSION_IDENTITY_SCOPES,
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
  sessionIdentityContentLength,
  sessionIdentityMaxChars,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
  type SessionSettingIdentityScope,
} from '@shared/session-identity.js';
import {
  clearSessionIdentityProfileDirectFirst,
  fetchSessionIdentityProfileDirectFirst,
  saveSessionIdentityProfileDirectFirst,
} from '../session-identity-direct.js';
import type { WsClient } from '../ws-client.js';
import {
  requestSessionIdentityRefresh,
  SessionIdentityRefreshError,
} from '../session-identity-refresh.js';
import { FileBrowser, type FileBrowserPreviewState } from './file-browser-lazy.js';

type Draft = { content: string; initial: string; revision: number; sourceFile: string; loaded: boolean };
const emptyDraft = (): Draft => ({ content: '', initial: '', revision: 0, sourceFile: '', loaded: false });

export function SessionIdentityTabs({
  serverId,
  sessionName,
  projectKey,
  pairTaskId,
  ws,
  pendingSessionIdentity,
  onPendingSessionIdentityChange,
  disabled = false,
}: {
  serverId: string;
  sessionName?: string;
  projectKey?: string;
  pairTaskId?: string;
  ws?: WsClient | null;
  pendingSessionIdentity?: string;
  onPendingSessionIdentityChange?: (content: string, sourceFile: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [activeScope, setActiveScope] = useState<SessionSettingIdentityScope>(SESSION_IDENTITY_SCOPES.SESSION);
  const [drafts, setDrafts] = useState<Record<SessionSettingIdentityScope, Draft>>({
    user: emptyDraft(), project: emptyDraft(), pair: emptyDraft(), session: emptyDraft(),
  });
  const [resolvedScopeKeys, setResolvedScopeKeys] = useState<Record<SessionSettingIdentityScope, string>>({
    user: '', project: '', pair: '', session: '',
  });
  const [manualPairTaskId, setManualPairTaskId] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState('');

  const effectivePairTaskId = (pairTaskId?.trim() || manualPairTaskId.trim());

  const scopeKey = useMemo(() => ({
    user: '',
    project: projectKey?.trim() ?? '',
    pair: effectivePairTaskId,
    session: sessionName ? sessionIdentitySessionKey(serverId, sessionName) : '',
  }), [effectivePairTaskId, projectKey, serverId, sessionName]);
  const accessContext = useMemo(() => (sessionName ? { serverId, sessionName } : { serverId }), [serverId, sessionName]);

  const effectiveScopeKey = (scope: SessionSettingIdentityScope) => resolvedScopeKeys[scope] || scopeKey[scope];

  useEffect(() => {
    let live = true;
    void Promise.all(SESSION_SETTING_IDENTITY_SCOPES.map(async (scope) => {
      const key = scopeKey[scope];
      const shouldSkipFetch = (scope === SESSION_IDENTITY_SCOPES.SESSION && !sessionName)
        || (scope === SESSION_IDENTITY_SCOPES.PROJECT && !key && !sessionName)
        || (scope === SESSION_IDENTITY_SCOPES.PAIR && !key && !sessionName);
      if (shouldSkipFetch) {
        return [scope, {
          content: scope === SESSION_IDENTITY_SCOPES.SESSION ? pendingSessionIdentity ?? '' : '',
          initial: '', revision: 0, sourceFile: '', loaded: true,
        }, ''] as const;
      }
      const profile = await fetchSessionIdentityProfileDirectFirst(scope, key, accessContext, ws);
      return [scope, {
        content: profile?.content ?? '', initial: profile?.content ?? '', revision: profile?.revision ?? 0,
        sourceFile: profile?.sourceFile ?? '', loaded: true,
      }, profile?.scopeKey ?? ''] as const;
    })).then((entries) => {
      if (!live) return;
      const nextDrafts: Record<SessionSettingIdentityScope, Draft> = {
        user: emptyDraft(), project: emptyDraft(), pair: emptyDraft(), session: emptyDraft(),
      };
      const nextKeys: Record<SessionSettingIdentityScope, string> = {
        user: '', project: '', pair: '', session: '',
      };
      for (const [scope, draft, resolvedKey] of entries) {
        nextDrafts[scope] = draft;
        if (resolvedKey) nextKeys[scope] = resolvedKey;
      }
      setDrafts(nextDrafts);
      setResolvedScopeKeys((prev) => ({ ...prev, ...nextKeys }));
      setError('');
    }).catch((reason) => {
      // eslint-disable-next-line no-console
      console.error('DEBUG_TEMP', reason);
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { live = false; };
  }, [accessContext, scopeKey, sessionName, ws]);

  const draft = drafts[activeScope];
  const validationError = draft.content.trim() ? sessionIdentityContentError(draft.content, activeScope) : null;
  const currentKey = effectiveScopeKey(activeScope);
  const canPersist = activeScope === SESSION_IDENTITY_SCOPES.USER
    || Boolean(currentKey)
    || (activeScope === SESSION_IDENTITY_SCOPES.PROJECT && Boolean(sessionName))
    || (activeScope === SESSION_IDENTITY_SCOPES.PAIR && Boolean(sessionName || currentKey));

  const updateDraft = (next: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [activeScope]: { ...current[activeScope], ...next } }));
    if (activeScope === SESSION_IDENTITY_SCOPES.SESSION && !sessionName && next.content !== undefined) {
      onPendingSessionIdentityChange?.(next.content, next.sourceFile ?? draft.sourceFile);
    }
  };

  const save = async () => {
    if (!canPersist || validationError) return;
    setSaving(true);
    setError('');
    try {
      const content = draft.content.trim() ? normalizeSessionIdentityContent(draft.content) : '';
      let profile: SessionIdentityProfile | null = null;
      const contentChanged = content !== draft.initial;
      const keyToSave = effectiveScopeKey(activeScope);
      if (content && contentChanged) {
        profile = await saveSessionIdentityProfileDirectFirst({
          scope: activeScope,
          scopeKey: keyToSave,
          content,
          ...(draft.sourceFile ? { sourceFile: draft.sourceFile } : {}),
        }, accessContext, ws);
      } else if (!content && contentChanged && draft.revision > 0) {
        await clearSessionIdentityProfileDirectFirst(activeScope, keyToSave, accessContext);
      }
      if (profile?.scopeKey) {
        setResolvedScopeKeys((prev) => ({ ...prev, [activeScope]: profile.scopeKey }));
      }
      if (contentChanged) {
        setDrafts((current) => ({
          ...current,
          [activeScope]: {
            ...current[activeScope], content, initial: content, revision: profile?.revision ?? 0,
            sourceFile: profile?.sourceFile ?? (content ? draft.sourceFile : ''), loaded: true,
          },
        }));
      }
      if (sessionName && ws) {
        setRefreshPending(true);
        await requestSessionIdentityRefresh(ws, sessionName);
      }
      setRefreshPending(false);
    } catch (reason) {
      if (reason instanceof SessionIdentityRefreshError) {
        setError(reason.code === 'timeout'
          ? t('session.identityApplyTimeout')
          : t('session.identityApplyFailed', { error: reason.message }));
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="session-settings-field session-identity-tabs">
      <div class="session-settings-label">{t('session.identityTitle')}</div>
      <div class="session-identity-tab-list" role="tablist">
        {SESSION_SETTING_IDENTITY_SCOPES.map((scope) => (
          <button type="button" role="tab" aria-selected={activeScope === scope} class={activeScope === scope ? 'active' : ''}
            onClick={() => { setActiveScope(scope); setError(''); }}>
            {t(`session.identityScope_${scope}`)}
          </button>
        ))}
      </div>
      <div class="session-settings-help">{t(`session.identityHelp_${activeScope}`)}</div>
      {activeScope === SESSION_IDENTITY_SCOPES.PAIR && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', flexWrap: 'wrap', fontSize: 12 }}>
          {currentKey ? (
            <>
              <span class="session-settings-muted">{t('session.identityPairTask')}:</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--chrome-accent, #38bdf8)' }}>{currentKey}</span>
              {!pairTaskId && (
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  onClick={() => {
                    setManualPairTaskId('');
                    setResolvedScopeKeys((prev) => ({ ...prev, pair: '' }));
                    updateDraft({ content: '', initial: '', revision: 0, loaded: true });
                  }}
                >
                  {t('session.identityPairSwitchTask')}
                </button>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
              <input
                class="input"
                aria-label="session-identity-pair-task-id"
                value={manualPairTaskId}
                onInput={(e) => setManualPairTaskId((e.target as HTMLInputElement).value)}
                placeholder={t('session.identityPairTaskPlaceholder')}
                style={{ flex: 1, maxWidth: 280, fontSize: 12 }}
                disabled={disabled || saving}
              />
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                disabled={disabled || saving || !manualPairTaskId.trim()}
                onClick={() => {
                  const tid = manualPairTaskId.trim();
                  if (!tid) return;
                  setDrafts((prev) => ({ ...prev, pair: { ...prev.pair, loaded: false } }));
                  fetchSessionIdentityProfileDirectFirst(SESSION_IDENTITY_SCOPES.PAIR, tid, accessContext, ws)
                    .then((profile) => {
                      setDrafts((prev) => ({
                        ...prev,
                        pair: {
                          content: profile?.content ?? '', initial: profile?.content ?? '',
                          revision: profile?.revision ?? 0, sourceFile: profile?.sourceFile ?? '', loaded: true,
                        },
                      }));
                      setResolvedScopeKeys((prev) => ({ ...prev, pair: tid }));
                    })
                    .catch((err) => {
                      setError(err instanceof Error ? err.message : String(err));
                      setDrafts((prev) => ({ ...prev, pair: { ...prev.pair, loaded: true } }));
                    });
                }}
              >
                {t('session.identityPairLoadTask')}
              </button>
            </div>
          )}
        </div>
      )}
      <textarea
        class="input"
        aria-label="session-identity-content"
        value={draft.content}
        onInput={(event) => updateDraft({ content: (event.target as HTMLTextAreaElement).value, sourceFile: '' })}
        rows={6}
        style={{ width: '100%', resize: 'vertical' }}
        disabled={disabled || saving || !draft.loaded}
        placeholder={t('session.identityPlaceholder')}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {ws && <button type="button" class="btn btn-secondary" disabled={disabled || saving} onClick={() => setShowBrowser(true)}>
          {t('session.identityChooseFile')}
        </button>}
        <button type="button" class="btn btn-secondary" disabled={disabled || saving || !draft.content}
          onClick={() => updateDraft({ content: '', sourceFile: '' })}>{t('session.identityClear')}</button>
        <button type="button" class="btn btn-primary"
          disabled={disabled || saving || !draft.loaded || Boolean(validationError) || (!refreshPending && draft.content === draft.initial) || !canPersist}
          onClick={() => { void save(); }}>
          {canPersist ? t('session.identityApply') : t('session.identitySaveAfterCreate')}
        </button>
        <span class="session-settings-muted">{t('session.identityCharacterCount', {
          count: sessionIdentityContentLength(draft.content), limit: sessionIdentityMaxChars(activeScope),
        })}</span>
      </div>
      {draft.sourceFile && <div class="session-settings-muted">{t('session.identitySelectedFile', { path: draft.sourceFile })}</div>}
      {validationError && <div class="session-settings-error">{t('session.identityTooLargeScoped', { limit: sessionIdentityMaxChars(activeScope) })}</div>}
      {error && <div class="session-settings-error">{error}</div>}
      {showBrowser && ws && <FileBrowser
        ws={ws} mode="file-single" layout="modal" initialPath="~" serverId={serverId} sessionName={sessionName}
        scopeToSessionRoot={Boolean(sessionName) && activeScope !== SESSION_IDENTITY_SCOPES.SESSION} readOnly
        onConfirm={(paths, preview?: FileBrowserPreviewState) => {
          const selectedPath = paths[0];
          if (!selectedPath || preview?.status !== 'ok' || preview.path !== selectedPath) {
            setError(t('session.identityPreviewRequired')); return;
          }
          if (sessionIdentityContentError(preview.content, activeScope)) {
            setError(t('session.identityTooLargeScoped', { limit: sessionIdentityMaxChars(activeScope) })); return;
          }
          updateDraft({ content: preview.content, sourceFile: selectedPath });
          setError(''); setShowBrowser(false);
        }}
        onClose={() => setShowBrowser(false)}
      />}
    </div>
  );
}
