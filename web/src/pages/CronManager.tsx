import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';
import type { CronAction, CronJobStatus } from '@shared/cron-types';
import { CRON_STATUS } from '@shared/cron-types';
import { BUILT_IN_MODES } from '@shared/p2p-modes';
import type { SessionInfo } from '../types.js';
import { formatLabel } from '../format-label.js';
import { FloatingPanel } from '../components/FloatingPanel.js';

// ── Types ────────────────────────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  cron_expr: string;
  project_name: string;
  target_role: string;
  target_session_name?: string | null;
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

interface SubSessionSlim {
  sessionName: string;
  type: string;
  label?: string | null;
  state: string;
  parentSession?: string | null;
}

interface Props {
  serverId: string;
  projectName: string;
  sessions: SessionInfo[];
  subSessions?: SubSessionSlim[];
  activeSession?: string | null;
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

/** Get main sessions (brain + workers) for a specific project, excluding sub-sessions. */
function mainSessions(sessions: SessionInfo[], projectName: string): SessionInfo[] {
  return sessions.filter(s => /^(brain|w\d+)$/.test(s.role) && !s.name.startsWith('deck_sub_') && s.project === projectName);
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

/** Resolve a role to its display label from sessions list, scoped to project. */
function roleToDisplay(role: string, sessions: SessionInfo[], projectName?: string): string {
  const s = sessions.find(x => x.role === role && !x.name.startsWith('deck_sub_') && (!projectName || x.project === projectName));
  if (!s) return role;
  return `${sessionDisplayLabel(s)} (${agentBadge(s.agentType)})`;
}

// ── Component ────────────────────────────────────────────────────────────

export function CronManager({ serverId, projectName, sessions, subSessions = [], activeSession: _activeSession, onBack: _onBack }: Props) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(() => localStorage.getItem('rcc_cron_show_all') === '1');
  // Sub-panel state: 'form' for create/edit, 'history:jobId' for execution log
  const [subPanel, setSubPanel] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [historyData, setHistoryData] = useState<Record<string, CronExecution[]>>({});

  const toggleShowAll = () => {
    setShowAll(prev => { const v = !prev; localStorage.setItem('rcc_cron_show_all', v ? '1' : ''); return v; });
  };

  // ── Load jobs ──────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    try {
      const q = showAll ? `serverId=${serverId}` : `serverId=${serverId}&projectName=${projectName}`;
      const res = await apiFetch<{ jobs: CronJob[] }>(`/api/cron?${q}`);
      setJobs(res.jobs);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, projectName, showAll]);

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
    setSubPanel('form');
  };

  const handleFormDone = () => {
    setSubPanel(null);
    setEditingJob(null);
    loadJobs();
  };

  const openHistory = async (jobId: string) => {
    setSubPanel(`history:${jobId}`);
    if (!historyData[jobId]) {
      try {
        const res = await apiFetch<{ executions: CronExecution[] }>(`/api/cron/${jobId}/executions?limit=20`);
        setHistoryData(prev => ({ ...prev, [jobId]: res.executions }));
      } catch { /* ignore */ }
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const eligible = mainSessions(sessions, projectName);
  // Sub-sessions scoped to this project's main sessions
  const mainNames = new Set(eligible.map(s => s.name));
  const scopedSubs = subSessions.filter(s => s.parentSession && mainNames.has(s.parentSession));

  const historyJobId = subPanel?.startsWith('history:') ? subPanel.slice(8) : null;
  const historyJob = historyJobId ? jobs.find(j => j.id === historyJobId) : null;

  const displayTarget = (job: CronJob) => {
    if (job.target_session_name) {
      const sub = subSessions.find(s => s.sessionName === job.target_session_name);
      return sub?.label ? formatLabel(sub.label) : job.target_session_name.replace('deck_sub_', '');
    }
    return roleToDisplay(job.target_role, sessions, job.project_name);
  };

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '12px 20px' }}>
      {/* Toolbar: show-all toggle + add button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <label style={{ color: '#94a3b8', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input type="checkbox" checked={showAll} onChange={toggleShowAll} />
          {t('cron.show_all_projects')}
        </label>
        <div style={{ flex: 1 }} />
        <button onClick={() => { setEditingJob(null); setSubPanel('form'); }}
          style={{ padding: '3px 10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
          title={t('cron.create')}>+</button>
      </div>

      {error && <div style={{ color: '#f87171', marginBottom: '8px', fontSize: '13px' }}>{error}</div>}

      {loading && <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px' }}>{t('common.loading')}</div>}

      {!loading && jobs.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: '40px' }}>{t('cron.no_tasks')}</div>
      )}

      {jobs.map(job => {
        const action = parseAction(job.action);
        return (
          <div key={job.id} style={{ ...cardStyle, padding: '12px 16px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '14px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</span>
              {showAll && <span style={{ color: '#64748b', fontSize: '11px', flexShrink: 0 }}>{job.project_name}</span>}
              <span style={{ color: statusColors[job.status] ?? '#94a3b8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', flexShrink: 0 }}>
                {t(`cron.${job.status}`)}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#94a3b8', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{job.cron_expr}</span>
              <span>→ {displayTarget(job)}</span>
              {action?.type === 'p2p' && <span style={{ opacity: 0.6 }}>P2P {action.mode}</span>}
              {action?.type === 'command' && <span style={{ opacity: 0.6, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{action.command}</span>}
            </div>

            <div style={{ display: 'flex', gap: '6px', fontSize: '12px' }}>
              {(job.status === CRON_STATUS.ACTIVE || job.status === CRON_STATUS.PAUSED) && (
                <button onClick={() => handlePauseResume(job)} style={{ ...btnSecondary, padding: '3px 8px', fontSize: '12px' }}>
                  {job.status === CRON_STATUS.ACTIVE ? t('cron.pause') : t('cron.resume')}
                </button>
              )}
              <button onClick={() => handleEdit(job)} style={{ ...btnSecondary, padding: '3px 8px', fontSize: '12px' }}>✎</button>
              <button onClick={() => handleDelete(job)} style={{ ...btnDanger, padding: '3px 8px', fontSize: '12px' }}>✕</button>
              <button onClick={() => openHistory(job.id)} style={{ ...btnSecondary, padding: '3px 8px', fontSize: '12px', marginLeft: 'auto' }}>
                {t('cron.history')}
              </button>
            </div>
          </div>
        );
      })}

      {/* Sub-panel: Create/Edit form — FloatingPanel */}
      {subPanel === 'form' && (
        <FloatingPanel
          id="cron-form"
          title={editingJob ? t('cron.edit') : t('cron.create')}
          onClose={() => { setSubPanel(null); setEditingJob(null); }}
          defaultW={500} defaultH={600}
        >
          <div style={{ padding: '16px', overflow: 'auto', height: '100%' }}>
            <CronForm
              serverId={serverId}
              projectName={projectName}
              sessions={eligible}
              subSessions={scopedSubs}
              job={editingJob}
              onDone={handleFormDone}
              onCancel={() => { setSubPanel(null); setEditingJob(null); }}
            />
          </div>
        </FloatingPanel>
      )}

      {/* Sub-panel: Execution history — FloatingPanel */}
      {historyJobId && historyJob && (
        <FloatingPanel
          id={`cron-history-${historyJobId}`}
          title={`${t('cron.history')} · ${historyJob.name}`}
          onClose={() => setSubPanel(null)}
          defaultW={480} defaultH={400}
        >
          <div style={{ padding: '12px', overflow: 'auto', height: '100%' }}>
            {!historyData[historyJobId] && <div style={{ color: '#64748b', fontSize: '13px' }}>{t('common.loading')}</div>}
            {historyData[historyJobId]?.length === 0 && <div style={{ color: '#64748b', fontSize: '13px' }}>{t('cron.no_history')}</div>}
            {historyData[historyJobId]?.map(exec => (
              <div key={exec.id} style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#94a3b8', padding: '4px 0', borderBottom: '1px solid #1e293b' }}>
                <span style={{ minWidth: '140px' }}>{fmtTime(exec.created_at)}</span>
                <span style={{ color: exec.status === 'dispatched' ? '#4ade80' : exec.status === 'error' ? '#f87171' : '#fbbf24' }}>
                  {execStatusLabel(exec.status, t)}
                </span>
                {exec.detail && <span style={{ flex: 1, color: '#64748b' }}>{exec.detail}</span>}
              </div>
            ))}
          </div>
        </FloatingPanel>
      )}
    </div>
  );
}

