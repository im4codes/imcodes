export const PENDING_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const PENDING_UPLOAD_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const PENDING_UPLOAD_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const DB_NAME = 'imcodes_pending_uploads_v2';
const DB_VERSION = 1;
const META_STORE_NAME = 'pending_uploads';
const CHUNK_STORE_NAME = 'pending_upload_chunks';

export interface PendingUploadMeta {
  clientUploadId: string;
  serverId: string;
  sessionName: string;
  composerKey: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  chunkCount: number;
  chunkSize: number;
  complete: boolean;
  createdAt: number;
}

interface PendingUploadChunkRecord {
  clientUploadId: string;
  chunkIndex: number;
  data: ArrayBuffer;
}

export interface PendingUploadEntry {
  meta: PendingUploadMeta;
  file: File;
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;
const inFlightPersistCounts = new Map<string, number>();

function addInFlightPersist(clientUploadId: string): void {
  inFlightPersistCounts.set(clientUploadId, (inFlightPersistCounts.get(clientUploadId) ?? 0) + 1);
}

function removeInFlightPersist(clientUploadId: string): void {
  const next = (inFlightPersistCounts.get(clientUploadId) ?? 0) - 1;
  if (next <= 0) inFlightPersistCounts.delete(clientUploadId);
  else inFlightPersistCounts.set(clientUploadId, next);
}

function isPersistInFlight(clientUploadId: string): boolean {
  return (inFlightPersistCounts.get(clientUploadId) ?? 0) > 0;
}

function createAbortError(): Error {
  const err = new Error('Upload canceled');
  err.name = 'AbortError';
  return err;
}

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('NotReadableError'));
    reader.readAsArrayBuffer(blob);
  });
}

export function resetPendingUploadStoreForTests(): void {
  cachedDbPromise = null;
  inFlightPersistCounts.clear();
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openPendingDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          const metaStore = db.createObjectStore(META_STORE_NAME, { keyPath: 'clientUploadId' });
          metaStore.createIndex('by_composer', 'composerKey', { unique: false });
          metaStore.createIndex('by_createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = db.createObjectStore(CHUNK_STORE_NAME, {
            keyPath: ['clientUploadId', 'chunkIndex'],
          });
          chunkStore.createIndex('by_upload', 'clientUploadId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          cachedDbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        cachedDbPromise = null;
        reject(request.error ?? new Error('indexeddb_open_failed'));
      };
    } catch (error) {
      cachedDbPromise = null;
      reject(error);
    }
  });
  return cachedDbPromise;
}

function runGetAll<T>(source: IDBObjectStore | IDBIndex, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = query !== undefined ? source.getAll(query) : source.getAll();
    req.onsuccess = () => resolve((req.result as T[] | undefined) ?? []);
    req.onerror = () => reject(req.error ?? new Error('indexeddb_get_all_failed'));
  });
}

function awaitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb_tx_aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb_tx_failed'));
  });
}

function deleteUploadChunks(chunkStore: IDBObjectStore, clientUploadId: string): void {
  chunkStore.delete(IDBKeyRange.bound([clientUploadId, 0], [clientUploadId, Number.MAX_SAFE_INTEGER]));
}

function isExpired(record: PendingUploadMeta, now: number): boolean {
  return !Number.isFinite(record.createdAt) || now - record.createdAt > PENDING_UPLOAD_TTL_MS;
}

async function readChunkedFileFromDb(db: IDBDatabase, meta: PendingUploadMeta): Promise<File | null> {
  const tx = db.transaction(CHUNK_STORE_NAME, 'readonly');
  const chunkStore = tx.objectStore(CHUNK_STORE_NAME);
  const chunks = await runGetAll<PendingUploadChunkRecord>(
    chunkStore,
    IDBKeyRange.bound([meta.clientUploadId, 0], [meta.clientUploadId, Number.MAX_SAFE_INTEGER]),
  );
  await awaitTx(tx);
  if (chunks.length !== meta.chunkCount) {
    return null;
  }
  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].chunkIndex !== i) return null;
  }
  const parts = chunks.map((chunk) => chunk.data);
  return new File(parts, meta.name, {
    type: meta.mimeType || 'application/octet-stream',
    lastModified: meta.lastModified,
  });
}

