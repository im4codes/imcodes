/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const listTeamsMock = vi.fn();
const createTeamMock = vi.fn();
const getTeamMock = vi.fn();
const createTeamInviteMock = vi.fn();
const joinTeamByTokenMock = vi.fn();
const updateTeamMemberRoleMock = vi.fn();
const removeTeamMemberMock = vi.fn();
const listSharedWorkspacesMock = vi.fn();
const createSharedWorkspaceMock = vi.fn();
const listSharedProjectsMock = vi.fn();
const enrollSharedProjectMock = vi.fn();
const updateSharedProjectPolicyMock = vi.fn();
const getSharedProjectPolicyMock = vi.fn();
const listSharedDocumentsMock = vi.fn();
const createSharedDocumentMock = vi.fn();
const createSharedDocumentVersionMock = vi.fn();
const activateSharedDocumentVersionMock = vi.fn();
const listSharedDocumentBindingsMock = vi.fn();
const createSharedDocumentBindingMock = vi.fn();
const fetchSharedContextRuntimeConfigMock = vi.fn();
const updateSharedContextRuntimeConfigMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  ApiError: class ApiError extends Error {
    code: string | null;
    constructor(public status: number, public body: string) {
      super(body);
      this.code = body;
    }
  },
  listTeams: (...args: unknown[]) => listTeamsMock(...args),
  createTeam: (...args: unknown[]) => createTeamMock(...args),
  getTeam: (...args: unknown[]) => getTeamMock(...args),
  createTeamInvite: (...args: unknown[]) => createTeamInviteMock(...args),
  joinTeamByToken: (...args: unknown[]) => joinTeamByTokenMock(...args),
  updateTeamMemberRole: (...args: unknown[]) => updateTeamMemberRoleMock(...args),
  removeTeamMember: (...args: unknown[]) => removeTeamMemberMock(...args),
  listSharedWorkspaces: (...args: unknown[]) => listSharedWorkspacesMock(...args),
  createSharedWorkspace: (...args: unknown[]) => createSharedWorkspaceMock(...args),
  listSharedProjects: (...args: unknown[]) => listSharedProjectsMock(...args),
  enrollSharedProject: (...args: unknown[]) => enrollSharedProjectMock(...args),
  updateSharedProjectPolicy: (...args: unknown[]) => updateSharedProjectPolicyMock(...args),
  getSharedProjectPolicy: (...args: unknown[]) => getSharedProjectPolicyMock(...args),
  listSharedDocuments: (...args: unknown[]) => listSharedDocumentsMock(...args),
  createSharedDocument: (...args: unknown[]) => createSharedDocumentMock(...args),
  createSharedDocumentVersion: (...args: unknown[]) => createSharedDocumentVersionMock(...args),
  activateSharedDocumentVersion: (...args: unknown[]) => activateSharedDocumentVersionMock(...args),
  listSharedDocumentBindings: (...args: unknown[]) => listSharedDocumentBindingsMock(...args),
  createSharedDocumentBinding: (...args: unknown[]) => createSharedDocumentBindingMock(...args),
  fetchSharedContextRuntimeConfig: (...args: unknown[]) => fetchSharedContextRuntimeConfigMock(...args),
  updateSharedContextRuntimeConfig: (...args: unknown[]) => updateSharedContextRuntimeConfigMock(...args),
}));

