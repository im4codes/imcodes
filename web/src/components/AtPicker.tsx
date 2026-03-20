/**
 * AtPicker — dropdown autocomplete for @-mentions.
 * Two groups: Files (searched via WS file.search) and Agents (filtered from sessions).
 * Supports keyboard navigation and mode sub-picker for agents.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ServerMessage } from '../ws-client.js';

interface SessionEntry {
  name: string;
  agentType: string;
  state: string;
  label?: string | null;
  isSelf?: boolean;
}

interface AtPickerProps {
  query: string;
  sessions: SessionEntry[];
  mainSession: string;
  wsClient: any;
  projectDir?: string;
  onSelectFile: (path: string) => void;
  onSelectAgent: (session: string, mode: string) => void;
  onClose: () => void;
  visible: boolean;
}

type PickerItem =
  | { kind: 'file'; path: string; basename: string; dir: string }
  | { kind: 'agent'; session: string; shortName: string; agentType: string; busy: boolean; isSelf: boolean };

const MODES = ['audit', 'review', 'brainstorm', 'discuss'] as const;

const DEBOUNCE_MS = 200;

// ── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: Record<string, string | number> = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  maxHeight: 256,
  overflowY: 'auto',
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  boxShadow: '0 -4px 12px rgba(0,0,0,0.4)',
  zIndex: 50,
  padding: '4px 0',
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

export function AtPicker({
  query,
  sessions,
  wsClient,
  projectDir,
  onSelectFile,
  onSelectAgent,
  onClose,
  visible,
}: AtPickerProps) {
  const { t } = useTranslation();
  const [fileResults, setFileResults] = useState<Array<{ path: string; basename: string; dir: string }>>([]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [modeAgent, setModeAgent] = useState<string | null>(null);
  const [modeHighlight, setModeHighlight] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Show all sessions as agents — label or short name, mark self
  const agents = useMemo(() => {
    return sessions
      .map((s) => {
        const parts = s.name.split('_');
        const shortName = s.label || parts[parts.length - 1] || s.name;
        return {
          kind: 'agent' as const,
          session: s.name,
          shortName,
          agentType: s.agentType,
          busy: s.state !== 'idle',
          isSelf: !!s.isSelf,
        };
      })
      .filter((a) => !query || a.shortName.toLowerCase().includes(query.toLowerCase()) || a.session.toLowerCase().includes(query.toLowerCase()));
  }, [sessions, query]);

  // Build flat item list for keyboard nav
  const items = useMemo<PickerItem[]>(() => {
    const list: PickerItem[] = [];
    for (const f of fileResults) list.push({ kind: 'file', ...f });
    for (const a of agents) list.push(a);
    return list;
  }, [fileResults, agents]);

  // Debounced file search
  useEffect(() => {
    if (!visible || !query || query.length < 1) {
      setFileResults([]);
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
  }, [query, visible, wsClient]);

  // Listen for file search responses
  useEffect(() => {
    if (!wsClient) return;
    const handler = (msg: ServerMessage) => {
      if (msg.type === 'file.search_response' && msg.requestId === requestIdRef.current) {
        const results = (msg.results ?? []).slice(0, 10).map((p: string) => {
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

  // Reset highlight when items change
  useEffect(() => {
    setHighlightIdx(0);
    setModeAgent(null);
  }, [query, visible]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      // In mode sub-picker
      if (modeAgent !== null) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setModeAgent(null);
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          setModeHighlight((h) => (h - 1 + MODES.length) % MODES.length);
          return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          setModeHighlight((h) => (h + 1) % MODES.length);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelectAgent(modeAgent, MODES[modeHighlight]);
          setModeAgent(null);
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((h) => (h - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((h) => (h + 1) % items.length);
        return;
      }
      if (e.key === 'Enter' && items.length > 0) {
        e.preventDefault();
        const item = items[highlightIdx];
        if (!item) return;
        if (item.kind === 'file') {
          onSelectFile(item.path);
        } else {
          setModeAgent(item.session);
          setModeHighlight(0);
        }
      }
    },
    [visible, items, highlightIdx, modeAgent, modeHighlight, onClose, onSelectFile, onSelectAgent],
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

  // Mode sub-picker overlay
  if (modeAgent !== null) {
    const agentItem = agents.find((a) => a.session === modeAgent);
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={groupLabelStyle}>
          {agentItem ? `${agentItem.shortName} - ` : ''}Select Mode
        </div>
        <div style={modeContainerStyle}>
          {MODES.map((mode, idx) => (
            <button
              key={mode}
              type="button"
              style={idx === modeHighlight ? modeBtnHoverStyle : modeBtnStyle}
              onClick={() => {
                onSelectAgent(modeAgent, mode);
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

  if (items.length === 0 && query) return (
    <div ref={containerRef} style={containerStyle}>
      <div style={{ ...itemStyle, color: '#64748b', justifyContent: 'center' }}>No results</div>
    </div>
  );
  if (items.length === 0) return null;

  let flatIdx = 0;

  return (
    <div ref={containerRef} style={containerStyle}>
      {/* File results group */}
      {fileResults.length > 0 && (
        <>
          <div style={groupLabelStyle}>Files</div>
          {fileResults.map((f) => {
            const idx = flatIdx++;
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
        </>
      )}

      {/* Agents group */}
      {agents.length > 0 && (
        <>
          <div style={groupLabelStyle}>Agents</div>
          {agents.map((a) => {
            const idx = flatIdx++;
            const hl = idx === highlightIdx;
            return (
              <div
                key={a.session}
                data-hl={hl ? 'true' : undefined}
                style={hl ? itemHighlightStyle : itemStyle}
                onClick={() => {
                  setModeAgent(a.session);
                  setModeHighlight(0);
                }}
                onMouseEnter={() => setHighlightIdx(idx)}
              >
                <span style={{ fontWeight: 500 }}>{a.shortName}</span>
                <span style={dimStyle}>{a.agentType}</span>
                {a.isSelf && <span style={{ ...dimStyle, color: '#60a5fa', fontSize: 10, marginLeft: 4 }}>(You)</span>}
                {a.busy && <span style={busyDotStyle} title="Busy" />}
              </div>
            );
          })}
        </>
      )}

      {/* Empty state handled above */}
    </div>
  );
}
