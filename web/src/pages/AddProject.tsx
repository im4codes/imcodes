import { useState } from 'preact/hooks';

interface AddProjectProps {
  apiKey: string;
  serverId: string;
  onAdded: (name: string) => void;
  onCancel: () => void;
}

type TrackerType = 'none' | 'github' | 'gitlab';

export function AddProject({ apiKey, serverId, onAdded, onCancel }: AddProjectProps) {
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [trackerType, setTrackerType] = useState<TrackerType>('none');
  const [trackerApiUrl, setTrackerApiUrl] = useState('');
  const [trackerToken, setTrackerToken] = useState('');
  const [trackerRepo, setTrackerRepo] = useState('');
  const [trackerProjectId, setTrackerProjectId] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [coderAgent, setCoderAgent] = useState('claude-code');
  const [auditorAgent, setAuditorAgent] = useState('codex');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentTypes = ['claude-code', 'claude-code-sdk', 'codex', 'codex-sdk', 'copilot-sdk', 'cursor-headless', 'opencode', 'gemini', 'qwen'];

  async function validateTracker() {
    if (trackerType === 'none') return true;
    setValidating(true);
    setValidationError(null);
    try {
      const payload = {
        type: trackerType,
        apiUrl: trackerApiUrl || undefined,
        token: trackerToken,
        repo: trackerType === 'github' ? trackerRepo : undefined,
        projectId: trackerType === 'gitlab' ? trackerProjectId : undefined,
      };
      const res = await fetch(`/api/server/${serverId}/tracker/validate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setValidationError(data.error ?? 'Validation failed');
        return false;
      }
      return true;
    } catch (err) {
      setValidationError(String(err));
      return false;
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!name || !dir) return;

    if (trackerType !== 'none') {
      const valid = await validateTracker();
      if (!valid) return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        dir,
        coderAgent,
        auditorAgent,
        baseBranch,
        tracker: trackerType !== 'none' ? {
          type: trackerType,
          apiUrl: trackerApiUrl || undefined,
          token: trackerToken,
          repo: trackerType === 'github' ? trackerRepo : undefined,
          projectId: trackerType === 'gitlab' ? trackerProjectId : undefined,
        } : undefined,
      };
      const res = await fetch(`/api/server/${serverId}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      onAdded(name);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="add-project">
      <h2>Add Project</h2>
      <form onSubmit={handleSubmit} class="form">
        <div class="form-group">
          <label>Project Name</label>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="my-project"
            required
          />
        </div>

        <div class="form-group">
          <label>Working Directory</label>
          <input
            type="text"
            value={dir}
            onInput={(e) => setDir((e.target as HTMLInputElement).value)}
            placeholder="/home/user/projects/my-project"
            required
          />
        </div>

        <div class="form-group">
          <label>Base Branch</label>
          <input
            type="text"
            value={baseBranch}
            onInput={(e) => setBaseBranch((e.target as HTMLInputElement).value)}
            placeholder="main"
          />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Coder Agent</label>
            <select value={coderAgent} onChange={(e) => setCoderAgent((e.target as HTMLSelectElement).value)}>
              {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div class="form-group">
            <label>Auditor Agent</label>
            <select value={auditorAgent} onChange={(e) => setAuditorAgent((e.target as HTMLSelectElement).value)}>
              {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>Issue Tracker</label>
          <select value={trackerType} onChange={(e) => setTrackerType((e.target as HTMLSelectElement).value as TrackerType)}>
            <option value="none">None</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </div>

        {trackerType !== 'none' && (
          <div class="tracker-config">
            <div class="form-group">
              <label>API URL (leave empty for hosted)</label>
              <input
                type="text"
                value={trackerApiUrl}
                onInput={(e) => setTrackerApiUrl((e.target as HTMLInputElement).value)}
                placeholder={trackerType === 'github' ? 'https://api.github.com' : 'https://gitlab.com'}
              />
            </div>
            <div class="form-group">
              <label>API Token</label>
              <input
                type="password"
                value={trackerToken}
                onInput={(e) => setTrackerToken((e.target as HTMLInputElement).value)}
                placeholder={trackerType === 'github' ? 'ghp_...' : 'glpat_...'}
                required
              />
            </div>
            {trackerType === 'github' && (
              <div class="form-group">
                <label>Repository (owner/repo)</label>
                <input
                  type="text"
                  value={trackerRepo}
                  onInput={(e) => setTrackerRepo((e.target as HTMLInputElement).value)}
                  placeholder="myorg/myrepo"
                  required
                />
              </div>
            )}
            {trackerType === 'gitlab' && (
              <div class="form-group">
                <label>Project ID or path (namespace/project)</label>
                <input
                  type="text"
                  value={trackerProjectId}
                  onInput={(e) => setTrackerProjectId((e.target as HTMLInputElement).value)}
                  placeholder="123 or mygroup/myproject"
                  required
                />
              </div>
            )}
            {validationError && <div class="error">{validationError}</div>}
          </div>
        )}

        {error && <div class="error">{error}</div>}

        <div class="form-actions">
          <button type="button" class="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={saving || validating}>
            {saving ? 'Adding…' : validating ? 'Validating…' : 'Add Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
