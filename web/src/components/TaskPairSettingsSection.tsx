import { useTranslation } from 'react-i18next';
import {
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  type TaskPairEngine,
} from '@shared/task-pair.js';

export interface TaskPairSettingsValue {
  pairEngine?: TaskPairEngine;
  pairMaxConcurrency?: number;
}

const labelStyle = { fontSize: 12, color: '#94a3b8', marginBottom: 4 } as const;
const helpStyle = { fontSize: 11, color: '#64748b', marginBottom: 6 } as const;

/**
 * Project-Brain settings for parallel task-pair execution. Who does
 * executor/auditor work is configured by each execution pool entry's role
 * above this section; any persisted `pairEngine` is carried through unchanged.
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
  const max = value.pairMaxConcurrency ?? TASK_PAIR_DEFAULT_MAX_CONCURRENCY;
  return (
    <div class="session-settings-task-pairs" data-testid="task-pair-settings">
      <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600, marginBottom: 6 }}>{t('taskPair.settings.title')}</div>
      <div style={helpStyle}>{t('taskPair.settings.help')}</div>

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
    </div>
  );
}
