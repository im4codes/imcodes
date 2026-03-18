import { useState } from 'preact/hooks';
import type { AutoFixTaskStatus } from '../types';

interface StateTransition {
  state: string;
  timestamp: number;
}

interface AutoFixMonitorProps {
  apiKey: string;
  serverId: string;
  projectName: string;
  task: AutoFixTaskStatus;
  onSessionSelect: (session: string) => void;
}

const PIPELINE_STATES = [
  'planning',
  'design_review',
  'implementing',
  'code_review',
  'approved',
  'done',
] as const;

const STATE_LABELS: Record<string, string> = {
  planning: 'Planning',
  design_review: 'Design Review',
  implementing: 'Implementing',
  code_review: 'Code Review',
  approved: 'Approved',
  done: 'Done',
  failed: 'Failed',
};

function getStateIndex(state: string): number {
  const idx = PIPELINE_STATES.indexOf(state as typeof PIPELINE_STATES[number]);
  return idx === -1 ? -1 : idx;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

interface ProgressBarProps {
  currentState: string;
}

function ProgressBar({ currentState }: ProgressBarProps) {
  const isFailed = currentState === 'failed';
  const currentIdx = isFailed ? -1 : getStateIndex(currentState);

  return (
    <div class="autofix-progress">
      {PIPELINE_STATES.map((state, idx) => {
        let stateClass = 'progress-step';
        if (isFailed) {
          stateClass += ' progress-step--future';
        } else if (idx < currentIdx) {
          stateClass += ' progress-step--done';
        } else if (idx === currentIdx) {
          stateClass += ' progress-step--active';
        } else {
          stateClass += ' progress-step--future';
        }
        return (
          <div key={state} class={stateClass}>
            <div class="progress-step__dot" />
            <span class="progress-step__label">{STATE_LABELS[state]}</span>
            {idx < PIPELINE_STATES.length - 1 && (
              <div class={`progress-step__line${idx < currentIdx ? ' progress-step__line--done' : ''}`} />
            )}
          </div>
        );
      })}
      {isFailed && (
        <div class="progress-step progress-step--failed">
          <div class="progress-step__dot" />
          <span class="progress-step__label">Failed</span>
        </div>
      )}
    </div>
  );
}

export function AutoFixMonitor({ task, onSessionSelect }: AutoFixMonitorProps) {
  const [activeTab, setActiveTab] = useState<'coder' | 'auditor'>('coder');

  // Build a synthetic timeline from task data (real impl would receive this via props/ws)
  const timeline: StateTransition[] = [
    { state: 'planning', timestamp: task.startedAt },
    ...(task.state !== 'planning' ? [{ state: task.state, timestamp: task.updatedAt }] : []),
  ];

  const activeSession = activeTab === 'coder' ? task.coderSession : task.auditorSession;

  return (
    <div class="autofix-monitor">
      {/* Header */}
      <div class="autofix-monitor__header">
        <div class="autofix-monitor__title-row">
          <span class="autofix-monitor__task-id">#{task.issueId ?? task.id}</span>
          <h2 class="autofix-monitor__title">{task.title}</h2>
          <span class={`badge badge--state badge--${task.state}`}>
            {STATE_LABELS[task.state] ?? task.state}
          </span>
        </div>
        {task.discussionRounds > 0 && (
          <div class="autofix-monitor__rounds">
            Round {task.discussionRounds}/{task.maxDiscussionRounds}
          </div>
        )}
      </div>

      {/* Progress bar */}
      <ProgressBar currentState={task.state} />

      {/* Terminal tabs */}
      <div class="autofix-monitor__tabs">
        <div class="tab-bar">
          <button
            class={`tab${activeTab === 'coder' ? ' active' : ''}`}
            onClick={() => setActiveTab('coder')}
          >
            {task.coderSession || 'Coder'}
          </button>
          <button
            class={`tab${activeTab === 'auditor' ? ' active' : ''}`}
            onClick={() => setActiveTab('auditor')}
          >
            {task.auditorSession || 'Auditor'}
          </button>
        </div>
        <div class="autofix-monitor__terminal-placeholder" onClick={() => onSessionSelect(activeSession)}>
          <span class="autofix-monitor__terminal-label">
            Session: <strong>{activeSession}</strong>
            <span class="autofix-monitor__terminal-hint"> (click to open terminal)</span>
          </span>
        </div>
      </div>

      {/* Timeline */}
      <div class="autofix-monitor__timeline">
        <div class="autofix-monitor__timeline-header">Timeline</div>
        <ul class="timeline-list">
          {timeline.map((entry, idx) => (
            <li key={idx} class="timeline-item">
              <span class="timeline-item__time">{formatTime(entry.timestamp)}</span>
              <span class={`timeline-item__state badge--state badge--${entry.state}`}>
                {STATE_LABELS[entry.state] ?? entry.state}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
