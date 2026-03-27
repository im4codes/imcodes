/**
 * P2pChainStatus — chain visualization and status display for P2P Quick Discussion runs.
 * Shows the hop chain (initiator -> targets -> initiator) with status icons and a cancel button.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

interface Target {
  session: string;
  mode: string;
}

interface P2pRun {
  id: string;
  initiator_session: string;
  remaining_targets: string;
  current_target_session: string | null;
  status: string;
  result_summary: string | null;
  error: string | null;
  mode_key: string;
}

interface P2pChainStatusProps {
  run: P2pRun;
  onCancel: (runId: string) => void;
}

// ── Status helpers ─────────────────────────────────────────────────────────

type StatusCategory = 'completed' | 'failed' | 'active' | 'queued';

function categorize(status: string): StatusCategory {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') return 'failed';
  if (status === 'running' || status === 'dispatched' || status === 'awaiting_next_hop') return 'active';
  return 'queued';
}

const STATUS_COLORS: Record<StatusCategory, string> = {
  completed: '#4ade80',
  failed: '#f87171',
  active: '#facc15',
  queued: '#64748b',
};

const STATUS_ICON: Record<StatusCategory, string> = {
  completed: '\u2713',   // checkmark
  failed: '\u2717',      // x mark
  active: '\u23f3',      // hourglass
  queued: '\u25cb',      // open circle
};

function isActive(status: string): boolean {
  return status === 'queued' || status === 'dispatched' || status === 'running' || status === 'awaiting_next_hop';
}

// ── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: Record<string, string | number> = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: '10px 14px',
  fontSize: 13,
  color: '#e2e8f0',
};

const chainRowStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexWrap: 'wrap',
  marginBottom: 8,
  fontSize: 12,
  lineHeight: '22px',
};

const hopStyle: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: '1px 6px',
  borderRadius: 4,
  background: '#0f172a',
  border: '1px solid #334155',
  whiteSpace: 'nowrap',
};

const arrowStyle: Record<string, string | number> = {
  color: '#475569',
  fontSize: 11,
  margin: '0 2px',
};

const badgeStyle = (cat: StatusCategory): Record<string, string | number> => ({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 9999,
  fontSize: 11,
  fontWeight: 600,
  background: cat === 'completed' ? 'rgba(74, 222, 128, 0.15)'
    : cat === 'failed' ? 'rgba(248, 113, 113, 0.15)'
    : cat === 'active' ? 'rgba(250, 204, 21, 0.15)'
    : 'rgba(100, 116, 139, 0.15)',
  color: STATUS_COLORS[cat],
  border: `1px solid ${STATUS_COLORS[cat]}33`,
});

const cancelBtnStyle: Record<string, string | number> = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid #ef4444',
  background: 'rgba(239, 68, 68, 0.1)',
  color: '#f87171',
  fontSize: 12,
  cursor: 'pointer',
  marginLeft: 8,
};

const resultStyle: Record<string, string | number> = {
  marginTop: 6,
  padding: '6px 8px',
  background: '#0f172a',
  borderRadius: 4,
  fontSize: 12,
  color: '#94a3b8',
  whiteSpace: 'pre-wrap',
  maxHeight: 120,
  overflowY: 'auto',
  lineHeight: 1.4,
};

const errorStyle: Record<string, string | number> = {
  ...resultStyle,
  color: '#f87171',
  borderLeft: '2px solid #ef4444',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function shortSession(name: string): string {
  const parts = name.split('_');
  return parts[parts.length - 1] || name;
}

function parseTargets(json: string): Target[] {
  try {
    return JSON.parse(json) as Target[];
  } catch {
    return [];
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export function P2pChainStatus({ run, onCancel }: P2pChainStatusProps) {
  const { t } = useTranslation();
  const cat = categorize(run.status);

  const remaining = useMemo(() => {
    return parseTargets(run.remaining_targets);
  }, [run.remaining_targets]);

  // Build chain nodes: initiator -> each target -> initiator (return)
  const chainNodes = useMemo(() => {
    const nodes: Array<{ label: string; mode?: string; icon: string; color: string }> = [];

    // Initiator (start)
    nodes.push({
      label: shortSession(run.initiator_session),
      icon: '',
      color: '#60a5fa',
    });

    // Current target (if any)
    if (run.current_target_session) {
      const isCurrent = cat === 'active';
      nodes.push({
        label: shortSession(run.current_target_session),
        mode: run.mode_key,
        icon: isCurrent ? STATUS_ICON.active : STATUS_ICON.completed,
        color: isCurrent ? STATUS_COLORS.active : STATUS_COLORS.completed,
      });
    }

    // Remaining targets
    for (const tgt of remaining) {
      nodes.push({
        label: shortSession(tgt.session),
        mode: tgt.mode,
        icon: STATUS_ICON.queued,
        color: STATUS_COLORS.queued,
      });
    }

    // Return to initiator
    nodes.push({
      label: shortSession(run.initiator_session),
      icon: cat === 'completed' ? STATUS_ICON.completed : STATUS_ICON.queued,
      color: cat === 'completed' ? STATUS_COLORS.completed : STATUS_COLORS.queued,
    });

    return nodes;
  }, [run, cat, remaining]);

  return (
    <div style={containerStyle}>
      {/* Chain visualization */}
      <div style={chainRowStyle}>
        {chainNodes.map((node, idx) => (
          <>
            {idx > 0 && <span style={arrowStyle}>&rarr;</span>}
            <span style={{ ...hopStyle, borderColor: node.color + '66' }}>
              {node.icon && <span style={{ color: node.color, fontSize: 11 }}>{node.icon}</span>}
              <span style={{ fontWeight: 500 }}>{node.label}</span>
              {node.mode && (
                <span style={{ color: '#64748b', fontSize: 10, marginLeft: 2 }}>
                  ({t(`p2p.mode.${node.mode}`, node.mode)})
                </span>
              )}
            </span>
          </>
        ))}
      </div>

      {/* Status badge + cancel */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={badgeStyle(cat)}>{run.status}</span>
        {isActive(run.status) && (
          <button
            type="button"
            style={cancelBtnStyle}
            onClick={() => onCancel(run.id)}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Result summary */}
      {run.result_summary && cat === 'completed' && (
        <div style={resultStyle}>{run.result_summary}</div>
      )}

      {/* Error */}
      {run.error && cat === 'failed' && (
        <div style={errorStyle}>{run.error}</div>
      )}
    </div>
  );
}
