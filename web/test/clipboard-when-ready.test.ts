/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboardWhenReady } from '../src/util/clipboard.js';

/**
 * Copying text that has to be fetched first.
 *
 * The rule these tests encode is iOS Safari's: a page may write to the
 * clipboard only while the user's tap still counts as a transient activation,
 * and awaiting a network request spends it. So the clipboard has to be engaged
 * with the *promise*, synchronously, and the browser holds the slot open.
 *
 * `iosClipboard` below is the whole point: it accepts a write issued inside
 * the gesture and refuses one issued after the fetch resolved, which is
 * exactly what an iPhone does and what desktop Chrome does not.
 */

const originalNavigator = globalThis.navigator;
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A ClipboardItem that keeps the promise it was handed, as Safari does. */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob> | Blob | string>) {}
}

function installClipboard(options: { activationExpired: boolean }) {
  const written: string[] = [];
  const lateWrites: string[] = [];
  let gestureOver = false;
  const readItem = async (item: FakeClipboardItem): Promise<string> => {
    const value = await item.items['text/plain'];
    return typeof value === 'string' ? value : await (value as Blob).text();
  };

  const clipboard = {
    write: vi.fn(async (items: FakeClipboardItem[]) => {
      // The slot is granted at call time; resolving afterwards is allowed.
      // That is the behaviour this whole approach relies on.
      if (options.activationExpired && gestureOver) throw new Error('NotAllowedError');
      written.push(await readItem(items[0]!));
    }),
    writeText: vi.fn(async (text: string) => {
      if (options.activationExpired && gestureOver) {
        lateWrites.push(text);
        throw new Error('NotAllowedError');
      }
      written.push(text);
    }),
  };
  vi.stubGlobal('navigator', { ...originalNavigator, clipboard });
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  return {
    clipboard,
    written,
    lateWrites,
    /** The tap is over; anything from here on is a late write. */
    endGesture: () => { gestureOver = true; },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', originalNavigator);
  if (originalClipboardItem === undefined) {
    Reflect.deleteProperty(globalThis as object, 'ClipboardItem');
  } else {
    vi.stubGlobal('ClipboardItem', originalClipboardItem);
  }
  vi.restoreAllMocks();
});

describe('copyToClipboardWhenReady', () => {
  it('engages the clipboard before the text exists', async () => {
    // The ordering IS the fix. Asserted directly, because a test that only
    // checks the text arrived would pass on the broken version too -- on
    // desktop, where the late write is permitted.
    const api = installClipboard({ activationExpired: true });
    const pending = deferred<string>();
    const onSuccess = vi.fn();

    copyToClipboardWhenReady(pending.promise, onSuccess, vi.fn());
    expect(api.clipboard.write, 'called inside the gesture, not after').toHaveBeenCalledTimes(1);

    api.endGesture();
    pending.resolve('curl -fsSL https://example.test/install | sh');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(api.written).toEqual(['curl -fsSL https://example.test/install | sh']);
  });

  it('is what makes an iPhone work where the old order failed', async () => {
    // The old code: await the mint, then write. Simulated here by ending the
    // gesture before the write, which is precisely what iOS refuses.
    const api = installClipboard({ activationExpired: true });
    const text = await Promise.resolve('minted-command');
    api.endGesture();

    await expect(navigator.clipboard.writeText(text)).rejects.toThrow('NotAllowedError');
    expect(api.lateWrites, 'the write iOS threw away').toEqual(['minted-command']);
    expect(api.written, 'nothing reached the clipboard').toEqual([]);
  });

  it('copies once the text arrives when the browser has no ClipboardItem', async () => {
    // Older Android WebViews and Firefox before 127. The late write is fine
    // there, so the fallback is not a downgrade for them.
    const api = installClipboard({ activationExpired: false });
    Reflect.deleteProperty(globalThis as object, 'ClipboardItem');
    const pending = deferred<string>();
    const onSuccess = vi.fn();

    copyToClipboardWhenReady(pending.promise, onSuccess, vi.fn());
    pending.resolve('fallback-command');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(api.written).toEqual(['fallback-command']);
    expect(api.clipboard.write).not.toHaveBeenCalled();
  });

  it('falls back to a plain write when the promise form is refused', async () => {
    // A browser that has ClipboardItem but rejects `write`. It must still copy
    // rather than report a permission problem.
    const api = installClipboard({ activationExpired: false });
    api.clipboard.write.mockRejectedValueOnce(new Error('DataError'));
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    copyToClipboardWhenReady(Promise.resolve('recovered'), onSuccess, onFailure);
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onFailure).not.toHaveBeenCalled();
    expect(api.written).toEqual(['recovered']);
  });

  it('reports failure, not success, when the text never arrives', async () => {
    // A failed mint is not a clipboard problem, and the caller needs to be
    // able to tell the difference -- telling someone to check permissions they
    // have is the bug this whole change is about.
    installClipboard({ activationExpired: false });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const pending = deferred<string>();

    copyToClipboardWhenReady(pending.promise, onSuccess, onFailure);
    pending.reject(new Error('mint_failed'));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
