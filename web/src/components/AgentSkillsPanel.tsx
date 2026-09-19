import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  AGENT_SKILLS_ACTION,
  AGENT_SKILLS_ERROR,
  isAgentSkillSource,
  type AgentSkillEntry,
} from '@shared/agent-skills.js';
import { apiFetch } from '../api.js';
import { listAgentSkills, runAgentSkills, type AgentSkillsRunResult } from '../api/agent-skills.js';
import { isServerOnline, type OnlineServerInfo } from '../server-selection.js';

interface Props {
  /** The machine the panel opens on. */
  serverId?: string;
}

interface Machine extends OnlineServerInfo {
  name: string;
}

interface MachineResult extends AgentSkillsRunResult {
  serverId: string;
}

const KNOWN_ERRORS = new Set<string>([...Object.values(AGENT_SKILLS_ERROR), 'forbidden', 'not_found']);

/**
 * Agent Skills are the files in each machine's `~/.agents/skills`, which every
 * agent on that machine already reads. This panel lists them per machine and
 * runs the `skills` CLI there: install on any set of machines at once, update,
 * remove.
 */
export function AgentSkillsPanel({ serverId }: Props) {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState<string | undefined>(serverId);
  const [skills, setSkills] = useState<AgentSkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [source, setSource] = useState('');
  const [targets, setTargets] = useState<Set<string>>(() => new Set(serverId ? [serverId] : []));
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<MachineResult[]>([]);

  useEffect(() => {
    void apiFetch<{ servers?: Machine[] }>('/api/server')
      .then((response) => setMachines(Array.isArray(response.servers) ? response.servers : []))
      .catch(() => setMachines([]));
  }, []);

  useEffect(() => {
    setMachineId(serverId);
    setTargets(new Set(serverId ? [serverId] : []));
  }, [serverId]);

  const load = useCallback(async () => {
    if (!machineId) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      setSkills(await listAgentSkills(machineId));
    } catch {
      setSkills([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const machineName = useCallback(
    (id: string) => machines.find((machine) => machine.id === id)?.name ?? id,
    [machines],
  );
  const onlineMachines = useMemo(() => machines.filter((machine) => isServerOnline(machine)), [machines]);

  const errorText = (error?: string) => t(
    `sharedContext.management.agentSkills.errors.${error && KNOWN_ERRORS.has(error) ? error : 'generic'}`,
  );

  /** Run one request on each machine; each machine reports on its own. */
  const runOn = async (
    ids: string[],
    request: Parameters<typeof runAgentSkills>[1],
    label: string,
  ) => {
    setBusy(label);
    setResults([]);
    try {
      const settled = await Promise.all(ids.map(async (id) => ({ serverId: id, ...(await runAgentSkills(id, request)) })));
      setResults(settled);
      const current = settled.find((result) => result.serverId === machineId);
      if (current?.skills) setSkills(current.skills);
      else await load();
    } finally {
      setBusy(null);
    }
  };

  const sourceValid = isAgentSkillSource(source.trim());
  const install = () => {
    if (!sourceValid || targets.size === 0) return;
    void runOn([...targets], { action: AGENT_SKILLS_ACTION.ADD, source: source.trim() }, 'install');
  };

  const remove = (skill: AgentSkillEntry) => {
    if (!machineId) return;
    const confirmed = globalThis.confirm?.(t('sharedContext.management.agentSkills.removeConfirm', {
      name: skill.name,
      machine: machineName(machineId),
    })) ?? true;
    if (!confirmed) return;
    void runOn([machineId], { action: AGENT_SKILLS_ACTION.REMOVE, names: [skill.name] }, `remove:${skill.name}`);
  };

  const toggleTarget = (id: string) => {
    setTargets((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section class="capabilities-panel shared-context-capability-panel" aria-labelledby="agent-skills-title">
      <header class="capabilities-panel-header">
        <div>
          <h2 id="agent-skills-title">{t('sharedContext.management.agentSkills.title')}</h2>
          <p>{t('sharedContext.management.agentSkills.description')}</p>
        </div>
        <button class="capability-button" type="button" onClick={() => void load()} disabled={!machineId || loading}>
          {t('sharedContext.refresh')}
        </button>
      </header>

      <div class="capability-inventory-toolbar">
        <label>
          <span class="capability-muted">{t('sharedContext.management.agentSkills.machineLabel')}</span>{' '}
          <select
            value={machineId ?? ''}
            onChange={(event) => setMachineId((event.target as HTMLSelectElement).value || undefined)}
            aria-label={t('sharedContext.management.agentSkills.machineLabel')}
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
        <button
          class="capability-button"
          type="button"
          disabled={!machineId || busy !== null || skills.length === 0}
          onClick={() => machineId && void runOn([machineId], { action: AGENT_SKILLS_ACTION.UPDATE }, 'update-all')}
        >
          {busy === 'update-all' ? t('capabilities.working') : t('sharedContext.management.agentSkills.updateAll')}
        </button>
      </div>

      {loadError ? (
        <div class="capability-inline-alert" role="alert">
          <span>{t('sharedContext.management.agentSkills.loadError')}</span>
          <button class="capability-link-button" type="button" onClick={() => void load()}>{t('capabilities.retry')}</button>
        </div>
      ) : null}

      {!machineId ? (
        <div class="capability-empty">{t('sharedContext.management.capabilityInventory.noServer')}</div>
      ) : loading ? (
        <div class="capability-empty" aria-busy="true">{t('common.loading')}</div>
      ) : skills.length === 0 && !loadError ? (
        <div class="capability-empty">{t('sharedContext.management.agentSkills.empty')}</div>
      ) : (
        <div class="capability-inventory" data-testid="agent-skills-inventory">
          {skills.map((skill) => (
            <article key={skill.name} class="capability-item">
              <header>
                <div><h3>{skill.name}</h3></div>
                <div class="capability-chip-row">
                  <button
                    class="capability-button"
                    type="button"
                    disabled={busy !== null || !skill.source}
                    onClick={() => machineId && void runOn([machineId], { action: AGENT_SKILLS_ACTION.UPDATE, names: [skill.name] }, `update:${skill.name}`)}
                  >
                    {busy === `update:${skill.name}` ? t('capabilities.working') : t('sharedContext.management.agentSkills.update')}
                  </button>
                  <button
                    class="capability-button capability-button-danger"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => remove(skill)}
                  >
                    {busy === `remove:${skill.name}` ? t('capabilities.working') : t('sharedContext.management.agentSkills.remove')}
                  </button>
                </div>
              </header>
              {skill.description ? <p class="capability-muted">{skill.description}</p> : null}
              {skill.source ? (
                <dl class="capability-facts">
                  <dt>{t('capabilities.sourceLabel')}</dt><dd>{skill.source}</dd>
                </dl>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <section class="capability-item" aria-labelledby="agent-skills-install-title">
        <header><div><h3 id="agent-skills-install-title">{t('sharedContext.management.agentSkills.installTitle')}</h3></div></header>
        <div class="capability-inventory-toolbar">
          <input
            type="text"
            value={source}
            onInput={(event) => setSource((event.target as HTMLInputElement).value)}
            placeholder={t('sharedContext.management.agentSkills.sourcePlaceholder')}
            aria-label={t('sharedContext.management.agentSkills.sourceLabel')}
            aria-invalid={source.trim() !== '' && !sourceValid}
          />
          <button
            class="capability-button"
            type="button"
            disabled={!sourceValid || targets.size === 0 || busy !== null}
            onClick={install}
          >
            {busy === 'install' ? t('sharedContext.management.agentSkills.installing') : t('sharedContext.management.agentSkills.install')}
          </button>
        </div>
        {source.trim() !== '' && !sourceValid ? (
          <p class="capability-muted" role="alert">{t('sharedContext.management.agentSkills.sourceInvalid')}</p>
        ) : null}
        <fieldset class="capability-binding-list">
          <legend class="capability-muted">{t('sharedContext.management.agentSkills.machinesLabel')}</legend>
          {onlineMachines.map((machine) => (
            <label key={machine.id} class="capability-binding-row">
              <input type="checkbox" checked={targets.has(machine.id)} onChange={() => toggleTarget(machine.id)} />
              <span>{machine.name}</span>
            </label>
          ))}
        </fieldset>
      </section>

      {results.length > 0 ? (
        <div class="capability-binding-list" data-testid="agent-skills-results" role="status">
          {results.map((result) => (
            <div key={result.serverId} class="capability-binding-row">
              <div>
                <strong>{machineName(result.serverId)}</strong>{' '}
                <span class="capability-muted">
                  {result.ok ? t('sharedContext.management.agentSkills.done') : errorText(result.error)}
                </span>
                {result.output ? (
                  <details>
                    <summary>{t('sharedContext.management.agentSkills.details')}</summary>
                    <pre>{result.output}</pre>
                  </details>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
