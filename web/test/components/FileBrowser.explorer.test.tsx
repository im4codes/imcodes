/**
 * @vitest-environment jsdom
 *
 * Explorer ergonomics tests for FileBrowser:
 * - Crisp SVG FileTypeIcon + indent guides + ancestor folder git indicator dots
 * - Collapse All button + targeted inline creation (active dir / file parent / Office doc types)
 * - Inline rename (stem pre-selection, Enter/Escape, separator guard, F2 shortcut, no prompt)
 * - Rich context menu (non-destructive items in readOnly, Copy Relative Path, Insert @path)
 * - Tree keyboard navigation (ArrowUp/Down/Left/Right/Enter/F2/Delete/Meta+Backspace)
 * - Drag-and-drop move with self/same-parent/descendant guards
 * - Panel density & hover-reveal checkboxes (`fb-tree-panel`, `fb-has-selection`)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/preact';

vi.mock('../../src/components/FileEditor.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/file-editor-lazy.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/FilePreviewPane.js', () => ({
  default: (props: { content: string }) => <div data-testid="mock-file-preview">{props.content}</div>,
}));
vi.mock('../../src/direct-file-transfer.js', () => ({
  FILE_DOWNLOAD_TRANSPORT_MODE: {
    CONNECTING: 'connecting', DIRECT: 'direct', FALLING_BACK: 'falling_back', HTTP: 'http', BROWSER: 'browser',
  },
  downloadPreviewWithDirectFallback: vi.fn().mockResolvedValue(undefined),
  prewarmDirectFileLease: vi.fn(() => undefined),
  selectPreviewDownloadDestination: vi.fn().mockResolvedValue(null),
  isDirectFileTransferStaleHandleError: vi.fn(() => false),
  isFileUploadCanceled: vi.fn(() => false),
}));

import { FileBrowser, __resetFileBrowserSharedChangesForTests } from '../../src/components/FileBrowser.js';
import { clearFileBrowserCache } from '../../src/file-browser-cache.js';
import type { WsClient, ServerMessage } from '../../src/ws-client.js';

afterEach(() => {
  __resetFileBrowserSharedChangesForTests();
  clearFileBrowserCache();
  vi.restoreAllMocks();
  cleanup();
});

vi.mock('react-i18next', () => {
  const map: Record<string, string> = {
    'file_browser.title_dir': 'Select Directory',
    'file_browser.title_file': 'Select Files',
    'file_browser.select': 'Select',
    'file_browser.browse': 'Browse',
    'file_browser.show_hidden': 'Hidden',
    'file_browser.this_pc': 'This PC',
    'file_browser.collapse_all': 'Collapse All Folders',
    'file_browser.ctx_new_file': 'New File…',
    'file_browser.ctx_new_folder': 'New Folder…',
    'file_browser.ctx_refresh_folder': 'Refresh Folder',
    'file_browser.ctx_collapse_folder': 'Collapse Folder',
    'file_browser.ctx_open': 'Open / Preview',
    'file_browser.ctx_copy_relative_path': 'Copy Relative Path',
    'file_browser.ctx_insert_at_path': 'Insert @path',
    'file_browser.ctx_download': 'Download',
    'file_browser.folder_has_changes': 'Contains changed files',
    'file_browser.invalid_name': 'Name cannot contain path separators',
    'file_browser.delete_confirm': 'Delete this item?',
    'common.rename': 'Rename',
    'common.delete': 'Delete',
    'common.cancel': 'Cancel',
    'fileBrowser.copyPath': 'Copy path',
    'fileBrowser.copied': 'Copied!',
    'chat.new_file': 'New file',
    'chat.new_file_name': 'File name',
    'chat.new_folder': 'New folder',
    'chat.new_folder_name': 'Folder name',
    'chat.create': 'Create',
    'file_browser.filter_placeholder': 'Filter by name',
    'file_browser.filter_label': 'Filter files by name',
    'file_browser.filter_clear': 'Clear filter',
  };
  const t = (key: string, opts?: Record<string, unknown> | string) => {
    if (key === 'file_browser.insert' && typeof opts === 'object') return `Insert ${opts?.count ?? 0}`;
    if (key === 'file_browser.selected_count' && typeof opts === 'object') return `${opts?.count ?? 0} selected`;
    return map[key] ?? (typeof opts === 'string' ? opts : key);
  };
  const stable = { t, i18n: { language: 'en' } };
  return { useTranslation: () => stable };
});

function makeWsFactory() {
  const listeners = new Set<(msg: ServerMessage) => void>();
  let reqSeq = 0;
  const fsListDir = vi.fn((path: string) => {
    reqSeq += 1;
    return `ls-${reqSeq}:${path}`;
  });
  const fsMkdir = vi.fn(() => 'mkdir-1');
  const fsWriteFile = vi.fn(() => 'write-1');
  const fsRename = vi.fn(() => 'rename-1');
  const fsDelete = vi.fn(() => 'delete-1');
  const fsGitStatus = vi.fn(() => 'git-status-1');
  const fsGitDiff = vi.fn(() => 'git-diff-1');
  const fsReadFile = vi.fn(() => 'read-1');

  const ws = {
    connected: true,
    onMessage: (fn: (msg: ServerMessage) => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    fsListDir,
    fsMkdir,
    fsWriteFile,
    fsRename,
    fsDelete,
    fsReadFile,
    fsGitStatus,
    fsGitDiff,
    forgetOwnedDataRequest: vi.fn(),
  } as unknown as WsClient;

  const sendMsg = (msg: ServerMessage) => {
    for (const fn of listeners) fn(msg);
  };

  const respondLs = (
    path: string,
    entries: Array<{ name: string; isDir: boolean; hidden?: boolean }>,
    requestId?: string,
  ) => {
    const resolvedId = requestId ?? fsListDir.mock.results.findLast(
      (_, i) => fsListDir.mock.calls[i]?.[0] === path,
    )?.value ?? 'ls-1';
    sendMsg({
      type: 'fs.ls_response',
      requestId: resolvedId,
      path,
      resolvedPath: path,
      status: 'ok',
      entries,
    } as ServerMessage);
  };

  return { ws, fsListDir, fsMkdir, fsWriteFile, fsRename, fsDelete, fsReadFile, sendMsg, respondLs };
}

describe('FileBrowser VS Code Explorer upgrade', () => {
  it('renders extension SVG icons, vertical indent guides, and ancestor folder git status dots', async () => {
    const { ws, respondLs, sendMsg } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="file-multi" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [
        { name: 'src', isDir: true },
        { name: 'dist', isDir: true },
        { name: 'package.json', isDir: false },
        { name: 'App.tsx', isDir: false },
      ]);
    });

    await act(async () => {
      sendMsg({
        type: 'fs.git_status_response',
        requestId: 'git-status-1',
        path: '/repo',
        resolvedPath: '/repo',
        status: 'ok',
        files: [
          { path: '/repo/src/utils/helper.ts', code: 'M' },
          { path: '/repo/dist/out.js', code: '!!' },
        ],
      } as ServerMessage);
    });

    expect(container.querySelector('[data-file-icon="folder-open"]')).toBeTruthy();
    expect(container.querySelector('[data-file-icon="folder-closed"]')).toBeTruthy();
    expect(container.querySelector('[data-file-icon="npm"]')).toBeTruthy();
    expect(container.querySelector('[data-file-icon="tsx"]')).toBeTruthy();

    const srcRow = screen.getByText('src').closest('.fb-node') as HTMLElement;
    expect(srcRow.querySelector('.fb-indent-guide')).toBeTruthy();
    expect(srcRow.querySelector('.fb-node-git-dot.git-dot-modified')).toBeTruthy();

    const distRow = screen.getByText('dist').closest('.fb-node') as HTMLElement;
    expect(distRow.querySelector('.fb-node-git-dot')).toBeNull();
  });

  it('targets active subfolder or selected file parent for inline creation and collapses all via toolbar button', async () => {
    const { ws, respondLs, fsWriteFile, fsMkdir } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} serverId="srv-1" mode="file-multi" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false },
      ]);
    });

    // Click subfolder 'src' to focus & expand it
    await act(async () => {
      fireEvent.click(screen.getByText('src').closest('.fb-node')!);
    });
    await act(async () => {
      respondLs('/repo/src', [{ name: 'main.ts', isDir: false }]);
    });

    expect(screen.getByText('main.ts')).toBeTruthy();

    // Click main.ts so active node is a file inside /repo/src -> creation targets /repo/src
    await act(async () => {
      fireEvent.click(screen.getByText('main.ts').closest('.fb-node')!);
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('New file'));
    });

    const inlineRow = container.querySelector('.fb-inline-create-row') as HTMLElement;
    expect(inlineRow).toBeTruthy();
    expect(screen.getByTestId('fb-new-doc-type-select')).toBeTruthy();

    const input = screen.getByTestId('fb-inline-create-input') as HTMLInputElement;
    // Reject path separator
    await act(async () => {
      fireEvent.input(input, { target: { value: 'bad/name.ts' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fsWriteFile).not.toHaveBeenCalled();

    // Valid name commits inside /repo/src
    await act(async () => {
      fireEvent.input(input, { target: { value: 'util.ts' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fsWriteFile).toHaveBeenCalledWith('/repo/src/util.ts', '', { createOnly: true });

    // Collapse all collapses /repo/src back to root
    const treeEl = container.querySelector('.fb-tree') as HTMLElement;
    await act(async () => {
      fireEvent.click(screen.getByTestId('fb-collapse-all-btn'));
    });
    expect(within(treeEl).queryByText('main.ts')).toBeNull();
    expect(within(treeEl).getByText('src')).toBeTruthy();

    // Focusing 'src' again while collapsed and clicking New folder expands it and creates inside /repo/src
    await act(async () => {
      fireEvent.click(within(treeEl).getByText('src').closest('.fb-node')!);
      fireEvent.click(screen.getByTestId('fb-collapse-all-btn'));
    });
    await act(async () => {
      fireEvent.click(within(treeEl).getByText('src').closest('.fb-node')!);
      // Re-collapse to verify openNewEntry expands collapsed target
      fireEvent.click(within(treeEl).getByText('src').closest('.fb-node')!);
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('New folder'));
    });
    const folderInput = screen.getByTestId('fb-inline-create-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.input(folderInput, { target: { value: 'hooks' } });
      fireEvent.keyDown(folderInput, { key: 'Enter' });
    });
    expect(fsMkdir).toHaveBeenCalledWith('/repo/src/hooks');
  });

  it('supports inline rename validation, Escape cancel, and F2 trigger', async () => {
    const { ws, respondLs, fsRename } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [{ name: 'index.ts', isDir: false }]);
    });

    const row = screen.getByText('index.ts').closest('.fb-node')!;
    await act(async () => {
      fireEvent.click(row);
    });
    const treeEl = container.querySelector('.fb-tree')!;
    await act(async () => {
      fireEvent.keyDown(treeEl, { key: 'F2' });
    });

    const renameInput = screen.getByTestId('fb-rename-input') as HTMLInputElement;
    expect(renameInput.selectionStart).toBe(0);
    expect(renameInput.selectionEnd).toBe(5);

    // Invalid separator blocked
    await act(async () => {
      fireEvent.input(renameInput, { target: { value: 'a\\b.ts' } });
      fireEvent.keyDown(renameInput, { key: 'Enter' });
    });
    expect(fsRename).not.toHaveBeenCalled();

    // Escape cancels cleanly
    await act(async () => {
      fireEvent.keyDown(renameInput, { key: 'Escape' });
    });
    expect(screen.queryByTestId('fb-rename-input')).toBeNull();
    expect(fsRename).not.toHaveBeenCalled();
  });

  it('provides rich readOnly-safe context menu with Copy Relative Path and Insert @path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const { ws, respondLs } = makeWsFactory();
    const onConfirm = vi.fn();
    render(
      <FileBrowser
        ws={ws}
        mode="file-multi"
        layout="panel"
        readOnly
        initialPath="/repo"
        onConfirm={onConfirm}
      />,
    );

    await act(async () => {
      respondLs('/repo', [{ name: 'src', isDir: true }]);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('src').closest('.fb-node')!);
      respondLs('/repo/src', [{ name: 'app.ts', isDir: false }]);
    });

    const appRow = screen.getByText('app.ts').closest('.fb-node')!;
    fireEvent.contextMenu(appRow, { clientX: 50, clientY: 50 });

    // Non-destructive actions present; mutating actions absent in readOnly
    const menuEl = document.querySelector('.fb-context-menu') as HTMLElement;
    expect(menuEl).toBeTruthy();
    expect(within(menuEl).getByText('Copy path')).toBeTruthy();
    expect(within(menuEl).getByText('Copy Relative Path')).toBeTruthy();
    expect(within(menuEl).getByText('Open / Preview')).toBeTruthy();
    expect(within(menuEl).getByText('Insert @path')).toBeTruthy();
    expect(within(menuEl).queryByText('New File…')).toBeNull();
    expect(within(menuEl).queryByText('New Folder…')).toBeNull();
    expect(within(menuEl).queryByText('Rename')).toBeNull();
    expect(within(menuEl).queryByText('Delete')).toBeNull();

    await act(async () => {
      fireEvent.click(within(menuEl).getByText('Copy Relative Path'));
    });
    expect(writeText).toHaveBeenCalledWith('src/app.ts');

    fireEvent.contextMenu(appRow, { clientX: 50, clientY: 50 });
    const reopenedMenu = document.querySelector('.fb-context-menu') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(reopenedMenu).getByText('Insert @path'));
    });
    expect(onConfirm).toHaveBeenCalledWith(['/repo/src/app.ts']);
  });

  it('navigates tree with keyboard arrows, Enter, Delete, and skips shortcuts inside inputs', async () => {
    const { ws, respondLs, fsDelete, fsReadFile } = makeWsFactory();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false },
      ]);
    });

    const treeEl = container.querySelector('.fb-tree') as HTMLElement;
    // ArrowDown -> /repo -> /repo/src
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'ArrowDown' }); });
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'ArrowDown' }); });
    expect(within(treeEl).getByText('src').closest('.fb-node')?.classList.contains('focused')).toBe(true);

    // ArrowRight expands collapsed dir 'src'
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'ArrowRight' }); });
    await act(async () => {
      respondLs('/repo/src', [{ name: 'a.ts', isDir: false }]);
    });
    expect(within(treeEl).getByText('a.ts')).toBeTruthy();

    // ArrowRight again enters child a.ts
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'ArrowRight' }); });
    expect(within(treeEl).getByText('a.ts').closest('.fb-node')?.classList.contains('focused')).toBe(true);

    // Enter previews focused file
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'Enter' }); });
    expect(fsReadFile).toHaveBeenCalledWith('/repo/src/a.ts');

    // Typing Delete in search input MUST NOT delete the focused tree node
    const searchInput = screen.getByTestId('fb-nav-search-input');
    await act(async () => { fireEvent.keyDown(searchInput, { key: 'Delete' }); });
    expect(fsDelete).not.toHaveBeenCalled();

    // Delete on tree deletes focused node
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'Delete' }); });
    expect(confirmSpy).toHaveBeenCalled();
    expect(fsDelete).toHaveBeenCalledWith('/repo/src/a.ts');

    // ArrowLeft collapses back to parent
    await act(async () => { fireEvent.keyDown(treeEl, { key: 'ArrowLeft' }); });
    expect(within(treeEl).getByText('src').closest('.fb-node')?.classList.contains('focused')).toBe(true);
  });

  it('moves items via drag-and-drop and blocks self, same-parent, and descendant drops', async () => {
    const { ws, respondLs, fsRename } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="file-single" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [
        { name: 'src', isDir: true },
        { name: 'dest', isDir: true },
        { name: 'top.ts', isDir: false },
      ]);
    });

    const treeEl = container.querySelector('.fb-tree') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(treeEl).getByText('src').closest('.fb-node')!);
    });
    await act(async () => {
      respondLs('/repo/src', [{ name: 'nested', isDir: true }]);
    });

    const rootRow = container.querySelector('[data-path="/repo"]') as HTMLElement;
    const srcRow = container.querySelector('[data-path="/repo/src"]') as HTMLElement;
    const nestedRow = container.querySelector('[data-path="/repo/src/nested"]') as HTMLElement;
    const destRow = container.querySelector('[data-path="/repo/dest"]') as HTMLElement;

    // Guard 1: drop onto self
    fireEvent.dragStart(srcRow);
    fireEvent.drop(srcRow);
    expect(fsRename).not.toHaveBeenCalled();

    // Guard 2: drop onto own descendant
    fireEvent.dragOver(nestedRow);
    expect(nestedRow.classList.contains('drop-target')).toBe(false);
    fireEvent.drop(nestedRow);
    expect(fsRename).not.toHaveBeenCalled();

    // Guard 3: drop onto same parent (root)
    fireEvent.drop(rootRow);
    expect(fsRename).not.toHaveBeenCalled();
    fireEvent.dragEnd(srcRow);

    // Valid drop: /repo/src -> /repo/dest/src
    fireEvent.dragStart(srcRow);
    fireEvent.dragOver(destRow);
    expect(destRow.classList.contains('drop-target')).toBe(true);
    fireEvent.drop(destRow);
    expect(fsRename).toHaveBeenCalledWith('/repo/src', '/repo/dest/src');
    expect(destRow.classList.contains('drop-target')).toBe(false);
  });

  it('applies uncluttered panel classes and toggles fb-has-selection when multi-selecting', async () => {
    const { ws, respondLs } = makeWsFactory();
    const { container } = render(
      <FileBrowser ws={ws} mode="file-multi" layout="panel" initialPath="/repo" onConfirm={vi.fn()} />,
    );

    await act(async () => {
      respondLs('/repo', [{ name: 'a.ts', isDir: false }]);
    });

    const tree = container.querySelector('.fb-tree')!;
    expect(tree.classList.contains('fb-tree-panel')).toBe(true);
    expect(tree.classList.contains('fb-has-selection')).toBe(false);

    const checkbox = screen.getByText('a.ts').closest('.fb-node')!.querySelector('input[type="checkbox"]')!;
    await act(async () => { fireEvent.click(checkbox); });
    expect(tree.classList.contains('fb-has-selection')).toBe(true);
  });
});
