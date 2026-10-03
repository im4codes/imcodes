import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { TerminalDiff } from '../types.js';
import type { WsClient } from '../ws-client.js';

const MAX_PREVIEW_CHARS = 32 * 1024;
const FLUSH_MS = 40;

/** Keep the shell card useful without mounting an xterm for every card. */
function plainTerminalText(value: string): string {
  return value
    // OSC title/hyperlink sequences.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI cursor/style sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function trimPreview(value: string): string {
  return value.length > MAX_PREVIEW_CHARS ? value.slice(-MAX_PREVIEW_CHARS) : value;
}

interface Props {
  sessionName: string;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (apply: (diff: TerminalDiff) => void) => void;
  onHistory: (apply: (content: string) => void) => void;
  onScrollBottomFn?: (fn: () => void) => void;
}

/**
 * A bounded, read-only terminal preview for collapsed shell cards. It consumes
 * the same history/raw stream as TerminalView, but does not create xterm,
 * ResizeObserver, fit timers, or a canvas/WebGL renderer. Opening the card
 * swaps this component for TerminalView, so the live terminal starts from the
 * same server stream without leaving a black preview behind.
 */
export function TerminalTextPreview({ sessionName, ws, connected, onDiff, onHistory, onScrollBottomFn }: Props) {
  const [text, setText] = useState('');
  const textRef = useRef('');
  const linesRef = useRef<string[]>([]);
  const pendingRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<HTMLPreElement>(null);
  const decoderRef = useRef(new TextDecoder());

  const commit = useCallback((next: string) => {
    const bounded = trimPreview(next);
    textRef.current = bounded;
    setText(bounded);
  }, []);

  const flushRaw = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = '';
    commit(textRef.current + plainTerminalText(pending));
  }, [commit]);

  const queueRaw = useCallback((data: Uint8Array) => {
    pendingRef.current += decoderRef.current.decode(data, { stream: true });
    if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushRaw, FLUSH_MS);
  }, [flushRaw]);

  const applyHistory = useCallback((content: string) => {
    commit(plainTerminalText(content));
  }, [commit]);

  const applyDiff = useCallback((diff: TerminalDiff) => {
    const rows = Number.isFinite(diff.rows) && diff.rows > 0 ? Math.floor(diff.rows) : 200;
    if (diff.fullFrame) linesRef.current = [];
    for (const [index, content] of diff.lines) {
      if (index < 0 || index >= rows) continue;
      linesRef.current[index] = plainTerminalText(content);
    }
    commit(linesRef.current.slice(0, rows).join('\n'));
  }, [commit]);

  useEffect(() => {
    onHistory(applyHistory);
    onDiff(applyDiff);
  }, [applyDiff, applyHistory, onDiff, onHistory]);

  useEffect(() => {
    if (!ws || !connected || typeof ws.onTerminalRaw !== 'function') return;
    const unsubscribe = ws.onTerminalRaw(sessionName, queueRaw);
    return () => {
      unsubscribe();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingRef.current = '';
    };
  }, [connected, queueRaw, sessionName, ws]);

  useEffect(() => {
    onScrollBottomFn?.(() => {
      const el = previewRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [onScrollBottomFn]);

  return (
    <pre
      ref={previewRef}
      class="subcard-terminal-text-preview"
      aria-label="Terminal output preview"
    >{text || ' '}</pre>
  );
}
