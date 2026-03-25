/**
 * StartSubSessionDialog — choose type (cc/codex/opencode/shell/openclaw) and launch a sub-session.
 */
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import { FileBrowser } from './FileBrowser.js';
import { getUserPref, saveUserPref } from '../api.js';
import { useProviderStatus } from '../hooks/useProviderStatus.js';

interface Props {
  ws: WsClient | null;
  defaultCwd?: string;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string, extra?: Record<string, unknown>) => void;
  onClose: () => void;
}

const BASE_AGENT_TYPES = [
  { id: 'claude-code', label: 'Claude Code', icon: '⚡' },
  { id: 'codex', label: 'Codex', icon: '📦' },
  { id: 'opencode', label: 'OpenCode', icon: '🔆' },
  { id: 'gemini', label: 'Gemini CLI', icon: '♊' },
  { id: 'shell', label: 'Shell', icon: '🐚' },
  { id: 'script', label: 'Script', icon: '🔄' },
];

const OPENCLAW_AGENT = { id: 'openclaw', label: 'OpenClaw', icon: '🦞' };

type OpenClawMode = 'new' | 'bind';

interface RemoteSession {
  id: string;
  label: string;
}

export function StartSubSessionDialog({ ws, defaultCwd, onStart, onClose }: Props) {
  const { t } = useTranslation();
  const [type, setType] = useState('claude-code');
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [label, setLabel] = useState('');
  const [scriptCmd, setScriptCmd] = useState('');
  const [scriptInterval, setScriptInterval] = useState('5');
  const [detectingShells, setDetectingShells] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [ocDescription, setOcDescription] = useState('');
  const [ocRemoteSessions, setOcRemoteSessions] = useState<RemoteSession[]>([]);
  const [ocLoadingSessions, setOcLoadingSessions] = useState(false);
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  const { isProviderConnected } = useProviderStatus(ws);
  const openClawAvailable = isProviderConnected('openclaw');

  const agentTypes = openClawAvailable
    ? [...BASE_AGENT_TYPES, OPENCLAW_AGENT]
    : BASE_AGENT_TYPES;

  // Load saved shell preference from server
  useEffect(() => {
    void getUserPref('default_shell').then((saved) => {
      if (typeof saved === 'string' && saved) setShellBin(saved);
    }).catch(() => {});
  }, []);

  // Request shell detection from daemon
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        setShells(msg.shells);
        setDetectingShells(false);
        setShellBin((prev) => (msg.shells.includes(prev) ? prev : (msg.shells[0] ?? prev)));
      }
      const raw = msg as unknown as Record<string, unknown>;
      if (raw['type'] === 'openclaw.sessions_response') {
        const sessions = raw['sessions'] as RemoteSession[] | undefined;
        setOcRemoteSessions(sessions ?? []);
        setOcLoadingSessions(false);
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Fetch remote sessions when bind mode is selected
  useEffect(() => {
    if (type !== 'openclaw' || ocMode !== 'bind' || !ws) return;
    setOcLoadingSessions(true);
    setOcRemoteSessions([]);
    ws.send({ type: 'openclaw.list_sessions' });
  }, [type, ocMode, ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (type === 'openclaw' && ocMode === 'new' && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [type, ocMode, ocSessionKey]);

  // Fall back if openclaw disappears
  useEffect(() => {
    if (type === 'openclaw' && !openClawAvailable) {
      setType('claude-code');
    }
  }, [openClawAvailable, type]);

  const handleStart = () => {
    if (type === 'script') {
      if (!scriptCmd.trim()) return;
      const interval = Math.max(1, parseInt(scriptInterval, 10) || 5);
      const escaped = scriptCmd.trim().replace(/'/g, "'\\''");
      const wrapper = `bash -c 'while true; do clear; ${escaped}; sleep ${interval}; done'`;
      onStart('script', wrapper, cwd || undefined, label || scriptCmd.trim().slice(0, 30));
      return;
    }
    if (type === 'openclaw') {
      const extra =
        ocMode === 'bind'
          ? { ocMode: 'bind', ocSessionId: ocSelectedSession }
          : { ocMode: 'new', ocSessionKey: ocSessionKey.trim(), ocDescription: ocDescription.trim() };
      onStart('openclaw', undefined, cwd || undefined, label || undefined, extra);
      return;
    }
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      void saveUserPref('default_shell', selectedShell).catch(() => {});
    }
    onStart(type, selectedShell, cwd || undefined, label || undefined);
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 380 }}>
        <div class="dialog-header">
          <span>New Sub-Session</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selection */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {agentTypes.map((at) => (
                <button
                  key={at.id}
                  class={`subsession-type-btn${type === at.id ? ' active' : ''}`}
                  onClick={() => setType(at.id)}
                >
                  <span>{at.icon}</span> {at.id === 'openclaw' ? t('session.agentType.openclaw') : at.label}
                </button>
              ))}
            </div>
          </div>

          {/* Script command (only for script type) */}
          {type === 'script' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Command</div>
              <input
                class="input"
                placeholder="e.g. df -h, kubectl get pods, htop -t"
                value={scriptCmd}
                onInput={(e) => setScriptCmd((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
                autoFocus
              />
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12, marginBottom: 8 }}>Interval (seconds)</div>
              <input
                class="input"
                type="number"
                min="1"
                value={scriptInterval}
                onInput={(e) => setScriptInterval((e.target as HTMLInputElement).value)}
                style={{ width: 80 }}
              />
            </div>
          )}

          {/* Shell binary picker (only for shell type) */}
          {type === 'shell' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Shell</div>
              {detectingShells ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>Detecting shells...</div>
              ) : shells.length > 0 ? (
                <select
                  class="input"
                  value={shellBin}
                  onChange={(e) => setShellBin((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {shells.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <input
                  class="input"
                  placeholder="/bin/bash"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
          )}

          {/* OpenClaw-specific options */}
          {type === 'openclaw' && (
            <>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionMode')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button
                    class={`subsession-type-btn${ocMode === 'new' ? ' active' : ''}`}
                    onClick={() => setOcMode('new')}
                  >
                    {t('session.newSession')}
                  </button>
                  <button
                    class={`subsession-type-btn${ocMode === 'bind' ? ' active' : ''}`}
                    onClick={() => setOcMode('bind')}
                  >
                    {t('session.bindExisting')}
                  </button>
                </div>
              </div>

              {ocMode === 'bind' ? (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.selectSession')}</div>
                  {ocLoadingSessions ? (
                    <div style={{ fontSize: 12, color: '#64748b' }}>{t('session.loadingSessions')}</div>
                  ) : ocRemoteSessions.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#64748b' }}>{t('session.noSessions')}</div>
                  ) : (
                    <select
                      class="input"
                      value={ocSelectedSession}
                      onChange={(e) => setOcSelectedSession((e.target as HTMLSelectElement).value)}
                      style={{ width: '100%' }}
                    >
                      <option value="">{t('session.selectSession')}</option>
                      {ocRemoteSessions.map((s) => (
                        <option key={s.id} value={s.id}>{s.label || s.id}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionKey')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      class="input"
                      type="text"
                      value={ocSessionKey}
                      onInput={(e) => setOcSessionKey((e.target as HTMLInputElement).value)}
                      autoComplete="off"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`)}
                      style={{ whiteSpace: 'nowrap', fontSize: 12 }}
                    >
                      {t('session.autoGenerate')}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.description')}</div>
                <textarea
                  class="input"
                  placeholder={t('session.descriptionPlaceholder')}
                  value={ocDescription}
                  onInput={(e) => setOcDescription((e.target as HTMLTextAreaElement).value)}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
            </>
          )}

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Working directory (optional)</div>
            <div class="input-with-browse">
              <input
                class="input"
                placeholder="~/projects/myapp"
                value={cwd}
                onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              />
              {ws && (
                <button class="btn-browse" type="button" onClick={() => setShowDirBrowser(true)} title="Browse">📁</button>
              )}
            </div>
          </div>

          {showDirBrowser && ws && (
            <FileBrowser
              ws={ws}
              mode="dir-only"
              layout="modal"
              initialPath={cwd || defaultCwd || '~'}
              onConfirm={(paths) => { setCwd(paths[0] ?? ''); setShowDirBrowser(false); }}
              onClose={() => setShowDirBrowser(false)}
            />
          )}

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Label (optional)</div>
            <input
              class="input"
              placeholder="e.g. backend"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart}>Launch</button>
        </div>
      </div>
    </div>
  );
}
