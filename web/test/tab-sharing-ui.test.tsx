/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionTabs } from '../src/components/SessionTabs.js';
import { ShareSessionDialog } from '../src/components/ShareSessionDialog.js';
import { SessionControls } from '../src/components/SessionControls.js';
import { discoverSharedEntries, openSharedEntry } from '../src/api.js';
import { formatSharedActorLabel, sharedActorRoleLabelKey } from '../src/tab-sharing-ui.js';
import type { SessionInfo } from '../src/types.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

const apiMocks = vi.hoisted(() => ({
  listSharesForTarget: vi.fn(),
  createShare: vi.fn(),
}));

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    listSharesForTarget: apiMocks.listSharesForTarget,
    createShare: apiMocks.createShare,
  };
});

const messages: Record<string, string> = {
  'share.menu.shareTab': 'Share',
  'share.dialogTitle': 'Share access',
  'share.dialogSubtitle': 'Grant scoped access to {{target}}.',
  'share.target.label': 'Target',
  'share.target.currentTab': 'Current tab',
  'share.target.server': 'Whole source server',
  'share.target.serverFallback': 'This server',
  'share.role.label': 'Role',
  'share.role.viewer': 'Viewer',
  'share.role.participant': 'Participant',
  'share.role.serverMember': 'Server member',
  'share.role.serverManager': 'Server manager',
  'share.role.system': 'System',
  'share.roleHelp.viewer': 'Can view.',
  'share.roleHelp.participant': 'Can send.',
  'share.trust.title': 'Participant trust disclosure',
  'share.trust.body': 'Agents are not sandboxed.',
  'share.recipient.label': 'Recipient',
  'share.recipient.placeholder': 'User ID or email',
  'share.list.label': 'Shared users',
  'share.list.title': 'Shared users',
  'share.list.empty': 'No shared users yet',
  'share.create': 'Create share',
  'share.creating': 'Creating...',
  'share.scope.current': 'Shared scope',
  'share.indicator': '{{scope}} shared as {{role}} · {{status}}',
  'share.indicatorCompact': 'Shared as {{role}} · {{status}}',
  'share.actorLabel': '{{name}} · {{role}}',
  'share.status.active': 'Active',
  'share.status.revoked': 'Revoked',
  'share.status.expired': 'Expired',
  'share.status.target-unavailable': 'Target unavailable',
  'common.cancel': 'Cancel',
  'common.loading': 'Loading',
  'common.send': 'Send',
  'session.actions': 'Actions',
  'session.send_placeholder': 'Send to {{name}}',
  'session.send_placeholder_desktop_upload': '{{placeholder}}',
  'session.new_btn': 'New session',
  'session.pin_plain': 'Pin',
  'session.unpin_plain': 'Unpin',
  'session.restart_plain': 'Restart',
  'session.start_fresh': 'Start fresh',
  'session.rename_plain': 'Rename',
  'session.settings': 'Settings',
  'session.stop_plain': 'Stop',
  'session.clone.menu': 'Copy session',
  'session.unpin_to_stop': 'Unpin to stop',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = messages[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_alpha_brain',
    project: 'Alpha',
    role: 'brain',
    agentType: 'codex',
    state: 'idle',
    ...overrides,
  };
}

function makeQuickData() {
  return {
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    recordHistory: vi.fn(),
    addCommand: vi.fn(),
    addPhrase: vi.fn(),
    removeCommand: vi.fn(),
    removePhrase: vi.fn(),
    removeHistory: vi.fn(),
    removeSessionHistory: vi.fn(),
    clearHistory: vi.fn(),
    clearSessionHistory: vi.fn(),
  };
}

function makeWs() {
  return {
    connected: true,
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  };
}

