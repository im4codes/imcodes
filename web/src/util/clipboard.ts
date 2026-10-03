/**
 * clipboard — write text to the system clipboard with a graceful fallback
 * for non-secure contexts.
 *
 * `navigator.clipboard.writeText` is the modern path, but it is gated on
 * Secure Context, which excludes file://, http://lan-host, and some Android
 * WebView configurations our app runs in. The fallback creates a hidden
 * `<textarea>`, selects it, and calls the deprecated `document.execCommand`
 * — still the only widely-supported way to populate the clipboard in those
 * environments.
 *
 * Callers pass an `onSuccess` callback that is invoked once the write
 * resolves so they can flip their UI into a "Copied!" state without having
 * to know which path succeeded.
 */
/** The only MIME type any of this needs, and the one every browser allows. */
const CLIPBOARD_TEXT_TYPE = 'text/plain';

/**
 * Copy text that does not exist yet.
 *
 * Every "copy" button whose text comes from the network has the same problem
 * on iOS: Safari only lets a page write to the clipboard while the user's tap
 * is still counted as a *transient activation*, and awaiting a request spends
 * it. By the time the mint returns there is no activation left, so
 * `writeText` is refused -- and so is the `execCommand` fallback, which needs
 * the same activation. The page then reports "check your clipboard
 * permissions" at someone whose permissions were never the problem. Chrome and
 * most Android browsers allow the late write as long as the document is
 * focused, which is why the button works on one phone and not on another.
 *
 * The supported way round it is to hand the clipboard the PROMISE, inside the
 * gesture, and let the browser hold the slot open until it settles. That is
 * what `ClipboardItem` accepts a promise for.
 *
 * Must be called synchronously from the event handler. An `await` before it
 * puts us back where we started.
 */
export function copyToClipboardWhenReady(
  pending: Promise<string>,
  onSuccess: () => void,
  onFailure: () => void = () => {},
): void {
  // Late path: resolve first, then copy. Correct everywhere except where the
  // activation has already expired, so it is the fallback rather than the
  // default.
  const copyOnceResolved = (): void => {
    pending.then(
      (text) => copyToClipboard(text, onSuccess, onFailure),
      // A rejected promise is the caller's to report -- it means the text
      // could not be fetched, which is not a clipboard problem and must not be
      // described as one.
      () => onFailure(),
    );
  };

  const clipboard = navigator.clipboard;
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (!clipboard?.write || typeof Item !== 'function') {
    copyOnceResolved();
    return;
  }

  let item: ClipboardItem;
  try {
    item = new Item({
      [CLIPBOARD_TEXT_TYPE]: pending.then((text) => new Blob([text], { type: CLIPBOARD_TEXT_TYPE })),
    });
  } catch {
    // A browser with `ClipboardItem` that refuses a promise value.
    copyOnceResolved();
    return;
  }

  clipboard.write([item]).then(onSuccess, copyOnceResolved);
}

export function copyToClipboard(
  text: string,
  onSuccess: () => void,
  onFailure: () => void = () => {},
): void {
  if (!text) {
    onFailure();
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
      execCommandCopy(text, onSuccess, onFailure);
    });
    return;
  }
  execCommandCopy(text, onSuccess, onFailure);
}

function execCommandCopy(text: string, onSuccess: () => void, onFailure: () => void): void {
  const selection = window.getSelection();
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let ta: HTMLTextAreaElement | null = null;
  let copyEventHandled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    copyEventHandled = true;
  };

  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.tabIndex = -1;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '0';
    ta.style.top = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    ta.style.fontSize = '16px';
    document.body.appendChild(ta);
    selection?.removeAllRanges();
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    document.addEventListener('copy', onCopy);
    const commandCopied = document.execCommand('copy');
    if (copyEventHandled || commandCopied) onSuccess();
    else onFailure();
  } catch {
    onFailure();
  } finally {
    document.removeEventListener('copy', onCopy);
    ta?.remove();
    // Do not restore an ambient page selection. Safari can leave a stale
    // full-page selection behind after double-tap zoom; restoring it would
    // make the next native copy action capture surrounding app chrome again.
    selection?.removeAllRanges();
    if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
  }
}
