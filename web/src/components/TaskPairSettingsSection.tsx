import { useTranslation } from 'react-i18next';
import {
  TASK_PAIR_ALLOWLIST_ROLES,
  TASK_PAIR_DEFAULT_ALLOWLIST,
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  TASK_PAIR_ENGINES,
  type TaskPairAllowlistEntry,
  type TaskPairAllowlistRole,
  type TaskPairEngine,
} from '@shared/task-pair.js';

/** The select's "nothing chosen" value: an unconfigured project is inert, not `pairs`. */
const ENGINE_UNSET = '';

export interface TaskPairSettingsValue {
  pairEngine?: TaskPairEngine;
  pairAllowlist?: TaskPairAllowlistEntry[];
  pairMaxConcurrency?: number;
}

const labelStyle = { fontSize: 12, color: '#94a3b8', marginBottom: 4 } as const;
const helpStyle = { fontSize: 11, color: '#64748b', marginBottom: 6 } as const;

/** Project-Brain settings of the marker-driven task-pair engine. */
export function TaskPairSettingsSection({
  value,
  disabled,
  onChange,
}: {
  value: TaskPairSettingsValue;
  disabled?: boolean;
  onChange: (next: TaskPairSettingsValue) => void;
}) {
  const { t } = useTranslation();
  // Legacy is retained in stored snapshots for migration but is not a
  // selectable/live engine; render it as the inert unset state.
  const engine = value.pairEngine === 'legacy' ? ENGINE_UNSET : (value.pairEngine ?? ENGINE_UNSET);
  const allowlist = value.pairAllowlist ?? TASK_PAIR_DEFAULT_ALLOWLIST.map((entry) => ({ ...entry }));
  const max = value.pairMaxConcurrency ?? TASK_PAIR_DEFAULT_MAX_CONCURRENCY;
  const setAllowlist = (next: TaskPairAllowlistEntry[]) => onChange({ ...value, pairAllowlist: next });
  const updateEntry = (index: number, patch: Partial<TaskPairAllowlistEntry>) => {
    setAllowlist(allowlist.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  return (
    <div class="session-settings-task-pairs" data-testid="task-pair-settings">
      <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600, marginBottom: 6 }}>{t('taskPair.settings.title')}</div>
      <div style={helpStyle}>{t('taskPair.settings.help')}</div>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <div style={labelStyle}>{t('taskPair.settings.engine')}</div>
        <select
          data-testid="task-pair-engine"
          value={engine}
          disabled={disabled}
          onInput={(e) => {
            const next = (e.target as HTMLSelectElement).value;
            onChange({ ...value, pairEngine: next === ENGINE_UNSET ? undefined : (next as TaskPairEngine) });
          }}
        >
          <option value={ENGINE_UNSET}>{t('taskPair.settings.engine_unset')}</option>
          {TASK_PAIR_ENGINES.map((option) => (
            <option key={option} value={option}>{t(`taskPair.settings.engine_${option}`)}</option>
          ))}
        </select>
        <div style={helpStyle}>{t('taskPair.settings.engine_help')}</div>
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <div style={labelStyle}>{t('taskPair.settings.max_concurrency')}</div>
        <input
          type="number"
          min={1}
          data-testid="task-pair-max-concurrency"
          value={String(max)}
          disabled={disabled}
          onInput={(e) => {
            const parsed = Number.parseInt((e.target as HTMLInputElement).value, 10);
            onChange({ ...value, pairMaxConcurrency: Number.isFinite(parsed) && parsed >= 1 ? parsed : TASK_PAIR_DEFAULT_MAX_CONCURRENCY });
          }}
        />
      </label>

      <div style={labelStyle}>{t('taskPair.settings.allowlist')}</div>
      <div style={helpStyle}>{t('taskPair.settings.allowlist_help')}</div>
      {allowlist.map((entry, index) => (
        <div key={index} data-testid={`task-pair-allowlist-row-${index}`} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <select
            aria-label={t('taskPair.settings.allowlist_role')}
            value={entry.role}
            disabled={disabled}
            onInput={(e) => updateEntry(index, { role: (e.target as HTMLSelectElement).value as TaskPairAllowlistRole })}
          >
            {TASK_PAIR_ALLOWLIST_ROLES.map((role) => (
              <option key={role} value={role}>{t(`taskPair.settings.role_${role}`)}</option>
            ))}
          </select>
          <input
            aria-label={t('taskPair.settings.agent_type')}
            placeholder={t('taskPair.settings.agent_type')}
            value={entry.agentType}
            disabled={disabled}
            onInput={(e) => updateEntry(index, { agentType: (e.target as HTMLInputElement).value.trim() })}
          />
          <input
            aria-label={t('taskPair.settings.model_pattern')}
            placeholder={t('taskPair.settings.model_pattern')}
            value={entry.modelPattern}
            disabled={disabled}
            onInput={(e) => updateEntry(index, { modelPattern: (e.target as HTMLInputElement).value.trim() })}
          />
          <button type="button" disabled={disabled} onClick={() => setAllowlist(allowlist.filter((_entry, i) => i !== index))}>
            {t('taskPair.settings.remove')}
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" data-testid="task-pair-allowlist-add" disabled={disabled} onClick={() => setAllowlist([...allowlist, { role: 'both', agentType: '', modelPattern: '' }])}>
          {t('taskPair.settings.add')}
        </button>
        <button type="button" disabled={disabled} onClick={() => setAllowlist(TASK_PAIR_DEFAULT_ALLOWLIST.map((entry) => ({ ...entry })))}>
          {t('taskPair.settings.reset')}
        </button>
      </div>
    </div>
  );
}
