import { useState, useEffect } from 'preact/hooks';
import type { TrackerIssue } from '../types.js';

interface AutoFixControlsProps {
  apiKey: string;
  serverId: string;
  projectName: string;
  isRunning: boolean;
  onStarted: () => void;
  onStopped: () => void;
}

type Mode = 'task' | 'issue' | 'continuous';

export function AutoFixControls({ apiKey, serverId, projectName, isRunning, onStarted, onStopped }: AutoFixControlsProps) {
  const [mode, setMode] = useState<Mode>('task');
  const [task, setTask] = useState('');
  const [coderAgent, setCoderAgent] = useState('claude-code');
  const [auditorAgent, setAuditorAgent] = useState('codex');
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopImmediate, setStopImmediate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentTypes = ['claude-code', 'claude-code-sdk', 'codex', 'codex-sdk', 'opencode'];

  useEffect(() => {
    if (mode === 'issue' || mode === 'continuous') {
      fetchIssues();
    }
  }, [mode]);

  async function fetchIssues() {
    setLoadingIssues(true);
    try {
      const res = await fetch(`/api/server/${serverId}/projects/${projectName}/issues`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return;
      const data = await res.json() as TrackerIssue[];
      setIssues(data);
    } finally {
      setLoadingIssues(false);
    }
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const payload = {
        coder: coderAgent,
        auditor: auditorAgent,
        mode,
        task: mode === 'task' ? task : undefined,
        issueId: mode === 'issue' ? selectedIssue : undefined,
        continuous: mode === 'continuous',
      };
      const res = await fetch(`/api/server/${serverId}/projects/${projectName}/autofix`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      onStarted();
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await fetch(`/api/server/${serverId}/projects/${projectName}/autofix`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ immediate: stopImmediate }),
      });
      onStopped();
    } catch (err) {
      setError(String(err));
    } finally {
      setStopping(false);
    }
  }

  const priorityColors: Record<number, string> = { 0: '#ef4444', 1: '#f97316', 2: '#eab308', 3: '#6b7280' };
  const priorityLabels: Record<number, string> = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };

  return (
    <div class="autofix-controls">
      <h3>Auto-Fix Pipeline</h3>

      {isRunning ? (
        <div class="autofix-running">
          <p>Auto-fix is currently running.</p>
          <div class="form-group form-group--checkbox">
            <label>
              <input
                type="checkbox"
                checked={stopImmediate}
                onChange={(e) => setStopImmediate((e.target as HTMLInputElement).checked)}
              />
              Stop immediately (vs. stop after current task)
            </label>
          </div>
          <button class="btn btn-danger" onClick={handleStop} disabled={stopping}>
            {stopping ? 'Stopping…' : stopImmediate ? 'Stop Now' : 'Stop After Current'}
          </button>
        </div>
      ) : (
        <div class="autofix-start">
          <div class="form-row">
            <div class="form-group">
              <label>Coder</label>
              <select value={coderAgent} onChange={(e) => setCoderAgent((e.target as HTMLSelectElement).value)}>
                {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div class="form-group">
              <label>Auditor</label>
              <select value={auditorAgent} onChange={(e) => setAuditorAgent((e.target as HTMLSelectElement).value)}>
                {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div class="mode-tabs">
            {(['task', 'issue', 'continuous'] as Mode[]).map((m) => (
              <button
                key={m}
                class={`mode-tab${mode === m ? ' mode-tab--active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m === 'task' ? 'One-Time Task' : m === 'issue' ? 'Pick Issue' : 'Continuous'}
              </button>
            ))}
          </div>

          {mode === 'task' && (
            <div class="form-group">
              <label>Task Description</label>
              <textarea
                value={task}
                onInput={(e) => setTask((e.target as HTMLTextAreaElement).value)}
                placeholder="Describe the task to fix or implement…"
                rows={4}
              />
            </div>
          )}

          {(mode === 'issue' || mode === 'continuous') && (
            <div class="issue-picker">
              {loadingIssues ? (
                <div class="loading">Loading issues…</div>
              ) : issues.length === 0 ? (
                <div class="empty-state">No open issues found in tracker.</div>
              ) : (
                <div class="issue-list">
                  {mode === 'continuous' && (
                    <p class="info">Continuous mode will process issues in priority order automatically.</p>
                  )}
                  {issues.map((issue) => (
                    <label key={issue.id} class={`issue-item${selectedIssue === issue.id ? ' issue-item--selected' : ''}`}>
                      {mode === 'issue' && (
                        <input
                          type="radio"
                          name="issue"
                          value={issue.id}
                          checked={selectedIssue === issue.id}
                          onChange={() => setSelectedIssue(issue.id)}
                        />
                      )}
                      <span class="priority-badge" style={{ color: priorityColors[issue.priority] }}>
                        {priorityLabels[issue.priority]}
                      </span>
                      <span class="issue-title">#{issue.id} {issue.title}</span>
                      {issue.assignee && <span class="issue-assignee">@{issue.assignee}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <div class="error">{error}</div>}

          <button
            class="btn btn-primary"
            onClick={handleStart}
            disabled={starting || (mode === 'task' && !task) || (mode === 'issue' && !selectedIssue)}
          >
            {starting ? 'Starting…' : 'Start Auto-Fix'}
          </button>
        </div>
      )}
    </div>
  );
}
