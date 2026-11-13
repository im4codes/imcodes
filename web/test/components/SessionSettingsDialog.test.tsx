/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/preact';
import {
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  DEFAULT_CODEX_AUTOMATION_MODEL,
} from '../../../src/shared/models/options.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '../../../shared/agy-agent.js';
import { __clearTransportModelCacheForTests } from '../../src/hooks/useTransportModels.js';
import { DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS } from '../../../shared/supervision-execution-pool.js';
import {
  buildTransportConfigWithSupervision,
  hasInvalidSessionSupervisionSnapshot,
} from '../../../shared/supervision-config.js';

const patchSessionMock = vi.fn();
const patchSubSessionMock = vi.fn();
const fetchSupervisorDefaultsMock = vi.fn();
const fetchExecutionPoolCatalogMock = vi.fn();
const saveSupervisorDefaultsMock = vi.fn();
const fetchSessionIdentityProfileMock = vi.fn();
const saveSessionIdentityProfileMock = vi.fn();
const clearSessionIdentityProfileMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const parts = key.split('.');
      const leaf = parts[parts.length - 1];
      if (params?.value && typeof params.value === 'string') return `${leaf}:${params.value}`;
      if (params?.backend && params?.model) return `${leaf}:${params.backend}:${params.model}`;
      if (params?.auditor && params?.loops != null) return `${leaf}:${params.auditor}:${params.loops}`;
      if (params?.loops != null) return `${leaf}:${params.loops}`;
      if (params?.streak != null && params?.total != null) return `${leaf}:${params.streak}:${params.total}`;
      if (params?.promptVersion) return `${leaf}:${params.promptVersion}`;
      return leaf;
    },
  }),
}));

