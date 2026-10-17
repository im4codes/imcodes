import { memo } from 'preact/compat';
import { useRef } from 'preact/hooks';
import type { ComponentProps } from 'preact';
import { SubSessionWindow } from './SubSessionWindow.js';
import { useStableCallbacks } from '../hooks/useStableCallbacks.js';
import { recordChangedProps } from '../perf-render-debug.js';

const MemoizedSubSessionWindow = memo(SubSessionWindow);

/** See StableSessionPane: same problem, same fix, for floating sub-session windows. */
export function StableSubSessionWindow(props: ComponentProps<typeof SubSessionWindow>) {
  const previousRef = useRef<Record<string, unknown> | null>(null);
  const stable = useStableCallbacks(props as unknown as Record<string, unknown>) as unknown as ComponentProps<typeof SubSessionWindow>;
  recordChangedProps('StableSubSessionWindow', previousRef.current, stable as unknown as Record<string, unknown>);
  previousRef.current = stable as unknown as Record<string, unknown>;
  return <MemoizedSubSessionWindow {...stable} />;
}
