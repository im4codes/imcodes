import { dispatchActiveTimelineRefresh } from './hooks/useTimeline.js';

export interface NativeAppStateApi {
  addListener(
    eventName: 'appStateChange',
    listenerFunc: (state: { isActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
}

export async function installNativeAppResumeRefresh(
  enabled: boolean,
  reconnectNow: (force: boolean) => void,
  appApi: NativeAppStateApi,
): Promise<() => void> {
  if (!enabled) return () => {};
  const handle = await appApi.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    reconnectNow(true);
    dispatchActiveTimelineRefresh();
  });
  return () => {
    const result = handle.remove();
    if (result && typeof (result as Promise<void>).then === 'function') void result;
  };
}
