import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentProps } from 'preact';
import { SessionPane } from './SessionPane.js';
import { useStableCallbacks } from '../hooks/useStableCallbacks.js';
import { recordChangedProps } from '../perf-render-debug.js';

const MemoizedSessionPane = memo(SessionPane);

type Props = ComponentProps<typeof SessionPane>;

/**
 * A hidden main pane renders nothing anyone sees, but the session list it is
 * handed changes whenever ANY session flips state (idle/running/queued), which
 * with dozens of sessions is many times a second -- each one re-rendering every
 * hidden pane. Hidden panes therefore take list updates on this cadence; a pane
 * that becomes active (or is active) always gets the current lists at once.
 */
export const HIDDEN_PANE_LIST_REFRESH_MS = 2_000;

/**
 * App re-renders many times a second (live frames, toasts, timers) and builds
 * ~25 inline handlers per pane on each render. With dozens of mounted panes
 * that re-rendered every pane's whole subtree every time. Handlers get a stable
 * identity (they still call the latest closure); the pane re-renders when a
 * data prop actually changed, or from its own state.
 */
export function StableSessionPane(props: Props) {
  const hidden = !props.isActive;
  const committed = useRef({ sessions: props.sessions, subSessions: props.subSessions });
  const latest = useRef(props);
  latest.current = props;
  const [tick, refresh] = useState(0);
  if (!hidden) committed.current = { sessions: props.sessions, subSessions: props.subSessions };
  const stale = hidden && (committed.current.sessions !== props.sessions || committed.current.subSessions !== props.subSessions);
  useEffect(() => {
    if (!stale) return undefined;
    const timer = setTimeout(() => {
      committed.current = { sessions: latest.current.sessions, subSessions: latest.current.subSessions };
      refresh((value) => value + 1);
    }, HIDDEN_PANE_LIST_REFRESH_MS + Math.random() * (HIDDEN_PANE_LIST_REFRESH_MS / 4));
    return () => clearTimeout(timer);
    // Re-armed when the pane flips stale/fresh or after each refresh, so constant
    // churn cannot postpone the refresh forever (throttle, not debounce).
  }, [stale, tick]);
  const effective = { ...props, sessions: committed.current.sessions, subSessions: committed.current.subSessions } as Props;
  const previousRef = useRef<Record<string, unknown> | null>(null);
  const stable = useStableCallbacks(effective as unknown as Record<string, unknown>) as unknown as Props;
  recordChangedProps('StableSessionPane', previousRef.current, stable as unknown as Record<string, unknown>);
  previousRef.current = stable as unknown as Record<string, unknown>;
  return <MemoizedSessionPane {...stable} />;
}
