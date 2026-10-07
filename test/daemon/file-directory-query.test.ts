import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, realpath, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildQueriedDirectoryListing } from '../../src/daemon/file-directory-query.js';
import { FILE_TRANSFER_DIRECTORY_MAX_ENTRIES, type FileDirectoryListQuery } from '../../shared/transport/file-transfer.js';

const sortBy = (key: FileDirectoryListQuery['sort']['key'], direction: 'asc' | 'desc' = 'asc', dirsFirst = true, nameFilter?: string): FileDirectoryListQuery => ({
  sort: { key, direction, dirsFirst },
  ...(nameFilter !== undefined ? { nameFilter } : {}),
});

const direntsOf = async (dir: string) => (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isFile());

describe('node-side directory query (filter, order, THEN truncate)', () => {
  let dir: string;
  beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(tmpdir(), 'imcodes-dir-query-'))); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function makeBigDirectory(count: number): Promise<void> {
    const base = Date.UTC(2026, 0, 1) / 1000;
    for (let start = 0; start < count; start += 250) {
      await Promise.all(Array.from({ length: Math.min(250, count - start) }, async (_, offset) => {
        const index = start + offset;
        const file = path.join(dir, `file-${String(index).padStart(5, '0')}.txt`);
        await writeFile(file, 'x'.repeat(index % 7));
        await utimes(file, base + index, base + index);
      }));
    }
  }

  it('a 5000-file directory: the newest file by mtime is first even though its name sorts past the 512 cut', async () => {
    await makeBigDirectory(5000);
    const newest = path.join(dir, 'zzz-newest.log');
    await writeFile(newest, 'new');
    await utimes(newest, Date.UTC(2030, 0, 1) / 1000, Date.UTC(2030, 0, 1) / 1000);
    const oldest = path.join(dir, 'zzz-oldest.log');
    await writeFile(oldest, 'old');
    await utimes(oldest, 1, 1);

    const dirents = await direntsOf(dir);
    const byTime = await buildQueriedDirectoryListing({ realPath: dir, dirents, query: sortBy('modified', 'desc') });
    expect(byTime.entries).toHaveLength(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    expect(byTime.entries[0]!.name).toBe('zzz-newest.log');
    expect(byTime.entries[0]!.mtimeMs).toBe(Date.UTC(2030, 0, 1));
    expect(byTime.truncated).toBe(true);
    expect(byTime.total).toBe(5002);
    expect(byTime.partial).toBeUndefined();

    const oldestFirst = await buildQueriedDirectoryListing({ realPath: dir, dirents, query: sortBy('modified', 'asc') });
    expect(oldestFirst.entries[0]!.name).toBe('zzz-oldest.log');
  });

  it('a name filter finds a file that the first-512-by-name cut would hide', async () => {
    await makeBigDirectory(2000);
    await writeFile(path.join(dir, 'zz-quarterly Report.PDF'), 'r');
    const result = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('name', 'asc', true, 'quarterly report') });
    expect(result.entries.map((e) => e.name)).toEqual(['zz-quarterly Report.PDF']);
    expect(result.truncated).toBeUndefined();
  });

  it('size sort is by bytes over the whole directory, and directories carry no size', async () => {
    await makeBigDirectory(1000);
    await writeFile(path.join(dir, 'zzz-biggest.bin'), 'y'.repeat(100_000));
    await mkdir(path.join(dir, 'a-folder'));
    const result = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('size', 'desc', false) });
    expect(result.entries[0]).toMatchObject({ name: 'zzz-biggest.bin', size: 100_000 });
    const folder = result.entries.find((e) => e.name === 'a-folder');
    // No size for a directory, and with the missing value last it is not in the first 512.
    expect(folder).toBeUndefined();
    const dirsFirst = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('size', 'desc', true) });
    expect(dirsFirst.entries[0]!.name).toBe('a-folder');
    expect(dirsFirst.entries[0]).not.toHaveProperty('size');
  });

  it('keeps an entry whose stat fails, without metadata, ordered last', async () => {
    await writeFile(path.join(dir, 'ok.txt'), 'abc');
    await writeFile(path.join(dir, 'broken.txt'), 'abc');
    const result = await buildQueriedDirectoryListing({
      realPath: dir,
      dirents: await direntsOf(dir),
      query: sortBy('modified', 'desc'),
      statEntry: async (full) => (full.endsWith('broken.txt') ? null : { size: 3, mtimeMs: 1_000, birthtimeMs: 1_000 }),
    });
    expect(result.entries.map((e) => e.name)).toEqual(['ok.txt', 'broken.txt']);
    expect(result.entries[1]).not.toHaveProperty('mtimeMs');
    expect(result.entries[1]).not.toHaveProperty('size');
  });

  it('never passes a ctime off as a creation time: only win32 and darwin report birthtime', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'abc');
    const dirents = await direntsOf(dir);
    const stat = async () => ({ size: 3, mtimeMs: 2_000, birthtimeMs: 1_000 });
    const linux = await buildQueriedDirectoryListing({ realPath: dir, dirents, query: sortBy('name'), statEntry: stat, platform: 'linux' });
    expect(linux.entries[0]).toMatchObject({ mtimeMs: 2_000 });
    expect(linux.entries[0]).not.toHaveProperty('birthtimeMs');
    for (const platform of ['win32', 'darwin'] as const) {
      const result = await buildQueriedDirectoryListing({ realPath: dir, dirents, query: sortBy('name'), statEntry: stat, platform });
      expect(result.entries[0]).toMatchObject({ birthtimeMs: 1_000 });
    }
    const zeroBirth = await buildQueriedDirectoryListing({ realPath: dir, dirents, query: sortBy('name'), statEntry: async () => ({ size: 3, mtimeMs: 2_000, birthtimeMs: 0 }), platform: 'darwin' });
    expect(zeroBirth.entries[0]).not.toHaveProperty('birthtimeMs');
  });

  it('bounds the stat pass: past the entry limit the order is over the first ones and the answer says partial', async () => {
    await makeBigDirectory(40);
    const stats: string[] = [];
    const result = await buildQueriedDirectoryListing({
      realPath: dir,
      dirents: await direntsOf(dir),
      query: sortBy('modified', 'desc'),
      maxStatEntries: 10,
      statEntry: async (full) => { stats.push(full); return { size: 1, mtimeMs: 5_000, birthtimeMs: 5_000 }; },
    });
    expect(stats).toHaveLength(10);
    expect(result.partial).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(10);
  });

  it('bounds the stat pass in time: entries not stat\'d before the budget are dropped from the order and the answer says partial', async () => {
    await makeBigDirectory(40);
    let clock = 0;
    const result = await buildQueriedDirectoryListing({
      realPath: dir,
      dirents: await direntsOf(dir),
      query: sortBy('size', 'asc'),
      budgetMs: 100,
      now: () => clock,
      statEntry: async () => { clock += 30; return { size: 1, mtimeMs: 1, birthtimeMs: 1 }; },
    });
    expect(result.partial).toBe(true);
    expect(result.entries.filter((e) => e.size !== undefined).length).toBeLessThan(40);
  });

  it('a name sort only stats the entries it returns', async () => {
    await makeBigDirectory(2000);
    let statCalls = 0;
    const result = await buildQueriedDirectoryListing({
      realPath: dir,
      dirents: await direntsOf(dir),
      query: sortBy('name'),
      statEntry: async () => { statCalls += 1; return { size: 1, mtimeMs: 1, birthtimeMs: 1 }; },
    });
    expect(result.entries).toHaveLength(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    expect(statCalls).toBe(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    expect(result.total).toBe(2000);
  });

  it('treats the filter as plain text: regex syntax matches literally and never throws', async () => {
    await writeFile(path.join(dir, 'a.b(c)+.txt'), 'x');
    await writeFile(path.join(dir, 'axb.txt'), 'x');
    const literal = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('name', 'asc', true, 'a.b(c)+') });
    expect(literal.entries.map((e) => e.name)).toEqual(['a.b(c)+.txt']);
    const evil = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('name', 'asc', true, '(a+)+$') });
    expect(evil.entries).toEqual([]);
  });

  it('the filter applies to names only, never to the directory path', async () => {
    await mkdir(path.join(dir, 'secretfolder'));
    await writeFile(path.join(dir, 'secretfolder', 'inner.txt'), 'x');
    const result = await buildQueriedDirectoryListing({
      realPath: path.join(dir, 'secretfolder'),
      dirents: await direntsOf(path.join(dir, 'secretfolder')),
      query: sortBy('name', 'asc', true, 'secretfolder'),
    });
    expect(result.entries).toEqual([]);
  });

  it('orders a listing that fits the same way the browser does (shared comparator)', async () => {
    for (const name of ['file10.txt', 'File2.txt', 'file1.txt', '中文.md']) await writeFile(path.join(dir, name), 'x');
    const result = await buildQueriedDirectoryListing({ realPath: dir, dirents: await direntsOf(dir), query: sortBy('name') });
    expect(result.entries.map((e) => e.name).slice(0, 3)).toEqual(['file1.txt', 'File2.txt', 'file10.txt']);
    expect(result.truncated).toBeUndefined();
  });
});
