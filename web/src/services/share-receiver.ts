import { registerPlugin, type Plugin, type PluginListenerHandle } from '@capacitor/core';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import { isNative } from '../native.js';

export interface RawSharedFileItem {
  name?: string;
  mimeType?: string;
  size?: number;
  base64?: string;
}

export interface RawSharedPayload {
  id?: string;
  files?: RawSharedFileItem[];
  text?: string;
  error?: typeof FS_READ_ERROR_CODES.FILE_TOO_LARGE | 'read_failed' | string;
}

export interface SharedPayload {
  id: string;
  files: File[];
  text?: string;
  error?: typeof FS_READ_ERROR_CODES.FILE_TOO_LARGE | 'read_failed' | string;
}

export interface PendingSharedSessionUpload {
  id: string;
  serverId: string;
  sessionName: string;
  files: File[];
  text?: string;
}

export interface ShareReceiverPluginContract extends Plugin {
  consumePendingShares(): Promise<{ items?: RawSharedPayload[] }>;
  addListener(
    eventName: 'sharedPayload',
    listenerFunc: (payload: RawSharedPayload) => void,
  ): Promise<PluginListenerHandle>;
}

declare global {
  interface Window {
    __imcodesConsumePendingShares?: () => void;
  }
}

const ShareReceiver = registerPlugin<ShareReceiverPluginContract>('ShareReceiver');

const consumedPayloadIds = new Set<string>();
const MAX_TRACKED_PAYLOAD_IDS = 200;

function trackPayloadId(id: string): boolean {
  if (consumedPayloadIds.has(id)) return false;
  if (consumedPayloadIds.size >= MAX_TRACKED_PAYLOAD_IDS) {
    const oldest = consumedPayloadIds.values().next().value;
    if (oldest !== undefined) consumedPayloadIds.delete(oldest);
  }
  consumedPayloadIds.add(id);
  return true;
}

export function resetShareReceiverStateForTests(): void {
  consumedPayloadIds.clear();
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const commaIdx = base64.indexOf(',');
  const raw = commaIdx >= 0 && base64.slice(0, commaIdx).includes('base64')
    ? base64.slice(commaIdx + 1)
    : base64;
  const normalized = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const buf = Buffer.from(normalized, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function base64ToFile(item: RawSharedFileItem): File | null {
  if (!item || typeof item !== 'object' || typeof item.base64 !== 'string') {
    return null;
  }
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim()
    : 'shared-file';
  const mimeType = typeof item.mimeType === 'string' && item.mimeType.trim()
    ? item.mimeType.trim()
    : 'application/octet-stream';
  try {
    const bytes = decodeBase64Bytes(item.base64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new File([copy], name, { type: mimeType });
  } catch {
    return null;
  }
}

export function parseSharedPayload(raw: unknown): SharedPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as RawSharedPayload;
  const rawFiles = Array.isArray(candidate.files) ? candidate.files : [];
  const files: File[] = [];
  let hadDecodeFailure = false;

  for (const item of rawFiles) {
    const file = base64ToFile(item);
    if (file) {
      files.push(file);
    } else {
      hadDecodeFailure = true;
    }
  }

  const text = typeof candidate.text === 'string' && candidate.text.trim()
    ? candidate.text.trim()
    : undefined;
  let error = typeof candidate.error === 'string' && candidate.error.trim()
    ? candidate.error.trim()
    : undefined;
  if (!error && hadDecodeFailure) {
    error = 'read_failed';
  }

  if (files.length === 0 && !text && !error) {
    return null;
  }

  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim()
    : (globalThis.crypto?.randomUUID?.() ?? `share-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  return {
    id,
    files,
    ...(text ? { text } : {}),
    ...(error ? { error } : {}),
  };
}

export function subscribeShareReceiver(
  handler: (payload: SharedPayload) => void,
  options?: {
    plugin?: ShareReceiverPluginContract;
    native?: boolean;
  },
): () => void {
  const native = options?.native ?? isNative();
  if (!native) return () => {};

  const plugin = options?.plugin ?? ShareReceiver;
  let disposed = false;
  let listenerHandle: PluginListenerHandle | null = null;
  let polling = false;
  let pollQueued = false;

  const deliver = (raw: unknown) => {
    if (disposed) return;
    const parsed = parseSharedPayload(raw);
    if (!parsed) return;
    if (!trackPayloadId(parsed.id)) return;
    handler(parsed);
  };

  const pollPendingShares = async (): Promise<void> => {
    if (disposed) return;
    if (polling) {
      pollQueued = true;
      return;
    }
    polling = true;
    try {
      do {
        pollQueued = false;
        if (disposed) return;
        if (!listenerHandle) {
          try {
            const handle = await plugin.addListener('sharedPayload', (payload) => {
              deliver(payload);
            });
            if (disposed) {
              void handle.remove().catch(() => {});
              return;
            }
            listenerHandle = handle;
          } catch {
            // Plugin not available yet — will retry on next poll/wakeup
          }
        }

        if (disposed) return;
        try {
          const pending = await plugin.consumePendingShares();
          if (disposed) return;
          const items = Array.isArray(pending?.items) ? pending.items : [];
          for (const item of items) {
            deliver(item);
          }
        } catch {
          // Ignore if plugin is unavailable
        }
      } while (pollQueued && !disposed);
    } finally {
      polling = false;
    }
  };

  const consumeHook = () => {
    void pollPendingShares();
  };
  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void pollPendingShares();
    }
  };
  const onFocus = () => {
    void pollPendingShares();
  };

  if (typeof window !== 'undefined') {
    window.__imcodesConsumePendingShares = consumeHook;
    window.addEventListener('focus', onFocus);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  void pollPendingShares();

  return () => {
    disposed = true;
    if (typeof window !== 'undefined') {
      if (window.__imcodesConsumePendingShares === consumeHook) {
        delete window.__imcodesConsumePendingShares;
      }
      window.removeEventListener('focus', onFocus);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (listenerHandle) {
      void listenerHandle.remove().catch(() => {});
      listenerHandle = null;
    }
  };
}

export default ShareReceiver;
