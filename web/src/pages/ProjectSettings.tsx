import { useState, useEffect } from 'preact/hooks';

interface ProjectSettings {
  name: string;
  coderAgent: string;
  auditorAgent: string;
  baseBranch: string;
  maxDiscussionRounds: number;
  autoMerge: boolean;
  issueFilters?: {
    labels?: string[];
    assignedToMe?: boolean;
    milestone?: string;
  };
  autoFixMode?: 'one-time' | 'continuous';
}

interface ProjectSettingsProps {
  apiKey: string;
  serverId: string;
  projectName: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function ProjectSettings({ apiKey, serverId, projectName, onSaved, onCancel }: ProjectSettingsProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const agentTypes = ['claude-code', 'claude-code-sdk', 'codex', 'codex-sdk', 'copilot-sdk', 'cursor-headless', 'opencode', 'gemini', 'qwen'];

  useEffect(() => {
    fetch(`/api/server/${serverId}/projects/${projectName}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json() as Promise<ProjectSettings>)
      .then(setSettings)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectName]);

  async function handleSave(e: Event) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/server/${serverId}/projects/${projectName}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function update(patch: Partial<ProjectSettings>) {
    setSettings((s) => s ? { ...s, ...patch } : s);
  }

  if (loading) return <div class="loading">Loading settings…</div>;
  if (!settings) return <div class="error">Failed to load: {error}</div>;

  return (
    <div class="project-settings">
      <h2>Settings — {projectName}</h2>
      <form onSubmit={handleSave} class="form">
        <div class="form-group">
          <label>Base Branch</label>
          <input
            type="text"
            value={settings.baseBranch}
            onInput={(e) => update({ baseBranch: (e.target as HTMLInputElement).value })}
          />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Coder Agent</label>
            <select value={settings.coderAgent} onChange={(e) => update({ coderAgent: (e.target as HTMLSelectElement).value })}>
              {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div class="form-group">
            <label>Auditor Agent</label>
            <select value={settings.auditorAgent} onChange={(e) => update({ auditorAgent: (e.target as HTMLSelectElement).value })}>
              {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>Max Discussion Rounds</label>
          <input
            type="number"
            min={1}
            max={10}
            value={settings.maxDiscussionRounds}
            onInput={(e) => update({ maxDiscussionRounds: parseInt((e.target as HTMLInputElement).value, 10) })}
          />
        </div>

        <div class="form-group form-group--checkbox">
          <label>
            <input
              type="checkbox"
              checked={settings.autoMerge}
              onChange={(e) => update({ autoMerge: (e.target as HTMLInputElement).checked })}
            />
            Auto-merge on approval
          </label>
        </div>

        <div class="form-group">
          <label>Auto-Fix Mode</label>
          <select value={settings.autoFixMode ?? 'one-time'} onChange={(e) => update({ autoFixMode: (e.target as HTMLSelectElement).value as 'one-time' | 'continuous' })}>
            <option value="one-time">One-time</option>
            <option value="continuous">Continuous</option>
          </select>
        </div>

        <fieldset class="form-group">
          <legend>Issue Filters</legend>
          <div class="form-group">
            <label>Labels (comma-separated)</label>
            <input
              type="text"
              value={(settings.issueFilters?.labels ?? []).join(', ')}
              onInput={(e) => update({ issueFilters: {
                ...settings.issueFilters,
                labels: (e.target as HTMLInputElement).value.split(',').map((l) => l.trim()).filter(Boolean),
              }})}
            />
          </div>
          <div class="form-group form-group--checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings.issueFilters?.assignedToMe ?? false}
                onChange={(e) => update({ issueFilters: {
                  ...settings.issueFilters,
                  assignedToMe: (e.target as HTMLInputElement).checked,
                }})}
              />
              Assigned to me only
            </label>
          </div>
        </fieldset>

        {error && <div class="error">{error}</div>}

        <div class="form-actions">
          <button type="button" class="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
