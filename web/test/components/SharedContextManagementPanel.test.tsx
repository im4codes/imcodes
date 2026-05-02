/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { MEMORY_WS } from '@shared/memory-ws.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from '@shared/feature-flags.js';
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
const deletePersonalCloudMemoryMock = vi.fn();
const deleteEnterpriseSharedMemoryMock = vi.fn();

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
  deletePersonalCloudMemory: (...args: unknown[]) => deletePersonalCloudMemoryMock(...args),
  deleteEnterpriseSharedMemory: (...args: unknown[]) => deleteEnterpriseSharedMemoryMock(...args),
}));

import { SharedContextManagementPanel } from '../../src/components/SharedContextManagementPanel.js';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
          primaryContextPreset: undefined,
          backupContextBackend: undefined,
          backupContextModel: undefined,
          backupContextPreset: undefined,
          memoryRecallMinScore: 0.4,
          memoryScoringWeights: {
            similarity: 0.4,
            recency: 0.25,
            frequency: 0.15,
            project: 0.2,
          },
          enablePersonalMemorySync: false,
        },
        effective: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'sonnet',
          primaryContextPreset: undefined,
          backupContextBackend: undefined,
          backupContextModel: undefined,
          backupContextPreset: undefined,
          memoryRecallMinScore: 0.4,
          memoryScoringWeights: {
            similarity: 0.4,
            recency: 0.25,
            frequency: 0.15,
            project: 0.2,
          },
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
          primaryContextPreset: undefined,
          backupContextBackend: 'claude-code-sdk',
          backupContextModel: 'haiku',
          backupContextPreset: undefined,
          memoryRecallMinScore: 0.37,
          memoryScoringWeights: {
            similarity: 0.5,
            recency: 0.2,
            frequency: 0.1,
            project: 0.2,
          },
          enablePersonalMemorySync: true,
        },
        effective: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
          primaryContextPreset: undefined,
          backupContextBackend: 'claude-code-sdk',
          backupContextModel: 'haiku',
          backupContextPreset: undefined,
          memoryRecallMinScore: 0.37,
          memoryScoringWeights: {
            similarity: 0.5,
            recency: 0.2,
            frequency: 0.1,
            project: 0.2,
          },
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
    deletePersonalCloudMemoryMock.mockResolvedValue({ ok: true });
    deleteEnterpriseSharedMemoryMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
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
    vi.unstubAllGlobals();
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
    const backupBackend = screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen');
    fireEvent.click(primaryBackend);
    fireEvent.click(backupBackend);
    await flush();
    expect(screen.getAllByLabelText('model:qwen:qwen3-coder-plus').some((el) => el.getAttribute('aria-pressed') === 'true')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.processingSave'));
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: undefined,
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: false,
    }));
    expect(screen.getAllByLabelText('model:codex-sdk:gpt-5.4').some((el) => el.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(await screen.findByText('sharedContext.management.processingSavedPrimaryBackend')).toBeDefined();
  });

  it('loads and saves the message recall threshold from memory settings', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    const thresholdInput = await screen.findByLabelText('sharedContext.management.memoryRecallThresholdLabel') as HTMLInputElement;
    expect(thresholdInput.value).toBe('0.4');

    fireEvent.input(thresholdInput, { target: { value: '0.36', valueAsNumber: 0.36 } });

    await act(async () => {
      fireEvent.click(screen.getAllByText('sharedContext.management.processingSave')[0]);
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: undefined,
      backupContextBackend: undefined,
      backupContextModel: undefined,
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.36,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: false,
    }));
  });

  it('shows advanced scoring controls only after toggling and saves custom weights', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    expect(screen.queryByLabelText('sharedContext.management.memoryWeightSimilarity')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryAdvancedScoringShow'));
    });

    const similarity = await screen.findByLabelText('sharedContext.management.memoryWeightSimilarity') as HTMLInputElement;
    const recency = screen.getByLabelText('sharedContext.management.memoryWeightRecency') as HTMLInputElement;
    fireEvent.input(similarity, { target: { value: '0.5', valueAsNumber: 0.5 } });
    fireEvent.input(recency, { target: { value: '0.2', valueAsNumber: 0.2 } });

    await act(async () => {
      fireEvent.click(screen.getAllByText('sharedContext.management.processingSave')[1]);
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: undefined,
      backupContextBackend: undefined,
      backupContextModel: undefined,
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4762,
        recency: 0.1905,
        frequency: 0.1429,
        project: 0.1905,
      },
      enablePersonalMemorySync: false,
    }));
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

    await waitFor(() => {
      expect(screen.getAllByLabelText('model:claude-code-sdk:sonnet').some((el) => el.getAttribute('aria-pressed') === 'true')).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingPrimaryBackend: qwen'));
    });

    expect(screen.getAllByLabelText('model:qwen:qwen3-coder-plus').some((el) => el.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('allows selecting a backup model directly from backend-specific chips', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen'));
    });
    const qwenChip = await screen.findByLabelText('model:qwen:qwen3-coder-plus');
    await act(async () => {
      fireEvent.click(qwenChip);
    });

    expect(qwenChip.getAttribute('aria-pressed')).toBe('true');
  });

  it('preloads a backend-appropriate backup model as soon as the backup backend changes', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });

    expect(screen.getAllByLabelText('model:claude-code-sdk:sonnet').some((el) => el.getAttribute('aria-pressed') === 'false')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingBackupBackend: qwen'));
    });

    expect(screen.getAllByLabelText('model:qwen:qwen3-coder-plus').some((el) => el.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('loads qwen presets from ws and persists the selected preset with its derived model', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    expect(sent.some((message) => message.type === 'cc.presets.list')).toBe(true);

    await act(async () => {
      for (const handler of messageHandlers) {
        handler({
          type: 'cc.presets.list_response',
          presets: [
            { name: 'Qwen Team', env: { ANTHROPIC_MODEL: 'qwen-team-model' } },
          ],
        });
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.processing'));
    });
    await waitFor(() => expect(fetchSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1'));
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('sharedContext.management.processingPrimaryBackend: qwen'));
    });

    // Preset chip — the old `<select>` was replaced with a chip button labeled
    // `{idPrefix}:preset:{name}` so the selector is discoverable and testable
    // without needing combo-box semantics.
    const presetChip = await screen.findByLabelText('primary:preset:Qwen Team');
    await act(async () => {
      fireEvent.click(presetChip);
    });

    // Clicking the preset chip should mark it active AND mirror the preset's
    // ANTHROPIC_MODEL onto the built-in model highlight so the saved payload
    // carries the correct model identifier.
    expect(presetChip.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.processingSave'));
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', {
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen-team-model',
      primaryContextPreset: 'Qwen Team',
      backupContextBackend: undefined,
      backupContextModel: undefined,
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: false,
    }));
  });

  it('loads local, cloud, and enterprise memory views and saves personal sync settings', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
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

    const queryCommand = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
    expect(queryCommand).toBeDefined();

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PERSONAL_RESPONSE,
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
    expect((await screen.findAllByText('sharedContext.management.memoryRecentDescription')).length).toBeGreaterThan(0);

    const memoryContent = screen.getByTestId('memory-record-content-local-personal-1') as HTMLDivElement;
    expect(memoryContent.style.maxHeight).toBe('4.8em');
    // Expand by clicking on the collapsed content area (corner fold is SVG, click parent)
    await act(async () => {
      fireEvent.click(memoryContent.parentElement!);
    });
    expect(memoryContent.style.maxHeight).toBe('none');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabCloud'));
    });
    expect(await screen.findByText('Cloud personal decision')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryDurableDescription')).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabEnterprise'));
    });
    expect(await screen.findByText('Shared coding standard reminder')).toBeDefined();
    await act(async () => {
      // Switch back to personal tab, then to unprocessed sub-tab
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabPersonal'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabLocalPending'));
    });
    expect(await screen.findByText('Pending raw local event')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.memoryPendingTitle')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryStatusPending')).length).toBeGreaterThan(0);
    expect(await screen.findByText('sharedContext.management.memoryProcessedNote')).toBeDefined();
    expect((await screen.findAllByText('sharedContext.management.memoryStatDirtyTargets')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('sharedContext.management.memoryStatPendingJobs')).length).toBeGreaterThan(0);

    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // Click the toggle row — auto-saves
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => expect(updateSharedContextRuntimeConfigMock).toHaveBeenCalledWith('srv-1', expect.objectContaining({
      enablePersonalMemorySync: true,
    })));
  });

  it('keeps memory browsing on all projects by default and explains cloud-only personal memory', async () => {
    getPersonalCloudMemoryMock.mockResolvedValueOnce({
      stats: {
        totalRecords: 16059,
        matchedRecords: 16059,
        recentSummaryCount: 0,
        durableCandidateCount: 16059,
        projectCount: 12,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
      records: [
        {
          id: 'cloud-personal-large',
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          summary: 'Large synced personal memory set',
          projectionClass: 'durable_memory_candidate',
          sourceEventCount: 8,
          updatedAt: 1700000003000,
        },
      ],
      pendingRecords: [],
    });
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    const localQuery = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
    expect(localQuery).toBeDefined();
    expect(localQuery).not.toHaveProperty('canonicalRepoId');
    expect(localQuery).not.toHaveProperty('projectId');

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PERSONAL_RESPONSE,
        requestId: localQuery?.requestId,
        stats: {
          totalRecords: 0,
          matchedRecords: 0,
          recentSummaryCount: 0,
          durableCandidateCount: 0,
          projectCount: 0,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [],
        pendingRecords: [],
      });
    });

    expect(await screen.findByText('sharedContext.management.memoryProcessedEmptyWithCloud')).toBeDefined();
    expect((await screen.findAllByText('16059')).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryViewPersonalCloud'));
    });
    expect(await screen.findByText('Large synced personal memory set')).toBeDefined();
  });

  it('adds daemon memory project indexes to the browse dropdown without forcing a default project filter', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    const localQuery = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
    expect(localQuery).toBeDefined();
    expect(localQuery).not.toHaveProperty('canonicalRepoId');
    expect(localQuery).not.toHaveProperty('projectId');

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PERSONAL_RESPONSE,
        requestId: localQuery?.requestId,
        stats: {
          totalRecords: 42,
          matchedRecords: 42,
          recentSummaryCount: 20,
          durableCandidateCount: 22,
          projectCount: 2,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [],
        pendingRecords: [],
        projects: [
          {
            projectId: 'github.com/im4codes/imcodes',
            displayName: 'im4codes/imcodes',
            totalRecords: 40,
            recentSummaryCount: 19,
            durableCandidateCount: 21,
            updatedAt: 1700000005000,
          },
          {
            projectId: 'local/201eaffedeeb',
            totalRecords: 2,
            recentSummaryCount: 1,
            durableCandidateCount: 1,
          },
        ],
      });
    });

    const browseSelect = await screen.findByLabelText('sharedContext.management.memoryBrowseProjectFilter') as HTMLSelectElement;
    expect(browseSelect.value).toBe('');
    const optionValues = Array.from(browseSelect.options).map((option) => option.value);
    expect(optionValues).toContain('github.com/im4codes/imcodes');
    expect(optionValues).toContain('local/201eaffedeeb');

    await act(async () => {
      fireEvent.input(browseSelect, { target: { value: 'github.com/im4codes/imcodes' } });
    });

    await waitFor(() => {
      const filteredQuery = [...sent].reverse().find((message) => (
        message.type === MEMORY_WS.PERSONAL_QUERY
        && message.canonicalRepoId === 'github.com/im4codes/imcodes'
      ));
      expect(filteredQuery).toMatchObject({
        canonicalRepoId: 'github.com/im4codes/imcodes',
        projectId: 'github.com/im4codes/imcodes',
      });
    });
  });

  it('shows actionable daemon and feature-state reasons instead of disabled/unknown-only memory UI', async () => {
    render(<SharedContextManagementPanel serverId="srv-1" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    expect((await screen.findAllByText('sharedContext.management.memoryFeatureUnavailable')).length).toBeGreaterThan(0);
    expect(await screen.findByText('sharedContext.management.memoryLocalStatusUnavailable')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryToolTabPreferences'));
    });
    expect((await screen.findAllByText('sharedContext.management.memoryToolDisabledNoDaemon')).length).toBeGreaterThan(0);
  });

  it('does not render local daemon errors as healthy zero memory stats', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    const localQuery = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
    expect(localQuery).toBeDefined();

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PERSONAL_RESPONSE,
        requestId: localQuery?.requestId,
        errorCode: 'management_request_unrouted',
        error: 'missing management context',
        stats: {
          totalRecords: 0,
          matchedRecords: 0,
          recentSummaryCount: 0,
          durableCandidateCount: 0,
          projectCount: 0,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [],
        pendingRecords: [],
      });
    });

    expect(await screen.findByText('sharedContext.management.memoryLocalStatusError')).toBeDefined();
    expect(screen.queryByText('sharedContext.management.memoryStatTotal')).toBeNull();
    expect(screen.queryByText('sharedContext.management.memoryProcessedEmptyPending')).toBeNull();
  });

  it('ignores stale cloud memory responses after a newer project filter load starts', async () => {
    const firstCloud = deferred<Awaited<ReturnType<typeof getPersonalCloudMemoryMock>>>();
    const secondCloud = deferred<Awaited<ReturnType<typeof getPersonalCloudMemoryMock>>>();
    getPersonalCloudMemoryMock
      .mockReturnValueOnce(firstCloud.promise)
      .mockReturnValueOnce(secondCloud.promise);

    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(
      <SharedContextManagementPanel
        serverId="srv-1"
        ws={ws as never}
        activeProjectDir="/work/repo"
        memoryProjectCandidates={[{
          projectDir: '/work/repo',
          displayName: 'Repo',
          canonicalRepoId: 'github.com/acme/repo',
          source: 'active_session',
        }]}
      />,
    );
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });
    await act(async () => {
      const browseSelect = screen.getByLabelText('sharedContext.management.memoryBrowseProjectFilter') as HTMLSelectElement;
      fireEvent.input(browseSelect, { target: { value: 'github.com/acme/repo' } });
    });

    await act(async () => {
      secondCloud.resolve({
        stats: {
          totalRecords: 7,
          matchedRecords: 7,
          recentSummaryCount: 0,
          durableCandidateCount: 7,
          projectCount: 1,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [{
          id: 'latest-cloud',
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          summary: 'Latest cloud memory',
          projectionClass: 'durable_memory_candidate',
          sourceEventCount: 1,
          updatedAt: 1700000004000,
        }],
        pendingRecords: [],
      });
      await secondCloud.promise;
    });

    await act(async () => {
      firstCloud.resolve({
        stats: {
          totalRecords: 99,
          matchedRecords: 99,
          recentSummaryCount: 0,
          durableCandidateCount: 99,
          projectCount: 1,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [{
          id: 'stale-cloud',
          scope: 'personal',
          projectId: 'github.com/old/repo',
          summary: 'Stale cloud memory',
          projectionClass: 'durable_memory_candidate',
          sourceEventCount: 1,
          updatedAt: 1700000001000,
        }],
        pendingRecords: [],
      });
      await firstCloud.promise;
    });

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabCloud'));
    });
    expect(await screen.findByText('Latest cloud memory')).toBeDefined();
    expect(screen.queryByText('Stale cloud memory')).toBeNull();
  });

  it('deletes local, cloud, and enterprise memory records', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    const localQuery = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
    expect(localQuery).toBeDefined();

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PERSONAL_RESPONSE,
        requestId: localQuery?.requestId,
        stats: {
          totalRecords: 1,
          matchedRecords: 1,
          recentSummaryCount: 1,
          durableCandidateCount: 0,
          projectCount: 1,
          stagedEventCount: 0,
          dirtyTargetCount: 0,
          pendingJobCount: 0,
        },
        records: [
          {
            id: 'local-personal-1',
            scope: 'personal',
            projectId: 'github.com/acme/repo',
            summary: 'Local personal summary',
            projectionClass: 'recent_summary',
            sourceEventCount: 1,
            updatedAt: 1700000000000,
          },
        ],
        pendingRecords: [],
      });
    });

    const localDeleteButtons = await screen.findAllByText('sharedContext.management.memoryDelete');
    await act(async () => {
      fireEvent.click(localDeleteButtons[0]);
    });
    const deleteCommand = sent.find((message) => message.type === MEMORY_WS.DELETE);
    expect(deleteCommand).toMatchObject({ id: 'local-personal-1' });
    await act(async () => {
      for (const handler of messageHandlers) handler({ type: MEMORY_WS.DELETE_RESPONSE, requestId: deleteCommand?.requestId, success: true });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabCloud'));
    });
    const cloudDeleteButtons = await screen.findAllByText('sharedContext.management.memoryDelete');
    await act(async () => {
      fireEvent.click(cloudDeleteButtons[0]);
    });
    await waitFor(() => expect(deletePersonalCloudMemoryMock).toHaveBeenCalledWith('cloud-personal-1'));

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryTabEnterprise'));
    });
    const enterpriseDeleteButtons = await screen.findAllByText('sharedContext.management.memoryDelete');
    await act(async () => {
      fireEvent.click(enterpriseDeleteButtons[0]);
    });
    await waitFor(() => expect(deleteEnterpriseSharedMemoryMock).toHaveBeenCalledWith('team-1', 'shared-1'));
  });

  it('resolves directory-only memory project options through the daemon before using the canonical id', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(
      <SharedContextManagementPanel
        serverId="srv-1"
        ws={ws as never}
        activeProjectDir="/work/repo"
        memoryProjectCandidates={[{
          projectDir: '/work/repo',
          displayName: 'Repo',
          source: 'active_session',
        }]}
      />,
    );
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    await waitFor(() => {
      expect(sent.some((message) => message.type === MEMORY_WS.PROJECT_RESOLVE && message.projectDir === '/work/repo')).toBe(true);
    });
    const resolveCommand = [...sent].reverse().find((message) => message.type === MEMORY_WS.PROJECT_RESOLVE);
    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
        requestId: resolveCommand?.requestId,
        success: true,
        status: 'resolved',
        projectDir: '/work/repo',
        canonicalRepoId: 'github.com/acme/repo',
        displayName: 'acme/repo',
      });
    });

    await waitFor(() => {
      const latestPersonalQuery = [...sent].reverse().find((message) => message.type === MEMORY_WS.PERSONAL_QUERY);
      expect(latestPersonalQuery).toBeTruthy();
      expect(latestPersonalQuery).not.toHaveProperty('canonicalRepoId');
      expect(latestPersonalQuery).not.toHaveProperty('projectId');
    });

    await act(async () => {
      const browseSelect = screen.getByLabelText('sharedContext.management.memoryBrowseProjectFilter') as HTMLSelectElement;
      fireEvent.input(browseSelect, { target: { value: 'github.com/acme/repo' } });
    });

    await waitFor(() => {
      const latestPersonalQuery = [...sent].reverse().find((message) => (
        message.type === MEMORY_WS.PERSONAL_QUERY
        && message.canonicalRepoId === 'github.com/acme/repo'
      ));
      expect(latestPersonalQuery).toMatchObject({
        canonicalRepoId: 'github.com/acme/repo',
        projectId: 'github.com/acme/repo',
      });
    });
    expect(screen.getAllByText('github.com/acme/repo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/work/repo').length).toBeGreaterThan(0);
  });


  it('exposes post-1.1 preference, skill, markdown, and observation management controls', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: unknown) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.tabs.memory'));
    });

    await waitFor(() => expect(sent.some((message) => message.type === MEMORY_WS.PREF_QUERY)).toBe(true));
    expect(sent.some((message) => message.type === MEMORY_WS.FEATURES_QUERY)).toBe(true);
    expect(sent.some((message) => message.type === MEMORY_WS.SKILL_QUERY)).toBe(true);
    expect(sent.some((message) => message.type === MEMORY_WS.OBSERVATION_QUERY)).toBe(true);
    const latestRequestId = (type: string) => [...sent].reverse().find((message) => message.type === type)?.requestId as string | undefined;
    const latestCommand = (type: string) => [...sent].reverse().find((message) => message.type === type) as Record<string, unknown> | undefined;
    await act(async () => {
      fireEvent.input(screen.getByPlaceholderText('sharedContext.management.memoryPreferenceTextPlaceholder'), {
        target: { value: 'Prefer ignored stale response.' },
      });
    });
    expect(screen.getByText('sharedContext.management.memoryPreferenceSave')).toHaveProperty('disabled', true);
    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PREF_RESPONSE,
        requestId: 'stale-or-other-tab',
        featureEnabled: true,
        records: [{
          id: 'pref-stale',
          userId: 'daemon-local',
          text: 'Stale response should not render.',
          fingerprint: 'fp-stale',
          origin: 'user_note',
          state: 'active',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        }],
      });
    });
    expect(screen.queryByText('Stale response should not render.')).toBeNull();

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.FEATURES_RESPONSE,
        requestId: latestRequestId(MEMORY_WS.FEATURES_QUERY),
        records: [
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences, enabled: true, disabledBehavior: 'Preferences enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest, enabled: true, disabledBehavior: 'MD ingest enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skills, enabled: true, disabledBehavior: 'Skills enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation, enabled: true, disabledBehavior: 'Skill review enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, enabled: true, disabledBehavior: 'Observation store enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry, enabled: true, disabledBehavior: 'Namespace registry enabled.' },
        ],
      });
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.PREF_RESPONSE,
        requestId: latestRequestId(MEMORY_WS.PREF_QUERY),
        featureEnabled: true,
        records: [{
          id: 'pref-1',
          userId: 'daemon-local',
          text: 'Always prefer tests.',
          fingerprint: 'fp-pref',
          origin: 'user_note',
          state: 'active',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        }],
      });
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.SKILL_RESPONSE,
        requestId: latestRequestId(MEMORY_WS.SKILL_QUERY),
        featureEnabled: true,
        entries: [{
          key: 'typescript/test-runner',
          layer: 'user_default',
          name: 'Test Runner',
          category: 'typescript',
          description: 'Run focused tests.',
          displayPath: '~/.imcodes/skills/typescript/test-runner.md',
          uri: 'skill://user_default/typescript%2Ftest-runner',
          fingerprint: 'fp-skill',
          updatedAt: 1700000001000,
        }],
      });
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.OBSERVATION_RESPONSE,
        requestId: latestRequestId(MEMORY_WS.OBSERVATION_QUERY),
        featureEnabled: true,
        records: [{
          id: 'obs-1',
          scope: 'personal',
          class: 'decision',
          origin: 'chat_compacted',
          state: 'active',
          text: 'Use registry hints for skills.',
          fingerprint: 'fp-obs',
          namespaceId: 'ns-1',
          updatedAt: 1700000002000,
          createdAt: 1700000002000,
        }],
      });
    });

    expect(await screen.findByText('Always prefer tests.')).toBeDefined();
    expect(await screen.findByText('Test Runner')).toBeDefined();
    expect(await screen.findByText('Use registry hints for skills.')).toBeDefined();
    expect(await screen.findByText('sharedContext.management.memoryFeatureStatusTitle')).toBeDefined();
    expect(screen.getByLabelText('sharedContext.management.memoryFeatureLabel.preferences: sharedContext.management.memoryFeatureEnabled')).toBeDefined();
    expect(screen.getAllByText('sharedContext.management.memoryFeatureDisableAction').length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getAllByText('sharedContext.management.memoryFeatureDisableAction')[0]);
    });
    const featureSet = latestCommand(MEMORY_WS.FEATURES_SET);
    expect(featureSet).toMatchObject({
      type: MEMORY_WS.FEATURES_SET,
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: false,
    });
    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.FEATURES_SET_RESPONSE,
        requestId: featureSet?.requestId,
        success: true,
        flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
        requested: false,
        enabled: false,
        records: [
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences, requested: false, enabled: false, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_PREFERENCES', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Preferences disabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_MD_INGEST', dependencies: [], dependencyBlocked: [], disabledBehavior: 'MD ingest enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skills, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_SKILLS', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Skills enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_SKILL_AUTO_CREATION', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Skill review enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_OBSERVATION_STORE', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Observation store enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Namespace registry enabled.' },
        ],
      });
    });
    expect(await screen.findByText('sharedContext.notice.memoryFeatureDisabled')).toBeDefined();
    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.FEATURES_RESPONSE,
        requestId: latestRequestId(MEMORY_WS.FEATURES_QUERY),
        records: [
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences, requested: false, enabled: false, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_PREFERENCES', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Preferences disabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_MD_INGEST', dependencies: [], dependencyBlocked: [], disabledBehavior: 'MD ingest enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skills, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_SKILLS', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Skills enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_SKILL_AUTO_CREATION', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Skill review enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_OBSERVATION_STORE', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Observation store enabled.' },
          { flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry, requested: true, enabled: true, source: 'persisted_config', envKey: 'IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY', dependencies: [], dependencyBlocked: [], disabledBehavior: 'Namespace registry enabled.' },
        ],
      });
    });
    expect(screen.getByLabelText('sharedContext.management.memoryFeatureLabel.preferences: sharedContext.management.memoryFeatureDisabled')).toBeDefined();
    expect(screen.getAllByText('sharedContext.management.memoryFeatureEnableAction').length).toBeGreaterThan(0);

    expect(screen.getByPlaceholderText('sharedContext.management.memoryPreferenceTextPlaceholder')).toBeDefined();
    expect(screen.getByText('sharedContext.management.memoryPreferenceSave')).toBeDefined();

    await act(async () => {
      fireEvent.input(screen.getAllByPlaceholderText('sharedContext.management.memoryProjectPlaceholder')[0], {
        target: { value: 'github.com/acme/repo' },
      });
      fireEvent.input(screen.getAllByPlaceholderText('sharedContext.management.memoryProjectDirPlaceholder')[0], {
        target: { value: '/work/repo' },
      });
      fireEvent.click(screen.getByText('sharedContext.management.memoryPreferenceSave'));
    });
    const prefCreate = latestCommand(MEMORY_WS.PREF_CREATE);
    expect(prefCreate).toMatchObject({
      type: MEMORY_WS.PREF_CREATE,
      text: 'Prefer ignored stale response.',
    });
    expect(prefCreate).not.toHaveProperty('userId');
    expect(prefCreate).not.toHaveProperty('actorId');
    expect(prefCreate).not.toHaveProperty('role');

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memorySkillRebuildRegistry'));
      fireEvent.click(screen.getByText('sharedContext.management.memorySkillPreview'));
    });
    const rebuildCommand = latestCommand(MEMORY_WS.SKILL_REBUILD);
    expect(rebuildCommand).toMatchObject({
      type: MEMORY_WS.SKILL_REBUILD,
      projectDir: '/work/repo',
      canonicalRepoId: 'github.com/acme/repo',
    });
    const readCommand = latestCommand(MEMORY_WS.SKILL_READ);
    expect(readCommand).toMatchObject({
      type: MEMORY_WS.SKILL_READ,
      key: 'typescript/test-runner',
      layer: 'user_default',
      projectDir: '/work/repo',
      canonicalRepoId: 'github.com/acme/repo',
    });

    await act(async () => {
      for (const handler of messageHandlers) handler({
        type: MEMORY_WS.SKILL_READ_RESPONSE,
        requestId: readCommand?.requestId,
        success: true,
        key: 'typescript/test-runner',
        layer: 'user_default',
        content: '# Test Runner\nUse pnpm test.',
      });
    });
    expect(await screen.findByText(/Use pnpm test/)).toBeDefined();

    expect(screen.getAllByPlaceholderText('sharedContext.management.memoryProjectDirPlaceholder').length).toBeGreaterThan(0);
    expect(screen.getByText('sharedContext.management.memoryMdIngestRun')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.management.memoryMdIngestRun'));
      fireEvent.click(screen.getByText('sharedContext.management.memoryObservationPromote'));
    });
    const mdIngestCommand = latestCommand(MEMORY_WS.MD_INGEST_RUN);
    expect(mdIngestCommand).toMatchObject({
      type: MEMORY_WS.MD_INGEST_RUN,
      projectDir: '/work/repo',
      canonicalRepoId: 'github.com/acme/repo',
      scope: 'personal',
    });
    expect(mdIngestCommand).not.toHaveProperty('projectId');
    const promoteCommand = latestCommand(MEMORY_WS.OBSERVATION_PROMOTE);
    expect(promoteCommand).toMatchObject({
      type: MEMORY_WS.OBSERVATION_PROMOTE,
      id: 'obs-1',
      projectDir: '/work/repo',
      canonicalRepoId: 'github.com/acme/repo',
      expectedFromScope: 'personal',
      toScope: 'project_shared',
    });
  });


});
