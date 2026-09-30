import { memo } from 'preact/compat';
import type { ComponentProps } from 'preact';
import { SubSessionWindow } from './SubSessionWindow.js';
import { useStableCallbacks } from '../hooks/useStableCallbacks.js';

const MemoizedSubSessionWindow = memo(SubSessionWindow);

/** See StableSessionPane: same problem, same fix, for floating sub-session windows. */
export function StableSubSessionWindow(props: ComponentProps<typeof SubSessionWindow>) {
  const stable = useStableCallbacks(props as unknown as Record<string, unknown>) as unknown as ComponentProps<typeof SubSessionWindow>;
  return <MemoizedSubSessionWindow {...stable} />;
}
