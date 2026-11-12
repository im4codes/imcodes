import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';
import {
  base64ToFile,
  parseSharedPayload,
  resetShareReceiverStateForTests,
  subscribeShareReceiver,
  type RawSharedPayload,
  type ShareReceiverPluginContract,
  type SharedPayload,
} from '../src/services/share-receiver.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe('share-receiver service', () => {
  beforeEach(() => {
    resetShareReceiverStateForTests();
  });

  it('converts base64 file payloads into File instances with content, name, and mimeType', async () => {
    const content = 'Hello from external app!';
    const base64 = Buffer.from(content, 'utf8').toString('base64');

    const file = base64ToFile({
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: content.length,
      base64,
    });

    expect(file).not.toBeNull();
    expect(file!.name).toBe('notes.txt');
    expect(file!.type).toBe('text/plain');
    expect(file!.size).toBe(content.length);
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file!);
    });
    const bytes = new Uint8Array(buffer);
    expect(Buffer.from(bytes).toString('utf8')).toBe(content);
  });

  it('falls back to default file name and mimeType and handles data URL prefix', async () => {
    const base64 = `data:application/pdf;base64,${Buffer.from('%PDF-1.7', 'utf8').toString('base64')}`;
    const file = base64ToFile({ base64 });
    expect(file).not.toBeNull();
    expect(file!.name).toBe('shared-file');
    expect(file!.type).toBe('application/octet-stream');
    expect(file!.size).toBe(8);
  });

  it('parses multi-file shares, optional text, and size/read error boundaries', () => {
    const f1 = Buffer.from('file-one', 'utf8').toString('base64');
    const f2 = Buffer.from('file-two', 'utf8').toString('base64');

    const parsed = parseSharedPayload({
      id: 'share-123',
      files: [
        { name: 'one.txt', mimeType: 'text/plain', base64: f1 },
        { name: 'two.png', mimeType: 'image/png', base64: f2 },
      ],
      text: '  Please review these files  ',
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe('share-123');
    expect(parsed!.files).toHaveLength(2);
    expect(parsed!.files[0]!.name).toBe('one.txt');
    expect(parsed!.files[1]!.name).toBe('two.png');
    expect(parsed!.text).toBe('Please review these files');
    expect(parsed!.error).toBeUndefined();

    const oversized = parseSharedPayload({
      id: 'share-oversized',
      files: [],
      error: 'file_too_large',
    });
    expect(oversized).toEqual({
      id: 'share-oversized',
      files: [],
      error: 'file_too_large',
    });

    expect(parseSharedPayload({ files: [] })).toBeNull();
  });

  it('delivers cold-start pending shares and warm-start events while deduplicating identical payload ids', async () => {
    const listeners: Array<(payload: RawSharedPayload) => void> = [];
    const removeSpy = vi.fn(async () => {});
    const rawItem: RawSharedPayload = {
      id: 'dup-share-1',
      files: [
        {
          name: 'report.md',
          mimeType: 'text/markdown',
          base64: Buffer.from('# Report', 'utf8').toString('base64'),
        },
      ],
      text: 'Shared note',
    };

    const mockPlugin: ShareReceiverPluginContract = {
      addListener: vi.fn(async (_event, cb) => {
        listeners.push(cb);
        return { remove: removeSpy };
      }),
      consumePendingShares: vi.fn(async () => ({
        items: [rawItem],
      })),
    };

    const received: SharedPayload[] = [];
    const dispose = subscribeShareReceiver((payload) => {
      received.push(payload);
    }, {
      plugin: mockPlugin,
      native: true,
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]!.id).toBe('dup-share-1');
    expect(received[0]!.files[0]!.name).toBe('report.md');
    expect(received[0]!.text).toBe('Shared note');

    // Emit duplicate payload with same id via live listener — must be ignored
    listeners[0]?.(rawItem);
    expect(received).toHaveLength(1);

    // Emit new warm-start share payload — must be delivered
    listeners[0]?.({
      id: 'warm-share-2',
      files: [
        {
          name: 'second.txt',
          mimeType: 'text/plain',
          base64: Buffer.from('2nd', 'utf8').toString('base64'),
        },
      ],
    });
    expect(received).toHaveLength(2);
    expect(received[1]!.id).toBe('warm-share-2');

    dispose();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(window.__imcodesConsumePendingShares).toBeUndefined();
  });

  it('retries addListener on wakeup, polls pendingShares via __imcodesConsumePendingShares / visibilitychange / focus, and cleans up on unsubscribe', async () => {
    const listeners: Array<(payload: RawSharedPayload) => void> = [];
    const removeSpy = vi.fn(async () => {});
    let shouldFailAddListener = true;
    const pendingQueue: RawSharedPayload[] = [
      {
        id: 'pending-after-retry-1',
        files: [
          {
            name: 'inbox.pdf',
            mimeType: 'application/pdf',
            base64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
          },
        ],
      },
    ];

    const mockPlugin: ShareReceiverPluginContract = {
      addListener: vi.fn(async (_event, cb) => {
        if (shouldFailAddListener) {
          throw new Error('UNIMPLEMENTED');
        }
        listeners.push(cb);
        return { remove: removeSpy };
      }),
      consumePendingShares: vi.fn(async () => {
        if (shouldFailAddListener) {
          throw new Error('UNIMPLEMENTED');
        }
        const items = pendingQueue.splice(0, pendingQueue.length);
        return { items };
      }),
    };

    const received: SharedPayload[] = [];
    const dispose = subscribeShareReceiver((payload) => {
      received.push(payload);
    }, {
      plugin: mockPlugin,
      native: true,
    });

    await vi.waitFor(() => {
      expect(mockPlugin.addListener).toHaveBeenCalledTimes(1);
    });
    expect(received).toHaveLength(0);
    expect(typeof window.__imcodesConsumePendingShares).toBe('function');

    // Now native local plugin finishes registering and flushes via window.__imcodesConsumePendingShares()
    shouldFailAddListener = false;
    window.__imcodesConsumePendingShares?.();
    // Overlapping focus wakeup while poll is in flight should not register duplicate listeners
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]!.id).toBe('pending-after-retry-1');
    expect(listeners).toHaveLength(1);

    // Dual-channel notification (notifyListeners + pendingShares flush with same id) is idempotent
    const dualItem: RawSharedPayload = {
      id: 'dual-channel-2',
      files: [
        {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          base64: Buffer.from('jpg', 'utf8').toString('base64'),
        },
      ],
    };
    pendingQueue.push(dualItem);
    listeners[0]?.(dualItem);
    window.__imcodesConsumePendingShares?.();

    await vi.waitFor(() => {
      expect(pendingQueue).toHaveLength(0);
    });
    expect(received).toHaveLength(2);
    expect(received[1]!.id).toBe('dual-channel-2');

    // visibilitychange to visible polls newly queued background share
    pendingQueue.push({
      id: 'visibility-share-3',
      files: [
        {
          name: 'resume.txt',
          mimeType: 'text/plain',
          base64: Buffer.from('resume', 'utf8').toString('base64'),
        },
      ],
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => {
      expect(received).toHaveLength(3);
    });
    expect(received[2]!.id).toBe('visibility-share-3');

    // Unsubscribe cleans up hook, DOM listeners, and plugin listener
    dispose();
    expect(window.__imcodesConsumePendingShares).toBeUndefined();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    const callsBeforePostDisposeEvents = vi.mocked(mockPlugin.consumePendingShares).mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.mocked(mockPlugin.consumePendingShares).mock.calls.length).toBe(callsBeforePostDisposeEvents);
  });

  it('keeps iOS AppDelegate and ShareReceiverPlugin native bridge contracts aligned and deduplicates per-path within 2s across interleaved A -> B -> A shares', () => {
    const appDelegate = readFileSync(join(WEB_ROOT, 'ios/App/App/AppDelegate.swift'), 'utf8');
    const authPlugin = readFileSync(join(WEB_ROOT, 'ios/App/App/AuthSessionPlugin.swift'), 'utf8');

    expect(appDelegate).toContain('launchOptions?[.url] as? URL');
    expect(appDelegate).toContain('ShareReceiverPlugin.shared.flushToWebView()');
    expect(authPlugin).toContain('url.path.contains("/Documents/Inbox/") || url.path.contains("-Inbox/")');
    expect(authPlugin).toContain('duplicatePathDebounceInterval: TimeInterval = 2.0');
    expect(authPlugin).toContain('recentHandledPaths: [String: TimeInterval] = [:]');
    expect(authPlugin).toContain('recentHandledPaths = recentHandledPaths.filter');
    expect(authPlugin).toContain('recentHandledPaths[normalizedPath] = now');
    expect(authPlugin).not.toContain('lastHandledPath');
    expect(authPlugin).toContain('maxPendingShares = 20');
    expect(authPlugin).toContain('self.pendingShares.append(payload)');
    expect(authPlugin).toContain('window.__imcodesConsumePendingShares?.()');

    // Deterministic contract harness modeling ShareReceiverPlugin.handleIncomingFileURL
    // per-path 2.0s window deduplication + Inbox file deletion semantics:
    const debounceMatch = authPlugin.match(/duplicatePathDebounceInterval:\s*TimeInterval\s*=\s*([0-9.]+)/);
    const windowSec = Number(debounceMatch?.[1] ?? NaN);
    expect(windowSec).toBe(2.0);

    const inboxFiles = new Map<string, string>([
      ['/tmp/com.im.codes-Inbox/A.txt', 'content-A-1'],
      ['/tmp/com.im.codes-Inbox/B.txt', 'content-B-1'],
    ]);
    const recentHandledPaths = new Map<string, number>();
    const dispatched: Array<{ path: string; content?: string; error?: string }> = [];

    const simulateHandleIncomingFile = (rawPath: string, nowSec: number): boolean => {
      for (const [p, ts] of recentHandledPaths.entries()) {
        if (nowSec - ts >= windowSec) {
          recentHandledPaths.delete(p);
        }
      }
      const lastAt = recentHandledPaths.get(rawPath);
      if (lastAt !== undefined && nowSec - lastAt < windowSec) {
        return true;
      }
      recentHandledPaths.set(rawPath, nowSec);

      const content = inboxFiles.get(rawPath);
      if (rawPath.includes('/Documents/Inbox/') || rawPath.includes('-Inbox/')) {
        inboxFiles.delete(rawPath);
      }
      if (content === undefined) {
        dispatched.push({ path: rawPath, error: 'read_failed' });
      } else {
        dispatched.push({ path: rawPath, content });
      }
      return true;
    };

    // 1. Short-interval A -> A (t=0.0s, t=0.1s) and interleaved A -> B -> A (t=0.3s B, t=0.6s A):
    //    Only A and B are enqueued once each; deleted Inbox file A at t=0.6s does NOT produce read_failed.
    simulateHandleIncomingFile('/tmp/com.im.codes-Inbox/A.txt', 0.0);
    simulateHandleIncomingFile('/tmp/com.im.codes-Inbox/A.txt', 0.1);
    simulateHandleIncomingFile('/tmp/com.im.codes-Inbox/B.txt', 0.3);
    simulateHandleIncomingFile('/tmp/com.im.codes-Inbox/A.txt', 0.6);

    expect(dispatched).toEqual([
      { path: '/tmp/com.im.codes-Inbox/A.txt', content: 'content-A-1' },
      { path: '/tmp/com.im.codes-Inbox/B.txt', content: 'content-B-1' },
    ]);

    // 2. After the 2.0s window expires (t=2.5s >= 2.0s), a newly created Inbox file at path A is accepted again.
    inboxFiles.set('/tmp/com.im.codes-Inbox/A.txt', 'content-A-2');
    simulateHandleIncomingFile('/tmp/com.im.codes-Inbox/A.txt', 2.5);
    expect(dispatched).toEqual([
      { path: '/tmp/com.im.codes-Inbox/A.txt', content: 'content-A-1' },
      { path: '/tmp/com.im.codes-Inbox/B.txt', content: 'content-B-1' },
      { path: '/tmp/com.im.codes-Inbox/A.txt', content: 'content-A-2' },
    ]);
  });

  it('ships complete shareTarget i18n keys across all 7 locales', () => {
    const keysets = SUPPORTED_LOCALES.map((locale) => {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { shareTarget?: Record<string, unknown> };
      expect(messages.shareTarget, locale).toBeDefined();
      const keys = flattenKeys(messages.shareTarget).sort();
      expect(keys.length, locale).toBeGreaterThanOrEqual(11);
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>(
          (cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined),
          messages.shareTarget,
        );
        expect(typeof value === 'string' && value.trim().length > 0, `${locale}:shareTarget.${key}`).toBe(true);
      }
      return keys;
    });
    for (const keys of keysets.slice(1)) {
      expect(keys).toEqual(keysets[0]);
    }
  });

  it('walks the UIResponder chain for openURL in ShareActionViewController and localizes share.openNow across all 7 iOS lproj bundles', () => {
    const shareVC = readFileSync(
      join(WEB_ROOT, 'ios/App/ShareActionExtension/ShareActionViewController.swift'),
      'utf8',
    );
    expect(shareVC).toContain('sel_registerName("openURL:options:completionHandler:")');
    expect(shareVC).toContain('sel_registerName("openURL:")');
    expect(shareVC).toContain('URL(string: "imcodes://share-inbox")!');
    expect(shareVC).toContain('self.openHostApp(url)');
    expect(shareVC).toContain('self.localized("share.openNow")');
    expect(shareVC).toContain('self.localized("share.done")');

    const iosLocales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'ru'];
    const requiredKeys = ['CFBundleDisplayName', 'share.openApp', 'share.openNow', 'share.done', 'share.error'];
    for (const lproj of iosLocales) {
      const content = readFileSync(
        join(WEB_ROOT, 'ios/App/ShareActionExtension', `${lproj}.lproj/InfoPlist.strings`),
        'utf8',
      );
      for (const key of requiredKeys) {
        const pattern = new RegExp(`"${key.replace('.', '\\.')}"\\s*=\\s*"([^"]+)"\\s*;`);
        const match = content.match(pattern);
        expect(match?.[1]?.trim().length, `${lproj}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
