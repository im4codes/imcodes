/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationMachinesSection } from '../../src/components/VerificationMachinesSection.js';

const listMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();
const refetchAliasesMock = vi.fn();
const aliasId = 'b'.repeat(32);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      typeof params?.name === 'string' ? `${key}:${params.name}` : key
    ),
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
    expect(listMock).toHaveBeenCalledWith('repo-1');
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
});
