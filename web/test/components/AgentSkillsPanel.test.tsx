/**
 * The Agent Skills tab: lists one machine's ~/.agents/skills and runs the
 * skills CLI on as many machines as the person ticks, reporting each.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/preact';

const NOW = Date.now();
const SERVERS = [
  { id: 'mac', name: 'mini-2', status: 'online', lastHeartbeatAt: NOW },
  { id: 'linux', name: 'vm-124', status: 'online', lastHeartbeatAt: NOW },
  { id: 'gone', name: 'old-box', status: 'offline', lastHeartbeatAt: 0 },
];

const listAgentSkills = vi.fn(async (_serverId: string) => [
  { name: 'wecomcli-doc', description: 'WeCom docs', source: 'WeComTeam/wecom-cli', missingBins: ['wecom-cli'] },
]);
const searchDirectory = vi.fn(async (_query: string) => [
  { name: 'pdf', source: 'anthropics/skills', installs: 198154 },
  { name: 'pdf', source: 'openai/skills', installs: 12547 },
]);
const auditSkills = vi.fn(async (_source: string, _skills: string[]) => ({
  pdf: [
    { auditor: 'socket', risk: 'safe', score: 90 },
    { auditor: 'snyk', risk: 'medium' },
  ],
}));
const runAgentSkills = vi.fn(async (serverId: string, _request: unknown) => (
  serverId === 'linux'
    ? { ok: false, error: 'cli_failed', output: 'git clone failed' }
    : { ok: true, output: 'Installed', skills: [{ name: 'wecomcli-doc', description: 'WeCom docs' }, { name: 'fresh', description: 'new' }] }
));

vi.mock('../../src/api.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  apiFetch: vi.fn(async () => ({ servers: SERVERS })),
}));
vi.mock('../../src/api/agent-skills.js', () => ({
  listAgentSkills: (serverId: string) => listAgentSkills(serverId),
  runAgentSkills: (serverId: string, request: unknown) => runAgentSkills(serverId, request),
  searchAgentSkillsDirectory: (query: string) => searchDirectory(query),
  auditAgentSkills: (source: string, skills: string[]) => auditSkills(source, skills),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

const { AgentSkillsPanel } = await import('../../src/components/AgentSkillsPanel.js');

beforeEach(() => {
  listAgentSkills.mockClear();
  runAgentSkills.mockClear();
  searchDirectory.mockClear();
  auditSkills.mockClear();
});
afterEach(() => cleanup());

describe('AgentSkillsPanel', () => {
  it('lists the skills in the machine\'s ~/.agents/skills', async () => {
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    expect(await screen.findByText('wecomcli-doc')).toBeDefined();
    expect(screen.getByText('WeCom docs')).toBeDefined();
    expect(listAgentSkills).toHaveBeenCalledWith('mac');
  });

  it('installs on every ticked online machine and reports each on its own', async () => {
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    await screen.findByText('wecomcli-doc');
    // Only online machines can be ticked.
    const linux = await screen.findByRole('checkbox', { name: 'vm-124' });
    expect(screen.queryByRole('checkbox', { name: 'old-box' })).toBeNull();
    // The machine on screen starts ticked.
    expect((screen.getByRole('checkbox', { name: 'mini-2' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(linux);

    fireEvent.input(screen.getByLabelText('sharedContext.management.agentSkills.sourceLabel'), { target: { value: 'WeComTeam/wecom-cli' } });
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.install'));

    await waitFor(() => expect(runAgentSkills).toHaveBeenCalledTimes(2));
    expect(runAgentSkills).toHaveBeenCalledWith('mac', { action: 'add', source: 'WeComTeam/wecom-cli' });
    expect(runAgentSkills).toHaveBeenCalledWith('linux', { action: 'add', source: 'WeComTeam/wecom-cli' });
    const results = await screen.findByTestId('agent-skills-results');
    expect(results.textContent).toContain('sharedContext.management.agentSkills.done');
    expect(results.textContent).toContain('sharedContext.management.agentSkills.errors.cli_failed');
    // The machine on screen shows its skills after the run.
    expect(await screen.findByText('fresh')).toBeDefined();
  });

  it('will not install from a source that is not owner/repo or https', async () => {
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    await screen.findByText('wecomcli-doc');
    fireEvent.input(screen.getByLabelText('sharedContext.management.agentSkills.sourceLabel'), { target: { value: '--all' } });
    const button = screen.getByText('sharedContext.management.agentSkills.install').closest('button')!;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('sharedContext.management.agentSkills.sourceInvalid')).toBeDefined();
    fireEvent.click(button);
    expect(runAgentSkills).not.toHaveBeenCalled();
  });

  it('removes one skill from the machine on screen, after confirmation', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    await screen.findByText('wecomcli-doc');
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.remove'));
    await waitFor(() => expect(runAgentSkills).toHaveBeenCalledWith('mac', { action: 'remove', names: ['wecomcli-doc'] }));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('warns when a skill needs a command the machine does not have', async () => {
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    const warning = await screen.findByTestId('agent-skill-missing-wecomcli-doc');
    expect(warning.textContent).toContain('"bins":"wecom-cli"');
  });

  it('searches skills.sh, shows the audits, and installs just that skill on the ticked machines', async () => {
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    await screen.findByText('wecomcli-doc');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'vm-124' }));

    fireEvent.input(screen.getByLabelText('sharedContext.management.agentSkills.searchLabel'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.search'));
    const found = await screen.findByTestId('agent-skills-search-results');
    expect(searchDirectory).toHaveBeenCalledWith('pdf');
    expect(found.textContent).toContain('anthropics/skills');

    fireEvent.click(found.querySelector('button')!);
    const verdicts = await screen.findByTestId('agent-skills-audit');
    expect(auditSkills).toHaveBeenCalledWith('anthropics/skills', ['pdf']);
    expect(verdicts.textContent).toContain('Socket');
    expect(verdicts.textContent).toContain('sharedContext.management.agentSkills.risk.medium');

    const selected = screen.getByTestId('agent-skills-selected');
    fireEvent.click(selected.querySelector('button')!);
    await waitFor(() => expect(runAgentSkills).toHaveBeenCalledTimes(2));
    for (const machine of ['mac', 'linux']) {
      expect(runAgentSkills).toHaveBeenCalledWith(machine, { action: 'add', source: 'anthropics/skills', names: ['pdf'] });
    }
  });

  it('says skills.sh is unavailable instead of failing, and installing by source still works', async () => {
    searchDirectory.mockRejectedValueOnce(new Error('502'));
    render(h(AgentSkillsPanel, { serverId: 'mac' }));
    await screen.findByText('wecomcli-doc');
    fireEvent.input(screen.getByLabelText('sharedContext.management.agentSkills.searchLabel'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.search'));
    expect(await screen.findByText('sharedContext.management.agentSkills.directoryUnavailable')).toBeDefined();
    fireEvent.input(screen.getByLabelText('sharedContext.management.agentSkills.sourceLabel'), { target: { value: 'owner/repo' } });
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.install'));
    await waitFor(() => expect(runAgentSkills).toHaveBeenCalledWith('mac', { action: 'add', source: 'owner/repo' }));
  });
});
