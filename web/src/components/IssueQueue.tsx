import type { TrackerIssue } from '../types';

interface CompletedIssue {
  id: string;
  success: boolean;
}

interface IssueQueueProps {
  issues: TrackerIssue[];
  currentIssueId: string | null;
  completedIssues: CompletedIssue[];
}

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

interface PriorityBadgeProps {
  priority: number;
}

function PriorityBadge({ priority }: PriorityBadgeProps) {
  return (
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
  );
}

export function IssueQueue({ issues, currentIssueId, completedIssues }: IssueQueueProps) {
  const completedIds = new Set(completedIssues.map((c) => c.id));

  const currentIssue = currentIssueId ? issues.find((i) => i.id === currentIssueId) ?? null : null;

  const upcomingIssues = issues
    .filter((i) => i.id !== currentIssueId && !completedIds.has(i.id))
    .sort((a, b) => a.priority - b.priority);

  const completedWithInfo = completedIssues.map((c) => ({
    ...c,
    issue: issues.find((i) => i.id === c.id),
  }));

  const totalCompleted = completedIssues.length;
  const totalFailed = completedIssues.filter((c) => !c.success).length;
  const successRate = totalCompleted > 0 ? Math.round(((totalCompleted - totalFailed) / totalCompleted) * 100) : 0;

  return (
    <div class="issue-queue">
      {/* Stats row */}
      <div class="issue-queue__stats" style={{ display: 'flex', gap: '16px', padding: '8px 0', fontSize: '12px', color: '#94a3b8', borderBottom: '1px solid #334155', marginBottom: '12px' }}>
        <span>Completed: <strong style={{ color: '#e2e8f0' }}>{totalCompleted}</strong></span>
        <span>Failed: <strong style={{ color: '#f87171' }}>{totalFailed}</strong></span>
        <span>
          Success Rate:{' '}
          <strong style={{ color: successRate >= 80 ? '#4ade80' : '#f87171' }}>
            {successRate}%
          </strong>
        </span>
      </div>

      {/* Current issue */}
      {currentIssue && (
        <div class="issue-queue__section">
          <div class="issue-queue__section-label">Current</div>
          <div
            class="issue-card issue-card--current"
            style={{ border: '2px solid #3b82f6', borderRadius: '6px', padding: '10px 14px', background: '#0a0f1a', marginBottom: '8px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <PriorityBadge priority={currentIssue.priority} />
              <span style={{ color: '#60a5fa', fontSize: '11px' }}>#{currentIssue.id}</span>
              <span class="badge" style={{ background: '#1e3a5f', color: '#93c5fd', fontSize: '10px' }}>
                IN PROGRESS
              </span>
            </div>
            <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{currentIssue.title}</div>
            {currentIssue.labels.length > 0 && (
              <div style={{ marginTop: '4px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {currentIssue.labels.map((label) => (
                  <span key={label} class="badge" style={{ background: '#1e293b', color: '#94a3b8', fontSize: '10px' }}>
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upcoming queue */}
      {upcomingIssues.length > 0 && (
        <div class="issue-queue__section">
          <div class="issue-queue__section-label">Queue ({upcomingIssues.length})</div>
          {upcomingIssues.map((issue) => (
            <div
              key={issue.id}
              class="issue-card issue-card--upcoming"
              style={{ border: `1px solid ${PRIORITY_COLORS[issue.priority] ?? '#334155'}40`, borderRadius: '6px', padding: '8px 12px', background: '#0f172a', marginBottom: '6px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                <PriorityBadge priority={issue.priority} />
                <span style={{ color: '#64748b', fontSize: '11px' }}>#{issue.id}</span>
              </div>
              <div style={{ color: '#cbd5e1', fontSize: '13px' }}>{issue.title}</div>
            </div>
          ))}
        </div>
      )}

      {/* Completed issues */}
      {completedWithInfo.length > 0 && (
        <div class="issue-queue__section">
          <div class="issue-queue__section-label">Completed</div>
          {completedWithInfo.map((c) => (
            <div
              key={c.id}
              class="issue-card issue-card--completed"
              style={{ border: '1px solid #334155', borderRadius: '6px', padding: '6px 12px', background: '#0a0a0f', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}
            >
              <span style={{ fontSize: '16px', lineHeight: 1 }}>
                {c.success ? '✓' : '✗'}
              </span>
              <span style={{ color: c.success ? '#4ade80' : '#f87171', fontSize: '11px', fontWeight: 700 }}>
                {c.success ? 'PASS' : 'FAIL'}
              </span>
              <span style={{ color: '#64748b', fontSize: '11px' }}>#{c.id}</span>
              <span style={{ color: '#94a3b8', fontSize: '12px' }}>
                {c.issue?.title ?? 'Unknown issue'}
              </span>
            </div>
          ))}
        </div>
      )}

      {issues.length === 0 && completedIssues.length === 0 && (
        <div class="empty-state" style={{ color: '#64748b', padding: '24px 0', textAlign: 'center' }}>
          No issues in queue.
        </div>
      )}
    </div>
  );
}
