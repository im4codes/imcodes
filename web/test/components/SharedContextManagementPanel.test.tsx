/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
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
const listSharedDocumentsMock = vi.fn();
const createSharedDocumentMock = vi.fn();
const createSharedDocumentVersionMock = vi.fn();
const activateSharedDocumentVersionMock = vi.fn();
const listSharedDocumentBindingsMock = vi.fn();
const createSharedDocumentBindingMock = vi.fn();

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
  listSharedDocuments: (...args: unknown[]) => listSharedDocumentsMock(...args),
  createSharedDocument: (...args: unknown[]) => createSharedDocumentMock(...args),
  createSharedDocumentVersion: (...args: unknown[]) => createSharedDocumentVersionMock(...args),
  activateSharedDocumentVersion: (...args: unknown[]) => activateSharedDocumentVersionMock(...args),
  listSharedDocumentBindings: (...args: unknown[]) => listSharedDocumentBindingsMock(...args),
  createSharedDocumentBinding: (...args: unknown[]) => createSharedDocumentBindingMock(...args),
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
    getTeamMock.mockResolvedValue({ id: 'team-1', name: 'Acme', myRole: 'owner', members: [{ user_id: 'user-owner', role: 'owner', joined_at: 1 }, { user_id: 'user-member', role: 'member', joined_at: 2 }] });
    listSharedWorkspacesMock.mockResolvedValue([{ id: 'ws-1', enterpriseId: 'team-1', name: 'Platform' }]);
    listSharedProjectsMock.mockResolvedValue([{ id: 'enr-1', workspaceId: 'ws-1', canonicalRepoId: 'github.com/acme/repo', displayName: 'Repo', scope: 'project_shared', status: 'active' }]);
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
    expect((await screen.findAllByText(/Repo/)).length).toBeGreaterThan(0);
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
    await screen.findByText('sharedContext.management.promoteAdmin');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.promoteAdmin'));
    });
    expect(updateTeamMemberRoleMock).toHaveBeenCalledWith('team-1', 'user-member', 'admin');

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
});
