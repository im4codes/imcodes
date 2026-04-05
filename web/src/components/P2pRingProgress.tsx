/**
 * P2pRingProgress — compact ring/circle progress indicator for P2P discussions.
 * Shows discussion completion as a filled arc proportional to completedRounds / totalRounds.
 * Intended for sidebar display between session tree and pinned panels.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { mapP2pStatusToUiState } from '@shared/p2p-status.js';

export interface P2pRingProgressProps {
  completedRounds: number;
  totalRounds: number;
  completedHops?: number;
  totalHops?: number;
  activeHop?: number | null;
  activeRoundHop?: number | null;
  status: string;
  modeKey?: string;
  onClick?: () => void;
}

// Active statuses that show "Round N/M" in the center
// SVG geometry constants
const OUTER_RADIUS = 30;
const STROKE_WIDTH = 4;
const VIEW_SIZE = (OUTER_RADIUS + STROKE_WIDTH) * 2; // 68
const CENTER = VIEW_SIZE / 2; // 34
const RING_RADIUS = OUTER_RADIUS - STROKE_WIDTH / 2; // 28
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function P2pRingProgress({
  completedRounds,
  totalRounds,
  completedHops = 0,
  totalHops = 0,
  activeHop = null,
  activeRoundHop = null,
  status,
  modeKey,
  onClick,
}: P2pRingProgressProps) {
  const { t } = useTranslation();
  const visibleRoundHop = useMemo(() => {
    if (totalHops <= 0) return 0;
    if (typeof activeRoundHop === 'number') return activeRoundHop;
    const active = mapP2pStatusToUiState(status) === 'running' || status === 'setup';
    const visibleGlobalHop = active ? (activeHop ?? completedHops) : completedHops;
    return visibleGlobalHop > 0 ? ((visibleGlobalHop - 1) % totalHops) + 1 : 0;
  }, [activeHop, activeRoundHop, completedHops, status, totalHops]);

  // Use hop-level progress if available, fall back to round-level
  const fraction = useMemo(() => {
    const active = mapP2pStatusToUiState(status) === 'running' || status === 'setup';
    if (totalHops > 0) {
      const visibleHop = active ? (activeHop ?? completedHops) : completedHops;
      const totalOverallHops = totalRounds > 1 ? totalRounds * totalHops : totalHops;
      return Math.min(1, Math.max(0, visibleHop / totalOverallHops));
    }
    if (totalRounds <= 0) return 0;
    return Math.min(1, Math.max(0, completedRounds / totalRounds));
  }, [completedHops, totalHops, completedRounds, totalRounds, activeHop, status]);

  const dashArray = useMemo(() => {
    const filled = fraction * CIRCUMFERENCE;
    return `${filled} ${CIRCUMFERENCE - filled}`;
  }, [fraction]);

  const centerText = useMemo(() => {
    if (mapP2pStatusToUiState(status) === 'running' || status === 'setup') {
      if (totalHops > 0) {
        return t('p2p.ring.active_hops', {
          round: completedRounds + 1,
          totalRounds,
          hop: visibleRoundHop,
          totalHops,
          defaultValue: `R{{round}}/{{totalRounds}} H{{hop}}/{{totalHops}}`,
        });
      }
      return t('p2p.ring.active', {
        round: completedRounds + 1,
        totalRounds,
        defaultValue: `R{{round}}/{{totalRounds}}`,
      });
    }
    return status;
  }, [status, completedRounds, totalRounds, totalHops, visibleRoundHop, t]);

  const statusLabel = useMemo(() => {
    if (mapP2pStatusToUiState(status) === 'running' || status === 'setup') {
      return t('p2p.ring.label_active', {
        round: completedRounds + 1,
        totalRounds,
        defaultValue: `Round {{round}}/{{totalRounds}}`,
      });
    }
    return t(`p2p.status.${status}`, status);
  }, [status, completedRounds, totalRounds, t]);

  const modeLabel = useMemo(() => (
    modeKey ? t(`p2p.mode.${modeKey}`, modeKey) : null
  ), [modeKey, t]);

  return (
    <div
      class={`p2p-ring p2p-ring-status-${status}${onClick ? ' p2p-ring-clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      title={[modeLabel, statusLabel].filter(Boolean).join(' · ')}
    >
      <div class="p2p-ring-inner">
        {modeLabel && <div class="p2p-ring-mode">{modeLabel}</div>}
        <svg
          width={VIEW_SIZE}
          height={VIEW_SIZE}
          viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
          aria-hidden="true"
        >
          {/* Background track */}
          <circle
            class="p2p-ring-track"
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
          />
          {/* Progress arc */}
          <circle
            class="p2p-ring-progress"
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={dashArray}
            strokeLinecap="round"
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        </svg>
        {/* Center text absolutely positioned over SVG */}
        <div class="p2p-ring-text" aria-label={centerText}>
          {centerText}
        </div>
      </div>
      {/* Label below ring */}
      <div class="p2p-ring-label">{modeLabel || statusLabel}</div>
      {modeLabel && <div class="p2p-ring-sub">{statusLabel}</div>}
    </div>
  );
}
