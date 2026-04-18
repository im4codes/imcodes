/**
 * StartSubSessionDialog — choose type (cc/cc-sdk/codex/codex-sdk/opencode/gemini/qwen/shell/openclaw) and launch a sub-session.
 */
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import type { RemoteSession } from '../hooks/useProviderStatus.js';
import { FileBrowser } from './file-browser-lazy.js';
import { getUserPref, saveUserPref } from '../api.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, COPILOT_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, QWEN_EFFORT_LEVELS, type TransportEffortLevel } from '@shared/effort-levels.js';
import { getSessionAgentGroups, getSessionAgentLabel, SESSION_AGENT_GROUP_LABEL_KEYS } from './session-agent-options.js';

interface Props {
  ws: WsClient | null;
  defaultCwd?: string;
  isProviderConnected: (id: string) => boolean;
  getRemoteSessions: (providerId: string) => RemoteSession[];
  refreshSessions: (providerId: string) => void;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string, extra?: Record<string, unknown>) => void;
  onClose: () => void;
}

type OpenClawMode = 'new' | 'bind';

export function StartSubSessionDialog({ ws, defaultCwd, isProviderConnected: _isProviderConnected, getRemoteSessions, refreshSessions, onStart, onClose }: Props) {
  const { t } = useTranslation();
  const [type, setType] = useState('claude-code-sdk');
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [label, setLabel] = useState('');
  const [scriptCmd, setScriptCmd] = useState('');
  const [scriptInterval, setScriptInterval] = useState('5');
  const [detectingShells, setDetectingShells] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [thinking, setThinking] = useState<TransportEffortLevel>('high');

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [description, setDescription] = useState('');
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  // CC env presets
  const [ccPresets, setCcPresets] = useState<Array<{ name: string; env: Record<string, string>; contextWindow?: number; initMessage?: string }>>([]);
  const [ccPreset, setCcPreset] = useState<string>('');
  const [ccInitPrompt, setCcInitPrompt] = useState<string>('');
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetBaseUrl, setNewPresetBaseUrl] = useState('');
  const [newPresetToken, setNewPresetToken] = useState('');
  const [newPresetModel, setNewPresetModel] = useState('');
  const [newPresetCtx, setNewPresetCtx] = useState('1000000');
  const [newPresetCustomEnv, setNewPresetCustomEnv] = useState<Array<{ key: string; value: string }>>([]);
  const DEFAULT_INIT_MSG = 'For web searches, use: curl -s "https://html.duckduckgo.com/html/?q=QUERY" | head -200. Replace QUERY with URL-encoded search terms.';
  const [newPresetInit, setNewPresetInit] = useState(DEFAULT_INIT_MSG);
  const [presetError, setPresetError] = useState('');
  const fmtCtx = (v: string) => { const n = parseInt(v, 10); if (!n) return ''; if (n >= 1000000) return `${(n/1000000).toFixed(n%1000000===0?0:1)}M`; if (n >= 1000) return `${(n/1000).toFixed(0)}K`; return String(n); };

  // Remote sessions come from the provider status hook (pushed on connect, cached in DB)
  const ocRemoteSessions = getRemoteSessions('openclaw');

  const agentGroups = getSessionAgentGroups('sub-session');

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
      if (msg.type === 'cc.presets.list_response') {
        setCcPresets((msg as any).presets ?? []);
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    try { ws.send({ type: 'cc.presets.list' }); } catch {}
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (type === 'openclaw' && ocMode === 'new' && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [type, ocMode, ocSessionKey]);

  useEffect(() => {
    setThinking('high');
  }, [type]);

  const handleStart = () => {
    const desc = description.trim() || undefined;
    if (type === 'script') {
      if (!scriptCmd.trim()) return;
      const interval = Math.max(1, parseInt(scriptInterval, 10) || 5);
      const escaped = scriptCmd.trim().replace(/'/g, "'\\''");
      const wrapper = `bash -c 'while true; do clear; ${escaped}; sleep ${interval}; done'`;
      onStart('script', wrapper, cwd || undefined, label || scriptCmd.trim().slice(0, 30), desc ? { description: desc } : undefined);
      return;
    }
    if (type === 'openclaw') {
      const extra =
        ocMode === 'bind'
          ? { ocMode: 'bind', ocSessionId: ocSelectedSession, description: desc, thinking }
          : { ocMode: 'new', ocSessionKey: ocSessionKey.trim(), description: desc, thinking };
      onStart('openclaw', undefined, cwd || undefined, label || undefined, extra);
      return;
    }
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      void saveUserPref('default_shell', selectedShell).catch(() => {});
    }
    const extra: Record<string, unknown> = {};
    if (desc) extra.description = desc;
    if (ccPreset && (type === 'claude-code' || type === 'qwen')) extra.ccPreset = ccPreset;
    if (ccInitPrompt.trim() && type === 'claude-code') extra.ccInitPrompt = ccInitPrompt.trim();
    if (type === 'claude-code-sdk' || type === 'codex-sdk' || type === 'copilot-sdk' || type === 'qwen') extra.thinking = thinking;
    onStart(type, selectedShell, cwd || undefined, label || undefined, Object.keys(extra).length > 0 ? extra : undefined);
  };

  const thinkingLevels = type === 'claude-code-sdk'
    ? CLAUDE_SDK_EFFORT_LEVELS
    : type === 'codex-sdk'
      ? CODEX_SDK_EFFORT_LEVELS
      : type === 'copilot-sdk'
        ? COPILOT_SDK_EFFORT_LEVELS
        : type === 'qwen'
          ? QWEN_EFFORT_LEVELS
          : type === 'openclaw'
            ? OPENCLAW_THINKING_LEVELS
            : [];
  const supportsCcPreset = type === 'claude-code' || type === 'qwen';

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
            <div class="subsession-type-groups">
              {agentGroups.map((group) => (
                <div key={group.id} class="subsession-type-group">
                  <div class="subsession-type-group-title">{t(SESSION_AGENT_GROUP_LABEL_KEYS[group.id])}</div>
                  <div class="subsession-type-grid">
                    {group.items.map((choice) => (
                      <button
                        key={choice.id}
                        class={`subsession-type-btn${type === choice.id ? ' active' : ''}`}
                        onClick={() => setType(choice.id)}
                      >
                        <span>{choice.icon}</span> {getSessionAgentLabel(t, choice)}
                      </button>
                    ))}
                  </div>
                </div>
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
                  onInput={(e) => setShellBin((e.target as HTMLSelectElement).value)}
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

          {/* OpenClaw-specific options — always show, even if provider not yet connected */}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('session.selectSession')}</div>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => refreshSessions('openclaw')}
                      style={{ fontSize: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title={t('common.refresh')}
                    >
                      {t('common.refresh')}
                    </button>
                  </div>
                  {ocRemoteSessions.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#64748b' }}>{t('session.noSessions')}</div>
                  ) : (
                    <select
                      class="input"
                      value={ocSelectedSession}
                      onInput={(e) => setOcSelectedSession((e.target as HTMLSelectElement).value)}
                      style={{ width: '100%' }}
                    >
                      <option value="">{t('session.selectSession')}</option>
                      {ocRemoteSessions.map((s) => (
                        <option key={s.key} value={s.key}>{s.displayName || s.key}</option>
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

            </>
          )}

          {/* CC env preset selector + editor */}
          {supportsCcPreset && (
            <>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>API Provider</span>
                  <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11, padding: 0 }} onClick={() => setShowPresetEditor(!showPresetEditor)}>
                    {showPresetEditor ? '▾ Close' : '+ Add / Edit'}
                  </button>
                </div>
                {ccPresets.length > 0 ? (
                  <select class="input" value={ccPreset} onInput={(e) => setCcPreset((e.target as HTMLSelectElement).value)} style={{ width: '100%' }}>
                    <option value="">Default (Anthropic)</option>
                    {ccPresets.map((p) => <option key={p.name} value={p.name}>{p.name}{p.env['ANTHROPIC_MODEL'] ? ` (${p.env['ANTHROPIC_MODEL']})` : ''}</option>)}
                  </select>
                ) : !showPresetEditor && (
                  <div style={{ fontSize: 11, color: '#475569' }}>Default (Anthropic)</div>
                )}
              </div>

              {showPresetEditor && (
                <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 10, fontSize: 11 }}>
                  <div style={{ color: '#64748b', marginBottom: 4, fontSize: 10 }}>Stored locally (~/.imcodes/cc-presets.json)</div>
                  {presetError && <div style={{ color: '#ef4444', fontSize: 11, marginBottom: 4 }}>{presetError}</div>}
                  {[
                    { label: 'Preset Name', envKey: '', ph: 'e.g. MiniMax', val: newPresetName, set: setNewPresetName },
                    { label: 'API Base URL', envKey: 'ANTHROPIC_BASE_URL', ph: 'https://api.minimax.io/anthropic', val: newPresetBaseUrl, set: setNewPresetBaseUrl },
                    { label: 'API Key', envKey: 'ANTHROPIC_AUTH_TOKEN', ph: 'your-api-key', val: newPresetToken, set: setNewPresetToken, type: 'password' as const },
                    { label: 'Model', envKey: 'ANTHROPIC_MODEL', ph: 'e.g. MiniMax-M2.7', val: newPresetModel, set: setNewPresetModel },
                  ].map(({ label, envKey, ph, val, set, type }) => (
                    <div key={label} style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>{label}{envKey && <span style={{ color: '#334155', marginLeft: 4 }}>{envKey}</span>}</div>
                      <input class="input" type={type ?? 'text'} placeholder={ph} value={val} onInput={(e) => set((e.target as HTMLInputElement).value)} style={{ width: '100%', fontSize: 11 }} />
                    </div>
                  ))}
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>Context Window{newPresetCtx && <span style={{ color: '#3b82f6', marginLeft: 4 }}>{fmtCtx(newPresetCtx)}</span>}</div>
                    <input class="input" type="text" placeholder="1000000" value={newPresetCtx} onInput={(e) => setNewPresetCtx((e.target as HTMLInputElement).value)} style={{ width: '100%', fontSize: 11 }} />
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 1 }}>
                      <span style={{ fontSize: 9, color: '#64748b' }}>Custom ENV Vars</span>
                      <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 9, padding: 0 }} onClick={() => setNewPresetCustomEnv([...newPresetCustomEnv, { key: '', value: '' }])}>+ Add</button>
                    </div>
                    {newPresetCustomEnv.map((item, i) => (
                      <div key={i} style={{ display: 'flex', gap: 3, marginBottom: 2 }}>
                        <input class="input" placeholder="ENV_KEY" value={item.key} onInput={(e) => { const u = [...newPresetCustomEnv]; u[i] = { ...u[i], key: (e.target as HTMLInputElement).value }; setNewPresetCustomEnv(u); }} style={{ flex: 1, fontSize: 10, fontFamily: 'monospace' }} />
                        <input class="input" placeholder="value" value={item.value} onInput={(e) => { const u = [...newPresetCustomEnv]; u[i] = { ...u[i], value: (e.target as HTMLInputElement).value }; setNewPresetCustomEnv(u); }} style={{ flex: 2, fontSize: 10 }} />
                        <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11, padding: '0 3px' }} onClick={() => setNewPresetCustomEnv(newPresetCustomEnv.filter((_, j) => j !== i))}>×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>Init Message</div>
                    <textarea class="input" value={newPresetInit} rows={2} onInput={(e) => setNewPresetInit((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', fontSize: 10, resize: 'vertical' }} />
                  </div>
                  <button type="button" class="btn btn-primary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={!newPresetName.trim() || !newPresetBaseUrl.trim()}
                    onClick={() => {
                      const env: Record<string, string> = { ANTHROPIC_BASE_URL: newPresetBaseUrl.trim(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' };
                      if (newPresetToken.trim()) env['ANTHROPIC_AUTH_TOKEN'] = newPresetToken.trim();
                      if (newPresetModel.trim()) env['ANTHROPIC_MODEL'] = newPresetModel.trim();
                      for (const { key, value } of newPresetCustomEnv) { if (key.trim()) env[key.trim()] = value; }
                      const preset: any = { name: newPresetName.trim(), env };
                      if (newPresetCtx) preset.contextWindow = parseInt(newPresetCtx, 10);
                      if (newPresetInit.trim()) preset.initMessage = newPresetInit.trim();
                      const updated = [...ccPresets.filter(p => p.name !== preset.name), preset];
                      setCcPresets(updated);
                      try { ws?.send({ type: 'cc.presets.save', presets: updated }); } catch {}
                      setNewPresetName(''); setNewPresetBaseUrl(''); setNewPresetToken(''); setNewPresetModel(''); setNewPresetCtx('1000000'); setNewPresetInit(DEFAULT_INIT_MSG); setNewPresetCustomEnv([]);
                      setCcPreset(preset.name); setPresetError('');
                    }}
                  >Save</button>
                  {ccPresets.length > 0 && (
                    <div style={{ marginTop: 8, borderTop: '1px solid #334155', paddingTop: 6 }}>
                      {ccPresets.map((p) => (
                        <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
                          <span style={{ color: '#e2e8f0' }}>{p.name} <span style={{ color: '#475569' }}>{p.env['ANTHROPIC_MODEL'] ?? ''}</span></span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 10 }} onClick={() => {
                              setNewPresetName(p.name); setNewPresetBaseUrl(p.env['ANTHROPIC_BASE_URL'] ?? ''); setNewPresetToken(p.env['ANTHROPIC_AUTH_TOKEN'] ?? ''); setNewPresetModel(p.env['ANTHROPIC_MODEL'] ?? '');
                              setNewPresetCtx(p.contextWindow ? String(p.contextWindow) : '1000000'); setNewPresetInit(p.initMessage ?? DEFAULT_INIT_MSG);
                              const knownKeys = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_ATTRIBUTION_HEADER']);
                              setNewPresetCustomEnv(Object.entries(p.env).filter(([k]) => !knownKeys.has(k)).map(([key, value]) => ({ key, value })));
                            }}>Edit</button>
                            <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 10 }} onClick={() => { const u = ccPresets.filter(x => x.name !== p.name); setCcPresets(u); try { ws?.send({ type: 'cc.presets.save', presets: u }); } catch {} if (ccPreset === p.name) setCcPreset(''); }}>Del</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {ccPreset && (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Extra init prompt</div>
                  <textarea class="input" placeholder="Additional instruction..." value={ccInitPrompt} rows={2} onInput={(e) => setCcInitPrompt((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', resize: 'vertical' }} />
                </div>
              )}
            </>
          )}

          {/* Working directory */}
          {thinkingLevels.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.thinking')}</div>
              <select
                class="input"
                value={thinking}
                onInput={(e) => setThinking((e.target as HTMLSelectElement).value as TransportEffortLevel)}
                style={{ width: '100%' }}
              >
                {thinkingLevels.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </div>
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

          {/* Description / persona */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.description')}</div>
            <textarea
              class="input"
              placeholder={t('session.descriptionPlaceholder')}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
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
