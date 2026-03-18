import { useEffect, useState } from 'preact/hooks';

interface ProjectSummary {
  name: string;
  dir: string;
  status: 'idle' | 'running' | 'auto-fix' | 'error';
  trackerType?: 'github' | 'gitlab' | null;
  activeSessions: number;
  lastActivity?: number;
}

interface ProjectListProps {
  apiKey: string;
  serverId: string;
  onSelect: (name: string) => void;
  onAdd: () => void;
}

export function ProjectList({ apiKey, serverId, onSelect, onAdd }: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects();
  }, [serverId]);

  async function fetchProjects() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/server/${serverId}/projects`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as ProjectSummary[];
      setProjects(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div class="loading">Loading projects…</div>;
  if (error) return <div class="error">Failed to load projects: {error}</div>;

  return (
    <div class="project-list">
      <div class="project-list__header">
        <h2>Projects</h2>
        <button class="btn btn-primary" onClick={onAdd}>+ Add Project</button>
      </div>

      {projects.length === 0 && (
        <div class="empty-state">
          <p>No projects yet. Add one to get started.</p>
        </div>
      )}

      <div class="project-list__items">
        {projects.map((p) => (
          <div
            key={p.name}
            class={`project-card project-card--${p.status}`}
            onClick={() => onSelect(p.name)}
          >
            <div class="project-card__header">
              <span class="project-card__name">{p.name}</span>
              {p.trackerType && (
                <span class={`tracker-badge tracker-badge--${p.trackerType}`}>
                  {p.trackerType}
                </span>
              )}
              <span class={`status-badge status-badge--${p.status}`}>
                {p.status}
              </span>
            </div>

            <div class="project-card__meta">
              <span class="project-card__dir">{p.dir}</span>
              <span class="project-card__sessions">
                {p.activeSessions} active session{p.activeSessions !== 1 ? 's' : ''}
              </span>
              {p.lastActivity && (
                <span class="project-card__last-activity">
                  Last activity: {new Date(p.lastActivity).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