import { SharedContextManagementPanel } from '../../src/components/SharedContextManagementPanel.js';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SharedContextManagementPanel', () => {
  beforeEach(() => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', name: 'Acme', role: 'owner' }]);
    getTeamMock.mockResolvedValue({
      id: 'team-1',
      name: 'Acme',
      myRole: 'owner',
      members: [
        { user_id: 'user-owner', username: 'owner', display_name: 'Owner User', role: 'owner', joined_at: 1 },
        { user_id: 'user-member', username: 'member', display_name: null, role: 'member', joined_at: 2 },
      ],
    });
    listSharedWorkspacesMock.mockResolvedValue([{ id: 'ws-1', enterpriseId: 'team-1', name: 'Platform' }]);
    listSharedProjectsMock.mockResolvedValue([{ id: 'enr-1', workspaceId: 'ws-1', canonicalRepoId: 'github.com/acme/repo', displayName: 'Repo', scope: 'project_shared', status: 'active' }]);
    getSharedProjectPolicyMock.mockResolvedValue({
      enrollmentId: 'enr-1',
      enterpriseId: 'team-1',
      allowDegradedProviderSupport: true,
      allowLocalFallback: false,
      requireFullProviderSupport: false,
    });
    listSharedDocumentsMock.mockResolvedValue([{ id: 'doc-1', enterpriseId: 'team-1', kind: 'coding_standard', title: 'Rules', versions: [{ id: 'ver-1', versionNumber: 1, status: 'active' }] }]);
    listSharedDocumentBindingsMock.mockResolvedValue([{ id: 'bind-1', workspaceId: 'ws-1', enrollmentId: 'enr-1', documentId: 'doc-1', versionId: 'ver-1', mode: 'required', applicabilityRepoId: 'github.com/acme/repo', applicabilityLanguage: 'typescript', applicabilityPathPattern: 'src/**', status: 'active' }]);
    createTeamMock.mockResolvedValue({ id: 'team-2', name: 'New Team', role: 'owner' });
    createTeamInviteMock.mockResolvedValue({ token: 'invite-token', expiresAt: 123 });
    joinTeamByTokenMock.mockResolvedValue({ ok: true, teamId: 'team-1', role: 'member' });
    createSharedWorkspaceMock.mockResolvedValue({ id: 'ws-2', enterpriseId: 'team-1', name: 'Infra' });
    enrollSharedProjectMock.mockResolvedValue({ id: 'enr-2' });
    updateSharedProjectPolicyMock.mockResolvedValue({ ok: true });
    createSharedDocumentMock.mockResolvedValue({ id: 'doc-2' });
    createSharedDocumentVersionMock.mockResolvedValue({ id: 'ver-2', documentId: 'doc-1', versionNumber: 2, status: 'draft' });
    activateSharedDocumentVersionMock.mockResolvedValue({ ok: true, versionId: 'ver-1', status: 'active' });
    createSharedDocumentBindingMock.mockResolvedValue({ id: 'bind-2' });
    updateTeamMemberRoleMock.mockResolvedValue({ ok: true });
    removeTeamMemberMock.mockResolvedValue({ ok: true });
    fetchSharedContextRuntimeConfigMock.mockResolvedValue({
      snapshot: {
        persisted: { primaryContextModel: 'sonnet', backupContextModel: undefined },
        effective: { primaryContextModel: 'sonnet', backupContextModel: undefined },
        envPrimaryOverrideActive: false,
        envBackupOverrideActive: false,
        defaultPrimaryContextModel: 'sonnet',
      },
    });
    updateSharedContextRuntimeConfigMock.mockResolvedValue({
      snapshot: {
        persisted: { primaryContextModel: 'gpt-5.4', backupContextModel: 'haiku' },
        effective: { primaryContextModel: 'gpt-5.4', backupContextModel: 'haiku' },
        envPrimaryOverrideActive: false,
        envBackupOverrideActive: false,
        defaultPrimaryContextModel: 'sonnet',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads enterprise data and renders members, workspaces, projects, and documents', async () => {
    render(<SharedContextManagementPanel />);
    await flush();
    await waitFor(() => expect(getTeamMock).toHaveBeenCalledWith('team-1'));
    expect((await screen.findAllByText(/Platform/)).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.members'));
    });
    expect(await screen.findByText(/Owner User/)).toBeDefined();
    expect(await screen.findByText(/@member/)).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.projects'));
    });
    expect((await screen.findAllByText(/Repo/)).length).toBeGreaterThan(0);
    expect(await screen.findByText('sharedContext.management.projectRelationshipTitle')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.knowledge'));
    });
    expect((await screen.findAllByText(/Rules/)).length).toBeGreaterThan(0);
  });

  it('creates invite, workspace, document version, and binding', async () => {
    render(<SharedContextManagementPanel />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.createInvite'));
    });
    expect(createTeamInviteMock).toHaveBeenCalledWith('team-1', 'member', undefined);
    expect(await screen.findByText('invite-token')).toBeDefined();

    const workspaceNameInput = screen.getByPlaceholderText('sharedContext.management.workspaceNamePlaceholder') as HTMLInputElement;
    fireEvent.input(workspaceNameInput, { target: { value: 'Infra' } });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.createWorkspace'));
    });
    expect(createSharedWorkspaceMock).toHaveBeenCalledWith('team-1', 'Infra');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.knowledge'));
    });

    const documentContent = screen.getByPlaceholderText('sharedContext.management.documentContent') as HTMLTextAreaElement;
    fireEvent.input(documentContent, { target: { value: 'Use strict types.' } });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.createVersion'));
    });
    expect(createSharedDocumentVersionMock).toHaveBeenCalledWith('doc-1', { contentMd: 'Use strict types.' });

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.createBinding'));
    });
    expect(createSharedDocumentBindingMock).toHaveBeenCalled();
  });

  it('updates member role and enrolls a project', async () => {
    render(<SharedContextManagementPanel />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.members'));
    });
    await screen.findByText('sharedContext.management.promoteAdmin');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.promoteAdmin'));
    });
    expect(updateTeamMemberRoleMock).toHaveBeenCalledWith('team-1', 'user-member', 'admin');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.projects'));
    });
    const repoInput = screen.getByPlaceholderText('sharedContext.management.canonicalRepoId') as HTMLInputElement;
    fireEvent.input(repoInput, { target: { value: 'github.com/acme/new-repo' } });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.enrollProject'));
    });
    expect(enrollSharedProjectMock).toHaveBeenCalledWith('team-1', expect.objectContaining({
      canonicalRepoId: 'github.com/acme/new-repo',
      scope: 'project_shared',
    }));
  });

  it('loads the saved project policy instead of resetting to hardcoded defaults', async () => {
    getSharedProjectPolicyMock.mockResolvedValue({
      enrollmentId: 'enr-1',
      enterpriseId: 'team-1',
      allowDegradedProviderSupport: false,
      allowLocalFallback: true,
      requireFullProviderSupport: true,
    });

    render(<SharedContextManagementPanel />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.projects'));
    });

    await waitFor(() => expect(getSharedProjectPolicyMock).toHaveBeenCalledWith('enr-1'));

    expect(await screen.findByText('sharedContext.management.policyExplainTitle')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.allowDegradedHelp')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.allowLocalFallbackHelp')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.requireFullSupportHelp')).toBeDefined();

    await waitFor(() => {
      const degraded = screen.getByLabelText(/sharedContext.management.allowDegraded/i) as HTMLInputElement;
      const localFallback = screen.getByLabelText(/sharedContext.management.allowLocalFallback/i) as HTMLInputElement;
      const fullSupport = screen.getByLabelText(/sharedContext.management.requireFullSupport/i) as HTMLInputElement;
      expect(degraded.checked).toBe(false);
      expect(localFallback.checked).toBe(true);
      expect(fullSupport.checked).toBe(true);
    });
  });

  it('does not loop enterprise-change notifications when parent rerenders with a new callback identity', async () => {
    const onEnterpriseChange = vi.fn();

    function Wrapper() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((prev) => prev + 1)}>rerender</button>
          <SharedContextManagementPanel onEnterpriseChange={(enterpriseId) => onEnterpriseChange(enterpriseId)} />
        </div>
      );
    }

    render(<Wrapper />);
    await flush();
    await waitFor(() => expect(getTeamMock).toHaveBeenCalledWith('team-1'));
    expect(onEnterpriseChange).toHaveBeenCalledTimes(1);
    expect(onEnterpriseChange).toHaveBeenLastCalledWith('team-1');

    await act(async () => {
      fireEvent.click(screen.getByText('rerender'));
    });

    expect(onEnterpriseChange).toHaveBeenCalledTimes(1);
  });

  it('loads and saves server-backed processing config', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    await waitFor(() => expect(fetchSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1'));

    const primaryInput = screen.getByLabelText('sharedContext.management.processingPrimaryModel') as HTMLInputElement;
    const backupInput = screen.getByLabelText('sharedContext.management.processingBackupModel') as HTMLInputElement;
    fireEvent.input(primaryInput, { target: { value: 'gpt-5.4' } });
    fireEvent.input(backupInput, { target: { value: 'haiku' } });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.processingSave'));
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextModel: 'gpt-5.4',
      backupContextModel: 'haiku',
    }));
    expect(await screen.findByText('gpt-5.4')).toBeDefined();
  });
});
