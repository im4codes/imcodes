const createMemoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
};

const ensureStorage = (prop: 'localStorage' | 'sessionStorage') => {
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
};

ensureStorage('localStorage');
ensureStorage('sessionStorage');
