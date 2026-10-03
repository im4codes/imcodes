import { Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  AGENT_SKILLS_ACTION,
  AGENT_SKILLS_DIRECTORY,
  AGENT_SKILLS_ERROR,
  isAgentSkillSource,
  type AgentSkillAuditVerdict,
  type AgentSkillEntry,
  type AgentSkillSearchResult,
} from '@shared/agent-skills.js';
import {
  auditAgentSkills,
  listAgentSkills,
  runAgentSkills,
  searchAgentSkillsDirectory,
  type AgentSkillsRunResult,
} from '../api/agent-skills.js';
import { useDaemonMachines, useMachineTargets } from '../hooks/useDaemonMachines.js';
import { MachineSelect, MachineTargets } from './MachinePicker.js';

interface Props {
  /** The machine the panel opens on. */
  serverId?: string;
}

interface MachineResult extends AgentSkillsRunResult {
  serverId: string;
}

type AuditState =
  | { state: 'loading' }
  | { state: 'ready'; verdicts: AgentSkillAuditVerdict[] }
  | { state: 'unavailable' };

const KNOWN_ERRORS = new Set<string>([...Object.values(AGENT_SKILLS_ERROR), 'forbidden', 'not_found']);
const KNOWN_RISKS = new Set(['safe', 'low', 'medium', 'high', 'critical']);
/** The auditors skills.sh reports, by their product names. */
const AUDITOR_NAMES: Record<string, string> = { ath: 'Gen ATH', socket: 'Socket', snyk: 'Snyk', zeroleaks: 'ZeroLeaks' };

/**
 * Agent Skills are the files in each machine's `~/.agents/skills`, which every
 * agent on that machine already reads. This panel lists them per machine,
 * searches the skills.sh directory with its security audits, and runs the
 * `skills` CLI: install on any set of machines at once, update, remove.
 */
