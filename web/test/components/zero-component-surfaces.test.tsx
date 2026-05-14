/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const {
  apiFetchMock,
  deletePasskeyMock,
  listPasskeysMock,
  passkeyRegisterBeginMock,
  passkeyRegisterCompleteMock,
  startRegistrationMock,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  deletePasskeyMock: vi.fn(),
  listPasskeysMock: vi.fn(),
  passkeyRegisterBeginMock: vi.fn(),
  passkeyRegisterCompleteMock: vi.fn(),
  startRegistrationMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object' && 'defaultValue' in options) {
        return String((options as { defaultValue: string }).defaultValue);
      }
      return key;
    },
  }),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: (...args: unknown[]) => startRegistrationMock(...args),
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  deletePasskey: (...args: unknown[]) => deletePasskeyMock(...args),
  listPasskeys: (...args: unknown[]) => listPasskeysMock(...args),
  passkeyRegisterBegin: (...args: unknown[]) => passkeyRegisterBeginMock(...args),
  passkeyRegisterComplete: (...args: unknown[]) => passkeyRegisterCompleteMock(...args),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({});
  deletePasskeyMock.mockResolvedValue({});
  listPasskeysMock.mockResolvedValue({ credentials: [] });
  passkeyRegisterBeginMock.mockResolvedValue({ challengeId: 'challenge-1', publicKey: { challenge: 'abc' } });
  passkeyRegisterCompleteMock.mockResolvedValue({});
  startRegistrationMock.mockResolvedValue({ id: 'credential-response' });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function autofixTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix checkout flow',
    state: 'implementing',
    discussionRounds: 1,
    maxDiscussionRounds: 3,
    coderSession: 'deck_alpha_coder',
    auditorSession: 'deck_alpha_auditor',
    branch: 'fix/checkout',
    issueId: '123',
    startedAt: Date.now() - 10_000,
    updatedAt: Date.now(),
    ...overrides,
  } as any;
}

