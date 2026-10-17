/**
 * tsk_58c8fb1b73: the production binding's poll tick must notice the engine
 * behind a viewed scope flipping (the settings live outside the supervision
 * database, so its data_version never changes) and tell the open viewer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionSupervisionConsoleBinding } from '../../src/daemon/supervision-console-binding.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { SUPERVISION_TASK_CONSOLE_MSG } from '../../shared/supervision-task-console.js';
import { TASK_PAIR_ENGINE_ENV } from '../../shared/task-pair.js';

const SCOPE = { projectName: 'cd', coordinatorSessionName: 'deck_cd_brain' };
const previousEngine = process.env[TASK_PAIR_ENGINE_ENV];

describe('engine flip under an open viewer, through the production binding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    process.env[TASK_PAIR_ENGINE_ENV] = 'legacy';
  });
  afterEach(() => {
    vi.useRealTimers();
    setTaskPairStoreForTests(undefined);
    if (previousEngine === undefined) delete process.env[TASK_PAIR_ENGINE_ENV];
    else process.env[TASK_PAIR_ENGINE_ENV] = previousEngine;
  });

  it('resyncs the viewer within one poll interval of the flip, and stays quiet otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-console-engine-poll-'));
    const databasePath = join(dir, 'supervision-state.sqlite');
    const sent: any[] = [];
    const handlers: Array<(message: unknown) => void> = [];
    const registry = new SupervisionTaskRegistry({ dbPath: databasePath });
    let production: ReturnType<typeof createProductionSupervisionConsoleBinding> | undefined;
    try {
      production = createProductionSupervisionConsoleBinding({
        databasePath, registry, externalPollIntervalMs: 1_000,
        serverLink: { send: (message) => { sent.push(message); }, onMessage: (handler) => { handlers.push(handler); } },
        authorize: () => true, now: () => 7, newEpoch: () => 'epoch',
      });
      handlers[0]?.({
        type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, subscriptionId: 'sub-1', scope: SCOPE,
        afterEventId: null, reason: 'initial',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      sent.length = 0;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sent).toEqual([]);

      process.env[TASK_PAIR_ENGINE_ENV] = 'pairs';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED)).toEqual([
        expect.objectContaining({ subscriptionId: 'sub-1', reason: 'task_pair_changed' }),
      ]);
    } finally {
      production?.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
