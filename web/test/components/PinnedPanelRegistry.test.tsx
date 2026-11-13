/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { afterEach } from 'vitest';
import { FS_SESSION_ROOT_PATH } from '../../../src/shared/transport/fs.js';

const fileBrowserProps: any[] = [];
const cronManagerProps: any[] = [];
const repoPageProps: any[] = [];
const localWebPreviewProps: any[] = [];
const sharedContextManagementProps: any[] = [];
const sharedContextDiagnosticsProps: any[] = [];

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: (props: any) => {
    fileBrowserProps.push(props);
    return (
      <button
        data-testid="mock-file-browser"
        data-initial-path={props.initialPath}
        data-changes-root={props.changesRootPath ?? ''}
        onClick={() => props.onPreviewFile?.({ path: `${props.initialPath}/src/app.ts`, preferDiff: false })}
      >
        file browser
      </button>
    );
  },
}));
vi.mock('../../src/components/ChatView.js', () => ({ ChatView: () => null }));
vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: () => null }));
vi.mock('../../src/pages/RepoPage.js', () => ({
  RepoPage: (props: any) => {
    repoPageProps.push(props);
    return <div data-testid="mock-repo-page" />;
  },
}));
vi.mock('../../src/pages/CronManager.js', () => ({
  CronManager: (props: any) => {
    cronManagerProps.push(props);
    return <div data-testid="mock-cron-manager" />;
  },
}));
vi.mock('../../src/components/LocalWebPreviewPanel.js', () => ({
  LocalWebPreviewPanel: (props: any) => {
    localWebPreviewProps.push(props);
    return <div data-testid="mock-local-web-preview" />;
  },
}));
vi.mock('../../src/components/SharedContextManagementPanel.js', () => ({
  SharedContextManagementPanel: (props: any) => {
    sharedContextManagementProps.push(props);
    return <div data-testid="mock-shared-context-management" />;
  },
}));
vi.mock('../../src/components/ContextDiagnosticsPanel.js', () => ({
  ContextDiagnosticsPanel: (props: any) => {
    sharedContextDiagnosticsProps.push(props);
    return <div data-testid="mock-shared-context-diagnostics" />;
  },
}));
vi.mock('../../src/components/UsageFooter.js', () => ({ UsageFooter: () => null }));
vi.mock('../../src/hooks/useTimeline.js', () => ({ useTimeline: () => ({ events: [], refreshing: false, historyStatus: 'idle' }) }));
vi.mock('../../src/hooks/useNowTicker.js', () => ({ useNowTicker: () => Date.now() }));
vi.mock('../../src/usage-data.js', () => ({ extractLatestUsage: () => null }));
vi.mock('../../src/thinking-utils.js', () => ({
  getActiveThinkingTs: () => null,
  getActiveStatusText: () => null,
  getTailSessionState: () => null,
  hasActiveToolCall: () => false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import {
  LOCAL_WEB_PREVIEW_PANEL_TYPE,
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE,
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE,
} from '../../src/components/pinnedPanelTypes.js';
import { renderPanelContent } from '../../src/components/PinnedPanelRegistry.js';

afterEach(() => {
  cleanup();
  fileBrowserProps.length = 0;
  cronManagerProps.length = 0;
  repoPageProps.length = 0;
  localWebPreviewProps.length = 0;
  sharedContextManagementProps.length = 0;
  sharedContextDiagnosticsProps.length = 0;
});

describe('pinned cron manager panel', () => {
  it('forwards the active websocket so backend cron changes refresh immediately', () => {
    const ws = { onMessage: vi.fn() } as any;
    render(
      <>{renderPanelContent(
        { id: 'cronmanager:srv:project', type: 'cronmanager', props: { projectName: 'project' } },
        {
          ws,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeSession: 'deck_project_brain',
          sessions: [{
            name: 'deck_project_brain', project: 'project', role: 'main', agentType: 'codex', state: 'idle',
          }],
          t: (key: string) => key,
        },
      )}</>,
    );

    expect(screen.getByTestId('mock-cron-manager')).toBeTruthy();
    expect(cronManagerProps).toHaveLength(1);
    expect(cronManagerProps[0].ws).toBe(ws);
    expect(cronManagerProps[0].portalSubPanels).toBe(true);
  });

  it('keeps a whole-server shared Cron panel unscoped to the active session', () => {
    render(
      <>{renderPanelContent(
        { id: 'cronmanager:shared-server', type: 'cronmanager', props: { projectName: 'project' } },
        {
          ws: {} as any,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeSession: 'deck_project_brain',
          sharedAccessRole: 'participant',
          shareTargetKind: 'server',
          sessions: [{
            name: 'deck_project_brain', project: 'project', role: 'main', agentType: 'codex', state: 'idle',
          }],
          t: (key: string) => key,
        },
      )}</>,
    );

    expect(cronManagerProps[0]).toMatchObject({
      sharedSessionName: undefined,
      sharedScope: true,
      readOnly: false,
    });
  });
});

describe('pinned file browser panel', () => {
  it('keeps Changes tab data and forwards rootPath to floating preview requests', () => {
    const onPreviewFile = vi.fn();
    render(
      <>{renderPanelContent(
        { id: 'filebrowser:srv:/repo', type: 'filebrowser', props: { projectDir: '/captured' } },
        {
          ws: {} as any,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeProjectDir: '/repo',
          activeSession: 'deck_repo_brain',
          inputRefsMap: { current: new Map() },
          onPreviewFile,
          t: (key: string) => key,
        },
      )}</>,
    );

    const browser = screen.getByTestId('mock-file-browser');
    expect(browser.getAttribute('data-initial-path')).toBe('/repo');
    expect(browser.getAttribute('data-changes-root')).toBe('/repo');

    fireEvent.click(browser);
    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/repo/src/app.ts',
      preferDiff: false,
      rootPath: '/repo',
    });
  });

  it('uses the virtual root and read-only mode for a shared viewer without exposing a host path', () => {
    render(
      <>{renderPanelContent(
        { id: 'filebrowser:shared', type: 'filebrowser', props: { projectDir: '/stale/owner/path' } },
        {
          ws: {} as any,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeSession: 'deck_shared_brain',
          sharedAccessRole: 'viewer',
          inputRefsMap: { current: new Map() },
          t: (key: string) => key,
        },
      )}</>,
    );

    expect(fileBrowserProps[0]).toMatchObject({
      initialPath: FS_SESSION_ROOT_PATH,
      changesRootPath: FS_SESSION_ROOT_PATH,
      sessionName: 'deck_shared_brain',
      scopeToSessionRoot: true,
      readOnly: true,
    });
  });

  it('allows full machine file browsing and write mode for a shared server participant', () => {
    fileBrowserProps.length = 0;
    render(
      <>{renderPanelContent(
        { id: 'filebrowser:shared-server', type: 'filebrowser', props: { projectDir: '/home/user/project' } },
        {
          ws: {} as any,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeSession: 'deck_shared_brain',
          activeProjectDir: '/home/user/project',
          sharedAccessRole: 'participant',
          shareTargetKind: 'server',
          inputRefsMap: { current: new Map() },
          t: (key: string) => key,
        },
      )}</>,
    );

    expect(fileBrowserProps[0]).toMatchObject({
      initialPath: '/home/user/project',
      changesRootPath: '/home/user/project',
      sessionName: 'deck_shared_brain',
      scopeToSessionRoot: false,
      readOnly: false,
    });
  });
});

describe('pinned repository panel', () => {
  it('opens a shared repository from the virtual root even when no project path is visible', () => {
    render(
      <>{renderPanelContent(
        { id: 'repopage:shared', type: 'repopage', props: {} },
        {
          ws: {} as any,
          connected: true,
          serverId: 'srv',
          subSessions: [],
          activeSession: 'deck_shared_brain',
          sharedAccessRole: 'participant',
          t: (key: string) => key,
        },
      )}</>,
    );

    expect(screen.getByTestId('mock-repo-page')).toBeTruthy();
    expect(repoPageProps[0]).toMatchObject({
      projectDir: FS_SESSION_ROOT_PATH,
      sessionId: 'deck_shared_brain',
      scopeToSessionRoot: true,
      readOnly: false,
    });
  });
});

describe('pinned panel server-switch isolation', () => {
  const srv1Session = {
    name: 'deck_srv1_brain',
    project: 'srv1_app',
    role: 'main' as const,
    agentType: 'codex',
    state: 'idle',
    projectDir: '/srv1/app',
  };
  const srv2Session = {
    name: 'deck_srv2_brain',
    project: 'srv2_app',
    role: 'main' as const,
    agentType: 'codex',
    state: 'idle',
    projectDir: '/srv2/app',
  };

  function makeCtx(overrides: Partial<Parameters<typeof renderPanelContent>[1]> = {}): Parameters<typeof renderPanelContent>[1] {
    return {
      ws: {} as any,
      connected: true,
      serverId: 'srv-2',
      subSessions: [],
      activeSession: null,
      sessions: [],
      sessionsLoading: false,
      t: (key: string) => key,
      ...overrides,
    };
  }

  it('holds follow-current panels on loading placeholder while target server sessions are pending', () => {
    const panels = [
      { id: 'filebrowser', type: 'filebrowser', props: { serverId: 'srv-1', projectDir: '/srv1/app', changesRootPath: '/srv1/app' } },
      { id: 'repo-alias', type: 'repo', props: { serverId: 'srv-1', projectDir: '/srv1/app' } },
      { id: 'repopage', type: 'repopage', props: { serverId: 'srv-1', projectDir: '/srv1/app', sessionName: 'deck_srv1_brain' } },
      { id: 'cronmanager', type: 'cronmanager', props: { serverId: 'srv-1', projectName: 'srv1_app' } },
    ];

    for (const panel of panels) {
      cleanup();
      render(<>{renderPanelContent(panel, makeCtx({ serverId: 'srv-2', sessionsLoading: true }))}</>);
      expect(screen.getByText('common.loading')).toBeTruthy();
    }

    expect(fileBrowserProps).toHaveLength(0);
    expect(repoPageProps).toHaveLength(0);
    expect(cronManagerProps).toHaveLength(0);
  });

  it('never falls back to srv-1 captured props when srv-2 finishes loading with zero sessions (serverId-tagged and legacy pins)', () => {
    const taggedAndLegacyPins = [
      { id: 'fb-tagged', type: 'filebrowser', props: { serverId: 'srv-1', projectDir: '/srv1/app', changesRootPath: '/srv1/app' } },
      { id: 'fb-legacy', type: 'filebrowser', props: { projectDir: '/srv1/app', changesRootPath: '/srv1/app' } },
      { id: 'repo-tagged', type: 'repo', props: { serverId: 'srv-1', projectDir: '/srv1/app' } },
      { id: 'rp-tagged', type: 'repopage', props: { serverId: 'srv-1', projectDir: '/srv1/app', sessionName: 'deck_srv1_brain' } },
      { id: 'rp-legacy', type: 'repopage', props: { projectDir: '/srv1/app', sessionName: 'deck_srv1_brain' } },
      { id: 'cron-tagged', type: 'cronmanager', props: { serverId: 'srv-1', projectName: 'srv1_app' } },
      { id: 'cron-legacy', type: 'cronmanager', props: { projectName: 'srv1_app' } },
    ];

    for (const panel of taggedAndLegacyPins) {
      cleanup();
      render(<>{renderPanelContent(panel, makeCtx({ serverId: 'srv-2', sessions: [], sessionsLoading: false }))}</>);
      if (panel.type === 'cronmanager') {
        expect(screen.getByText('No project')).toBeTruthy();
      } else {
        expect(screen.getByText('No project dir')).toBeTruthy();
      }
    }

    expect(fileBrowserProps).toHaveLength(0);
    expect(repoPageProps).toHaveLength(0);
    expect(cronManagerProps).toHaveLength(0);
  });

  it('rebinds follow-current panels to srv-2 once hydrated and restores srv-1 on switch back', () => {
    const panels = [
      { id: 'fb', type: 'filebrowser', props: { serverId: 'srv-1', projectDir: '/srv1/app', changesRootPath: '/srv1/app' } },
      { id: 'repo', type: 'repo', props: { serverId: 'srv-1', projectDir: '/srv1/app' } },
      { id: 'rp', type: 'repopage', props: { serverId: 'srv-1', projectDir: '/srv1/app', sessionName: 'deck_srv1_brain' } },
      { id: 'cron', type: 'cronmanager', props: { serverId: 'srv-1', projectName: 'srv1_app' } },
    ];

    for (const panel of panels) {
      cleanup();
      render(
        <>{renderPanelContent(panel, makeCtx({
          serverId: 'srv-2',
          activeSession: 'deck_srv2_brain',
          activeProjectDir: '/srv2/app',
          sessions: [srv2Session],
        }))}</>,
      );
    }

    expect(fileBrowserProps).toHaveLength(2);
    expect(fileBrowserProps[0]).toMatchObject({ initialPath: '/srv2/app', changesRootPath: '/srv2/app' });
    expect(fileBrowserProps[1]).toMatchObject({ initialPath: '/srv2/app' });
    expect(repoPageProps).toHaveLength(1);
    expect(repoPageProps[0]).toMatchObject({ projectDir: '/srv2/app', sessionId: 'deck_srv2_brain' });
    expect(cronManagerProps).toHaveLength(1);
    expect(cronManagerProps[0]).toMatchObject({ projectName: 'srv2_app' });

    fileBrowserProps.length = 0;
    repoPageProps.length = 0;
    cronManagerProps.length = 0;

    for (const panel of panels) {
      cleanup();
      render(
        <>{renderPanelContent(panel, makeCtx({
          serverId: 'srv-1',
          activeSession: 'deck_srv1_brain',
          activeProjectDir: '/srv1/app',
          sessions: [srv1Session],
        }))}</>,
      );
    }

    expect(fileBrowserProps[0]).toMatchObject({ initialPath: '/srv1/app', changesRootPath: '/srv1/app' });
    expect(repoPageProps[0]).toMatchObject({ projectDir: '/srv1/app', sessionId: 'deck_srv1_brain' });
    expect(cronManagerProps[0]).toMatchObject({ projectName: 'srv1_app' });
  });

  it('isolates server-bound local-web-preview and shared-context pinned panels across servers', () => {
    const boundPanels = [
      {
        id: 'preview-1',
        type: LOCAL_WEB_PREVIEW_PANEL_TYPE,
        props: { serverId: 'srv-1', port: '3000', path: '/app' },
      },
      {
        id: 'sc-mgmt-1',
        type: SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE,
        props: { serverId: 'srv-1', enterpriseId: 'ent-1', canonicalRepoId: 'repo-1', workspaceId: 'ws-1' },
      },
      {
        id: 'sc-diag-1',
        type: SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE,
        props: { serverId: 'srv-1', enterpriseId: 'ent-1', canonicalRepoId: 'repo-1', workspaceId: 'ws-1' },
      },
    ];

    for (const panel of boundPanels) {
      cleanup();
      render(<>{renderPanelContent(panel, makeCtx({ serverId: 'srv-2', activeSession: 'deck_srv2_brain', activeProjectDir: '/srv2/app', sessions: [srv2Session] }))}</>);
    }

    expect(localWebPreviewProps).toHaveLength(0);
    expect(sharedContextManagementProps).toHaveLength(0);
    expect(sharedContextDiagnosticsProps).toHaveLength(0);

    for (const panel of boundPanels) {
      cleanup();
      render(<>{renderPanelContent(panel, makeCtx({ serverId: 'srv-1', activeSession: 'deck_srv1_brain', activeProjectDir: '/srv1/app', sessions: [srv1Session] }))}</>);
    }

    expect(localWebPreviewProps).toHaveLength(1);
    expect(localWebPreviewProps[0]).toMatchObject({ serverId: 'srv-1', port: '3000', path: '/app' });
    expect(sharedContextManagementProps).toHaveLength(1);
    expect(sharedContextManagementProps[0]).toMatchObject({ enterpriseId: 'ent-1', serverId: 'srv-1', activeProjectDir: '/srv1/app' });
    expect(sharedContextDiagnosticsProps).toHaveLength(1);
    expect(sharedContextDiagnosticsProps[0]).toMatchObject({ enterpriseId: 'ent-1', canonicalRepoId: 'repo-1', workspaceId: 'ws-1' });
  });
});
