/**
 * SubSessionBar — bottom panel showing sub-session preview cards.
 * Cards show live chat/terminal previews. Single or double row layout.
 */
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { SubSessionCard } from './SubSessionCard.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import { isVisuallyBusy } from '../thinking-utils.js';
import { reorderSubSessions } from '../api.js';
import { formatLabel } from '../format-label.js';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { P2pProgressCard } from './P2pProgressCard.js';
import type { P2pProgressDiscussion } from './P2pProgressCard.js';

interface DaemonStats {
  daemonVersion?: string | null;
  cpu: number;
  memUsed: number;
  memTotal: number;
  load1: number;
  load5: number;
  load15: number;
  uptime: number;
}

type DiscussionSummary = P2pProgressDiscussion & {
  currentSpeaker?: string;
  filePath?: string;
  fileId?: string;
};

interface Props {
  subSessions: SubSession[];
  openIds: Set<string>;
  idleFlashTokens?: Map<string, number>;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onRestart: (id: string) => void;
  onNew: () => void;
  onViewDiscussions?: () => void;
  onViewDiscussion?: (fileId: string) => void;
  onViewRepo?: () => void;
  onViewCron?: () => void;

  discussions?: DiscussionSummary[];
  onStopDiscussion?: (id: string) => void;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  serverId?: string;
  /** Per-sub-session usage data (ctx tokens, model) collected from timeline events. */
  subUsages?: Map<string, { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string }>;
  /** ID of the currently focused (topmost) sub-session window. */
  focusedSubId?: string | null;
  /** Quick data for compact SessionControls in cards. */
  quickData?: import('./QuickInputPanel.js').UseQuickDataResult;
  /** All sessions — for @ picker. */
  sessions?: import('../types.js').SessionInfo[];
  /** All sub-sessions slim — for @ picker. */
  allSubSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  /** Set of sub-session labels participating in active P2P discussions. */
  p2pSessionLabels?: Set<string>;
}

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const TYPE_ABBR: Record<string, string> = {
  'claude-code': 'cc',
  'codex': 'cx',
  'opencode': 'oc',
  'openclaw': 'oc',
  'qwen': 'qw',
  'gemini': 'gm',
  'shell': 'sh',
  'script': 'sc',
};

type Layout = 'single' | 'double';

interface CardSize { w: number; h: number }

