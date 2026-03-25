/**
 * P2pConfigPanel — modal settings panel for P2P config mode.
 * Lets the user configure per-session participation and modes, plus round count.
 */
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getUserPref, saveUserPref } from '../api.js';
import type { P2pSavedConfig, P2pSessionConfig } from '@shared/p2p-modes.js';

interface SessionRow {
  name: string;
  agentType: string;
  state: string;
}

interface SubSessionRow {
  sessionName: string;
  type: string;
  label?: string | null;
  parentSession?: string | null;
  state: string;
}

interface Props {
  sessions: SessionRow[];
  subSessions: SubSessionRow[];
  /** Active main session name — only show sessions scoped to this one by default */
  activeSession?: string | null;
  onClose: () => void;
  onSave: (config: P2pSavedConfig) => void;
}

const EXCLUDED_TYPES = new Set(['shell', 'script']);
const SESSION_MODES = ['audit', 'review', 'brainstorm', 'discuss', 'skip'] as const;
const ROUND_OPTIONS = [1, 2, 3, 5] as const;

const overlayStyle: Record<string, string | number> = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: 16,
};

const panelStyle: Record<string, string | number> = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 10,
  width: '100%',
  maxWidth: 520,
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  overflow: 'hidden',
};

const headerStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 20px 12px',
  borderBottom: '1px solid #334155',
};

const titleStyle: Record<string, string | number> = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: '#f1f5f9',
};

const closeBtnStyle: Record<string, string | number> = {
  background: 'none',
  border: 'none',
  color: '#64748b',
  fontSize: 20,
  cursor: 'pointer',
  lineHeight: 1,
  padding: 0,
};

const bodyStyle: Record<string, string | number> = {
  flex: 1,
  overflowY: 'auto',
  padding: '12px 20px',
};

const rowStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 0',
  borderBottom: '1px solid #1e3a5f20',
};

const checkboxStyle: Record<string, string | number> = {
  accentColor: '#3b82f6',
  width: 15,
  height: 15,
  cursor: 'pointer',
  flexShrink: 0,
};

const nameStyle: Record<string, string | number> = {
  flex: 1,
  fontSize: 13,
  color: '#e2e8f0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const badgeStyle: Record<string, string | number> = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 4,
  background: '#334155',
  color: '#94a3b8',
  flexShrink: 0,
};

const selectStyle: Record<string, string | number> = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 5,
  color: '#e2e8f0',
  fontSize: 12,
  padding: '3px 6px',
  cursor: 'pointer',
  flexShrink: 0,
};

const sectionLabelStyle: Record<string, string | number> = {
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginTop: 14,
  marginBottom: 6,
};

const roundsBtnStyle = (active: boolean): Record<string, string | number> => ({
  padding: '4px 12px',
  borderRadius: 6,
  border: `1px solid ${active ? '#3b82f6' : '#475569'}`,
  background: active ? '#1d4ed840' : '#1e293b',
  color: active ? '#93c5fd' : '#e2e8f0',
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
});

const footerStyle: Record<string, string | number> = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 20px',
  borderTop: '1px solid #334155',
};

const btnSecondaryStyle: Record<string, string | number> = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: 'none',
  color: '#94a3b8',
  fontSize: 13,
  cursor: 'pointer',
};

