import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  AGENT_MCP_ACTION,
  AGENT_MCP_ERROR,
  AGENT_MCP_REGISTRY,
  AGENT_MCP_TRANSPORT,
  isReservedAgentMcpName,
  readAgentMcpServerSpec,
  type AgentMcpList,
  type AgentMcpRegistryInput,
  type AgentMcpRegistryServer,
  type AgentMcpRunRequest,
  type AgentMcpRunResult,
  type AgentMcpServerEntry,
  type AgentMcpServerSpec,
  type AgentMcpTransport,
} from '@shared/agent-mcp.js';
import { listAgentMcp, runAgentMcp, searchAgentMcpRegistry } from '../api/agent-mcp.js';
import { useDaemonMachines, useMachineTargets } from '../hooks/useDaemonMachines.js';
import { MachineSelect, MachineTargets } from './MachinePicker.js';

interface Props {
  /** The machine the panel opens on. */
  serverId?: string;
}

interface ValueRow {
  key: string;
  value: string;
  secret: boolean;
  required: boolean;
  description?: string;
}

interface Form {
  name: string;
  transport: AgentMcpTransport;
  url: string;
  command: string;
  argsText: string;
  rows: ValueRow[];
}

type MachineResult = (AgentMcpRunResult | { ok: false; error: string }) & { serverId: string };

const EMPTY_FORM: Form = { name: '', transport: AGENT_MCP_TRANSPORT.STDIO, url: '', command: 'npx', argsText: '', rows: [] };
const KNOWN_ERRORS = new Set<string>([...Object.values(AGENT_MCP_ERROR), 'forbidden', 'not_found']);

/** A config-friendly name from a registry id: io.github.acme/remote-files → remote-files. */
function nameFromRegistryId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').slice(0, 64) || 'mcp-server';
}

function rowsFrom(inputs: AgentMcpRegistryInput[]): ValueRow[] {
  return inputs.map((input) => ({
    key: input.name,
    // "Bearer {api_key}" becomes "Bearer ", so only the secret itself is left to type.
    value: input.template ? input.template.replace(/\{[^}]*\}/gu, '') : '',
    secret: input.secret,
    required: input.required,
    ...(input.description ? { description: input.description } : {}),
  }));
}

