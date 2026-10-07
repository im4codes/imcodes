import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  apiFetch,
}));

import { listMachineDirectories } from '../src/api/machines.js';
import { MachineDirectoryWsAdapter } from '../src/machine-directory-ws-adapter.js';
import type { FileDirectoryListQuery } from '@shared/transport/file-transfer.js';

afterEach(() => apiFetch.mockReset());

const QUERY: FileDirectoryListQuery = { sort: { key: 'modified', direction: 'desc', dirsFirst: true }, nameFilter: 'report' };
const entry = { name: 'a.txt', path: '/d/a.txt', isDir: false, hidden: false };

describe('listMachineDirectories', () => {
  it('sends only the path for a plain listing, so an older server (which rejects any other field) still accepts it', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry] });
    await listMachineDirectories('srv', '/d');
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ path: '/d' });
  });

  it('sends the query when given one', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry] });
    await listMachineDirectories('srv', '/d', undefined, QUERY);
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ path: '/d', query: QUERY });
  });

  it('keeps file details and the truncation report, and drops values that are not real numbers', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      resolvedPath: '/d',
      entries: [
        { ...entry, size: 5, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 },
        { ...entry, name: 'bad.txt', path: '/d/bad.txt', size: -1, mtimeMs: 'yesterday', birthtimeMs: Number.NaN },
      ],
      truncated: true,
      total: 5002,
      partial: true,
    });
    const result = await listMachineDirectories('srv', '/d', undefined, QUERY);
    expect(result).toEqual({
      resolvedPath: '/d',
      entries: [
        { ...entry, size: 5, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 },
        { ...entry, name: 'bad.txt', path: '/d/bad.txt' },
      ],
      truncated: true,
      total: 5002,
      partial: true,
    });
  });

  it('ignores a truncation flag without a usable total, and an answer from an older server has no extra fields at all', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry], truncated: true, total: 'many', partial: true });
    expect(await listMachineDirectories('srv', '/d')).toEqual({ resolvedPath: '/d', entries: [entry] });
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry] });
    expect(await listMachineDirectories('srv', '/d')).toEqual({ resolvedPath: '/d', entries: [entry] });
  });
});

describe('MachineDirectoryWsAdapter listing query', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('forwards the query only when the node supports it', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry] });
    new MachineDirectoryWsAdapter('srv', { supportsQuery: true }).fsListDir('/d', true, false, { query: QUERY });
    await flush();
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ path: '/d', query: QUERY });

    apiFetch.mockClear();
    new MachineDirectoryWsAdapter('srv', { supportsQuery: false }).fsListDir('/d', true, false, { query: QUERY });
    new MachineDirectoryWsAdapter('srv').fsListDir('/d', true, false, { query: QUERY });
    await flush();
    expect(apiFetch.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([{ path: '/d' }, { path: '/d' }]);
  });

  it('relays details and truncation in the fs.ls_response the browser consumes', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [{ ...entry, mtimeMs: 7 }], truncated: true, total: 900, partial: true });
    const adapter = new MachineDirectoryWsAdapter('srv', { supportsQuery: true });
    const seen: unknown[] = [];
    adapter.onMessage((message) => seen.push(message));
    const requestId = adapter.fsListDir('/d', true, false, { query: QUERY });
    await flush();
    expect(seen).toEqual([expect.objectContaining({
      type: 'fs.ls_response', requestId, status: 'ok', resolvedPath: '/d', truncated: true, total: 900, partial: true,
      entries: [{ ...entry, mtimeMs: 7 }],
    })]);
  });

  it('a plain answer carries no truncation fields', async () => {
    apiFetch.mockResolvedValue({ ok: true, resolvedPath: '/d', entries: [entry] });
    const adapter = new MachineDirectoryWsAdapter('srv');
    const seen: Array<Record<string, unknown>> = [];
    adapter.onMessage((message) => seen.push(message as unknown as Record<string, unknown>));
    adapter.fsListDir('/d');
    await flush();
    expect(seen[0]).not.toHaveProperty('truncated');
    expect(seen[0]).not.toHaveProperty('partial');
  });
});
