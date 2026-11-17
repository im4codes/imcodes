/**
 * @vitest-environment jsdom
 *
 * Tests for the quick-search input embedded in FileBrowser's `.fb-nav` bar.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, act, cleanup } from '@testing-library/preact';
import { FILE_BROWSER_FILTER_DEBOUNCE_MS } from '@shared/file-browser-sort.js';

vi.mock('../../src/components/FileEditor.js', () => ({ FileEditor: () => null, FileEditorContent: () => null }));
vi.mock('../../src/components/file-editor-lazy.js', () => ({ FileEditor: () => null, FileEditorContent: () => null }));
vi.mock('../../src/components/FilePreviewPane.js', () => ({ default: () => null }));
vi.mock('../../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api.js')>();
  return {
    ...actual,
    listDocsSharedWithMe: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('../../src/direct-file-transfer.js', () => ({
  FILE_DOWNLOAD_TRANSPORT_MODE: { CONNECTING: 'connecting', DIRECT: 'direct', FALLING_BACK: 'falling_back', HTTP: 'http', BROWSER: 'browser' },
  downloadPreviewWithDirectFallback: vi.fn().mockResolvedValue(undefined),
  prewarmDirectFileLease: vi.fn(() => undefined),
  selectPreviewDownloadDestination: vi.fn().mockResolvedValue(null),
  isDirectFileTransferStaleHandleError: vi.fn(() => false),
  isFileUploadCanceled: vi.fn(() => false),
}));
vi.mock('react-i18next', () => {
  const t = (key: string, opts?: Record<string, unknown> | string) => {
    if (typeof opts === 'string') return key;
    return opts ? `${key}|${JSON.stringify(opts)}` : key;
  };
  const translation = { t };
  return { useTranslation: () => translation };
});

import { FileBrowser } from '../../src/components/FileBrowser.js';
import type { WsClient, ServerMessage } from '../../src/ws-client.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeWs(opts: { connected?: boolean } = {}) {
  const handlers = new Set<(msg: ServerMessage) => void>();
  let lsCounter = 0;
  let readCounter = 0;
  const sent: Array<Record<string, unknown>> = [];
  const lsCalls: Array<{ requestId: string; path: string }> = [];
  const readCalls: Array<{ requestId: string; path: string; sessionName?: string }> = [];

  const ws = {
    connected: opts.connected ?? true,
    onMessage: (handler: (msg: ServerMessage) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    send: vi.fn((msg: Record<string, unknown>) => { sent.push(msg); }),
    fsListDir: vi.fn((path: string) => {
      lsCounter += 1;
      const requestId = `ls-${lsCounter}`;
      lsCalls.push({ requestId, path });
      return requestId;
    }),
    fsGitStatus: vi.fn(() => 'git-1'),
    fsReadFile: vi.fn((path: string, sessionName?: string) => {
      readCounter += 1;
      const requestId = `read-${readCounter}`;
      readCalls.push({ requestId, path, sessionName });
      return requestId;
    }),
    fsGitDiff: vi.fn(() => 'diff-1'),
    forgetOwnedDataRequest: vi.fn(),
  } as unknown as WsClient;

  const emit = (msg: Record<string, unknown>) => {
    act(() => {
      for (const handler of handlers) handler(msg as unknown as ServerMessage);
    });
  };

  const respondLs = (
    requestId: string,
    entries: Array<{ name: string; isDir: boolean }>,
    resolvedPath = '/proj',
  ) => {
    emit({
      type: 'fs.ls_response',
      requestId,
      path: resolvedPath,
      resolvedPath,
      status: 'ok',
      entries: entries.map((e) => ({ ...e, hidden: e.name.startsWith('.') })),
    });
  };

  const searchRequests = () => sent.filter((m) => m.type === 'file.search');

  return { ws, sent, lsCalls, readCalls, emit, respondLs, searchRequests };
}

describe('FileBrowser nav quick search', () => {
  it('renders search input in !listView and hides it in listView or shared docs view', async () => {
    const h1 = makeWs();
    const normal = render(
      <FileBrowser ws={h1.ws} mode="file-single" layout="panel" initialPath="/proj" serverId="srv-1" />,
    );
    expect(normal.getByTestId('fb-nav-search-input')).toBeTruthy();
    expect(normal.container.querySelector('.fb-nav-spacer')).toBeNull();

    // Toggling Shared Docs hides .fb-nav-search and restores .fb-nav-spacer
    await act(async () => {
      fireEvent.click(normal.getByTestId('fb-toolbar-shared-docs-btn'));
    });
    expect(normal.queryByTestId('fb-nav-search-input')).toBeNull();
    expect(normal.container.querySelector('.fb-nav-spacer')).toBeTruthy();

    cleanup();

    const h2 = makeWs();
    const listView = render(
      <FileBrowser ws={h2.ws} mode="file-single" layout="panel" initialPath="/proj" listView />,
    );
    expect(listView.queryByTestId('fb-nav-search-input')).toBeNull();
    expect(listView.container.querySelector('.fb-nav-spacer')).toBeTruthy();
  });

  it('debounces file.search, passes scoped sessionName, suppresses IME, stops keydown propagation, and ignores stale/post-clear responses', () => {
    vi.useFakeTimers();
    const harness = makeWs();
    const outerKeyDown = vi.fn();
    const view = render(
      <div onKeyDown={outerKeyDown}>
        <FileBrowser
          ws={harness.ws}
          mode="file-single"
          layout="panel"
          initialPath="/proj"
          sessionName="sess_1"
          scopeToSessionRoot
        />
      </div>,
    );
    harness.respondLs(harness.lsCalls[0].requestId, [{ name: 'src', isDir: true }], '/proj');

    const input = view.getByTestId('fb-nav-search-input') as HTMLInputElement;

    // Keydown propagation is stopped so host container hotkeys don't fire
    fireEvent.keyDown(input, { key: 'a' });
    expect(outerKeyDown).not.toHaveBeenCalled();

    // IME composition should suppress search dispatch until compositionend
    act(() => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    fireEvent.input(input, { target: { value: 'ind' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS + 50); });
    expect(harness.searchRequests()).toHaveLength(0);

    fireEvent.input(input, { target: { value: 'index' } });
    act(() => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    expect(harness.searchRequests()).toHaveLength(1);
    const firstReq = harness.searchRequests()[0];
    expect(firstReq).toMatchObject({
      type: 'file.search',
      query: 'index',
      projectDir: '/proj',
      sessionName: 'sess_1',
    });

    // Second search supersedes the first requestId
    fireEvent.input(input, { target: { value: 'main' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    expect(harness.searchRequests()).toHaveLength(2);
    const secondReq = harness.searchRequests()[1];

    // Late response for first requestId is ignored
    harness.emit({
      type: 'file.search_response',
      requestId: firstReq.requestId,
      results: ['stale.ts'],
    });
    expect(view.queryByText('stale.ts')).toBeNull();

    // Active response renders
    harness.emit({
      type: 'file.search_response',
      requestId: secondReq.requestId,
      results: ['src/main.ts'],
    });
    expect(view.getByText('main.ts')).toBeTruthy();
    expect(view.getByText('src')).toBeTruthy();

    // Escape clears search & restores tree
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(view.queryByText('main.ts')).toBeNull();
    expect(view.getByText('src')).toBeTruthy();

    // Post-clear response is discarded even if matching earlier requestId
    fireEvent.input(input, { target: { value: 'ghost' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    const thirdReq = harness.searchRequests()[2];
    fireEvent.click(view.getByTestId('fb-nav-search-clear'));
    harness.emit({
      type: 'file.search_response',
      requestId: thirdReq.requestId,
      results: ['ghost.ts'],
    });
    expect(view.queryByText('ghost.ts')).toBeNull();
  });

  it('preserves search and checkboxes when previewing remote files in file-multi and file-single, and supports git badges', () => {
    vi.useFakeTimers();
    const harness = makeWs();
    const onConfirm = vi.fn();
    const view = render(
      <FileBrowser
        ws={harness.ws}
        mode="file-multi"
        layout="panel"
        initialPath="/proj"
        onConfirm={onConfirm}
      />,
    );
    harness.respondLs(harness.lsCalls[0].requestId, [{ name: 'src', isDir: true }], '/proj');
    harness.emit({
      type: 'fs.git_status_response',
      requestId: 'git-1',
      status: 'ok',
      files: [{ path: '/proj/src/deep/app.ts', code: 'M' }],
    });

    const input = view.getByTestId('fb-nav-search-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'app' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    const req = harness.searchRequests()[0];
    harness.emit({
      type: 'file.search_response',
      requestId: req.requestId,
      results: ['src/deep/app.ts', 'src/deep/util.ts'],
    });

    // Git badge renders on matching searched file
    expect(view.getByTitle('git: M')).toBeTruthy();

    // Click row to preview unexpanded subdir file -> preserves search results and does not re-root tree
    fireEvent.click(view.getByText('app.ts'));
    expect(harness.readCalls.some((c) => c.path === '/proj/src/deep/app.ts')).toBe(true);
    expect(view.getByText('util.ts')).toBeTruthy();
    expect(input.value).toBe('app');

    // Toggle checkboxes in file-multi without losing search results
    const checkboxes = view.container.querySelectorAll('.fb-search-item input.fb-node-check');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    expect(view.getByText('util.ts')).toBeTruthy();

    fireEvent.click(view.container.querySelector('.fb-footer .btn-primary')!);
    expect(onConfirm).toHaveBeenCalledWith(['/proj/src/deep/app.ts', '/proj/src/deep/util.ts']);
  });

  it('filters dir-only and showHidden, joins Windows paths, navigates on dir click, and falls back offline', () => {
    vi.useFakeTimers();
    const harness = makeWs();
    const view = render(
      <FileBrowser
        ws={harness.ws}
        mode="dir-only"
        layout="panel"
        initialPath="C:\\proj"
      />,
    );
    harness.respondLs(harness.lsCalls[0].requestId, [{ name: 'packages', isDir: true }], 'C:\\proj');

    // Toggle hidden files off via UI checkbox
    const hiddenCheckbox = view.container.querySelector('.fb-nav-hidden-toggle input') as HTMLInputElement;
    if (hiddenCheckbox.checked) fireEvent.click(hiddenCheckbox);
    harness.respondLs(harness.lsCalls[1].requestId, [{ name: 'packages', isDir: true }], 'C:\\proj');

    const input = view.getByTestId('fb-nav-search-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'pkg' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    const req = harness.searchRequests()[0];
    expect(req.projectDir).toBe('C:\\proj');

    harness.emit({
      type: 'file.search_response',
      requestId: req.requestId,
      results: ['packages/core/', 'packages/core/index.ts', '.git/objects/'],
    });

    // File excluded in dir-only, hidden dir excluded when showHidden=false
    expect(view.getByText('core')).toBeTruthy();
    expect(view.getByText('packages')).toBeTruthy();
    expect(view.queryByText('index.ts')).toBeNull();
    expect(view.queryByText('objects')).toBeNull();

    // Clicking searched directory clears search and navigates into Windows joined path
    fireEvent.click(view.getByText('core'));
    expect(input.value).toBe('');
    expect(harness.lsCalls.some((c) => c.path === 'C:\\proj\\packages\\core')).toBe(true);

    // Search empty state
    fireEvent.input(input, { target: { value: 'nomatch' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    const emptyReq = harness.searchRequests()[1];
    harness.emit({
      type: 'file.search_response',
      requestId: emptyReq.requestId,
      results: [],
    });
    expect(view.container.querySelector('.fb-search-status')?.textContent).toContain('file_browser.filter_empty');

    // Search timeout state (5s)
    fireEvent.input(input, { target: { value: 'slow' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    expect(harness.searchRequests()).toHaveLength(3);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(view.getByRole('alert').textContent).toContain('file_browser.search_timeout');

    // Search error state
    fireEvent.input(input, { target: { value: 'boom' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS); });
    const errReq = harness.searchRequests()[3];
    harness.emit({
      type: 'file.search_response',
      requestId: errReq.requestId,
      results: [],
      error: 'fzf failed',
    });
    expect(view.getByRole('alert').textContent).toContain('fzf failed');

    fireEvent.click(view.getByTestId('fb-nav-search-clear'));
    cleanup();

    // Offline fallback uses local tree filter without sending file.search
    const offline = makeWs({ connected: true });
    const offlineView = render(
      <FileBrowser ws={offline.ws} mode="file-single" layout="panel" initialPath="/proj" />,
    );
    offline.respondLs(
      offline.lsCalls[0].requestId,
      [
        { name: 'alpha.ts', isDir: false },
        { name: 'beta.ts', isDir: false },
      ],
      '/proj',
    );
    (offline.ws as { connected: boolean }).connected = false;
    const offlineInput = offlineView.getByTestId('fb-nav-search-input') as HTMLInputElement;
    fireEvent.input(offlineInput, { target: { value: 'alpha' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS + 50); });
    expect(offline.searchRequests()).toHaveLength(0);
    expect(offlineView.getByText('alpha.ts')).toBeTruthy();
    expect(offlineView.queryByText('beta.ts')).toBeNull();

    // Navigating (goUp) clears active search and restores directory browsing
    fireEvent.click(offlineView.getByTitle('Go up'));
    expect(offlineInput.value).toBe('');
    cleanup();

    // Windows drives root falls back to local filter without dispatching file.search
    const drives = makeWs({ connected: true });
    const drivesView = render(
      <FileBrowser ws={drives.ws} mode="file-single" layout="panel" initialPath="C:\\" />,
    );
    drives.emit({
      type: 'fs.ls_response',
      requestId: drives.lsCalls[0].requestId,
      path: '__imcodes_windows_drives__',
      resolvedPath: '__imcodes_windows_drives__',
      status: 'ok',
      entries: [
        { name: 'C:\\', isDir: true, hidden: false },
        { name: 'D:\\', isDir: true, hidden: false },
      ],
    });
    const drivesInput = drivesView.getByTestId('fb-nav-search-input') as HTMLInputElement;
    fireEvent.input(drivesInput, { target: { value: 'D:' } });
    act(() => { vi.advanceTimersByTime(FILE_BROWSER_FILTER_DEBOUNCE_MS + 50); });
    expect(drives.searchRequests()).toHaveLength(0);
    expect(drivesView.getByText('D:\\')).toBeTruthy();
    expect(drivesView.queryByText('C:\\')).toBeNull();
  });
});
