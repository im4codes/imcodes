/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';
import { CloneSessionGroupDialog } from '../../src/components/CloneSessionGroupDialog.js';
import type { SessionInfo } from '../../src/types.js';
import { SESSION_GROUP_CLONE_CAPABILITY_V1, SESSION_GROUP_CLONE_MSG } from '../../../shared/session-group-clone.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'session.clone.title': 'Copy Session Group',
        'session.clone.source': 'Source session',
        'session.clone.targetProjectName': 'Target project name',
        'session.clone.targetProjectPlaceholder': 'my-project-copy',
        'session.clone.finalSessionName': 'Final session',
        'session.clone.previewUnavailable': 'Enter a project name',
        'session.clone.preserveDirectories': 'Default: cloned sessions use the original working directories',
        'session.clone.overrideDirectories': 'Use a new working directory for cloned sessions',
        'session.clone.cwdOverride': 'Replacement working directory',
        'session.clone.cwdOverridePlaceholder': '/work/new-checkout',
        'session.clone.browseCwd': 'Browse working directory',
        'session.clone.daemonHostValidation': 'Working directories are validated on the daemon host before anything is created.',
        'session.clone.runningWarning': 'The copied group starts fresh.',
        'session.clone.capabilityMissing': 'The daemon has not reported copy support yet.',
        'session.clone.submit': 'Copy group',
        'session.clone.submitting': 'Copying...',
        'session.clone.blankProject': 'Target project name is required.',
        'session.clone.notConnected': 'Connect first.',
        'session.clone.daemonOffline': 'Daemon offline.',
        'session.clone.missingServer': 'Select a server.',
        'session.clone.cwdRequired': 'Enter cwd.',
        'session.clone.progress': `Status: ${String(opts?.state ?? '')}`,
        'session.clone.subSessionProgress': `Sub-sessions: ${String(opts?.created ?? 0)}/${String(opts?.total ?? 0)} copied`,
        'session.clone.operationId': `Operation: ${String(opts?.operationId ?? '')}`,
        'session.clone.success': `Copied group created as ${String(opts?.session ?? '')}. Switching to it now.`,
        'session.clone.cleanupRequired': 'Cleanup required',
        'session.clone.cleanupRequiredBody': 'Manual cleanup may be required.',
        'session.clone.cleanupResourceDetail': `${String(opts?.kind ?? '')}: ${String(opts?.id ?? '')}`,
        'session.clone.warningsTitle': `${String(opts?.count ?? 0)} warning(s)`,
        'session.clone.skippedMembersTitle': `${String(opts?.count ?? 0)} skipped member(s)`,
        'session.clone.skippedMemberDetail': `${String(opts?.session ?? '')}: ${String(opts?.reason ?? '')}`,
        'session.clone.skippedCronJobs': `${String(opts?.count ?? 0)} scheduled task(s) were not copied.`,
        'session.clone.skippedOrchestrationRuns': `${String(opts?.count ?? 0)} discussion/orchestration run(s) were not copied.`,
        'session.clone.state.validating': 'Validating',
        'session.clone.state.creating_subs': 'Creating sub-sessions',
        'session.clone.state.cleanup_required': 'Cleanup required',
        'session.clone.state.failed': 'Failed',
        'session.clone.errorCode.unsupported_command': 'The daemon has not reported copy support.',
        'session.clone.errorCode.forbidden': 'Only owners and admins can copy groups.',
        'session.clone.errorCode.invalid_cwd': 'The working directory is invalid on the daemon host.',
        'session.clone.errorCode.name_taken': 'That target session name is already in use.',
        'session.clone.errorCode.cleanup_required': 'The copy needs manual cleanup before retrying.',
        'session.clone.errorCode.server_p2p_commit_failed': 'The server could not copy the Team settings.',
        'session.clone.warningCode.p2p_prompt_session_reference': 'Free-text Team reference may still mention the source',
        'session.clone.warningCode.scheduled_work_skipped': 'Scheduled work was not copied',
        'session.clone.cleanupResourceKind.server_p2p_pref': 'server Team preference',
        'session.clone.cleanupResourceKind.daemon_session': 'daemon session',
        'session.clone.skippedReason.stopped': 'stopped',
        'session.clone.skippedReason.unsupported': 'unsupported',
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: () => null,
}));

