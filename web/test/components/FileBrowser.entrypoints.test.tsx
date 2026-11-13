/**
 * @vitest-environment jsdom
 *
 * Integration tests verifying real FileBrowser + real DocShareDialog entrypoints
 * across mobile SessionControls overlay, SubSessionWindow (mobile & desktop),
 * and pinned filebrowser panels (PinnedPanelRegistry / pinnedPanelTypes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/FileEditor.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/file-editor-lazy.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/FilePreviewPane.js', () => ({
  default: () => null,
}));
vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));
vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: () => null,
}));
vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
}));
vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));
vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: [],
    refreshing: false,
    addOptimisticUserMessage: vi.fn(),
    markOptimisticFailed: vi.fn(),
    retryOptimisticMessage: vi.fn(),
    loadingOlder: false,
    hasOlderHistory: false,
    loadOlderEvents: vi.fn(),
  }),
}));
vi.mock('../../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: () => null,
  useQuickData: () => ({
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
  }),
}));
vi.mock('../../src/git-status-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git-status-store.js')>();
  return {
    ...actual,
    useSharedGitChanges: () => [],
  };
});

import * as api from '../../src/api.js';
import { SessionControls } from '../../src/components/SessionControls.js';
import { SubSessionWindow } from '../../src/components/SubSessionWindow.js';
import { getPanelType } from '../../src/components/PinnedPanelRegistry.js';
import '../../src/components/pinnedPanelTypes.js';
import { NodeGroupsNavContext } from '../../src/components/node-groups-nav.js';
import { __resetFileBrowserSharedChangesForTests } from '../../src/components/FileBrowser.js';
import type { ServerMessage } from '../../src/ws-client.js';
import type { SessionInfo } from '../../src/types.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeWs() {
  const listeners = new Set<(msg: ServerMessage) => void>();
  return {
    connected: true,
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    sendSessionMessage: vi.fn(),
    sendInput: vi.fn(),
    requestSessionList: vi.fn(),
    subscribeTransportSession: vi.fn(),
    unsubscribeTransportSession: vi.fn(),
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    sendSnapshotRequest: vi.fn(),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    getDaemonCapabilitySnapshot: vi.fn(() => null),
    isDaemonCapabilityStale: vi.fn(() => false),
    onMessage: vi.fn((fn: (msg: ServerMessage) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }),
    fsListDir: vi.fn((path: string) => {
      const requestId = `req-${Math.random().toString(36).slice(2)}`;
      queueMicrotask(() => {
        for (const fn of listeners) {
          fn({
            type: 'fs.ls_response',
            requestId,
            path,
            status: 'ok',
            entries: [{ name: 'spec.docx', isDir: false, size: 128 }],
          } as unknown as ServerMessage);
        }
      });
      return requestId;
    }),
    fsReadFile: vi.fn(() => 'read-req'),
    fsGitStatus: vi.fn(() => 'git-status-req'),
    fsGitDiff: vi.fn(() => 'git-diff-req'),
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

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_alpha_brain',
    project: 'alpha',
    role: 'brain',
    agentType: 'claude-code',
    state: 'idle',
    projectDir: '/home/user/proj',
    ...overrides,
  } as SessionInfo;
}

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-fb-1',
    serverId: 'srv-1',
    type: 'claude-code-sdk',
    runtimeType: 'transport',
    shellBin: null,
    cwd: '/home/user/sub',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_alpha_brain',
    label: 'worker',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-fb-1',
    state: 'idle',
    ...overrides,
  } as SubSession;
}

describe('FileBrowser + DocShareDialog Manage Node Groups entrypoints (F2)', () => {
  let listSharesSpy: ReturnType<typeof vi.spyOn>;
  const originalUA = navigator.userAgent;

  beforeEach(() => {
    __resetFileBrowserSharedChangesForTests();
    listSharesSpy = vi.spyOn(api, 'listDocumentShares').mockResolvedValue({ shares: [], groups: [] });
  });

  afterEach(() => {
    cleanup();
    listSharesSpy.mockRestore();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUA });
    vi.restoreAllMocks();
  });

  it('mobile SessionControls overlay opens real DocShareDialog and closes mobile overlay when Manage Node Groups is clicked', async () => {
    const openNodeGroups = vi.fn();
    const onMobileClose = vi.fn();
    const ws = makeWs();

    render(
      <NodeGroupsNavContext.Provider value={openNodeGroups}>
        <SessionControls
          ws={ws as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
          mobileFileBrowserOpen={true}
          onMobileFileBrowserClose={onMobileClose}
        />
      </NodeGroupsNavContext.Provider>,
    );

    const shareBtn = await screen.findByTestId('fb-toolbar-share-btn');
    fireEvent.click(shareBtn);

    expect(await screen.findByTestId('doc-share-dialog')).toBeTruthy();
    expect(await screen.findByTestId('doc-share-no-groups-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('doc-share-open-node-groups-btn'));
    expect(onMobileClose).toHaveBeenCalledTimes(1);
    expect(openNodeGroups).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('doc-share-dialog')).toBeNull());
  });

  it('mobile SubSessionWindow closes its fullscreen file overlay and navigates to Manage Node Groups', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    const openNodeGroups = vi.fn();
    const ws = makeWs();

    const { container } = render(
      <NodeGroupsNavContext.Provider value={openNodeGroups}>
        <SubSessionWindow
          sub={makeSubSession()}
          ws={ws as any}
          connected={true}
          active={true}
          serverId="srv-1"
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          onMinimize={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          onRename={vi.fn()}
          zIndex={6000}
          onFocus={vi.fn()}
        />
      </NodeGroupsNavContext.Provider>,
    );

    const toggleBtn = container.querySelector('button[title="picker.files"]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    fireEvent.click(toggleBtn);

    await waitFor(() => expect(document.body.querySelector('.mobile-fb-overlay')).toBeTruthy());

    const shareBtn = await screen.findByTestId('fb-toolbar-share-btn');
    fireEvent.click(shareBtn);

    expect(await screen.findByTestId('doc-share-no-groups-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('doc-share-open-node-groups-btn'));

    expect(openNodeGroups).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.body.querySelector('.mobile-fb-overlay')).toBeNull());
  });

  it('desktop SubSessionWindow floating FileBrowser triggers Manage Node Groups via NodeGroupsNavContext', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64)' });
    const openNodeGroups = vi.fn();
    const ws = makeWs();

    const { container } = render(
      <NodeGroupsNavContext.Provider value={openNodeGroups}>
        <SubSessionWindow
          sub={makeSubSession()}
          ws={ws as any}
          connected={true}
          active={true}
          serverId="srv-1"
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          onMinimize={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          onRename={vi.fn()}
          zIndex={6000}
          onFocus={vi.fn()}
        />
      </NodeGroupsNavContext.Provider>,
    );

    const toggleBtn = container.querySelector('button[title="picker.files"]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    fireEvent.click(toggleBtn);

    const shareBtn = await screen.findByTestId('fb-toolbar-share-btn');
    fireEvent.click(shareBtn);
    expect(await screen.findByTestId('doc-share-no-groups-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('doc-share-open-node-groups-btn'));
    expect(openNodeGroups).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('doc-share-dialog')).toBeNull());
  });

  it('pinned filebrowser panel forwards ctx.onOpenNodeGroups into real FileBrowser and DocShareDialog', async () => {
    const reg = getPanelType('filebrowser');
    expect(reg).toBeTruthy();
    const openNodeGroups = vi.fn();
    const ws = makeWs();

    render(
      h('div', null, reg!.render(
        { id: 'pin-fb-1', type: 'filebrowser', props: { serverId: 'srv-1', projectDir: '/home/user/proj' } } as any,
        {
          ws: ws as any,
          serverId: 'srv-1',
          connected: true,
          sessionsLoading: false,
          activeSession: 'deck_alpha_brain',
          activeProjectDir: '/home/user/proj',
          t: (k: string) => k,
          onOpenNodeGroups: openNodeGroups,
        } as any,
      )),
    );

    const shareBtn = await screen.findByTestId('fb-toolbar-share-btn');
    fireEvent.click(shareBtn);
    expect(await screen.findByTestId('doc-share-no-groups-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('doc-share-open-node-groups-btn'));
    expect(openNodeGroups).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('doc-share-dialog')).toBeNull());
  });
});
