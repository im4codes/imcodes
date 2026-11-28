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

  it('reloads skills for the active machine on refreshSignal without resetting machine or search state, and skips request when no machine is selected', async () => {
    const view = render(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 0 }));
    await screen.findByText('wecomcli-doc');
    expect(listAgentSkills).toHaveBeenCalledTimes(1);
    expect(listAgentSkills).toHaveBeenLastCalledWith('mac');

    const machineSelect = await screen.findByLabelText('sharedContext.management.agentSkills.machineLabel') as HTMLSelectElement;
    await screen.findByRole('option', { name: 'vm-124' });
    machineSelect.value = 'linux';
    fireEvent(machineSelect, new Event('change', { bubbles: true }));
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledWith('linux'));

    const searchInput = screen.getByLabelText('sharedContext.management.agentSkills.searchLabel') as HTMLInputElement;
    fireEvent.input(searchInput, { target: { value: 'pdf' } });

    listAgentSkills.mockClear();
    view.rerender(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 1 }));
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledTimes(1));
    expect(listAgentSkills).toHaveBeenCalledWith('linux');
    expect(machineSelect.value).toBe('linux');
    expect(searchInput.value).toBe('pdf');

    view.unmount();
    listAgentSkills.mockClear();
    const emptyView = render(h(AgentSkillsPanel, { refreshSignal: 0 }));
    emptyView.rerender(h(AgentSkillsPanel, { refreshSignal: 1 }));
    await waitFor(() => expect(listAgentSkills).not.toHaveBeenCalled());
  });

  it('ignores stale concurrent refresh and machine-switch rejections/responses after a newer load settles', async () => {
    const view = render(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 0 }));
    await screen.findByText('wecomcli-doc');

    let rejectFirst!: (err: Error) => void;
    const firstPending = new Promise<Awaited<ReturnType<typeof listAgentSkills>>>((_res, rej) => {
      rejectFirst = rej;
    });
    let resolveSecond!: (rows: Awaited<ReturnType<typeof listAgentSkills>>) => void;
    const secondPending = new Promise<Awaited<ReturnType<typeof listAgentSkills>>>((res) => {
      resolveSecond = res;
    });

    listAgentSkills
      .mockReturnValueOnce(firstPending)
      .mockReturnValueOnce(secondPending);

    view.rerender(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 1 }));
    view.rerender(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 2 }));

    resolveSecond([{ name: 'fresh-skill', description: 'Latest skills list' }]);
    expect(await screen.findByText('fresh-skill')).toBeDefined();

    rejectFirst(new Error('500'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('fresh-skill')).toBeDefined();
    expect(screen.queryByText('sharedContext.management.agentSkills.loadFailed')).toBeNull();

    // Also verify a pending machine-A load cannot overwrite a newer machine-B result.
    let rejectOldMachine!: (err: Error) => void;
    const oldMachinePending = new Promise<Awaited<ReturnType<typeof listAgentSkills>>>((_res, rej) => {
      rejectOldMachine = rej;
    });
    listAgentSkills
      .mockReturnValueOnce(oldMachinePending)
      .mockResolvedValueOnce([{ name: 'linux-skill', description: 'On linux' }]);

    view.rerender(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 3 }));
    const machineSelect = await screen.findByLabelText('sharedContext.management.agentSkills.machineLabel') as HTMLSelectElement;
    await screen.findByRole('option', { name: 'vm-124' });
    machineSelect.value = 'linux';
    fireEvent(machineSelect, new Event('change', { bubbles: true }));

    expect(await screen.findByText('linux-skill')).toBeDefined();

    rejectOldMachine(new Error('stale machine failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('linux-skill')).toBeDefined();
    expect(screen.queryByText('sharedContext.management.agentSkills.loadFailed')).toBeNull();
  });

  it('settles loading and updated skills when Update All completes ahead of an overlapping refresh, and does not clobber another machine switched mid-run', async () => {
    const view = render(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 0 }));
    await screen.findByText('wecomcli-doc');

    let resolveUpdate!: (res: Awaited<ReturnType<typeof runAgentSkills>>) => void;
    const pendingUpdate = new Promise<Awaited<ReturnType<typeof runAgentSkills>>>((res) => {
      resolveUpdate = res;
    });
    let resolveRefresh!: (rows: Awaited<ReturnType<typeof listAgentSkills>>) => void;
    const pendingRefresh = new Promise<Awaited<ReturnType<typeof listAgentSkills>>>((res) => {
      resolveRefresh = res;
    });

    runAgentSkills.mockReturnValueOnce(pendingUpdate);
    listAgentSkills.mockReturnValueOnce(pendingRefresh);

    // Overlap Update All with a concurrent hero refresh on the same machine.
    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.updateAll'));
    view.rerender(h(AgentSkillsPanel, { serverId: 'mac', refreshSignal: 1 }));
    expect(screen.getByText('common.loading')).toBeDefined();

    // Update All completes first with fresh skills; loading must settle immediately and stale refresh must not overwrite.
    resolveUpdate({
      ok: true,
      output: 'Updated',
      skills: [{ name: 'updated-skill', description: 'From update' }],
    });
    expect(await screen.findByText('updated-skill')).toBeDefined();
    expect(screen.queryByText('common.loading')).toBeNull();

    resolveRefresh([{ name: 'stale-refresh-skill', description: 'Stale' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('updated-skill')).toBeDefined();
    expect(screen.queryByText('stale-refresh-skill')).toBeNull();
    expect(screen.queryByText('common.loading')).toBeNull();

    // Now start an action on mac (including empty-skills result), switch to linux while pending -> mac result must not clobber linux.
    let resolveMacAction!: (res: Awaited<ReturnType<typeof runAgentSkills>>) => void;
    const pendingMacAction = new Promise<Awaited<ReturnType<typeof runAgentSkills>>>((res) => {
      resolveMacAction = res;
    });
    runAgentSkills.mockReturnValueOnce(pendingMacAction);
    listAgentSkills.mockResolvedValueOnce([{ name: 'linux-active-skill', description: 'Linux list' }]);

    fireEvent.click(screen.getByText('sharedContext.management.agentSkills.updateAll'));
    const machineSelect = await screen.findByLabelText('sharedContext.management.agentSkills.machineLabel') as HTMLSelectElement;
    await screen.findByRole('option', { name: 'vm-124' });
    machineSelect.value = 'linux';
    fireEvent(machineSelect, new Event('change', { bubbles: true }));
    expect(await screen.findByText('linux-active-skill')).toBeDefined();

    const linuxCallsAfterSwitch = listAgentSkills.mock.calls.length;
    resolveMacAction({ ok: true, output: 'Done on mac' });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('linux-active-skill')).toBeDefined();
    expect(listAgentSkills.mock.calls.length).toBe(linuxCallsAfterSwitch);
    expect(screen.queryByText('common.loading')).toBeNull();
  });
});
