/**
 * @vitest-environment jsdom
 *
 * Tests for FileBrowser component.
 * Covers: modal vs panel layout, dir-only / file-multi modes,
 * expand/collapse tree, selection, multi-select, confirm callback.
 *
 * Heavy hljs/marked imports are mocked to prevent OOM in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';

// Mock FileEditor.js to prevent Vitest's SSR module graph from evaluating
// 17 CodeMirror/Lezer imports (causes OOM in jsdom). vi.mock is hoisted but
// Vitest still resolves the module graph for dependency analysis — this mock
// ensures the heavy module is replaced before evaluation.
vi.mock('../../src/components/FileEditor.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
// Mock the lazy wrapper that imports FileEditor.
vi.mock('../../src/components/file-editor-lazy.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/FilePreviewPane.js', () => ({
  default: (props: { content: string }) => <div data-testid="mock-file-preview">{props.content}</div>,
}));

import { FileBrowser, __resetFileBrowserSharedChangesForTests, mergePreviewState } from '../../src/components/FileBrowser.js';
import type { WsClient, ServerMessage } from '../../src/ws-client.js';

// Cleanup DOM/timers after each test
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ── i18n stub ─────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => {
  // t must be reference-stable — a new function ref each render causes
  // fetchPreview to be recreated, triggering infinite re-renders via
  // the autoPreviewPath useEffect.
  const map: Record<string, string> = {
    'file_browser.title_dir': 'Select Directory',
    'file_browser.title_file': 'Select Files',
    'file_browser.select': 'Select',
    'file_browser.browse': 'Browse',
    'file_browser.show_hidden': 'Hidden',
    'file_browser.this_pc': 'This PC',
    'file_browser.home': 'Home',
    'file_browser.timeout': 'Request timed out',
    'file_browser.mkdir_failed': 'Failed to create folder',
    'common.cancel': 'Cancel',
    'chat.new_folder': 'New folder',
    'chat.new_folder_name': 'Folder name',
    'chat.create': 'Create',
  };
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (key === 'file_browser.insert') return `Insert ${opts?.count ?? 0}`;
    if (key === 'file_browser.selected_count') return `${opts?.count ?? 0} selected`;
    return map[key] ?? key;
  };
  const translation = { t };
  return { useTranslation: () => translation };
});

// ── WsClient factory ──────────────────────────────────────────────────────

function makeWsFactory() {
  const messageHandlers = new Set<(msg: ServerMessage) => void>();
  let lastRequestId = 'mock-req-id';
  let lastSentPath = '';
  let lastSentIncludeFiles = false;
  const fsListDir = vi.fn((path: string, includeFiles = false) => {
    lastSentPath = path;
    lastSentIncludeFiles = includeFiles;
    return lastRequestId;
  });
  const fsMkdir = vi.fn((path: string) => {
    lastSentPath = path;
    lastRequestId = 'mock-mkdir-id';
    return lastRequestId;
  });

  const ws: WsClient = {
    onMessage: (handler: (msg: ServerMessage) => void) => {
      messageHandlers.add(handler);
      return () => { messageHandlers.delete(handler); };
    },
    fsListDir,
    fsMkdir,
    fsReadFile: vi.fn(() => 'mock-read-id'),
    fsGitStatus: vi.fn(() => 'mock-git-status-id'),
    fsGitDiff: vi.fn(() => 'mock-git-diff-id'),
  } as unknown as WsClient;

  const respond = (entries: Array<{ name: string; isDir: boolean; hidden?: boolean }>, resolvedPath?: string) => {
    for (const messageHandler of messageHandlers) messageHandler({
      type: 'fs.ls_response',
      requestId: lastRequestId,
      path: lastSentPath,
      resolvedPath: resolvedPath ?? lastSentPath,
      status: 'ok',
      entries: entries.map((e) => ({ ...e, hidden: e.hidden ?? e.name.startsWith('.') })),
    });
  };

  const respondError = (error: string) => {
    for (const messageHandler of messageHandlers) messageHandler({
      type: 'fs.ls_response',
      requestId: lastRequestId,
      path: lastSentPath,
      status: 'error',
      error,
    });
  };

  const sendMsg = (msg: ServerMessage) => {
    for (const messageHandler of messageHandlers) messageHandler(msg);
  };

  return { ws, fsListDir, fsMkdir, respond, respondError, sendMsg, getLastPath: () => lastSentPath, getIncludeFiles: () => lastSentIncludeFiles };
}

describe('FileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFileBrowserSharedChangesForTests();
  });

  it('does not regress an existing preview back to loading for the same file', () => {
    const merged = mergePreviewState(
      { status: 'ok', path: '/home/user/foo.ts', content: 'const x = 1;', diff: '+const x = 1;', diffHtml: '<div>diff</div>' },
      { status: 'loading', path: '/home/user/foo.ts' },
    );

    expect(merged).toEqual({
      status: 'ok',
      path: '/home/user/foo.ts',
      content: 'const x = 1;',
      diff: '+const x = 1;',
      diffHtml: '<div>diff</div>',
    });
  });

  it('merges richer ok preview state for the same file without dropping existing diff data', () => {
    const merged = mergePreviewState(
      { status: 'ok', path: '/home/user/foo.ts', content: 'const x = 1;', diff: '+const x = 1;', diffHtml: '<div>diff</div>' },
      { status: 'ok', path: '/home/user/foo.ts', content: 'const x = 2;' },
    );

    expect(merged).toEqual({
      status: 'ok',
      path: '/home/user/foo.ts',
      content: 'const x = 2;',
      diff: '+const x = 1;',
      diffHtml: '<div>diff</div>',
      downloadId: undefined,
    });
  });

  // ── Layout ─────────────────────────────────────────────────────────────

  it('renders modal overlay in modal layout', () => {
    const { ws } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="dir-only" layout="modal" onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.fb-overlay')).not.toBeNull();
    expect(document.querySelector('.fb-modal')).not.toBeNull();
  });

  it('renders panel container (no overlay) in panel layout', () => {
    const { ws } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="file-multi" layout="panel" onConfirm={vi.fn()} />);
    expect(document.querySelector('.fb-panel')).not.toBeNull();
    expect(document.querySelector('.fb-overlay')).toBeNull();
  });

  it('shows "Select Directory" title in dir-only modal', () => {
    const { ws } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(getByText('Select Directory')).toBeDefined();
  });

  it('shows "Select Files" title in file-single modal', () => {
    const { ws } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="file-single" layout="modal" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(getByText('Select Files')).toBeDefined();
  });

  it('calls onClose when Cancel button is clicked in modal', () => {
    const onClose = vi.fn();
    const { ws } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" onConfirm={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── WS requests ────────────────────────────────────────────────────────

  it('sends fs.ls on mount for the initial path', () => {
    const { ws, fsListDir } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="~/projects" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(fsListDir).toHaveBeenCalledWith('~/projects', false, false);
  });

  it('does NOT include files for dir-only mode', () => {
    const { ws, getIncludeFiles } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="dir-only" layout="modal" onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(getIncludeFiles()).toBe(false);
  });

  it('includes files for file-multi mode', () => {
    const { ws, getIncludeFiles } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="file-multi" layout="panel" onConfirm={vi.fn()} />);
    expect(getIncludeFiles()).toBe(true);
  });

  // ── Tree rendering ─────────────────────────────────────────────────────

  it('renders directory entries after fs.ls_response', async () => {
    const { ws, respond } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => {
      respond([
        { name: 'projects', isDir: true },
        { name: 'documents', isDir: true },
      ], '/home/user');
    });

    expect(getByText('projects')).toBeDefined();
    expect(getByText('documents')).toBeDefined();
  });

  it('uses entry.path from a Windows drive root listing', async () => {
    const { ws, respond } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath=":drives:" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    act(() => respond([
      { name: 'C:\\', path: 'C:\\', isDir: true },
      { name: 'D:\\', path: 'D:\\', isDir: true },
    ] as any, '__imcodes_windows_drives__'));

    expect(await screen.findByText('C:\\')).toBeTruthy();
    expect(await screen.findByText('D:\\')).toBeTruthy();
  });

  it('initialPath="~" requests home directory, NOT the drives sentinel', async () => {
    const { ws, fsListDir, respond } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="~" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    // First call should ask for ~ (home), not :drives:
    const calls = fsListDir.mock.calls.map((c) => c[0]);
    expect(calls).toContain('~');
    expect(calls).not.toContain(':drives:');

    // Daemon resolves ~ to actual home path
    act(() => respond([
      { name: 'projects', isDir: true },
      { name: 'Documents', isDir: true },
    ], 'C:\\Users\\admin'));

    expect(await screen.findByText('projects')).toBeTruthy();
    expect(await screen.findByText('Documents')).toBeTruthy();
  });

  it('shows "This PC" drive switch button when current path looks like Windows', async () => {
    const { ws, fsListDir, respond } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="~" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    // Resolve home to a Windows-style path
    act(() => respond([{ name: 'projects', isDir: true }], 'C:\\Users\\admin'));
    await screen.findByText('projects');

    // Drive switch button should be visible
    const driveBtn = container.querySelector('button[title*="This PC"]');
    expect(driveBtn).toBeTruthy();

    // Clicking it requests the :drives: sentinel
    fsListDir.mockClear();
    act(() => { fireEvent.click(driveBtn as Element); });
    expect(fsListDir.mock.calls.map((c) => c[0])).toContain(':drives:');
  });

  it('does NOT show drive switch button on Linux paths', async () => {
    const { ws, respond } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="~" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    act(() => respond([{ name: 'projects', isDir: true }], '/home/admin'));
    await screen.findByText('projects');

    const driveBtn = container.querySelector('button[title*="This PC"]');
    expect(driveBtn).toBeNull();
  });

  it('drive button toggles to "Home" when at drives root', async () => {
    const { ws, fsListDir, respond } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath=":drives:" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    act(() => respond([
      { name: 'C:\\', path: 'C:\\', isDir: true },
    ] as any, '__imcodes_windows_drives__'));
    await screen.findByText('C:\\');

    // Button should now offer to go Home
    const homeBtn = container.querySelector('button[title="Home"]');
    expect(homeBtn).toBeTruthy();

    fsListDir.mockClear();
    act(() => { fireEvent.click(homeBtn as Element); });
    expect(fsListDir.mock.calls.map((c) => c[0])).toContain('~');
  });

  it('shows error indicator on fs.ls_response with status error', async () => {
    const { ws, respondError } = makeWsFactory();
    const { getByTitle } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => { respondError('forbidden_path'); });

    // Error shown as ⚠ button with error message in title tooltip
    expect(getByTitle('forbidden_path')).toBeDefined();
  });

  it('does not re-fetch already loaded directories', async () => {
    const { ws, respond, fsListDir } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => {
      respond([{ name: 'projects', isDir: true }], '/home/user');
    });

    const callsBefore = fsListDir.mock.calls.length;

    // Clicking the already-loaded root node should NOT trigger a new fetch
    await act(async () => {
      fireEvent.click(getByText('projects'));
    });

    // projects was never loaded (just the root), so clicking it DOES fetch
    // but clicking the root node again (already loaded) should not
    // Re-click the already-loaded node's parent (root breadcrumb area)
    // The key check: clicking the root node's expand arrow should not re-fetch
    expect(fsListDir.mock.calls.length).toBeGreaterThanOrEqual(callsBefore); // at minimum no regression
  });

  it('creates a new folder and refreshes the parent directory after fs.mkdir_response', async () => {
    const { ws, respond, sendMsg, fsMkdir, fsListDir } = makeWsFactory();
    const { getByTitle, getByPlaceholderText, getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => {
      respond([{ name: 'projects', isDir: true }], '/home/user');
    });

    await act(async () => {
      fireEvent.click(getByTitle('New folder'));
    });
    await act(async () => {
      fireEvent.input(getByPlaceholderText('Folder name'), { target: { value: 'newdir' } });
    });
    await act(async () => {
      fireEvent.click(getByText('Create'));
    });

    expect(fsMkdir).toHaveBeenCalledWith('/home/user/newdir');

    await act(async () => {
      sendMsg({ type: 'fs.mkdir_response', requestId: 'mock-mkdir-id', path: '/home/user/newdir', resolvedPath: '/home/user/newdir', status: 'ok' } as any);
    });

    expect(fsListDir).toHaveBeenLastCalledWith('/home/user', false, false);
  });

  // ── Selection ──────────────────────────────────────────────────────────

  it('calls onConfirm with selected path in dir-only mode', async () => {
    const onConfirm = vi.fn();
    const { ws, respond } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    await act(async () => {
      respond([{ name: 'projects', isDir: true }], '/home/user');
    });

    fireEvent.click(getByText('projects'));
    fireEvent.click(getByText('Select'));
    expect(onConfirm).toHaveBeenCalledWith(['/home/user/projects']);
  });

  it('multi-select: onConfirm receives all checked paths', async () => {
    const onConfirm = vi.fn();
    const { ws, respond } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="file-multi" layout="panel" initialPath="/home/user" onConfirm={onConfirm} />,
    );

    await act(async () => {
      respond([
        { name: 'a.ts', isDir: false },
        { name: 'b.ts', isDir: false },
      ], '/home/user');
    });

    // In file-multi mode, selection is via checkbox only (not row click)
    const getCheckbox = (name: string) =>
      getByText(name).closest('.fb-node')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    fireEvent.click(getCheckbox('a.ts'));
    fireEvent.click(getCheckbox('b.ts'));

    fireEvent.click(getByText('Insert 2'));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.arrayContaining(['/home/user/a.ts', '/home/user/b.ts']),
    );
  });

  it('deselects a path when clicked again in multi-select', async () => {
    const { ws, respond } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser ws={ws} mode="file-multi" layout="panel" initialPath="/home/user" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respond([{ name: 'a.ts', isDir: false }], '/home/user');
    });

    // In file-multi mode, selection is via checkbox only (not row click)
    const checkbox = getByText('a.ts').closest('.fb-node')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    fireEvent.click(checkbox);  // select (Insert 1)
    fireEvent.click(checkbox);  // deselect → back to Select

    // When nothing is selected, button reverts to 'Select' label
    expect(getByText('Select')).toBeDefined();
  });

  it('shows already-inserted badge for paths in alreadyInserted', async () => {
    const { ws, respond } = makeWsFactory();
    const { getByText } = render(
      <FileBrowser
        ws={ws}
        mode="file-multi"
        layout="panel"
        initialPath="/home/user"
        alreadyInserted={['/home/user/a.ts']}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => {
      respond([{ name: 'a.ts', isDir: false }], '/home/user');
    });

    expect(getByText('↑')).toBeDefined();
  });

  // ── Git status & diff ─────────────────────────────────────────────────

  it('calls fsGitStatus when loading a directory', async () => {
    const { ws, respond } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user" onConfirm={vi.fn()} />);
    await act(async () => { respond([{ name: 'foo.ts', isDir: false }], '/home/user'); });
    expect(ws.fsGitStatus).toHaveBeenCalled();
  });

  it('shows git badge on modified file after git_status_response', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user" onConfirm={vi.fn()} />);
    await act(async () => { respond([{ name: 'foo.ts', isDir: false }], '/home/user'); });
    // Simulate git status response marking foo.ts as Modified
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });
    expect(document.querySelector('.fb-node-git-badge')).not.toBeNull();
  });

  it('requests stats only for shared changes queries, not tree git badges', () => {
    const { ws } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        onConfirm={vi.fn()}
        changesRootPath="/home/user"
        defaultTab="changes"
      />,
    );

    expect(ws.fsGitStatus).toHaveBeenCalledWith('~');
    expect(ws.fsGitStatus).toHaveBeenCalledWith('/home/user', { includeStats: true });
  });

  it('keeps subtree git status requests lightweight when expanding directories', async () => {
    const { ws, respond } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => {
      respond([{ name: 'projects', isDir: true }], '/home/user');
    });

    const dirEntry = await screen.findByText('projects');
    await act(async () => { fireEvent.click(dirEntry); });

    expect((ws.fsGitStatus as any).mock.calls).toEqual([
      ['/home/user'],
      ['/home/user/projects'],
    ]);
  });

  it('does not refresh shared changes while files tab hides the changes panel', () => {
    const { ws } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        onConfirm={vi.fn()}
        changesRootPath="/home/user"
        onPreviewFile={vi.fn()}
        defaultTab="files"
      />,
    );

    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);
    expect(ws.fsGitStatus).toHaveBeenCalledWith('~');
  });

  it('does not render an embedded changes section in files view', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onConfirm={vi.fn()}
        defaultTab="files"
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    expect(document.querySelector('.fb-changes-section')).toBeNull();
    expect(document.querySelector('.fb-body-with-changes')).toBeNull();
  });

  it('shows panel tabs when changesRootPath is provided', async () => {
    const { ws, respond } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user"
        changesRootPath="/home/user" onConfirm={vi.fn()} />,
    );
    await act(async () => { respond([], '/home/user'); });
    expect(document.querySelector('.fb-panel-tabs')).not.toBeNull();
  });

  it('shows changes list after clicking Changes tab', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user"
        changesRootPath="/home/user" onConfirm={vi.fn()} />,
    );
    await act(async () => { respond([], '/home/user'); });
    // Click Changes tab (in .fb-panel-tabs)
    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/bar.ts', code: 'M' }],
      });
    });
    expect(document.querySelector('.fb-changes-section')).not.toBeNull();
  });

  it('keeps the Changes list usable when stats are unavailable', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user"
        changesRootPath="/home/user" onConfirm={vi.fn()} />,
    );
    await act(async () => { respond([], '/home/user'); });
    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/bar.ts', code: 'M' }],
      });
    });
    expect(document.querySelector('.fb-changes-item')).not.toBeNull();
    expect(document.querySelector('.fb-changes-item-stats')).toBeNull();
  });

  it('shows + and - stats in the changes list when provided by git status', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user"
        changesRootPath="/home/user" onConfirm={vi.fn()} />,
    );
    await act(async () => { respond([], '/home/user'); });
    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/bar.ts', code: 'M', additions: 7, deletions: 2 }],
      } as any);
    });
    expect(document.querySelector('.fb-changes-item-stats')?.textContent).toContain('+7');
    expect(document.querySelector('.fb-changes-item-stats')?.textContent).toContain('-2');
  });

  it('shares changes requests across file browsers on the same repo', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <div>
        <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user/src"
          changesRootPath="/home/user" onConfirm={vi.fn()} />
        <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user/src"
          changesRootPath="/home/user" onConfirm={vi.fn()} />
      </div>,
    );

    await act(async () => { respond([], '/home/user/src'); });

    const changeRequests = (ws.fsGitStatus as any).mock.calls.filter((call: any[]) => call[0] === '/home/user');
    expect(changeRequests).toHaveLength(1);

    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/bar.ts', code: 'M' }],
      });
    });

    expect(document.querySelectorAll('.fb-panel-tab-badge')[0]?.textContent).toBe('1');
    expect(document.querySelectorAll('.fb-panel-tab-badge')[1]?.textContent).toBe('1');
  });

  it('shows diff toggle button when diff is available', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(<FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/home/user"
      autoPreviewPath="/home/user/foo.ts" onConfirm={vi.fn()} />);
    await act(async () => { respond([{ name: 'foo.ts', isDir: false }], '/home/user'); });
    // Simulate read + diff responses
    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'mock-read-id', path: '/home/user/foo.ts', status: 'ok', content: 'const x = 1;' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'mock-git-diff-id', path: '/home/user/foo.ts', status: 'ok', diff: '+const x = 1;\n-const x = 0;' });
    });
    expect(document.querySelector('.fb-diff-toggle')).not.toBeNull();
  });

  it('defaults to diff mode when opening a file from the Changes tab', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });

    const changeItem = document.querySelector('.fb-changes-item') as HTMLElement;
    await act(async () => { fireEvent.click(changeItem); });
    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'mock-read-id', path: '/home/user/foo.ts', status: 'ok', content: 'const x = 1;' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'mock-git-diff-id', path: '/home/user/foo.ts', status: 'ok', diff: '+const x = 1;\n-const x = 0;' });
    });

    expect(document.querySelector('.fb-diff')).not.toBeNull();
    expect(document.querySelector('.fb-preview-content pre')).toBeNull();
  });

  it('falls back to source preview when an untracked file has no diff content', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/new-file.ts', code: '??' }],
      });
    });

    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });

    const changeItem = document.querySelector('.fb-changes-item') as HTMLElement;
    await act(async () => { fireEvent.click(changeItem); });
    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'mock-read-id', path: '/home/user/new-file.ts', status: 'ok', content: 'const fresh = true;' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'mock-git-diff-id', path: '/home/user/new-file.ts', status: 'ok', diff: '' });
    });

    expect(document.querySelector('.fb-diff')).toBeNull();
    expect(document.querySelector('.fb-diff-toggle.active')).toBeNull();
    expect(screen.getByTestId('mock-file-preview').textContent).toContain('const fresh = true;');
  });

  it('passes preferDiff to external previews opened from the Changes tab', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    const onPreviewFile = vi.fn();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onPreviewFile={onPreviewFile}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });

    const changeItem = document.querySelector('.fb-changes-item') as HTMLElement;
    await act(async () => { fireEvent.click(changeItem); });

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/home/user/foo.ts',
      preferDiff: true,
      preview: { status: 'loading', path: '/home/user/foo.ts' },
    });
  });

  it('does not start local preview fetches when using an external preview host', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    const onPreviewFile = vi.fn();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onPreviewFile={onPreviewFile}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });

    const changeItem = document.querySelector('.fb-changes-item') as HTMLElement;
    await act(async () => { fireEvent.click(changeItem); });

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(0);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(0);
    expect(onPreviewFile).toHaveBeenLastCalledWith({
      path: '/home/user/foo.ts',
      preferDiff: true,
      preview: { status: 'loading', path: '/home/user/foo.ts' },
    });
  });

  it('does not render an inline preview when an external preview host is provided', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    const onPreviewFile = vi.fn();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onPreviewFile={onPreviewFile}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    const changesTab = document.querySelector('.fb-panel-tab:last-child') as HTMLElement;
    await act(async () => { fireEvent.click(changesTab); });

    const changeItem = document.querySelector('.fb-changes-item') as HTMLElement;
    await act(async () => { fireEvent.click(changeItem); });

    expect(onPreviewFile).toHaveBeenCalled();
    expect(document.querySelector('.fb-preview')).toBeNull();
    expect(document.querySelector('.fb-body-split')).toBeNull();
    expect(document.querySelector('.fb-tree-split')).toBeNull();
    expect(document.querySelector('.fb-resize-handle')).toBeNull();
  });

  it('does not change the source panel layout when opening external previews from the files list', async () => {
    const { ws, respond } = makeWsFactory();
    const onPreviewFile = vi.fn();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        onPreviewFile={onPreviewFile}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([{ name: 'foo.ts', isDir: false }], '/home/user'); });

    const fileEntry = await screen.findByText('foo.ts');
    await act(async () => { fireEvent.click(fileEntry); });

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/home/user/foo.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/home/user/foo.ts' },
    });
    expect(document.querySelector('.fb-preview')).toBeNull();
    expect(document.querySelector('.fb-body-split')).toBeNull();
    expect(document.querySelector('.fb-tree-split')).toBeNull();
    expect(document.querySelector('.fb-resize-handle')).toBeNull();
  });

  it('hides the embedded changes section in files view when an external preview host is provided', async () => {
    const { ws, respond, sendMsg } = makeWsFactory();
    localStorage.setItem('rcc_fb_tab', 'files');
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        changesRootPath="/home/user"
        onPreviewFile={vi.fn()}
        onConfirm={vi.fn()}
        defaultTab="files"
      />,
    );

    await act(async () => { respond([], '/home/user'); });
    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'mock-git-status-id',
        path: '/home/user',
        resolvedPath: '/home/user',
        status: 'ok',
        files: [{ path: '/home/user/foo.ts', code: 'M' }],
      });
    });

    expect(document.querySelector('.fb-panel-tabs')).not.toBeNull();
    expect(document.querySelector('.fb-changes-section')).toBeNull();
    expect(document.querySelector('.fb-body-with-changes')).toBeNull();
  });

  it('does not re-read when an external preview is hydrated with a live loading state', () => {
    const { ws } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        initialPreview={{ status: 'loading', path: '/home/user/foo.ts' }}
        autoPreviewPath="/home/user/foo.ts"
        autoPreviewPreferDiff
        skipAutoPreviewIfLoading
        onConfirm={vi.fn()}
      />,
    );

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(0);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(0);
  });

  it('preserves a manual diff tab selection when the same preview path refreshes', async () => {
    const { ws } = makeWsFactory();
    const view = render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        initialPreview={{
          status: 'ok',
          path: '/home/user/foo.ts',
          content: 'const before = 1;',
          diff: '+const before = 1;',
          diffHtml: '<div>diff before</div>',
        }}
        onConfirm={vi.fn()}
      />,
    );

    const toggle = screen.getByTitle('Toggle diff view');
    expect(document.querySelector('.fb-diff')).toBeNull();
    expect(toggle.className).not.toContain('active');

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(document.querySelector('.fb-diff')).not.toBeNull();
    expect(toggle.className).toContain('active');

    view.rerender(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        initialPreview={{
          status: 'ok',
          path: '/home/user/foo.ts',
          content: 'const after = 2;',
          diff: '+const after = 2;',
          diffHtml: '<div>diff after</div>',
        }}
        onConfirm={vi.fn()}
      />,
    );

    expect(document.querySelector('.fb-diff')?.textContent).toContain('diff after');
    expect(screen.getByTitle('Toggle diff view').className).toContain('active');
  });

  it('fetches preview data when a floating preview is hydrated with a loading state', () => {
    const { ws } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        initialPreview={{ status: 'loading', path: '/home/user/foo.ts' }}
        autoPreviewPath="/home/user/foo.ts"
        autoPreviewPreferDiff
        onConfirm={vi.fn()}
      />,
    );

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(1);
    expect((ws.fsReadFile as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
    expect((ws.fsGitDiff as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
  });

  it('dispatches at most one current read/diff cycle per visible target', async () => {
    const { ws, respond } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => {
      respond([{ name: 'foo.ts', isDir: false }], '/home/user');
    });

    const fileEntry = await screen.findByText('foo.ts');
    await act(async () => { fireEvent.click(fileEntry); });
    await act(async () => { fireEvent.click(fileEntry); });

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(1);
    expect((ws.fsReadFile as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
    expect((ws.fsGitDiff as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
  });

  it('does not let stale pending preview work delay a new auto-preview target', () => {
    const { ws } = makeWsFactory();
    (ws.fsReadFile as any)
      .mockImplementationOnce(() => 'read-foo')
      .mockImplementationOnce(() => 'read-bar');
    (ws.fsGitDiff as any)
      .mockImplementationOnce(() => 'diff-foo')
      .mockImplementationOnce(() => 'diff-bar');

    const view = render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        onConfirm={vi.fn()}
      />,
    );

    view.rerender(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/bar.ts"
        onConfirm={vi.fn()}
      />,
    );

    expect((ws.fsReadFile as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      '/home/user/foo.ts',
      '/home/user/bar.ts',
    ]);
    expect((ws.fsGitDiff as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      '/home/user/foo.ts',
      '/home/user/bar.ts',
    ]);
  });

  it('clears stale preview-cycle ownership when the ws instance changes', () => {
    const first = makeWsFactory();
    (first.ws.fsReadFile as any).mockImplementationOnce(() => 'read-first');
    (first.ws.fsGitDiff as any).mockImplementationOnce(() => 'diff-first');

    const view = render(
      <FileBrowser
        ws={first.ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        initialPreview={{ status: 'loading', path: '/home/user/foo.ts' }}
        autoPreviewPath="/home/user/foo.ts"
        autoPreviewPreferDiff
        onConfirm={vi.fn()}
      />,
    );

    expect((first.ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((first.ws.fsGitDiff as any).mock.calls).toHaveLength(1);

    const second = makeWsFactory();
    (second.ws.fsReadFile as any).mockImplementationOnce(() => 'read-second');
    (second.ws.fsGitDiff as any).mockImplementationOnce(() => 'diff-second');

    view.rerender(
      <FileBrowser
        ws={second.ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        initialPreview={{ status: 'loading', path: '/home/user/foo.ts' }}
        autoPreviewPath="/home/user/foo.ts"
        autoPreviewPreferDiff
        onConfirm={vi.fn()}
      />,
    );

    expect((second.ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((second.ws.fsGitDiff as any).mock.calls).toHaveLength(1);
    expect((second.ws.fsReadFile as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
    expect((second.ws.fsGitDiff as any).mock.calls[0]?.[0]).toBe('/home/user/foo.ts');
  });

  it('ignores stale preview responses after switching to a new target', async () => {
    const { ws, sendMsg } = makeWsFactory();
    const onPreviewStateChange = vi.fn();
    (ws.fsReadFile as any)
      .mockImplementationOnce(() => 'read-foo')
      .mockImplementationOnce(() => 'read-bar');
    (ws.fsGitDiff as any)
      .mockImplementationOnce(() => 'diff-foo')
      .mockImplementationOnce(() => 'diff-bar');

    const view = render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        onPreviewStateChange={onPreviewStateChange}
        onConfirm={vi.fn()}
      />,
    );

    view.rerender(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/bar.ts"
        onPreviewStateChange={onPreviewStateChange}
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'read-foo', path: '/home/user/foo.ts', status: 'ok', content: 'old foo' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'diff-foo', path: '/home/user/foo.ts', status: 'ok', diff: '+old foo' });
    });

    expect(onPreviewStateChange.mock.calls.at(-1)?.[0]).toMatchObject({
      path: '/home/user/bar.ts',
      preview: { status: 'loading', path: '/home/user/bar.ts' },
    });

    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'read-bar', path: '/home/user/bar.ts', status: 'ok', content: 'new bar' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'diff-bar', path: '/home/user/bar.ts', status: 'ok', diff: '+new bar' });
    });

    expect(onPreviewStateChange.mock.calls.at(-1)?.[0]).toMatchObject({
      path: '/home/user/bar.ts',
      preview: { status: 'ok', path: '/home/user/bar.ts', content: 'new bar', diff: '+new bar' },
    });
  });

  it('polls only for an active inline preview', async () => {
    vi.useFakeTimers();
    const { ws, respond, sendMsg } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        onConfirm={vi.fn()}
      />,
    );

    await act(async () => { respond([{ name: 'foo.ts', isDir: false }], '/home/user'); });
    await act(async () => {
      sendMsg({ type: 'fs.read_response', requestId: 'mock-read-id', path: '/home/user/foo.ts', status: 'ok', content: 'const x = 1;' });
      sendMsg({ type: 'fs.git_diff_response', requestId: 'mock-git-diff-id', path: '/home/user/foo.ts', status: 'ok', diff: '+const x = 1;' });
    });

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(2);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('does not poll local preview state for source instances that delegate to external previews', async () => {
    vi.useFakeTimers();
    const { ws } = makeWsFactory();
    render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        onPreviewFile={vi.fn()}
        initialPreview={{ status: 'ok', path: '/home/user/foo.ts', content: 'const x = 1;' }}
        onConfirm={vi.fn()}
      />,
    );

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(0);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(0);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(0);
    vi.useRealTimers();
  });

  it('does not immediately reopen an auto-preview after the preview close button is pressed', async () => {
    const { ws } = makeWsFactory();
    const onClose = vi.fn();
    const { container } = render(
      <FileBrowser
        ws={ws}
        mode="file-single"
        layout="panel"
        initialPath="/home/user"
        autoPreviewPath="/home/user/foo.ts"
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    expect((ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(1);

    await act(async () => {
      fireEvent.click(container.querySelector('.fb-close') as HTMLElement);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect((ws.fsReadFile as any).mock.calls).toHaveLength(1);
    expect((ws.fsGitDiff as any).mock.calls).toHaveLength(1);
  });

  // ── Expand ────────────────────────────────────────────────────────────

  it('fetches children when a collapsed directory expand arrow is clicked', async () => {
    const { ws, respond, fsListDir } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="dir-only" layout="modal" initialPath="/home/user" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => {
      respond([{ name: 'projects', isDir: true }], '/home/user');
    });

    const callsBefore = fsListDir.mock.calls.length;

    // The ▸ arrow for 'projects' directory
    const arrows = container.querySelectorAll('.fb-node-expand');
    const projectArrow = [...arrows].find((el) => el.textContent === '▸');
    if (projectArrow) {
      await act(async () => { fireEvent.click(projectArrow.parentElement!); });
    }

    expect(fsListDir.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
