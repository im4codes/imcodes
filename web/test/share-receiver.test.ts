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
    const bytes = new Uint8Array(await file!.arrayBuffer());
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
});