describe('collaborative tab sharing UI', () => {
  it('formats all effective actor roles with display-safe labels', () => {
    expect(sharedActorRoleLabelKey('viewer')).toBe('share.role.viewer');
    expect(sharedActorRoleLabelKey('participant')).toBe('share.role.participant');
    expect(sharedActorRoleLabelKey('server-member')).toBe('share.role.serverMember');
    expect(sharedActorRoleLabelKey('server-manager')).toBe('share.role.serverManager');
    expect(sharedActorRoleLabelKey('system')).toBe('share.role.system');
    expect(formatSharedActorLabel(
      (key, options) => {
        const template = messages[key] ?? key;
        return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
      },
      { actorDisplayName: 'Mina Manager', effectiveActorRole: 'server-manager' },
    )).toBe('Mina Manager · Server manager');
  });

  it('discovers recipient shared entries from the recipient share list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      shares: [
        {
          id: 'share-1',
          serverId: 'srv-1',
          serverName: 'Workstation',
          role: 'viewer',
          status: 'active',
          targetLabel: 'Alpha',
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_alpha_brain' },
          createdByUserId: 'manager-secret',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const entries = await discoverSharedEntries();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shares',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'share-1',
        serverId: 'srv-1',
        serverName: 'Workstation',
        role: 'viewer',
        status: 'active',
        targetLabel: 'Alpha',
        target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_alpha_brain' },
      }),
    ]);
  });

  it('opens a recipient shared tab through the share-scoped open route', async () => {
    const target = { kind: 'main' as const, serverId: 'srv-1', sessionName: 'deck_alpha_brain' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      server: { id: 'srv-1', name: 'Workstation', status: 'online', lastHeartbeatAt: 1710000000 },
      target,
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 1700000000,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-1'],
        primaryShareId: 'share-1',
        authorizedAt: 1710000001,
      },
      sessions: [{ sessionName: 'deck_alpha_brain', title: 'Alpha', state: 'idle', agentType: 'codex' }],
      subSessions: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const opened = await openSharedEntry(target);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shares/open',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ target }),
      }),
    );
    expect(opened.coverage.effectiveRole).toBe('participant');
    expect(opened.sessions).toEqual([
      { sessionName: 'deck_alpha_brain', title: 'Alpha', state: 'idle', agentType: 'codex' },
    ]);
  });

  it('adds the manager share action only to the tab context menu', () => {
    const onShareSession = vi.fn();
    render(
      <SessionTabs
        sessions={[makeSession()]}
        activeSession="deck_alpha_brain"
        onSelect={() => {}}
        onNewSession={() => {}}
        onStopProject={() => {}}
        onRestartProject={() => {}}
        onShareSession={onShareSession}
        sessionsLoaded
        pinned={new Set()}
        setPinnedArr={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(onShareSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'deck_alpha_brain' }));
  });

  it('renders passive shared-state indicators without button semantics', () => {
    render(
      <SessionTabs
        sessions={[makeSession({ sharedState: { effectiveRole: 'viewer', status: 'active' } })]}
        activeSession="deck_alpha_brain"
        onSelect={() => {}}
        onNewSession={() => {}}
        onStopProject={() => {}}
        onRestartProject={() => {}}
        sessionsLoaded
        pinned={new Set()}
        setPinnedArr={() => {}}
      />,
    );

    const indicator = screen.getByLabelText('Shared as Viewer · Active');
    expect(indicator.getAttribute('role')).not.toBe('button');
    expect(indicator.closest('button')).toBeNull();
    expect(indicator).toHaveProperty('onclick', null);
  });

  it('renders revoked, expired, and unavailable shared-state indicators as passive states', () => {
    render(
      <SessionTabs
        sessions={[
          makeSession({
            name: 'deck_alpha_brain',
            sharedState: { effectiveRole: 'viewer', status: 'revoked', scopeLabel: 'Alpha' },
          }),
          makeSession({
            name: 'deck_beta_brain',
            project: 'Beta',
            sharedState: { effectiveRole: 'participant', status: 'expired', scopeLabel: 'Beta' },
          }),
          makeSession({
            name: 'deck_gamma_brain',
            project: 'Gamma',
            sharedState: { effectiveRole: 'viewer', status: 'target-unavailable', scopeLabel: 'Gamma' },
          }),
        ]}
        activeSession="deck_alpha_brain"
        onSelect={() => {}}
        onNewSession={() => {}}
        onStopProject={() => {}}
        onRestartProject={() => {}}
        sessionsLoaded
        pinned={new Set()}
        setPinnedArr={() => {}}
      />,
    );

    for (const label of ['Shared as Viewer · Revoked', 'Shared as Participant · Expired', 'Shared as Viewer · Target unavailable']) {
      const indicator = screen.getByLabelText(label);
      expect(indicator.getAttribute('role')).not.toBe('button');
      expect(indicator.closest('button')).toBeNull();
    }
  });

  it('disables viewer share controls and direct session actions', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as never}
        activeSession={makeSession({
          runtimeType: 'transport',
          sharedState: { effectiveRole: 'viewer', status: 'active', scopeLabel: 'Alpha' },
        })}
        connected
        quickData={makeQuickData()}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Message input' });
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('Actions') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the latest observed dispatch id when a shared participant cancels a transport turn', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as never}
        activeSession={makeSession({
          runtimeType: 'transport',
          state: 'running',
          sharedState: {
            effectiveRole: 'participant',
            status: 'active',
            scopeLabel: 'Alpha',
            activeDispatchId: 'dispatch-123',
          },
        })}
        connected
        quickData={makeQuickData()}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Message input' });
    input.textContent = '/stop';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(ws.sendSessionCommandUrgent).toHaveBeenCalledWith('cancel', expect.objectContaining({
      sessionName: 'deck_alpha_brain',
      observedDispatchId: 'dispatch-123',
    }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('lets managers choose server or current-tab target and discloses participant trust', async () => {
    apiMocks.listSharesForTarget.mockResolvedValue([]);
    apiMocks.createShare.mockResolvedValue({
      id: 'share-1',
      targetUserId: 'user@example.test',
      targetUserDisplayName: 'User Example',
      role: 'participant',
      status: 'active',
    });

    render(
      <ShareSessionDialog
        target={{
          serverId: 'srv-1',
          serverLabel: 'Workstation',
          sessionName: 'deck_alpha_brain',
          tabLabel: 'Alpha',
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Participant'));
    expect(screen.getByText('Participant trust disclosure')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Whole source server'));
    fireEvent.input(screen.getByLabelText('Recipient'), { target: { value: 'user@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create share' }));

    await waitFor(() => expect(apiMocks.createShare).toHaveBeenCalledTimes(1));
    expect(apiMocks.createShare).toHaveBeenCalledWith('srv-1', {
      target: { kind: 'server', serverId: 'srv-1' },
      targetUser: 'user@example.test',
      role: 'participant',
    });
    expect(await screen.findByText('User Example')).not.toBeNull();
    expect(screen.queryByText('user@example.test')).toBeNull();
    expect(screen.queryByText('share-1')).toBeNull();
  });

  it('keeps the send-adjacent share menu wired to active sub-session context', () => {
    const source = readFileSync(join(WEB_ROOT, 'src/components/SessionControls.tsx'), 'utf8');
    expect(source).toContain("t('share.menu.shareTab')");
    expect(source).toContain('onShareSession(activeSession, subSessionId ?? null)');
  });
});
