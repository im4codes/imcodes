type Listener = () => void;

const listeners = new Set<Listener>();

/** Tell the mounted Cloud Docs blocked notice host that `window.open` returned null. */
export function publishCloudDocsWindowBlocked(): void {
  for (const listener of listeners) listener();
}

export function subscribeCloudDocsWindowBlocked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetCloudDocsWindowNoticeForTests(): void {
  listeners.clear();
}
