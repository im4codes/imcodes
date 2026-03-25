import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import { FileBrowser } from './FileBrowser.js';
import { getUserPref, saveUserPref } from '../api.js';
import { useProviderStatus } from '../hooks/useProviderStatus.js';

const DEFAULT_SHELL_KEY = 'default_shell';

interface Props {
  ws: WsClient | null;
  onClose: () => void;
  onSessionStarted: (sessionName: string) => void;
}

type AgentType = 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'openclaw';
type OpenClawMode = 'new' | 'bind';

interface RemoteSession {
  id: string;
  label: string;
}

export function NewSessionDialog({ ws, onClose, onSessionStarted }: Props) {
  const { t } = useTranslation();
  const [project, setProject] = useState('');
  const [dir, setDir] = useState('~/');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [ocDescription, setOcDescription] = useState('');
  const [ocRemoteSessions, setOcRemoteSessions] = useState<RemoteSession[]>([]);
  const [ocLoadingSessions, setOcLoadingSessions] = useState(false);
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  const { isProviderConnected } = useProviderStatus(ws);
  const openClawAvailable = isProviderConnected('openclaw');

  // Load saved shell preference from server, then detect available shells
  useEffect(() => {
    void getUserPref(DEFAULT_SHELL_KEY).then((saved) => {
      if (typeof saved === 'string' && saved) setShellBin(saved);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        const list = msg.shells as string[];
        setShells(list);
        // Keep saved preference if it's available, otherwise pick first
        setShellBin((prev) => (list.includes(prev) ? prev : (list[0] ?? prev)));
      }
      // Listen for openclaw remote session list response
      const raw = msg as unknown as Record<string, unknown>;
      if (raw['type'] === 'openclaw.sessions_response') {
        const sessions = raw['sessions'] as RemoteSession[] | undefined;
        setOcRemoteSessions(sessions ?? []);
        setOcLoadingSessions(false);
      }
    });
    ws.subSessionDetectShells?.();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Fetch remote sessions when bind mode is selected
  useEffect(() => {
    if (agentType !== 'openclaw' || ocMode !== 'bind' || !ws) return;
    setOcLoadingSessions(true);
    setOcRemoteSessions([]);
    ws.send({ type: 'openclaw.list_sessions' });
  }, [agentType, ocMode, ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (agentType === 'openclaw' && ocMode === 'new' && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [agentType, ocMode, ocSessionKey]);

  // (openclaw fallback removed — show connect hint instead of auto-switching)

  // Listen for session.event started/error while dialog is open
  useEffect(() => {
    if (!ws || !starting) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        const name = msg.session ?? '';
        if (msg.event === 'started' && name.startsWith(`deck_${project.trim()}_`)) {
          unsub();
          onSessionStarted(name);
          onClose();
        } else if (msg.event === 'error' && name.startsWith(`deck_${project.trim()}_`)) {
          unsub();
          setError(`Session failed to start: ${msg.state}`);
          setStarting(false);
        }
      }
      if (msg.type === 'session.error') {
        unsub();
        setError((msg as unknown as { message: string }).message || 'Failed to start session');
        setStarting(false);
      }
    });

    // Timeout after 15s
    const timeout = setTimeout(() => {
      unsub();
      setError(t('new_session.timeout'));
      setStarting(false);
    }, 15_000);

    return () => { unsub(); clearTimeout(timeout); };
  }, [starting, ws, project]);

  const handleStart = () => {
    if (!project.trim()) { setError(t('new_session.project_required')); return; }
    if (!dir.trim()) { setError(t('new_session.dir_required')); return; }
    if (!ws) { setError(t('new_session.not_connected')); return; }
    if (!ws.connected) { setError(t('new_session.daemon_offline')); return; }

    setError('');
    setStarting(true);
    if (shellBin) void saveUserPref(DEFAULT_SHELL_KEY, shellBin).catch(() => {});

    if (agentType === 'openclaw') {
      const extra =
        ocMode === 'bind'
          ? { ocMode: 'bind', ocSessionId: ocSelectedSession }
          : { ocMode: 'new', ocSessionKey: ocSessionKey.trim(), ocDescription: ocDescription.trim() };
      ws.sendSessionCommand('start', { project: project.trim(), dir: dir.trim(), agentType, ...extra });
    } else {
      ws.sendSessionCommand('start', { project: project.trim(), dir: dir.trim(), agentType });
    }
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !starting) onClose();
    if (e.key === 'Enter' && !starting) handleStart();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
      onClick={(e) => { if (e.target === e.currentTarget && !starting) onClose(); }}
      onKeyDown={handleKey}
      role="dialog"
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 24, width: 400 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, color: '#f1f5f9' }}>Start New Session</h2>

        <div class="form-group">
          <label>Project name</label>
          <input
            type="text"
            placeholder="my-project"
            value={project}
            disabled={starting}
            onInput={(e) => { setProject((e.target as HTMLInputElement).value); setError(''); }}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellcheck={false}
            data-lpignore="true"
            data-1p-ignore
          />
        </div>

        <div class="form-group">
          <label>Working directory</label>
          <div class="input-with-browse">
            <input
              type="text"
              placeholder="~/projects/my-project"
              value={dir}
              disabled={starting}
              onInput={(e) => setDir((e.target as HTMLInputElement).value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              data-lpignore="true"
              data-1p-ignore
            />
            {ws && (
              <button class="btn-browse" type="button" disabled={starting} onClick={() => setShowDirBrowser(true)} title="Browse">📁</button>
            )}
          </div>
        </div>

        {showDirBrowser && ws && (
          <FileBrowser
            ws={ws}
            mode="dir-only"
            layout="modal"
            initialPath={dir || '~'}
            onConfirm={(paths) => { setDir(paths[0] ?? ''); setShowDirBrowser(false); }}
            onClose={() => setShowDirBrowser(false)}
          />
        )}

        <div class="form-group">
          <label>Agent type</label>
          <select
            value={agentType}
            disabled={starting}
            onChange={(e) => setAgentType((e.target as HTMLSelectElement).value as AgentType)}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="opencode">OpenCode</option>
            <option value="gemini">Gemini CLI</option>
            <option value="openclaw">{t('session.agentType.openclaw')}{openClawAvailable ? '' : ` (${t('session.openclaw_not_connected')})`}</option>
          </select>
        </div>

        {/* Session description / persona (all agent types) */}
        <div class="form-group">
          <label>{t('session.description')}</label>
          <textarea
            placeholder={t('session.descriptionPlaceholder')}
            value={ocDescription}
            rows={2}
            onInput={(e) => setOcDescription((e.target as HTMLTextAreaElement).value)}
            disabled={starting}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit', resize: 'vertical', fontSize: 13 }}
          />
        </div>

        {/* OpenClaw not connected hint */}
        {agentType === 'openclaw' && !openClawAvailable && (
          <div style={{ padding: '12px 16px', background: '#1c1917', border: '1px solid #f59e0b44', borderRadius: 6, color: '#fbbf24', fontSize: 13, marginBottom: 8 }}>
            {t('session.openclaw_connect_hint')}
            <code style={{ display: 'block', marginTop: 6, color: '#e2e8f0', background: '#0f172a', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}>
              imcodes connect openclaw
            </code>
          </div>
        )}

        {/* OpenClaw-specific options */}
        {agentType === 'openclaw' && openClawAvailable && (
          <>
            <div class="form-group">
              <label>{t('session.sessionMode')}</label>
              <select
                value={ocMode}
                disabled={starting}
                onChange={(e) => setOcMode((e.target as HTMLSelectElement).value as OpenClawMode)}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
              >
                <option value="new">{t('session.newSession')}</option>
                <option value="bind">{t('session.bindExisting')}</option>
              </select>
            </div>

            {ocMode === 'bind' ? (
              <div class="form-group">
                <label>{t('session.selectSession')}</label>
                {ocLoadingSessions ? (
                  <div style={{ fontSize: 13, color: '#64748b', padding: '8px 0' }}>{t('session.loadingSessions')}</div>
                ) : ocRemoteSessions.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#64748b', padding: '8px 0' }}>{t('session.noSessions')}</div>
                ) : (
                  <select
                    value={ocSelectedSession}
                    disabled={starting}
                    onChange={(e) => setOcSelectedSession((e.target as HTMLSelectElement).value)}
                    style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
                  >
                    <option value="">{t('session.selectSession')}</option>
                    {ocRemoteSessions.map((s) => (
                      <option key={s.id} value={s.id}>{s.label || s.id}</option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <div class="form-group">
                <label>{t('session.sessionKey')}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={ocSessionKey}
                    disabled={starting}
                    onInput={(e) => setOcSessionKey((e.target as HTMLInputElement).value)}
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={starting}
                    onClick={() => setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`)}
                    style={{ whiteSpace: 'nowrap', fontSize: 12 }}
                  >
                    {t('session.autoGenerate')}
                  </button>
                </div>
              </div>
            )}

            <div class="form-group">
              <label>{t('session.description')}</label>
              <textarea
                placeholder={t('session.descriptionPlaceholder')}
                value={ocDescription}
                disabled={starting}
                onInput={(e) => setOcDescription((e.target as HTMLTextAreaElement).value)}
                rows={3}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>
          </>
        )}

        <div class="form-group">
          <label>Default shell (for terminal sub-session)</label>
          {shells.length > 0 ? (
            <select
              value={shellBin}
              disabled={starting}
              onChange={(e) => setShellBin((e.target as HTMLSelectElement).value)}
              style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
            >
              {shells.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <input
              type="text"
              placeholder="/bin/bash"
              value={shellBin}
              disabled={starting}
              onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
              autoComplete="off"
            />
          )}
        </div>

        {error && (
          <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 12px', background: '#450a0a', padding: '8px 12px', borderRadius: 4, border: '1px solid #7f1d1d' }}>
            {error}
          </p>
        )}

        {starting && (
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 12px' }}>
            {t('new_session.starting')}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button class="btn btn-secondary" onClick={onClose} disabled={starting}>{t('common.cancel')}</button>
          <button class="btn btn-primary" onClick={handleStart} disabled={starting || (agentType === 'openclaw' && !openClawAvailable)}>
            {starting ? t('new_session.starting') : t('new_session.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
