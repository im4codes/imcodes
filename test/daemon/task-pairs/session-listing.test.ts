import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { listSendTargets } from '../../../src/daemon/send-tool.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { resetSessionActivityForTests } from '../../../src/daemon/session-activity.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import type { TaskPairState } from '../../../shared/task-pair.js';

const PROJECT = 'listingproj';
const BRAIN = 'deck_listingproj_brain';
const EXEC = 'deck_sub_listingexec';
const AUD = 'deck_sub_listingaud';

function session(name: string, role: SessionRecord['role'], state: SessionRecord['state'] = 'idle'): SessionRecord {
  return {
    name,
    projectName: PROJECT,
    role,
    agentType: 'claude-code-sdk',
    projectDir: `/tmp/${PROJECT}`,
    state,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    sessionInstanceId: `instance_${name}`,
    runtimeEpoch: `epoch_${name}`,
  } as SessionRecord;
}

const pair: TaskPairState = {
  taskId: 'pair-list-1',
  brain: BRAIN,
  executor: EXEC,
  auditor: AUD,
  title: 'List projection',
  status: 'working',
  flags: [],
  flagSides: {},
  round: 2,
  blocking: ['P0'],
  previousAuditors: [],
  capCounts: {},
  capRound: 2,
  createdAt: 1,
  updatedAt: 2,
};

describe('one-call sub-session status projection', () => {
  beforeEach(() => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetSessionActivityForTests();
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2'), session('deck_sub_stopped', 'w3', 'stopped')]) upsertSession(record);
    getTaskPairStore().savePair(PROJECT, pair);
  });

  afterEach(() => {
    resetSessionActivityForTests();
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD, 'deck_sub_stopped']) removeSession(name);
  });

  it('returns activity timestamps and open pair identity in one call', () => {
    timelineEmitter.emit(EXEC, 'user.message', { text: 'working' }, { ts: 100 });
    timelineEmitter.emit(EXEC, 'tool.call', { tool: 'shell' }, { ts: 110 });
    const result = listSendTargets({ userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` }, {}, {
      listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    const executor = result.items.find((item) => item.sessionName === EXEC);
    expect(executor).toMatchObject({
      status: 'idle',
      lastMessageAt: 100,
      lastToolCallAt: 110,
      openPairs: [{ taskId: 'pair-list-1', role: 'executor', status: 'working', round: 2, title: 'List projection' }],
    });
    expect(result.items.find((item) => item.sessionName === AUD)).toMatchObject({
      openPairs: [{ taskId: 'pair-list-1', role: 'auditor', status: 'working', round: 2, title: 'List projection' }],
    });
  });
});

