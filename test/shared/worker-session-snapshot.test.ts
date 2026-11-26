import { describe, expect, it } from 'vitest';
import {
  WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON,
  WORKER_SESSION_SNAPSHOT_VERSION,
  WORKER_SESSION_SYNC_STATUS,
  buildWorkerSessionSnapshotCompleteResponse,
  normalizeWorkerSessionRows,
  normalizeWorkerSubSessionRows,
} from '../../shared/worker-session-snapshot.js';
import { buildWorkerSessionSyncPlan } from '../../src/daemon/worker-session-sync-plan.js';

describe('worker session snapshot normalization', () => {
  it('skips removed legacy agent types in session and sub-session rows while keeping valid rows', () => {
    const sessions = normalizeWorkerSessionRows([
      {
        name: 'deck_valid_brain',
        project_name: 'valid',
        role: 'brain',
        agent_type: 'claude-code-sdk',
        project_dir: '/tmp/valid',
        state: 'idle',
      },
      {
        name: 'deck_legacy_gemini',
        project_name: 'legacy',
        role: 'brain',
        agent_type: 'gemini',
        project_dir: '/tmp/legacy',
        state: 'idle',
      },
      {
        name: 'deck_legacy_gemini_sdk',
        project_name: 'legacy-sdk',
        role: 'w1',
        agent_type: 'gemini-sdk',
        project_dir: '/tmp/legacy-sdk',
        state: 'stopped',
      },
    ]);

    expect(sessions.ok).toBe(true);
    expect(sessions.issues).toEqual([]);
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]?.name).toBe('deck_valid_brain');

    const subSessions = normalizeWorkerSubSessionRows([
      { id: 'sub-legacy-1', type: 'gemini', cwd: '/tmp/legacy', parent_session: 'deck_valid_brain' },
      { id: 'sub-valid-1', type: 'codex-sdk', cwd: '/tmp/valid', parent_session: 'deck_valid_brain' },
      { id: 'sub-legacy-2', type: 'gemini-sdk', cwd: '/tmp/legacy-2', parent_session: 'deck_valid_brain' },
    ]);

    expect(subSessions.ok).toBe(true);
    expect(subSessions.issues).toEqual([]);
    expect(subSessions.rows).toHaveLength(1);
    expect(subSessions.rows[0]?.id).toBe('sub-valid-1');
  });

  it('handles snapshots whose subSessions consist only of removed legacy agent types', () => {
    const subSessions = normalizeWorkerSubSessionRows([
      { id: 'sub-legacy-only', type: 'gemini', cwd: '/tmp/legacy' },
      { id: 'sub-legacy-sdk-only', type: 'gemini-sdk', cwd: '/tmp/legacy-sdk' },
    ]);

    expect(subSessions).toEqual({ ok: true, rows: [], issues: [] });

    const plan = buildWorkerSessionSyncPlan(
      {
        source: 'snapshot',
        response: buildWorkerSessionSnapshotCompleteResponse({
          serverId: 'srv-1',
          generatedAt: 100,
          sessions: [
            {
              name: 'deck_proj_brain',
              project_name: 'proj',
              role: 'brain',
              agent_type: 'codex-sdk',
              project_dir: '/tmp/proj',
              state: 'idle',
            },
          ],
          subSessions: [
            { id: 'sub-legacy-only', type: 'gemini', cwd: '/tmp/legacy', parent_session: 'deck_proj_brain' },
            { id: 'sub-legacy-sdk-only', type: 'gemini-sdk', cwd: '/tmp/legacy-sdk', parent_session: 'deck_proj_brain' },
          ],
        }),
      },
      'srv-1',
      [],
    );

    expect(plan.status).toBe(WORKER_SESSION_SYNC_STATUS.APPLIED);
    expect(plan.issues).toEqual([]);
    expect(plan.mainUpserts.map((s) => s.name)).toEqual(['deck_proj_brain']);
    expect(plan.remoteSubSessionNames).toEqual([]);
  });

  it('still rejects arbitrary unknown agent types and corrupt non-object rows', () => {
    const unknownSession = normalizeWorkerSessionRows([
      {
        name: 'deck_unknown',
        project_name: 'proj',
        role: 'brain',
        agent_type: 'totally-unknown',
        project_dir: '/tmp/proj',
        state: 'idle',
      },
    ]);
    expect(unknownSession.ok).toBe(false);
    expect(unknownSession.issues).toContain('sessions[0].agent_type: invalid agent type');

    const unknownSub = normalizeWorkerSubSessionRows([
      { id: 'sub-unknown', type: 'totally-unknown', cwd: '/tmp/proj' },
    ]);
    expect(unknownSub.ok).toBe(false);
    expect(unknownSub.issues).toContain('subSessions[0].type: invalid agent type');

    const corruptRow = normalizeWorkerSessionRows([
      null,
      {
        name: 'deck_legacy_gemini',
        project_name: 'legacy',
        role: 'brain',
        agent_type: 'gemini',
        project_dir: '/tmp/legacy',
        state: 'idle',
      },
    ]);
    expect(corruptRow.ok).toBe(false);
    expect(corruptRow.issues).toContain('sessions[0]: expected object');

    const degradedPlan = buildWorkerSessionSyncPlan(
      {
        source: 'snapshot',
        response: {
          version: WORKER_SESSION_SNAPSHOT_VERSION,
          complete: true,
          serverId: 'srv-1',
          generatedAt: 100,
          snapshotId: 'srv-1:100',
          counts: { sessions: 0, subSessions: 1 },
          sessions: [],
          subSessions: [{ id: 'sub-bogus', type: 'totally-unknown' }],
        },
      },
      'srv-1',
      [],
    );
    expect(degradedPlan.status).toBe(WORKER_SESSION_SYNC_STATUS.DEGRADED);
    expect(degradedPlan.reason).toBe(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW);
  });
});
