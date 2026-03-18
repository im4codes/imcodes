import { useState, useEffect } from 'preact/hooks';
import type { AutoFixTaskStatus } from '../types';

interface TaskCardProps {
  task: AutoFixTaskStatus;
  priority?: number;
  onAbort?: () => void;
  onRetry?: () => void;
}

const STATE_BORDER_COLORS: Record<string, string> = {
  planning: '#94a3b8',
  design_review: '#3b82f6',
  implementing: '#a855f7',
  code_review: '#f97316',
  approved: '#22c55e',
  done: '#22c55e',
  failed: '#ef4444',
};

const STATE_LABELS: Record<string, string> = {
  planning: 'Planning',
  design_review: 'Design Review',
  implementing: 'Implementing',
  code_review: 'Code Review',
  approved: 'Approved',
  done: 'Done',
  failed: 'Failed',
};

const PRIORITY_COLORS: Record<number, string> = {
  0: '#ef4444',
  1: '#f97316',
  2: '#eab308',
  3: '#94a3b8',
};

const PRIORITY_BG: Record<number, string> = {
  0: '#450a0a',
  1: '#431407',
  2: '#422006',
  3: '#1e293b',
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function TaskCard({ task, priority, onAbort, onRetry }: TaskCardProps) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);

  const isTerminal = task.state === 'done' || task.state === 'failed';

  useEffect(() => {
    if (isTerminal) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTerminal]);

  const elapsed = now - task.startedAt;
  const borderColor = STATE_BORDER_COLORS[task.state] ?? '#334155';

  return (
    <div
      class={`task-card task-card--${task.state}`}
      style={{
        borderLeft: `4px solid ${borderColor}`,
        background: '#1e293b',
        borderRadius: '6px',
        overflow: 'hidden',
        marginBottom: '8px',
      }}
    >
      {/* Main row */}
      <div
        class="task-card__header"
        style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '10px' }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
            {/* Phase label */}
            <span
              class="badge"
              style={{ background: `${borderColor}22`, color: borderColor, border: `1px solid ${borderColor}44`, fontSize: '10px' }}
            >
              {STATE_LABELS[task.state] ?? task.state}
            </span>

            {/* Priority badge */}
            {priority !== undefined && (
              <span
                class="badge"
                style={{
                  background: PRIORITY_BG[priority] ?? '#1e293b',
                  color: PRIORITY_COLORS[priority] ?? '#94a3b8',
                  fontSize: '10px',
                }}
              >
                P{priority}
              </span>
            )}

            {task.issueId && (
              <span style={{ color: '#64748b', fontSize: '11px' }}>#{task.issueId}</span>
            )}
          </div>

          <div
            class="task-card__title"
            style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {task.title}
          </div>
        </div>

        {/* Elapsed time */}
        <div style={{ color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {formatElapsed(elapsed)}
        </div>

        {/* Expand chevron */}
        <span style={{ color: '#64748b', fontSize: '10px', flexShrink: 0 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expandable details */}
      {expanded && (
        <div
          class="task-card__details"
          style={{ padding: '0 14px 12px', borderTop: '1px solid #334155' }}
        >
          <div style={{ paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
            {task.branch && (
              <div>
                <span style={{ color: '#64748b' }}>Branch: </span>
                <code style={{ color: '#a78bfa', background: '#1a1040', padding: '1px 5px', borderRadius: '3px' }}>
                  {task.branch}
                </code>
              </div>
            )}
            {task.coderSession && (
              <div>
                <span style={{ color: '#64748b' }}>Coder: </span>
                <span style={{ color: '#60a5fa' }}>{task.coderSession}</span>
              </div>
            )}
            {task.auditorSession && (
              <div>
                <span style={{ color: '#64748b' }}>Auditor: </span>
                <span style={{ color: '#34d399' }}>{task.auditorSession}</span>
              </div>
            )}
            {task.error && (
              <div
                style={{ background: '#1a0505', border: '1px solid #7f1d1d', borderRadius: '4px', padding: '6px 10px', color: '#f87171' }}
              >
                <span style={{ fontWeight: 700 }}>Error: </span>
                {task.error}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            {!isTerminal && onAbort && (
              <button
                class="btn btn-danger"
                onClick={(e) => { e.stopPropagation(); onAbort(); }}
              >
                Abort
              </button>
            )}
            {task.state === 'failed' && onRetry && (
              <button
                class="btn btn-secondary"
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