export function AgentSkillsPanel({ serverId }: Props) {
  const { t } = useTranslation();
  const { machines, onlineMachines, machineName } = useDaemonMachines();
  const { targets, toggle: toggleTarget } = useMachineTargets(serverId);
  const [machineId, setMachineId] = useState<string | undefined>(serverId);
  const [skills, setSkills] = useState<AgentSkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<MachineResult[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [found, setFound] = useState<AgentSkillSearchResult[] | null>(null);
  const [selected, setSelected] = useState<AgentSkillSearchResult | null>(null);
  const [audit, setAudit] = useState<AuditState | null>(null);

  useEffect(() => {
    setMachineId(serverId);
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

  const search = async () => {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    setSearchError(false);
    setSelected(null);
    setAudit(null);
    try {
      setFound(await searchAgentSkillsDirectory(text.slice(0, AGENT_SKILLS_DIRECTORY.QUERY_CHARS)));
    } catch {
      setFound(null);
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  /** Pick a directory result and show what skills.sh's auditors say about it. */
  const choose = async (result: AgentSkillSearchResult) => {
    setSelected(result);
    setAudit({ state: 'loading' });
    try {
      const audits = await auditAgentSkills(result.source, [result.name]);
      setAudit({ state: 'ready', verdicts: audits[result.name] ?? [] });
    } catch {
      setAudit({ state: 'unavailable' });
    }
  };

  const sourceValid = isAgentSkillSource(source.trim());
  const install = () => {
    if (!sourceValid || targets.size === 0) return;
    void runOn([...targets], { action: AGENT_SKILLS_ACTION.ADD, source: source.trim() }, 'install');
  };
  const installSelected = () => {
    if (!selected || targets.size === 0) return;
    void runOn([...targets], { action: AGENT_SKILLS_ACTION.ADD, source: selected.source, names: [selected.name] }, 'install-selected');
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


  const riskLabel = (risk: string) => t(`sharedContext.management.agentSkills.risk.${KNOWN_RISKS.has(risk) ? risk : 'unknown'}`);

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
        <MachineSelect
          machines={machines}
          value={machineId}
          onChange={setMachineId}
          label={t('sharedContext.management.agentSkills.machineLabel')}
        />
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
              {skill.missingBins?.length ? (
                <div class="capability-inline-alert" role="alert" data-testid={`agent-skill-missing-${skill.name}`}>
                  <span>{t('sharedContext.management.agentSkills.missingBins', { bins: skill.missingBins.join(', ') })}</span>
                </div>
              ) : null}
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

        <MachineTargets
          machines={onlineMachines}
          targets={targets}
          onToggle={toggleTarget}
          legend={t('sharedContext.management.agentSkills.machinesLabel')}
        />

        <div class="capability-inventory-toolbar">
          <input
            type="search"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
            placeholder={t('sharedContext.management.agentSkills.searchPlaceholder')}
            aria-label={t('sharedContext.management.agentSkills.searchLabel')}
          />
          <button class="capability-button" type="button" disabled={!query.trim() || searching} onClick={() => void search()}>
            {searching ? t('sharedContext.management.agentSkills.searching') : t('sharedContext.management.agentSkills.search')}
          </button>
        </div>
        {searchError ? (
          <p class="capability-muted" role="alert">{t('sharedContext.management.agentSkills.directoryUnavailable')}</p>
        ) : found && found.length === 0 ? (
          <p class="capability-muted">{t('sharedContext.management.agentSkills.searchEmpty')}</p>
        ) : found ? (
          <div class="capability-binding-list" data-testid="agent-skills-search-results">
            {found.map((result) => (
              <button
                key={`${result.source}/${result.name}`}
                type="button"
                class={`capability-binding-row${selected === result ? ' is-selected' : ''}`}
                aria-pressed={selected === result}
                onClick={() => void choose(result)}
              >
                <strong>{result.name}</strong>{' '}
                <span class="capability-muted">{result.source}</span>{' '}
                <span class="capability-muted">{t('sharedContext.management.agentSkills.installs', { count: result.installs })}</span>
              </button>
            ))}
          </div>
        ) : null}

        {selected ? (
          <div class="capability-item" data-testid="agent-skills-selected">
            <header>
              <div>
                <h3>{selected.name}</h3>
                <a class="capability-muted" href={`${AGENT_SKILLS_DIRECTORY.PAGE_URL}/${selected.source}/${selected.name}`} target="_blank" rel="noopener noreferrer">
                  {selected.source}
                </a>
              </div>
              <button
                class="capability-button"
                type="button"
                disabled={targets.size === 0 || busy !== null}
                onClick={installSelected}
              >
                {busy === 'install-selected'
                  ? t('sharedContext.management.agentSkills.installing')
                  : t('sharedContext.management.agentSkills.installSelected', { name: selected.name, count: targets.size })}
              </button>
            </header>
            <p class="capability-muted">{t('sharedContext.management.agentSkills.auditTitle')}</p>
            {audit?.state === 'loading' ? (
              <p class="capability-muted" aria-busy="true">{t('common.loading')}</p>
            ) : audit?.state === 'unavailable' ? (
              <p class="capability-muted" role="alert">{t('sharedContext.management.agentSkills.directoryUnavailable')}</p>
            ) : audit?.state === 'ready' && audit.verdicts.length === 0 ? (
              <p class="capability-muted">{t('sharedContext.management.agentSkills.auditNone')}</p>
            ) : audit?.state === 'ready' ? (
              <dl class="capability-facts" data-testid="agent-skills-audit">
                {audit.verdicts.map((verdict) => (
                  <Fragment key={verdict.auditor}>
                    <dt>{AUDITOR_NAMES[verdict.auditor] ?? verdict.auditor}</dt>
                    <dd class={`capability-state capability-risk-${KNOWN_RISKS.has(verdict.risk) ? verdict.risk : 'unknown'}`}>
                      {riskLabel(verdict.risk)}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}

        <details>
          <summary class="capability-muted">{t('sharedContext.management.agentSkills.installBySource')}</summary>
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
        </details>
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
