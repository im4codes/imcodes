import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import { FileBrowser } from './FileBrowser.js';
import { getUserPref, saveUserPref } from '../api.js';

const DEFAULT_SHELL_KEY = 'default_shell';

interface Props {
  ws: WsClient | null;
  onClose: () => void;
  onSessionStarted: (sessionName: string) => void;
  isProviderConnected: (id: string) => boolean;
}

type AgentType = 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'openclaw';
type OpenClawMode = 'new' | 'bind';

interface RemoteSession {
  id: string;
  label: string;
}

export function NewSessionDialog({ ws, onClose, onSessionStarted, isProviderConnected: _isProviderConnected }: Props) {
  const { t } = useTranslation();
  const [project, setProject] = useState('');
  const [dir, setDir] = useState('~/');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('');

  // CC env presets
  const [ccPresets, setCcPresets] = useState<Array<{ name: string; env: Record<string, string>; contextWindow?: number; initMessage?: string }>>([]);
  const [ccPreset, setCcPreset] = useState<string>('');
  const [ccInitPrompt, setCcInitPrompt] = useState<string>('');
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  // New preset form
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetEnv, setNewPresetEnv] = useState('');
  const [newPresetCtx, setNewPresetCtx] = useState('');
  const [newPresetInit, setNewPresetInit] = useState('');

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [ocDescription, setOcDescription] = useState('');
  const [ocRemoteSessions, setOcRemoteSessions] = useState<RemoteSession[]>([]);
  const [ocLoadingSessions, setOcLoadingSessions] = useState(false);
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  // Load saved shell preference — will be validated against daemon's detected list later
  const [savedShellPref, setSavedShellPref] = useState<string | null>(null);
  useEffect(() => {
    void getUserPref(DEFAULT_SHELL_KEY).then((saved) => {
      if (typeof saved === 'string' && saved) setSavedShellPref(saved);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        const list = msg.shells as string[];
        setShells(list);
        // Use saved preference only if daemon actually has that shell; otherwise pick first detected
        const preferred = savedShellPref;
        if (preferred && list.includes(preferred)) {
          setShellBin(preferred);
        } else {
          setShellBin(list[0] ?? '');
        }
      }
      // Listen for CC presets response
      if (msg.type === 'cc.presets.list_response') {
        setCcPresets((msg as any).presets ?? []);
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
    try { ws.send({ type: 'cc.presets.list' }); } catch { /* ws may not support send in test */ }
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
      ws.sendSessionCommand('start', {
        project: project.trim(), dir: dir.trim(), agentType,
        ...(ccPreset ? { ccPreset } : {}),
        ...(ccInitPrompt.trim() ? { ccInitPrompt: ccInitPrompt.trim() } : {}),
      });
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
            <option value="openclaw">{t('session.agentType.openclaw')}</option>
          </select>
        </div>

        {/* CC env preset selector + editor */}
        {agentType === 'claude-code' && (
          <>
            <div class="form-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>API Provider</span>
                <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 12, padding: 0 }} onClick={() => setShowPresetEditor(!showPresetEditor)}>
                  {showPresetEditor ? '▾ Close' : '+ Add / Edit'}
                </button>
              </label>
              {ccPresets.length > 0 && (
                <select
                  value={ccPreset}
                  disabled={starting}
                  onChange={(e) => setCcPreset((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit' }}
                >
                  <option value="">Default (Anthropic)</option>
                  {ccPresets.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}{p.env['ANTHROPIC_MODEL'] ? ` (${p.env['ANTHROPIC_MODEL']})` : ''}</option>
                  ))}
                </select>
              )}
              {ccPresets.length === 0 && !showPresetEditor && (
                <div style={{ fontSize: 12, color: '#475569', padding: '4px 0' }}>Default (Anthropic) — click "+ Add / Edit" to configure</div>
              )}
            </div>

            {/* Inline preset editor */}
            {showPresetEditor && (
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 12 }}>
                <div style={{ marginBottom: 4, fontWeight: 600, color: '#94a3b8' }}>Add New Preset</div>
                <div style={{ fontSize: 10, color: '#475569', marginBottom: 8 }}>Stored locally on daemon machine (~/.imcodes/cc-presets.json). Not synced to server.</div>
                <input
                  type="text" placeholder="Name (e.g. MiniMax)" value={newPresetName}
                  onInput={(e) => setNewPresetName((e.target as HTMLInputElement).value)}
                  style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '6px 8px', borderRadius: 4, marginBottom: 6, fontSize: 12, boxSizing: 'border-box' }}
                />
                <textarea
                  placeholder={'ENV vars (JSON):\n{"ANTHROPIC_BASE_URL":"...","ANTHROPIC_AUTH_TOKEN":"...","ANTHROPIC_MODEL":"..."}'}
                  value={newPresetEnv} rows={3}
                  onInput={(e) => setNewPresetEnv((e.target as HTMLTextAreaElement).value)}
                  style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '6px 8px', borderRadius: 4, marginBottom: 6, fontSize: 11, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
                />
                <input
                  type="text" placeholder="Context window (e.g. 200000 or 1000000)" value={newPresetCtx}
                  onInput={(e) => setNewPresetCtx((e.target as HTMLInputElement).value)}
                  style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '6px 8px', borderRadius: 4, marginBottom: 6, fontSize: 12, boxSizing: 'border-box' }}
                />
                <textarea
                  placeholder="Init message (optional — default: DuckDuckGo search instruction)" value={newPresetInit} rows={2}
                  onInput={(e) => setNewPresetInit((e.target as HTMLTextAreaElement).value)}
                  style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '6px 8px', borderRadius: 4, marginBottom: 8, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" disabled={!newPresetName.trim() || !newPresetEnv.trim()} style={{ background: '#1d4ed8', border: 'none', color: '#fff', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, opacity: !newPresetName.trim() || !newPresetEnv.trim() ? 0.5 : 1 }}
                    onClick={() => {
                      try {
                        const env = JSON.parse(newPresetEnv);
                        const preset: any = { name: newPresetName.trim(), env };
                        if (newPresetCtx) preset.contextWindow = parseInt(newPresetCtx, 10);
                        if (newPresetInit.trim()) preset.initMessage = newPresetInit.trim();
                        const updated = [...ccPresets.filter(p => p.name !== preset.name), preset];
                        setCcPresets(updated);
                        try { ws?.send({ type: 'cc.presets.save', presets: updated }); } catch {}
                        setNewPresetName(''); setNewPresetEnv(''); setNewPresetCtx(''); setNewPresetInit('');
                        setCcPreset(preset.name);
                      } catch { setError('Invalid JSON in env vars'); }
                    }}
                  >Save</button>
                </div>

                {/* Existing presets — edit/delete */}
                {ccPresets.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #334155', paddingTop: 8 }}>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Saved presets:</div>
                    {ccPresets.map((p) => (
                      <div key={p.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                        <span style={{ color: '#e2e8f0' }}>{p.name} <span style={{ color: '#475569' }}>{p.env['ANTHROPIC_MODEL'] ?? ''}</span></span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11 }}
                            onClick={() => {
                              setNewPresetName(p.name);
                              setNewPresetEnv(JSON.stringify(p.env, null, 2));
                              setNewPresetCtx(p.contextWindow ? String(p.contextWindow) : '');
                              setNewPresetInit(p.initMessage ?? '');
                            }}
                          >Edit</button>
                          <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}
                            onClick={() => {
                              const updated = ccPresets.filter(x => x.name !== p.name);
                              setCcPresets(updated);
                              try { ws?.send({ type: 'cc.presets.save', presets: updated }); } catch {}
                              if (ccPreset === p.name) setCcPreset('');
                            }}
                          >Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Extra init prompt for this launch */}
            {ccPreset && (
              <div class="form-group">
                <label>Extra init prompt (optional)</label>
                <textarea
                  placeholder="Additional instruction injected after session starts..."
                  value={ccInitPrompt} rows={2}
                  onInput={(e) => setCcInitPrompt((e.target as HTMLTextAreaElement).value)}
                  disabled={starting}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '8px 12px', borderRadius: 4, fontFamily: 'inherit', resize: 'vertical', fontSize: 13 }}
                />
              </div>
            )}
          </>
        )}

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

        {/* OpenClaw-specific options */}
        {agentType === 'openclaw' && (
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
          <button class="btn btn-primary" onClick={handleStart} disabled={starting}>
            {starting ? t('new_session.starting') : t('new_session.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
