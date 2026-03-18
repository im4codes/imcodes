import type { AutoFixTaskStatus } from '../types';
import { TaskCard } from './TaskCard';
import { ReviewFlow } from './ReviewFlow';

interface SplitViewProps {
  tasks: AutoFixTaskStatus[];
  onAbort?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
}

const REVIEW_STATES = new Set<AutoFixTaskStatus['state']>(['code_review', 'design_review']);

export function SplitView({ tasks, onAbort, onRetry }: SplitViewProps) {
  if (tasks.length === 0) {
    return (
      <div
        class="split-view split-view--empty"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: '#64748b', fontSize: '14px' }}
      >
        No active tasks
      </div>
    );
  }

  return (
    <div
      class="split-view"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(1, 1fr)',
        gap: '16px',
        padding: '8px 0',
      }}
    >
      <style>{`
        @media (min-width: 768px) {
          .split-view { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (min-width: 1280px) {
          .split-view { grid-template-columns: repeat(3, 1fr) !important; }
        }
        .split-view__item--review {
          grid-column: 1 / -1;
        }
      `}</style>

      {tasks.map((task) => {
        const isReview = REVIEW_STATES.has(task.state);

        if (isReview) {
          return (
            <div
              key={task.id}
              class="split-view__item split-view__item--review"
              style={{ background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}
            >
              <div style={{ marginBottom: '10px' }}>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>{task.title}</span>
                <span
                  class="badge"
                  style={{ marginLeft: '8px', background: '#1e3a5f', color: '#93c5fd', fontSize: '10px' }}
                >
                  {task.state === 'code_review' ? 'Code Review' : 'Design Review'}
                </span>
              </div>
              <ReviewFlow
                coderSession={task.coderSession}
                auditorSession={task.auditorSession}
                reviews={[]}
              />
            </div>
          );
        }

        return (
          <div
            key={task.id}
            class="split-view__item"
            style={{ background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <TaskCard
              task={task}
              onAbort={onAbort ? () => onAbort(task.id) : undefined}
              onRetry={onRetry ? () => onRetry(task.id) : undefined}
            />
            {/* Mini terminal placeholder */}
            <div
              class="split-view__mini-terminal"
              style={{
                background: '#0f0f13',
                borderRadius: '4px',
                border: '1px solid #334155',
                padding: '8px 12px',
                minHeight: '60px',
                display: 'flex',
                alignItems: 'center',
                color: '#334155',
                fontSize: '11px',
              }}
            >
              {task.coderSession || 'terminal'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
