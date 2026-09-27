/** Opt-in render attribution for the SDK-window performance harness. */
export type PerfFrameType = 'agent.status' | 'session.state' | 'usage.update' | 'other';

interface RenderDebugState {
  enabled?: boolean;
  currentFrame?: PerfFrameType;
  frames?: Record<string, number>;
  renders?: Record<string, Record<string, number>>;
}

function state(): RenderDebugState | null {
  if (typeof window === 'undefined') return null;
  const root = window as unknown as { __imcodesRenderDebug?: RenderDebugState };
  if (!root.__imcodesRenderDebug?.enabled) return null;
  const value = root.__imcodesRenderDebug;
  value.frames ??= {};
  value.renders ??= {};
  return value;
}

export function markPerfFrame(type: string): void {
  const value = state();
  if (!value) return;
  const frame = type === 'agent.status' || type === 'session.state' || type === 'usage.update'
    ? type
    : 'other';
  value.currentFrame = frame;
  value.frames![frame] = (value.frames![frame] ?? 0) + 1;
}

export function recordPerfRender(component: string): void {
  const value = state();
  if (!value) return;
  const frame = value.currentFrame ?? 'other';
  const byFrame = value.renders![component] ?? (value.renders![component] = {});
  byFrame[frame] = (byFrame[frame] ?? 0) + 1;
}
