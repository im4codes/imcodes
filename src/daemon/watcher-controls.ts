export interface WatcherControl {
  refresh(): Promise<boolean>;
}

const controls = new Map<string, WatcherControl>();

export function registerWatcherControl(sessionName: string, control: WatcherControl): void {
  controls.set(sessionName, control);
}

export function unregisterWatcherControl(sessionName: string): void {
  controls.delete(sessionName);
}

export async function refreshSessionWatcher(sessionName: string): Promise<boolean> {
  const control = controls.get(sessionName);
  if (!control) return false;
  return control.refresh();
}