vi.mock('../../src/api.js', () => ({
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
  fetchSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  fetchSessionSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  fetchSessionSupervisorExecutionPoolCatalog: (...args: unknown[]) => fetchExecutionPoolCatalogMock(...args),
  saveSessionSupervisorDefaults: (_serverId: string, _sessionName: string, value: unknown) => saveSupervisorDefaultsMock(value),
  saveSupervisorDefaults: (...args: unknown[]) => saveSupervisorDefaultsMock(...args),
  getUserPref: () => fetchSupervisorDefaultsMock(),
  saveUserPref: (_key: string, value: unknown) => saveSupervisorDefaultsMock(value),
  onUserPrefChanged: () => () => undefined,
  fetchSessionIdentityProfile: (...args: unknown[]) => fetchSessionIdentityProfileMock(...args),
  saveSessionIdentityProfile: (...args: unknown[]) => saveSessionIdentityProfileMock(...args),
  clearSessionIdentityProfile: (...args: unknown[]) => clearSessionIdentityProfileMock(...args),
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: ({ onConfirm }: { onConfirm: (paths: string[], preview: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onConfirm(
        ['/home/k/identities/release-agent.md'],
        { status: 'ok', path: '/home/k/identities/release-agent.md', content: 'Identity loaded outside the project.' },
      )}
    >confirm-external-identity-file</button>
  ),
}));

import {
  SESSION_MODEL_CONFIRMATION_TIMEOUT_MS,
  SessionSettingsDialog,
  SupervisionSettingsDialog,
  buildSupervisionExecutionPoolCandidates,
} from '../../src/components/SessionSettingsDialog.js';

function inputForLabel(label: string, index = 0): HTMLInputElement {
  const labels = screen.getAllByText(label);
  const container = labels[index]?.parentElement;
  const input = container?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input for label ${label} at index ${index}`);
  }
  return input;
}

function changeSelect(select: HTMLElement, value: string): void {
  const element = select as HTMLSelectElement;
  element.value = value;
  fireEvent.input(element);
  fireEvent.change(element);
}

function makePeerAuditSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionName: 'deck_sub_peer',
    parentSession: 'deck_proj_brain',
    type: 'codex-sdk',
    runtimeType: 'transport' as const,
    label: 'Peer',
    state: 'idle',
    sessionInstanceId: 'peer-instance-1',
    runtimeEpoch: 'peer-runtime-1',
    activeModel: 'gpt-5.6',
    requestedModel: 'gpt-5.6',
    providerId: 'openai',
    ...overrides,
  };
}

function makeIdentityAckWs() {
  const handlers = new Set<(message: any) => void>();
  const ws = {
    connected: true,
    send: vi.fn((message: Record<string, unknown>) => {
      if (message.type !== 'session.identity.refresh') return;
      queueMicrotask(() => handlers.forEach((handler) => handler({
        type: 'command.ack',
        commandId: message.commandId,
        session: message.sessionName,
        status: 'ok',
      })));
    }),
    onMessage: vi.fn((handler: (message: any) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    sendSessionMessage: vi.fn(),
    subSessionSetModel: vi.fn(),
  };
  return ws;
}

describe('SessionSettingsDialog supervision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearTransportModelCacheForTests();
    fetchSupervisorDefaultsMock.mockRejectedValue(new Error('no defaults'));
    fetchExecutionPoolCatalogMock.mockResolvedValue([]);
    saveSupervisorDefaultsMock.mockResolvedValue(undefined);
    fetchSessionIdentityProfileMock.mockResolvedValue(null);
    saveSessionIdentityProfileMock.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      contentHash: 'hash',
      revision: 1,
      updatedAt: 1,
      source: 'web',
    }));
    clearSessionIdentityProfileMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps session and supervision fields on independent production surfaces', () => {
    const common = {
      serverId: 'srv-1', sessionName: 'deck_proj_brain', label: 'Brain', description: '',
      cwd: '/proj', type: 'codex-sdk', transportConfig: { supervision: { mode: 'off' } },
      ws: makeIdentityAckWs() as any, onClose: vi.fn(), onSaved: vi.fn(),
    };
    const { unmount } = render(<SessionSettingsDialog {...common} surface="session" />);
    expect(screen.getByTestId('session-model-settings')).toBeTruthy();
    expect(screen.queryByTestId('supervision-execution-pool-primary')).toBeNull();
    expect(screen.queryByTestId('audit-blocking-severities')).toBeNull();
    expect(screen.queryByTestId('task-pair-settings')).toBeNull();
    unmount();

    render(<SupervisionSettingsDialog {...common} canControlAutomaticSupervision />);
    expect(screen.getByTestId('supervision-execution-pool-primary')).toBeTruthy();
    expect(screen.getByTestId('supervision-execution-pool-economy')).toBeTruthy();
    expect(screen.getByTestId('audit-blocking-severities')).toBeTruthy();
    expect(screen.getByTestId('task-pair-settings')).toBeTruthy();
    expect(screen.queryByTestId('session-model-settings')).toBeNull();
    expect(screen.queryByLabelText('session-identity-content')).toBeNull();
  });

  it('saves each settings surface without leaking fields owned by the other dialog', async () => {
    const common = {
      serverId: 'srv-1', sessionName: 'deck_proj_brain', label: 'Brain', description: '', cwd: '/proj',
      type: 'codex-sdk', transportConfig: { supervision: { mode: 'off' } }, ws: makeIdentityAckWs() as any,
      onClose: vi.fn(), onSaved: vi.fn(),
    };
    const { unmount } = render(<SessionSettingsDialog {...common} surface="session" />);
    fireEvent.input(screen.getByDisplayValue('Brain'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', { label: 'Renamed' }));
    expect(patchSessionMock.mock.calls[0]?.[2]).not.toHaveProperty('transportConfig');
    unmount();

    vi.clearAllMocks();
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk', model: CODEX_MODEL_IDS[0], timeoutMs: 18_000,
      executionPools: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS,
    });
    render(<SupervisionSettingsDialog {...common} canControlAutomaticSupervision />);
    fireEvent.click(screen.getByTestId('audit-blocking-severity-P1'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalled());
    const fields = patchSessionMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(fields).toHaveProperty('transportConfig');
    expect(fields).not.toHaveProperty('label');
    expect(fields).not.toHaveProperty('description');
    expect(fields).not.toHaveProperty('agentType');
  });

  it('switches the model through the shared session command and reports success', async () => {
    const ws = makeIdentityAckWs();
    const onSaved = vi.fn();
    const props = {
      serverId: 'srv-1', sessionName: 'deck_proj_brain', label: 'Brain', description: '', cwd: '/proj',
      type: 'codex-sdk', requestedModel: 'gpt-5.4', transportConfig: null, surface: 'session' as const,
      ws: ws as any, onClose: vi.fn(), onSaved,
    };
    const view = render(<SessionSettingsDialog
        surface="supervision" {...props} activeModel="gpt-5.4" />);
    changeSelect(screen.getByLabelText('label'), 'gpt-5.6');
    await waitFor(() => expect((screen.getByRole('button', { name: 'apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(screen.getByRole('button', { name: 'applying' })).toBeTruthy();
    await waitFor(() => expect(ws.sendSessionMessage).toHaveBeenCalledWith('deck_proj_brain', '/model gpt-5.6'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();

    view.rerender(<SessionSettingsDialog
        surface="supervision" {...props} requestedModel="gpt-5.6" activeModel="gpt-5.6" modelDisplay="gpt-5.6" />);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      requestedModel: 'gpt-5.6', activeModel: 'gpt-5.6', modelDisplay: 'gpt-5.6',
    }));
    expect(screen.getByRole('status').textContent).toBe('applied');
  });

  it('uses the structured model command for process sub-sessions and explains unsupported types', async () => {
    const ws = makeIdentityAckWs();
    const common = {
      serverId: 'srv-1', sessionName: 'deck_proj_worker', subSessionId: 'sub-1', label: 'Worker',
      description: '', cwd: '/proj', activeModel: 'gpt-5.4', requestedModel: 'gpt-5.4',
      transportConfig: null, surface: 'session' as const, ws: ws as any, onClose: vi.fn(), onSaved: vi.fn(),
    };
    const view = render(<SessionSettingsDialog {...common} type="codex" />);
    changeSelect(screen.getByLabelText('label'), 'gpt-5.6');
    await waitFor(() => expect((screen.getByRole('button', { name: 'apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    await waitFor(() => expect(ws.subSessionSetModel).toHaveBeenCalledWith('deck_proj_worker', 'gpt-5.6', '/proj'));
    expect(ws.sendSessionMessage).not.toHaveBeenCalled();
    expect(common.onSaved).not.toHaveBeenCalled();
    view.rerender(<SessionSettingsDialog {...common} type="codex" requestedModel="gpt-5.6" activeModel="gpt-5.6" />);
    await waitFor(() => expect(common.onSaved).toHaveBeenCalledWith({
      requestedModel: 'gpt-5.6', activeModel: 'gpt-5.6', modelDisplay: 'gpt-5.6',
    }));
    view.unmount();

    render(<SessionSettingsDialog {...common} type="shell" activeModel={null} requestedModel={null} />);
    expect(screen.getByText('unsupported')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'apply' })).toBeNull();
  });

  it('keeps Antigravity settings options when model discovery cannot dispatch', () => {
    const ws = Object.assign(makeIdentityAckWs(), { requestTransportModels: () => { throw new Error('offline probe'); } });
    render(<SessionSettingsDialog serverId="srv-1" sessionName="agy-settings" label="AG" description="" cwd="/proj" type="agy-sdk" activeModel={null} requestedModel={null} transportConfig={null} surface="session" ws={ws as any} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'gemini-3.8-flash-high' })).toBeDefined();
  });

  it('replaces Antigravity settings fallback options while preserving the current explicit choice', async () => {
    const handlers = new Set<(message: unknown) => void>();
    const ws = { connected: true, send: vi.fn(), onMessage: (cb: (message: unknown) => void) => { handlers.add(cb); return () => handlers.delete(cb); }, requestTransportModels: () => 'settings-cache-refresh' };
    render(<SessionSettingsDialog serverId="srv-1" sessionName="agy-catalog-settings" label="AG" description="" cwd="/proj" type="agy-sdk" activeModel="user-chosen-model" requestedModel="user-chosen-model" transportConfig={null} surface="session" ws={ws as any} onClose={vi.fn()} onSaved={vi.fn()} />);
    act(() => handlers.forEach(cb => cb({ type: 'transport.models_response', agentType: 'agy-sdk', requestId: 'settings-cache-refresh', models: [{ id: 'new-live-model' }], defaultModel: 'new-live-model' })));
    await waitFor(() => expect(screen.getByRole('option', { name: 'new-live-model' })).toBeDefined());
    expect(screen.queryByRole('option', { name: 'gemini-4-argon-medium' })).toBeNull();
    expect(screen.getByRole('option', { name: 'user-chosen-model' })).toBeDefined();
  });

  it('reports a model command dispatch failure without closing the settings dialog', async () => {
    const ws = makeIdentityAckWs();
    ws.sendSessionMessage.mockImplementation(() => { throw new Error('offline'); });
    const onClose = vi.fn();
    render(
      <SessionSettingsDialog
        serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
        type="codex-sdk" activeModel="gpt-5.4" requestedModel="gpt-5.4" transportConfig={null}
        surface="session" ws={ws as any} onClose={onClose} onSaved={vi.fn()}
      />,
    );
    changeSelect(screen.getByLabelText('label'), 'gpt-5.6');
    fireEvent.click(await screen.findByRole('button', { name: 'apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('failed');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fails visibly when the daemon never confirms the active model', async () => {
    vi.useFakeTimers();
    try {
      const ws = makeIdentityAckWs();
      render(
        <SessionSettingsDialog
          serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
          type="codex-sdk" activeModel="gpt-5.4" requestedModel="gpt-5.4" transportConfig={null}
          surface="session" ws={ws as any} onClose={vi.fn()} onSaved={vi.fn()}
        />,
      );
      changeSelect(screen.getByLabelText('label'), 'gpt-5.6');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'apply' })); });
      expect(screen.getByRole('button', { name: 'applying' })).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(SESSION_MODEL_CONFIRMATION_TIMEOUT_MS); });
      expect(screen.getByRole('alert').textContent).toBe('failed');
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves a manually entered exact-session identity online and requests an immediate runtime refresh', async () => {
    const ws = makeIdentityAckWs();
    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description=""
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        ws={ws as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const identity = await screen.findByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(identity.disabled).toBe(false));
    fireEvent.input(identity, { target: { value: 'You are the release engineer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'identityApply' }));

    await waitFor(() => expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith({
      scope: 'session',
      scopeKey: 'srv-1:deck_proj_brain',
      content: 'You are the release engineer.',
    }, { serverId: 'srv-1', sessionName: 'deck_proj_brain' }));
    expect(ws.send).toHaveBeenCalledWith({
      type: 'session.identity.refresh',
      sessionName: 'deck_proj_brain',
      commandId: expect.any(String),
    });
    expect(patchSessionMock).not.toHaveBeenCalled();
  });

  it('directly overwrites an existing identity without optimistic revision coupling', async () => {
    fetchSessionIdentityProfileMock.mockImplementation(async (scope: string) => {
      if (scope !== 'session') return null;
      return {
        scope: 'session', scopeKey: 'srv-1:deck_proj_brain',
        content: 'Old identity', contentHash: 'hash', revision: 4,
        updatedAt: 1, source: 'web',
      };
    });

    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
        type="codex-sdk" transportConfig={null} ws={makeIdentityAckWs() as any}
        onClose={vi.fn()} onSaved={vi.fn()}
      />,
    );

    const identity = await screen.findByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(identity.value).toBe('Old identity'));
    fireEvent.input(identity, { target: { value: 'My explicit update' } });
    fireEvent.click(screen.getByRole('button', { name: 'identityApply' }));

    await waitFor(() => expect(saveSessionIdentityProfileMock).toHaveBeenCalledOnce());
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith({
      scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'My explicit update',
    }, { serverId: 'srv-1', sessionName: 'deck_proj_brain' });
  });

  it('reuses the host file browser, uploads its content, and records the selected source path', async () => {
    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description=""
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        ws={makeIdentityAckWs() as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const identity = await screen.findByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(identity.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'identityChooseFile' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm-external-identity-file' }));
    expect(identity.value).toBe('Identity loaded outside the project.');
    expect(screen.getByText('identitySelectedFile')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'identityApply' }));
    await waitFor(() => expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      scopeKey: 'srv-1:deck_proj_brain',
      content: 'Identity loaded outside the project.',
    }), { serverId: 'srv-1', sessionName: 'deck_proj_brain' }));
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceFile: '/home/k/identities/release-agent.md',
    }), { serverId: 'srv-1', sessionName: 'deck_proj_brain' });
  });

  it('edits synchronized user and project identities from the four-tab settings surface', async () => {
    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1"
        sessionName="deck_proj_brain"
        projectKey="repo-stable-id"
        label="Brain"
        description=""
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        ws={makeIdentityAckWs() as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(await screen.findAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'identityScope_pair' })).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'identityScope_user' }));
    const userIdentity = screen.getByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(userIdentity.disabled).toBe(false));
    fireEvent.input(userIdentity, { target: { value: 'Shared across my machines.' } });
    fireEvent.click(screen.getByRole('button', { name: 'identityApply' }));
    await waitFor(() => expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user', scopeKey: '', content: 'Shared across my machines.',
    }), { serverId: 'srv-1', sessionName: 'deck_proj_brain' }));

    fireEvent.click(screen.getByRole('tab', { name: 'identityScope_project' }));
    const projectIdentity = screen.getByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(projectIdentity.disabled).toBe(false));
    fireEvent.input(projectIdentity, { target: { value: 'Use this project role.' } });
    fireEvent.click(screen.getByRole('button', { name: 'identityApply' }));
    await waitFor(() => expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project', scopeKey: 'repo-stable-id', content: 'Use this project role.',
    }), { serverId: 'srv-1', sessionName: 'deck_proj_brain' }));
  });

  it('renders authoritative supervision read-only for non-Brain sessions without unauthorized writes', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision={false}
        serverId="srv-1"
        sessionName="deck_proj_worker"
        parentSession="deck_proj_brain"
        label="Worker"
        description=""
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
            auditTargetSessionName: 'deck_sub_peer',
          },
        }}
        peerAuditSessions={[makePeerAuditSession()] as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('brainOnly')).toBeDefined();
    expect(screen.queryByTestId('audit-blocking-severities')).toBeNull();
    expect(screen.queryByTestId('task-pair-settings')).toBeNull();
    const poolCheckbox = within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_peer') as HTMLInputElement;
    expect(poolCheckbox.disabled).toBe(true);
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('never writes supervision or execution pools from a shared-viewer read-only dialog', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision={false}
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Shared Brain"
        description=""
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        transportConfig={null}
        supervisionMode="supervised_audit"
        peerAuditSessions={[makePeerAuditSession()] as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('brainOnly')).toBeDefined();
    expect(screen.queryByTestId('session-model-settings')).toBeNull();
    expect(screen.queryByTestId('audit-blocking-severities')).toBeNull();
    expect(screen.queryByTestId('task-pair-settings')).toBeNull();

    const poolCheckbox = within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_peer') as HTMLInputElement;
    expect(poolCheckbox.disabled).toBe(true);
    fireEvent.click(poolCheckbox);

    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await Promise.resolve();
    expect(patchSessionMock).not.toHaveBeenCalled();
    expect(patchSubSessionMock).not.toHaveBeenCalled();
    expect(saveSupervisorDefaultsMock).not.toHaveBeenCalled();
  });

  it('shows the working directory as read-only and omits cwd when saving a main session', async () => {
    render(
      <SessionSettingsDialog
        surface="session"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cwdInput = inputForLabel('workingDir');
    expect(cwdInput.value).toBe('/proj');
    expect(cwdInput.disabled).toBe(true);

    fireEvent.input(inputForLabel('label'), { target: { value: 'Brain renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        label: 'Brain renamed',
      }));
    });
    expect(patchSessionMock.mock.calls[0]?.[2]).not.toHaveProperty('cwd');
  });

  it('shows the working directory as read-only and omits cwd when saving a sub-session', async () => {
    render(
      <SessionSettingsDialog
        surface="session"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_sub_abcd1234"
        subSessionId="abcd1234"
        label="Worker"
        description=""
        cwd="/proj/sub"
        type="codex-sdk"
        parentSession="deck_proj_brain"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cwdInput = inputForLabel('workingDir');
    expect(cwdInput.value).toBe('/proj/sub');
    expect(cwdInput.disabled).toBe(true);

    fireEvent.input(inputForLabel('label'), { target: { value: 'Worker renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSubSessionMock).toHaveBeenCalledWith('srv-1', 'abcd1234', expect.objectContaining({
        label: 'Worker renamed',
      }));
    });
    expect(patchSubSessionMock.mock.calls[0]?.[2]).not.toHaveProperty('cwd');
  });

  it('renders only the 3 active supervision groups and retires all obsolete controls', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        transportConfig={{ supervision: { mode: 'supervised_audit', backend: 'codex-sdk', model: CODEX_MODEL_IDS[0], timeoutMs: 30_000, promptVersion: 'supervision_decision_v1' } }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // 3 active groups rendered
    expect(screen.getByTestId('supervision-execution-pool-primary')).toBeTruthy();
    expect(screen.getByTestId('supervision-execution-pool-economy')).toBeTruthy();
    expect(screen.getByTestId('audit-blocking-severities')).toBeTruthy();
    expect(screen.getByTestId('task-pair-max-concurrency')).toBeTruthy();

    // Retired controls absent
    expect(screen.queryByTestId('supervision-intro-toggle')).toBeNull();
    expect(screen.queryByLabelText('supervision-defaults:backend')).toBeNull();
    expect(screen.queryByLabelText('supervision-defaults-backup:backend')).toBeNull();
    expect(screen.queryByLabelText('supervision-defaults:timeout')).toBeNull();
    expect(screen.queryByLabelText('supervision-session:mode')).toBeNull();
    expect(screen.queryByTestId('supervision-merged-preview')).toBeNull();
    expect(screen.queryByTestId('audit-blocking-summary')).toBeNull();
    expect(screen.queryByTestId('task-pair-engine')).toBeNull();
    expect(screen.queryByText('maxAutoContinueStreak')).toBeNull();
    expect(screen.queryByText('maxAutoContinueTotal')).toBeNull();
    expect(screen.queryByText('globalCustomInstructionsLabel')).toBeNull();
    expect(screen.queryByText('customInstructionsLabel')).toBeNull();
    expect(screen.queryByText('maxAuditLoops')).toBeNull();
    expect(screen.queryByText('usesGlobalRuntime')).toBeNull();
    expect(document.querySelector('.session-settings-summary')).toBeNull();
  });

  it('does not block pool saves when stored legacy runtime defaults are empty', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: '',
      model: '',
      timeoutMs: 0,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary },
        economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
      },
    });
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession()]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primaryCheckbox = await within(screen.getByTestId('supervision-execution-pool-primary'))
      .findByLabelText('primary:deck_sub_peer') as HTMLInputElement;
    fireEvent.click(primaryCheckbox);
    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: expect.arrayContaining([
              expect.objectContaining({ agentType: 'codex-sdk', model: 'gpt-5.6' }),
            ]),
          }),
        }),
      }));
    });
  });

  for (const storedMode of ['off', 'supervised', 'supervised_audit'] as const) {
    it(`shows and saves blocking severities and max parallel pairs and preserves hidden snapshot fields when mode=${storedMode}`, async () => {
      const hiddenSnapshot = {
        mode: storedMode,
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        preset: 'custom-qwen-preset',
        backupBackend: 'claude-code-sdk',
        backupModel: 'claude-sonnet-4-6',
        timeoutMs: 45_000,
        promptVersion: 'supervision_decision_v1',
        customInstructions: 'session-note',
        customInstructionsOverride: true,
        globalCustomInstructions: 'global-note',
        maxParseRetries: 3,
        maxAutoContinueStreak: 4,
        maxAutoContinueTotal: 12,
        maxAuditLoops: 6,
        pairEngine: 'pairs',
        pairMaxConcurrency: 2,
        taskRunPromptVersion: 'task_run_status_v1',
      };
      render(
        <SessionSettingsDialog
          surface="supervision"
          canControlAutomaticSupervision
          serverId="srv-1"
          sessionName="deck_proj_brain"
          label="Brain"
          description="desc"
          cwd="/proj"
          type="codex-sdk"
          activeModel={CODEX_MODEL_IDS[0]}
          transportConfig={{ supervision: hiddenSnapshot }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      expect(screen.getByTestId('audit-blocking-severities')).toBeTruthy();
      expect(screen.getByTestId('audit-non-finding-policy')).toBeTruthy();
      expect((screen.getByTestId('task-pair-max-concurrency') as HTMLInputElement).value).toBe('2');

      fireEvent.click(screen.getByTestId('audit-blocking-severity-P1'));
      fireEvent.input(screen.getByTestId('task-pair-max-concurrency'), { target: { value: '7' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(patchSessionMock).toHaveBeenCalled());
      const saved = patchSessionMock.mock.calls.at(-1)?.[2] as { transportConfig?: { supervision?: Record<string, unknown> } };
      expect(saved.transportConfig?.supervision).toEqual(expect.objectContaining({
        mode: storedMode,
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        backupBackend: 'claude-code-sdk',
        backupModel: 'claude-sonnet-4-6',
        timeoutMs: 45_000,
        promptVersion: 'supervision_decision_v1',
        customInstructions: 'session-note',
        customInstructionsOverride: true,
        globalCustomInstructions: 'global-note',
        maxParseRetries: 3,
        maxAutoContinueStreak: 4,
        maxAutoContinueTotal: 12,
        maxAuditLoops: 6,
        pairEngine: 'pairs',
        pairMaxConcurrency: 7,
        auditBlockingSeverities: ['P0', 'P1'],
        taskRunPromptVersion: 'task_run_status_v1',
      }));
    });
  }

  it('shared builder preserves supervision when mode=off has explicit auditBlockingSeverities without configured pools', () => {
    const built = buildTransportConfigWithSupervision(null, {
      mode: 'off',
      auditBlockingSeverities: ['P0', 'P1'],
    });
    expect(built).toEqual(expect.objectContaining({
      supervision: expect.objectContaining({
        mode: 'off',
        auditBlockingSeverities: ['P0', 'P1'],
      }),
    }));
  });

  it('quick-opens supervised_audit settings without showing or requiring a manual auditor', async () => {
    // Was: "seeds a quick-open audit draft immediately instead of leaving Save
    // disabled" -- it asserted the Settings picker appeared and had to be
    // satisfied. The picker is retired; quick-open must still land in
    // supervised_audit and Save must be reachable with no auditor chosen.
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision serverId="srv-1" sessionName="deck_proj_brain"
        label="Brain" description="desc" cwd="/proj" type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        sessionInstanceId="brain-instance-1" runtimeEpoch="brain-runtime-1"
        ws={{ connected: true, send() {}, onMessage: () => () => undefined } as any}
        peerAuditSessions={[makePeerAuditSession({ sessionInstanceId: 'peer-1', runtimeEpoch: 'peer-epoch-1' })]}
        openIntent={{ supervisionMode: 'supervised_audit' }}
        transportConfig={{}}
        onClose={vi.fn()} onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('session-supervision-peer-target-section')).toBeNull();
    expect(screen.queryByTestId('peer-audit-chooser-row')).toBeNull();
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  for (const [label, candidates] of [
    ['with eligible candidates', [makePeerAuditSession({ sessionInstanceId: 'peer-1', runtimeEpoch: 'peer-epoch-1' })]],
    ['with zero candidates', []],
  ] as const) {
    it(`retires the manual auditor picker from supervised_audit settings ${label}`, () => {
      // The auditor is routed from auditPolicy + the live pool. The legacy
      // picker is gone from Settings entirely -- including the eligible-candidate
      // case, which is what makes this non-vacuous. Real Quick delegation lives
      // in the independent QuickAgentDelegationDialog and is covered by its own
      // suite, which is the control for "non-supervision delegation preserved".
      render(
        <SessionSettingsDialog
        surface="supervision"
          canControlAutomaticSupervision serverId="srv-1" sessionName="deck_proj_brain"
          label="Brain" description="desc" cwd="/proj" type="codex-sdk"
          activeModel={CODEX_MODEL_IDS[0]}
          sessionInstanceId="brain-instance-1" runtimeEpoch="brain-runtime-1"
          ws={{ connected: true, send() {}, onMessage: () => () => undefined } as any}
          peerAuditSessions={candidates as never}
          transportConfig={{ supervision: {
            mode: 'supervised_audit', backend: 'codex-sdk', model: CODEX_MODEL_IDS[0],
            timeoutMs: 12_000, promptVersion: 'supervision_decision_v1', maxAuditLoops: 2,
          } }}
          onClose={vi.fn()} onSaved={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('peer-audit-chooser-row')).toBeNull();
      expect(screen.queryByTestId('session-supervision-peer-target-section')).toBeNull();
      expect(
        (screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled,
        'an absent manual auditor must never gate Save',
      ).toBe(false);
    });
  }

  it('hides the legacy manual auditor block, saves with zero candidates, and strips legacy target fields', async () => {
    // Supervision/auto-audit routes the auditor from auditPolicy + the live pool.
    // The legacy "delegate recent work" manual picker is meaningless there: it
    // must not render, must not gate Save (supervisionValid), and must not leave
    // auditTargetSessionName / auditTargetFingerprint / peerAuditPromptVersion in
    // the saved payload.
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        sessionInstanceId="brain-instance-1"
        runtimeEpoch="brain-runtime-1"
        ws={{ connected: true, send() {}, onMessage: () => () => undefined } as any}
        peerAuditSessions={[]}
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            maxAuditLoops: 2,
            auditTargetSessionName: 'deck_sub_legacy_peer',
            peerAuditPromptVersion: 'peer_audit_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // 1. hidden in supervision/audit mode
    expect(
      screen.queryByTestId('peer-audit-chooser-row'),
      'the legacy manual auditor block must not render in audit mode',
    ).toBeNull();

    // 2. no eligible candidate must NOT block Save
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled, 'an absent manual auditor must not gate Save').toBe(false);

    // 3. legacy target fields are stripped from the payload
    fireEvent.click(save);
    await waitFor(() => { expect(patchSessionMock).toHaveBeenCalled(); });
    const saved = patchSessionMock.mock.calls.at(-1)?.[2] as { transportConfig?: { supervision?: Record<string, unknown> } };
    const supervision = saved.transportConfig?.supervision ?? {};
    expect(supervision, 'legacy auditor target must not be persisted').not.toHaveProperty('auditTargetSessionName');
    expect(supervision).not.toHaveProperty('auditTargetFingerprint');
    expect(supervision).not.toHaveProperty('peerAuditPromptVersion');
    expect(
      hasInvalidSessionSupervisionSnapshot(saved.transportConfig ?? null),
      'the exact targetless Web payload must satisfy the canonical server validator',
    ).toBe(false);
  });

  const renderAuditDialog = (supervisionOverrides: Record<string, unknown> = {}) => render(
    <SessionSettingsDialog
        surface="supervision"
      canControlAutomaticSupervision
      serverId="srv-1"
      sessionName="deck_proj_brain"
      label="Brain"
      description="desc"
      cwd="/proj"
      type="codex-sdk"
      activeModel={CODEX_MODEL_IDS[0]}
      sessionInstanceId="brain-instance-1"
      runtimeEpoch="brain-runtime-1"
      ws={{ connected: true, send() {}, onMessage: () => () => undefined } as any}
      peerAuditSessions={[]}
      transportConfig={{
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: CODEX_MODEL_IDS[0],
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxAuditLoops: 2,
          ...supervisionOverrides,
        },
      }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );

  const severityBox = (level: string) => screen.getByTestId(`audit-blocking-severity-${level}`) as HTMLInputElement;

  it('shows P0-P4 blocking checkboxes with definitions, defaulting a legacy snapshot to P0 only', () => {
    renderAuditDialog();
    expect(screen.getByText('auditBlockingSeverities')).toBeDefined();
    for (const level of ['P0', 'P1', 'P2', 'P3', 'P4']) {
      expect(screen.getByTestId(`audit-blocking-severity-description-${level}`).textContent).toBe(level);
      expect(severityBox(level).checked, `${level} checked`).toBe(level === 'P0');
    }
    // The single remaining level cannot be cleared.
    expect(severityBox('P0').disabled).toBe(true);
    expect(screen.getByTestId('audit-non-finding-policy').textContent).toBe(
      'auditNonFindingTitleauditNonFindingHelp',
    );
  });

  it('persists the selected blocking severities and keeps at least one selected', async () => {
    renderAuditDialog();
    fireEvent.click(severityBox('P2'));
    fireEvent.click(severityBox('P1'));
    expect(severityBox('P0').disabled).toBe(false);
    fireEvent.click(severityBox('P0'));
    expect(severityBox('P0').checked).toBe(false);
    fireEvent.click(severityBox('P1'));
    expect(severityBox('P2').checked).toBe(true);
    expect(severityBox('P2').disabled, 'the last selected level stays locked').toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => { expect(patchSessionMock).toHaveBeenCalled(); });
    const saved = patchSessionMock.mock.calls.at(-1)?.[2] as { transportConfig?: { supervision?: Record<string, unknown> } };
    expect(saved.transportConfig?.supervision?.auditBlockingSeverities).toEqual(['P2']);
    expect(hasInvalidSessionSupervisionSnapshot(saved.transportConfig ?? null)).toBe(false);
  });

  it('restores persisted blocking severities from the snapshot', () => {
    renderAuditDialog({ auditBlockingSeverities: ['P1', 'P0'] });
    expect(severityBox('P0').checked).toBe(true);
    expect(severityBox('P1').checked).toBe(true);
    expect(severityBox('P2').checked).toBe(false);
  });

  it('persists the default Brain model to account defaults without another pool interaction', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    expect(within(primary).getByLabelText(`primary:configured:codex-sdk:${CODEX_MODEL_IDS[0]}`)).toHaveProperty('checked', true);
    expect(within(primary).getByTestId('supervision-execution-pool-primary-empty')).toBeDefined();
    expect(within(economy).getByTestId('supervision-execution-pool-economy-empty')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: CODEX_MODEL_IDS[0] })],
          }),
          economyTaskPool: expect.objectContaining({ configs: [] }),
        }),
      }));
      expect(patchSessionMock).not.toHaveBeenCalled();
    });
  });

  it('allows adding a low-tier model to the economy pool', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_spark',
          label: 'Spark helper',
          activeModel: DEFAULT_CODEX_AUTOMATION_MODEL,
          requestedModel: DEFAULT_CODEX_AUTOMATION_MODEL,
        })]}
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    expect(within(primary).queryByLabelText('primary:deck_sub_spark')).toBeNull();
    const economySpark = within(economy).getByLabelText('economy:deck_sub_spark');
    fireEvent.click(economySpark);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: CODEX_MODEL_IDS[0] })],
          }),
          economyTaskPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: 'gpt-5.3-codex-spark' })],
          }),
        }),
      }));
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            executionPools: expect.objectContaining({
              economyTaskPool: expect.objectContaining({
                configs: [expect.objectContaining({ model: DEFAULT_CODEX_AUTOMATION_MODEL })],
              }),
            }),
          }),
        }),
      }));
    });
  });

  it('derives pool candidates only from open reply-capable sub-sessions with known models', () => {
    const candidates = buildSupervisionExecutionPoolCandidates({
      sessionName: 'deck_proj_brain',
      sessions: [
        makePeerAuditSession({ sessionName: 'deck_sub_ready', label: 'Ready', state: 'idle', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_starting', label: 'Starting', state: 'starting', activeModel: 'gpt-5.5' }),
        makePeerAuditSession({ sessionName: 'deck_sub_stopped', state: 'stopped' }),
        makePeerAuditSession({ sessionName: 'deck_sub_closed', closedAt: Date.now() }),
        makePeerAuditSession({ sessionName: 'deck_sub_shell', type: 'shell' }),
        makePeerAuditSession({ sessionName: 'deck_sub_unknown', activeModel: null, requestedModel: null, modelDisplay: null }),
        makePeerAuditSession({ sessionName: 'deck_sub_other', parentSession: 'deck_other_brain' }),
      ],
    });

    expect(candidates.map((candidate) => candidate.sessionNames)).toEqual([
      ['deck_sub_ready'],
      ['deck_sub_starting'],
    ]);
    expect(candidates[0]).toMatchObject({
      label: 'Ready',
      config: {
        agentType: 'codex-sdk',
        providerFamily: 'openai',
        runtimeType: 'transport',
        model: 'gpt-5.6',
      },
    });
  });

  it('deduplicates canonical constraints while retaining Cx, CC preset, Cursor, and Ds live evidence', () => {
    const candidates = buildSupervisionExecutionPoolCandidates({
      sessionName: 'deck_proj_brain',
      sessions: [
        makePeerAuditSession({ sessionName: 'deck_sub_cx1', label: 'Cx1', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cx2', label: 'Cx2', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cursor', label: 'Cursor', type: 'cursor-headless', providerId: 'cursor', activeModel: 'cursor-large' }),
        makePeerAuditSession({ sessionName: 'deck_sub_ds', label: 'Ds', type: 'deepseek-harness', providerId: 'deepseek', activeModel: 'deepseek-reasoner' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_a1', label: 'CC A1', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_a2', label: 'CC A2', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_b', label: 'CC B', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-b' }),
        makePeerAuditSession({ sessionName: 'deck_sub_bad_preset', type: 'openclaw', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_clone', executionCloneKind: 'supervision-execution', parentRunId: 'run-1' }),
        makePeerAuditSession({ sessionName: 'deck_sub_parent_run', parentRunId: 'run-2' }),
        makePeerAuditSession({ sessionName: 'deck_sub_stopped', state: 'stopped' }),
        makePeerAuditSession({ sessionName: 'deck_sub_unknown', activeModel: null, requestedModel: null, modelDisplay: null }),
        makePeerAuditSession({ sessionName: 'deck_sub_shell', type: 'shell' }),
      ],
    });

    expect(candidates).toHaveLength(5);
    expect(candidates.find((candidate) => candidate.config.agentType === 'codex-sdk')).toMatchObject({
      sessionNames: ['deck_sub_cx1', 'deck_sub_cx2'],
      labels: ['Cx1', 'Cx2'],
      matchingSessionCount: 2,
      config: { providerFamily: 'openai', model: 'gpt-5.6' },
    });
    expect(candidates.map((candidate) => candidate.config.agentType)).toEqual(expect.arrayContaining([
      'cursor-headless', 'deepseek-harness', 'claude-code-sdk',
    ]));
    const presets = candidates
      .filter((candidate) => candidate.config.agentType === 'claude-code-sdk')
      .sort((left, right) => (left.config.ccPresetId ?? '').localeCompare(right.config.ccPresetId ?? ''));
    expect(presets.map((candidate) => [candidate.config.ccPresetId, candidate.sessionNames])).toEqual([
      ['preset-a', ['deck_sub_cc_a1', 'deck_sub_cc_a2']],
      ['preset-b', ['deck_sub_cc_b']],
    ]);
  });

  it('shows session, SDK, and model and keeps primary/economy selection mutually exclusive', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_worker',
          label: 'Integration worker',
          activeModel: 'gpt-5.6',
          requestedModel: 'gpt-5.6',
        })]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    const primaryWorker = within(primary).getByLabelText('primary:deck_sub_worker') as HTMLInputElement;
    const economyWorker = within(economy).getByLabelText('economy:deck_sub_worker') as HTMLInputElement;
    expect(primary.textContent).toContain('Integration worker');
    expect(primary.textContent).toContain('deck_sub_worker');
    expect(primary.textContent).toContain('codex_sdk · gpt-5.6');

    fireEvent.click(primaryWorker);
    expect(primaryWorker.checked).toBe(true);
    expect(economyWorker.checked).toBe(false);
    fireEvent.click(economyWorker);
    expect(primaryWorker.checked).toBe(false);
    expect(economyWorker.checked).toBe(true);
    fireEvent.click(primaryWorker);
    expect(primaryWorker.checked).toBe(true);
    expect(economyWorker.checked).toBe(false);
  });

  it('defaults a primary pool entry to the both role, offers executor/auditor/both, and persists the choice', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_worker',
          label: 'Integration worker',
          activeModel: 'gpt-5.6',
          requestedModel: 'gpt-5.6',
        })]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    const primaryWorker = within(primary).getByLabelText('primary:deck_sub_worker') as HTMLInputElement;
    fireEvent.click(primaryWorker);

    const capabilityId = 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6';
    const roleSelect = within(primary).getByTestId(`supervision-execution-pool-role-${capabilityId}`) as HTMLSelectElement;
    expect(roleSelect.value).toBe('both');
    // The economy pool never shows a role selector: auditors always come from primary.
    expect(within(economy).queryByTestId(`supervision-execution-pool-role-${capabilityId}`)).toBeNull();

    // A native 'change' dispatch (not the fireEvent.change/changeSelect
    // helper, whose synthetic event this nested-in-label <select> did not
    // react to in this environment), wrapped in act() so the resulting
    // state update is flushed before the very next interaction reads it.
    act(() => {
      roleSelect.value = 'executor';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0] as {
      executionPools?: { primaryDevelopmentPool?: { configs?: Array<Record<string, unknown>> } };
    };
    const config = saved.executionPools?.primaryDevelopmentPool?.configs?.find((entry) => entry.capabilityId === capabilityId);
    expect(config).toMatchObject({ role: 'executor' });
  });

  it.each(['executor', 'auditor', 'both'] as const)('reopens the live grouped candidate with the saved %s role', async (role) => {
    const props = {
      surface: 'supervision' as const, canControlAutomaticSupervision: true,
      serverId: 'srv-1', sessionName: 'deck_proj_brain', label: 'Brain', description: '', cwd: '/proj',
      type: 'codex-sdk', activeModel: CODEX_MODEL_IDS[0], transportConfig: null,
      peerAuditSessions: [makePeerAuditSession(), makePeerAuditSession({ sessionName: 'deck_sub_peer2' })],
      onClose: vi.fn(), onSaved: vi.fn(),
    };
    const capabilityId = 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6';
    const { unmount } = render(<SessionSettingsDialog {...props} />);
    const primary = screen.getByTestId('supervision-execution-pool-primary');
    fireEvent.click(within(primary).getByLabelText('primary:deck_sub_peer,deck_sub_peer2'));
    act(() => {
      const select = within(primary).getByTestId(`supervision-execution-pool-role-${capabilityId}`) as HTMLSelectElement;
      select.value = role;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0];
    unmount();
    fetchSupervisorDefaultsMock.mockResolvedValue(saved);
    render(<SessionSettingsDialog {...props} />);
    await waitFor(() => expect((screen.getByTestId(`supervision-execution-pool-role-${capabilityId}`) as HTMLSelectElement).value).toBe(role));
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    fireEvent.click(within(economy).getByLabelText('economy:deck_sub_peer,deck_sub_peer2'));
    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary')).getByLabelText('primary:deck_sub_peer,deck_sub_peer2'));
    expect((screen.getByTestId(`supervision-execution-pool-role-${capabilityId}`) as HTMLSelectElement).value).toBe(role);
  });

  it.each(['executor', 'auditor', 'both'] as const)('renders a configured-only %s entry without fabricating a live candidate', async (role) => {
    const capabilityId = 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6';
    fetchSupervisorDefaultsMock.mockResolvedValue({ executionPools: {
      state: 'configured', primaryDevelopmentPool: { configs: [{
        capabilityId, agentType: 'codex-sdk', runtimeType: 'transport', providerFamily: 'openai', model: 'gpt-5.6', role,
      }] }, economyTaskPool: { configs: [{
        capabilityId, agentType: 'codex-sdk', runtimeType: 'transport', providerFamily: 'openai', model: 'gpt-5.6', role: 'both',
      }] },
    } });
    render(<SupervisionSettingsDialog canControlAutomaticSupervision serverId="srv-1" sessionName="deck_proj_brain" label="" description="" cwd="/proj"
      type="codex-sdk" activeModel={CODEX_MODEL_IDS[0]} transportConfig={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect((screen.getByTestId(`supervision-execution-pool-role-${capabilityId}`) as HTMLSelectElement).value).toBe(role));
    const checkbox = screen.getByLabelText('primary:configured:codex-sdk:gpt-5.6');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(screen.queryByTestId(`supervision-execution-pool-role-${capabilityId}`)).toBeNull();
  });

  it('persists a CC preset constraint without binding it to a live session', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_cc_preset',
          label: 'CC preset worker',
          type: 'claude-code-sdk',
          providerId: 'anthropic',
          activeModel: 'MiniMax-M3',
          requestedModel: 'MiniMax-M3',
          ccPresetId: 'preset-a',
        })]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_cc_preset'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0] as {
      executionPools?: { primaryDevelopmentPool?: { configs?: Array<Record<string, unknown>> } };
    };
    const preset = saved.executionPools?.primaryDevelopmentPool?.configs
      ?.find((config) => config.ccPresetId === 'preset-a');
    expect(preset).toMatchObject({
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      model: 'minimax-m3',
      ccPresetId: 'preset-a',
    });
    expect(preset).not.toHaveProperty('sessionName');
  });

  it('shows an owner-authoritative empty-pool catalog to a participant once per constraint and leaves it unchecked', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary },
        economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
      },
    });
    fetchExecutionPoolCatalogMock.mockResolvedValue([
      {
        sessionName: 'deck_sub_cx_one', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Cx one', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      },
      {
        sessionName: 'deck_sub_cx_two', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Cx two', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      },
      {
        sessionName: 'deck_sub_cc_preset', parentSession: 'deck_proj_brain', type: 'claude-code-sdk', runtimeType: 'transport',
        label: 'CC preset', activeModel: 'minimax-m3', providerId: 'anthropic', ccPresetId: 'preset-a',
        capabilityId: 'supervision-exec-v1-cc-preset:transport:claude-code-sdk:anthropic:preset-a:minimax-m3', ownerCatalog: true,
      },
    ]);
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    const primaryCx = await within(primary).findByLabelText('primary:deck_sub_cx_one,deck_sub_cx_two') as HTMLInputElement;
    const economyCx = within(economy).getByLabelText('economy:deck_sub_cx_one,deck_sub_cx_two') as HTMLInputElement;
    const economyPreset = within(economy).getByLabelText('economy:deck_sub_cc_preset') as HTMLInputElement;
    expect(primaryCx.checked).toBe(false);
    expect(economyCx.checked).toBe(false);
    expect(economyPreset.checked).toBe(false);
    expect(primary.textContent).toContain('×2');
    await waitFor(() => expect(primary.querySelectorAll('input[type="checkbox"]')).toHaveLength(2));

    fireEvent.click(economyPreset);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0] as {
      executionPools?: {
        primaryDevelopmentPool?: { configs?: Array<Record<string, unknown>> };
        economyTaskPool?: { configs?: Array<Record<string, unknown>> };
      };
    };
    expect(saved.executionPools?.primaryDevelopmentPool?.configs).toEqual([]);
    expect(saved.executionPools?.economyTaskPool?.configs).toEqual([
      expect.objectContaining({ ccPresetId: 'preset-a' }),
    ]);
  });

  it('clears an owner catalog immediately when the covered session scope changes and the replacement load fails', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue(null);
    fetchExecutionPoolCatalogMock
      .mockResolvedValueOnce([{
        sessionName: 'deck_sub_old', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Old owner candidate', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      }])
      .mockRejectedValueOnce(new Error('new owner denied'));
    const view = render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('Old owner candidate')).toHaveLength(2));

    view.rerender(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-2"
        sessionName="deck_other_brain"
        label="Other"
        description="desc"
        cwd="/other"
        type="codex-sdk"
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryAllByText('Old owner candidate')).toHaveLength(0);
    await waitFor(() => expect(fetchExecutionPoolCatalogMock).toHaveBeenCalledWith('srv-2', 'deck_other_brain'));
    expect(screen.queryAllByText('Old owner candidate')).toHaveLength(0);
  });

  it('routes each pool add button to the existing sub-session launcher and accepts the new starting session immediately', () => {
    const onAddPoolSession = vi.fn();
    const view = render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[]}
        transportConfig={null}
        onAddPoolSession={onAddPoolSession}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByRole('button', { name: 'addPoolSession' }));
    expect(onAddPoolSession).toHaveBeenCalledWith('primary');

    view.rerender(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_new',
          label: 'New provider',
          state: 'starting',
          activeModel: 'gpt-5.5',
          requestedModel: 'gpt-5.5',
        })]}
        transportConfig={null}
        onAddPoolSession={onAddPoolSession}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_new')).toBeDefined();
  });

  it('portals above control overlays and always keeps Close and Cancel actionable', () => {
    const onClose = vi.fn();
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );

    const overlay = document.querySelector('.session-settings-overlay');
    expect(overlay?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('uses the responsive themed settings shell instead of native dialog chrome', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const dialog = document.querySelector('.session-settings-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-header')).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-body')).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-footer')).toBeTruthy();
    expect(dialog?.querySelectorAll('.session-settings-card')).toHaveLength(2);
    expect(dialog?.querySelector('.session-settings-audit-severities')).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-task-pairs')).toBeTruthy();
    expect(dialog?.querySelectorAll('.session-settings-subsection').length).toBeGreaterThanOrEqual(2);

    const close = screen.getByRole('button', { name: /^close$/i });
    expect(close.classList.contains('session-settings-close')).toBe(true);
    expect(close.textContent).toContain('×');
  });

  it('shows unsupported copy for process sessions', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('unsupported')).toBeDefined();
  });

  it('shows an invalid stored config warning when the persisted supervision snapshot is corrupt', () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'bad-backend',
            model: '',
            timeoutMs: 0,
            promptVersion: '',
            maxParseRetries: 0,
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('invalidStoredConfig')).toBeDefined();
  });

  it('submits sub-session supervision updates through patchSubSession without task-pair fields', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_sub_abcd1234"
        subSessionId="abcd1234"
        label="Worker"
        description=""
        cwd="/proj"
        type="codex-sdk"
        parentSession="deck_proj_brain"
        peerAuditSessions={[makePeerAuditSession()]}
        transportConfig={{ supervision: { mode: 'supervised', backend: 'codex-sdk', model: CODEX_MODEL_IDS[0], timeoutMs: 30_000, promptVersion: 'supervision_decision_v1' } }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    expect(screen.queryByTestId('task-pair-settings')).toBeNull();
    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary')).getByLabelText('primary:deck_sub_peer'));
    fireEvent.click(screen.getByTestId('audit-blocking-severity-P1'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSubSessionMock).toHaveBeenCalledWith('srv-1', 'abcd1234', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            auditBlockingSeverities: ['P0', 'P1'],
          }),
        }),
      }));
    });
    const patchedSupervision = (patchSubSessionMock.mock.calls.at(-1)?.[2] as {
      transportConfig?: { supervision?: Record<string, unknown> };
    })?.transportConfig?.supervision;
    expect(patchedSupervision).not.toHaveProperty('pairEngine');
    expect(patchedSupervision).not.toHaveProperty('pairMaxConcurrency');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      transportConfig: expect.objectContaining({
        supervision: expect.objectContaining({
          auditBlockingSeverities: ['P0', 'P1'],
        }),
      }),
    }));
  });

  it('persists execution pool updates onto the session snapshot even while stored mode stays off', async () => {
    render(
      <SessionSettingsDialog
        surface="supervision"
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession()]}
        transportConfig={{ supervision: { mode: 'off' } }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary')).getByLabelText('primary:deck_sub_peer'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: expect.arrayContaining([
              expect.objectContaining({ agentType: 'codex-sdk', model: 'gpt-5.6' }),
            ]),
          }),
        }),
      }));
    });
    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'off',
            executionPools: expect.objectContaining({
              state: 'configured',
              primaryDevelopmentPool: expect.objectContaining({
                configs: expect.arrayContaining([
                  expect.objectContaining({ agentType: 'codex-sdk', model: 'gpt-5.6' }),
                ]),
              }),
            }),
          }),
        }),
      }));
    });
    expect(patchSubSessionMock).not.toHaveBeenCalled();
  });

  it('syncs model list and resets model when provider is switched', async () => {
    const ws = makeIdentityAckWs();
    render(
      <SessionSettingsDialog
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description=""
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        requestedModel={CODEX_MODEL_IDS[0]}
        transportConfig={null}
        surface="session"
        ws={ws as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Initial state: model list contains Codex models, no Claude models
    const modelSelect = screen.getByLabelText('label') as HTMLSelectElement;
    const initialOptions = [...modelSelect.options].map((o) => o.value);
    expect(initialOptions.some((id) => CODEX_MODEL_IDS.includes(id as typeof CODEX_MODEL_IDS[number]))).toBe(true);
    expect(initialOptions.some((id) => CLAUDE_CODE_MODEL_IDS.includes(id as typeof CLAUDE_CODE_MODEL_IDS[number]))).toBe(false);

    // Switch provider to claude-code-sdk
    const typeSelect = screen.getByTestId('session-agent-type') as HTMLSelectElement;
    expect(typeSelect.value).toBe('codex-sdk');
    changeSelect(typeSelect, 'claude-code-sdk');

    // Model list must now contain Claude models
    await waitFor(() => {
      const options = [...modelSelect.options].map((o) => o.value);
      expect(options.some((id) => CLAUDE_CODE_MODEL_IDS.includes(id as typeof CLAUDE_CODE_MODEL_IDS[number]))).toBe(true);
    });

    // Selected model must have been reset to a Claude default (not a stale Codex model)
    await waitFor(() => {
      expect(CLAUDE_CODE_MODEL_IDS.includes(modelSelect.value as typeof CLAUDE_CODE_MODEL_IDS[number])).toBe(true);
    });

    // A provider switch is committed by Save, not a separate /model command.
    const applyButton = await screen.findByRole('button', { name: 'apply' });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', {
      agentType: 'claude-code-sdk', requestedModel: CLAUDE_CODE_MODEL_IDS[0], activeModel: null,
    }));
    expect(ws.sendSessionMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, 'sub-1'])('saves Codex to AGY once for %s and clears the old active display', async (subSessionId) => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SessionSettingsDialog
      serverId="srv-1" sessionName="deck_proj_brain" subSessionId={subSessionId}
      label="Brain" description="" cwd="/proj" type="codex-sdk"
      activeModel={CODEX_MODEL_IDS[0]} requestedModel={CODEX_MODEL_IDS[0]} modelDisplay={CODEX_MODEL_IDS[0]}
      transportConfig={null} surface="session" onClose={onClose} onSaved={onSaved}
    />);
    changeSelect(screen.getByTestId('session-agent-type'), AGY_SDK_PROVIDER_ID);
    await waitFor(() => expect((screen.getByLabelText('label') as HTMLSelectElement).value).toBe(AGY_DEFAULT_MODEL_ID));
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    const patch = subSessionId ? patchSubSessionMock : patchSessionMock;
    await waitFor(() => expect(patch).toHaveBeenCalledWith('srv-1', subSessionId ?? 'deck_proj_brain', {
      [subSessionId ? 'type' : 'agentType']: AGY_SDK_PROVIDER_ID,
      requestedModel: AGY_DEFAULT_MODEL_ID,
      activeModel: null,
    }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      type: AGY_SDK_PROVIDER_ID, requestedModel: AGY_DEFAULT_MODEL_ID, activeModel: null, modelDisplay: null,
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses a late AGY live default but does not override a later manual selection', async () => {
    const handlers = new Set<(message: unknown) => void>();
    const ws = { connected: true, onMessage: (cb: (message: unknown) => void) => { handlers.add(cb); return () => handlers.delete(cb); }, requestTransportModels: () => 'agy-switch' };
    render(<SessionSettingsDialog serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
      type="codex-sdk" activeModel={CODEX_MODEL_IDS[0]} requestedModel={CODEX_MODEL_IDS[0]}
      transportConfig={null} surface="session" ws={ws as any} onClose={vi.fn()} onSaved={vi.fn()} />);
    changeSelect(screen.getByTestId('session-agent-type'), AGY_SDK_PROVIDER_ID);
    await waitFor(() => expect((screen.getByLabelText('label') as HTMLSelectElement).value).toBe(AGY_DEFAULT_MODEL_ID));
    act(() => handlers.forEach((handler) => handler({ type: 'transport.models_response', agentType: AGY_SDK_PROVIDER_ID,
      sessionName: 'deck_proj_brain', requestId: 'agy-switch', models: [{ id: AGY_DEFAULT_MODEL_ID }, { id: 'live-default' }, { id: 'manual-choice' }], defaultModel: 'live-default' })));
    await waitFor(() => expect((screen.getByLabelText('label') as HTMLSelectElement).value).toBe('live-default'));
    changeSelect(screen.getByLabelText('label'), 'manual-choice');
    act(() => handlers.forEach((handler) => handler({ type: 'transport.models_response', agentType: AGY_SDK_PROVIDER_ID,
      sessionName: 'deck_proj_brain', requestId: 'agy-switch', models: [{ id: AGY_DEFAULT_MODEL_ID }, { id: 'manual-choice' }, { id: 'later-default' }], defaultModel: 'later-default' })));
    expect((screen.getByLabelText('label') as HTMLSelectElement).value).toBe('manual-choice');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', {
      agentType: AGY_SDK_PROVIDER_ID, requestedModel: 'manual-choice', activeModel: null,
    }));
  });

  it.each([
    { from: AGY_SDK_PROVIDER_ID, to: 'codex-sdk', expected: CODEX_MODEL_IDS[0] },
    { from: 'codex-sdk', to: 'shell', expected: null },
  ])('uses the target default or clears models for $from to $to', async ({ from, to, expected }) => {
    const oldModel = from === AGY_SDK_PROVIDER_ID ? AGY_DEFAULT_MODEL_ID : CODEX_MODEL_IDS[0];
    const onSaved = vi.fn();
    render(<SessionSettingsDialog serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
      type={from} activeModel={oldModel} requestedModel={oldModel} transportConfig={null}
      surface="session" onClose={vi.fn()} onSaved={onSaved} />);
    changeSelect(screen.getByTestId('session-agent-type'), to);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', {
      agentType: to, requestedModel: expected, activeModel: null,
    }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: expected, activeModel: null, modelDisplay: null,
    }));
  });

  it('does not change model for metadata-only saves or publish a failed provider save', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    patchSessionMock.mockRejectedValueOnce(new Error('offline'));
    render(<SessionSettingsDialog serverId="srv-1" sessionName="deck_proj_brain" label="Brain" description="" cwd="/proj"
      type="codex-sdk" activeModel={CODEX_MODEL_IDS[0]} requestedModel={CODEX_MODEL_IDS[0]}
      transportConfig={null} surface="session" onClose={onClose} onSaved={onSaved} />);
    changeSelect(screen.getByTestId('session-agent-type'), AGY_SDK_PROVIDER_ID);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(document.querySelector('.session-settings-error')?.textContent).toContain('offline'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    changeSelect(screen.getByTestId('session-agent-type'), 'codex-sdk');
    fireEvent.input(inputForLabel('label'), { target: { value: 'New Brain' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenLastCalledWith('srv-1', 'deck_proj_brain', { label: 'New Brain' }));
  });
});
