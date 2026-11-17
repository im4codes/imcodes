/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationMachinesSection } from '../../src/components/VerificationMachinesSection.js';

const listMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();
const refetchAliasesMock = vi.fn();
const aliasId = 'b'.repeat(32);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (typeof params?.name === 'string') return `${key}:${params.name}`;
      if (typeof params?.project === 'string') return `${key}:${params.project}`;
      return key;
    },
  }),
}));

vi.mock('../../src/api/verification-machines.js', () => ({
  listVerificationMachines: (...args: unknown[]) => listMock(...args),
  setVerificationMachine: (...args: unknown[]) => setMock(...args),
  removeVerificationMachine: (...args: unknown[]) => removeMock(...args),
}));

vi.mock('../../src/hooks/useAliases.js', () => ({
  useAliases: () => ({
    aliases: [{ id: aliasId, name: '211-gitlab', value: 'ssh k@172.16.253.211', tags: [], createdAt: '', updatedAt: '', source: 'web' }],
    filtered: [], loaded: true, loading: false, error: null, stale: false,
    refetch: refetchAliasesMock, create: vi.fn(), remove: vi.fn(),
  }),
}));

const profile = {
  id: 'a'.repeat(32),
  scope: 'project' as const,
  scopeKey: 'repo-1',
  alias: 'Windows lab',
  kind: 'controlled_node' as const,
  target: '1234567890',
  enabled: true,
  revision: 4,
  createdAt: 1,
  updatedAt: 2,
  lastVerificationStatus: 'verified' as const,
  source: 'web' as const,
};

