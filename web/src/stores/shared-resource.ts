import { useSyncExternalStore } from 'preact/compat';
import { useEffect } from 'preact/hooks';

export interface SharedResourceSnapshot<T> {
  value: T | null;
  loaded: boolean;
  loading: boolean;
  stale: boolean;
  error: unknown | null;
}

export interface SharedResourceUseResult<T> extends SharedResourceSnapshot<T> {
  set: (value: T | ((previous: T | null) => T)) => void;
  invalidate: () => void;
  reload: () => Promise<T | null>;
}

type ValueOrUpdater<T> = T | ((previous: T | null) => T);

type InvalidationApi<T> = {
  mutate: (value: ValueOrUpdater<T>, opts?: { sourceVersion?: number }) => void;
  invalidate: () => void;
  reload: () => Promise<T | null>;
  peek: () => SharedResourceSnapshot<T>;
};

export interface SharedResource<T> {
  use: () => SharedResourceUseResult<T>;
  subscribe: (listener: () => void) => () => void;
  peek: () => SharedResourceSnapshot<T>;
  set: (value: ValueOrUpdater<T>) => void;
  mutate: (value: ValueOrUpdater<T>, opts?: { sourceVersion?: number }) => void;
  invalidate: () => void;
  reload: () => Promise<T | null>;
  hasSubscribers: () => boolean;
  disposeForTests: () => void;
}

export interface CreateSharedResourceOptions<T> {
  fetcher: () => Promise<T | null>;
  subscribeInvalidation?: (api: InvalidationApi<T>) => () => void;
}

const registry = new Set<{ disposeForTests: () => void }>();

function resolveValue<T>(current: T | null, value: ValueOrUpdater<T>): T {
  return typeof value === 'function'
    ? (value as (previous: T | null) => T)(current)
    : value;
}

export function createSharedResource<T>(opts: CreateSharedResourceOptions<T>): SharedResource<T> {
  let snapshot: SharedResourceSnapshot<T> = {
    value: null,
    loaded: false,
    loading: false,
    stale: false,
    error: null,
  };
  let inflight: Promise<T | null> | null = null;
  let mutationVersion = 0;
  let generation = 0;
  let invalidationUnsubscribe: (() => void) | null = null;
  let notifying = false;
  let notifyAgain = false;
  const listeners = new Set<() => void>();

  const publish = (next: SharedResourceSnapshot<T>): void => {
    snapshot = next;
    notify();
  };

  const notify = (): void => {
    if (notifying) {
      notifyAgain = true;
      return;
    }
    notifying = true;
    try {
      do {
        notifyAgain = false;
        const currentListeners = Array.from(listeners);
        for (const listener of currentListeners) listener();
      } while (notifyAgain);
    } finally {
      notifying = false;
    }
  };

  const ensureInvalidation = (): void => {
    if (invalidationUnsubscribe || !opts.subscribeInvalidation) return;
    invalidationUnsubscribe = opts.subscribeInvalidation({
      mutate: (value, mutateOpts) => mutate(value, mutateOpts),
      invalidate,
      reload,
      peek,
    });
  };

  const subscribe = (listener: () => void): (() => void) => {
    ensureInvalidation();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  function peek(): SharedResourceSnapshot<T> {
    return snapshot;
  }

  function mutate(value: ValueOrUpdater<T>, mutateOpts?: { sourceVersion?: number }): void {
    if (mutateOpts?.sourceVersion != null && mutateOpts.sourceVersion < mutationVersion) return;
    const nextValue = resolveValue(snapshot.value, value);
    if (
      Object.is(nextValue, snapshot.value)
      && snapshot.loaded
      && !snapshot.loading
      && !snapshot.stale
      && snapshot.error == null
    ) return;
    mutationVersion = Math.max(mutationVersion + 1, mutateOpts?.sourceVersion ?? 0);
    publish({
      value: nextValue,
      loaded: true,
      loading: false,
      stale: false,
      error: null,
    });
  }

  function set(value: ValueOrUpdater<T>): void {
    mutate(value);
  }

  function reload(): Promise<T | null> {
    return startReload(false);
  }

  function startReload(loadingAlreadyPublished: boolean): Promise<T | null> {
    ensureInvalidation();
    if (inflight) return inflight;
    const startVersion = mutationVersion;
    const startGeneration = generation;
    if (!loadingAlreadyPublished) publish({ ...snapshot, loading: true, error: null });
    inflight = opts.fetcher()
      .then((value) => {
        if (generation !== startGeneration) return snapshot.value;
        if (mutationVersion === startVersion) {
          publish({
            value,
            loaded: true,
            loading: false,
            stale: false,
            error: null,
          });
          return value;
        }
        publish({ ...snapshot, loading: false, error: null });
        return snapshot.value;
      })
      .catch((error: unknown) => {
        if (generation !== startGeneration) return snapshot.value;
        publish({
          ...snapshot,
          loading: false,
          error,
        });
        return Promise.reject(error);
      })
      .finally(() => {
        if (generation === startGeneration) inflight = null;
      });
    return inflight;
  }

  function invalidate(): void {
    const hasListeners = listeners.size > 0;
    publish({
      ...snapshot,
      stale: true,
      loading: hasListeners ? true : snapshot.loading,
      error: null,
    });
    if (hasListeners) {
      void startReload(true).catch(() => undefined);
    }
  }

  function disposeForTests(): void {
    generation += 1;
    inflight = null;
    mutationVersion = 0;
    try { invalidationUnsubscribe?.(); } catch { /* ignore */ }
    invalidationUnsubscribe = null;
    listeners.clear();
    snapshot = {
      value: null,
      loaded: false,
      loading: false,
      stale: false,
      error: null,
    };
  }

  function use(): SharedResourceUseResult<T> {
    const current = useSyncExternalStore(subscribe, peek);
    useEffect(() => {
      const latest = peek();
      if ((!latest.loaded || latest.stale) && !latest.loading && !latest.error && !inflight) {
        void reload().catch(() => undefined);
      } else {
        ensureInvalidation();
      }
    }, [current.loaded, current.loading, current.stale, current.error]);
    return {
      ...current,
      set,
      invalidate,
      reload,
    };
  }

  const resource: SharedResource<T> = {
    use,
    subscribe,
    peek,
    set,
    mutate,
    invalidate,
    reload,
    hasSubscribers: () => listeners.size > 0,
    disposeForTests,
  };
  registry.add(resource);
  return resource;
}

export function __resetSharedResourcesForTests(): void {
  for (const resource of Array.from(registry)) resource.disposeForTests();
}