/** The form as a server spec, or null while it is not one the daemon would accept. */
function specOf(form: Form): AgentMcpServerSpec | null {
  const values = Object.fromEntries(form.rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
  const hasValues = Object.keys(values).length > 0;
  return readAgentMcpServerSpec(form.transport === AGENT_MCP_TRANSPORT.STDIO
    ? {
      name: form.name.trim(),
      transport: form.transport,
      command: form.command.trim(),
      args: form.argsText.split('\n').map((line) => line.trim()).filter(Boolean),
      ...(hasValues ? { env: values } : {}),
    }
    : { name: form.name.trim(), transport: form.transport, url: form.url.trim(), ...(hasValues ? { headers: values } : {}) });
}

/**
 * MCP servers live in each agent's own config on a machine. This panel lists
 * them, searches the official MCP Registry, and adds or removes a server on
 * any set of machines at once -- for every agent found on each.
 */
export function AgentMcpPanel({ serverId }: Props) {
  const { t } = useTranslation();
  const { machines, onlineMachines, machineName } = useDaemonMachines();
  const { targets, toggle } = useMachineTargets(serverId);
  const [machineId, setMachineId] = useState<string | undefined>(serverId);
  const [list, setList] = useState<AgentMcpList>({ servers: [], agents: [] });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<MachineResult[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [found, setFound] = useState<AgentMcpRegistryServer[] | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);

  useEffect(() => setMachineId(serverId), [serverId]);

  const load = useCallback(async () => {
    if (!machineId) {
      setList({ servers: [], agents: [] });
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      setList(await listAgentMcp(machineId));
    } catch {
      setList({ servers: [], agents: [] });
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentName = useMemo(() => {
    const names = new Map(list.agents.map((agent) => [agent.agent, agent.displayName]));
    return (agent: string) => names.get(agent) ?? agent;
  }, [list.agents]);

  const errorText = (error?: string) => t(
    `sharedContext.management.agentMcp.errors.${error && KNOWN_ERRORS.has(error) ? error : 'generic'}`,
  );

  const runOn = async (ids: string[], request: AgentMcpRunRequest, label: string) => {
    setBusy(label);
    setResults([]);
    try {
      const settled = await Promise.all(ids.map(async (id) => ({ serverId: id, ...(await runAgentMcp(id, request)) })));
      setResults(settled);
      const current = settled.find((result) => result.serverId === machineId);
      if (current && 'list' in current && current.list) setList(current.list);
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
    try {
      setFound(await searchAgentMcpRegistry(text.slice(0, AGENT_MCP_REGISTRY.QUERY_CHARS)));
    } catch {
      setFound(null);
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  const pickRemote = (server: AgentMcpRegistryServer) => {
    if (!server.remote) return;
    setForm({ ...EMPTY_FORM, name: nameFromRegistryId(server.id), transport: server.remote.transport, url: server.remote.url, rows: rowsFrom(server.remote.headers) });
  };
  const pickNpm = (server: AgentMcpRegistryServer) => {
    if (!server.npm) return;
    const pkg = server.npm.version ? `${server.npm.identifier}@${server.npm.version}` : server.npm.identifier;
    setForm({ ...EMPTY_FORM, name: nameFromRegistryId(server.id), command: 'npx', argsText: `-y\n${pkg}`, rows: rowsFrom(server.npm.env) });
  };

  const spec = specOf(form);
  const missing = form.rows.filter((row) => row.required && !row.value.trim()).map((row) => row.key);
  const setRow = (index: number, patch: Partial<ValueRow>) => setForm((previous) => ({
    ...previous,
    rows: previous.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
  }));

  const install = () => {
    if (!spec || missing.length > 0 || targets.size === 0) return;
    void runOn([...targets], { action: AGENT_MCP_ACTION.ADD, server: spec }, 'install');
  };

  const remove = (server: AgentMcpServerEntry) => {
    if (!machineId) return;
    const confirmed = globalThis.confirm?.(t('sharedContext.management.agentMcp.removeConfirm', {
      name: server.name,
      machine: machineName(machineId),
    })) ?? true;
    if (!confirmed) return;
    void runOn([machineId], { action: AGENT_MCP_ACTION.REMOVE, name: server.name }, `remove:${server.name}`);
  };

  const remote = form.transport !== AGENT_MCP_TRANSPORT.STDIO;

  return (
    <section class="capabilities-panel shared-context-capability-panel" aria-labelledby="agent-mcp-title">
      <header class="capabilities-panel-header">
        <div>
          <h2 id="agent-mcp-title">{t('sharedContext.management.agentMcp.title')}</h2>
          <p>{t('sharedContext.management.agentMcp.description')}</p>
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
      </div>
      {machineId && !loading && !loadError ? (
        <p class="capability-muted" data-testid="agent-mcp-agents">
          {list.agents.length > 0
            ? t('sharedContext.management.agentMcp.agentsFound', { agents: list.agents.map((agent) => agent.displayName).join(', ') })
            : t('sharedContext.management.agentMcp.noAgents')}
        </p>
      ) : null}

      {loadError ? (
        <div class="capability-inline-alert" role="alert">
          <span>{t('sharedContext.management.agentMcp.loadError')}</span>
          <button class="capability-link-button" type="button" onClick={() => void load()}>{t('capabilities.retry')}</button>
        </div>
      ) : null}

      {!machineId ? (
        <div class="capability-empty">{t('sharedContext.management.capabilityInventory.noServer')}</div>
      ) : loading ? (
        <div class="capability-empty" aria-busy="true">{t('common.loading')}</div>
      ) : list.servers.length === 0 && !loadError ? (
        <div class="capability-empty">{t('sharedContext.management.agentMcp.empty')}</div>
      ) : (
        <div class="capability-inventory" data-testid="agent-mcp-inventory">
          {list.servers.map((server) => (
            <article key={server.name} class="capability-item">
              <header>
                <div>
                  <span class="capability-kind">{t(`sharedContext.management.agentMcp.transports.${server.transport}`)}</span>
                  <h3>{server.name}</h3>
                </div>
                {isReservedAgentMcpName(server.name) ? (
                  // IM.codes' own server: the daemon writes it and would refuse to remove it.
                  <span class="capability-muted">{t('sharedContext.management.agentMcp.builtIn')}</span>
                ) : (
                  <button
                    class="capability-button capability-button-danger"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => remove(server)}
                  >
                    {busy === `remove:${server.name}` ? t('capabilities.working') : t('sharedContext.management.agentMcp.remove')}
                  </button>
                )}
              </header>
              <dl class="capability-facts">
                {server.url ? <><dt>{t('sharedContext.management.agentMcp.url')}</dt><dd>{server.url}</dd></> : null}
                {server.packageName ? <><dt>{t('sharedContext.management.agentMcp.package')}</dt><dd>{server.packageName}</dd></>
                  : server.command ? <><dt>{t('sharedContext.management.agentMcp.command')}</dt><dd>{server.command}</dd></> : null}
                <dt>{t('sharedContext.management.agentMcp.installedIn')}</dt>
                <dd>{server.agents.map(agentName).join(', ')}</dd>
              </dl>
              {server.envNames.length + server.headerNames.length > 0 ? (
                <div class="capability-chip-row">
                  {[...server.envNames, ...server.headerNames].map((name) => <code key={name}>{name}</code>)}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <section class="capability-item" aria-labelledby="agent-mcp-install-title">
        <header><div><h3 id="agent-mcp-install-title">{t('sharedContext.management.agentMcp.installTitle')}</h3></div></header>
        <MachineTargets
          machines={onlineMachines}
          targets={targets}
          onToggle={toggle}
          legend={t('sharedContext.management.agentSkills.machinesLabel')}
        />

        <div class="capability-inventory-toolbar">
          <input
            type="search"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
            placeholder={t('sharedContext.management.agentMcp.searchPlaceholder')}
            aria-label={t('sharedContext.management.agentMcp.searchLabel')}
          />
          <button class="capability-button" type="button" disabled={!query.trim() || searching} onClick={() => void search()}>
            {searching ? t('sharedContext.management.agentMcp.searching') : t('sharedContext.management.agentMcp.search')}
          </button>
        </div>
        {searchError ? (
          <p class="capability-muted" role="alert">{t('sharedContext.management.agentMcp.registryUnavailable')}</p>
        ) : found && found.length === 0 ? (
          <p class="capability-muted">{t('sharedContext.management.agentMcp.searchEmpty')}</p>
        ) : found ? (
          <div class="capability-binding-list" data-testid="agent-mcp-search-results">
            {found.map((server) => (
              <div key={server.id} class="capability-binding-row">
                <div>
                  <strong>{server.id}</strong>{server.version ? <span class="capability-muted"> {server.version}</span> : null}
                  {server.description ? <p class="capability-muted">{server.description}</p> : null}
                </div>
                <div class="capability-chip-row">
                  {server.remote ? (
                    <button class="capability-button" type="button" onClick={() => pickRemote(server)}>
                      {t('sharedContext.management.agentMcp.useRemote')}
                    </button>
                  ) : null}
                  {server.npm ? (
                    <button class="capability-button" type="button" onClick={() => pickNpm(server)}>
                      {t('sharedContext.management.agentMcp.useNpm')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div class="capability-binding-list" data-testid="agent-mcp-form">
          <label class="capability-binding-row">
            <span>{t('sharedContext.management.agentMcp.name')}</span>
            <input type="text" value={form.name} onInput={(event) => setForm({ ...form, name: (event.target as HTMLInputElement).value })}
              aria-label={t('sharedContext.management.agentMcp.name')} />
          </label>
          <label class="capability-binding-row">
            <span>{t('sharedContext.management.agentMcp.transport')}</span>
            <select value={form.transport}
              onChange={(event) => setForm({ ...form, transport: (event.target as HTMLSelectElement).value as AgentMcpTransport })}
              aria-label={t('sharedContext.management.agentMcp.transport')}>
              {Object.values(AGENT_MCP_TRANSPORT).map((transport) => (
                <option key={transport} value={transport}>{t(`sharedContext.management.agentMcp.transports.${transport}`)}</option>
              ))}
            </select>
          </label>
          {remote ? (
            <label class="capability-binding-row">
              <span>{t('sharedContext.management.agentMcp.url')}</span>
              <input type="url" value={form.url} placeholder="https://…" onInput={(event) => setForm({ ...form, url: (event.target as HTMLInputElement).value })}
                aria-label={t('sharedContext.management.agentMcp.url')} />
            </label>
          ) : (
            <>
              <label class="capability-binding-row">
                <span>{t('sharedContext.management.agentMcp.command')}</span>
                <input type="text" value={form.command} onInput={(event) => setForm({ ...form, command: (event.target as HTMLInputElement).value })}
                  aria-label={t('sharedContext.management.agentMcp.command')} />
              </label>
              <label class="capability-binding-row">
                <span>{t('sharedContext.management.agentMcp.args')}</span>
                <textarea rows={3} value={form.argsText} onInput={(event) => setForm({ ...form, argsText: (event.target as HTMLTextAreaElement).value })}
                  aria-label={t('sharedContext.management.agentMcp.args')} />
              </label>
            </>
          )}
          <p class="capability-muted">{t(remote ? 'sharedContext.management.agentMcp.headers' : 'sharedContext.management.agentMcp.env')}</p>
          {form.rows.map((row, index) => (
            <div key={index} class="capability-binding-row">
              <input type="text" value={row.key} placeholder={t('sharedContext.management.agentMcp.key')}
                aria-label={t('sharedContext.management.agentMcp.key')}
                onInput={(event) => setRow(index, { key: (event.target as HTMLInputElement).value })} />
              <input type={row.secret ? 'password' : 'text'} value={row.value} autoComplete="off"
                placeholder={row.description ?? t('sharedContext.management.agentMcp.value')}
                aria-label={row.key || t('sharedContext.management.agentMcp.value')}
                onInput={(event) => setRow(index, { value: (event.target as HTMLInputElement).value })} />
              {row.required ? <span class="capability-muted">{t('sharedContext.management.agentMcp.required')}</span> : null}
            </div>
          ))}
          <button class="capability-link-button" type="button"
            onClick={() => setForm({ ...form, rows: [...form.rows, { key: '', value: '', secret: true, required: false }] })}>
            {t('sharedContext.management.agentMcp.addRow')}
          </button>
          <p class="capability-muted">{t('sharedContext.management.agentMcp.secretHint')}</p>
          {form.name.trim() && !spec ? <p class="capability-muted" role="alert">{t('sharedContext.management.agentMcp.invalid')}</p> : null}
          {missing.length > 0 ? (
            <p class="capability-muted" role="alert">{t('sharedContext.management.agentMcp.missingRequired', { names: missing.join(', ') })}</p>
          ) : null}
          <button class="capability-button" type="button"
            disabled={!spec || missing.length > 0 || targets.size === 0 || busy !== null} onClick={install}>
            {busy === 'install'
              ? t('sharedContext.management.agentMcp.installing')
              : t('sharedContext.management.agentMcp.install', { count: targets.size })}
          </button>
        </div>
      </section>

      {results.length > 0 ? (
        <div class="capability-binding-list" data-testid="agent-mcp-results" role="status">
          {results.map((result) => (
            <div key={result.serverId} class="capability-binding-row">
              <div>
                <strong>{machineName(result.serverId)}</strong>{' '}
                <span class="capability-muted">{result.ok ? t('sharedContext.management.agentMcp.done') : errorText(result.error)}</span>
                {'results' in result && result.results?.length ? (
                  <ul>
                    {result.results.map((entry) => (
                      <li key={entry.agent}>
                        {agentName(entry.agent)}: {entry.ok ? '✓' : `✗ ${entry.error ?? ''}`}
                        {entry.dropped?.length ? ` · ${t('sharedContext.management.agentMcp.dropped', { fields: entry.dropped.join(', ') })}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
