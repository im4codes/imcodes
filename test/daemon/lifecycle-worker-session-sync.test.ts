import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../../src/store/session-store.js';

let tempDir: string;

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_existing_brain',
    projectName: 'existing',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/tmp/existing-project',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'imcodes-sync-test-'));
  vi.stubEnv('HOME', tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('lifecycle worker session sync', () => {
  it('does not destructively prune all local main sessions when the remote main snapshot is empty', async () => {
    const store = await import('../../src/store/session-store.js');
    await store.loadStore({ probe: false });
    store.upsertSession(makeSession({ name: 'deck_existing_brain' }));
    store.upsertSession(makeSession({
      name: 'deck_sub_child',
      projectName: 'child',
      role: 'w1',
      projectDir: '/tmp/existing-project/sub',
      parentSession: 'deck_existing_brain',
    }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/sessions')) {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      if (url.endsWith('/sub-sessions')) {
        return new Response(JSON.stringify({ subSessions: [{ id: 'child', cwd: '/tmp/existing-project/sub', parent_session: 'deck_existing_brain' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    const { syncSessionsFromWorker } = await import('../../src/daemon/lifecycle.js');
    const outcome = await syncSessionsFromWorker('https://worker.example', 'server-1', 'token-1');

    expect(outcome).toMatchObject({ ok: true, skippedMainPrune: true });
    expect(store.getSession('deck_existing_brain')).toBeDefined();
    expect(store.getSession('deck_sub_child')).toBeDefined();
  });
});
