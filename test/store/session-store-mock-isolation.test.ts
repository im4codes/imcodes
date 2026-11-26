import { afterEach, expect, it, vi } from 'vitest';

const SESSION_STORE_MODULE = '../../src/store/session-store.js';

vi.unmock('../../src/store/session-store.js');

afterEach(() => {
  vi.doUnmock(SESSION_STORE_MODULE);
  vi.resetModules();
});

it('loads the real session store after a worker-local partial mock registration', async () => {
  vi.doMock(SESSION_STORE_MODULE, () => ({
    listSessions: vi.fn(() => []),
  }));
  vi.resetModules();

  const sessionStore = await vi.importActual<typeof import('../../src/store/session-store.js')>(
    SESSION_STORE_MODULE,
  );
  expect(sessionStore.loadStore).toBeTypeOf('function');
  expect(sessionStore.flushStore).toBeTypeOf('function');
});
