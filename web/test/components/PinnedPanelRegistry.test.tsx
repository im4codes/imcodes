/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { afterEach } from 'vitest';

const fileBrowserProps: any[] = [];

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
vi.mock('../../src/pages/RepoPage.js', () => ({ RepoPage: () => null }));
vi.mock('../../src/pages/CronManager.js', () => ({ CronManager: () => null }));
vi.mock('../../src/components/LocalWebPreviewPanel.js', () => ({ LocalWebPreviewPanel: () => null }));
vi.mock('../../src/components/SharedContextManagementPanel.js', () => ({ SharedContextManagementPanel: () => null }));
vi.mock('../../src/components/ContextDiagnosticsPanel.js', () => ({ ContextDiagnosticsPanel: () => null }));
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

import '../../src/components/pinnedPanelTypes.js';
import { renderPanelContent } from '../../src/components/PinnedPanelRegistry.js';

afterEach(() => {
  cleanup();
  fileBrowserProps.length = 0;
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
});
