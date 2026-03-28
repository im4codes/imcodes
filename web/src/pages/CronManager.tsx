import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';
import type { CronAction, CronJobStatus } from '@shared/cron-types';
import { CRON_STATUS } from '@shared/cron-types';
import type { SessionInfo } from '../types.js';
import { formatLabel } from '../format-label.js';

// ── Types ────────────────────────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  cron_expr: string;
  project_name: string;
  target_role: string;
  action: string; // JSON string
  status: CronJobStatus;
  last_run_at: number | null;
  next_run_at: number | null;
  expires_at: number | null;
  created_at: number;
}

interface CronExecution {
  id: string;
  status: string;
  detail: string | null;
  created_at: number;
}

interface Props {
  serverId: string;
  projectName: string;
  sessions: SessionInfo[];
  onBack: () => void;
}

// ── Styles ───────────────────────────────────────────────────────────────

const cardStyle = { background: '#1e293b', borderRadius: '12px', padding: '20px', marginBottom: '16px' };
const inputStyle: Record<string, string> = { width: '100%', padding: '10px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', marginBottom: '10px', boxSizing: 'border-box' };
const btnPrimary: Record<string, string> = { padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: '600' };
const btnSecondary: Record<string, string> = { padding: '8px 16px', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' };
const btnDanger: Record<string, string> = { ...btnSecondary, color: '#f87171' };
const labelStyle = { display: 'block', color: '#94a3b8', fontSize: '13px', marginBottom: '4px', fontWeight: '500' as const };

// ── Helpers ──────────────────────────────────────────────────────────────

function parseAction(raw: string): CronAction | null {
  try { return JSON.parse(raw); } catch { return null; }
}

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const statusColors: Record<string, string> = {
  [CRON_STATUS.ACTIVE]: '#4ade80',
  [CRON_STATUS.PAUSED]: '#94a3b8',
  [CRON_STATUS.EXPIRED]: '#fbbf24',
  [CRON_STATUS.ERROR]: '#f87171',
};

function execStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'dispatched') return t('cron.status_sent');
  if (status === 'skipped_offline') return t('cron.status_skipped_offline');
  if (status === 'skipped_busy') return t('cron.status_skipped_busy');
  if (status === 'error') return t('cron.status_error');
  return status;
}

/** Get main sessions (brain + workers), excluding sub-sessions. */
function mainSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter(s => /^(brain|w\d+)$/.test(s.role) && !s.name.startsWith('deck_sub_'));
}

/** Display label for a session: label or project/W{N}, like P2P config panel. */
function sessionDisplayLabel(s: SessionInfo): string {
  if (s.label) return formatLabel(s.label);
  return s.role === 'brain' ? s.project : `W${s.name.split('_w')[1] ?? '?'}`;
}

/** Short agent type badge. */
const AGENT_ABBR: Record<string, string> = {
  'claude-code': 'cc', codex: 'cx', opencode: 'oc', gemini: 'gm', shell: 'sh',
};
function agentBadge(agentType: string): string {
  return AGENT_ABBR[agentType] ?? agentType.slice(0, 3);
}

/** Resolve a role to its display label from sessions list. */
function roleToDisplay(role: string, sessions: SessionInfo[]): string {
  const s = sessions.find(x => x.role === role && !x.name.startsWith('deck_sub_'));
  if (!s) return role;
  return `${sessionDisplayLabel(s)} (${agentBadge(s.agentType)})`;
}

// ── Component ────────────────────────────────────────────────────────────