const DEFAULT_SIZE: CardSize = { w: 350, h: 250 };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v) return JSON.parse(v) as T;
  } catch { /* ignore */ }
  return fallback;
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function SubSessionBar({ subSessions, openIds, idleFlashTokens, onOpen, onClose, onRestart, onNew, onViewDiscussions, onViewDiscussion, onViewRepo, onViewCron, discussions = [], onStopDiscussion, ws, connected, onDiff, onHistory, serverId, subUsages, focusedSubId, quickData, sessions, allSubSessions, p2pSessionLabels }: Props) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<Layout>(() => load('rcc_subcard_layout', 'single'));
  const [collapsed, setCollapsed] = useState(isMobile);
  const [p2pHidden, setP2pHidden] = useState(false);
  const [showSizePanel, setShowSizePanel] = useState(false);
  const [cardSize, setCardSize] = useState<CardSize>(() => load('rcc_subcard_size', DEFAULT_SIZE));
  const [draftW, setDraftW] = useState(String(cardSize.w));
  const [draftH, setDraftH] = useState(String(cardSize.h));
  const [stats, setStats] = useState<DaemonStats | null>(null);
  // DB sort_order is the authority — subSessions arrive pre-sorted from server.
  // Local dragOrder only tracks in-session drag reorder (synced back to DB via reorderSubSessions).
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const reorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Touch-drag state for collapsed bar (persists across re-renders)
  const touchDragRef = useRef<{ id: string | null; active: boolean; timer: ReturnType<typeof setTimeout> | null }>({ id: null, active: false, timer: null });
  const collapsedBarRef = useRef<HTMLDivElement | null>(null);

  // Reset drag order only when session membership changes (add/remove),
  // NOT on state updates (idle/running) which just change the array reference.
  const sessionIdList = subSessions.map(s => s.id).join(',');
  useEffect(() => { setDragOrder(null); }, [sessionIdList]);

  const syncOrderToServer = (ids: string[]) => {
    if (reorderTimerRef.current) clearTimeout(reorderTimerRef.current);
    reorderTimerRef.current = setTimeout(() => {
      if (serverId) reorderSubSessions(serverId, ids).catch(() => {});
    }, 150);
  };

  // Use drag order if active, otherwise DB order (subSessions is pre-sorted)
  const orderedSessions = useMemo(() => {
    if (!dragOrder) return subSessions;
    const sessionMap = new Map(subSessions.map((s) => [s.id, s]));
    return dragOrder.map((id) => sessionMap.get(id)).filter(Boolean) as SubSession[];
  }, [subSessions, dragOrder]);
  const orderedSessionsRef = useRef(orderedSessions);
  orderedSessionsRef.current = orderedSessions;
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;

  // Touch-based reorder for collapsed bar — must use addEventListener({ passive: false })
  // so touchmove can preventDefault (passive listeners can't).
  useEffect(() => {
    const el = collapsedBarRef.current;
    if (!el) return;
    const td = touchDragRef.current;

    const findBtnId = (target: EventTarget | null): string | null => {
      let node = target as HTMLElement | null;
      while (node && node !== el) { if (node.dataset.subId) return node.dataset.subId; node = node.parentElement; }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      const id = findBtnId(e.target);
      if (!id) return;
      td.timer = setTimeout(() => {
        td.id = id;
        td.active = true;
        setDragOrder(orderedSessionsRef.current.map((s) => s.id));
        const btn = el.querySelector(`[data-sub-id="${id}"]`) as HTMLElement | null;
        if (btn) { btn.style.transform = 'scale(1.18)'; btn.style.boxShadow = '0 0 10px rgba(251,191,36,0.6)'; btn.style.borderColor = '#f59e0b'; btn.style.zIndex = '2'; }
        el.style.overflowX = 'hidden';
        window.getSelection()?.removeAllRanges();
      }, 400);
    };

    const onMove = (e: TouchEvent) => {
      if (td.timer && !td.active) { clearTimeout(td.timer); td.timer = null; return; }
      if (!td.active || !td.id) return;
      e.preventDefault(); // works because { passive: false }
      const touch = e.touches[0];
      const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
      const overId = findBtnId(targetEl);
      if (overId && overId !== td.id) {
        const draggedId = td.id;
        setDragOrder((prev) => {
          const ids = prev ?? orderedSessionsRef.current.map((s) => s.id);
          const from = ids.indexOf(draggedId);
          const to = ids.indexOf(overId);
          if (from === -1 || to === -1) return prev;
          const next = [...ids];
          next.splice(from, 1);
          next.splice(to, 0, draggedId);
          return next;
        });
      }
    };

    const onEnd = () => {
      if (td.timer) { clearTimeout(td.timer); td.timer = null; }
      if (td.active && td.id) {
        const btn = el.querySelector(`[data-sub-id="${td.id}"]`) as HTMLElement | null;
        if (btn) { btn.style.transform = ''; btn.style.boxShadow = ''; btn.style.borderColor = ''; btn.style.zIndex = ''; }
        el.style.overflowX = '';
        if (dragOrderRef.current) syncOrderToServer(dragOrderRef.current);
      }
      td.id = null;
      td.active = false;
    };

    const onContext = (e: Event) => { if (td.active) e.preventDefault(); };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('contextmenu', onContext);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('contextmenu', onContext);
    };
  }, [collapsed, syncOrderToServer]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type === 'daemon.stats') {
        setStats({ daemonVersion: msg.daemonVersion, cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal, load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime });
      }
    });
  }, [ws]);

  const toggleLayout = () => {
    const next: Layout = layout === 'single' ? 'double' : 'single';
    setLayout(next);
    save('rcc_subcard_layout', next);
  };

  const applySize = () => {
    const w = Math.max(200, Math.min(800, parseInt(draftW) || DEFAULT_SIZE.w));
    const h = Math.max(150, Math.min(600, parseInt(draftH) || DEFAULT_SIZE.h));
    const next = { w, h };
    setCardSize(next);
    save('rcc_subcard_size', next);
    setDraftW(String(w));
    setDraftH(String(h));
    setShowSizePanel(false);
  };

  const resetSize = () => {
    setCardSize(DEFAULT_SIZE);
    save('rcc_subcard_size', DEFAULT_SIZE);
    setDraftW(String(DEFAULT_SIZE.w));
    setDraftH(String(DEFAULT_SIZE.h));
    setShowSizePanel(false);
  };

  return (
    <div class="subcard-bar">
      {/* Toolbar */}
      <div class="subcard-toolbar">
        <button class="subcard-toolbar-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('subsessionBar.show') : t('subsessionBar.hide')}>
          {collapsed ? '▲' : '▼'}
        </button>
        {!collapsed && (
          <>
            <button class="subcard-toolbar-btn" onClick={toggleLayout} title={layout === 'single' ? t('subsessionBar.layout_double') : t('subsessionBar.layout_single')}>
              {layout === 'single' ? '⊞' : '☰'}
            </button>
            <button
              class={`subcard-toolbar-btn${showSizePanel ? ' subcard-toolbar-btn-active' : ''}`}
              onClick={() => { setShowSizePanel(!showSizePanel); setDraftW(String(cardSize.w)); setDraftH(String(cardSize.h)); }}
              title={t('subsessionBar.card_size')}
            >
              ⚙
            </button>
            <span class="subcard-toolbar-label">{t('subsessionBar.subs_count', { count: subSessions.length })}</span>
            {/* Desktop: full stats in expanded toolbar */}
            {stats && (
              <span class="daemon-stats-inline" title={`${stats.daemonVersion ? `Daemon ${stats.daemonVersion} | ` : ''}Load: ${stats.load1} / ${stats.load5} / ${stats.load15} | Uptime: ${formatUptime(stats.uptime)}`}>
                {stats.daemonVersion && (
                  <>
                    <span style={{ color: '#94a3b8' }}>v{stats.daemonVersion}</span>
                    <span style={{ color: '#94a3b8' }}> · </span>
                  </>
                )}
                <span style={{ color: stats.cpu > 80 ? '#f87171' : stats.cpu > 50 ? '#fbbf24' : '#4ade80' }}>
                  CPU {stats.cpu}%
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#60a5fa' }}>
                  Mem {(() => { const gb = stats.memUsed / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(stats.memUsed / (1024 ** 2)).toFixed(0)}M`; })()}
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#a78bfa' }}>
                  Load {stats.load1}
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#94a3b8' }}>
                  {formatUptime(stats.uptime)}
                </span>
              </span>
            )}
          </>
        )}
        {/* Mobile: compact stats in collapsed toolbar */}
        {collapsed && stats && (() => {
          const totalGb = stats.memTotal / (1024 ** 3);
          const useG = totalGb >= 1;
          const div = useG ? 1024 ** 3 : 1024 ** 2;
          const unit = useG ? 'G' : 'M';
          const memUsed = (stats.memUsed / div).toFixed(1);
          const memTotal = useG ? totalGb.toFixed(1) : (stats.memTotal / div).toFixed(0);
          const ei = { fontSize: '0.65em', verticalAlign: 'middle' } as const;
          return (
            <span class="daemon-stats-inline" title={`${stats.daemonVersion ? `v${stats.daemonVersion} | ` : ''}CPU ${stats.cpu}% | Mem ${memUsed}/${memTotal}${unit} | Load: ${stats.load1} / ${stats.load5} / ${stats.load15} | Uptime: ${formatUptime(stats.uptime)}`} style={{ whiteSpace: 'nowrap', fontSize: 10 }}>
              {stats.daemonVersion && <span style={{ color: '#94a3b8' }}>v{stats.daemonVersion} </span>}
              <span style={{ color: stats.cpu > 80 ? '#f87171' : stats.cpu > 50 ? '#fbbf24' : '#4ade80' }}><span style={ei}>⚙️</span>{stats.cpu}%</span>
              {' '}
              <span style={{ color: '#60a5fa' }}><span style={ei}>🧠</span>{memUsed}/{memTotal}{unit}</span>
              {' '}
              <span style={{ color: '#a78bfa' }}>≡{Number(stats.load1).toFixed(1)}</span>
            </span>
          );
        })()}
        <button class="subcard-toolbar-add" data-onboarding="new-sub-session" onClick={onNew} title={t('subsessionBar.new_sub_session')}>+</button>
        {onViewDiscussions && (
          <button class="subcard-toolbar-btn" data-onboarding="discussion-history" onClick={onViewDiscussions} title={t('subsessionBar.p2p_discussions')} style={{ marginLeft: 4, fontSize: 11 }}>
            📋
          </button>
        )}
        {onViewRepo && (
          <button
            class="subcard-toolbar-btn"
            data-onboarding="repo-page"
            onClick={() => onViewRepo()}
            title={t('subsessionBar.repository')}
            style={{
              marginLeft: 4,
              fontSize: 11,
            }}
          >
            🔀
          </button>
        )}
        {onViewCron && (
          <button class="subcard-toolbar-btn" data-onboarding="cron-manager" onClick={onViewCron} title={t('subsessionBar.scheduled_tasks')} style={{ marginLeft: 4, fontSize: 11 }}>
            ⏰
          </button>
        )}
      </div>

      {/* Size settings panel */}
      {!collapsed && showSizePanel && (
        <div class="subcard-size-panel">
          <span class="subcard-size-label">{t('subsessionBar.card_size')}</span>
          <label class="subcard-size-field">
            {t('subsessionBar.width_short')}
            <input
              type="number"
              class="subcard-size-input"
              value={draftW}
              min={200} max={800}
              onInput={(e) => setDraftW((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <label class="subcard-size-field">
            {t('subsessionBar.height_short')}
            <input
              type="number"
              class="subcard-size-input"
              value={draftH}
              min={150} max={600}
              onInput={(e) => setDraftH((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <button class="subcard-toolbar-btn" onClick={applySize}>{t('subsessionBar.apply')}</button>
          <button class="subcard-toolbar-btn" onClick={resetSize}>{t('subsessionBar.reset')}</button>
        </div>
      )}

      {/* Empty state: no sub-sessions and expanded */}
      {!collapsed && subSessions.length === 0 && discussions.length === 0 && (
        <div class="subcard-empty-state">
          {t('subsessionBar.empty_prefix')} <strong>+</strong> {t('subsessionBar.empty_suffix')}
        </div>
      )}

      {/* Discussions panel — above sub-session buttons */}
      {discussions.length > 0 && (
        <div class={`discussion-panel${isMobile ? ' discussion-panel-mobile' : ''}`}>
          {discussions.map((d) => (
            <P2pProgressCard
              key={d.id}
              discussion={d}
              compact={!isMobile}
              mobile={isMobile}
              hidden={isMobile && p2pHidden}
              onToggleHide={isMobile ? () => setP2pHidden((v) => !v) : undefined}
              onStopDiscussion={onStopDiscussion}
              onClick={d.fileId && onViewDiscussion ? () => onViewDiscussion(d.fileId!) : undefined}
            />
          ))}
        </div>
      )}

      {/* Collapsed: compact buttons (all platforms) — long-press to reorder */}
      {collapsed && subSessions.length > 0 && (
        <div class="subsession-bar" style={{ borderTop: 'none' }} ref={collapsedBarRef}>
          {orderedSessions.map((sub) => {
            const agentTag = sub.type === 'shell' ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
            const label = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;
            const abbr = TYPE_ABBR[sub.type] ?? agentTag.slice(0, 2);
            const isOpen = openIds.has(sub.id);
            const usage = subUsages?.get(`deck_sub_${sub.id}`);
            const model = usage ? shortModelLabel(usage.model) : null;
            // Compute ctx percentage for mini bar
            let ctxPct = 0;
            if (usage) {
              const ctx = resolveContextWindow(usage.contextWindow, usage.model);
              ctxPct = Math.min(100, (usage.inputTokens + usage.cacheTokens) / ctx * 100);
            }
            return (
              <button
                key={sub.id}
                data-sub-id={sub.id}
                class={`subsession-card${isOpen ? ' open' : ''} mobile${isVisuallyBusy(sub.state, false) ? ' subcard-running-pulse' : ''}`}
                onClick={() => onOpen(sub.id)}
                title={label + (model ? ` · ${model}` : '') + (ctxPct > 0 ? ` · ctx ${ctxPct.toFixed(0)}%` : '')}
              >
                <span class="subsession-card-icon">{abbr}</span>
                <span class="subsession-card-label">{sub.label ? formatLabel(sub.label).slice(0, 12) : agentTag.slice(0, 6)}</span>
                {p2pSessionLabels?.has(sub.sessionName) && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
                {model && <span class="subsession-card-model">{model}</span>}
                {sub.ccPresetId && <span class="subsession-card-custom-api" title={`Custom API: ${sub.ccPresetId}`}>◉</span>}
                {sub.state === 'starting' && <span class="subsession-card-badge">…</span>}
                {ctxPct > 0 && (
                  <span class="subsession-card-ctx" style={{ width: '100%' }}>
                    <span class="subsession-card-ctx-fill" style={{ width: `${ctxPct}%` }} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded: preview cards (all platforms) */}
      {!collapsed && orderedSessions.length > 0 && (
        <div
          class={`subcard-scroll ${layout === 'double' ? 'subcard-double' : 'subcard-single'}`}
          style={layout === 'double' ? { gridAutoColumns: 'max-content' } : undefined}
        >
          {orderedSessions.map((sub) => (
            <div
              key={sub.id}
              class="subcard-drag-wrap"
              draggable
              onDragStart={(e) => {
                dragIdRef.current = sub.id;
                e.dataTransfer!.effectAllowed = 'move';
                (e.currentTarget as HTMLElement).style.opacity = '0.5';
                // Initialize dragOrder from current displayed order
                if (!dragOrder) setDragOrder(orderedSessions.map((s) => s.id));
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer!.dropEffect = 'move';
                if (!dragIdRef.current || dragIdRef.current === sub.id) return;
                setDragOrder((prev) => {
                  const ids = prev ?? orderedSessions.map((s) => s.id);
                  const from = ids.indexOf(dragIdRef.current!);
                  const to = ids.indexOf(sub.id);
                  if (from === -1 || to === -1) return prev;
                  const next = [...ids];
                  next.splice(from, 1);
                  next.splice(to, 0, dragIdRef.current!);
                  return next;
                });
              }}
              onDragEnd={(e) => {
                dragIdRef.current = null;
                (e.currentTarget as HTMLElement).style.opacity = '';
                if (dragOrder) syncOrderToServer(dragOrder);
              }}
            >
              <SubSessionCard
                sub={sub}
                ws={ws}
                connected={connected}
                isOpen={openIds.has(sub.id)}
                isFocused={focusedSubId === sub.id}
                idleFlashToken={idleFlashTokens?.get(sub.sessionName) ?? 0}
                onOpen={() => onOpen(sub.id)}
                onClose={() => onClose(sub.id)}
                onRestart={() => onRestart(sub.id)}
                onDiff={onDiff}
                onHistory={onHistory}
                cardW={cardSize.w}
                cardH={cardSize.h}
                quickData={quickData}
                sessions={sessions}
                subSessions={allSubSessions}
                serverId={serverId}
                inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
