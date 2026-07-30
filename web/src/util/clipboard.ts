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
export function copyToClipboard(text: string, onSuccess: () => void): void {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
      execCommandCopy(text, onSuccess);
    });
    return;
  }
  execCommandCopy(text, onSuccess);
}

function execCommandCopy(text: string, onSuccess: () => void): void {
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
  } catch {
    // No clipboard available. Callers that surface a "Copied!" state will
    // simply not flip; the user can long-press inside the source element
    // and use the native callout instead.
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
