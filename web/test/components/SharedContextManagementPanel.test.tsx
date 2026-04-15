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
const getPersonalCloudMemoryMock = vi.fn();
const getEnterpriseSharedMemoryMock = vi.fn();

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
  getPersonalCloudMemory: (...args: unknown[]) => getPersonalCloudMemoryMock(...args),
  getEnterpriseSharedMemory: (...args: unknown[]) => getEnterpriseSharedMemoryMock(...args),
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
        persisted: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'sonnet',
          backupContextBackend: undefined,
          backupContextModel: undefined,
          enablePersonalMemorySync: false,
        },
        effective: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'sonnet',
          backupContextBackend: undefined,
          backupContextModel: undefined,
          enablePersonalMemorySync: false,
        },
        envPrimaryOverrideActive: false,
        envBackupOverrideActive: false,
        defaultPrimaryContextBackend: 'claude-code-sdk',
        defaultPrimaryContextModel: 'sonnet',
      },
    });
    updateSharedContextRuntimeConfigMock.mockResolvedValue({
      snapshot: {
        persisted: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
          backupContextBackend: 'claude-code-sdk',
          backupContextModel: 'haiku',
          enablePersonalMemorySync: true,
        },
        effective: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
          backupContextBackend: 'claude-code-sdk',
          backupContextModel: 'haiku',
          enablePersonalMemorySync: true,
        },
        envPrimaryOverrideActive: false,
        envBackupOverrideActive: false,
        defaultPrimaryContextBackend: 'claude-code-sdk',
        defaultPrimaryContextModel: 'sonnet',
      },
    });
    getPersonalCloudMemoryMock.mockResolvedValue({
      stats: {
        totalRecords: 2,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 1,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
      records: [
        {
          id: 'cloud-personal-1',
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          summary: 'Cloud personal decision',
          projectionClass: 'durable_memory_candidate',
          sourceEventCount: 3,
          updatedAt: 1700000000000,
        },
      ],
      pendingRecords: [],
    });
    getEnterpriseSharedMemoryMock.mockResolvedValue({
      stats: {
        totalRecords: 4,
        matchedRecords: 2,
        recentSummaryCount: 3,
        durableCandidateCount: 1,
        projectCount: 2,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
      records: [
        {
          id: 'shared-1',
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          summary: 'Shared coding standard reminder',
          projectionClass: 'recent_summary',
          sourceEventCount: 4,
          updatedAt: 1700000001000,
        },
      ],
      pendingRecords: [],
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
    expect((await screen.findAllByText(/@member/)).length).toBeGreaterThan(0);
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

    expect(screen.queryByText('sharedContext.roles.admin')).toBeNull();
    expect(await screen.findByText(/New invitations create member access only\./)).toBeDefined();

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
      fireEvent.click(screen.getByRole('button', { name: 'sharedContext.management.createVersion' }));
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

    const primaryBackend = screen.getByLabelText('sharedContext.management.processingPrimaryBackend: codex-sdk');
    const primaryInput = screen.getByLabelText('sharedContext.management.processingPrimaryModel') as HTMLInputElement;
    const backupBackend = screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen');
    const backupInput = screen.getByLabelText('sharedContext.management.processingBackupModel') as HTMLInputElement;
    fireEvent.click(primaryBackend);
    fireEvent.input(primaryInput, { target: { value: 'gpt-5.4' } });
    fireEvent.click(backupBackend);
    await flush();

    expect(backupInput.value).toBe('qwen3-coder-plus');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.processingSave'));
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      enablePersonalMemorySync: false,
    }));
    expect((screen.getByLabelText('sharedContext.management.processingPrimaryModel') as HTMLInputElement).value).toBe('gpt-5.4');
    expect(await screen.findByText('sharedContext.management.processingSavedPrimaryBackend')).toBeDefined();
  });

  it('renders a shortened server label in the header but keeps the full server scope in processing details', async () => {
    render(<SharedContextManagementPanel serverId="6f380811d06730a7d21cba1c" />);
    await flush();

    expect(await screen.findByText('6f380811…ba1c')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    expect(await screen.findByText('6f380811d06730a7d21cba1c')).toBeDefined();
  });

  it('switches to a backend-appropriate default model when the backend changes', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    const primaryInput = await screen.findByLabelText('sharedContext.management.processingPrimaryModel') as HTMLInputElement;
    expect(primaryInput.value).toBe('sonnet');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingPrimaryBackend: qwen'));
    });

    expect(primaryInput.value).toBe('qwen3-coder-plus');
  });

  it('allows selecting a backup model directly from backend-specific chips', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    const backupInput = await screen.findByLabelText('sharedContext.management.processingBackupModel') as HTMLInputElement;

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen'));
    });
    const qwenChip = await screen.findByLabelText('model:qwen:qwen3-coder-plus');
    await act(async () => {
      fireEvent.click(qwenChip);
    });

    expect(backupInput.value).toBe('qwen3-coder-plus');
  });

  it('preloads a backend-appropriate backup model as soon as the backup backend changes', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    const backupInput = await screen.findByLabelText('sharedContext.management.processingBackupModel') as HTMLInputElement;
    expect(backupInput.value).toBe('');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen'));
    });

    expect(backupInput.value).toBe('qwen3-coder-plus');
  });

  it('loads local, cloud, and enterprise memory views and saves personal sync settings', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let messageHandler: ((message: unknown) => void) | null = null;
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandler = handler;
        return () => {
          if (messageHandler === handler) messageHandler = null;
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    await waitFor(() => expect(fetchSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1'));
    await waitFor(() => expect(getPersonalCloudMemoryMock).toHaveBeenCalledWith(expect.any(Object)));
    await waitFor(() => expect(getEnterpriseSharedMemoryMock).toHaveBeenCalledWith('team-1', expect.any(Object)));

    const queryCommand = sent.find((message) => message.type === 'shared_context.personal_memory.query');
    expect(queryCommand).toBeDefined();

    await act(async () => {
      messageHandler?.({
        type: 'shared_context.personal_memory.response',
        requestId: queryCommand?.requestId,
        stats: {
          totalRecords: 3,
          matchedRecords: 2,
          recentSummaryCount: 2,
          durableCandidateCount: 1,
          projectCount: 2,
          stagedEventCount: 5,
          dirtyTargetCount: 1,
          pendingJobCount: 1,
        },
        records: [
          {
            id: 'local-personal-1',
            scope: 'personal',
            projectId: 'github.com/acme/repo',
            summary: 'User intent: Local personal request\nCurrent outcome: Local compressed summary with enough detail to trigger the collapsed preview control in the management panel.\nKey constraints: keep the summary concise for runtime use, preserve the latest decision, and retain the working preference that was stated earlier in the session.\nCompressed from 5 events.',
            projectionClass: 'recent_summary',
            sourceEventCount: 2,
            updatedAt: 1700000002000,
          },
        ],
        pendingRecords: [
          {
            id: 'pending-1',
            projectId: 'github.com/acme/repo',
            sessionName: 'deck_repo_brain',
            eventType: 'user.turn',
            content: 'Pending raw local event',
            createdAt: 1700000001500,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('memory-record-content-local-personal-1').textContent).toContain('Local compressed summary');
    });
    await waitFor(() => {
      expect(screen.getAllByText('sharedContext.management.memoryLocalTitle').length).toBeGreaterThan(0);
    });
    expect((await screen.findAllByText('sharedContext.management.memoryStatusProcessed')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('sharedContext.management.memoryRecentDescription')).length).toBeGreaterThan(0);

    const memoryContent = screen.getByTestId('memory-record-content-local-personal-1') as HTMLDivElement;
    expect(memoryContent.style.maxHeight).toBe('4.5em');
    const expandButton = screen.getAllByText('sharedContext.management.memoryExpand')[0];
    await act(async () => {
      fireEvent.click(expandButton);
    });
    expect(memoryContent.style.maxHeight).toBe('none');
    expect(screen.getByText('sharedContext.management.memoryCollapse')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabCloud'));
    });
    expect(await screen.findByText('Cloud personal decision')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryDurableDescription')).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabShared'));
    });
    expect(await screen.findByText('Shared coding standard reminder')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabLocalPending'));
    });
    expect(await screen.findByText('Pending raw local event')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.memoryPendingTitle')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryStatusPending')).length).toBeGreaterThan(0);
    expect(await screen.findByText('sharedContext.management.memoryProcessedNote')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryStatDirtyTargets')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('sharedContext.management.memoryStatPendingJobs')).length).toBeGreaterThan(0);

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.personalSyncSave'));
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      enablePersonalMemorySync: true,
    })));
  });
});
