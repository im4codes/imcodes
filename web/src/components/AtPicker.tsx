/**
 * AtPicker — dropdown autocomplete for @-mentions.
 * Two-step: first pick category (Files / Agents), then search/select within that category.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ServerMessage } from '../ws-client.js';
import { COMBO_PRESETS, COMBO_SEPARATOR, type P2pSavedConfig } from '@shared/p2p-modes.js';

interface SessionEntry {
  name: string;
  agentType: string;
  state: string;
  label?: string | null;
  parentSession?: string | null;
  isSelf?: boolean;
}

interface AtPickerProps {
  query: string;
  sessions: SessionEntry[];
  rootSession: string;
  wsClient: any;
  projectDir?: string;
  onSelectFile: (path: string) => void;
  onSelectAgent: (session: string, mode: string) => void;
  onSelectAllConfig?: (config: P2pSavedConfig, rounds: number, modeOverride: string) => void;
  p2pConfig?: P2pSavedConfig | null;
  onClose: () => void;
  onStageChange?: (stage: 'choose' | 'files' | 'agents' | 'mode') => void;
  visible: boolean;
}

type Category = 'choose' | 'files' | 'agents';

const MODES = ['audit', 'review', 'plan', 'brainstorm', 'discuss'] as const;

const DEBOUNCE_MS = 200;

// ── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: Record<string, string | number> = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  maxHeight: 280,
  overflowY: 'auto',
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  boxShadow: '0 -4px 12px rgba(0,0,0,0.4)',
  zIndex: 50,
  padding: '4px 0',
};

const categoryStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  cursor: 'pointer',
  fontSize: 14,
  color: '#e2e8f0',
};

const categoryHighlightStyle: Record<string, string | number> = {
  ...categoryStyle,
  background: '#334155',
};

const groupLabelStyle: Record<string, string | number> = {
  padding: '4px 10px 2px',
  fontSize: 10,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const itemStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 13,
  color: '#e2e8f0',
  whiteSpace: 'nowrap',
};

const itemHighlightStyle: Record<string, string | number> = {
  ...itemStyle,
  background: '#334155',
};

const dimStyle: Record<string, string | number> = {
  color: '#64748b',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginLeft: 4,
};

const busyDotStyle: Record<string, string | number> = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#f59e0b',
  flexShrink: 0,
};

const modeContainerStyle: Record<string, string | number> = {
  padding: '4px 10px',
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const modeBtnStyle: Record<string, string | number> = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: 12,
  cursor: 'pointer',
};

const modeBtnHoverStyle: Record<string, string | number> = {
  ...modeBtnStyle,
  background: '#334155',
  borderColor: '#60a5fa',
  color: '#93c5fd',
};

const backBtnStyle: Record<string, string | number> = {
  padding: '4px 10px',
  fontSize: 11,
  color: '#60a5fa',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

const MODE_COLORS: Record<string, string> = {
  config: '#94a3b8',
  audit: '#f59e0b',
  review: '#3b82f6',
  plan: '#06b6d4',
  brainstorm: '#a78bfa',
  discuss: '#22c55e',
};

function comboModeColor(key: string): string {
  const last = key.split(COMBO_SEPARATOR).pop()?.trim();
  return last ? (MODE_COLORS[last] ?? '#94a3b8') : '#94a3b8';
}

function comboModeLabel(key: string, t: (k: string) => string): string {
  return key.split(COMBO_SEPARATOR).map((m) => t(`p2p.mode_${m.trim()}`)).join('→');
}

function buildEffectiveConfig(config: P2pSavedConfig, modeOverride: string): P2pSavedConfig {
  if (modeOverride === 'config') return config;
  const overriddenSessions: P2pSavedConfig['sessions'] = {};
  for (const [session, entry] of Object.entries(config.sessions)) {
    overriddenSessions[session] = entry.enabled && entry.mode !== 'skip'
      ? { ...entry, mode: modeOverride }
      : { ...entry };
  }
  return { ...config, sessions: overriddenSessions };
}

export function AtPicker({
  query,
  sessions,
  rootSession,
  wsClient,
  projectDir,
  onSelectFile,
  onSelectAgent,
  onSelectAllConfig,
  p2pConfig,
  onClose,
  onStageChange,
  visible,
}: AtPickerProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>('choose');
  const [fileResults, setFileResults] = useState<Array<{ path: string; basename: string; dir: string }>>([]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [modeAgent, setModeAgent] = useState<string | null>(null);
  const [modeHighlight, setModeHighlight] = useState(0);
  // Config mode: show rounds picker before dispatching
  const [configRoundsPicker, setConfigRoundsPicker] = useState(false);
  const [configRoundsHighlight, setConfigRoundsHighlight] = useState(0);
  const [configModeOverride, setConfigModeOverride] = useState<string>('config');
  const [configPickerFocus, setConfigPickerFocus] = useState<'rounds' | 'mode'>('rounds');
  const CONFIG_ROUNDS_OPTIONS = [1, 2, 3, 5] as const;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build session lookup for label/type resolution (used in config previews)
  const sessionLookup = useMemo(() => {
    const map = new Map<string, { label?: string | null; agentType: string }>();
    for (const s of sessions) {
      if (!map.has(s.name)) map.set(s.name, { label: s.label, agentType: s.agentType });
    }
    return map;
  }, [sessions]);

  /** Resolve a human-readable display name for a session key */
  const resolveDisplayName = useCallback((sessionKey: string) => {
    const entry = sessionLookup.get(sessionKey);
    if (entry?.label) return entry.label;
    const parts = sessionKey.split('_');
    return parts[parts.length - 1] || sessionKey;
  }, [sessionLookup]);

  /** Resolve agent type for a session key */
  const resolveAgentType = useCallback((sessionKey: string) => {
    return sessionLookup.get(sessionKey)?.agentType ?? '';
  }, [sessionLookup]);

  // Deduplicate sessions by name, keep isSelf flag, exclude shell/script
  const agents = useMemo(() => {
    const seen = new Map<string, SessionEntry>();
    for (const s of sessions) {
      if (s.agentType === 'shell' || s.agentType === 'script') continue;
      if (rootSession && s.name !== rootSession && s.parentSession !== rootSession) continue;
      const existing = seen.get(s.name);
      if (!existing) {
        seen.set(s.name, s);
      } else if (s.isSelf && !existing.isSelf) {
        // Prefer the one with isSelf
        seen.set(s.name, s);
      }
    }
    return [...seen.values()]
      .map((s) => {
        const shortName = s.label || s.name.split('_').pop() || s.name;
        return {
          session: s.name,
          shortName,
          agentType: s.agentType,
          busy: s.state !== 'idle',
          isSelf: !!s.isSelf,
        };
      })
      .filter((a) => !query || a.shortName.toLowerCase().includes(query.toLowerCase()) || a.session.toLowerCase().includes(query.toLowerCase()));
  }, [sessions, query, rootSession]);

  // Debounced file search — only when in files category
  useEffect(() => {
    if (!visible || category !== 'files' || !query || query.length < 1) {
      if (category !== 'files') setFileResults([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!wsClient || !wsClient.connected) return;
      const reqId = crypto.randomUUID();
      requestIdRef.current = reqId;
      try {
        wsClient.send({ type: 'file.search', requestId: reqId, query, projectDir });
      } catch {
        // WS not connected
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, visible, wsClient, category, projectDir]);

  // Listen for file search responses
  useEffect(() => {
    if (!wsClient) return;
    const handler = (msg: ServerMessage) => {
      if (msg.type === 'file.search_response' && msg.requestId === requestIdRef.current) {
        const results = (msg.results ?? []).slice(0, 15).map((p: string) => {
          const lastSlash = p.lastIndexOf('/');
          return {
            path: p,
            basename: lastSlash >= 0 ? p.slice(lastSlash + 1) : p,
            dir: lastSlash >= 0 ? p.slice(0, lastSlash) : '',
          };
        });
        setFileResults(results);
      }
    };
    const unsub = wsClient.onMessage(handler);
    return unsub;
  }, [wsClient]);

  // Reset when visibility or category changes
  useEffect(() => {
    setHighlightIdx(0);
    setModeAgent(null);
  }, [query, visible, category]);

  // Reset to category chooser when picker opens
  useEffect(() => {
    if (visible) {
      setCategory('choose');
      setFileResults([]);
      setModeAgent(null);
      setConfigRoundsPicker(false);
      setConfigModeOverride('config');
      setConfigPickerFocus('rounds');
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (modeAgent !== null) {
      onStageChange?.('mode');
      return;
    }
    onStageChange?.(category);
  }, [visible, category, modeAgent, onStageChange]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      // Config rounds sub-picker
      if (configRoundsPicker) {
        const ALL_MODES = ['config', 'audit', 'review', 'plan', 'brainstorm', 'discuss'] as const;
        const currentModeIdx = Math.max(0, ALL_MODES.indexOf(configModeOverride as typeof ALL_MODES[number]));
        if (e.key === 'Escape') { e.preventDefault(); setConfigRoundsPicker(false); setConfigPickerFocus('rounds'); return; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setConfigPickerFocus((f) => (f === 'rounds' ? 'mode' : 'rounds'));
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (configPickerFocus === 'rounds') {
            setConfigRoundsHighlight((h) => (h - 1 + CONFIG_ROUNDS_OPTIONS.length) % CONFIG_ROUNDS_OPTIONS.length);
          } else {
            const next = (currentModeIdx - 1 + ALL_MODES.length) % ALL_MODES.length;
            setConfigModeOverride(ALL_MODES[next]);
          }
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (configPickerFocus === 'rounds') {
            setConfigRoundsHighlight((h) => (h + 1) % CONFIG_ROUNDS_OPTIONS.length);
          } else {
            const next = (currentModeIdx + 1) % ALL_MODES.length;
            setConfigModeOverride(ALL_MODES[next]);
          }
          return;
        }
        if (e.key === 'Enter' && p2pConfig) {
          e.preventDefault(); e.stopPropagation();
          const rounds = CONFIG_ROUNDS_OPTIONS[configRoundsHighlight];
          const effectiveConfig = buildEffectiveConfig(p2pConfig, configModeOverride);
          onSelectAllConfig?.(effectiveConfig, rounds, configModeOverride);
          setConfigRoundsPicker(false);
          setConfigPickerFocus('rounds');
          return;
        }
        return;
      }

      // Mode sub-picker
      if (modeAgent !== null) {
        if (e.key === 'Escape') { e.preventDefault(); setModeAgent(null); return; }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setModeHighlight((h) => (h - 1 + MODES.length) % MODES.length); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setModeHighlight((h) => (h + 1) % MODES.length); return; }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSelectAgent(modeAgent, MODES[modeHighlight]); setModeAgent(null); return; }
        return;
      }

      // Category chooser
      if (category === 'choose') {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightIdx((h) => (h === 0 ? 1 : 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          setCategory(highlightIdx === 0 ? 'files' : 'agents');
          setHighlightIdx(0);
          return;
        }
        return;
      }

      // Files or Agents list — config only affects @@all rows, individual agents always show all
      const kbConfigMap = p2pConfig ? new Map(Object.entries(p2pConfig.sessions)) : null;
      const kbCfgFiltered = kbConfigMap
        ? agents.filter(a => { const entry = kbConfigMap.get(a.session); return entry ? (entry.enabled && entry.mode !== 'skip') : false; })
        : null;
      const kbCfgActive = kbCfgFiltered && kbCfgFiltered.length > 0;
      const nonSelfCount = agents.filter(a => !a.isSelf).length;
      const hasAllRow = category === 'agents' && nonSelfCount > 1;
      const cfgParticipants = kbCfgActive
        ? kbCfgFiltered.map(a => [a.session, kbConfigMap!.get(a.session)!] as [string, { enabled: boolean; mode: string }])
        : [];
      const cfgRowCount = category === 'agents' && cfgParticipants.length > 0 ? 2 : 0;
      const regAllOffset = cfgRowCount;
      const agentsOff = regAllOffset + (hasAllRow ? 1 : 0);
      const count = category === 'files' ? fileResults.length : cfgRowCount + (hasAllRow ? 1 : 0) + agents.length;
      if (e.key === 'Escape') {
        e.preventDefault();
        setCategory('choose');
        setHighlightIdx(0);
        return;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx((h) => (h - 1 + count) % count); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx((h) => (h + 1) % count); return; }
      if (e.key === 'Enter' && count > 0) {
        e.preventDefault(); e.stopPropagation();
        if (category === 'files') {
          const f = fileResults[highlightIdx];
          if (f) onSelectFile(f.path);
        } else if (cfgRowCount > 0 && highlightIdx === 0) {
          // @all with saved rounds
          const rounds = p2pConfig!.rounds ?? 1;
          onSelectAllConfig?.(p2pConfig!, rounds, 'config');
        } else if (cfgRowCount > 0 && highlightIdx === 1) {
          // @all+ — open rounds picker
          setConfigRoundsPicker(true); setConfigRoundsHighlight(0); setConfigModeOverride('config'); setConfigPickerFocus('rounds');
        } else if (hasAllRow && highlightIdx === regAllOffset) {
          setModeAgent('__all__'); setModeHighlight(0);
        } else {
          const agentIdx = highlightIdx - agentsOff;
          const a = agents[agentIdx];
          if (a) { setModeAgent(a.session); setModeHighlight(0); }
        }
      }
    },
    [visible, category, highlightIdx, fileResults, agents, modeAgent, modeHighlight, configRoundsPicker, configRoundsHighlight, configModeOverride, configPickerFocus, p2pConfig, onClose, onSelectFile, onSelectAgent, onSelectAllConfig],
  );

  useEffect(() => {
    if (!visible) return;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [visible, handleKeyDown]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector('[data-hl="true"]');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  if (!visible) return null;

  // ── Config rounds sub-picker (for @all+ with custom rounds) ──
  if (configRoundsPicker && p2pConfig) {
    const ALL_MODES = ['config', 'audit', 'review', 'plan', 'brainstorm', 'discuss'];
    const effectiveConfig = buildEffectiveConfig(p2pConfig, configModeOverride);
    const participants = Object.entries(effectiveConfig.sessions)
      .filter(([, e]) => e.enabled && e.mode !== 'skip');
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={backBtnStyle} onClick={() => { setConfigRoundsPicker(false); setConfigModeOverride('config'); setConfigPickerFocus('rounds'); }}>← {t('p2p.picker.back')}</div>
        <div style={{
          ...groupLabelStyle,
          color: configPickerFocus === 'mode' ? '#93c5fd' : groupLabelStyle.color,
        }}>{t('p2p.settings_mode', 'Mode')}</div>
        <div style={modeContainerStyle}>
          {ALL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              style={{
                ...modeBtnStyle,
                ...(configModeOverride === m ? {
                  background: '#1e293b',
                  borderColor: MODE_COLORS[m] ?? '#60a5fa',
                  color: MODE_COLORS[m] ?? '#93c5fd',
                  boxShadow: `0 0 0 1px ${(MODE_COLORS[m] ?? '#60a5fa')}55, 0 0 18px ${(MODE_COLORS[m] ?? '#60a5fa')}22`,
                  fontWeight: 700,
                } : {}),
                fontSize: 11,
                padding: '2px 8px',
              }}
              onClick={() => { setConfigModeOverride(m); setConfigPickerFocus('mode'); }}
            >
              {configModeOverride === m ? '● ' : ''}{t(`p2p.mode_${m}`)}
            </button>
          ))}
        </div>
        {/* Combo presets */}
        <div style={{ ...groupLabelStyle, marginTop: 6 }}>{t('p2p.combo_label')}</div>
        <div style={{ ...modeContainerStyle, flexWrap: 'wrap' }}>
          {COMBO_PRESETS.map((c) => {
            const isActive = configModeOverride === c.key;
            const color = comboModeColor(c.key);
            return (
              <button
                key={c.key}
                type="button"
                style={{
                  ...modeBtnStyle,
                  ...(isActive ? {
                    background: '#1e293b',
                    borderColor: color,
                    color,
                    boxShadow: `0 0 0 1px ${color}55, 0 0 18px ${color}22`,
                    fontWeight: 700,
                  } : {}),
                  fontSize: 10,
                  padding: '2px 6px',
                }}
                onClick={() => {
                  const cfg = buildEffectiveConfig(p2pConfig, c.pipeline[0]);
                  onSelectAllConfig?.(cfg, c.pipeline.length, c.key);
                  setConfigRoundsPicker(false);
                  setConfigPickerFocus('rounds');
                }}
              >
                {comboModeLabel(c.key, t)}
              </button>
            );
          })}
        </div>
        <div style={{ ...dimStyle, padding: '2px 12px 8px', color: configModeOverride.includes(COMBO_SEPARATOR) ? comboModeColor(configModeOverride) : (MODE_COLORS[configModeOverride] ?? dimStyle.color) }}>
          {t('p2p.settings_mode')}: {configModeOverride.includes(COMBO_SEPARATOR) ? comboModeLabel(configModeOverride, t) : t(`p2p.mode_${configModeOverride}`)}
        </div>
        <div style={{
          ...groupLabelStyle,
          color: configPickerFocus === 'rounds' ? '#93c5fd' : groupLabelStyle.color,
        }}>{t('p2p.settings_rounds')}</div>
        <div style={modeContainerStyle}>
          {CONFIG_ROUNDS_OPTIONS.map((r, idx) => (
            <button
              key={r}
              type="button"
              style={idx === configRoundsHighlight ? {
                ...modeBtnHoverStyle,
                boxShadow: configPickerFocus === 'rounds'
                  ? '0 0 0 1px rgba(147, 197, 253, 0.7), 0 0 18px rgba(96, 165, 250, 0.22)'
                  : modeBtnHoverStyle.boxShadow,
              } : modeBtnStyle}
              onClick={() => {
                const cfg = buildEffectiveConfig(p2pConfig, configModeOverride);
                onSelectAllConfig?.(cfg, r, configModeOverride);
                setConfigRoundsPicker(false);
                setConfigPickerFocus('rounds');
              }}
              onMouseEnter={() => { setConfigRoundsHighlight(idx); setConfigPickerFocus('rounds'); }}
            >
              {r}
            </button>
          ))}
        </div>
        {participants.length > 0 && (
          <>
            <div style={groupLabelStyle}>{t('p2p.picker.agents')}</div>
            {participants.map(([session, entry]) => {
              const shortName = resolveDisplayName(session);
              const aType = resolveAgentType(session);
              const effectiveMode = configModeOverride === 'config' ? entry.mode : configModeOverride;
              return (
                <div key={session} style={{ ...itemStyle, fontSize: 12, paddingLeft: 14 }}>
                  <span style={{ color: '#e2e8f0' }}>{shortName}</span>
                  {aType && <span style={dimStyle}>{aType}</span>}
                  <span style={{ ...dimStyle, color: MODE_COLORS[effectiveMode] ?? dimStyle.color }}>· {effectiveMode}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // ── Mode sub-picker ──
  if (modeAgent !== null) {
    const isAll = modeAgent === '__all__';
    const agentItem = isAll ? null : agents.find((a) => a.session === modeAgent);
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={backBtnStyle} onClick={() => setModeAgent(null)}>← {t('p2p.picker.back')}</div>
        <div style={groupLabelStyle}>
          {isAll ? `${t('p2p.picker.all_agents', 'All Agents')} — ` : agentItem ? `${agentItem.shortName} — ` : ''}{t('p2p.picker.select_mode')}
        </div>
        <div style={modeContainerStyle}>
          {MODES.map((mode, idx) => (
            <button
              key={mode}
              type="button"
              style={idx === modeHighlight ? modeBtnHoverStyle : modeBtnStyle}
              onClick={() => {
                if (isAll) {
                  onSelectAgent('__all__', mode);
                } else {
                  onSelectAgent(modeAgent, mode);
                }
                setModeAgent(null);
              }}
              onMouseEnter={() => setModeHighlight(idx)}
            >
              {t(`p2p.mode.${mode}`, mode.charAt(0).toUpperCase() + mode.slice(1))}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Category chooser ──
  if (category === 'choose') {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div
          data-hl={highlightIdx === 0 ? 'true' : undefined}
          style={highlightIdx === 0 ? categoryHighlightStyle : categoryStyle}
          onClick={() => { setCategory('files'); setHighlightIdx(0); }}
          onMouseEnter={() => setHighlightIdx(0)}
        >
          <span style={{ fontSize: 16 }}>📁</span>
          <span style={{ fontWeight: 500 }}>{t('p2p.picker.files')}</span>
          <span style={dimStyle}>{t('p2p.picker.search_project_files')}</span>
        </div>
        <div
          data-hl={highlightIdx === 1 ? 'true' : undefined}
          style={highlightIdx === 1 ? categoryHighlightStyle : categoryStyle}
          onClick={() => { setCategory('agents'); setHighlightIdx(0); }}
          onMouseEnter={() => setHighlightIdx(1)}
        >
          <span style={{ fontSize: 16 }}>🤖</span>
          <span style={{ fontWeight: 500 }}>{t('p2p.picker.agents')}</span>
          <span style={dimStyle}>{t('p2p.picker.quick_discussion_with_agent')}</span>
        </div>
      </div>
    );
  }

  // ── Files list ──
  if (category === 'files') {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={backBtnStyle} onClick={() => { setCategory('choose'); setHighlightIdx(0); }}>← {t('p2p.picker.back')}</div>
        <div style={groupLabelStyle}>
          {t('p2p.picker.files')} {query ? `— "${query}"` : `— ${t('p2p.picker.type_to_search')}`}
        </div>
        {fileResults.length === 0 && query && (
          <div style={{ ...itemStyle, color: '#64748b', justifyContent: 'center' }}>
            {query.length < 2 ? t('p2p.picker.keep_typing') : t('p2p.picker.no_files_found')}
          </div>
        )}
        {fileResults.map((f, idx) => {
          const hl = idx === highlightIdx;
          return (
            <div
              key={f.path}
              data-hl={hl ? 'true' : undefined}
              style={hl ? itemHighlightStyle : itemStyle}
              onClick={() => onSelectFile(f.path)}
              onMouseEnter={() => setHighlightIdx(idx)}
            >
              <span style={{ fontWeight: 500, color: '#e2e8f0' }}>{f.basename}</span>
              <span style={dimStyle}>{f.dir}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Agents list ──
  // Config filtering only affects @@all(config) rows — individual agents always show all.
  const cfgMap = p2pConfig ? new Map(Object.entries(p2pConfig.sessions)) : null;
  const cfgFiltered = cfgMap
    ? agents.filter(a => { const e = cfgMap.get(a.session); return e ? (e.enabled && e.mode !== 'skip') : false; })
    : null;
  const cfgActive = cfgFiltered && cfgFiltered.length > 0;
  // Config participants — for @@all(config) preview only
  const configParticipants: [string, { enabled: boolean; mode: string }][] = cfgActive
    ? cfgFiltered.map(a => [a.session, cfgMap!.get(a.session)!] as [string, { enabled: boolean; mode: string }])
    : [];
  const showConfigRows = cfgActive && configParticipants.length > 0;
  // Individual agents list — always show all (unfiltered)
  const nonSelfAgents = agents.filter(a => !a.isSelf);
  const showAll = nonSelfAgents.length > 1;
  const configRowCount = showConfigRows ? 2 : 0; // @all and @all+
  // Index offset: configRows come first, then regular @all, then individual agents
  const regularAllOffset = configRowCount;
  const agentsOffset = regularAllOffset + (showAll ? 1 : 0);

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={backBtnStyle} onClick={() => { setCategory('choose'); setHighlightIdx(0); }}>← {t('p2p.picker.back')}</div>
      <div style={groupLabelStyle}>{t('p2p.picker.agents')}</div>
      {agents.length === 0 && !showConfigRows && (
        <div style={{ ...itemStyle, color: '#64748b', justifyContent: 'center' }}>{t('p2p.picker.no_agents_available')}</div>
      )}

      {/* Config @all rows */}
      {showConfigRows && (() => {
        const rounds = p2pConfig!.rounds ?? 1;
        const hlAll = highlightIdx === 0;
        const hlAllPlus = highlightIdx === 1;
        return (
          <>
            {/* @all (N轮) — use saved rounds, dispatch immediately */}
            <div
              data-hl={hlAll ? 'true' : undefined}
              style={hlAll ? itemHighlightStyle : itemStyle}
              onClick={() => { onSelectAllConfig?.(p2pConfig!, rounds, 'config'); }}
              onMouseEnter={() => setHighlightIdx(0)}
            >
              <span style={{ fontWeight: 600, color: '#94a3b8' }}>⚙ {t('p2p.all_label')}</span>
              <span style={{ ...dimStyle, color: '#94a3b8' }}>({rounds} {t('p2p.settings_rounds').toLowerCase()})</span>
            </div>
            {/* Participant preview under @all */}
            {hlAll && (
              <div style={{ paddingLeft: 20, paddingBottom: 4 }}>
                {configParticipants.map(([session, entry]) => {
                  const shortName = resolveDisplayName(session);
                  const aType = resolveAgentType(session);
                  return (
                    <div key={session} style={{ fontSize: 11, color: '#64748b', lineHeight: '1.6' }}>
                      {shortName}{aType ? ` (${aType})` : ''} · {entry.mode}
                    </div>
                  );
                })}
              </div>
            )}
            {/* @all+ — pop rounds picker */}
            <div
              data-hl={hlAllPlus ? 'true' : undefined}
              style={hlAllPlus ? itemHighlightStyle : itemStyle}
              onClick={() => { setConfigRoundsPicker(true); setConfigRoundsHighlight(0); setConfigModeOverride('config'); setConfigPickerFocus('rounds'); }}
              onMouseEnter={() => setHighlightIdx(1)}
            >
              <span style={{ fontWeight: 600, color: '#94a3b8' }}>⚙ {t('p2p.all_plus')}</span>
              <span style={{ ...dimStyle, color: '#94a3b8' }}>{t('p2p.settings_mode')}: {t('p2p.mode_config')}</span>
            </div>
            {/* Participant preview under @all+ */}
            {hlAllPlus && (
              <div style={{ paddingLeft: 20, paddingBottom: 4 }}>
                <div style={{ fontSize: 11, color: '#64748b', lineHeight: '1.6' }}>
                  {t('p2p.settings_mode')}: {t('p2p.mode_config')} · {t('p2p.settings_rounds')}
                </div>
                {configParticipants.map(([session, entry]) => {
                  const shortName = resolveDisplayName(session);
                  const aType = resolveAgentType(session);
                  return (
                    <div key={session} style={{ fontSize: 11, color: '#64748b', lineHeight: '1.6' }}>
                      {shortName}{aType ? ` (${aType})` : ''} · {entry.mode}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}

      {/* Regular @all */}
      {showAll && (
        <div
          data-hl={highlightIdx === regularAllOffset ? 'true' : undefined}
          style={highlightIdx === regularAllOffset ? itemHighlightStyle : itemStyle}
          onClick={() => { setModeAgent('__all__'); setModeHighlight(0); }}
          onMouseEnter={() => setHighlightIdx(regularAllOffset)}
        >
          <span style={{ fontWeight: 500, color: '#22c55e' }}>⚡ {t('p2p.picker.all_agents', 'All Agents')}</span>
          <span style={dimStyle}>{nonSelfAgents.length} {t('p2p.picker.sessions', 'sessions')}</span>
        </div>
      )}

      {/* Individual agents — always show all, unfiltered */}
      {agents.map((a, idx) => {
        const adjustedIdx = agentsOffset + idx;
        const hl = adjustedIdx === highlightIdx;
        const cfgMode = cfgMap ? cfgMap.get(a.session) : undefined;
        return (
          <div
            key={a.session}
            data-hl={hl ? 'true' : undefined}
            style={hl ? itemHighlightStyle : itemStyle}
            onClick={() => { setModeAgent(a.session); setModeHighlight(0); }}
            onMouseEnter={() => setHighlightIdx(adjustedIdx)}
          >
            <span style={{ fontWeight: 500 }}>{a.shortName}</span>
            <span style={dimStyle}>{a.agentType}{cfgMode?.enabled ? ` · ${cfgMode.mode}` : ''}</span>
            {a.isSelf && <span style={{ color: '#60a5fa', fontSize: 10, marginLeft: 4 }}>({t('p2p.picker.you')})</span>}
            {a.busy && <span style={busyDotStyle} title={t('p2p.picker.busy')} />}
          </div>
        );
      })}
    </div>
  );
}
