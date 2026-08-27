import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSupervisionConsoleBinding, isAuthorizedSupervisionConsoleScope, resolveSupervisionProjectionEpoch,
  type SupervisionConsoleLink,
} from '../../src/daemon/supervision-console-binding.js';
import type { SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import {
  SUPERVISION_TASK_CONSOLE_MSG, SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  evaluateSupervisionConsoleCursor, initialSupervisionConsoleCursor,
  isStaleSupervisionConsoleResponse, isValidSupervisionTaskConsoleEvent,
  type SupervisionTaskConsoleCursorState,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';

const SCOPE = { projectName: 'codedeck', coordinatorSessionName: 'deck_cd_brain' };

const LEGACY = `
  CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
    classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
    push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
    runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
    lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
    verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
`;

/** Stands in for the browser: applies exactly the shared contract rules. */
class BrowserClient {
  cursor: SupervisionTaskConsoleCursorState;
  activeSubscriptionId = 'sub-1';
  applied: number[] = [];
  resyncs: string[] = [];
  rejected = 0;
  receivedDeltas = 0;
  duplicates = 0;
  constructor() { this.cursor = initialSupervisionConsoleCursor(SCOPE, ''); }

  receive(frame: any): void {
    if (frame?.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED) {
      this.resyncs.push(frame.reason); return;
    }
    if (isStaleSupervisionConsoleResponse({
      activeSubscriptionId: this.activeSubscriptionId, responseSubscriptionId: frame?.subscriptionId ?? '',
    })) { this.rejected += 1; return; }
    if (!isValidSupervisionTaskConsoleEvent(frame)) { this.rejected += 1; return; }
    if (frame.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
      this.cursor = { ...this.cursor, projectionVersion: frame.projectionVersion,
        projectionEpoch: frame.projectionEpoch, lastDurableEventId: frame.lastDurableEventId };
      this.applied = [];
      return;
    }
    this.receivedDeltas += 1;
    const verdict = evaluateSupervisionConsoleCursor({ client: this.cursor, incoming: frame });
    if (verdict.decision === 'ignore_duplicate') this.duplicates += 1;
    if (verdict.decision === 'apply') {
      this.applied.push(frame.projectionVersion);
      this.cursor = { ...this.cursor, projectionVersion: frame.projectionVersion,
        lastDurableEventId: frame.lastDurableEventId };
    } else if (verdict.decision === 'resync_required') {
      this.resyncs.push(verdict.reason);
    }
  }

  subscribeFrame(afterEventId: number | null, over: Record<string, unknown> = {}) {
    return {
      type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE, scope: SCOPE,
      subscriptionId: this.activeSubscriptionId, afterEventId, reason: 'initial',
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion: this.cursor.projectionVersion,
      lastDurableEventId: this.cursor.lastDurableEventId,
      projectionEpoch: this.cursor.projectionEpoch, ...over,
    };
  }
}

let db: DatabaseSync; let browser: BrowserClient; let inbound: ((m: unknown) => void)[];
let binding: ReturnType<typeof createSupervisionConsoleBinding>;

function connect(epoch?: string) {
  inbound = [];
  const link: SupervisionConsoleLink = {
    send: (m) => browser.receive(m),
    onMessage: (h) => inbound.push(h),
  };
  binding = createSupervisionConsoleBinding({
    serverLink: link, database: db as unknown as SupervisionMigrationDb,
    authorize: (s) => s.coordinatorSessionName === SCOPE.coordinatorSessionName,
    now: () => 1, newEpoch: () => epoch ?? 'epoch-fresh',
  });
  return binding;
}
function toDaemon(frame: unknown) { for (const h of inbound) h(frame); }
function emit(taskId = 'tsk_a') {
  return binding.producer.appendTaskEvent({
    scope: SCOPE, taskId, eventType: 'implementing', status: 'implementing',
  });
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY);
  db.prepare(`INSERT INTO supervision_tasks (task_id, top_level_task_id, classification, status,
    payload_json, created_at, updated_at) VALUES ('tsk_a','top','slice','implementing','{}',1,1)`).run();
  browser = new BrowserClient();
  connect('epoch-1');
  db.prepare("UPDATE supervision_tasks SET project_name = 'codedeck' WHERE task_id = 'tsk_a'").run();
});

