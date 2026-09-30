import { memo } from 'preact/compat';
import { useRef } from 'preact/hooks';
import type { ComponentProps } from 'preact';
import { SessionPane } from './SessionPane.js';
import { useStableCallbacks } from '../hooks/useStableCallbacks.js';
import { recordChangedProps } from '../perf-render-debug.js';

const MemoizedSessionPane = memo(SessionPane);

/**
 * App re-renders many times a second (live frames, toasts, timers) and builds
 * ~25 inline handlers per pane on each render. With dozens of mounted panes
 * that re-rendered every pane's whole subtree every time. Handlers get a stable
 * identity (they still call the latest closure); the pane re-renders when a
 * data prop actually changed, or from its own state.
 */
export function StableSessionPane(props: ComponentProps<typeof SessionPane>) {
  const previousRef = useRef<Record<string, unknown> | null>(null);
  const stable = useStableCallbacks(props as unknown as Record<string, unknown>) as unknown as ComponentProps<typeof SessionPane>;
  recordChangedProps('StableSessionPane', previousRef.current, stable as unknown as Record<string, unknown>);
  previousRef.current = stable as unknown as Record<string, unknown>;
  return <MemoizedSessionPane {...stable} />;
}