describe('previously uncovered component surfaces', () => {
  it('renders P2P chain states and confirms cancellation', async () => {
    const { P2pChainStatus } = await import('../../src/components/P2pChainStatus.js');
    const onCancel = vi.fn();

    const { unmount } = render(
      <P2pChainStatus
        run={{
          id: 'run-1',
          initiator_session: 'deck_alpha_brain',
          initiator_label: 'Brain',
          current_target_session: 'deck_alpha_worker',
          current_target_label: 'Worker',
          remaining_targets: JSON.stringify([{ session: 'deck_alpha_reviewer', mode: 'audit' }]),
          status: 'running',
          mode_key: 'review',
          result_summary: null,
          error: null,
          current_round: 1,
          total_rounds: 2,
          completed_hops_count: 1,
          total_count: 4,
        }}
        onCancel={onCancel}
      />,
    );

    expect(screen.getAllByText('Brain')).toHaveLength(2);
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('p2p.confirm_cancel'));
    expect(onCancel).toHaveBeenCalledWith('run-1');

    unmount();
    render(
      <P2pChainStatus
        run={{
          id: 'run-2',
          initiator_session: 'deck_alpha_brain',
          remaining_targets: 'not json',
          current_target_session: null,
          status: 'completed',
          mode_key: 'review',
          result_summary: 'All hops complete',
          error: null,
        }}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('All hops complete')).toBeTruthy();

    cleanup();
    render(
      <P2pChainStatus
        run={{
          id: 'run-3',
          initiator_session: 'deck_alpha_brain',
          remaining_targets: '[]',
          current_target_session: null,
          status: 'failed',
          mode_key: 'review',
          result_summary: null,
          error: 'Target timed out',
        }}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('Target timed out')).toBeTruthy();
  });

  it('manages passkeys through list, add, delete, and error paths', async () => {
    const { PasskeyManager } = await import('../../src/components/PasskeyManager.js');
    listPasskeysMock
      .mockResolvedValueOnce({
        credentials: [{
          id: 'cred-1',
          deviceName: 'Laptop',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        }],
      })
      .mockResolvedValue({ credentials: [] });

    render(<PasskeyManager />);

    expect(await screen.findByText('Laptop')).toBeTruthy();
    fireEvent.click(screen.getByText('common.delete'));
    fireEvent.click(screen.getByText('common.confirm'));
    await waitFor(() => expect(deletePasskeyMock).toHaveBeenCalledWith('cred-1'));

    fireEvent.input(screen.getByPlaceholderText('passkey.device_name_placeholder'), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByText('passkey.add'));
    await waitFor(() => expect(passkeyRegisterCompleteMock).toHaveBeenCalledWith(
      'challenge-1',
      { id: 'credential-response' },
      'Work laptop',
    ));
  });

  it('renders review, audit, split-view, and preview panes', async () => {
    const { AuditFindings } = await import('../../src/components/AuditFindings.js');
    const { FilePreviewPane, highlightCode } = await import('../../src/components/FilePreviewPane.js');
    const { ReviewFlow } = await import('../../src/components/ReviewFlow.js');
    const { SplitView } = await import('../../src/components/SplitView.js');

    render(<AuditFindings findings={[]} />);
    expect(screen.getByText('No findings yet.')).toBeTruthy();
    cleanup();

    render(<AuditFindings findings={[
      { round: 1, type: 'finding', agent: 'auditor', content: '**Bug**\n- missing test', timestamp: Date.now() },
      { round: 1, type: 'response', agent: 'coder', content: 'Fixed', timestamp: Date.now() },
    ]} />);
    expect(screen.getByText('FINDING')).toBeTruthy();
    expect(screen.getByText('RESPONSE')).toBeTruthy();
    cleanup();

    render(<ReviewFlow coderSession="deck_alpha_coder" auditorSession="deck_alpha_auditor" reviews={[]} />);
    expect(screen.getByText('No reviews yet.')).toBeTruthy();
    cleanup();

    render(<ReviewFlow coderSession="deck_alpha_coder" auditorSession="deck_alpha_auditor" reviews={[
      { round: 1, approved: false, content: 'Needs work', timestamp: Date.now() },
      { round: 2, approved: true, content: 'Looks good', timestamp: Date.now() },
    ]} />);
    expect(screen.getByText('REJECTED')).toBeTruthy();
    expect(screen.getByText('APPROVED')).toBeTruthy();
    cleanup();

    render(<SplitView tasks={[]} />);
    expect(screen.getByText('No active tasks')).toBeTruthy();
    cleanup();

    const onAbort = vi.fn();
    const onRetry = vi.fn();
    render(<SplitView tasks={[
      autofixTask(),
      autofixTask({ id: 'task-2', state: 'code_review', title: 'Review patch' }),
      autofixTask({ id: 'task-3', state: 'failed', title: 'Retry patch', error: 'boom' }),
    ]} onAbort={onAbort} onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Fix checkout flow'));
    fireEvent.click(screen.getByText('Abort'));
    expect(onAbort).toHaveBeenCalledWith('task-1');
    fireEvent.click(screen.getByText('Retry patch'));
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('task-3');
    expect(screen.getByText('Code Review')).toBeTruthy();
    cleanup();

    expect(highlightCode('# Title', 'README.md').isMarkdown).toBe(true);
    expect(highlightCode('const x: number = 1;', 'main.ts').isMarkdown).toBe(false);
    render(<FilePreviewPane content="# Hello" path="/work/README.md" />);
    expect(document.querySelector('.fb-preview-md')).toBeTruthy();
    cleanup();
    render(<FilePreviewPane content="const answer = 42;" path="/work/main.ts" />);
    expect(document.querySelector('.fb-preview-code')).toBeTruthy();
  });

  it('covers getting started, project list, account deletion, mobile controls, and onboarding', async () => {
    const { DeleteAccount } = await import('../../src/components/DeleteAccount.js');
    const { GettingStarted } = await import('../../src/components/GettingStarted.js');
    const { MobileControls } = await import('../../src/components/MobileControls.js');
    const { NewUserGuide } = await import('../../src/components/NewUserGuide.js');
    const { ProjectList } = await import('../../src/pages/ProjectList.js');

    apiFetchMock.mockResolvedValueOnce({ apiKey: 'key-1' });
    localStorage.setItem('rcc_auth', JSON.stringify({ baseUrl: 'http://localhost:3000' }));
    const onKeyCreated = vi.fn();
    render(<GettingStarted keys={[]} onKeyCreated={onKeyCreated} onDeviceAppeared={vi.fn()} />);
    fireEvent.click(screen.getByText('api_key.generate'));
    await waitFor(() => expect(onKeyCreated).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('api_key.copy'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('key-1'));
    cleanup();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        name: 'Alpha',
        dir: '/work/alpha',
        status: 'running',
        trackerType: 'github',
        activeSessions: 2,
        lastActivity: Date.now(),
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    render(<ProjectList apiKey="api-key" serverId="srv-1" onSelect={onSelect} onAdd={onAdd} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    fireEvent.click(screen.getByText('+ Add Project'));
    fireEvent.click(screen.getByText('Alpha'));
    expect(fetchMock).toHaveBeenCalledWith('/api/server/srv-1/projects', {
      headers: { Authorization: 'Bearer api-key' },
    });
    expect(onAdd).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith('Alpha');
    cleanup();

    const onDeleted = vi.fn();
    apiFetchMock.mockResolvedValueOnce({});
    render(<DeleteAccount onDeleted={onDeleted} />);
    fireEvent.click(screen.getByText('account.delete_btn'));
    fireEvent.input(screen.getByPlaceholderText('DELETE'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByText('account.delete_confirm'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/user/me', { method: 'DELETE' });
    cleanup();

    const onSessionChange = vi.fn();
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<MobileControls sessions={['one', 'two', 'three']} activeSession="two" onSessionChange={onSessionChange} onSend={onSend} onStop={onStop} />);
    fireEvent.click(screen.getByTitle('one'));
    fireEvent.input(screen.getByPlaceholderText('Send message…'), { target: { value: ' hello ' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Send message…'), { key: 'Enter' });
    fireEvent.click(screen.getByTitle('Stop'));
    expect(onSessionChange).toHaveBeenCalledWith('one');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(onStop).toHaveBeenCalled();
    cleanup();

    const target = document.createElement('button');
    target.className = 'guide-target';
    target.getBoundingClientRect = () => ({ top: 20, left: 30, width: 100, height: 40, bottom: 60, right: 130, x: 30, y: 20, toJSON: () => ({}) });
    document.body.appendChild(target);
    const onClose = vi.fn();
    const onComplete = vi.fn();
    render(<NewUserGuide
      open
      steps={[
        { selector: '.guide-target', titleKey: 'step.one', bodyKeys: ['body.one'] },
        { titleKey: 'step.two', bodyKeys: ['body.two'] },
      ]}
      onClose={onClose}
      onComplete={onComplete}
    />);
    expect(screen.getByText('step.one')).toBeTruthy();
    fireEvent.click(screen.getByText('onboarding.next'));
    expect(screen.getByText('step.two')).toBeTruthy();
    fireEvent.click(screen.getByText('onboarding.prev'));
    expect(screen.getByText('step.one')).toBeTruthy();
    fireEvent.click(screen.getByText('onboarding.next'));
    fireEvent.click(screen.getByText('onboarding.finish'));
    expect(onComplete).toHaveBeenCalled();
    target.remove();
  });

  it('covers compact P2P progress and server navigation chrome', async () => {
    const { P2pRingProgress } = await import('../../src/components/P2pRingProgress.js');
    const { DeleteServerDialog, ServerContextMenu } = await import('../../src/components/ServerContextMenu.js');
    const { ServerIconBar } = await import('../../src/components/ServerIconBar.js');

    const onRingClick = vi.fn();
    render(
      <P2pRingProgress
        completedRounds={1}
        totalRounds={3}
        completedHops={2}
        totalHops={4}
        activeHop={3}
        status="running"
        modeKey="review"
        onClick={onRingClick}
      />,
    );
    const ring = document.querySelector('.p2p-ring') as HTMLElement;
    expect(ring.getAttribute('role')).toBe('button');
    fireEvent.click(ring);
    fireEvent.keyDown(ring, { key: 'Enter' });
    fireEvent.keyDown(ring, { key: 'Escape' });
    expect(onRingClick).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.p2p-ring-progress')?.getAttribute('stroke-dasharray')).toContain(' ');
    cleanup();

    render(
      <P2pRingProgress
        completedRounds={3}
        totalRounds={3}
        completedHops={6}
        totalHops={2}
        status="completed"
      />,
    );
    expect(document.querySelector('.p2p-ring')?.getAttribute('role')).toBeNull();
    expect(screen.getAllByText('completed').length).toBeGreaterThan(1);
    cleanup();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 120 });
    const onRename = vi.fn();
    const onUpgrade = vi.fn();
    const onUpgradeAll = vi.fn();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(
      <ServerContextMenu
        x={180}
        y={110}
        onRename={onRename}
        onUpgrade={onUpgrade}
        onUpgradeAll={onUpgradeAll}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    expect((document.querySelector('.server-ctx-menu') as HTMLElement).style.left).toBe('36px');
    fireEvent.click(screen.getByText('session.rename'));
    expect(onClose).toHaveBeenCalled();
    expect(onRename).toHaveBeenCalled();
    fireEvent.click(screen.getByText('server.upgrade_daemon'));
    fireEvent.click(screen.getByText('server.upgrade_all'));
    fireEvent.click(screen.getByText('server.delete'));
    expect(onUpgrade).toHaveBeenCalled();
    expect(onUpgradeAll).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(6);
    cleanup();

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteServerDialog serverName="Prod" onConfirm={onConfirm} onCancel={onCancel} />);
    const confirmButton = screen.getByText('server.delete_confirm') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.input(screen.getByPlaceholderText('Prod'), { target: { value: 'Prod' } });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(document.querySelector('.ask-dialog-overlay') as HTMLElement);
    expect(onCancel).toHaveBeenCalled();
    cleanup();

    const onSelectServer = vi.fn();
    const onServerContextMenu = vi.fn();
    const onToggleSidebar = vi.fn();
    const onSettings = vi.fn();
    const onHome = vi.fn();
    const onAdmin = vi.fn();
    render(
      <ServerIconBar
        servers={[
          { id: 'srv-1', name: 'Prod', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() },
          { id: 'srv-2', name: '', status: 'offline', lastHeartbeatAt: null, createdAt: Date.now() },
        ]}
        activeServerId="srv-1"
        onSelectServer={onSelectServer}
        onServerContextMenu={onServerContextMenu}
        sidebarCollapsed
        onToggleSidebar={onToggleSidebar}
        onSettings={onSettings}
        onHome={onHome}
        isAdmin
        onAdmin={onAdmin}
      />,
    );
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    fireEvent.click(screen.getByLabelText('Prod'));
    fireEvent.contextMenu(screen.getByLabelText('Prod'), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByTitle('Admin'));
    fireEvent.click(screen.getByTitle('Settings'));
    fireEvent.click(screen.getByTitle('Home'));
    expect(onToggleSidebar).toHaveBeenCalled();
    expect(onSelectServer).toHaveBeenCalledWith('srv-1', 'Prod');
    expect(onServerContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv-1' }), 12, 34);
    expect(onAdmin).toHaveBeenCalled();
    expect(onSettings).toHaveBeenCalled();
    expect(onHome).toHaveBeenCalled();
  });
});
