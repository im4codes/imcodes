import { memo } from 'preact/compat';
import { useMemo, useRef } from 'preact/hooks';
import type { ComponentProps } from 'preact';
import { SessionControls as SessionControlsImpl } from './SessionControls.js';
import { useStableCallbacks } from '../hooks/useStableCallbacks.js';
import { recordChangedProps } from '../perf-render-debug.js';
import { collectSettledQueuedIds } from '../session-controls-queue.js';

const MemoizedSessionControls = memo(SessionControlsImpl);

type Props = ComponentProps<typeof SessionControlsImpl>;

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * SessionControls is a very large component; re-rendering it because its
 * parent re-rendered (fresh inline handlers, or a new timeline array whose only
 * relevant content -- the set of settled queued ids -- did not change) was the
 * biggest single render cost with many windows open.
 *
 * This adapter (1) gives handler props a stable identity, (2) replaces the raw
 * timeline array by the derived id set, kept referentially equal while its
 * members are equal, and (3) memoizes the real component on the result. The
 * component still re-renders whenever anything it displays actually changes.
 */
export function StableSessionControls(props: Props) {
  const { transportTimelineEvents, activeSession, ...rest } = props;
  const settledRef = useRef<ReadonlySet<string>>(new Set());
  const settled = useMemo(
    () => collectSettledQueuedIds(transportTimelineEvents, activeSession?.name),
    [transportTimelineEvents, activeSession?.name],
  );
  if (!sameMembers(settledRef.current, settled)) settledRef.current = settled;
  const stable = useStableCallbacks({ ...rest, activeSession, timelineSettledQueuedIds: settledRef.current } as Record<string, unknown>) as unknown as Props;
  const previousRef = useRef<Record<string, unknown> | null>(null);
  recordChangedProps('StableSessionControls', previousRef.current, stable as unknown as Record<string, unknown>);
  previousRef.current = stable as unknown as Record<string, unknown>;
  return <MemoizedSessionControls {...stable} />;
}
