/**
 * P2pRingProgress — compact ring/circle progress indicator for P2P discussions.
 * Shows discussion completion as a filled arc proportional to completedRounds / totalRounds.
 * Intended for sidebar display between session tree and pinned panels.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

export interface P2pRingProgressProps {
  completedRounds: number;
  totalRounds: number;
  completedHops?: number;
  totalHops?: number;
  status: string;
  onClick?: () => void;
}

// Active statuses that show "Round N/M" in the center
const ACTIVE_STATUSES = new Set(['running', 'dispatched', 'awaiting_next_hop', 'setup']);

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
  status,
  onClick,
}: P2pRingProgressProps) {
  const { t } = useTranslation();

  // Use hop-level progress if available, fall back to round-level
  const fraction = useMemo(() => {
    if (totalHops > 0) return Math.min(1, Math.max(0, completedHops / totalHops));
    if (totalRounds <= 0) return 0;
    return Math.min(1, Math.max(0, completedRounds / totalRounds));
  }, [completedHops, totalHops, completedRounds, totalRounds]);

  const dashArray = useMemo(() => {
    const filled = fraction * CIRCUMFERENCE;
    return `${filled} ${CIRCUMFERENCE - filled}`;
  }, [fraction]);

  // Rotate so progress starts at the top (12 o'clock position)
  const dashOffset = CIRCUMFERENCE / 4;

  const centerText = useMemo(() => {
    if (ACTIVE_STATUSES.has(status)) {
      if (totalHops > 0) {
        return t('p2p.ring.active_hops', {
          round: completedRounds + 1,
          totalRounds,
          hop: completedHops,
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
  }, [status, completedRounds, totalRounds, completedHops, totalHops, t]);

  const label = useMemo(() => {
    if (ACTIVE_STATUSES.has(status)) {
      return t('p2p.ring.label_active', {
        round: completedRounds + 1,
        totalRounds,
        defaultValue: `Round {{round}}/{{totalRounds}}`,
      });
    }
    return t(`p2p.status.${status}`, status);
  }, [status, completedRounds, totalRounds, t]);

  return (
    <div
      class={`p2p-ring${onClick ? ' p2p-ring-clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      title={label}
    >
      <div class="p2p-ring-inner">
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
            stroke-width={STROKE_WIDTH}
          />
          {/* Progress arc */}
          <circle
            class="p2p-ring-progress"
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS}
            fill="none"
            stroke-width={STROKE_WIDTH}
            stroke-dasharray={dashArray}
            stroke-dashoffset={-dashOffset}
            stroke-linecap="round"
          />
        </svg>
        {/* Center text absolutely positioned over SVG */}
        <div class="p2p-ring-text" aria-label={centerText}>
          {centerText}
        </div>
      </div>
      {/* Label below ring */}
      <div class="p2p-ring-label">{label}</div>
    </div>
  );
}
