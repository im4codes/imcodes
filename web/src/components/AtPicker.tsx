/**
 * AtPicker — dropdown autocomplete for @-mentions.
 * Two-step: first pick category (Files / Agents), then search/select within that category.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ServerMessage } from '../ws-client.js';

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
  onClose: () => void;
  onStageChange?: (stage: 'choose' | 'files' | 'agents' | 'mode') => void;
  visible: boolean;
}

type Category = 'choose' | 'files' | 'agents';

const MODES = ['audit', 'review', 'brainstorm', 'discuss'] as const;

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

export function AtPicker({
  query,
  sessions,
  rootSession,
  wsClient,
  projectDir,
  onSelectFile,
  onSelectAgent,
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
        const parts = s.name.split('_');
        const shortName = s.label || parts[parts.length - 1] || s.name;
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

      // Mode sub-picker
      if (modeAgent !== null) {
        if (e.key === 'Escape') { e.preventDefault(); setModeAgent(null); return; }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setModeHighlight((h) => (h - 1 + MODES.length) % MODES.length); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setModeHighlight((h) => (h + 1) % MODES.length); return; }
        if (e.key === 'Enter') { e.preventDefault(); onSelectAgent(modeAgent, MODES[modeHighlight]); setModeAgent(null); return; }
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
          e.preventDefault();
          setCategory(highlightIdx === 0 ? 'files' : 'agents');
          setHighlightIdx(0);
          return;
        }
        return;
      }

      // Files or Agents list
      const count = category === 'files' ? fileResults.length : agents.length;
      if (e.key === 'Escape') {
        e.preventDefault();
        setCategory('choose');
        setHighlightIdx(0);
        return;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx((h) => (h - 1 + count) % count); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx((h) => (h + 1) % count); return; }
      if (e.key === 'Enter' && count > 0) {
        e.preventDefault();
        if (category === 'files') {
          const f = fileResults[highlightIdx];
          if (f) onSelectFile(f.path);
        } else {
          const a = agents[highlightIdx];
          if (a) { setModeAgent(a.session); setModeHighlight(0); }
        }
      }
    },
    [visible, category, highlightIdx, fileResults, agents, modeAgent, modeHighlight, onClose, onSelectFile, onSelectAgent],
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
  const nonSelfAgents = agents.filter(a => !a.isSelf);
  const showAll = nonSelfAgents.length > 1;
  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={backBtnStyle} onClick={() => { setCategory('choose'); setHighlightIdx(0); }}>← {t('p2p.picker.back')}</div>
      <div style={groupLabelStyle}>{t('p2p.picker.agents')}</div>
      {agents.length === 0 && (
        <div style={{ ...itemStyle, color: '#64748b', justifyContent: 'center' }}>{t('p2p.picker.no_agents_available')}</div>
      )}
      {showAll && (
        <div
          data-hl={highlightIdx === 0 ? 'true' : undefined}
          style={highlightIdx === 0 ? itemHighlightStyle : itemStyle}
          onClick={() => { setModeAgent('__all__'); setModeHighlight(0); }}
          onMouseEnter={() => setHighlightIdx(0)}
        >
          <span style={{ fontWeight: 500, color: '#22c55e' }}>⚡ {t('p2p.picker.all_agents', 'All Agents')}</span>
          <span style={dimStyle}>{nonSelfAgents.length} {t('p2p.picker.sessions', 'sessions')}</span>
        </div>
      )}
      {agents.map((a, idx) => {
        const adjustedIdx = showAll ? idx + 1 : idx;
        const hl = adjustedIdx === highlightIdx;
        return (
          <div
            key={a.session}
            data-hl={hl ? 'true' : undefined}
            style={hl ? itemHighlightStyle : itemStyle}
            onClick={() => { setModeAgent(a.session); setModeHighlight(0); }}
            onMouseEnter={() => setHighlightIdx(adjustedIdx)}
          >
            <span style={{ fontWeight: 500 }}>{a.shortName}</span>
            <span style={dimStyle}>{a.agentType}</span>
            {a.isSelf && <span style={{ color: '#60a5fa', fontSize: 10, marginLeft: 4 }}>({t('p2p.picker.you')})</span>}
            {a.busy && <span style={busyDotStyle} title={t('p2p.picker.busy')} />}
          </div>
        );
      })}
    </div>
  );
}