const btnPrimaryStyle: Record<string, string | number> = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid #3b82f6',
  background: '#3b82f6',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export function P2pConfigPanel({ sessions, subSessions, activeSession, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [crossSession, setCrossSession] = useState(false);

  // Build combined eligible session list (exclude shell/script)
  const eligible: Array<{ key: string; shortName: string; agentType: string }> = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (EXCLUDED_TYPES.has(s.agentType)) continue;
    // When not cross-session, only show active session itself
    if (!crossSession && activeSession && s.name !== activeSession) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const shortName = s.name.split('_').pop() || s.name;
    eligible.push({ key: s.name, shortName, agentType: s.agentType });
  }

  for (const s of subSessions) {
    if (EXCLUDED_TYPES.has(s.type)) continue;
    // When not cross-session, only show sub-sessions under active main session
    if (!crossSession && activeSession && s.parentSession && s.parentSession !== activeSession) continue;
    if (seen.has(s.sessionName)) continue;
    seen.add(s.sessionName);
    const shortName = s.label || s.sessionName;
    eligible.push({ key: s.sessionName, shortName, agentType: s.type });
  }

  // Local config state: per-session enabled + mode
  const [sessionCfg, setSessionCfg] = useState<P2pSessionConfig>({});
  const [rounds, setRounds] = useState(3);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load saved config on mount
  useEffect(() => {
    setLoading(true);
    void getUserPref('p2p_session_config').then((raw) => {
      if (raw && typeof raw === 'string') {
        try {
          const parsed: P2pSavedConfig = JSON.parse(raw);
          setSessionCfg(parsed.sessions ?? {});
          setRounds(parsed.rounds ?? 3);
          setExtraPrompt(parsed.extraPrompt ?? '');
        } catch { /* start fresh */ }
      }
      setLoading(false);
    });
  }, []);

  const toggleEnabled = (key: string) => {
    setSessionCfg((prev) => {
      const cur = prev[key] ?? { enabled: true, mode: 'audit' };
      return { ...prev, [key]: { ...cur, enabled: !cur.enabled } };
    });
  };

  const setMode = (key: string, mode: string) => {
    setSessionCfg((prev) => {
      const cur = prev[key] ?? { enabled: true, mode: 'audit' };
      return { ...prev, [key]: { ...cur, mode } };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    // Fill in defaults for any session not yet in cfg
    const merged: P2pSessionConfig = { ...sessionCfg };
    for (const e of eligible) {
      if (!merged[e.key]) {
        merged[e.key] = { enabled: true, mode: 'audit' };
      }
    }
    const cfg: P2pSavedConfig = { sessions: merged, rounds, extraPrompt: extraPrompt.trim() || undefined };
    try {
      await saveUserPref('p2p_session_config', JSON.stringify(cfg));
      onSave(cfg);
    } catch { /* ignore — UI still closes */ }
    setSaving(false);
    onClose();
  };

  const getEntry = (key: string) => sessionCfg[key] ?? { enabled: true, mode: 'audit' };

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>{t('p2p.settings_title')}</h2>
          <button style={closeBtnStyle} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#64748b', fontSize: 13 }}>…</div>
          ) : (
            <>
              {/* Cross-session toggle */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#94a3b8', cursor: 'pointer', marginBottom: 4 }}>
                <input
                  type="checkbox"
                  style={checkboxStyle}
                  checked={crossSession}
                  onChange={() => setCrossSession((v) => !v)}
                />
                {t('p2p.cross_session')}
              </label>

              {/* Session rows */}
              <div style={sectionLabelStyle}>{t('p2p.picker.agents')}</div>
              {eligible.length === 0 && (
                <div style={{ color: '#64748b', fontSize: 13, padding: '8px 0' }}>
                  {t('p2p.picker.no_agents_available')}
                </div>
              )}
              {eligible.map((e) => {
                const entry = getEntry(e.key);
                return (
                  <div key={e.key} style={rowStyle}>
                    <input
                      type="checkbox"
                      style={checkboxStyle}
                      checked={entry.enabled}
                      onChange={() => toggleEnabled(e.key)}
                    />
                    <span style={nameStyle}>{e.shortName}</span>
                    <span style={badgeStyle}>{e.agentType}</span>
                    <select
                      style={{ ...selectStyle, opacity: entry.enabled ? 1 : 0.4 }}
                      value={entry.mode}
                      disabled={!entry.enabled}
                      onChange={(ev) => setMode(e.key, (ev.target as HTMLSelectElement).value)}
                    >
                      {SESSION_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m === 'skip' ? t('p2p.settings_skip') : t(`p2p.mode.${m}`, m.charAt(0).toUpperCase() + m.slice(1))}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}

              {/* Rounds */}
              <div style={sectionLabelStyle}>{t('p2p.settings_rounds')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {ROUND_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    style={roundsBtnStyle(rounds === r)}
                    onClick={() => setRounds(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                {t('p2p.settings_rounds_hint')}
              </div>

              {/* Extra prompt */}
              <div style={{ ...sectionLabelStyle, marginTop: 12 }}>{t('p2p.settings_extra_prompt')}</div>
              <textarea
                value={extraPrompt}
                onInput={(e) => setExtraPrompt((e.target as HTMLTextAreaElement).value)}
                placeholder={t('p2p.settings_extra_prompt_hint')}
                rows={2}
                style={{
                  width: '100%',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  color: '#e2e8f0',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  padding: '6px 8px',
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button style={btnSecondaryStyle} onClick={onClose}>{t('p2p.settings_close')}</button>
          <button
            style={{ ...btnPrimaryStyle, opacity: saving ? 0.6 : 1 }}
            onClick={() => { void handleSave(); }}
            disabled={saving || loading}
          >
            {t('p2p.settings_save')}
          </button>
        </div>
      </div>
    </div>
  );
}
