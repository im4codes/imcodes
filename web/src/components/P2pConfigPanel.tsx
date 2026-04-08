/**
 * P2pConfigPanel — modal settings panel for P2P config mode.
 * Lets the user configure per-session participation and modes, plus round count.
 */
import { useState, useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getUserPref, saveUserPref } from '../api.js';
import { P2pComboManager } from './P2pComboManager.js';
import { useP2pCustomCombos } from './p2p-combos.js';
import type { P2pSavedConfig, P2pSessionConfig } from '@shared/p2p-modes.js';
import { BUILT_IN_ADVANCED_PRESETS } from '@shared/p2p-advanced.js';
import type {
  P2pAdvancedPresetKey,
  P2pAdvancedRound,
  P2pContextReducerConfig,
  P2pContextReducerMode,
} from '@shared/p2p-advanced.js';

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
  initialTab?: 'participants' | 'combos';
  onClose: () => void;
  onSave: (config: P2pSavedConfig) => void;
}

const EXCLUDED_TYPES = new Set(['shell', 'script']);
const SESSION_MODES = ['audit', 'review', 'plan', 'brainstorm', 'discuss', 'skip'] as const;
const ROUND_OPTIONS = [1, 2, 3, 5] as const;
type AgentFlavorFilter = 'sdk' | 'cli';

function getAgentFlavor(agentType: string): AgentFlavorFilter {
  if (agentType === 'claude-code' || agentType === 'codex' || agentType === 'gemini' || agentType === 'opencode') return 'cli';
  return 'sdk';
}

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

const tabsStyle: Record<string, string | number> = {
  display: 'flex',
  gap: 8,
  padding: '0 20px 12px',
  borderBottom: '1px solid #334155',
};

const tabStyle = (active: boolean): Record<string, string | number> => ({
  padding: '6px 12px',
  borderRadius: 999,
  border: `1px solid ${active ? '#3b82f6' : '#475569'}`,
  background: active ? '#1d4ed840' : '#0f172a',
  color: active ? '#bfdbfe' : '#94a3b8',
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: 'pointer',
});

const rowStyle: Record<string, string | number> = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr) minmax(110px, auto)',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 6,
  background: '#0f172a',
  border: '1px solid #334155',
  minWidth: 0,
};

const checkboxStyle: Record<string, string | number> = {
  accentColor: '#3b82f6',
  width: 15,
  height: 15,
  cursor: 'pointer',
  flexShrink: 0,
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

const agentGridStyle = (mobile: boolean): Record<string, string | number> => ({
  display: 'grid',
  gridTemplateColumns: mobile ? '1fr' : 'repeat(2, minmax(0, 1fr))',
  gap: 10,
});

const sectionCardStyle: Record<string, string | number> = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 10,
  padding: 14,
};

const fieldLabelStyle: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#cbd5e1',
};