const sourceSession: SessionInfo = {
  name: 'deck_cd_brain',
  project: 'cd',
  role: 'brain',
  agentType: 'codex-sdk',
  runtimeType: 'transport',
  state: 'idle',
  projectDir: '/work/cd',
};

function makeWs() {
  const handlers = new Set<(msg: unknown) => void>();
  return {
    connected: true,
    cloneSessionGroup: vi.fn(),
    requestSessionList: vi.fn(),
    p2pStatus: vi.fn(),
    p2pListDiscussions: vi.fn(),
    getDaemonCapabilitySnapshot: vi.fn(() => ({
      daemonId: 'daemon-test',
      capabilities: [SESSION_GROUP_CLONE_CAPABILITY_V1],
      helloEpoch: 1,
      sentAt: Date.now(),
      observedAt: Date.now(),
    })),
    isDaemonCapabilityStale: vi.fn(() => false),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    emit: (msg: unknown) => {
      handlers.forEach((handler) => handler(msg));
    },
  };
}

function renderDialog(
  ws = makeWs(),
  overrides: Partial<Parameters<typeof CloneSessionGroupDialog>[0]> = {},
) {
  render(
    <CloneSessionGroupDialog
      ws={ws as any}
      serverId="server-1"
      sourceSession={sourceSession}
      sessions={[sourceSession]}
      subSessions={[]}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
  return ws;
}

describe('CloneSessionGroupDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('previews the smallest available sanitized target session name', () => {
    renderDialog(makeWs(), {
      sessions: [
        sourceSession,
        { ...sourceSession, name: 'deck_cd_1_brain', project: 'cd_1' },
      ],
    });

    expect(screen.getByDisplayValue('cd_2')).toBeDefined();
    expect(screen.getByText('deck_cd_2_brain')).toBeDefined();

    fireEvent.input(screen.getByDisplayValue('cd_2'), {
      target: { value: 'P2P Design Review' },
    });
    expect(screen.getByText('deck_p2p_design_review_brain')).toBeDefined();
  });

  it('shows the daemon-host directory option and running-source warning', () => {
    renderDialog(makeWs(), {
      sourceSession: { ...sourceSession, state: 'running' },
    });

    expect(screen.getByText('Working directories are validated on the daemon host before anything is created.')).toBeDefined();
    expect(screen.getByText('The copied group starts fresh.')).toBeDefined();

    expect(screen.getByText(/original working directories|Preserve source working directories/)).toBeDefined();

    fireEvent.click(screen.getByLabelText(/working director/i));
    expect(screen.getByPlaceholderText('/work/new-checkout')).toBeDefined();
  });

  it('rejects a blank target project before submitting', () => {
    const ws = renderDialog();
    fireEvent.input(screen.getByDisplayValue('cd_1'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));

    expect(screen.getByText('Target project name is required.')).toBeDefined();
    expect(ws.cloneSessionGroup).not.toHaveBeenCalled();
  });

  it('shows a non-technical capability message when clone support is not reported', () => {
    const ws = makeWs();
    ws.getDaemonCapabilitySnapshot.mockReturnValue({
      daemonId: 'daemon-test',
      capabilities: [],
      helloEpoch: 1,
      sentAt: Date.now(),
      observedAt: Date.now(),
    });
    renderDialog(ws);

    expect(screen.getByText('The daemon has not reported copy support yet.')).toBeDefined();
    expect(screen.queryByText(SESSION_GROUP_CLONE_CAPABILITY_V1)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));

    expect(ws.cloneSessionGroup).not.toHaveBeenCalled();
    expect(screen.getAllByText('The daemon has not reported copy support yet.')).toHaveLength(2);
    expect(screen.queryByText(SESSION_GROUP_CLONE_CAPABILITY_V1)).toBeNull();
  });

  it('submits once with an idempotency key', () => {
    const ws = renderDialog();
    const submit = screen.getByRole('button', { name: 'Copy group' });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(ws.cloneSessionGroup).toHaveBeenCalledOnce();
    expect(ws.cloneSessionGroup).toHaveBeenCalledWith({
      serverId: 'server-1',
      sourceMainSessionName: 'deck_cd_brain',
      targetProjectName: 'cd_1',
      cwdOverride: null,
      idempotencyKey: expect.any(String),
    });
  });

  it('refreshes, switches to the cloned main session, and closes on success', () => {
    const onClose = vi.fn();
    const ws = renderDialog(makeWs(), { onClose });
    const navigations: unknown[] = [];
    const onNavigate = (event: Event) => {
      navigations.push((event as CustomEvent).detail);
    };
    window.addEventListener('deck:navigate', onNavigate);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
      const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

      act(() => ws.emit({
        type: SESSION_GROUP_CLONE_MSG.EVENT,
        operationId: 'op-1',
        idempotencyKey,
        state: 'succeeded',
        result: {
          operationId: 'op-1',
          idempotencyKey,
          sourceMainSession: 'deck_cd_brain',
          clonedMainSession: 'deck_cd_1_brain',
          targetProjectName: 'cd_1',
          targetProjectSlug: 'cd_1',
          sessionNameMap: { deck_cd_brain: 'deck_cd_1_brain' },
          copiedSubSessionIds: [],
          skippedMembers: [],
          skippedCronJobs: 0,
          skippedOrchestrationRuns: 0,
          warnings: [],
        },
      }));

      expect(ws.requestSessionList).toHaveBeenCalledOnce();
      expect(ws.p2pStatus).toHaveBeenCalledWith({ sessionName: 'deck_cd_1_brain' });
      expect(ws.p2pListDiscussions).toHaveBeenCalledWith({ sessionName: 'deck_cd_1_brain' });
      expect(navigations).toContainEqual({ serverId: 'server-1', session: 'deck_cd_1_brain' });
      expect(onClose).toHaveBeenCalledOnce();
      expect(screen.getByText('Copied group created as deck_cd_1_brain. Switching to it now.')).toBeDefined();
    } finally {
      window.removeEventListener('deck:navigate', onNavigate);
    }
  });

  it('ignores stale operation events after accepting the active operation', () => {
    const ws = renderDialog();
    const navigations: unknown[] = [];
    const onNavigate = (event: Event) => navigations.push((event as CustomEvent).detail);
    window.addEventListener('deck:navigate', onNavigate);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
      const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

      act(() => ws.emit({
        type: SESSION_GROUP_CLONE_MSG.EVENT,
        operationId: 'op-current',
        idempotencyKey,
        state: 'validating',
      }));
      act(() => ws.emit({
        type: SESSION_GROUP_CLONE_MSG.EVENT,
        operationId: 'op-old',
        idempotencyKey,
        state: 'succeeded',
        clonedMainSessionName: 'deck_stale_brain',
      }));

      expect(navigations).toEqual([]);
      expect(ws.requestSessionList).not.toHaveBeenCalled();
      expect(screen.queryByText('Copied group created as deck_stale_brain. Switching to it now.')).toBeNull();
      expect(screen.getByText('Status: Validating')).toBeDefined();
    } finally {
      window.removeEventListener('deck:navigate', onNavigate);
    }
  });

  it('shows progress and ignores stale diagnostics from a different operation', () => {
    const ws = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
    const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

    act(() => ws.emit({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-current',
      idempotencyKey,
      state: 'creating_subs',
      totalSubSessions: 3,
      subSessionsCreated: 1,
      skippedMembers: [{ sessionName: 'deck_sub_old_worker', reason: 'stopped' }],
    }));
    act(() => ws.emit({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-stale',
      idempotencyKey,
      state: 'cleanup_required',
      cleanupRequired: true,
      errorCode: 'cleanup_required',
      skippedMembers: [{ sessionName: 'deck_sub_stale_worker', reason: 'unsupported' }],
    }));

    expect(screen.getByText('Status: Creating sub-sessions')).toBeDefined();
    expect(screen.getByText('Sub-sessions: 1/3 copied')).toBeDefined();
    expect(screen.getByText('Operation: op-current')).toBeDefined();
    expect(screen.getByText('deck_sub_old_worker: stopped')).toBeDefined();
    expect(screen.queryByText('Cleanup required')).toBeNull();
    expect(screen.queryByText('deck_sub_stale_worker: unsupported')).toBeNull();
  });

  it('shows cleanup-required diagnostics and localized cleanup failure text', () => {
    const ws = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
    const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

    act(() => ws.emit({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-cleanup',
      idempotencyKey,
      state: 'cleanup_required',
      cleanupRequired: true,
      errorCode: 'cleanup_required',
      cleanupResources: [
        { kind: 'server_p2p_pref', id: 'p2p_session_config:server-1:deck_cd_1_brain', sessionName: 'deck_cd_1_brain' },
        { kind: 'daemon_session', id: 'deck_cd_1_brain', sessionName: 'deck_cd_1_brain' },
      ],
    }));

    expect(screen.getByText('Status: Cleanup required')).toBeDefined();
    expect(screen.getByText('Cleanup required')).toBeDefined();
    expect(screen.getByText('Manual cleanup may be required.')).toBeDefined();
    expect(screen.getByText('The copy needs manual cleanup before retrying.')).toBeDefined();
    expect(screen.getByText('server Team preference: p2p_session_config:server-1:deck_cd_1_brain')).toBeDefined();
    expect(screen.getByText('daemon session: deck_cd_1_brain')).toBeDefined();
  });

  it('shows skipped-member, scheduled-work, and warning diagnostics', () => {
    const ws = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
    const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

    act(() => ws.emit({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-diag',
      idempotencyKey,
      state: 'failed',
      skippedMembers: [
        { sessionName: 'deck_sub_stopped_worker', reason: 'stopped' },
        { sessionName: 'deck_sub_unsupported_worker', reason: 'unsupported' },
      ],
      skippedCronJobs: 2,
      skippedOrchestrationRuns: 1,
      warnings: [
        {
          code: 'p2p_prompt_session_reference',
          sourceSessionName: 'deck_cd_brain',
          fieldPath: 'workflowLibrary[0].nodes[0].promptAppend',
        },
        { code: 'scheduled_work_skipped' },
      ],
    }));

    expect(screen.getByText('2 warning(s)')).toBeDefined();
    expect(screen.getByText('Free-text Team reference may still mention the source: deck_cd_brain / workflowLibrary[0].nodes[0].promptAppend')).toBeDefined();
    expect(screen.getByText('Scheduled work was not copied')).toBeDefined();
    expect(screen.getByText('2 skipped member(s)')).toBeDefined();
    expect(screen.getByText('deck_sub_stopped_worker: stopped')).toBeDefined();
    expect(screen.getByText('deck_sub_unsupported_worker: unsupported')).toBeDefined();
    expect(screen.getByText('2 scheduled task(s) were not copied.')).toBeDefined();
    expect(screen.getByText('1 discussion/orchestration run(s) were not copied.')).toBeDefined();
  });

  it('shows localized failure text for supported clone failure codes', () => {
    const cases = [
      ['unsupported_command', 'The daemon has not reported copy support.'],
      ['forbidden', 'Only owners and admins can copy groups.'],
      ['invalid_cwd', 'The working directory is invalid on the daemon host.'],
      ['name_taken', 'That target session name is already in use.'],
      ['server_p2p_commit_failed', 'The server could not copy the Team settings.'],
    ] as const;

    for (const [errorCode, expectedText] of cases) {
      const ws = renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Copy group' }));
      const idempotencyKey = ws.cloneSessionGroup.mock.calls[0]?.[0]?.idempotencyKey as string;

      act(() => ws.emit({
        type: SESSION_GROUP_CLONE_MSG.EVENT,
        operationId: `op-${errorCode}`,
        idempotencyKey,
        state: 'failed',
        errorCode,
      }));

      expect(screen.getByText(expectedText)).toBeDefined();
      cleanup();
    }
  });

  it('uses the target project only for identity preview and never adds a visual label suffix', () => {
    renderDialog(makeWs(), {
      sourceSession: {
        ...sourceSession,
        label: 'Production Brain',
      },
    });

    expect(screen.getByDisplayValue('deck_cd_brain')).toBeDefined();
    expect(screen.getByText('deck_cd_1_brain')).toBeDefined();
    expect(screen.queryByText('Production Brain copy')).toBeNull();
    expect(screen.queryByText('Production Brain (copy)')).toBeNull();

    fireEvent.input(screen.getByDisplayValue('cd_1'), {
      target: { value: 'P2P Design Review' },
    });

    expect(screen.getByText('deck_p2p_design_review_brain')).toBeDefined();
    expect(screen.queryByText('P2P Design Review')).toBeNull();
    expect(screen.queryByText('P2P Design Review copy')).toBeNull();
  });
});