describe('scope authorization', () => {
  const coordinator = {
    name: 'deck_cd_brain', projectName: 'codedeck', role: 'brain', agentType: 'codex',
    projectDir: '/work/codedeck', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as never;
  it('requires the exact live brain and its effective project', () => {
    expect(isAuthorizedSupervisionConsoleScope(SCOPE, [coordinator])).toBe(true);
    expect(isAuthorizedSupervisionConsoleScope({ ...SCOPE, projectName: 'other' }, [coordinator])).toBe(false);
    expect(isAuthorizedSupervisionConsoleScope(SCOPE, [{ ...coordinator, role: 'w1' }])).toBe(false);
    expect(isAuthorizedSupervisionConsoleScope(SCOPE, [])).toBe(false);
  });
});

describe('producer -> link -> browser E2E', () => {
  it('hydrates a snapshot the browser validator accepts, then applies live deltas', () => {
    toDaemon(browser.subscribeFrame(null));
    expect(browser.rejected).toBe(0);
    expect(browser.cursor.projectionEpoch).toBe('epoch-1');
    emit(); emit();
    expect(browser.applied).toEqual([1, 2]);
    expect(browser.resyncs).toEqual([]);
  });

  it('every emitted frame passes the browser-side structural validator', () => {
    toDaemon(browser.subscribeFrame(null));
    for (let i = 0; i < 5; i += 1) emit();
    expect(browser.rejected).toBe(0);
    expect(browser.applied).toEqual([1, 2, 3, 4, 5]);
  });

  it('RECONNECT: catch-up replays exactly the missed deltas', () => {
    toDaemon(browser.subscribeFrame(null));
    const first = emit();
    // Browser goes away; daemon keeps producing.
    const away = new BrowserClient();
    const live = browser; browser = away;
    emit(); emit();
    browser = live;
    browser.applied = [];
    toDaemon(browser.subscribeFrame(first.eventId));
    expect(browser.applied).toEqual([2, 3]);
    expect(browser.resyncs).toEqual([]);
  });

  it('OLD EPOCH: a rebuilt projection store forces a full resync, not a silent freeze', () => {
    toDaemon(browser.subscribeFrame(null));
    emit();
    // Simulate a rebuilt store: same DB rows dropped, new epoch.
    db.exec('DELETE FROM supervision_projection_state; DELETE FROM supervision_outbox;');
    connect('epoch-2');
    toDaemon(browser.subscribeFrame(0));
    expect(browser.resyncs).toContain('authority_epoch_changed');
  });

  it('STALE ACK from a superseded subscription does not prune owed frames', () => {
    toDaemon(browser.subscribeFrame(null));
    emit(); emit();
    browser.activeSubscriptionId = 'sub-2';
    toDaemon(browser.subscribeFrame(null));
    toDaemon({ type: SUPERVISION_TASK_CONSOLE_MSG.ACK, scope: SCOPE, subscriptionId: 'sub-1', projectionVersion: 2 });
    expect(binding.producer.pendingFrames(SCOPE)).toHaveLength(2);
    toDaemon({ type: SUPERVISION_TASK_CONSOLE_MSG.ACK, scope: SCOPE, subscriptionId: 'sub-2', projectionVersion: 2 });
    expect(binding.producer.pendingFrames(SCOPE)).toHaveLength(0);
  });

  it('a late frame answering a superseded subscribe is REJECTED by the browser', () => {
    toDaemon(browser.subscribeFrame(null));
    browser.activeSubscriptionId = 'sub-2';
    emit(); // still stamped sub-1 by the registry
    expect(browser.rejected).toBe(1);
    expect(browser.applied).toEqual([]);
  });

  it('RESTART: a new binding on the same DB resumes the cursor and redelivers unacked frames', () => {
    toDaemon(browser.subscribeFrame(null));
    emit(); emit();
    const before = binding.projectionEpoch;
    connect('epoch-should-not-be-used');
    // Epoch is restored from SQLite, NOT reminted -- no spurious resync.
    expect(binding.projectionEpoch).toBe(before);
    // Unacked frames are redelivered (at-least-once)...
    browser.applied = []; browser.receivedDeltas = 0; browser.duplicates = 0;
    toDaemon(browser.subscribeFrame(0, { projectionVersion: 0 }));
    expect(browser.receivedDeltas).toBe(2);
    // ...and this browser, whose cursor is already at 2, correctly DEDUPES them
    // rather than double-applying. That is the idempotency guarantee.
    expect(browser.duplicates).toBe(2);
    expect(browser.applied).toEqual([]);
    expect(browser.resyncs).toEqual([]);
  });

  it('RESTART: a browser that lost its cursor re-applies the redelivered frames', () => {
    toDaemon(browser.subscribeFrame(null));
    emit(); emit();
    connect('unused');
    // Fresh browser state, same epoch: catch-up must rebuild it exactly.
    const epoch = browser.cursor.projectionEpoch;
    browser = new BrowserClient();
    browser.cursor = { ...browser.cursor, projectionEpoch: epoch };
    toDaemon(browser.subscribeFrame(0, { projectionVersion: 0 }));
    expect(browser.applied).toEqual([1, 2]);
    expect(browser.rejected).toBe(0);
  });

  it('an unauthorized coordinator receives absolutely nothing', () => {
    const other = { ...SCOPE, coordinatorSessionName: 'deck_intruder_brain' };
    toDaemon({ ...browser.subscribeFrame(null), scope: other });
    expect(browser.rejected).toBe(0);
    expect(browser.applied).toEqual([]);
    expect(browser.resyncs).toEqual([]);
    expect(binding.sessions.refusedCount).toBe(1);
  });
});

describe('projection epoch stability', () => {
  it('is reminted only when no projection row exists', () => {
    db.exec(`INSERT INTO supervision_projection_state
      (project_name, coordinator_session_name, projection_version, projection_epoch, updated_at)
      VALUES ('p','c',3,'persisted-epoch',1)`);
    expect(resolveSupervisionProjectionEpoch(db as never, () => 'fresh')).toBe('persisted-epoch');
    db.exec('DELETE FROM supervision_projection_state');
    expect(resolveSupervisionProjectionEpoch(db as never, () => 'fresh')).toBe('fresh');
  });
});
