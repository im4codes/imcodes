import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  SESSION_IDENTITY_SCOPE_LIST,
  SESSION_IDENTITY_SCOPES,
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
  sessionIdentityMaxChars,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '@shared/session-identity.js';
import {
  clearSessionIdentityProfile,
  fetchSessionIdentityProfile,
  saveSessionIdentityProfile,
} from '../api.js';
import type { WsClient } from '../ws-client.js';
import { requestSessionIdentityRefresh } from '../session-identity-refresh.js';
import { FileBrowser, type FileBrowserPreviewState } from './file-browser-lazy.js';

type Draft = { content: string; initial: string; revision: number; sourceFile: string; loaded: boolean };
const emptyDraft = (): Draft => ({ content: '', initial: '', revision: 0, sourceFile: '', loaded: false });

export function SessionIdentityTabs({
  serverId,
  sessionName,
  projectKey,
  ws,
  pendingSessionIdentity,
  onPendingSessionIdentityChange,
  disabled = false,
}: {
  serverId: string;
  sessionName?: string;
  projectKey?: string;
  ws?: WsClient | null;
  pendingSessionIdentity?: string;
  onPendingSessionIdentityChange?: (content: string, sourceFile: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [activeScope, setActiveScope] = useState<SessionIdentityScope>(SESSION_IDENTITY_SCOPES.SESSION);
  const [drafts, setDrafts] = useState<Record<SessionIdentityScope, Draft>>({
    user: emptyDraft(), project: emptyDraft(), session: emptyDraft(),
  });
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState('');

  const scopeKey = useMemo(() => ({
    user: '',
    project: projectKey?.trim() ?? '',
    session: sessionName ? `${serverId}:${sessionName}` : '',
  }), [projectKey, serverId, sessionName]);

  useEffect(() => {
    let live = true;
    void Promise.all(SESSION_IDENTITY_SCOPE_LIST.map(async (scope) => {
      const key = scopeKey[scope];
      if ((scope !== SESSION_IDENTITY_SCOPES.USER && !key) || (scope === SESSION_IDENTITY_SCOPES.SESSION && !sessionName)) {
        return [scope, {
          content: scope === SESSION_IDENTITY_SCOPES.SESSION ? pendingSessionIdentity ?? '' : '',
          initial: '', revision: 0, sourceFile: '', loaded: true,
        }] as const;
      }
      const profile = await fetchSessionIdentityProfile(scope, key);
      return [scope, {
        content: profile?.content ?? '', initial: profile?.content ?? '', revision: profile?.revision ?? 0,
        sourceFile: profile?.sourceFile ?? '', loaded: true,
      }] as const;
    })).then((entries) => {
      if (!live) return;
      setDrafts(Object.fromEntries(entries) as Record<SessionIdentityScope, Draft>);
      setError('');
    }).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { live = false; };
  }, [scopeKey, sessionName]);

  const draft = drafts[activeScope];
  const validationError = draft.content.trim() ? sessionIdentityContentError(draft.content, activeScope) : null;
  const canPersist = activeScope === SESSION_IDENTITY_SCOPES.USER || Boolean(scopeKey[activeScope]);

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
      if (content && contentChanged) {
        profile = await saveSessionIdentityProfile({
          scope: activeScope,
          scopeKey: scopeKey[activeScope],
          content,
          ...(draft.sourceFile ? { sourceFile: draft.sourceFile } : {}),
        });
      } else if (!content && contentChanged && draft.revision > 0) {
        await clearSessionIdentityProfile(activeScope, scopeKey[activeScope]);
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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="session-settings-field session-identity-tabs">
      <div class="session-settings-label">{t('session.identityTitle')}</div>
      <div class="session-identity-tab-list" role="tablist">
        {SESSION_IDENTITY_SCOPE_LIST.map((scope) => (
          <button type="button" role="tab" aria-selected={activeScope === scope} class={activeScope === scope ? 'active' : ''}
            onClick={() => { setActiveScope(scope); setError(''); }}>
            {t(`session.identityScope_${scope}`)}
          </button>
        ))}
      </div>
      <div class="session-settings-help">{t(`session.identityHelp_${activeScope}`)}</div>
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
          count: Array.from(draft.content).length, limit: sessionIdentityMaxChars(activeScope),
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
