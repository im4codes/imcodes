import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { focusComposerElement } from '../util/composer-focus.js';

export interface PendingTaskQuotePayload {
  quote: string;
  nonce: number;
}

/**
 * Attaches a pending task-jump quote card to a session's dedicated task-quote
 * slot once the target session pane/window is active, without modifying
 * unrelated manual message quotes.
 */
export function usePendingTaskQuote(
  isReady: boolean,
  pendingTaskQuote: PendingTaskQuotePayload | null | undefined,
  onConsumed: ((nonce: number) => void) | undefined,
  setTaskQuote: (quote: string | null) => void,
  inputRef: RefObject<HTMLDivElement | null>,
): void {
  const consumedNonceRef = useRef<number | null>(null);
  const onConsumedRef = useRef(onConsumed);
  onConsumedRef.current = onConsumed;

  useEffect(() => {
    if (!isReady || !pendingTaskQuote) return;
    if (consumedNonceRef.current === pendingTaskQuote.nonce) return;
    consumedNonceRef.current = pendingTaskQuote.nonce;

    const clean = pendingTaskQuote.quote.trim();
    if (clean) {
      setTaskQuote(clean);
    }
    const focusNow = () => {
      focusComposerElement(inputRef.current);
    };
    focusNow();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(focusNow);
    }
    onConsumedRef.current?.(pendingTaskQuote.nonce);
  }, [isReady, pendingTaskQuote, setTaskQuote, inputRef]);
}
