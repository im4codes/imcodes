/**
 * AtPicker — dropdown autocomplete for @-mentions.
 * Two-step: first pick category (Files / Agents), then search/select within that category.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ServerMessage } from '../ws-client.js';
import {
  COMBO_PRESETS,
  isComboMode,
  parseModePipeline,
  type P2pSavedConfig,
} from '@shared/p2p-modes.js';
import { useP2pCustomCombos } from './p2p-combos.js';
import { isImeComposingKeyEvent } from '../ime-keyboard.js';

interface SessionEntry {
  name: string;
  agentType: string;
  state: string;
  role?: string | null;
  label?: string | null;
  parentSession?: string | null;
  isSelf?: boolean;
}

type PickerAgent = {
  session: string;
  shortName: string;
  agentType: string;
  busy: boolean;
  isSelf: boolean;
  disabled?: boolean;
};

interface AtPickerProps {
  query: string;
  sessions: SessionEntry[];
  rootSession: string;
  wsClient: any;
  projectDir?: string;
  onSelectFile: (path: string) => void;
  onSelectAgent: (session: string, mode: string) => void;
  onSelectDelegateAgent: (session: string) => void;
  onSelectAllConfig?: (config: P2pSavedConfig, rounds: number, modeOverride: string) => void;
  /** Launch a Team discussion directly with the chosen combo/mode and round count. */
  onLaunchTeam?: (modeKey: string, rounds: number) => void;
  p2pConfig?: P2pSavedConfig | null;
  onClose: () => void;
  onStageChange?: (stage: 'choose' | 'files' | 'agents' | 'mode' | 'team') => void;
  visible: boolean;
}

type Category = 'choose' | 'files' | 'agents' | 'team';

const DEBOUNCE_MS = 200;

function consumeEscapeKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
}

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
  onSelectDelegateAgent,
  onLaunchTeam,
  onClose,
  onStageChange,
  visible,
}: AtPickerProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>('choose');
  const [fileResults, setFileResults] = useState<Array<{ path: string; basename: string; dir: string }>>([]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [teamRoundsIdx, setTeamRoundsIdx] = useState(0);
  const CONFIG_ROUNDS_OPTIONS = [1, 2, 3, 5] as const;
  const { allCombos } = useP2pCustomCombos();
  // Team stage lists combos only — preset combos + custom combos. Single modes
  // are pointless for launching a Team discussion flow.
  const teamComboOptions = useMemo(
    () => [...COMBO_PRESETS.map((c) => c.key), ...allCombos.custom],
    [allCombos],
  );
  const teamOptionLabel = useCallback(
    (key: string) => (isComboMode(key)
      ? parseModePipeline(key).map((m) => t(`p2p.mode_${m}`, m)).join(' › ')
      : t(`p2p.mode_${key}`, key)),
    [t],
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const delegateAgents = useMemo<PickerAgent[]>(() => {
    const seen = new Map<string, SessionEntry>();
    for (const s of sessions) {
      if (s.agentType === 'shell' || s.agentType === 'script') continue;
      if (rootSession && s.name !== rootSession && s.parentSession !== rootSession) continue;
      const existing = seen.get(s.name);
      if (!existing) {
        seen.set(s.name, s);
      } else if (s.isSelf && !existing.isSelf) {
        seen.set(s.name, s);
      }
    }
    return [...seen.values()]
      .map((s) => {
        const shortName = s.label || s.name.split('_').pop() || s.name;
        const isSelf = !!s.isSelf;
        return {
          session: s.name,
          shortName,
          agentType: s.agentType,
          busy: s.state !== 'idle',
          isSelf,
          disabled: isSelf,
        };
      })
      .filter((a) => !query || a.shortName.toLowerCase().includes(query.toLowerCase()) || a.session.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
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
  }, [query, visible, category]);

  // Reset to category chooser when picker opens
  useEffect(() => {
    if (visible) {
      setCategory('choose');
      setFileResults([]);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    onStageChange?.(category);
  }, [visible, category, onStageChange]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;
      if (isImeComposingKeyEvent(e)) return;

      // Category chooser
      if (category === 'choose') {
        if (e.key === 'Escape') { consumeEscapeKey(e); onClose(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx((h) => (h + 1) % 3); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx((h) => (h + 2) % 3); return; }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          if (highlightIdx === 1) { setCategory('team'); setHighlightIdx(0); setTeamRoundsIdx(0); }
          else { setCategory(highlightIdx === 0 ? 'files' : 'agents'); setHighlightIdx(0); }
          return;
        }
        return;
      }

      // Team discussion: ↑↓ pick combo, ←→ pick rounds, Enter launches directly.
      if (category === 'team') {
        const count = teamComboOptions.length;
        if (e.key === 'Escape') { consumeEscapeKey(e); onClose(); return; }
        if (e.key === 'Backspace') { e.preventDefault(); setCategory('choose'); setHighlightIdx(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx((h) => Math.max(0, h - 1)); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx((h) => Math.min(Math.max(0, count - 1), h + 1)); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); setTeamRoundsIdx((i) => Math.max(0, i - 1)); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); setTeamRoundsIdx((i) => Math.min(CONFIG_ROUNDS_OPTIONS.length - 1, i + 1)); return; }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const key = teamComboOptions[highlightIdx];
          if (key) onLaunchTeam?.(key, CONFIG_ROUNDS_OPTIONS[teamRoundsIdx]);
          return;
        }
        return;
      }

      const count = category === 'files' ? fileResults.length : delegateAgents.length;
      if (e.key === 'Escape') {
        consumeEscapeKey(e);
        setCategory('choose');
        setHighlightIdx(0);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (count > 0) setHighlightIdx((h) => (h - 1 + count) % count);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (count > 0) setHighlightIdx((h) => (h + 1) % count);
        return;
      }
      if (e.key === 'Enter' && count > 0) {
        e.preventDefault(); e.stopPropagation();
        if (category === 'files') {
          const f = fileResults[highlightIdx];
          if (f) onSelectFile(f.path);
        } else {
          const a = delegateAgents[highlightIdx];
          if (a && !a.disabled) onSelectDelegateAgent(a.session);
        }
      }
    },
    [visible, category, highlightIdx, fileResults, delegateAgents, teamRoundsIdx, teamComboOptions, onClose, onSelectFile, onSelectDelegateAgent, onLaunchTeam],
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
          onClick={() => { setCategory('team'); setHighlightIdx(0); setTeamRoundsIdx(0); }}
          onMouseEnter={() => setHighlightIdx(1)}
        >
          <span style={{ fontSize: 16 }}>👥</span>
          <span style={{ fontWeight: 500 }}>{t('p2p.picker.team')}</span>
          <span style={dimStyle}>{t('p2p.picker.team_desc')}</span>
        </div>
        <div
          data-hl={highlightIdx === 2 ? 'true' : undefined}
          style={highlightIdx === 2 ? categoryHighlightStyle : categoryStyle}
          onClick={() => { setCategory('agents'); setHighlightIdx(0); }}
          onMouseEnter={() => setHighlightIdx(2)}
        >
          <span style={{ fontSize: 16 }}>🤖</span>
          <span style={{ fontWeight: 500 }}>{t('delegation.picker.agents')}</span>
          <span style={dimStyle}>{t('delegation.picker.delegate_to_agent')}</span>
        </div>
      </div>
    );
  }

  // ── Team discussion: combo rows only (↑↓) + rounds (←→) ──
  if (category === 'team') {
    const teamRounds = CONFIG_ROUNDS_OPTIONS[teamRoundsIdx];
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={backBtnStyle} onClick={() => { setCategory('choose'); setHighlightIdx(1); }}>← {t('p2p.picker.back')}</div>
        <div style={groupLabelStyle}>
          {t('p2p.picker.team')} · {t('p2p.settings_rounds')}: ◂ {teamRounds} ▸
        </div>
        {teamComboOptions.map((key, idx) => {
          const adjustedIdx = idx;
          const hl = adjustedIdx === highlightIdx;
          return (
            <div
              key={key}
              data-hl={hl ? 'true' : undefined}
              style={hl ? itemHighlightStyle : itemStyle}
              onClick={() => onLaunchTeam?.(key, teamRounds)}
              onMouseEnter={() => setHighlightIdx(adjustedIdx)}
            >
              <span style={{ fontWeight: 500 }}>{teamOptionLabel(key)}</span>
            </div>
          );
        })}
        <div style={{ ...dimStyle, padding: '4px 12px 6px' }}>↑↓ · ◂▸ {t('p2p.settings_rounds')} · ⏎</div>
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
  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={backBtnStyle} onClick={() => { setCategory('choose'); setHighlightIdx(0); }}>← {t('p2p.picker.back')}</div>
      <div style={groupLabelStyle}>{t('delegation.picker.agents')}</div>
      {delegateAgents.length === 0 && (
        <div style={{ ...itemStyle, color: '#64748b', justifyContent: 'center' }}>{t('p2p.picker.no_agents_available')}</div>
      )}

      {/* Individual delegation agents only. */}
      {delegateAgents.map((a, idx) => {
        const hl = idx === highlightIdx;
        const disabled = !!a.disabled;
        return (
          <div
            key={a.session}
            data-hl={hl ? 'true' : undefined}
            aria-disabled={disabled ? 'true' : undefined}
            style={{
              ...(hl ? itemHighlightStyle : itemStyle),
              ...(disabled ? { color: '#64748b', cursor: 'not-allowed', opacity: 0.65 } : {}),
            }}
            onClick={() => {
              if (!disabled) onSelectDelegateAgent(a.session);
            }}
            onMouseEnter={() => setHighlightIdx(idx)}
          >
            <span style={{ fontWeight: 500 }}>{a.shortName}</span>
            <span style={dimStyle}>{a.agentType}</span>
            {a.busy && <span style={busyDotStyle} title={t('p2p.picker.busy')} />}
          </div>
        );
      })}
    </div>
  );
}
