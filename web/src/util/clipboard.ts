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
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    onSuccess();
  } catch {
    // No clipboard available. Callers that surface a "Copied!" state will
    // simply not flip; the user can long-press inside the source element
    // and use the native callout instead.
  }
}
