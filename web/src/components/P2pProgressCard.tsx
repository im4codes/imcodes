import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

export interface P2pProgressNode {
  label: string;
  displayLabel?: string;
  agentType: string;
  ccPreset?: string | null;
  mode?: string;
  phase?: 'initial' | 'hop' | 'summary';
  status: 'done' | 'active' | 'pending' | 'skipped';
}

export interface P2pProgressDiscussion {
  id: string;
  topic: string;
  state: string;
  modeKey?: string;
  currentRound: number;
  maxRounds: number;
  completedHops?: number;
  totalHops?: number;
  activeHop?: number | null;
  activeRoundHop?: number | null;
  activePhase?: 'queued' | 'initial' | 'hop' | 'summary';
  conclusion?: string;
  error?: string;
  nodes?: P2pProgressNode[];
}

interface Props {
  discussion: P2pProgressDiscussion;
  compact?: boolean;
  onClick?: () => void;
  onStopDiscussion?: (id: string) => void;
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

export function P2pProgressCard({ discussion, compact = false, onClick, onStopDiscussion }: Props) {
  const { t } = useTranslation();
  const nodes = discussion.nodes ?? [];
  const isActive = discussion.state !== 'done' && discussion.state !== 'failed';
  const totalHopsPerRound = discussion.totalHops ?? 0;
  const completedRoundHops = useMemo(() => {
    if (totalHopsPerRound <= 0) return 0;
    const roundOffset = Math.max(0, discussion.currentRound - 1) * totalHopsPerRound;
    return Math.max(0, Math.min(totalHopsPerRound, (discussion.completedHops ?? 0) - roundOffset));
  }, [discussion.completedHops, discussion.currentRound, totalHopsPerRound]);
  const visibleRoundHop = useMemo(() => {
    if (totalHopsPerRound <= 0) return null;
    if (typeof discussion.activeRoundHop === 'number') return discussion.activeRoundHop;
    if (typeof discussion.activeHop === 'number' && discussion.activeHop > 0) {
      return ((discussion.activeHop - 1) % totalHopsPerRound) + 1;
    }
    return completedRoundHops;
  }, [discussion.activeHop, discussion.activeRoundHop, completedRoundHops, totalHopsPerRound]);
  const hopText = discussion.totalHops != null && discussion.totalHops > 0
    ? `H${visibleRoundHop ?? completedRoundHops}/${discussion.totalHops}`
    : null;
  const roundText = `R${discussion.currentRound}/${discussion.maxRounds}`;

  const phaseLabel = useMemo(() => (
    discussion.activePhase ? t(`p2p.discussions.phase_${discussion.activePhase}`) : null
  ), [discussion.activePhase, t]);

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

  const hopSegments = useMemo(() => (
    Array.from({ length: Math.max(0, discussion.totalHops ?? 0) }, (_, idx) => {
      const hopNum = idx + 1;
      const activeHopNum = visibleRoundHop ?? completedRoundHops;
      const status = discussion.state === 'done'
        ? 'done'
        : hopNum < activeHopNum
          ? 'done'
          : hopNum === activeHopNum && discussion.activePhase === 'hop'
            ? 'active'
          : 'pending';
      return { hopNum, status };
    })
  ), [completedRoundHops, discussion.activePhase, discussion.state, discussion.totalHops, visibleRoundHop]);

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
        {isActive && onStopDiscussion && (
          <button
            class="discussions-progress-stop"
            onClick={(e) => {
              e.stopPropagation();
              onStopDiscussion(discussion.id);
            }}
          >
            {t('common.cancel')}
          </button>
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
                class={`discussions-progress-segment ${statusClassName(seg.status as P2pProgressNode['status'])}`}
                title={`${t('p2p.discussions.round_label')} ${seg.roundNum}/${discussion.maxRounds}`}
              >
                <span class="discussions-progress-segment-index">{seg.roundNum}</span>
              </div>
            ))}
          </div>
        </div>

        {hopSegments.length > 0 && (
          <div class="discussions-progress-line">
            <div class="discussions-progress-line-head">
              <span class="discussions-progress-line-label">{t('p2p.discussions.hop_label')}</span>
              <span class="discussions-progress-line-value">{hopText}</span>
            </div>
            <div class="discussions-progress-segments discussions-progress-segments-hop">
              {hopSegments.map((seg) => (
                <div
                  key={seg.hopNum}
                  class={`discussions-progress-segment ${statusClassName(seg.status as P2pProgressNode['status'])}`}
                  title={`${t('p2p.discussions.hop_label')} ${seg.hopNum}/${discussion.totalHops}`}
                >
                  <span class="discussions-progress-segment-index">{seg.hopNum}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {nodes.length > 0 && (
        <div class="discussions-progress-nodes">
          {nodes.map((node, idx) => (
            <div key={idx} class={`discussions-progress-node ${statusClassName(node.status)}`}>
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
}
