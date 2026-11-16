// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deletePendingUpload,
  listPendingUploadsForKey,
  PENDING_UPLOAD_CHUNK_BYTES,
  PENDING_UPLOAD_MAX_FILE_BYTES,
  PENDING_UPLOAD_TTL_MS,
  persistPendingUploadFile,
  resetPendingUploadStoreForTests,
} from '../src/pending-upload-store.js';

function makePatternFile(size: number, name: string, byteFill = 0x41, lastModified = 123456): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (byteFill + (i % 251)) & 0xff;
  }
  return new File([bytes], name, { type: 'application/octet-stream', lastModified });
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsArrayBuffer(blob);
  });
}

describe('pending-upload-store', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetPendingUploadStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists a multi-chunk (> 4 MiB) file and restores exact bytes on cold-start listing', async () => {
    const size = PENDING_UPLOAD_CHUNK_BYTES * 2 + 1024; // 8 MiB + 1 KiB -> 3 chunks
    const file = makePatternFile(size, 'recording.bin', 0x2a, 987654);

    const persisted = await persistPendingUploadFile({
      clientUploadId: 'upl-chunked-1',
      serverId: 'srv-1',
      sessionName: 'deck_sub_1',
      composerKey: 'composer:deck_sub_1',
      file,
    });

    expect(persisted.persisted).toBe(true);
    expect(persisted.snapshotFile).not.toBeNull();
    expect(persisted.snapshotFile!.size).toBe(size);

    // Simulate cold reload by resetting cached DB handle
    resetPendingUploadStoreForTests();
    const list = await listPendingUploadsForKey('composer:deck_sub_1', 'srv-1');
    expect(list).toHaveLength(1);
    expect(list[0].meta.clientUploadId).toBe('upl-chunked-1');
    expect(list[0].meta.chunkCount).toBe(3);
    expect(list[0].file.name).toBe('recording.bin');
    expect(list[0].file.lastModified).toBe(987654);
    expect(list[0].file.size).toBe(size);

    const restoredBytes = await readBlobBytes(list[0].file);
    const originalBytes = await readBlobBytes(file);
    expect(restoredBytes.byteLength).toBe(originalBytes.byteLength);
    expect(restoredBytes[0]).toBe(originalBytes[0]);
    expect(restoredBytes[PENDING_UPLOAD_CHUNK_BYTES]).toBe(originalBytes[PENDING_UPLOAD_CHUNK_BYTES]);
    expect(restoredBytes[size - 1]).toBe(originalBytes[size - 1]);
  });

  it('evicts oldest records when exceeding 128 MiB total budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const fiftyMb = 50 * 1024 * 1024;

    await persistPendingUploadFile({
      clientUploadId: 'upl-1',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: makePatternFile(fiftyMb, 'f1.bin', 1),
    });

    vi.setSystemTime(1_001_000);
    await persistPendingUploadFile({
      clientUploadId: 'upl-2',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: makePatternFile(fiftyMb, 'f2.bin', 2),
    });

    // Adding a 3rd 50 MiB file (150 MiB total > 128 MiB) must evict upl-1
    vi.setSystemTime(1_002_000);
    await persistPendingUploadFile({
      clientUploadId: 'upl-3',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: makePatternFile(fiftyMb, 'f3.bin', 3),
    });

    const list = await listPendingUploadsForKey('composer:main', 'srv-1');
    expect(list.map((entry) => entry.meta.clientUploadId)).toEqual(['upl-2', 'upl-3']);
  });

  it('gracefully skips files larger than 128 MiB without throwing or evicting existing entries', async () => {
    const small = makePatternFile(1024, 'small.txt');
    await persistPendingUploadFile({
      clientUploadId: 'upl-small',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: small,
    });

    const oversized = {
      name: 'huge.iso',
      type: 'application/octet-stream',
      size: PENDING_UPLOAD_MAX_FILE_BYTES + 1,
      lastModified: 1,
      slice: () => new Blob([]),
    } as unknown as File;

    const result = await persistPendingUploadFile({
      clientUploadId: 'upl-huge',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: oversized,
    });

    expect(result).toEqual({ persisted: false, snapshotFile: null });
    const list = await listPendingUploadsForKey('composer:main', 'srv-1');
    expect(list.map((e) => e.meta.clientUploadId)).toEqual(['upl-small']);
  });

  it('sweeps expired (> 24h) pending uploads on read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    await persistPendingUploadFile({
      clientUploadId: 'upl-old',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: makePatternFile(512, 'old.txt'),
    });

    vi.setSystemTime(10_000 + PENDING_UPLOAD_TTL_MS + 1000);
    const list = await listPendingUploadsForKey('composer:main', 'srv-1');
    expect(list).toHaveLength(0);
  });

  it('deletes metadata and chunks cleanly on deletePendingUpload and on AbortSignal', async () => {
    const file = makePatternFile(2048, 'cancel.bin');
    await persistPendingUploadFile({
      clientUploadId: 'upl-del',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file,
    });
    expect(await listPendingUploadsForKey('composer:main', 'srv-1')).toHaveLength(1);

    await deletePendingUpload('upl-del');
    expect(await listPendingUploadsForKey('composer:main', 'srv-1')).toHaveLength(0);

    const ac = new AbortController();
    ac.abort();
    await expect(persistPendingUploadFile({
      clientUploadId: 'upl-abort',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file,
      signal: ac.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await listPendingUploadsForKey('composer:main', 'srv-1')).toHaveLength(0);
  });

  it('never deletes an in-flight persist when listPendingUploadsForKey or another persist runs concurrently', async () => {
    let resolveSlowRead!: (buf: ArrayBuffer) => void;
    let markSliceEntered!: () => void;
    const sliceEntered = new Promise<void>((resolve) => { markSliceEntered = resolve; });
    const slowBytes = new Uint8Array([1, 2, 3, 4]);
    const slowFile = {
      name: 'slow.bin',
      type: 'application/octet-stream',
      size: slowBytes.byteLength,
      lastModified: 100,
      slice: () => ({
        arrayBuffer: () => {
          markSliceEntered();
          return new Promise<ArrayBuffer>((resolve) => {
            resolveSlowRead = resolve;
          });
        },
      }),
    } as unknown as File;

    const slowPersist = persistPendingUploadFile({
      clientUploadId: 'upl-slow-inflight',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: slowFile,
    });

    await sliceEntered;

    // While upl-slow-inflight is still writing chunks (complete: false), both
    // listPendingUploadsForKey and a second persistPendingUploadFile run concurrently.
    const listedDuringWrite = await listPendingUploadsForKey('composer:main', 'srv-1');
    expect(listedDuringWrite).toHaveLength(0);

    const fastPersist = await persistPendingUploadFile({
      clientUploadId: 'upl-fast-sibling',
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:main',
      file: makePatternFile(64, 'fast.bin'),
    });
    expect(fastPersist.persisted).toBe(true);

    // Finish the slow in-flight persist -> its record must still be intact and restorable!
    resolveSlowRead(slowBytes.buffer);
    const slowResult = await slowPersist;
    expect(slowResult.persisted).toBe(true);
    expect(slowResult.snapshotFile).not.toBeNull();

    const listedAfterBoth = await listPendingUploadsForKey('composer:main', 'srv-1');
    expect(listedAfterBoth).toHaveLength(2);
    expect(listedAfterBoth.map((entry) => entry.meta.clientUploadId).sort()).toEqual([
      'upl-fast-sibling',
      'upl-slow-inflight',
    ]);
  });
});
