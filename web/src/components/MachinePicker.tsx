import { useTranslation } from 'react-i18next';
import { isServerOnline } from '../server-selection.js';
import type { DaemonMachine } from '../hooks/useDaemonMachines.js';

/** Which machine a management panel is showing. */
export function MachineSelect({ machines, value, onChange, label }: {
  machines: DaemonMachine[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <label>
      <span class="capability-muted">{label}</span>{' '}
      <select
        value={value ?? ''}
        onChange={(event) => onChange((event.target as HTMLSelectElement).value || undefined)}
        aria-label={label}
      >
        {machines.map((machine) => (
          <option key={machine.id} value={machine.id}>
            {isServerOnline(machine)
              ? machine.name
              : t('sharedContext.management.agentSkills.machineOffline', { name: machine.name })}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Tick the online machines an install goes to. */
export function MachineTargets({ machines, targets, onToggle, legend }: {
  machines: DaemonMachine[];
  targets: Set<string>;
  onToggle: (id: string) => void;
  legend: string;
}) {
  return (
    <fieldset class="capability-binding-list">
      <legend class="capability-muted">{legend}</legend>
      {machines.map((machine) => (
        <label key={machine.id} class="capability-binding-row">
          <input type="checkbox" checked={targets.has(machine.id)} onChange={() => onToggle(machine.id)} />
          <span>{machine.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
