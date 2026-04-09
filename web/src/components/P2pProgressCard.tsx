import { useMemo, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { memo } from 'preact/compat';

export interface P2pProgressNode {
  label: string;
  displayLabel?: string;
  agentType: string;
  ccPreset?: string | null;
  mode?: string;
  phase?: 'initial' | 'hop' | 'summary';
  status: 'done' | 'active' | 'pending' | 'skipped';
}

export interface P2pHopState {
  hopIndex: number;
  roundIndex: number;
  session?: string;
  mode?: string;
  status: 'queued' | 'dispatched' | 'running' | 'completed' | 'timed_out' | 'failed' | 'cancelled';
}

export interface P2pProgressDiscussion {
  id: string;
  topic: string;
  state: string;
  modeKey?: string;
  currentRound: number;
  maxRounds: number;
  completedHops?: number;
  completedRoundHops?: number;
  totalHops?: number;
  activeHop?: number | null;
  activeRoundHop?: number | null;
  activePhase?: 'queued' | 'initial' | 'hop' | 'summary';
  conclusion?: string;
  error?: string;
  nodes?: P2pProgressNode[];
  hopStates?: P2pHopState[];
  /** Epoch ms when the P2P run started */
  startedAt?: number;
  /** Epoch ms when the current hop/phase started (server-provided for accurate elapsed) */
  hopStartedAt?: number;
}

interface Props {
  discussion: P2pProgressDiscussion;
  compact?: boolean;
  /** Ultra-compact mobile mode: single line with active node only + hide button */
  mobile?: boolean;
  hidden?: boolean;
  onToggleHide?: () => void;
  onClick?: () => void;
  onStopDiscussion?: (id: string) => void;
}

interface ActionButtonProps {
  active: boolean;
  compact: boolean;
  onAction: () => void;
}

function statusClassName(status: P2pProgressNode['status']): string {
  return status === 'done'
    ? 'is-done'
    : status === 'active'
      ? 'is-active'
      : status === 'skipped'
        ? 'is-skipped'
        : 'is-pending';
}

function progressStatusClassName(status: P2pProgressNode['status'], animateActive: boolean): string {
  if (status !== 'active') return statusClassName(status);
  return animateActive ? 'is-active' : 'is-active-static';
}

// ── Elapsed timer ──────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function resolveTimerAnchor(startMs: number | undefined, fallbackStart: number, now: number): number {
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return fallbackStart;
  // Remote daemon clock skew can place server timestamps slightly or significantly in the future.
  // In that case, anchor locally so the timer still advances instead of sticking at 00:00.
  return startMs > now ? fallbackStart : startMs;
}

function DiscussionActionButton({ active, compact, onAction }: ActionButtonProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!active || !confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [active, confirming]);

  if (!active) {
    return (
      <button
        class="discussions-progress-stop"
        style={compact ? { padding: '2px 7px', fontSize: '10px' } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
      >
        {t('common.close')}
      </button>
    );
  }

  if (compact && confirming) {
    return (
      <button
        class="discussions-progress-stop"
        style={{ padding: '2px 7px', fontSize: '10px', background: 'rgba(239,68,68,0.3)', borderColor: '#ef4444', color: '#f87171' }}
        onClick={(e) => {
          e.stopPropagation();
          onAction();
          setConfirming(false);
        }}
      >
        {t('p2p.confirm_cancel')}
      </button>
    );
  }

  return (
    <button
      class="discussions-progress-stop"
      style={compact ? { padding: '2px 7px', fontSize: '10px' } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (compact) setConfirming(true);
        else onAction();
      }}
    >
      {t('common.cancel')}
    </button>
  );
}

const ElapsedTimer = memo(function ElapsedTimer({
  timerKey,
  startMs,
  active,
  className,
}: {
  timerKey: string | null;
  startMs?: number;
  active: boolean;
  className: string;
}) {
  const [fallbackStart, setFallbackStart] = useState(Date.now());
  const prevKey = useRef(timerKey);
  useEffect(() => {
    if (timerKey !== prevKey.current) {
      prevKey.current = timerKey;
      setFallbackStart(Date.now());
    }
  }, [timerKey]);
  const now = useNowTicker(active);
  const anchor = resolveTimerAnchor(startMs, fallbackStart, now);
  if (!active) return null;
  const elapsed = formatElapsed(now - anchor);
  return <span class={className}>{elapsed}</span>;
});

