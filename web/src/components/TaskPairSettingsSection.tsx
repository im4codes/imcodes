import { useTranslation } from 'react-i18next';
import {
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  TASK_PAIR_MAX_CONCURRENCY_CAP,
  TASK_PAIR_ENGINES,
  type TaskPairEngine,
} from '@shared/task-pair.js';

/** The select's "nothing chosen" value: an unconfigured project is inert, not `pairs`. */
const ENGINE_UNSET = '';

export interface TaskPairSettingsValue {
  pairEngine?: TaskPairEngine;
  pairMaxConcurrency?: number;
}

const labelStyle = { fontSize: 12, color: '#94a3b8', marginBottom: 4 } as const;
const helpStyle = { fontSize: 11, color: '#64748b', marginBottom: 6 } as const;

/**
 * Project-Brain settings of the marker-driven task-pair engine. Who does
 * executor/auditor work is not configured here -- it is the execution
 * pool's per-entry role, in the pool editor above this section.
 */
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
  const max = Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, value.pairMaxConcurrency ?? TASK_PAIR_DEFAULT_MAX_CONCURRENCY);
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
          max={TASK_PAIR_MAX_CONCURRENCY_CAP}
          data-testid="task-pair-max-concurrency"
          value={String(max)}
          disabled={disabled}
          onInput={(e) => {
            const parsed = Number.parseInt((e.target as HTMLInputElement).value, 10);
            onChange({ ...value, pairMaxConcurrency: Number.isFinite(parsed) && parsed >= 1 ? Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, parsed) : TASK_PAIR_DEFAULT_MAX_CONCURRENCY });
          }}
        />
      </label>
    </div>
  );
}