const fieldInputStyle: Record<string, string | number> = {
  width: '100%',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 13,
  padding: '7px 9px',
  outline: 'none',
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

export function P2pConfigPanel({
  sessions,
  subSessions,
  activeSession,
  initialTab = 'participants',
  onClose,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const [agentFlavorFilter, setAgentFlavorFilter] = useState<AgentFlavorFilter>('sdk');
  const [activeTab, setActiveTab] = useState<'participants' | 'combos'>(initialTab);
  const { customCombos, saveCustomCombos } = useP2pCustomCombos();
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Build combined eligible session list (exclude shell/script).
  // If activeSession is a sub-session, resolve its parent for scope filtering.
  const scopeSession = (() => {
    if (!activeSession) return null;
    if (activeSession.startsWith('deck_sub_')) {
      const parentRef = subSessions.find(s => s.sessionName === activeSession)?.parentSession;
      return parentRef ?? activeSession;
    }
    return activeSession;
  })();

  const allEligible: Array<{ key: string; shortName: string; agentType: string; flavor: AgentFlavorFilter }> = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (EXCLUDED_TYPES.has(s.agentType)) continue;
    if (scopeSession && s.name !== scopeSession) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const shortName = s.name.split('_').pop() || s.name;
    allEligible.push({ key: s.name, shortName, agentType: s.agentType, flavor: getAgentFlavor(s.agentType) });
  }

  for (const s of subSessions) {
    if (EXCLUDED_TYPES.has(s.type)) continue;
    if (scopeSession && s.parentSession && s.parentSession !== scopeSession) continue;
    if (seen.has(s.sessionName)) continue;
    seen.add(s.sessionName);
    const shortName = s.label || s.sessionName;
    allEligible.push({ key: s.sessionName, shortName, agentType: s.type, flavor: getAgentFlavor(s.type) });
  }

  const visibleEligible = allEligible.filter((entry) => entry.flavor === agentFlavorFilter);

  // Local config state: per-session enabled + mode
  const [sessionCfg, setSessionCfg] = useState<P2pSessionConfig>({});
  const [rounds, setRounds] = useState(3);
  const [hopTimeoutMinutes, setHopTimeoutMinutes] = useState(8);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [advancedPresetKey, setAdvancedPresetKey] = useState<P2pAdvancedPresetKey | ''>('');
  const [advancedRounds, setAdvancedRounds] = useState<P2pAdvancedRound[] | undefined>(undefined);
  const [advancedRunTimeoutMinutes, setAdvancedRunTimeoutMinutes] = useState(30);
  const [contextReducerMode, setContextReducerMode] = useState<P2pContextReducerMode | ''>('');
  const [contextReducerSession, setContextReducerSession] = useState('');
  const [contextReducerTemplate, setContextReducerTemplate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const enabledSdkParticipants = useMemo(
    () => allEligible.filter((entry) => entry.flavor === 'sdk').filter((entry) => {
      const cfg = sessionCfg[entry.key];
      return !!cfg?.enabled && cfg.mode !== 'skip';
    }),
    [allEligible, sessionCfg],
  );

  // Config key uses the main session (sub-sessions follow parent config)
  const configKey = scopeSession ? `p2p_session_config:${scopeSession}` : null;

  // Load saved config — per-session key with legacy global fallback
  useEffect(() => {
    if (!configKey) { setLoading(false); return; }
    setLoading(true);
    const apply = (raw: unknown) => {
      if (raw && typeof raw === 'string') {
        try {
          const parsed: P2pSavedConfig = JSON.parse(raw);
          setSessionCfg(parsed.sessions ?? {});
          setRounds(parsed.rounds ?? 3);
          setHopTimeoutMinutes(parsed.hopTimeoutMinutes ?? 8);
          setExtraPrompt(parsed.extraPrompt ?? '');
          setAdvancedPresetKey(parsed.advancedPresetKey ?? '');
          setAdvancedRounds(parsed.advancedRounds);
          setAdvancedRunTimeoutMinutes(parsed.advancedRunTimeoutMinutes ?? 30);
          setContextReducerMode(parsed.contextReducer?.mode ?? '');
          setContextReducerSession(parsed.contextReducer?.sessionName ?? '');
          setContextReducerTemplate(parsed.contextReducer?.templateSession ?? '');
          setAdvancedExpanded(Boolean(parsed.advancedPresetKey || parsed.contextReducer || parsed.advancedRunTimeoutMinutes != null));
        } catch { /* start fresh */ }
      }
      setLoading(false);
    };
    void getUserPref(configKey).then((raw) => {
      if (raw) { apply(raw); return; }
      // Fallback: migrate from legacy global key
      void getUserPref('p2p_session_config').then((legacyRaw) => {
        if (legacyRaw && typeof legacyRaw === 'string') {
          void saveUserPref(configKey!, legacyRaw).catch(() => {});
        }
        apply(legacyRaw);
      });
    });
  }, [configKey]);

  useEffect(() => {
    if (contextReducerMode === 'reuse_existing_session') {
      const stillEligible = enabledSdkParticipants.some((entry) => entry.key === contextReducerSession);
      if (!stillEligible) setContextReducerSession(enabledSdkParticipants[0]?.key ?? '');
      return;
    }
    if (contextReducerMode === 'clone_sdk_session') {
      const stillEligible = enabledSdkParticipants.some((entry) => entry.key === contextReducerTemplate);
      if (!stillEligible) setContextReducerTemplate(enabledSdkParticipants[0]?.key ?? '');
      return;
    }
    setContextReducerSession('');
    setContextReducerTemplate('');
  }, [contextReducerMode, contextReducerSession, contextReducerTemplate, enabledSdkParticipants]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleEnabled = (key: string) => {
    setSessionCfg((prev) => {
      const cur = prev[key] ?? { enabled: false, mode: 'audit' };
      return { ...prev, [key]: { ...cur, enabled: !cur.enabled } };
    });
  };

  const setMode = (key: string, mode: string) => {
    setSessionCfg((prev) => {
      const cur = prev[key] ?? { enabled: false, mode: 'audit' };
      return { ...prev, [key]: { ...cur, mode } };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    // Only keep entries for currently eligible sessions — drop stale entries
    // from old/closed sessions or other daemons to prevent config rot.
    const merged: P2pSessionConfig = {};
    for (const e of allEligible) {
      merged[e.key] = sessionCfg[e.key] ?? { enabled: false, mode: 'audit' };
    }
    let contextReducer: P2pContextReducerConfig | undefined;
    if (advancedPresetKey && contextReducerMode === 'reuse_existing_session' && contextReducerSession) {
      contextReducer = { mode: 'reuse_existing_session', sessionName: contextReducerSession };
    } else if (advancedPresetKey && contextReducerMode === 'clone_sdk_session' && contextReducerTemplate) {
      contextReducer = { mode: 'clone_sdk_session', templateSession: contextReducerTemplate };
    }
    const resolvedAdvancedRounds = advancedPresetKey
      ? (advancedRounds ? JSON.parse(JSON.stringify(advancedRounds)) as P2pAdvancedRound[] : JSON.parse(JSON.stringify(BUILT_IN_ADVANCED_PRESETS[advancedPresetKey])) as P2pAdvancedRound[])
      : undefined;
    const cfg: P2pSavedConfig = {
      sessions: merged,
      rounds,
      hopTimeoutMinutes,
      extraPrompt: extraPrompt.trim() || undefined,
      advancedPresetKey: advancedPresetKey || undefined,
      advancedRounds: resolvedAdvancedRounds,
      advancedRunTimeoutMinutes: advancedPresetKey ? advancedRunTimeoutMinutes : undefined,
      contextReducer,
    };
    try {
      if (configKey) await saveUserPref(configKey, JSON.stringify(cfg));
      onSave(cfg);
    } catch { /* ignore — UI still closes */ }
    setSaving(false);
    onClose();
  };

  const getEntry = (key: string) => sessionCfg[key] ?? { enabled: false, mode: 'audit' };
  const handleAdvancedPresetChange = (value: string) => {
    const nextPreset = value as P2pAdvancedPresetKey | '';
    setAdvancedPresetKey(nextPreset);
    if (!nextPreset) {
      setAdvancedRounds(undefined);
      setContextReducerMode('');
      setContextReducerSession('');
      setContextReducerTemplate('');
      return;
    }
    setAdvancedRounds((prev) => prev ?? (JSON.parse(JSON.stringify(BUILT_IN_ADVANCED_PRESETS[nextPreset])) as P2pAdvancedRound[]));
    setAdvancedRunTimeoutMinutes((prev) => (prev > 0 ? prev : 30));
  };

  const updateAdvancedRound = (roundId: string, updater: (round: P2pAdvancedRound) => P2pAdvancedRound) => {
    setAdvancedRounds((prev) => {
      if (!prev) return prev;
      return prev.map((round) => (round.id === roundId ? updater(round) : round));
    });
  };
  const overlayStyle: Record<string, string | number> = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: isMobile ? 'flex-start' : 'center',
    justifyContent: 'center',
    zIndex: 9999,
    padding: isMobile ? 'calc(env(safe-area-inset-top, 0px) + 12px) 0 0' : 16,
  };
  const panelStyle: Record<string, string | number> = {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: isMobile ? 0 : 10,
    width: isMobile ? '100vw' : 'min(780px, calc(100vw - 32px))',
    maxWidth: isMobile ? '100vw' : 780,
    height: isMobile ? 'calc(100vh - env(safe-area-inset-top, 0px) - 12px)' : 'auto',
    maxHeight: isMobile ? 'calc(100vh - env(safe-area-inset-top, 0px) - 12px)' : '90vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: isMobile ? 'none' : '0 8px 32px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  };

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>{t('p2p.settings_title')}</h2>
          <button style={closeBtnStyle} onClick={onClose}>✕</button>
        </div>
        <div style={tabsStyle}>
          <button type="button" style={tabStyle(activeTab === 'participants')} onClick={() => setActiveTab('participants')}>
            {t('p2p.picker.agents')}
          </button>
          <button type="button" style={tabStyle(activeTab === 'combos')} onClick={() => setActiveTab('combos')}>
            {t('p2p.combo_label')}
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#64748b', fontSize: 13 }}>…</div>
          ) : (
            activeTab === 'participants' ? (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <button
                    type="button"
                    style={tabStyle(agentFlavorFilter === 'sdk')}
                    onClick={() => setAgentFlavorFilter('sdk')}
                  >
                    {t('p2p.settings_filter_sdk', 'SDK')}
                  </button>
                  <button
                    type="button"
                    style={tabStyle(agentFlavorFilter === 'cli')}
                    onClick={() => setAgentFlavorFilter('cli')}
                  >
                    {t('p2p.settings_filter_cli', 'CLI')}
                  </button>
                </div>

                <div style={sectionCardStyle}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.picker.agents')}</div>
                  {visibleEligible.length === 0 && (
                    <div style={{ color: '#64748b', fontSize: 13, padding: '8px 0' }}>
                      {t('p2p.picker.no_agents_available')}
                    </div>
                  )}
                  <div style={agentGridStyle(isMobile)}>
                  {visibleEligible.map((e) => {
                    const entry = getEntry(e.key);
                    return (
                      <div key={e.key} style={{ ...rowStyle, opacity: entry.enabled ? 1 : 0.6 }}>
                        <input
                          type="checkbox"
                          style={checkboxStyle}
                          checked={entry.enabled}
                          onChange={() => toggleEnabled(e.key)}
                        />
                        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.shortName}</span>
                          <span style={{ ...badgeStyle, width: 'fit-content', fontSize: 10 }}>{e.agentType}</span>
                        </div>
                        <select
                          style={{ ...selectStyle, width: '100%', minWidth: 110, fontSize: 12, padding: '5px 8px' }}
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
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                  <div style={sectionCardStyle}>
                    <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_rounds')}</div>
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
                  </div>

                  <div style={sectionCardStyle}>
                    <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_hop_timeout', 'Hop Timeout')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={hopTimeoutMinutes}
                        onInput={(e) => {
                          const v = parseInt((e.target as HTMLInputElement).value, 10);
                          if (v >= 1 && v <= 10) setHopTimeoutMinutes(v);
                        }}
                        style={{
                          width: 72,
                          background: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: 5,
                          color: '#e2e8f0',
                          fontSize: 13,
                          padding: '6px 8px',
                          textAlign: 'center',
                          outline: 'none',
                        }}
                      />
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{t('p2p.settings_hop_timeout_unit', 'minutes per hop')}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                      {t('p2p.settings_hop_timeout_hint', 'How long to wait for each agent to respond. Increase for complex tasks.')}
                    </div>
                  </div>
                </div>

                <div style={{ ...sectionCardStyle, marginTop: 12 }}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_extra_prompt')}</div>
                  <textarea
                    value={extraPrompt}
                    onInput={(e) => setExtraPrompt((e.target as HTMLTextAreaElement).value)}
                    placeholder={t('p2p.settings_extra_prompt_hint')}
                    rows={3}
                    style={{
                      width: '100%',
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: 6,
                      color: '#e2e8f0',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      padding: '8px 10px',
                      resize: 'vertical',
                      outline: 'none',
                    }}
                  />
                </div>

                <div style={{ ...sectionCardStyle, marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={() => setAdvancedExpanded((value) => !value)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'none',
                      border: 'none',
                      color: '#e2e8f0',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    aria-expanded={advancedExpanded}
                  >
                    <span>{t('p2p.settings_advanced_title', 'Advanced workflow')}</span>
                    <span>{advancedExpanded ? '▾' : '▸'}</span>
                  </button>
                  {advancedExpanded && (
                    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                      <label style={fieldLabelStyle}>
                        <span>{t('p2p.settings_advanced_preset', 'Advanced preset')}</span>
                        <select
                          value={advancedPresetKey}
                          onChange={(event) => handleAdvancedPresetChange((event.target as HTMLSelectElement).value)}
                          style={fieldInputStyle}
                          aria-label={t('p2p.settings_advanced_preset', 'Advanced preset')}
                        >
                          <option value="">{t('common.off', 'Off')}</option>
                          <option value="openspec">OpenSpec</option>
                        </select>
                      </label>

                      {advancedPresetKey && (
                        <>
                          <label style={fieldLabelStyle}>
                            <span>{t('p2p.settings_advanced_run_timeout', 'Whole-run timeout')}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input
                                type="number"
                                min={1}
                                max={240}
                                value={advancedRunTimeoutMinutes}
                                onInput={(event) => {
                                  const next = parseInt((event.target as HTMLInputElement).value, 10);
                                  if (Number.isFinite(next) && next >= 1 && next <= 240) setAdvancedRunTimeoutMinutes(next);
                                }}
                                style={{ ...fieldInputStyle, width: 88, textAlign: 'center' }}
                                aria-label={t('p2p.settings_advanced_run_timeout', 'Whole-run timeout')}
                              />
                              <span style={{ fontSize: 12, color: '#94a3b8' }}>{t('p2p.settings_advanced_run_timeout_unit', 'minutes total')}</span>
                            </div>
                          </label>

                          <label style={fieldLabelStyle}>
                            <span>{t('p2p.settings_context_reducer_mode', 'Reducer mode')}</span>
                            <select
                              value={contextReducerMode}
                              onChange={(event) => setContextReducerMode((event.target as HTMLSelectElement).value as P2pContextReducerMode | '')}
                              style={fieldInputStyle}
                              aria-label={t('p2p.settings_context_reducer_mode', 'Reducer mode')}
                            >
                              <option value="">{t('common.none', 'None')}</option>
                              <option value="reuse_existing_session">{t('p2p.settings_context_reducer_reuse', 'Reuse existing SDK participant')}</option>
                              <option value="clone_sdk_session">{t('p2p.settings_context_reducer_clone', 'Clone SDK session template')}</option>
                            </select>
                          </label>

                          {contextReducerMode === 'reuse_existing_session' && (
                            <label style={fieldLabelStyle}>
                              <span>{t('p2p.settings_context_reducer_session', 'Reducer participant')}</span>
                              <select
                                value={contextReducerSession}
                                onChange={(event) => setContextReducerSession((event.target as HTMLSelectElement).value)}
                                style={fieldInputStyle}
                                aria-label={t('p2p.settings_context_reducer_session', 'Reducer participant')}
                              >
                                <option value="">{enabledSdkParticipants.length > 0 ? t('common.select', 'Select') : t('p2p.picker.no_agents_available')}</option>
                                {enabledSdkParticipants.map((entry) => (
                                  <option key={entry.key} value={entry.key}>{entry.shortName}</option>
                                ))}
                              </select>
                            </label>
                          )}

                          {contextReducerMode === 'clone_sdk_session' && (
                            <label style={fieldLabelStyle}>
                              <span>{t('p2p.settings_context_reducer_template', 'Template participant')}</span>
                              <select
                                value={contextReducerTemplate}
                                onChange={(event) => setContextReducerTemplate((event.target as HTMLSelectElement).value)}
                                style={fieldInputStyle}
                                aria-label={t('p2p.settings_context_reducer_template', 'Template participant')}
                              >
                                <option value="">{enabledSdkParticipants.length > 0 ? t('common.select', 'Select') : t('p2p.picker.no_agents_available')}</option>
                                {enabledSdkParticipants.map((entry) => (
                                  <option key={entry.key} value={entry.key}>{entry.shortName}</option>
                                ))}
                              </select>
                            </label>
                          )}

                          {advancedRounds && advancedRounds.length > 0 && (
                            <div style={{ display: 'grid', gap: 10 }}>
                              <div style={{ ...sectionLabelStyle, marginTop: 4, marginBottom: 0 }}>
                                {t('p2p.settings_advanced_rounds', 'Advanced rounds')}
                              </div>
                              {advancedRounds.map((round) => (
                                <div
                                  key={round.id}
                                  style={{
                                    display: 'grid',
                                    gap: 10,
                                    background: '#0b1220',
                                    border: '1px solid #334155',
                                    borderRadius: 8,
                                    padding: 12,
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{round.title}</div>
                                      <div style={{ fontSize: 11, color: '#64748b' }}>{round.id} · {round.preset}</div>
                                    </div>
                                    <select
                                      value={round.executionMode}
                                      onChange={(event) => updateAdvancedRound(round.id, (current) => ({
                                        ...current,
                                        executionMode: (event.target as HTMLSelectElement).value as P2pAdvancedRound['executionMode'],
                                      }))}
                                      style={{ ...fieldInputStyle, width: 180 }}
                                      aria-label={`${round.id}-execution-mode`}
                                    >
                                      <option value="single_main">{t('p2p.settings_single_main', 'Single main')}</option>
                                      <option value="multi_dispatch">{t('p2p.settings_multi_dispatch', 'Multi-dispatch')}</option>
                                    </select>
                                  </div>

                                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                                    <label style={fieldLabelStyle}>
                                      <span>{t('p2p.settings_round_timeout', 'Round timeout')}</span>
                                      <input
                                        type="number"
                                        min={1}
                                        max={60}
                                        value={round.timeoutMinutes ?? 5}
                                        onInput={(event) => {
                                          const next = parseInt((event.target as HTMLInputElement).value, 10);
                                          if (Number.isFinite(next) && next >= 1 && next <= 60) {
                                            updateAdvancedRound(round.id, (current) => ({ ...current, timeoutMinutes: next }));
                                          }
                                        }}
                                        style={fieldInputStyle}
                                        aria-label={`${round.id}-timeout`}
                                      />
                                    </label>
                                    <label style={fieldLabelStyle}>
                                      <span>{t('p2p.settings_verdict_policy', 'Verdict policy')}</span>
                                      <select
                                        value={round.verdictPolicy ?? 'none'}
                                        onChange={(event) => updateAdvancedRound(round.id, (current) => ({
                                          ...current,
                                          verdictPolicy: (event.target as HTMLSelectElement).value as NonNullable<P2pAdvancedRound['verdictPolicy']>,
                                          jumpRule: (event.target as HTMLSelectElement).value === 'none'
                                            ? undefined
                                            : current.jumpRule ?? {
                                              targetRoundId: advancedRounds.find((candidate) => candidate.id !== current.id)?.id ?? '',
                                              marker: 'REWORK',
                                              minTriggers: 0,
                                              maxTriggers: 2,
                                            },
                                        }))}
                                        style={fieldInputStyle}
                                        aria-label={`${round.id}-verdict-policy`}
                                      >
                                        <option value="none">{t('common.none', 'None')}</option>
                                        <option value="smart_gate">{t('p2p.settings_smart_gate', 'Smart gate')}</option>
                                        <option value="forced_rework">{t('p2p.settings_forced_rework', 'Forced rework')}</option>
                                      </select>
                                    </label>
                                  </div>

                                  {(round.verdictPolicy === 'smart_gate' || round.verdictPolicy === 'forced_rework' || round.jumpRule) && (
                                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                                      <label style={fieldLabelStyle}>
                                        <span>{t('p2p.settings_jump_target', 'Jump target')}</span>
                                        <select
                                          value={round.jumpRule?.targetRoundId ?? ''}
                                          onChange={(event) => updateAdvancedRound(round.id, (current) => ({
                                            ...current,
                                            jumpRule: {
                                              targetRoundId: (event.target as HTMLSelectElement).value,
                                              marker: current.jumpRule?.marker ?? 'REWORK',
                                              minTriggers: current.jumpRule?.minTriggers ?? 0,
                                              maxTriggers: current.jumpRule?.maxTriggers ?? 2,
                                            },
                                          }))}
                                          style={fieldInputStyle}
                                          aria-label={`${round.id}-jump-target`}
                                        >
                                          <option value="">{t('common.none', 'None')}</option>
                                          {advancedRounds
                                            .filter((candidate) => candidate.id !== round.id)
                                            .map((candidate) => (
                                              <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
                                            ))}
                                        </select>
                                      </label>
                                      <label style={fieldLabelStyle}>
                                        <span>{t('p2p.settings_jump_marker', 'Jump marker')}</span>
                                        <select
                                          value={round.jumpRule?.marker ?? 'REWORK'}
                                          onChange={(event) => updateAdvancedRound(round.id, (current) => ({
                                            ...current,
                                            jumpRule: current.jumpRule ? {
                                              ...current.jumpRule,
                                              marker: (event.target as HTMLSelectElement).value as 'PASS' | 'REWORK',
                                            } : undefined,
                                          }))}
                                          style={fieldInputStyle}
                                          aria-label={`${round.id}-jump-marker`}
                                        >
                                          <option value="REWORK">REWORK</option>
                                          <option value="PASS">PASS</option>
                                        </select>
                                      </label>
                                      <label style={fieldLabelStyle}>
                                        <span>{t('p2p.settings_min_triggers', 'Min triggers')}</span>
                                        <input
                                          type="number"
                                          min={0}
                                          max={10}
                                          value={round.jumpRule?.minTriggers ?? 0}
                                          onInput={(event) => updateAdvancedRound(round.id, (current) => ({
                                            ...current,
                                            jumpRule: current.jumpRule ? {
                                              ...current.jumpRule,
                                              minTriggers: parseInt((event.target as HTMLInputElement).value, 10) || 0,
                                            } : undefined,
                                          }))}
                                          style={fieldInputStyle}
                                          aria-label={`${round.id}-min-triggers`}
                                        />
                                      </label>
                                      <label style={fieldLabelStyle}>
                                        <span>{t('p2p.settings_max_triggers', 'Max triggers')}</span>
                                        <input
                                          type="number"
                                          min={1}
                                          max={10}
                                          value={round.jumpRule?.maxTriggers ?? 2}
                                          onInput={(event) => updateAdvancedRound(round.id, (current) => ({
                                            ...current,
                                            jumpRule: current.jumpRule ? {
                                              ...current.jumpRule,
                                              maxTriggers: parseInt((event.target as HTMLInputElement).value, 10) || 1,
                                            } : undefined,
                                          }))}
                                          style={fieldInputStyle}
                                          aria-label={`${round.id}-max-triggers`}
                                        />
                                      </label>
                                    </div>
                                  )}

                                  {(round.permissionScope === 'artifact_generation' || (round.artifactOutputs?.length ?? 0) > 0) && (
                                    <label style={fieldLabelStyle}>
                                      <span>{t('p2p.settings_artifact_outputs', 'Artifact outputs')}</span>
                                      <input
                                        type="text"
                                        value={(round.artifactOutputs ?? []).join(', ')}
                                        onInput={(event) => updateAdvancedRound(round.id, (current) => ({
                                          ...current,
                                          artifactOutputs: (event.target as HTMLInputElement).value
                                            .split(',')
                                            .map((entry) => entry.trim())
                                            .filter(Boolean),
                                        }))}
                                        style={fieldInputStyle}
                                        aria-label={`${round.id}-artifact-outputs`}
                                      />
                                    </label>
                                  )}

                                  <label style={fieldLabelStyle}>
                                    <span>{t('p2p.settings_prompt_append', 'Prompt append')}</span>
                                    <textarea
                                      value={round.promptAppend ?? ''}
                                      onInput={(event) => updateAdvancedRound(round.id, (current) => ({
                                        ...current,
                                        promptAppend: (event.target as HTMLTextAreaElement).value,
                                      }))}
                                      rows={2}
                                      style={{ ...fieldInputStyle, resize: 'vertical' }}
                                      aria-label={`${round.id}-prompt-append`}
                                    />
                                  </label>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={sectionCardStyle}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.combo_label')}</div>
                  <P2pComboManager
                    customCombos={customCombos}
                    onCustomCombosChange={saveCustomCombos}
                  />
                </div>
              </>
            )
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