// ── Cron Schedule Picker ─────────────────────────────────────────────────

const MINUTE_OPTS = ['0', '5', '10', '15', '20', '30', '45', '*/5', '*/10', '*/15', '*/30'];
const HOUR_OPTS = ['*', ...Array.from({ length: 24 }, (_, i) => String(i))];
const DOM_OPTS = ['*', ...Array.from({ length: 31 }, (_, i) => String(i + 1))];
const MONTH_OPTS = ['*', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const DOW_OPTS = [
  { value: '*', label: 'Any' },
  { value: '1-5', label: 'Weekdays' },
  { value: '0,6', label: 'Weekends' },
  { value: '1', label: 'Mon' }, { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' }, { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' }, { value: '6', label: 'Sat' }, { value: '0', label: 'Sun' },
];

/** Check if all 5 fields can be represented by the picker dropdowns. */
function isPickerCompatible(expr: string): boolean {
  const p = parseCronParts(expr);
  if (!p) return false;
  const dowValues = DOW_OPTS.map(w => w.value);
  return MINUTE_OPTS.includes(p.minute)
    && HOUR_OPTS.includes(p.hour)
    && DOM_OPTS.includes(p.dom)
    && MONTH_OPTS.includes(p.month)
    && dowValues.includes(p.dow);
}

const PRESETS = [
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9am', value: '0 9 * * 1' },
];

function parseCronParts(expr: string): { minute: string; hour: string; dom: string; month: string; dow: string } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

interface CronPickerProps {
  value: string;
  onChange: (v: string) => void;
  t: (key: string) => string;
}

function CronSchedulePicker({ value, onChange, t }: CronPickerProps) {
  const [mode, setMode] = useState<'picker' | 'advanced'>(() =>
    isPickerCompatible(value) ? 'picker' : 'advanced',
  );

  const parts = parseCronParts(value) ?? { minute: '0', hour: '9', dom: '*', month: '*', dow: '*' };

  const update = (field: string, val: string) => {
    const p = { ...parts, [field]: val };
    onChange(`${p.minute} ${p.hour} ${p.dom} ${p.month} ${p.dow}`);
  };

  /** Build options list, injecting the current value if it's not in the standard list. */
  const withCurrent = (opts: string[], current: string) =>
    opts.includes(current) ? opts : [...opts, current];

  const selectStyle: Record<string, string> = {
    padding: '6px 8px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: '6px', color: '#e2e8f0', fontSize: '13px', appearance: 'auto',
    flex: '1', minWidth: '0',
  };
  const fieldLabel: Record<string, string> = { fontSize: '11px', color: '#64748b', marginBottom: '2px' };

  const minuteLabel = (m: string) => m.startsWith('*/') ? m : (m === '0' ? ':00' : `:${m.padStart(2, '0')}`);
  const hourLabel = (h: string) => h === '*' ? t('cron.every_hour') : `${h.padStart(2, '0')}:00`;

  const dowValues = DOW_OPTS.map(w => w.value);
  const currentDowInList = dowValues.includes(parts.dow);

  return (
    <div style={{ marginBottom: '10px' }}>
      {/* Mode toggle + presets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <button type="button" onClick={() => setMode(m => m === 'picker' ? 'advanced' : 'picker')}
          style={{ padding: '3px 8px', background: '#334155', color: '#94a3b8', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}>
          {mode === 'picker' ? t('cron.mode_advanced') : t('cron.mode_picker')}
        </button>
        {mode === 'picker' && (
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <button key={p.value} type="button" onClick={() => onChange(p.value)}
                style={{ padding: '2px 6px', background: value === p.value ? '#3b82f6' : '#1e293b', color: value === p.value ? '#fff' : '#94a3b8', border: '1px solid #334155', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === 'advanced' ? (
        <>
          <input style={inputStyle} value={value} onInput={e => onChange((e.target as HTMLInputElement).value)} placeholder="0 9 * * 1-5" required />
          <div style={{ color: '#64748b', fontSize: '11px', marginTop: '-6px', marginBottom: '4px' }}>
            {t('cron.advanced_help')}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: '8px' }}>
          {/* Minute */}
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>{t('cron.field_minute')}</div>
            <select style={selectStyle} value={parts.minute} onChange={e => update('minute', (e.target as HTMLSelectElement).value)}>
              {withCurrent(MINUTE_OPTS, parts.minute).map(m => <option key={m} value={m}>{minuteLabel(m)}</option>)}
            </select>
          </div>
          {/* Hour */}
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>{t('cron.field_hour')}</div>
            <select style={selectStyle} value={parts.hour} onChange={e => update('hour', (e.target as HTMLSelectElement).value)}>
              {withCurrent(HOUR_OPTS, parts.hour).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          {/* Day of month */}
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>{t('cron.field_day')}</div>
            <select style={selectStyle} value={parts.dom} onChange={e => update('dom', (e.target as HTMLSelectElement).value)}>
              {withCurrent(DOM_OPTS, parts.dom).map(d => <option key={d} value={d}>{d === '*' ? t('cron.any') : d}</option>)}
            </select>
          </div>
          {/* Month */}
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>{t('cron.field_month')}</div>
            <select style={selectStyle} value={parts.month} onChange={e => update('month', (e.target as HTMLSelectElement).value)}>
              {withCurrent(MONTH_OPTS, parts.month).map(m => <option key={m} value={m}>{m === '*' ? t('cron.any') : m}</option>)}
            </select>
          </div>
          {/* Day of week */}
          <div style={{ flex: 1.3 }}>
            <div style={fieldLabel}>{t('cron.field_weekday')}</div>
            <select style={selectStyle} value={parts.dow} onChange={e => update('dow', (e.target as HTMLSelectElement).value)}>
              {DOW_OPTS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              {!currentDowInList && <option value={parts.dow}>{parts.dow}</option>}
            </select>
          </div>
        </div>
      )}

      {/* Preview: show the raw expression */}
      {mode === 'picker' && (
        <div style={{ color: '#64748b', fontSize: '11px', marginTop: '6px', fontFamily: 'monospace' }}>
          {value || '—'}
        </div>
      )}
    </div>
  );
}

// ── Create/Edit Form ─────────────────────────────────────────────────────

interface CronFormProps {
  serverId: string;
  projectName: string;
  sessions: SessionInfo[];
  subSessions?: SubSessionSlim[];
  job: CronJob | null; // null = create, non-null = edit
  onDone: () => void;
  onCancel: () => void;
}

function CronForm({ serverId, projectName, sessions, subSessions = [], job, onDone, onCancel }: CronFormProps) {
  const { t } = useTranslation();
  const isEdit = !!job;
  const existingAction = job ? parseAction(job.action) : null;

  const [name, setName] = useState(job?.name ?? '');
  const [cronExpr, setCronExpr] = useState(job?.cron_expr ?? '');
  const [targetRole, setTargetRole] = useState(job?.target_role ?? 'brain');
  const [targetSessionName, setTargetSessionName] = useState<string | null>(job?.target_session_name ?? null);
  const [actionType, setActionType] = useState<'command' | 'p2p'>(existingAction?.type ?? 'command');
  const [command, setCommand] = useState(existingAction?.type === 'command' ? existingAction.command : '');
  const [p2pTopic, setP2pTopic] = useState(existingAction?.type === 'p2p' ? existingAction.topic : '');
  const [p2pMode, setP2pMode] = useState(existingAction?.type === 'p2p' ? existingAction.mode : 'discuss');
  const [p2pParticipants, setP2pParticipants] = useState<string[]>(() => {
    if (existingAction?.type !== 'p2p') return [];
    const fromLegacy = existingAction.participants ?? [];
    const fromEntries = (existingAction.participantEntries ?? []).map(e => e.value);
    return [...new Set([...fromLegacy, ...fromEntries])];
  });
  const [p2pRounds, setP2pRounds] = useState(existingAction?.type === 'p2p' ? (existingAction.rounds ?? 1) : 1);
  const [expiresAt, setExpiresAt] = useState(job?.expires_at ? new Date(job.expires_at).toISOString().slice(0, 16) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Target selection: role:xxx for main sessions, sub:xxx for sub-sessions
  const targetValue = targetSessionName ? `sub:${targetSessionName}` : `role:${targetRole}`;
  const handleTargetChange = (val: string) => {
    if (val.startsWith('sub:')) {
      setTargetSessionName(val.slice(4));
      setTargetRole('brain'); // keep a default role for backward compat
    } else {
      setTargetSessionName(null);
      setTargetRole(val.slice(5)); // strip 'role:' prefix
    }
  };

  // Build participant entries: discriminated format for API
  const buildParticipantEntries = () => {
    return p2pParticipants.map(id => {
      if (id.startsWith('deck_sub_')) return { type: 'session' as const, value: id };
      return { type: 'role' as const, value: id };
    });
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const entries = buildParticipantEntries();
    const hasSessionEntries = entries.some(e => e.type === 'session');

    const action: CronAction = actionType === 'command'
      ? { type: 'command', command }
      : {
          type: 'p2p', topic: p2pTopic, mode: p2pMode, rounds: p2pRounds,
          // When any session entries exist, use only participantEntries (avoids duplication).
          // Legacy participants field only for pure-role jobs (backward compat).
          ...(hasSessionEntries
            ? { participantEntries: entries }
            : { participants: entries.map(e => e.value) }),
        };

    const payload = {
      name,
      cronExpr,
      serverId,
      projectName,
      targetRole,
      targetSessionName: targetSessionName ?? null,
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

  const p2pModes = BUILT_IN_MODES.map(m => m.key);
  // All sessions except the selected target — include both main sessions and sub-sessions
  const otherMainSessions = sessions.filter(s => targetSessionName ? true : s.role !== targetRole);
  const otherSubSessions = subSessions.filter(s => s.sessionName !== targetSessionName);

  return (
    <div style={{ ...cardStyle, border: '1px solid #334155' }}>
      <h3 style={{ color: '#e2e8f0', margin: '0 0 16px', fontSize: '16px' }}>
        {isEdit ? t('cron.edit') : t('cron.create')}
      </h3>

      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>{t('cron.name')}</label>
        <input style={inputStyle} value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder={t('cron.name_placeholder')} required />

        <label style={labelStyle}>{t('cron.schedule')}</label>
        <CronSchedulePicker value={cronExpr} onChange={setCronExpr} t={t} />

        <label style={labelStyle}>{t('cron.target')}</label>
        <select style={{ ...inputStyle, appearance: 'auto' as string }} value={targetValue} onChange={e => handleTargetChange((e.target as HTMLSelectElement).value)}>
          {sessions.length === 0 && subSessions.length === 0 && <option value="role:brain">brain</option>}
          {sessions.map(s => (
            <option key={s.name} value={`role:${s.role}`}>
              {sessionDisplayLabel(s)} ({agentBadge(s.agentType)})
            </option>
          ))}
          {subSessions.length > 0 && <option disabled>──────────</option>}
          {subSessions.map(s => (
            <option key={s.sessionName} value={`sub:${s.sessionName}`}>
              {s.label ? formatLabel(s.label) : s.sessionName.replace('deck_sub_', '')} ({agentBadge(s.type)})
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
              {otherMainSessions.map(s => (
                <label key={s.name} style={{ color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    type="checkbox"
                    checked={p2pParticipants.includes(s.role)}
                    onChange={() => setP2pParticipants(prev => prev.includes(s.role) ? prev.filter(x => x !== s.role) : [...prev, s.role])}
                  />
                  {sessionDisplayLabel(s)} <span style={{ opacity: 0.5, fontSize: '11px' }}>({agentBadge(s.agentType)})</span>
                </label>
              ))}
              {otherSubSessions.map(s => (
                <label key={s.sessionName} style={{ color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    type="checkbox"
                    checked={p2pParticipants.includes(s.sessionName)}
                    onChange={() => setP2pParticipants(prev => prev.includes(s.sessionName) ? prev.filter(x => x !== s.sessionName) : [...prev, s.sessionName])}
                  />
                  {s.label ? formatLabel(s.label) : s.sessionName.replace('deck_sub_', '')} <span style={{ opacity: 0.5, fontSize: '11px' }}>({agentBadge(s.type)})</span>
                </label>
              ))}
              {otherMainSessions.length === 0 && otherSubSessions.length === 0 && <span style={{ color: '#64748b', fontSize: '13px' }}>{t('cron.no_participants')}</span>}
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