export async function deletePendingUpload(clientUploadId: string): Promise<void> {
  if (!hasIndexedDb() || !clientUploadId) return;
  try {
    const db = await openPendingDb();
    const tx = db.transaction([META_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
    tx.objectStore(META_STORE_NAME).delete(clientUploadId);
    deleteUploadChunks(tx.objectStore(CHUNK_STORE_NAME), clientUploadId);
    await awaitTx(tx);
  } catch {
    // Best-effort cleanup; expired records are also swept automatically.
  }
}

/**
 * Streams `file` into IndexedDB in 4 MiB chunks (keeping peak write memory ~4 MiB)
 * under the 128 MiB store budget, then returns a File backed by the stored chunks.
 * Returns `{ persisted: false, snapshotFile: null }` when skipped (> 128 MiB or unavailable).
 */
export async function persistPendingUploadFile(options: {
  clientUploadId: string;
  serverId: string;
  sessionName: string;
  composerKey: string;
  file: File;
  signal?: AbortSignal;
}): Promise<{ persisted: boolean; snapshotFile: File | null }> {
  const { clientUploadId, serverId, sessionName, composerKey, file, signal } = options;
  if (signal?.aborted) throw createAbortError();
  if (!hasIndexedDb()) return { persisted: false, snapshotFile: null };
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PENDING_UPLOAD_MAX_FILE_BYTES) {
    return { persisted: false, snapshotFile: null };
  }
  if (typeof file.slice !== 'function') {
    return { persisted: false, snapshotFile: null };
  }

  addInFlightPersist(clientUploadId);
  try {
    let db: IDBDatabase;
    try {
      db = await openPendingDb();
    } catch {
      return { persisted: false, snapshotFile: null };
    }

    const mimeType = file.type || 'application/octet-stream';
    const chunkCount = file.size === 0 ? 0 : Math.ceil(file.size / PENDING_UPLOAD_CHUNK_BYTES);
    const createdAt = Date.now();
    const meta: PendingUploadMeta = {
      clientUploadId,
      serverId,
      sessionName,
      composerKey,
      name: file.name,
      mimeType,
      size: file.size,
      lastModified: file.lastModified,
      chunkCount,
      chunkSize: PENDING_UPLOAD_CHUNK_BYTES,
      complete: false,
      createdAt,
    };

    try {
      const prepTx = db.transaction([META_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
      const metaStore = prepTx.objectStore(META_STORE_NAME);
      const chunkStore = prepTx.objectStore(CHUNK_STORE_NAME);
      const existing = await runGetAll<PendingUploadMeta>(metaStore);
      const now = Date.now();

      const retained: PendingUploadMeta[] = [];
      for (const item of existing) {
        if (item.clientUploadId === clientUploadId) {
          metaStore.delete(item.clientUploadId);
          deleteUploadChunks(chunkStore, item.clientUploadId);
          continue;
        }
        if (!item.complete && isPersistInFlight(item.clientUploadId)) {
          // Another persist in this runtime is actively writing chunks; do not sweep it.
          continue;
        }
        if (isExpired(item, now) || !item.complete) {
          metaStore.delete(item.clientUploadId);
          deleteUploadChunks(chunkStore, item.clientUploadId);
          continue;
        }
        retained.push(item);
      }

      retained.sort((a, b) => a.createdAt - b.createdAt);
      let totalBytes = retained.reduce((sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0), 0);
      while (retained.length > 0 && totalBytes + file.size > PENDING_UPLOAD_MAX_TOTAL_BYTES) {
        const oldest = retained.shift()!;
        totalBytes -= Number.isFinite(oldest.size) ? oldest.size : 0;
        metaStore.delete(oldest.clientUploadId);
        deleteUploadChunks(chunkStore, oldest.clientUploadId);
      }

      metaStore.put(meta);
      await awaitTx(prepTx);

      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        if (signal?.aborted) {
          await deletePendingUpload(clientUploadId);
          throw createAbortError();
        }
        const start = chunkIndex * PENDING_UPLOAD_CHUNK_BYTES;
        const end = Math.min(file.size, start + PENDING_UPLOAD_CHUNK_BYTES);
        const buf = await readBlobArrayBuffer(file.slice(start, end, mimeType));
        if (signal?.aborted) {
          await deletePendingUpload(clientUploadId);
          throw createAbortError();
        }
        const chunkTx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
        chunkTx.objectStore(CHUNK_STORE_NAME).put({
          clientUploadId,
          chunkIndex,
          data: buf,
        } satisfies PendingUploadChunkRecord);
        await awaitTx(chunkTx);
      }

      if (signal?.aborted) {
        await deletePendingUpload(clientUploadId);
        throw createAbortError();
      }

      const completeMeta: PendingUploadMeta = { ...meta, complete: true };
      const finalizeTx = db.transaction(META_STORE_NAME, 'readwrite');
      finalizeTx.objectStore(META_STORE_NAME).put(completeMeta);
      await awaitTx(finalizeTx);

      const snapshotFile = await readChunkedFileFromDb(db, completeMeta);
      return { persisted: true, snapshotFile };
    } catch (error) {
      await deletePendingUpload(clientUploadId);
      if ((error instanceof Error && (error.name === 'AbortError' || error.name === 'NotReadableError'))) {
        throw error;
      }
      return { persisted: false, snapshotFile: null };
    }
  } finally {
    removeInFlightPersist(clientUploadId);
  }
}

export async function listPendingUploadsForKey(
  composerKey: string,
  serverId: string,
): Promise<PendingUploadEntry[]> {
  if (!hasIndexedDb() || !composerKey || !serverId) return [];
  try {
    const db = await openPendingDb();
    const tx = db.transaction([META_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
    const metaStore = tx.objectStore(META_STORE_NAME);
    const chunkStore = tx.objectStore(CHUNK_STORE_NAME);
    const all = await runGetAll<PendingUploadMeta>(metaStore);
    const now = Date.now();
    const candidates: PendingUploadMeta[] = [];

    for (const item of all) {
      if (!item.complete && isPersistInFlight(item.clientUploadId)) {
        // Active in-progress persist in this runtime; keep record untouched.
        continue;
      }
      if (isExpired(item, now) || !item.complete) {
        metaStore.delete(item.clientUploadId);
        deleteUploadChunks(chunkStore, item.clientUploadId);
        continue;
      }
      if (item.composerKey === composerKey && item.serverId === serverId) {
        candidates.push(item);
      }
    }
    await awaitTx(tx);

    candidates.sort((a, b) => a.createdAt - b.createdAt);
    const entries: PendingUploadEntry[] = [];
    for (const meta of candidates) {
      const file = await readChunkedFileFromDb(db, meta);
      if (!file) {
        await deletePendingUpload(meta.clientUploadId);
        continue;
      }
      entries.push({ meta, file });
    }
    return entries;
  } catch {
    return [];
  }
}
