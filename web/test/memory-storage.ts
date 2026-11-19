const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>();
  const target = {} as Storage;
  Object.defineProperties(target, {
    getItem: {
      value: (key: string) => (store.has(String(key)) ? store.get(String(key))! : null),
      configurable: true,
      writable: true,
    },
    setItem: {
      value: (key: string, value: string) => {
        store.set(String(key), String(value));
      },
      configurable: true,
      writable: true,
    },
    removeItem: {
      value: (key: string) => {
        store.delete(String(key));
      },
      configurable: true,
      writable: true,
    },
    clear: {
      value: () => {
        store.clear();
      },
      configurable: true,
      writable: true,
    },
    key: {
      value: (index: number) => Array.from(store.keys())[index] ?? null,
      configurable: true,
      writable: true,
    },
    length: {
      get: () => store.size,
      configurable: true,
    },
  });
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (Reflect.has(t, prop)) return Reflect.get(t, prop, receiver);
      if (typeof prop === 'string' && store.has(prop)) return store.get(prop);
      return undefined;
    },
    set(t, prop, value) {
      if (typeof prop === 'string' && !Reflect.has(t, prop)) {
        store.set(prop, String(value));
        return true;
      }
      return Reflect.set(t, prop, value);
    },
    has(t, prop) {
      return (typeof prop === 'string' && store.has(prop)) || Reflect.has(t, prop);
    },
    ownKeys() {
      return Array.from(store.keys());
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'string' && store.has(prop)) {
        return { enumerable: true, configurable: true, writable: true, value: store.get(prop) };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string' && store.has(prop)) {
        store.delete(prop);
        return true;
      }
      return Reflect.deleteProperty(t, prop);
    },
  });
};

export function ensureJsdomStorage(prop: 'localStorage' | 'sessionStorage'): void {
  const current = globalThis[prop] as Storage | undefined;
  if (
    current
    && typeof current.getItem === 'function'
    && typeof current.setItem === 'function'
    && typeof current.removeItem === 'function'
    && typeof current.clear === 'function'
    && typeof current.key === 'function'
  ) {
    return;
  }
  Object.defineProperty(globalThis, prop, {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
}
