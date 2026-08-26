import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SUPERVISION_MODE, normalizeSessionSupervisionSnapshot } from '../../shared/supervision-config.js';
import {
  SUPERVISION_STATE_VERSION,
  SupervisionStateStore,
  getSupervisionStateStore,
  resetSupervisionStateStoreForTests,
  type PersistedSupervisionWaitState,
} from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function state(overrides: Partial<PersistedSupervisionWaitState> = {}): PersistedSupervisionWaitState {
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
    backend: 'codex-sdk',
    model: 'gpt-5.3-codex-spark',
    timeoutMs: 30_000,
    promptVersion: 'supervision_decision_v1',
    maxParseRetries: 1,
    auditMode: 'audit',
    auditTargetSessionName: 'deck_sub_reviewer',
    maxAuditLoops: 2,
  });
  if (!snapshot) throw new Error('test snapshot did not normalize');
  return {
    version: SUPERVISION_STATE_VERSION,
    owner: {
      sessionName: 'deck_supervision_brain',
      sessionInstanceId: 'main-instance',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      runtimeEpoch: 'runtime-before-restart',
      providerId: 'codex-sdk',
      providerSessionId: 'provider-main',
      providerResumeId: 'resume-main',
    },
    commandId: 'cmd-waiting',
    snapshot,
    userText: 'wait for the external result',
    phase: 'waiting',
    requiresAudit: true,
    freshAuditRequiredAfterRework: false,
    continueLoops: 1,
    continueStreakCount: 1,
    reworkDispatches: 0,
    startedAt: 1_000,
    waitingStartedAt: 2_000,
    waitingDeadlineAt: 32_000,
    waitingNextHeartbeatAt: 12_000,
    auditReplyObserved: false,
    auditTargetObservedActive: false,
    auditTargetRecoveryAttempts: 0,
    auditTargetRecoveryLimitNotified: false,
    auditVerdictCorrectionAttempts: 0,
    auditMarkerWarningEmitted: false,
    updatedAt: 2_100,
    ...overrides,
  };
}

describe('SupervisionStateStore', () => {
  it('degrades to a no-op store instead of crashing startup on a corrupt database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-supervision-corrupt-'));
    const dbPath = join(dir, 'state.sqlite');
    const previousPath = process.env.IMCODES_SUPERVISION_STATE_DB_PATH;
    writeFileSync(dbPath, 'not a sqlite database');
    resetSupervisionStateStoreForTests();
    process.env.IMCODES_SUPERVISION_STATE_DB_PATH = dbPath;
    try {
      const store = getSupervisionStateStore();
      expect(store.list()).toEqual([]);
      expect(() => store.upsert(state())).not.toThrow();
      expect(store.get('deck_supervision_brain')).toBeUndefined();
    } finally {
      resetSupervisionStateStoreForTests();
      if (previousPath === undefined) delete process.env.IMCODES_SUPERVISION_STATE_DB_PATH;
      else process.env.IMCODES_SUPERVISION_STATE_DB_PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopens a file-backed SQLite database with the same exact session authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-supervision-state-'));
    const dbPath = join(dir, 'state.sqlite');
    const record = state();
    try {
      const beforeRestart = new SupervisionStateStore({ dbPath });
      beforeRestart.upsert(record);
      beforeRestart.close();

      const afterRestart = new SupervisionStateStore({ dbPath });
      expect(afterRestart.get(record.owner.sessionName)).toEqual(record);
      afterRestart.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips exact main/auditor identities and original deadlines', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SupervisionStateStore({ database: db });
    const record = state({
      phase: 'auditing',
      waitingStartedAt: undefined,
      waitingDeadlineAt: undefined,
      waitingNextHeartbeatAt: undefined,
      auditAttemptId: 'attempt-1',
      auditStartedAt: 5_000,
      auditDeadlineAt: 65_000,
      auditTarget: {
        sessionName: 'deck_sub_reviewer',
        sessionInstanceId: 'audit-instance',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        runtimeEpoch: 'audit-runtime-before-restart',
        providerId: 'claude-code-sdk',
        providerSessionId: 'provider-audit',
      },
    });

    store.upsert(record);

    expect(store.get('deck_supervision_brain')).toEqual(record);
    expect(store.list()).toEqual([record]);
    store.close();
    db.close();
  });

  it('atomically replaces a waiting record and deletes terminal authority', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SupervisionStateStore({ database: db });
    store.upsert(state());
    store.upsert(state({
      waitingNextHeartbeatAt: 22_000,
      updatedAt: 12_100,
      pendingAssistantText: '<!-- IMCODES_EXEC: WAITING -->',
    }));

    expect(store.list()).toHaveLength(1);
    expect(store.get('deck_supervision_brain')).toMatchObject({
      waitingStartedAt: 2_000,
      waitingDeadlineAt: 32_000,
      waitingNextHeartbeatAt: 22_000,
      pendingAssistantText: '<!-- IMCODES_EXEC: WAITING -->',
    });
    store.delete('deck_supervision_brain');
    expect(store.list()).toEqual([]);
    store.close();
    db.close();
  });
});