export function CronManager({ serverId, projectName, sessions, onBack: _onBack }: Props) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<Record<string, CronExecution[]>>({});

  // ── Load jobs ──────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    try {
      const res = await apiFetch<{ jobs: CronJob[] }>(`/api/cron?serverId=${serverId}&projectName=${projectName}`);
      setJobs(res.jobs);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, projectName]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // ── Actions ────────────────────────────────────────────────────────────
  const handlePauseResume = async (job: CronJob) => {
    const newStatus = job.status === CRON_STATUS.ACTIVE ? CRON_STATUS.PAUSED : CRON_STATUS.ACTIVE;
    try {
      await apiFetch(`/api/cron/${job.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
      await loadJobs();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDelete = async (job: CronJob) => {
    if (!window.confirm(t('cron.confirm_delete'))) return;
    try {
      await apiFetch(`/api/cron/${job.id}`, { method: 'DELETE' });
      setJobs(prev => prev.filter(j => j.id !== job.id));
    } catch (err) {
      setError(String(err));
    }
  };

  const handleEdit = (job: CronJob) => {
    setEditingJob(job);
    setShowForm(true);
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingJob(null);
    loadJobs();
  };

  const toggleHistory = async (jobId: string) => {
    if (expandedHistory === jobId) {
      setExpandedHistory(null);
      return;
    }
    setExpandedHistory(jobId);
    if (!historyData[jobId]) {
      try {
        const res = await apiFetch<{ executions: CronExecution[] }>(`/api/cron/${jobId}/executions?limit=20`);
        setHistoryData(prev => ({ ...prev, [jobId]: res.executions }));
      } catch { /* ignore */ }
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const eligible = mainSessions(sessions);

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <div style={{ flex: 1 }} />
        {!showForm && (
          <button onClick={() => { setEditingJob(null); setShowForm(true); }} style={btnPrimary}>
            + {t('cron.create')}
          </button>
        )}
      </div>

      {error && <div style={{ color: '#f87171', marginBottom: '12px', fontSize: '13px' }}>{error}</div>}

      {showForm && (
        <CronForm
          serverId={serverId}
          projectName={projectName}
          sessions={eligible}
          job={editingJob}
          onDone={handleFormDone}
          onCancel={() => { setShowForm(false); setEditingJob(null); }}
        />
      )}

      {loading && <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px' }}>{t('common.loading')}</div>}

      {!loading && jobs.length === 0 && !showForm && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: '40px' }}>{t('cron.no_tasks')}</div>
      )}

      {jobs.map(job => {
        const action = parseAction(job.action);
        const isExpanded = expandedHistory === job.id;
        return (
          <div key={job.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '15px', flex: 1 }}>{job.name}</span>
              <span style={{ color: statusColors[job.status] ?? '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }}>
                {t(`cron.${job.status}`)}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: '13px', color: '#94a3b8', marginBottom: '10px' }}>
              <div>{t('cron.schedule')}: <span style={{ color: '#cbd5e1' }}>{job.cron_expr}</span></div>
              <div>{t('cron.target')}: <span style={{ color: '#cbd5e1' }}>{roleToDisplay(job.target_role, sessions)}</span></div>
              <div>{t('cron.last_run')}: <span style={{ color: '#cbd5e1' }}>{fmtTime(job.last_run_at)}</span></div>
              <div>{t('cron.next_run')}: <span style={{ color: '#cbd5e1' }}>{fmtTime(job.next_run_at)}</span></div>
              {job.expires_at && <div>{t('cron.expires_at')}: <span style={{ color: '#cbd5e1' }}>{fmtTime(job.expires_at)}</span></div>}
            </div>

            {action?.type === 'command' && (
              <div style={{ background: '#0f172a', borderRadius: '6px', padding: '8px 10px', fontSize: '13px', color: '#cbd5e1', marginBottom: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '80px', overflow: 'auto' }}>
                {action.command}
              </div>
            )}
            {action?.type === 'p2p' && (
              <div style={{ background: '#0f172a', borderRadius: '6px', padding: '8px 10px', fontSize: '13px', color: '#cbd5e1', marginBottom: '10px' }}>
                P2P: {action.topic} <span style={{ opacity: 0.6 }}>({action.mode}, {action.participants?.map(r => roleToDisplay(r, sessions)).join(', ')})</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {(job.status === CRON_STATUS.ACTIVE || job.status === CRON_STATUS.PAUSED) && (
                <button onClick={() => handlePauseResume(job)} style={btnSecondary}>
                  {job.status === CRON_STATUS.ACTIVE ? t('cron.pause') : t('cron.resume')}
                </button>
              )}
              <button onClick={() => handleEdit(job)} style={btnSecondary}>{t('cron.edit')}</button>
              <button onClick={() => handleDelete(job)} style={btnDanger}>{t('common.delete')}</button>
              <button onClick={() => toggleHistory(job.id)} style={{ ...btnSecondary, marginLeft: 'auto' }}>
                {t('cron.history')} {isExpanded ? '▲' : '▼'}
              </button>
            </div>

            {isExpanded && (
              <div style={{ marginTop: '10px', borderTop: '1px solid #334155', paddingTop: '10px' }}>
                {!historyData[job.id] && <div style={{ color: '#64748b', fontSize: '13px' }}>{t('common.loading')}</div>}
                {historyData[job.id]?.length === 0 && <div style={{ color: '#64748b', fontSize: '13px' }}>{t('cron.no_history')}</div>}
                {historyData[job.id]?.map(exec => (
                  <div key={exec.id} style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#94a3b8', padding: '3px 0' }}>
                    <span style={{ minWidth: '140px' }}>{fmtTime(exec.created_at)}</span>
                    <span style={{ color: exec.status === 'dispatched' ? '#4ade80' : exec.status === 'error' ? '#f87171' : '#fbbf24' }}>
                      {execStatusLabel(exec.status, t)}
                    </span>
                    {exec.detail && <span>{exec.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Create/Edit Form ─────────────────────────────────────────────────────

interface CronFormProps {
  serverId: string;
  projectName: string;
  sessions: SessionInfo[];
  job: CronJob | null; // null = create, non-null = edit
  onDone: () => void;
  onCancel: () => void;
}

function CronForm({ serverId, projectName, sessions, job, onDone, onCancel }: CronFormProps) {
  const { t } = useTranslation();
  const isEdit = !!job;
  const existingAction = job ? parseAction(job.action) : null;

  const [name, setName] = useState(job?.name ?? '');
  const [cronExpr, setCronExpr] = useState(job?.cron_expr ?? '');
  const [targetRole, setTargetRole] = useState(job?.target_role ?? 'brain');
  const [actionType, setActionType] = useState<'command' | 'p2p'>(existingAction?.type ?? 'command');
  const [command, setCommand] = useState(existingAction?.type === 'command' ? existingAction.command : '');
  const [p2pTopic, setP2pTopic] = useState(existingAction?.type === 'p2p' ? existingAction.topic : '');
  const [p2pMode, setP2pMode] = useState(existingAction?.type === 'p2p' ? existingAction.mode : 'discuss');
  const [p2pParticipants, setP2pParticipants] = useState<string[]>(existingAction?.type === 'p2p' ? existingAction.participants : []);
  const [p2pRounds, setP2pRounds] = useState(existingAction?.type === 'p2p' ? (existingAction.rounds ?? 1) : 1);
  const [expiresAt, setExpiresAt] = useState(job?.expires_at ? new Date(job.expires_at).toISOString().slice(0, 16) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const action: CronAction = actionType === 'command'
      ? { type: 'command', command }
      : { type: 'p2p', topic: p2pTopic, mode: p2pMode, participants: p2pParticipants, rounds: p2pRounds };

    const payload = {
      name,
      cronExpr,
      serverId,
      projectName,
      targetRole,
      action,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    };

    try {
      if (isEdit) {
        await apiFetch(`/api/cron/${job.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/cron', { method: 'POST', body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('cron_interval_too_short')) {
        setError(t('cron.interval_too_short'));
      } else if (msg.includes('invalid_cron_expression')) {
        setError(t('cron.invalid_cron'));
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const p2pModes = ['audit', 'review', 'discuss', 'brainstorm'];
  const otherSessions = sessions.filter(s => s.role !== targetRole);

  return (
    <div style={{ ...cardStyle, border: '1px solid #334155' }}>
      <h3 style={{ color: '#e2e8f0', margin: '0 0 16px', fontSize: '16px' }}>
        {isEdit ? t('cron.edit') : t('cron.create')}
      </h3>

      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>{t('cron.name')}</label>
        <input style={inputStyle} value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder={t('cron.name_placeholder')} required />

        <label style={labelStyle}>{t('cron.schedule')}</label>
        <input style={inputStyle} value={cronExpr} onInput={e => setCronExpr((e.target as HTMLInputElement).value)} placeholder="0 9 * * 1-5" required />
        <div style={{ color: '#64748b', fontSize: '11px', marginTop: '-6px', marginBottom: '10px' }}>{t('cron.schedule_help')}</div>

        <label style={labelStyle}>{t('cron.target')}</label>
        <select style={{ ...inputStyle, appearance: 'auto' as string }} value={targetRole} onChange={e => setTargetRole((e.target as HTMLSelectElement).value)}>
          {sessions.length === 0 && <option value="brain">brain</option>}
          {sessions.map(s => (
            <option key={s.role} value={s.role}>
              {sessionDisplayLabel(s)} ({agentBadge(s.agentType)})
            </option>
          ))}
        </select>

        <label style={labelStyle}>{t('cron.action_type')}</label>
        <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
          <label style={{ color: '#e2e8f0', fontSize: '14px', cursor: 'pointer' }}>
            <input type="radio" name="actionType" checked={actionType === 'command'} onChange={() => setActionType('command')} style={{ marginRight: '6px' }} />
            {t('cron.action_command')}
          </label>
          <label style={{ color: '#e2e8f0', fontSize: '14px', cursor: 'pointer' }}>
            <input type="radio" name="actionType" checked={actionType === 'p2p'} onChange={() => setActionType('p2p')} style={{ marginRight: '6px' }} />
            {t('cron.action_p2p')}
          </label>
        </div>

        {actionType === 'command' && (
          <>
            <label style={labelStyle}>{t('cron.command')}</label>
            <textarea
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' }}
              value={command}
              onInput={e => setCommand((e.target as HTMLTextAreaElement).value)}
              placeholder={t('cron.command_placeholder')}
              required
            />
          </>
        )}

        {actionType === 'p2p' && (
          <>
            <label style={labelStyle}>{t('cron.p2p_topic')}</label>
            <textarea
              style={{ ...inputStyle, minHeight: '60px', resize: 'vertical', fontFamily: 'inherit' }}
              value={p2pTopic}
              onInput={e => setP2pTopic((e.target as HTMLTextAreaElement).value)}
              placeholder={t('cron.p2p_topic_placeholder')}
              required
            />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={labelStyle}>{t('cron.p2p_mode')}</label>
                <select style={{ ...inputStyle, appearance: 'auto' as string }} value={p2pMode} onChange={e => setP2pMode((e.target as HTMLSelectElement).value)}>
                  {p2pModes.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('cron.p2p_rounds')}</label>
                <input type="number" min={1} max={6} style={inputStyle} value={p2pRounds} onInput={e => setP2pRounds(parseInt((e.target as HTMLInputElement).value) || 1)} />
              </div>
            </div>

            <label style={labelStyle}>{t('cron.p2p_participants')}</label>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {otherSessions.map(s => (
                <label key={s.role} style={{ color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    type="checkbox"
                    checked={p2pParticipants.includes(s.role)}
                    onChange={() => setP2pParticipants(prev => prev.includes(s.role) ? prev.filter(x => x !== s.role) : [...prev, s.role])}
                  />
                  {sessionDisplayLabel(s)} <span style={{ opacity: 0.5, fontSize: '11px' }}>({agentBadge(s.agentType)})</span>
                </label>
              ))}
              {otherSessions.length === 0 && <span style={{ color: '#64748b', fontSize: '13px' }}>No other sessions available</span>}
            </div>
          </>
        )}

        <label style={labelStyle}>{t('cron.expires_at')}</label>
        <input
          type="datetime-local"
          style={inputStyle}
          value={expiresAt}
          onInput={e => setExpiresAt((e.target as HTMLInputElement).value)}
        />
        <div style={{ color: '#64748b', fontSize: '11px', marginTop: '-6px', marginBottom: '10px' }}>{t('cron.expires_never')}</div>

        {error && <div style={{ color: '#f87171', fontSize: '13px', marginBottom: '10px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={btnSecondary}>{t('cron.cancel')}</button>
          <button type="submit" disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? t('common.loading') : t('cron.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
