/**
 * @vitest-environment jsdom
 *
 * The table view of the file browser (remote desktop): column headers that
 * sort, the quick name filter, node-side re-queries for a listing the machine
 * cut, and the folds for an older machine and a narrow panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, act, cleanup, waitFor } from '@testing-library/preact';

vi.mock('../../src/components/FileEditor.js', () => ({ FileEditor: () => null, FileEditorContent: () => null }));
vi.mock('../../src/components/file-editor-lazy.js', () => ({ FileEditor: () => null, FileEditorContent: () => null }));
vi.mock('../../src/components/FilePreviewPane.js', () => ({ default: () => null }));
vi.mock('../../src/direct-file-transfer.js', () => ({
  FILE_DOWNLOAD_TRANSPORT_MODE: { CONNECTING: 'connecting', DIRECT: 'direct', FALLING_BACK: 'falling_back', HTTP: 'http', BROWSER: 'browser' },
  downloadPreviewWithDirectFallback: vi.fn().mockResolvedValue(undefined),
  prewarmDirectFileLease: vi.fn(() => undefined),
  selectPreviewDownloadDestination: vi.fn().mockResolvedValue(null),
  isDirectFileTransferStaleHandleError: vi.fn(() => false),
  isFileUploadCanceled: vi.fn(() => false),
}));
vi.mock('react-i18next', () => {
  // Reference-stable, and echoes interpolation so a test can read it back.
  const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key);
  const translation = { t };
  return { useTranslation: () => translation };
});

import { FileBrowser, __resetFileBrowserSharedChangesForTests } from '../../src/components/FileBrowser.js';
import type { WsClient, ServerMessage } from '../../src/ws-client.js';
import { fileBrowserSortStorageKey } from '../../src/file-browser-list-view.js';
import { fileBrowserColumnsStorageKey, fileBrowserTableMinWidth, FILE_BROWSER_HIDEABLE_COLUMNS } from '../../src/file-browser-list-view.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface TestEntry { name: string; isDir: boolean; size?: number; mtimeMs?: number; birthtimeMs?: number }

function makeWs() {
  const handlers = new Set<(msg: ServerMessage) => void>();
  let counter = 0;
  const calls: Array<{ requestId: string; path: string; options?: Record<string, unknown> }> = [];
  const fsListDir = vi.fn((path: string, _files?: boolean, _meta?: boolean, options?: Record<string, unknown>) => {
    counter += 1;
    const requestId = `req-${counter}`;
    calls.push({ requestId, path, options });
    return requestId;
  });
  const forgetOwnedDataRequest = vi.fn();
  const ws = {
    onMessage: (handler: (msg: ServerMessage) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    fsListDir,
    forgetOwnedDataRequest,
    fsGitStatus: vi.fn(() => 'git-1'),
    fsReadFile: vi.fn(() => 'read-1'),
    fsGitDiff: vi.fn(() => 'diff-1'),
  } as unknown as WsClient;
  const respond = (requestId: string, entries: TestEntry[], extra: Record<string, unknown> = {}, resolvedPath = '/data') => {
    act(() => {
      for (const handler of handlers) handler({
        type: 'fs.ls_response', requestId, path: resolvedPath, resolvedPath, status: 'ok',
        entries: entries.map((entry) => ({ ...entry, hidden: entry.name.startsWith('.') })),
        ...extra,
      } as unknown as ServerMessage);
    });
  };
  return { ws, calls, fsListDir, forgetOwnedDataRequest, respond, last: () => calls[calls.length - 1]! };
}

const FILES: TestEntry[] = [
  { name: 'Photos', isDir: true, mtimeMs: NOW - 5 * DAY, birthtimeMs: NOW - 90 * DAY },
  { name: 'report.pdf', isDir: false, size: 1536, mtimeMs: NOW - 2 * HOUR, birthtimeMs: NOW - 30 * DAY },
  { name: 'alpha.txt', isDir: false, size: 10, mtimeMs: NOW - 10 * DAY, birthtimeMs: NOW - 10 * DAY },
  { name: 'big.zip', isDir: false, size: 5_000_000, mtimeMs: NOW - 40 * DAY, birthtimeMs: NOW - 41 * DAY },
  { name: 'notes.md', isDir: false, size: 700, mtimeMs: NOW - 1 * DAY, birthtimeMs: NOW - 2 * DAY },
];

function mount(extra: Record<string, unknown> = {}, serverId: string | undefined = 'srv-1') {
  const harness = makeWs();
  const view = render(
    <FileBrowser
      ws={harness.ws}
      mode="file-single"
      layout="panel"
      initialPath="/data"
      serverId={serverId}
      readOnly
      hideFooter
      hideBreadcrumbConfirm
      listView
      onPreviewFile={() => {}}
      onConfirm={vi.fn()}
      {...extra}
    />,
  );
  return { ...harness, view };
}

const rowNames = (container: HTMLElement) => [...container.querySelectorAll('.fb-node-name')].map((el) => el.textContent).slice(1);
const header = (container: HTMLElement, key: string) => container.querySelector(`.fb-list-header-cell.fb-col-${key}`) as HTMLButtonElement;
const filterInput = (container: HTMLElement) => container.querySelector('.fb-list-filter-input') as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  __resetFileBrowserSharedChangesForTests();
});

describe('FileBrowser table view', () => {
  it('shows the five columns with a value in every cell', () => {
    const { view, respond, last } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const container = view.container as HTMLElement;
    expect(['name', 'size', 'kind', 'modified', 'created'].map((key) => header(container, key)?.querySelector('.fb-list-header-label')?.textContent))
      .toEqual(['file_browser.col.name', 'file_browser.col.size', 'file_browser.col.kind', 'file_browser.col.modified', 'file_browser.col.created']);
    const report = [...container.querySelectorAll('.fb-node')].find((row) => row.textContent?.includes('report.pdf'))!;
    const cells = [...report.querySelectorAll('.fb-col')].map((cell) => cell.textContent);
    expect(cells[0]).toBe('1.5 KB');
    expect(cells[1]).toBe('file_browser.kind.pdf');
    expect(cells[2]).toContain('file_browser.date_relative');
    expect(cells[2]).toContain('Today');
    expect(cells[3]).not.toBe('—');
    // The exact time is on hover.
    expect((report.querySelectorAll('.fb-col')[2] as HTMLElement).title).toMatch(/\d{4}/);
    // A folder has no size.
    const folder = [...container.querySelectorAll('.fb-node')].find((row) => row.textContent?.includes('Photos'))!;
    expect(folder.querySelector('.fb-col-size')?.textContent).toBe('—');
    expect(folder.querySelector('.fb-col-kind')?.textContent).toBe('file_browser.kind.folder');
  });

  it('sorts by a clicked header, flips on the second click, marks the active column and orders folders first', () => {
    const { view, respond, last } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const container = view.container as HTMLElement;
    expect(rowNames(container)).toEqual(['Photos', 'alpha.txt', 'big.zip', 'notes.md', 'report.pdf']);

    fireEvent.click(header(container, 'size'));
    expect(rowNames(container)).toEqual(['Photos', 'big.zip', 'report.pdf', 'notes.md', 'alpha.txt']);
    expect(header(container, 'size').getAttribute('aria-sort')).toBe('descending');
    expect(header(container, 'size').textContent).toContain('▼');
    expect(header(container, 'name').getAttribute('aria-sort')).toBe('none');

    fireEvent.click(header(container, 'size'));
    expect(rowNames(container)).toEqual(['Photos', 'alpha.txt', 'notes.md', 'report.pdf', 'big.zip']);
    expect(header(container, 'size').getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(header(container, 'modified'));
    expect(rowNames(container)).toEqual(['Photos', 'report.pdf', 'notes.md', 'alpha.txt', 'big.zip']);
    fireEvent.click(header(container, 'created'));
    expect(rowNames(container)).toEqual(['Photos', 'notes.md', 'alpha.txt', 'report.pdf', 'big.zip']);
    fireEvent.click(header(container, 'kind'));
    expect(rowNames(container)).toEqual(['Photos', 'big.zip', 'notes.md', 'report.pdf', 'alpha.txt']);

    // Folders first can be turned off.
    fireEvent.click(container.querySelector('.fb-list-dirs-first input') as HTMLInputElement);
    expect(rowNames(container)[0]).not.toBe('Photos');
  });

  it('a complete listing re-sorts with no request at all', () => {
    const { view, respond, last, fsListDir } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const before = fsListDir.mock.calls.length;
    fireEvent.click(header(view.container as HTMLElement, 'size'));
    fireEvent.click(header(view.container as HTMLElement, 'modified'));
    expect(fsListDir.mock.calls.length).toBe(before);
  });

  it('remembers the sort per machine and survives a remount, and blocked storage does not break it', () => {
    const first = mount({ directoryQuery: true }, 'srv-a');
    first.respond(first.last().requestId, FILES, {});
    fireEvent.click(header(first.view.container as HTMLElement, 'size'));
    expect(JSON.parse(localStorage.getItem(fileBrowserSortStorageKey('srv-a'))!)).toMatchObject({ key: 'size', direction: 'desc' });
    first.view.unmount();

    const again = mount({ directoryQuery: true }, 'srv-a');
    again.respond(again.last().requestId, FILES, {});
    expect(rowNames(again.view.container as HTMLElement)[1]).toBe('big.zip');
    again.view.unmount();

    const other = mount({ directoryQuery: true }, 'srv-b');
    other.respond(other.last().requestId, FILES, {});
    expect(rowNames(other.view.container as HTMLElement)[1]).toBe('alpha.txt');
    other.view.unmount();

    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const quiet = mount({ directoryQuery: true }, 'srv-c');
    quiet.respond(quiet.last().requestId, FILES, {});
    expect(() => fireEvent.click(header(quiet.view.container as HTMLElement, 'size'))).not.toThrow();
    expect(rowNames(quiet.view.container as HTMLElement)[1]).toBe('big.zip');
    blocked.mockRestore();
  });
});

describe('FileBrowser table view: quick name filter', () => {
  it('filters as you type, with every word needed, and costs no request on a complete listing', async () => {
    const { view, respond, last, fsListDir } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const container = view.container as HTMLElement;
    const before = fsListDir.mock.calls.length;
    fireEvent.input(filterInput(container), { target: { value: 'REPORT pdf' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['report.pdf']));
    fireEvent.input(filterInput(container), { target: { value: 'report zip' } });
    await waitFor(() => expect(rowNames(container)).toEqual([]));
    expect(container.querySelector('.fb-node-empty')?.textContent).toContain('file_browser.filter_empty');
    expect(container.querySelector('.fb-node-empty')?.textContent).toContain('report zip');
    expect(fsListDir.mock.calls.length).toBe(before);
  });

  it('clears with the button and with Escape, restoring the full list', async () => {
    const { view, respond, last } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const container = view.container as HTMLElement;
    fireEvent.input(filterInput(container), { target: { value: 'alpha' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['alpha.txt']));
    fireEvent.click(container.querySelector('.fb-list-filter-clear') as HTMLButtonElement);
    expect(rowNames(container)).toHaveLength(5);
    expect(filterInput(container).value).toBe('');

    fireEvent.input(filterInput(container), { target: { value: 'alpha' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['alpha.txt']));
    fireEvent.keyDown(filterInput(container), { key: 'Escape' });
    expect(rowNames(container)).toHaveLength(5);
  });

  it('does not filter in the middle of an IME composition and filters on its end', async () => {
    const { view, respond, last } = mount({ directoryQuery: true });
    respond(last().requestId, [{ name: '报告.pdf', isDir: false, size: 1 }, { name: 'other.txt', isDir: false, size: 1 }], {});
    const container = view.container as HTMLElement;
    const input = filterInput(container);
    act(() => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    fireEvent.input(input, { target: { value: 'b' } });
    fireEvent.input(input, { target: { value: 'bao' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Nothing was filtered by the pinyin letters, and none of them was lost.
    expect(rowNames(container)).toHaveLength(2);
    expect(input.value).toBe('bao');
    fireEvent.input(input, { target: { value: '报告' } });
    act(() => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await waitFor(() => expect(rowNames(container)).toEqual(['报告.pdf']));
    expect(input.value).toBe('报告');
  });

  it('keeps the parents of a match open and clears the filter on navigation but keeps the sort', async () => {
    const { view, respond, last, calls } = mount({ directoryQuery: true });
    respond(last().requestId, FILES, {});
    const container = view.container as HTMLElement;
    fireEvent.click(header(container, 'size'));
    fireEvent.input(filterInput(container), { target: { value: 'alpha' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['alpha.txt']));
    fireEvent.click(container.querySelector('button[title="Go up"]') as HTMLButtonElement);
    expect(filterInput(container).value).toBe('');
    // The new directory is listed with no filter and the remembered sort.
    expect(calls[calls.length - 1]!.options).toMatchObject({ query: { sort: { key: 'size', direction: 'desc' } } });
    expect(calls[calls.length - 1]!.options!.query as Record<string, unknown>).not.toHaveProperty('nameFilter');
  });
});

describe('FileBrowser table view: a listing the machine cut', () => {
  it('asks the machine with the sort and filter, says what was cut, and asks again when they change', async () => {
    const { view, respond, last, calls } = mount({ directoryQuery: true });
    expect(calls[0]!.options).toMatchObject({ query: { sort: { key: 'name', direction: 'asc', dirsFirst: true } } });
    respond(calls[0]!.requestId, FILES, { truncated: true, total: 5002 });
    const container = view.container as HTMLElement;
    expect(container.querySelector('.fb-list-notice')?.textContent).toContain('file_browser.notice_truncated');
    expect(container.querySelector('.fb-list-notice')?.textContent).toContain('5002');

    fireEvent.click(header(container, 'modified'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.options).toMatchObject({ query: { sort: { key: 'modified', direction: 'desc' } } });

    fireEvent.input(filterInput(container), { target: { value: 'zz' } });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.options).toMatchObject({ query: { sort: { key: 'modified' }, nameFilter: 'zz' } });
    expect(last().requestId).toBe(calls[2]!.requestId);
  });

  it('says when the order covers only part of the matches, cut or not', async () => {
    const cut = mount({ directoryQuery: true });
    cut.respond(cut.calls[0]!.requestId, FILES, { truncated: true, total: 90_000, partial: true });
    expect((cut.view.container as HTMLElement).querySelector('.fb-list-notice')?.textContent).toContain('file_browser.notice_truncated_partial');
    expect((cut.view.container as HTMLElement).querySelector('.fb-list-notice')?.textContent).toContain('50,000');
    cut.view.unmount();

    const notCut = mount({ directoryQuery: true });
    notCut.respond(notCut.calls[0]!.requestId, FILES, { partial: true });
    const container = notCut.view.container as HTMLElement;
    expect(container.querySelector('.fb-list-notice')?.textContent).toContain('file_browser.notice_partial');
    // An order built from only part of the matches is re-asked, not re-sorted here.
    fireEvent.click(header(container, 'size'));
    await waitFor(() => expect(notCut.calls).toHaveLength(2));
  });

  it('only the answer to the LAST ask is used; a superseded request is forgotten and its late answer dropped', async () => {
    const { view, respond, calls, forgetOwnedDataRequest } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, { truncated: true, total: 900 });
    const container = view.container as HTMLElement;
    fireEvent.click(header(container, 'size'));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(header(container, 'modified'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(forgetOwnedDataRequest).toHaveBeenCalledWith(calls[1]!.requestId);

    // The size answer arrives after the modified ask was made.
    respond(calls[1]!.requestId, [{ name: 'stale.bin', isDir: false, size: 9 }], { truncated: true, total: 900 });
    expect(rowNames(container)).not.toContain('stale.bin');
    respond(calls[2]!.requestId, [{ name: 'fresh.bin', isDir: false, mtimeMs: NOW, size: 1 }], { truncated: true, total: 900 });
    expect(rowNames(container)).toEqual(['fresh.bin']);
  });

  it('a listing narrowed by name is not complete: clearing the filter asks for the whole directory again', async () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    // Typed filter on a complete listing: handled here, no request.
    fireEvent.input(filterInput(container), { target: { value: 'alpha' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['alpha.txt']));
    expect(calls).toHaveLength(1);
    // A directory first listed WITH a filter holds only the matches.
    fireEvent.click(container.querySelector('button[title="Go up"]') as HTMLButtonElement);
    const afterUp = calls.length;
    respond(calls[afterUp - 1]!.requestId, FILES, {}, '/');
    fireEvent.input(filterInput(container), { target: { value: 'notes' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['notes.md']));
    expect(calls).toHaveLength(afterUp);
  });

  it('a filtered listing is re-asked when the filter is cleared', async () => {
    const harness = makeWs();
    const view = render(
      <FileBrowser ws={harness.ws} mode="file-single" layout="panel" initialPath="/data" serverId="srv-1" readOnly listView directoryQuery onPreviewFile={() => {}} onConfirm={vi.fn()} />,
    );
    const container = view.container as HTMLElement;
    harness.respond(harness.calls[0]!.requestId, FILES, { truncated: true, total: 2000 });
    fireEvent.input(filterInput(container), { target: { value: 'alpha' } });
    await waitFor(() => expect(harness.calls).toHaveLength(2));
    harness.respond(harness.calls[1]!.requestId, [FILES[2]!], {});
    expect(rowNames(container)).toEqual(['alpha.txt']);
    fireEvent.click(container.querySelector('.fb-list-filter-clear') as HTMLButtonElement);
    await waitFor(() => expect(harness.calls).toHaveLength(3));
    expect(harness.calls[2]!.options!.query as Record<string, unknown>).not.toHaveProperty('nameFilter');
  });
});

describe('FileBrowser table view: an older machine', () => {
  const PLAIN: TestEntry[] = [{ name: 'b.txt', isDir: false }, { name: 'a.txt', isDir: false }, { name: 'dir', isDir: true }];

  it('sends no query, shows a dash with the reason, disables the columns it cannot fill, and still sorts by name and kind', () => {
    const { view, respond, calls } = mount({ directoryQuery: false });
    expect(calls[0]!.options).toBeUndefined();
    respond(calls[0]!.requestId, PLAIN, {});
    const container = view.container as HTMLElement;
    for (const key of ['size', 'modified', 'created']) {
      expect(header(container, key).disabled).toBe(true);
      expect(header(container, key).title).toBe('file_browser.meta_unsupported');
    }
    expect(header(container, 'name').disabled).toBe(false);
    expect(header(container, 'kind').disabled).toBe(false);
    const row = [...container.querySelectorAll('.fb-node')].find((el) => el.textContent?.includes('a.txt'))!;
    expect(row.querySelector('.fb-col-modified')?.textContent).toBe('—');
    expect((row.querySelector('.fb-col-modified') as HTMLElement).title).toBe('file_browser.meta_unsupported');
    expect(rowNames(container)).toEqual(['dir', 'a.txt', 'b.txt']);
    fireEvent.click(header(container, 'name'));
    expect(rowNames(container)).toEqual(['dir', 'b.txt', 'a.txt']);
  });

  it('falls back to the name when the remembered sort needs details the machine does not send', () => {
    localStorage.setItem(fileBrowserSortStorageKey('srv-1'), JSON.stringify({ key: 'modified', direction: 'desc', dirsFirst: true }));
    const { view, respond, calls } = mount({ directoryQuery: false });
    respond(calls[0]!.requestId, PLAIN, {});
    expect(rowNames(view.container as HTMLElement)).toEqual(['dir', 'a.txt', 'b.txt']);
  });

  it('says when a plain listing hit the old 512-entry cut', () => {
    const { view, respond, calls } = mount({ directoryQuery: false });
    respond(calls[0]!.requestId, Array.from({ length: 512 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.txt`, isDir: false })), {});
    expect((view.container as HTMLElement).querySelector('.fb-list-notice')?.textContent).toContain('file_browser.notice_capped');
  });

  it('the Windows drive list is not "an older machine": its entries have no details by nature, so no column is disabled or explained away', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, [{ name: 'C:\\', isDir: true }, { name: 'D:\\', isDir: true }], {}, '__imcodes_windows_drives__');
    const container = view.container as HTMLElement;
    for (const key of ['size', 'modified', 'created']) {
      expect(header(container, key).disabled).toBe(false);
      expect(header(container, key).title).not.toBe('file_browser.meta_unsupported');
    }
    const row = [...container.querySelectorAll('.fb-node')].find((el) => el.textContent?.includes('C:'))!;
    expect((row.querySelector('.fb-col-modified') as HTMLElement).title).toBe('');
    expect(container.textContent).not.toContain('file_browser.meta_unsupported');
  });

  it('a machine that reports no creation time (Linux) disables only that column', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES.map(({ birthtimeMs: _drop, ...rest }) => rest), {});
    const container = view.container as HTMLElement;
    expect(header(container, 'created').disabled).toBe(true);
    expect(header(container, 'created').title).toBe('file_browser.created_unavailable');
    expect(header(container, 'modified').disabled).toBe(false);
    const row = [...container.querySelectorAll('.fb-node')].find((el) => el.textContent?.includes('alpha.txt'))!;
    expect((row.querySelector('.fb-col-created') as HTMLElement).title).toBe('file_browser.created_unavailable');
  });
});

describe('FileBrowser table view: other hosts and narrow panels', () => {
  it('is off unless asked for: no chrome, no columns, no query', () => {
    const { view, respond, calls } = mount({ listView: false, directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    expect(container.querySelector('.fb-list-chrome')).toBeNull();
    expect(container.querySelector('.fb-col')).toBeNull();
    expect(calls[0]!.options).toBeUndefined();
  });

  it('widens the table (header and rows share it) for every level of nested folders it shows', () => {
    const { view, respond, calls, last } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, [{ name: 'd1', isDir: true, mtimeMs: NOW }, { name: 'f.txt', isDir: false, size: 1, mtimeMs: NOW }], {});
    const container = view.container as HTMLElement;
    const tableMin = () => parseInt((container.querySelector('.fb-table-scroll') as HTMLElement).style.getPropertyValue('--fb-table-min'), 10);
    const flat = tableMin();
    expect(flat).toBe(fileBrowserTableMinWidth(new Set(['name', ...FILE_BROWSER_HIDEABLE_COLUMNS]) as never));
    let path = '/data';
    for (let level = 1; level <= 5; level += 1) {
      const name = `d${level}`;
      const row = [...container.querySelectorAll('.fb-node')].find((el) => el.querySelector('.fb-node-name')?.textContent === name)!;
      fireEvent.click(row);
      path = `${path}/${name}`;
      respond(last().requestId, [{ name: `d${level + 1}`, isDir: true, mtimeMs: NOW }], {}, path);
    }
    // d1..d5 are expanded and d6 is shown: six levels below the root, four of them past the ones the name column absorbs.
    expect(tableMin()).toBe(flat + 16 * 4);
    // Collapsing the deepest folders takes the extra width away again.
    fireEvent.click([...container.querySelectorAll('.fb-node')].find((el) => el.querySelector('.fb-node-name')?.textContent === 'd1')!);
    expect(tableMin()).toBe(flat);
  });

  it('is a table at ANY width: the same aligned header and cells in a 360 px container, which scrolls sideways instead of folding', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    // Nothing is folded into a second line, whatever the width.
    expect(container.querySelector('.fb-node-meta')).toBeNull();
    expect(container.querySelector('.is-narrow')).toBeNull();
    const headers = [...container.querySelectorAll('.fb-list-header-cell')].map((cell) => cell.className.match(/fb-col-(\w+)/)![1]);
    expect(headers).toEqual(['name', 'size', 'kind', 'modified', 'created']);
    const report = [...container.querySelectorAll('.fb-node')].find((row) => row.textContent?.includes('report.pdf'))!;
    expect([...report.querySelectorAll('.fb-col')].map((cell) => cell.className.match(/fb-col-(\w+)/)![1])).toEqual(['size', 'kind', 'modified', 'created']);
    // The table is as wide as its columns need, in the scroll box that holds the header and the rows together.
    const scroll = container.querySelector('.fb-table-scroll') as HTMLElement;
    expect(scroll.contains(container.querySelector('.fb-list-header'))).toBe(true);
    expect(scroll.contains(report)).toBe(true);
    const all = new Set(['name', 'size', 'kind', 'modified', 'created']) as never;
    expect(scroll.style.getPropertyValue('--fb-table-min')).toBe(`${fileBrowserTableMinWidth(all)}px`);
    expect(fileBrowserTableMinWidth(all)).toBeGreaterThan(360);
    // The toolbar (filter, columns) is outside the scroll box, so it does not slide away sideways.
    expect(scroll.contains(container.querySelector('.fb-list-toolbar'))).toBe(false);
    // Still sortable from the header.
    fireEvent.click(header(container, 'size'));
    expect(rowNames(container)[1]).toBe('big.zip');
    width.mockRestore();
  });

  it('every row has the cells of every visible column, in the header\'s order, including a row that is missing details', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, [...FILES, { name: 'mystery.bin', isDir: false }], {});
    const container = view.container as HTMLElement;
    const rows = [...container.querySelectorAll('.fb-node')].slice(1);
    for (const row of rows) {
      expect([...row.querySelectorAll('.fb-col')].map((cell) => cell.className.match(/fb-col-(\w+)/)![1]), row.textContent ?? '').toEqual(['size', 'kind', 'modified', 'created']);
    }
    const mystery = rows.find((row) => row.textContent?.includes('mystery.bin'))!;
    expect([...mystery.querySelectorAll('.fb-col-size, .fb-col-modified, .fb-col-created')].map((cell) => cell.textContent)).toEqual(['—', '—', '—']);
  });
});

describe('FileBrowser table view: columns menu', () => {
  const cells = (container: HTMLElement) => [...container.querySelectorAll('.fb-list-header-cell')].map((cell) => cell.className.match(/fb-col-(\w+)/)![1]);
  const toggle = (container: HTMLElement, name: string) => {
    const item = [...container.querySelectorAll('.fb-columns-item')].find((label) => label.textContent === name)!;
    fireEvent.click(item.querySelector('input') as HTMLInputElement);
  };

  it('shows every column by default and offers all four hideable ones, but never the name', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    expect(cells(container)).toEqual(['name', 'size', 'kind', 'modified', 'created']);
    expect(container.querySelector('.fb-columns-badge')).toBeNull();
    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    expect([...container.querySelectorAll('.fb-columns-item')].map((label) => label.textContent))
      .toEqual(FILE_BROWSER_HIDEABLE_COLUMNS.map((column) => `file_browser.col.${column}`));
    expect((container.querySelector('.fb-columns-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides a column from the header and every row, says so on the button (never silently), and brings it back', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    toggle(container, 'file_browser.col.kind');
    toggle(container, 'file_browser.col.created');
    expect(cells(container)).toEqual(['name', 'size', 'modified']);
    const report = [...container.querySelectorAll('.fb-node')].find((row) => row.textContent?.includes('report.pdf'))!;
    expect([...report.querySelectorAll('.fb-col')].map((cell) => cell.className.match(/fb-col-(\w+)/)![1])).toEqual(['size', 'modified']);
    // The button itself says how many are hidden, in the closed state too.
    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    expect(container.querySelector('.fb-columns-badge')?.textContent).toContain('file_browser.columns_hidden');
    expect(container.querySelector('.fb-columns-badge')?.textContent).toContain('"n":2');
    // The table gets narrower with its columns.
    const scroll = container.querySelector('.fb-table-scroll') as HTMLElement;
    expect(scroll.style.getPropertyValue('--fb-table-min')).toBe(`${fileBrowserTableMinWidth(new Set(['name', 'size', 'modified']) as never)}px`);

    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    toggle(container, 'file_browser.col.kind');
    expect(cells(container)).toEqual(['name', 'size', 'kind', 'modified']);
    fireEvent.click(container.querySelector('.fb-columns-reset') as HTMLButtonElement);
    expect(cells(container)).toEqual(['name', 'size', 'kind', 'modified', 'created']);
    expect(container.querySelector('.fb-columns-badge')).toBeNull();
  });

  it('remembers the hidden columns per machine, survives a remount, and blocked or corrupt storage just shows everything', () => {
    const first = mount({ directoryQuery: true }, 'srv-a');
    first.respond(first.calls[0]!.requestId, FILES, {});
    fireEvent.click((first.view.container as HTMLElement).querySelector('.fb-columns-button') as HTMLButtonElement);
    toggle(first.view.container as HTMLElement, 'file_browser.col.modified');
    expect(JSON.parse(localStorage.getItem(fileBrowserColumnsStorageKey('srv-a'))!)).toEqual(['modified']);
    first.view.unmount();

    const again = mount({ directoryQuery: true }, 'srv-a');
    again.respond(again.calls[0]!.requestId, FILES, {});
    expect(cells(again.view.container as HTMLElement)).toEqual(['name', 'size', 'kind', 'created']);
    again.view.unmount();

    const other = mount({ directoryQuery: true }, 'srv-b');
    other.respond(other.calls[0]!.requestId, FILES, {});
    expect(cells(other.view.container as HTMLElement)).toEqual(['name', 'size', 'kind', 'modified', 'created']);
    other.view.unmount();

    localStorage.setItem(fileBrowserColumnsStorageKey('srv-c'), '{"not":"an array"');
    const corrupt = mount({ directoryQuery: true }, 'srv-c');
    corrupt.respond(corrupt.calls[0]!.requestId, FILES, {});
    expect(cells(corrupt.view.container as HTMLElement)).toEqual(['name', 'size', 'kind', 'modified', 'created']);
    corrupt.view.unmount();

    // Names that are not columns (or the name column) in storage are ignored.
    localStorage.setItem(fileBrowserColumnsStorageKey('srv-d'), JSON.stringify(['name', 'owner', 'size']));
    const junk = mount({ directoryQuery: true }, 'srv-d');
    junk.respond(junk.calls[0]!.requestId, FILES, {});
    expect(cells(junk.view.container as HTMLElement)).toEqual(['name', 'kind', 'modified', 'created']);
    junk.view.unmount();

    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const quiet = mount({ directoryQuery: true }, 'srv-e');
    quiet.respond(quiet.calls[0]!.requestId, FILES, {});
    fireEvent.click((quiet.view.container as HTMLElement).querySelector('.fb-columns-button') as HTMLButtonElement);
    expect(() => toggle(quiet.view.container as HTMLElement, 'file_browser.col.size')).not.toThrow();
    expect(cells(quiet.view.container as HTMLElement)).toEqual(['name', 'kind', 'modified', 'created']);
    blocked.mockRestore();
  });

  it('says the list is ordered by the name when the remembered column is one this machine cannot serve', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    // An older machine: no creation times, so a remembered "created" order falls back to the name.
    localStorage.setItem(fileBrowserSortStorageKey('srv-1'), JSON.stringify({ key: 'created', direction: 'asc', dirsFirst: true }));
    view.unmount();
    const again = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    again.respond(again.calls[0]!.requestId, FILES.map(({ birthtimeMs: _drop, ...rest }) => rest), {});
    const container = again.view.container as HTMLElement;
    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    toggle(container, 'file_browser.col.created');
    const label = container.querySelector('.fb-list-sorted-by')?.textContent ?? '';
    expect(label).not.toContain('file_browser.col.created');
  });

  it('keeps sorting by a column that is hidden and says what the list is sorted by', () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    fireEvent.click(header(container, 'modified'));
    expect(container.querySelector('.fb-list-sorted-by')).toBeNull();
    const order = rowNames(container);
    fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    toggle(container, 'file_browser.col.modified');
    expect(rowNames(container)).toEqual(order);
    expect(container.querySelector('.fb-list-sorted-by')?.textContent).toContain('file_browser.sorted_by');
    expect(container.querySelector('.fb-list-sorted-by')?.textContent).toContain('file_browser.col.modified');
  });

  it('closes on Escape and on a click outside, and the filter and sorting still work with columns hidden', async () => {
    const { view, respond, calls } = mount({ directoryQuery: true });
    respond(calls[0]!.requestId, FILES, {});
    const container = view.container as HTMLElement;
    const open = () => fireEvent.click(container.querySelector('.fb-columns-button') as HTMLButtonElement);
    const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    open();
    expect(container.querySelector('.fb-columns-popover')).not.toBeNull();
    await settled(); // the menu's own listeners attach after paint
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.fb-columns-popover')).toBeNull());
    open();
    await waitFor(() => expect(container.querySelector('.fb-columns-popover')).not.toBeNull());
    await settled();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(container.querySelector('.fb-columns-popover')).toBeNull());
    open();
    await waitFor(() => expect(container.querySelector('.fb-columns-popover')).not.toBeNull());
    toggle(container, 'file_browser.col.size');
    fireEvent.input(filterInput(container), { target: { value: 'notes' } });
    await waitFor(() => expect(rowNames(container)).toEqual(['notes.md']));
  });
});