describe('VerificationMachinesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([profile]);
    setMock.mockImplementation(async (value) => ({ ...profile, ...value }));
    removeMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('loads both synchronized scopes and renames by stable id', async () => {
    render(<VerificationMachinesSection machines={[]} projectKey="repo-1" />);
    const alias = await screen.findByLabelText('controlled_nodes.verification.alias') as HTMLInputElement;
    expect(listMock).toHaveBeenCalledWith('repo-1', { includeAllProjects: true });
    fireEvent.input(alias, { target: { value: 'Renamed lab' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      expectedRevision: 4,
      alias: 'Renamed lab',
      target: '1234567890',
    })));
  });

  it('authorizes a controlled node by canonical nodeId in project scope', async () => {
    render(<VerificationMachinesSection machines={[{
      nodeId: '0987654321',
      displayName: 'Windows 11',
    } as any]} projectKey="repo-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'quick_input.verification_add' }));
    fireEvent.click(await screen.findByRole('tab', { name: /quick_input.tab_machines/ }));
    fireEvent.click(await screen.findByRole('button', {
      name: 'controlled_nodes.verification.authorize_node:Windows 11',
    }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      scopeKey: 'repo-1',
      alias: 'Windows 11',
      kind: 'controlled_node',
      target: '0987654321',
    })));
  });

  it('authorizes an existing alias by its stable id instead of accepting an SSH host field', async () => {
    render(<VerificationMachinesSection machines={[]} projectKey="repo-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'quick_input.verification_add' }));
    expect(screen.getByRole('tab', { name: /alias.tab/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('button', { name: /controlled_nodes.verification.authorize_node/ })).toBeNull();
    expect(screen.queryByPlaceholderText('controlled_nodes.verification.ssh_host')).toBeNull();
    fireEvent.click(await screen.findByRole('button', {
      name: 'controlled_nodes.verification.authorize_alias:211-gitlab',
    }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ssh', target: aliasId, alias: '211-gitlab', scope: 'project', scopeKey: 'repo-1',
    })));
  });

  it('displays project scopeKey and allows renaming, switching to user scope, or deleting when projectKey is undefined or mismatched', async () => {
    render(<VerificationMachinesSection machines={[]} />);
    const alias = await screen.findByLabelText('controlled_nodes.verification.alias') as HTMLInputElement;
    expect(listMock).toHaveBeenCalledWith(undefined, { includeAllProjects: true });
    expect(document.body.textContent).toContain('repo-1');

    // Rename while preserving the saved entry's original project scopeKey ('repo-1').
    fireEvent.input(alias, { target: { value: 'Renamed without active project' } });
    const saveBtn = screen.getByRole('button', { name: 'common.save' }) as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      scope: 'project',
      scopeKey: 'repo-1',
      alias: 'Renamed without active project',
      expectedRevision: 4,
    })));
    await waitFor(() => expect(saveBtn.disabled).toBe(false));

    // Switch saved project entry to global user scope even without an active projectKey.
    const rowScope = screen.getByLabelText('controlled_nodes.verification.scope Windows lab') as HTMLSelectElement;
    act(() => {
      rowScope.value = 'user';
      rowScope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      scope: 'user',
      scopeKey: '',
      expectedRevision: 4,
    })));
    await waitFor(() => expect(saveBtn.disabled).toBe(false));

    // Delete works without active projectKey too.
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith(profile.id, 4));
  });

  it('syncs header scope selector when projectKey arrives asynchronously unless manually chosen by user', async () => {
    const { rerender } = render(<VerificationMachinesSection machines={[]} />);
    await screen.findByLabelText('controlled_nodes.verification.alias');
    const headerScope = document.querySelector('.verification-machines-scope select') as HTMLSelectElement;
    expect(headerScope.value).toBe('user');

    rerender(<VerificationMachinesSection machines={[]} projectKey="repo-2" />);
    await waitFor(() => expect(headerScope.value).toBe('project'));

    // User manually switches back to user scope; subsequent projectKey changes must not overwrite manual choice.
    act(() => {
      headerScope.value = 'user';
      headerScope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(headerScope.value).toBe('user');
    rerender(<VerificationMachinesSection machines={[]} projectKey="repo-3" />);
    expect(headerScope.value).toBe('user');
  });

  it('does not overwrite another project profile when authorizing the same node in a new project', async () => {
    render(<VerificationMachinesSection machines={[{
      nodeId: '1234567890',
      displayName: 'Windows lab',
    } as any]} projectKey="repo-2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'quick_input.verification_add' }));
    fireEvent.click(await screen.findByRole('tab', { name: /quick_input.tab_machines/ }));
    fireEvent.click(await screen.findByRole('button', {
      name: 'controlled_nodes.verification.authorize_node:Windows lab',
    }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      scopeKey: 'repo-2',
      target: '1234567890',
    })));
    expect(setMock.mock.calls[0]?.[0]?.id).toBeUndefined();
  });

  it('surfaces specific conflict/auth errors, refreshes list, and clears stale local edits', async () => {
    const refreshed = { ...profile, alias: 'Server Updated Lab', revision: 5 };
    listMock.mockResolvedValueOnce([profile]).mockResolvedValueOnce([refreshed]);
    setMock.mockRejectedValueOnce(Object.assign(new Error('API 409: revision_conflict'), { code: 'revision_conflict' }));

    render(<VerificationMachinesSection machines={[]} projectKey="repo-1" />);
    const alias = await screen.findByLabelText('controlled_nodes.verification.alias') as HTMLInputElement;
    fireEvent.input(alias, { target: { value: 'Stale local edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('controlled_nodes.verification.error_revision_conflict');
    await waitFor(() => expect(alias.value).toBe('Server Updated Lab'));
    expect(refetchAliasesMock).toHaveBeenCalled();

    // alias_conflict surfaces specific alias conflict message and refreshes.
    listMock.mockResolvedValueOnce([refreshed]);
    setMock.mockRejectedValueOnce(Object.assign(new Error('API 409: alias_conflict'), { code: 'alias_conflict' }));
    fireEvent.input(alias, { target: { value: 'Dup alias' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('controlled_nodes.verification.error_alias_conflict');

    // target_unauthorized surfaces specific unauthorized message and refreshes.
    listMock.mockResolvedValueOnce([]);
    setMock.mockRejectedValueOnce(Object.assign(new Error('API 403: verification_machine_target_unauthorized'), {
      code: 'verification_machine_target_unauthorized',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('controlled_nodes.verification.error_target_unauthorized');
  });

  it('renders and allows editing/deleting entries beyond 100 items when projectKey is mismatched or missing', async () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({
      ...profile,
      id: (i + 1).toString(16).padStart(32, '0'),
      scope: 'project' as const,
      scopeKey: i < 51 ? 'repo-a' : 'repo-b',
      alias: `Machine ${i + 1}`,
      revision: 1,
    }));
    listMock.mockResolvedValue(entries);

    render(<VerificationMachinesSection machines={[]} projectKey="repo-other" />);
    const inputs = await screen.findAllByLabelText('controlled_nodes.verification.alias') as HTMLInputElement[];
    expect(inputs).toHaveLength(101);

    const lastInput = inputs[100]!;
    expect(lastInput.value).toBe('Machine 101');
    fireEvent.input(lastInput, { target: { value: 'Machine 101 Renamed' } });
    const saveButtons = screen.getAllByRole('button', { name: 'common.save' }) as HTMLButtonElement[];
    fireEvent.click(saveButtons[100]!);

    await waitFor(() => expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      id: entries[100]!.id,
      scope: 'project',
      scopeKey: 'repo-b',
      alias: 'Machine 101 Renamed',
      expectedRevision: 1,
    })));
    await waitFor(() => expect(saveButtons[100]!.disabled).toBe(false));

    const deleteButtons = screen.getAllByRole('button', { name: 'common.delete' });
    fireEvent.click(deleteButtons[100]!);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith(entries[100]!.id, 1));
  });
});
