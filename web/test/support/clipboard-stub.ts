import { vi, type Mock } from 'vitest';

/**
 * A clipboard for jsdom, with the one behaviour that matters here: iOS refuses
 * a write issued after the user's tap is over.
 *
 * `endGesture()` is that moment. Before it, writes are accepted; after it, a
 * stub built with `activationExpired` rejects them exactly as Safari does. That
 * is what separates "engaged the clipboard inside the tap" from "wrote after
 * awaiting the network", which no assertion about the copied text can tell
 * apart on a desktop browser.
 */
export interface ClipboardStub {
  write: Mock;
  writeText: Mock;
  /** Text that actually reached the clipboard, in order. */
  written: string[];
  /** Writes the expired activation threw away. */
  lateWrites: string[];
  endGesture(): void;
}

/** A ClipboardItem that keeps the promise it was handed, as browsers do. */
export class StubClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob | string> | Blob | string>) {}
}

/**
 * Read a clipboard payload back as text.
 *
 * `Blob.prototype.text` does not exist in the jsdom under `web/node_modules`,
 * only in the newer one at the repo root -- so a stub that used it passed under
 * the workspace config and failed under `vitest.unit.config.ts`, which is what
 * CI runs. `FileReader` exists in both and works under this project's fake
 * timers.
 */
export async function readClipboardPayload(value: Blob | string): Promise<string> {
  if (typeof value === 'string') return value;
  if (typeof value.text === 'function') return await value.text();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsText(value);
  });
}

/** Read the `text/plain` entry of a stubbed ClipboardItem. */
export async function readClipboardItem(item: StubClipboardItem): Promise<string> {
  return await readClipboardPayload(await item.items['text/plain']!);
}

export function installClipboardStub(
  options: { activationExpired?: boolean } = {},
): ClipboardStub {
  const written: string[] = [];
  const lateWrites: string[] = [];
  let gestureOver = false;
  const expired = (): boolean => Boolean(options.activationExpired) && gestureOver;

  const write = vi.fn(async (items: StubClipboardItem[]) => {
    // The slot is granted at call time; the promise settling later is allowed.
    // That permission is the whole reason to hand the clipboard a promise.
    if (expired()) throw new Error('NotAllowedError');
    written.push(await readClipboardItem(items[0]!));
  });
  const writeText = vi.fn(async (text: string) => {
    if (expired()) {
      lateWrites.push(text);
      throw new Error('NotAllowedError');
    }
    written.push(text);
  });

  vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { write, writeText } });
  vi.stubGlobal('ClipboardItem', StubClipboardItem);

  return { write, writeText, written, lateWrites, endGesture: () => { gestureOver = true; } };
}

export function removeClipboardStub(): void {
  vi.unstubAllGlobals();
}