const HopElapsedTimer = memo(function HopElapsedTimer({
  hopKey,
  startMs,
  active,
  className,
}: {
  hopKey: string | null;
  startMs?: number;
  active: boolean;
  className: string;
}) {
  const [fallbackStart, setFallbackStart] = useState(Date.now());
  const prevKey = useRef(hopKey);
  useEffect(() => {
    if (hopKey !== prevKey.current) {
      prevKey.current = hopKey;
      setFallbackStart(Date.now());
    }
  }, [hopKey]);
  const now = useNowTicker(active);
  const anchor = resolveTimerAnchor(startMs, fallbackStart, now);
  const elapsed = formatElapsed(now - anchor);
  if (!active) return null;
  return <span class={className}>{elapsed}</span>;
});

export const P2pProgressCard = memo(function P2pProgressCard({
  discussion,
  compact = false,
  mobile = false,
  hidden = false,
  onToggleHide,
  onClick,
  onStopDiscussion,
}: Props) {
  const { t } = useTranslation();
  const nodes = discussion.nodes ?? [];
  const isTerminal = discussion.state === 'done' || discussion.state === 'failed';
  const isRunning = !isTerminal;
  const isActive = !isTerminal;
  const showActionButton = discussion.state === 'failed' || isActive;
  const totalHopsPerRound = discussion.totalHops ?? 0;
  const activeHopNumbers = useMemo(() => {
    if (totalHopsPerRound <= 0) return [];
    return (discussion.hopStates ?? [])
      .filter((hop) =>
        hop.roundIndex === discussion.currentRound &&
        (hop.status === 'running' || hop.status === 'dispatched'),
      )
      .map((hop) => ((hop.hopIndex - 1) % totalHopsPerRound) + 1)
      .filter((hopNum) => hopNum > 0 && hopNum <= totalHopsPerRound)
      .sort((a, b) => a - b);
  }, [discussion.currentRound, discussion.hopStates, totalHopsPerRound]);
  const activeHopCount = useMemo(
    () => activeHopNumbers.length > 0
      ? activeHopNumbers.length
      : nodes.filter((node) => node.phase === 'hop' && node.status === 'active').length,
    [activeHopNumbers, nodes],
  );
  const completedRoundHops = useMemo(() => {
    if (totalHopsPerRound <= 0) return 0;
    if (typeof discussion.completedRoundHops === 'number') {
      return Math.max(0, Math.min(totalHopsPerRound, discussion.completedRoundHops));
    }
    const roundOffset = Math.max(0, discussion.currentRound - 1) * totalHopsPerRound;
    return Math.max(0, Math.min(totalHopsPerRound, (discussion.completedHops ?? 0) - roundOffset));
  }, [discussion.completedHops, discussion.completedRoundHops, discussion.currentRound, totalHopsPerRound]);
  const visibleRoundHop = useMemo(() => {
    if (totalHopsPerRound <= 0) return null;
    if (activeHopNumbers.length > 0) return activeHopNumbers[0];
    if (typeof discussion.activeRoundHop === 'number') return discussion.activeRoundHop;
    if (typeof discussion.activeHop === 'number' && discussion.activeHop > 0) {
      return ((discussion.activeHop - 1) % totalHopsPerRound) + 1;
    }
    return completedRoundHops;
  }, [activeHopNumbers, discussion.activeHop, discussion.activeRoundHop, completedRoundHops, totalHopsPerRound]);
  const activeHopRange = useMemo(() => {
    if (discussion.activePhase !== 'hop' || totalHopsPerRound <= 0 || activeHopCount <= 0) return null;
    if (activeHopNumbers.length > 0) {
      return {
        start: activeHopNumbers[0]!,
        end: activeHopNumbers[activeHopNumbers.length - 1]!,
      };
    }
    const start = typeof discussion.activeRoundHop === 'number' && discussion.activeRoundHop > 0
      ? Math.min(totalHopsPerRound, discussion.activeRoundHop)
      : Math.min(totalHopsPerRound, completedRoundHops + 1);
    const end = Math.min(totalHopsPerRound, completedRoundHops + activeHopCount);
    return { start, end };
  }, [activeHopCount, activeHopNumbers, completedRoundHops, discussion.activePhase, discussion.activeRoundHop, totalHopsPerRound]);
  const hopText = useMemo(() => {
    if (discussion.totalHops == null || discussion.totalHops <= 0) return null;
    if (activeHopRange && activeHopCount > 1) {
      const startHop = activeHopRange.start;
      const endHop = activeHopRange.end;
      return startHop >= endHop
        ? `H${endHop}/${discussion.totalHops}`
        : `H${startHop}-${endHop}/${discussion.totalHops}`;
    }
    if (activeHopRange && activeHopCount === 1) {
      return `H${activeHopRange.start}/${discussion.totalHops}`;
    }
    return `H${visibleRoundHop ?? completedRoundHops}/${discussion.totalHops}`;
  }, [activeHopCount, activeHopRange, completedRoundHops, discussion.totalHops, visibleRoundHop]);
  const roundText = `R${discussion.currentRound}/${discussion.maxRounds}`;

  const phaseLabel = useMemo(() => (
    discussion.activePhase ? t(`p2p.discussions.phase_${discussion.activePhase}`) : null
  ), [discussion.activePhase, t]);

  const hopKey = isRunning ? `${discussion.currentRound}:${discussion.activeHop}:${discussion.activePhase}` : null;
  const runKey = isRunning ? discussion.id : null;

  // ── Mobile ultra-compact: single-line summary ──────────────────────────
  if (mobile) {
    const activeNode = nodes.find((n) => n.status === 'active');
    return (
      <div
        class="discussions-progress-card discussions-progress-card-mobile"
        style={onClick ? { cursor: 'pointer' } : undefined}
        onClick={onClick}
      >
        <div class="discussions-progress-mobile-row">
          <span class="discussions-progress-kicker">P2P</span>
          <span class="discussions-progress-badge">{roundText}</span>
          {hopText && <span class="discussions-progress-badge">{hopText}</span>}
          <ElapsedTimer timerKey={runKey} startMs={discussion.startedAt} active={isRunning} className="p2p-timer p2p-timer-compact" />
          {phaseLabel && <span class="discussions-progress-badge discussions-progress-badge-phase">{phaseLabel}</span>}
          {!hidden && activeNode && (
            <span class={`discussions-progress-node ${progressStatusClassName(activeNode.status, isRunning)}`} style={{ margin: 0 }}>
              <span class="discussions-progress-node-dot" />
              <span class="discussions-progress-node-label">{activeNode.displayLabel ?? activeNode.label}</span>
              {activeNode.phase && <span class="discussions-progress-node-phase">{t(`p2p.discussions.phase_${activeNode.phase}`)}</span>}
            </span>
          )}
          <span style={{ flex: '1 1 0' }} />
          <HopElapsedTimer hopKey={hopKey} startMs={discussion.hopStartedAt} active={isRunning} className="p2p-timer p2p-timer-hop-compact" />
          {onToggleHide && (
            <button
              class="discussions-progress-stop"
              style={{ padding: '2px 7px', fontSize: '10px' }}
              onClick={(e) => { e.stopPropagation(); onToggleHide(); }}
            >
              {hidden ? '▼' : '▲'}
            </button>
          )}
          {showActionButton && onStopDiscussion && (
            <DiscussionActionButton
              active={isActive}
              compact={true}
              onAction={() => onStopDiscussion(discussion.id)}
            />
          )}
        </div>
        {!hidden && (
          <div class="discussions-progress-mobile-title">{discussion.topic || t('p2p.discussions.untitled')}</div>
        )}
      </div>
    );
  }

  // ── Desktop / standard rendering ───────────────────────────────────────

  const roundSegments = useMemo(() => (
    Array.from({ length: Math.max(0, discussion.maxRounds) }, (_, idx) => {
      const roundNum = idx + 1;
      const status = discussion.state === 'done'
        ? 'done'
        : roundNum < discussion.currentRound
          ? 'done'
          : roundNum === discussion.currentRound
            ? 'active'
            : 'pending';
      return { roundNum, status };
    })
  ), [discussion.currentRound, discussion.maxRounds, discussion.state]);

  const nodesRef = useRef<HTMLDivElement>(null);
  const activeNodeIdx = useMemo(() => nodes.findIndex((n) => n.status === 'active'), [nodes]);
  useEffect(() => {
    const container = nodesRef.current;
    if (!container || activeNodeIdx < 0) return;
    const child = container.children[activeNodeIdx] as HTMLElement | undefined;
    if (child) child.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeNodeIdx]);

  const hopSegments = useMemo(() => (
    Array.from({ length: Math.max(0, discussion.totalHops ?? 0) }, (_, idx) => {
      const hopNum = idx + 1;
      const isActiveHop = !!activeHopRange
        && hopNum >= activeHopRange.start
        && hopNum <= activeHopRange.end
        && (activeHopNumbers.length === 0 || activeHopNumbers.includes(hopNum));
      const activeHopNum = visibleRoundHop ?? completedRoundHops;
      const status = discussion.state === 'done'
        ? 'done'
        : isActiveHop
          ? 'active'
        : hopNum <= completedRoundHops
          ? 'done'
          : hopNum === activeHopNum && discussion.activePhase === 'hop'
            ? 'active'
            : 'pending';
      return { hopNum, status };
    })
  ), [activeHopNumbers, activeHopRange, completedRoundHops, discussion.activePhase, discussion.state, discussion.totalHops, visibleRoundHop]);

  return (
    <div
      class={`discussions-progress-card${compact ? ' discussions-progress-card-compact' : ''}`}
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <div class="discussions-progress-head">
        <div class="discussions-progress-titlewrap">
          <div class="discussions-progress-kicker">P2P</div>
          <div class="discussions-progress-title">{discussion.topic || t('p2p.discussions.untitled')}</div>
        </div>
        <ElapsedTimer timerKey={runKey} startMs={discussion.startedAt} active={isRunning} className="p2p-timer p2p-timer-total" />
        {showActionButton && onStopDiscussion && (
          <DiscussionActionButton
            active={isActive}
            compact={false}
            onAction={() => onStopDiscussion(discussion.id)}
          />
        )}
      </div>

      <div class="discussions-progress-meta">
        {discussion.modeKey && (
          <span class="discussions-progress-badge discussions-progress-badge-mode">
            {t(`p2p.mode.${discussion.modeKey}`, discussion.modeKey)}
          </span>
        )}
        <span class="discussions-progress-badge">{roundText}</span>
        {hopText && <span class="discussions-progress-badge">{hopText}</span>}
        <HopElapsedTimer hopKey={hopKey} startMs={discussion.hopStartedAt} active={isRunning} className="p2p-timer p2p-timer-hop" />
        {phaseLabel && (
          <span class="discussions-progress-badge discussions-progress-badge-phase">{phaseLabel}</span>
        )}
      </div>

      <div class="discussions-progress-lines">
        <div class="discussions-progress-line">
          <div class="discussions-progress-line-head">
            <span class="discussions-progress-line-label">{t('p2p.discussions.round_label')}</span>
            <span class="discussions-progress-line-value">{roundText}</span>
          </div>
          <div class="discussions-progress-segments discussions-progress-segments-round">
            {roundSegments.map((seg) => (
              <div
                key={seg.roundNum}
                class={`discussions-progress-segment ${progressStatusClassName(seg.status as P2pProgressNode['status'], isRunning)}`}
                title={`${t('p2p.discussions.round_label')} ${seg.roundNum}/${discussion.maxRounds}`}
              >
                <span class="discussions-progress-segment-index">{seg.roundNum}</span>
              </div>
            ))}
          </div>
        </div>

        {hopSegments.length > 0 && (
          <>
            <div class="discussions-progress-slogan">{t('p2p.discussions.slogan')}</div>
            <div class="discussions-progress-line">
              <div class="discussions-progress-line-head">
                <span class="discussions-progress-line-label">{t('p2p.discussions.hop_label')}</span>
                <span class="discussions-progress-line-value">{hopText}</span>
              </div>
              <div class="discussions-progress-segments discussions-progress-segments-hop">
                {hopSegments.map((seg) => (
                  <div
                    key={seg.hopNum}
                    class={`discussions-progress-segment ${progressStatusClassName(seg.status as P2pProgressNode['status'], isRunning)}`}
                    title={`${t('p2p.discussions.hop_label')} ${seg.hopNum}/${discussion.totalHops}`}
                  >
                    <span class="discussions-progress-segment-index">{seg.hopNum}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {nodes.length > 0 && (
        <div class="discussions-progress-nodes" ref={nodesRef}>
          {nodes.map((node, idx) => (
            <div key={idx} class={`discussions-progress-node ${progressStatusClassName(node.status, isRunning)}`}>
              <span class="discussions-progress-node-dot" />
              <span class="discussions-progress-node-label">{node.displayLabel ?? node.label}</span>
              {node.mode && <span class="discussions-progress-node-mode">{t(`p2p.mode.${node.mode}`, node.mode)}</span>}
              {node.phase && <span class="discussions-progress-node-phase">{t(`p2p.discussions.phase_${node.phase}`)}</span>}
            </div>
          ))}
        </div>
      )}

      {discussion.state === 'done' && discussion.conclusion && (
        <div class="discussion-card-body">
          <div class="discussion-status done">✓ Complete</div>
          <div class="discussion-conclusion">{discussion.conclusion}</div>
        </div>
      )}

      {discussion.state === 'failed' && discussion.error && (
        <div class="discussion-card-body">
          <div class="discussion-status failed">✕ Failed</div>
          <div class="discussion-conclusion" style={{ color: '#f87171' }}>{discussion.error}</div>
        </div>
      )}
    </div>
  );
});
