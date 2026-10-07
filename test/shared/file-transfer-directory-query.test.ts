import { describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_CAPABILITIES, parseAdvertisedControlledNodeCapabilities } from '../../shared/controlled-node-capabilities.js';
import {
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY,
  FILE_TRANSFER_MSG,
  isFileDirectoryListQuery,
  validateControlledFileTransferResponse,
  validateFileDirectoryListRequest,
} from '../../shared/transport/file-transfer.js';

// What every server and node before this change validated, key for key. A new
// node must stay inside these when it answers a request that has no `query`
// (an old server never sends one), or the old server's strict check rejects
// the whole listing.
const LEGACY_REQUEST_KEYS = ['type', 'requestId', 'path'];
const LEGACY_DONE_KEYS = ['type', 'requestId', 'path', 'resolvedPath', 'entries'];

const sort = { key: 'modified', direction: 'desc', dirsFirst: true } as const;
const entry = { name: 'a.txt', path: '/d/a.txt', isDir: false, hidden: false };
const done = (extra: Record<string, unknown> = {}, entries: unknown[] = [entry]) => ({
  type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE, requestId: 'req-1', path: '/d', resolvedPath: '/d', entries, ...extra,
});

describe('directory listing protocol: the query capability', () => {
  it('is advertised as a controlled-node capability and survives an old server\'s advertisement filter', () => {
    expect(CONTROLLED_NODE_CAPABILITIES).toContain(FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY);
    const parsed = parseAdvertisedControlledNodeCapabilities([FILE_TRANSFER_DIRECTORY_CAPABILITY, FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY, 'some.future.capability.v9']);
    expect(parsed).toEqual({ ok: true, value: [FILE_TRANSFER_DIRECTORY_CAPABILITY, FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY] });
  });

  it('no platform advertises more than the 32 capabilities an older server accepts (older servers close the connection past it)', () => {
    const exclusive = { windows: ['.macos.', '.linux.', 'macos', 'linux'], macos: ['.windows.', '.linux.', 'windows', 'linux'], linux: ['.windows.', '.macos.', 'windows', 'macos'] };
    for (const [platform, other] of Object.entries(exclusive)) {
      const advertised = CONTROLLED_NODE_CAPABILITIES.filter((capability) => !other.some((marker) => capability.includes(marker)));
      expect(advertised.length, platform).toBeLessThanOrEqual(32);
    }
  });

  it('a plain request is exactly the legacy shape and still validates', () => {
    const plain = { type: FILE_TRANSFER_MSG.DIRECTORY_LIST, requestId: 'req-1', path: '/d' };
    expect(Object.keys(plain).every((k) => LEGACY_REQUEST_KEYS.includes(k))).toBe(true);
    expect(validateFileDirectoryListRequest(plain).ok).toBe(true);
  });

  it('accepts a well-formed query and rejects anything else', () => {
    const base = { type: FILE_TRANSFER_MSG.DIRECTORY_LIST, requestId: 'req-1', path: '/d' };
    expect(validateFileDirectoryListRequest({ ...base, query: { sort } }).ok).toBe(true);
    expect(validateFileDirectoryListRequest({ ...base, query: { sort, nameFilter: 'report 2024' } }).ok).toBe(true);
    expect(validateFileDirectoryListRequest({ ...base, query: { sort, nameFilter: '' } }).ok).toBe(true);
    for (const bad of [
      { sort: { ...sort, key: 'owner' } },
      { sort: { ...sort, direction: 'sideways' } },
      { sort: { ...sort, dirsFirst: 'yes' } },
      { sort: { ...sort, extra: 1 } },
      { sort, nameFilter: 5 },
      { sort, nameFilter: 'x'.repeat(257) },
      { sort, regex: '.*' },
      { nameFilter: 'x' },
      'modified',
      null,
    ]) {
      expect(validateFileDirectoryListRequest({ ...base, query: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(isFileDirectoryListQuery({ sort })).toBe(true);
  });

  it('NEW server, OLD node: a legacy response (no metadata, no truncation flags) is accepted unchanged', () => {
    const legacy = done({}, [{ name: 'd', path: '/d/d', isDir: true, hidden: false, totalBytes: 10, freeBytes: 5 }, entry]);
    expect(Object.keys(legacy).every((k) => LEGACY_DONE_KEYS.includes(k))).toBe(true);
    const checked = validateControlledFileTransferResponse(legacy);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      const value = checked.value as unknown as Record<string, unknown>;
      expect(value).not.toHaveProperty('truncated');
      expect((value.entries as Array<Record<string, unknown>>)[1]).not.toHaveProperty('mtimeMs');
    }
  });

  it('carries metadata, truncation and partial through, and only those', () => {
    const rich = done({ truncated: true, total: 5002, partial: true, sneaky: 1 }, [{ ...entry, size: 3, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 }]);
    expect(validateControlledFileTransferResponse(rich).ok).toBe(false);
    const ok = validateControlledFileTransferResponse(done({ truncated: true, total: 5002, partial: true }, [{ ...entry, size: 3, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 }]));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toMatchObject({ truncated: true, total: 5002, partial: true });
      expect((ok.value as unknown as { entries: unknown[] }).entries[0]).toEqual({ ...entry, size: 3, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 });
    }
  });

  it('rejects flags that contradict each other or the delivered entries', () => {
    expect(validateControlledFileTransferResponse(done({ total: 9 })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ partial: true })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ truncated: false, total: 9 })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ truncated: true })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ truncated: true, total: 0 })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ truncated: true, total: 1.5 })).ok).toBe(false);
    expect(validateControlledFileTransferResponse(done({ truncated: true, total: 1, partial: false })).ok).toBe(false);
  });

  it('rejects bad entry metadata instead of passing NaN, negatives or strings on', () => {
    for (const bad of [{ size: -1 }, { size: Number.NaN }, { size: '3' }, { mtimeMs: -5 }, { mtimeMs: Number.POSITIVE_INFINITY }, { birthtimeMs: 9e15 }, { ctimeMs: 1 }]) {
      expect(validateControlledFileTransferResponse(done({}, [{ ...entry, ...bad }])).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
