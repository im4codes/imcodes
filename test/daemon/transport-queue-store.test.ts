import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTransportQueueStore,
  resetTransportQueueStoreForTests,
  TransportQueueStore,
} from '../../src/daemon/transport-queue-store.js';
import {
  buildTransportQueueSnapshot,
  reconcileObsoleteSupervisionQueueFailures,
  resolveLegacySupervisionQueueReference,
  shouldDismissObsoleteSupervisionQueueEntry,
} from '../../src/daemon/transport-queue-projection.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let dir: string;
let store: TransportQueueStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-transport-queue-'));
  store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TransportQueueStore', () => {
  it('derives the queue action matrix only from typed durable supervision references', () => {
    const integration = {
      kind: 'exact_integration' as const, taskId: 'tsk_done', assignmentId: 'asg_owner', revision: 'rev-1',
    };
    const blocker = {
      kind: 'implementation_blocker' as const, taskId: 'tsk_wait', assignmentId: 'asg_worker',
      revision: 'rev-1',
      exactError: 'waiting for Brain',
    };

    expect(shouldDismissObsoleteSupervisionQueueEntry(integration!, {
      taskId: 'tsk_done', status: 'finalized', currentRevision: 'rev-1',
      assignments: [{
        taskId: 'tsk_done', assignmentId: 'asg_owner', status: 'finalized', auditRevision: 'rev-1',
      }],
    })).toBe(true);
    expect(shouldDismissObsoleteSupervisionQueueEntry(integration!, {
      taskId: 'tsk_done', status: 'ready_for_integration', currentRevision: 'rev-1',
      assignments: [{
        taskId: 'tsk_done', assignmentId: 'asg_owner', status: 'ready_for_integration', auditRevision: 'rev-1',
      }],
    })).toBe(false);
    expect(shouldDismissObsoleteSupervisionQueueEntry(integration!, {
      taskId: 'tsk_done', status: 'ready_for_integration', currentRevision: 'rev-2',
      assignments: [{
        taskId: 'tsk_done', assignmentId: 'asg_owner', status: 'ready_for_integration', auditRevision: 'rev-2',
      }],
    })).toBe(true);
    expect(shouldDismissObsoleteSupervisionQueueEntry(blocker!, {
      taskId: 'tsk_wait', status: 'implementing', currentRevision: 'rev-1',
      assignments: [{
        taskId: 'tsk_wait', assignmentId: 'asg_worker', status: 'implementing', blocker: 'waiting for Brain',
      }],
    })).toBe(false);
    expect(shouldDismissObsoleteSupervisionQueueEntry(blocker!, {
      taskId: 'tsk_wait', status: 'rework', currentRevision: 'rev-2',
      assignments: [{
        taskId: 'tsk_wait', assignmentId: 'asg_worker', status: 'implementing', blocker: 'new audit REWORK',
      }],
    })).toBe(true);
    expect(shouldDismissObsoleteSupervisionQueueEntry(blocker!, {
      taskId: 'tsk_wait', status: 'implementing', currentRevision: 'rev-2',
      assignments: [{
        taskId: 'tsk_wait', assignmentId: 'asg_worker', status: 'implementing',
        auditRevision: 'rev-1', blocker: 'waiting for Brain',
      }],
    }), 'an old structured blocker cannot survive a successor revision').toBe(true);
    expect(shouldDismissObsoleteSupervisionQueueEntry(integration!, undefined)).toBe(false);
  });

  it('durably dismisses only obsolete supervision failures and is version-idempotent on restart/replay', () => {
    const obsoleteText = [
      '[Daemon-resolved exact PASS integration]',
      'taskId=tsk_finalized',
      'assignmentId=asg_finalized',
      'revision=rev-final',
    ].join('\n');
    for (const [id, text, supervisionReference] of [
      ['obsolete', 'wording is not queue authority', {
        kind: 'exact_integration', taskId: 'tsk_finalized', assignmentId: 'asg_finalized', revision: 'rev-final',
      }],
      ['live', 'this body can change without changing lifecycle', {
        kind: 'exact_integration', taskId: 'tsk_live', assignmentId: 'asg_live', revision: 'rev-live',
      }],
      ['ordinary', obsoleteText, undefined],
    ] as const) {
      store.enqueue({
        sessionName: 'deck', clientMessageId: id, text, privateMaterialJson: JSON.stringify({ text }),
        ...(supervisionReference ? { supervisionReference } : {}),
      });
      store.markFailed('deck', id, 'expired');
    }
    const lookup = (taskId: string) => taskId === 'tsk_finalized'
      ? {
          taskId, status: 'finalized', currentRevision: 'rev-final',
          assignments: [{
            taskId, assignmentId: 'asg_finalized', status: 'finalized', auditRevision: 'rev-final',
          }],
        }
      : taskId === 'tsk_live'
        ? {
            taskId, status: 'ready_for_integration', currentRevision: 'rev-live',
            assignments: [{
              taskId, assignmentId: 'asg_live', status: 'ready_for_integration', auditRevision: 'rev-live',
            }],
          }
        : undefined;

    const before = store.readSnapshot('deck');
    expect(reconcileObsoleteSupervisionQueueFailures(store, before, lookup)).toBe(true);
    const after = store.readSnapshot('deck');
    expect(after.pendingMessageVersion).toBeGreaterThan(before.pendingMessageVersion);
    expect(after.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['live', 'ordinary']);
    expect(store.readPrivateDispatchMaterial('deck', 'obsolete')).toBeUndefined();

    const replayVersion = after.pendingMessageVersion;
    store.close();
    store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });
    const afterRestart = store.readSnapshot('deck');
    expect(afterRestart.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['live', 'ordinary']);
    expect(reconcileObsoleteSupervisionQueueFailures(store, afterRestart, lookup)).toBe(false);
    expect(store.readSnapshot('deck').pendingMessageVersion).toBe(replayVersion);
    expect(afterRestart.failedMessageEntries.find((entry) => entry.clientMessageId === 'live')?.supervisionReference)
      .toEqual({ kind: 'exact_integration', taskId: 'tsk_live', assignmentId: 'asg_live', revision: 'rev-live' });
  });

  it('attaches deterministic supervision authority to a legacy row without overwriting conflicts', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'legacy', text: 'old wording' });
    const reference = {
      kind: 'exact_integration' as const, taskId: 'tsk_done', assignmentId: 'asg_owner', revision: 'rev-1',
    };
    expect(store.attachSupervisionReference('deck', 'legacy', reference, 200)).toBe(true);
    expect(store.attachSupervisionReference('deck', 'legacy', reference, 201)).toBe(true);
    expect(store.readSnapshot('deck').pendingMessageEntries[0]?.supervisionReference).toEqual(reference);
    expect(() => store.attachSupervisionReference('deck', 'legacy', {
      ...reference, revision: 'other-revision',
    }, 202)).toThrow('supervision reference mismatch');
  });

  it('migrates an existing queue database to the structured supervision column on restart', () => {
    const dbPath = join(dir, 'queue.sqlite');
    store.close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('ALTER TABLE queue_entries DROP COLUMN supervision_reference_json');
    legacy.close();
    store = new TransportQueueStore({ dbPath });

    const reference = {
      kind: 'exact_integration' as const, taskId: 'tsk_restart', assignmentId: 'asg_restart', revision: 'rev-1',
    };
    store.enqueue({ sessionName: 'deck', clientMessageId: 'after-upgrade', text: 'display', supervisionReference: reference });
    expect(store.readSnapshot('deck').pendingMessageEntries[0]?.supervisionReference).toEqual(reference);
  });

  it('recovers legacy exact-integration and no-progress rows from deterministic ids, never prose', () => {
    const task = {
      taskId: 'tsk_legacy', status: 'finalized', currentRevision: 'rev-1',
      assignments: [{
        taskId: 'tsk_legacy', assignmentId: 'asg_owner', role: 'integration_owner', status: 'finalized',
        auditRevision: 'rev-1', auditAttemptId: 'attempt-1',
      }, {
        taskId: 'tsk_legacy', assignmentId: 'asg_worker', role: 'implementer', status: 'rework',
        auditRevision: 'rev-1',
      }],
      auditReceipts: [{ revision: 'rev-1', attemptId: 'attempt-1' }],
    };
    const integrationId = deterministicSendMessageId('auto-integration:asg_owner:rev-1:attempt-1');
    expect(resolveLegacySupervisionQueueReference(integrationId, [task])).toEqual({
      kind: 'exact_integration', taskId: 'tsk_legacy', assignmentId: 'asg_owner', revision: 'rev-1',
    });
    const fingerprint = createHash('sha256').update(JSON.stringify({
      taskId: 'tsk_legacy', assignmentId: 'asg_worker', revision: 'rev-1', status: 'implementing',
      exactError: 'implementation heartbeat completed without durable progress or structured escalation',
    })).digest('hex');
    expect(resolveLegacySupervisionQueueReference(
      deterministicSendMessageId(`implementation-blocker:${fingerprint}`), [task],
    )).toEqual({
      kind: 'implementation_blocker', taskId: 'tsk_legacy', assignmentId: 'asg_worker',
      revision: 'rev-1',
      exactError: 'implementation heartbeat completed without durable progress or structured escalation',
    });
    expect(resolveLegacySupervisionQueueReference('send_message_00000000-0000-5000-a000-000000000000', [task]))
      .toBeUndefined();
  });

  it('wires terminal-task retirement through the production snapshot boundary', () => {
    resetTransportQueueStoreForTests();
    resetSupervisionTaskRegistryForTests();
    try {
      const queue = getTransportQueueStore();
      const registry = getSupervisionTaskRegistry();
      const created = registry.createOrGet({
        semanticTaskKey: 'terminal-queue-projection',
        projectName: 'queue-test',
        classification: 'independent_top_level',
        objective: 'prove terminal queue projection cleanup',
        currentRevision: 'terminal-rev',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.reason);
      const assigned = registry.createAssignment({
        taskId: created.value.taskId,
        role: 'integration_owner',
        identity: {
          sessionName: 'queue-owner', sessionInstanceId: 'queue-owner-instance', runtimeEpoch: 'queue-owner-epoch',
          agentType: 'codex-sdk', providerFamily: 'openai',
        },
        auditRevision: 'terminal-rev',
      });
      expect(assigned.ok).toBe(true);
      if (!assigned.ok) throw new Error(assigned.reason);
      expect(registry.updateTask({ taskId: created.value.taskId, status: 'cancelled' }).ok).toBe(true);

      const text = [
        '[Daemon-resolved exact PASS integration]',
        `taskId=${created.value.taskId}`,
        `assignmentId=${assigned.value.assignmentId}`,
        'revision=terminal-rev',
      ].join('\n');
      queue.enqueue({
        sessionName: 'queue-target', clientMessageId: 'terminal-card', text,
        supervisionReference: {
          kind: 'exact_integration', taskId: created.value.taskId,
          assignmentId: assigned.value.assignmentId, revision: 'terminal-rev',
        },
      });
      queue.markFailed('queue-target', 'terminal-card', 'expired');
      const beforeVersion = queue.readSnapshot('queue-target').pendingMessageVersion;

      expect(buildTransportQueueSnapshot('queue-target', 'test').failedMessageEntries).toEqual([]);
      const afterVersion = queue.readSnapshot('queue-target').pendingMessageVersion;
      expect(afterVersion).toBeGreaterThan(beforeVersion);
      expect(buildTransportQueueSnapshot('queue-target', 'test').failedMessageEntries).toEqual([]);
      expect(queue.readSnapshot('queue-target').pendingMessageVersion).toBe(afterVersion);
    } finally {
      resetTransportQueueStoreForTests();
      resetSupervisionTaskRegistryForTests();
    }
  });

  it('scrubs only orphaned peer-audit rows and preserves ordinary queued work', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'audit-queued',
      text: 'private audit brief',
      privateMaterialJson: JSON.stringify({
        text: 'private audit brief',
        peerAudit: { contractVersion: 'peer_audit_v1', attemptHash: 'attempt-hash' },
      }),
      now: 100,
    });
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'ordinary-queued',
      text: 'ordinary user task',
      privateMaterialJson: JSON.stringify({ text: 'ordinary user task' }),
      now: 101,
    });

    expect(store.scrubPeerAuditOrphans('deck', 200)).toEqual(['audit-queued']);
    expect(store.readSnapshot('deck').pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['ordinary-queued']);
    expect(store.readPrivateDispatchMaterial('deck', 'audit-queued')).toBeUndefined();
    expect(store.readPrivateDispatchMaterial('deck', 'ordinary-queued')).toContain('ordinary user task');
    expect(store.scrubPeerAuditOrphans('deck', 201)).toEqual([]);
  });

  it('persists live entries in SQLite snapshots with transaction-generated versions', () => {
    const first = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      commandId: 'cmd-1',
      text: 'hello\n\nworld',
      now: 100,
    });
    expect(first.pendingMessageVersion).toBe(1);
    expect(first.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-1']);
    expect(first.pendingMessageEntries[0]?.text).toBe('hello\n\nworld');
    expect(first.pendingMessageEntries[0]?.commandId).toBe('cmd-1');

    const second = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-2',
      text: 'second',
      now: 200,
    });
    expect(second.queueEpoch).toBe(first.queueEpoch);
    expect(second.queueAuthorityId).toBe(first.queueAuthorityId);
    expect(second.pendingMessageVersion).toBe(2);
  });

  it('preserves duplicate, multiline, blank-line, and leading/trailing-space text losslessly by id', () => {
    const firstText = '  same text\n\nwith blank line  ';
    const secondText = '  same text\n\nwith blank line  ';
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: firstText, now: 100 });
    const snapshot = store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-2', text: secondText, now: 101 });

    expect(snapshot.pendingMessageEntries.map((entry) => [entry.clientMessageId, entry.text])).toEqual([
      ['msg-1', firstText],
      ['msg-2', secondText],
    ]);

    const edited = store.edit('deck', 'msg-1', '\n edited text with trailing space \n', 200);
    expect(edited.pendingMessageEntries.find((entry) => entry.clientMessageId === 'msg-1')?.text)
      .toBe('\n edited text with trailing space \n');
    expect(edited.pendingMessageEntries.find((entry) => entry.clientMessageId === 'msg-2')?.text)
      .toBe(secondText);
  });

  it('sorts front placement before normal entries by persisted ordering', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'normal', text: 'normal', now: 100 });
    const snapshot = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'front',
      text: 'front',
      placement: 'front',
      now: 200,
    });
    expect(snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['front', 'normal']);
  });

  it('marks handoff in-flight without deleting the entry and exposes private material only to handoff callers', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'secret dispatch',
      privateMaterialJson: JSON.stringify({ messagePreamble: 'private', daemonPath: '/tmp/secret' }),
      now: 100,
    });

    const handoff = store.markHandoffInFlight('deck', ['msg-1'], 60_000, 200);
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.entry.status).toBe('handoff_inflight');
    expect(handoff[0]?.privateMaterialJson).toContain('private');

    const snapshot = store.readSnapshot('deck');
    expect(snapshot.pendingMessageEntries[0]?.clientMessageId).toBe('msg-1');
    expect(JSON.stringify(snapshot)).not.toContain('daemonPath');
    expect(JSON.stringify(snapshot)).not.toContain('messagePreamble');
  });

  it('releases only the matching handoff back to the queued state', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'first', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-2', text: 'second', now: 101 });
    const handoff = store.markHandoffInFlight('deck', ['msg-1'], 60_000, 200);
    expect(store.markHandoffInFlight('deck', ['msg-1'], 60_000, 201)).toEqual([]);

    const unchanged = store.releaseHandoff('deck', 'wrong-handoff', ['msg-1'], 202);
    expect(unchanged.pendingMessageEntries[0]?.status).toBe('handoff_inflight');

    const released = store.releaseHandoff('deck', handoff[0]!.handoffId, ['msg-1'], 203);
    expect(released.pendingMessageEntries).toEqual([
      expect.objectContaining({ clientMessageId: 'msg-1', status: 'queued' }),
      expect.objectContaining({ clientMessageId: 'msg-2', status: 'queued' }),
    ]);
  });

  it('recovers private dispatch material from SQLite and fails closed when it is missing', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-private',
      text: 'recoverable text',
      privateMaterialJson: JSON.stringify({
        text: 'recoverable text',
        messagePreamble: 'private preamble',
        attachmentRefs: [{ daemonPath: '/tmp/private-path' }],
      }),
      now: 100,
    });

    expect(store.readPrivateDispatchMaterial('deck', 'msg-private')).toContain('private preamble');

    const failed = store.markMissingPrivateMaterialFailed('deck', 'msg-private', 200);
    expect(failed.pendingMessageEntries).toEqual([]);
    expect(failed.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-private']);
    expect(failed.failedMessageEntries[0]?.failureReason).toBe('private_material_missing');
    expect(failed.dropReason).toBe('private_material_missing');
    expect(store.readPrivateDispatchMaterial('deck', 'msg-private')).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('private preamble');
    expect(JSON.stringify(failed)).not.toContain('/tmp/private-path');
  });

  it('finalizes sent entries with a delivery tombstone and removes private material', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'sent',
      privateMaterialJson: JSON.stringify({ messagePreamble: 'private' }),
      now: 100,
    });

    const snapshot = store.finalizeSent('deck', 'msg-1', 'frame-1', 200);
    expect(snapshot.pendingMessageEntries).toEqual([]);
    expect(snapshot.failedMessageEntries).toEqual([]);
    expect(snapshot.pendingMessageVersion).toBe(2);
  });

  it('RV-B clear-on-delivery: an alias providerText is gone from private material once delivered', () => {
    const EXPANDED = 'expanded alias secret value';
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-alias',
      text: 'ping ;;(host) now',
      privateMaterialJson: JSON.stringify({
        clientMessageId: 'msg-alias',
        text: 'ping ;;(host) now',
        providerText: EXPANDED,
      }),
      now: 100,
    });
    // While queued, the expanded value lives in private material (delivery needs it)…
    expect(store.readPrivateDispatchMaterial('deck', 'msg-alias')).toContain(EXPANDED);

    const result = store.finalizeSentBatch('deck', ['msg-alias'], 'frame-alias', 200);

    // … but the moment it is delivered, the private material (and the value) is DELETED.
    expect(store.readPrivateDispatchMaterial('deck', 'msg-alias')).toBeUndefined();
    // The delivered snapshot / diagnostics view never carries the expanded value.
    expect(JSON.stringify(result.snapshot)).not.toContain(EXPANDED);
    expect(result.snapshot.pendingMessageEntries).toEqual([]);
  });

  it('RV-B clear-on-edit: editing a queued alias entry strips the stale providerText from private material', () => {
    const EXPANDED = 'stale expanded alias value';
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-edit',
      text: 'ping ;;(host) now',
      privateMaterialJson: JSON.stringify({
        clientMessageId: 'msg-edit',
        text: 'ping ;;(host) now',
        providerText: EXPANDED,
        messagePreamble: 'per-turn preamble',
      }),
      now: 100,
    });
    expect(store.readPrivateDispatchMaterial('deck', 'msg-edit')).toContain(EXPANDED);

    const snapshot = store.edit('deck', 'msg-edit', 'edited plain text', 200);

    // The entry text is updated…
    expect(snapshot.pendingMessageEntries.map((e) => [e.clientMessageId, e.text])).toEqual([
      ['msg-edit', 'edited plain text'],
    ]);
    // … and the private material forgot the stale expanded value + preamble, but
    // still holds the new verbatim text (so rehydrate delivers the edited text).
    const material = store.readPrivateDispatchMaterial('deck', 'msg-edit');
    expect(material).toBeDefined();
    expect(material).not.toContain(EXPANDED);
    expect(material).not.toContain('per-turn preamble');
    const parsed = JSON.parse(material as string) as Record<string, unknown>;
    expect(parsed.providerText).toBeUndefined();
    expect(parsed.messagePreamble).toBeUndefined();
    expect(parsed.text).toBe('edited plain text');
  });

  it('finalizes a sent batch with one shared delivery frame and one fact per message', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'one', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-2', text: 'two', now: 101 });

    const result = store.finalizeSentBatch('deck', ['msg-1', 'msg-2', 'msg-1'], 'frame-merged', 200);

    expect(result.snapshot.pendingMessageEntries).toEqual([]);
    expect(result.deliveryFacts.map((fact) => fact.clientMessageId)).toEqual(['msg-1', 'msg-2']);
    expect(new Set(result.deliveryFacts.map((fact) => fact.deliveryFrameId))).toEqual(new Set(['frame-merged']));
    expect(new Set(result.deliveryFacts.map((fact) => fact.deliveryFrameVersion))).toEqual(new Set([3]));
    expect(result.deliveryFacts.every((fact) => fact.queueEpoch === result.snapshot.queueEpoch)).toBe(true);
    expect(result.deliveryFacts.every((fact) => fact.queueAuthorityId === result.snapshot.queueAuthorityId)).toBe(true);
    expect(store.hasDeliveryTombstone('deck', 'msg-1')).toBe(true);
    expect(store.hasDeliveryTombstone('deck', 'msg-2')).toBe(true);
  });

  it('keeps failed entries separate from pending entries', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'will fail', now: 100 });
    const snapshot = store.markFailed('deck', 'msg-1', 'dispatch_failed', 200);
    expect(snapshot.pendingMessageEntries).toEqual([]);
    expect(snapshot.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-1']);
    expect(snapshot.failedMessageEntries[0]?.failureReason).toBe('dispatch_failed');
  });

  it('restores expired handoff leases back to queued', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'lease', now: 100 });
    store.markHandoffInFlight('deck', ['msg-1'], 10, 200);
    const snapshot = store.restoreExpiredHandoffs('deck', 211);
    expect(snapshot.pendingMessageEntries[0]?.status).toBe('queued');
  });

  it('restores an unexpired prior-process handoff only when restart recovery is explicit', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-restart', text: 'lease', now: 100 });
    store.markHandoffInFlight('deck', ['msg-restart'], 60_000, 200);
    expect(store.restoreExpiredHandoffs('deck', 201).pendingMessageEntries[0]?.status).toBe('handoff_inflight');
    expect(store.restoreExpiredHandoffs('deck', 202, { includeUnexpired: true }).pendingMessageEntries[0]?.status).toBe('queued');
  });

  it('reset creates a new epoch and clears live entries', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'queued', now: 100 });
    const after = store.reset('deck', 'user_clear', 200);
    expect(after.queueEpoch).not.toBe(before.queueEpoch);
    expect(after.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(after.resetReason).toBe('user_clear');
    expect(after.pendingMessageEntries).toEqual([]);
  });

  it('edits and deletes by stable clientMessageId without normalizing text', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'original',
      now: 100,
    });
    const edited = store.edit('deck', 'msg-1', '  edited\n\nwith spaces  ', 200);
    expect(edited.pendingMessageEntries[0]?.clientMessageId).toBe('msg-1');
    expect(edited.pendingMessageEntries[0]?.text).toBe('  edited\n\nwith spaces  ');

    const deleted = store.markDeleted('deck', 'msg-1', 300);
    expect(deleted.pendingMessageEntries).toEqual([]);
    expect(deleted.failedMessageEntries).toEqual([]);
  });

  it('retries failed entries with a new clientMessageId and replacement relation', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed-original', text: 'original', now: 100 });
    store.markFailed('deck', 'failed-original', 'dispatch_failed', 200);

    const retried = store.retry('deck', 'failed-original', {
      clientMessageId: 'retry-new',
      commandId: 'cmd-retry',
      text: 'retry text',
      now: 300,
    });

    expect(retried.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['retry-new']);
    expect(retried.pendingMessageEntries[0]?.replacesClientMessageId).toBe('failed-original');
    expect(retried.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['failed-original']);
  });

  it('dismisses failed entries without affecting live pending entries', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'live', text: 'live', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed', text: 'failed', now: 101 });
    store.markFailed('deck', 'failed', 'dispatch_failed', 200);

    const dismissed = store.dismissFailed('deck', 'failed', 300);
    expect(dismissed.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['live']);
    expect(dismissed.failedMessageEntries).toEqual([]);
  });

  it('cleanup removes terminal rows after projection-safe terminalization', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed', text: 'failed', now: 100 });
    store.markFailed('deck', 'failed', 'dispatch_failed', 200);
    store.dismissFailed('deck', 'failed', 300);

    const cleaned = store.cleanup('deck', 400);
    expect(cleaned.pendingMessageEntries).toEqual([]);
    expect(cleaned.failedMessageEntries).toEqual([]);
    expect(cleaned.pendingMessageVersion).toBe(4);
  });

  it('records explicit drop/reset reasons for recognized removals', () => {
    for (const [index, reason] of (['expired', 'capacity_evicted', 'user_cleared', 'user_stopped', 'session_removed'] as const).entries()) {
      const id = `drop-${reason}`;
      store.enqueue({ sessionName: 'deck', clientMessageId: id, text: `drop ${reason}`, now: 100 + index });
      const dropped = store.drop('deck', id, reason, 200 + index);
      expect(dropped.dropReason).toBe(reason);
      expect(dropped.pendingMessageEntries.find((entry) => entry.clientMessageId === id)).toBeUndefined();
    }

    for (const [index, reason] of (['sqlite_restore', 'runtime_recreated', 'user_clear', 'authority_corrupt_reinitialized'] as const).entries()) {
      store.enqueue({ sessionName: 'deck', clientMessageId: `reset-${reason}`, text: `reset ${reason}`, now: 300 + index });
      const reset = store.reset('deck', reason, 400 + index);
      expect(reset.resetReason).toBe(reason);
      expect(reset.pendingMessageEntries).toEqual([]);
      expect(reset.failedMessageEntries).toEqual([]);
    }
  });

  it('runtime recreation emits a new authority baseline and does not resurrect old entries', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'old', text: 'old queue', now: 100 });
    const reset = store.reset('deck', 'runtime_recreated', 200, { activityGeneration: 42 });
    expect(reset.queueEpoch).not.toBe(before.queueEpoch);
    expect(reset.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(reset.resetReason).toBe('runtime_recreated');
    expect(reset.activityGeneration).toBe(42);
    expect(reset.pendingMessageEntries).toEqual([]);

    const after = store.enqueue({ sessionName: 'deck', clientMessageId: 'new', text: 'new queue', now: 300 });
    expect(after.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['new']);
    expect(after.pendingMessageEntries.find((entry) => entry.clientMessageId === 'old')).toBeUndefined();
  });

  it('reinitializes corrupt authority with explicit reset metadata', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'old', text: 'old queue', now: 100 });
    const reset = store.reinitializeAfterCorruption('deck', 200, { activityGeneration: 'gen-corrupt' });
    expect(reset.resetReason).toBe('authority_corrupt_reinitialized');
    expect(reset.activityGeneration).toBe('gen-corrupt');
    expect(reset.queueEpoch).not.toBe(before.queueEpoch);
    expect(reset.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(reset.pendingMessageEntries).toEqual([]);
  });

  it('delivery facts and following snapshots reflect only committed state', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'sent', text: 'sent text', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'kept', text: 'kept text', now: 101 });

    const result = store.finalizeSentBatch('deck', ['sent'], 'frame-commit', 200);
    expect(result.deliveryFacts).toHaveLength(1);
    expect(result.deliveryFacts[0]?.pendingMessageVersion).toBe(result.snapshot.pendingMessageVersion);
    expect(result.deliveryFacts[0]?.deliveryFrameVersion).toBe(result.snapshot.pendingMessageVersion);
    expect(result.snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['kept']);
    expect(store.readSnapshot('deck').pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['kept']);
  });

  it('returns privacy-safe degraded diagnostics for busy mutations without speculative writes', () => {
    store.close();
    const dbPath = join(dir, 'busy.sqlite');
    store = new TransportQueueStore({ dbPath, busyTimeoutMs: 1 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'committed', text: 'already committed', now: 100 });

    const locker = new DatabaseSync(dbPath);
    try {
      locker.exec('PRAGMA busy_timeout = 1; BEGIN IMMEDIATE;');
      const result = store.mutateSafely('deck', 'busy_enqueue', () => store.enqueue({
        sessionName: 'deck',
        clientMessageId: 'speculative',
        text: 'must not appear',
        now: 200,
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          degraded: true,
          degradedReason: 'sqlite_busy_or_locked',
        });
        expect(result.snapshot.type).toBe('transport.queue.snapshot');
        if (result.snapshot.degraded) {
          expect(result.snapshot.degradedReason).toBe('sqlite_busy_or_locked');
        } else {
          expect(result.snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['committed']);
        }
        expect(JSON.stringify(result)).not.toContain('must not appear');
      }
    } finally {
      locker.exec('ROLLBACK;');
      locker.close();
    }

    const committed = store.readSnapshot('deck', 'after_busy');
    expect(committed.pendingMessageEntries.map((entry) => [entry.clientMessageId, entry.text])).toEqual([
      ['committed', 'already committed'],
    ]);
  });
});

// A queue row is addressed to a RUNTIME, not to a reusable session name. Before
// this, session_name was the sole recipient key in all four tables and no drain
// path compared identity at all, so a same-named successor drained the previous
// instance's work.
describe('durable queue is bound to the recipient runtime identity', () => {
  const A = { sessionInstanceId: 'instance-A', runtimeEpoch: 'epoch-A' };
  const B = { sessionInstanceId: 'instance-B', runtimeEpoch: 'epoch-B' };
  const NAME = 'deck_shared_name';

  function queueForA() {
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'm1', text: 'for A', now: 10 });
  }

  it('retains A\'s work while A is offline', () => {
    queueForA();
    expect(store.readSnapshot(NAME).pendingMessageEntries).toHaveLength(1);
    expect(store.queueBelongsTo(NAME, A)).toBe(true);
  });

  it('refuses a same-name NEW instance: B cannot consume A\'s queue', () => {
    queueForA();
    expect(store.queueBelongsTo(NAME, B)).toBe(false);
    expect(
      store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, B),
      'B must lease nothing, so its drain aborts',
    ).toEqual([]);
    // Untouched and still A's.
    expect(store.readSnapshot(NAME).pendingMessageEntries).toHaveLength(1);
    expect(store.queueBelongsTo(NAME, A)).toBe(true);
  });

  it('lets A itself consume after coming back', () => {
    queueForA();
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, A)).toHaveLength(1);
  });

  it('refuses an unusable caller identity outright', () => {
    queueForA();
    for (const bad of [undefined, null, { sessionInstanceId: '', runtimeEpoch: 'epoch-A' }, { sessionInstanceId: 'instance-A', runtimeEpoch: '' }]) {
      expect(store.queueBelongsTo(NAME, bad as never)).toBe(false);
      expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, bad as never)).toEqual([]);
    }
  });

  it('quarantines legacy rows that carry no identity', () => {
    // A row written before identity binding existed.
    store.enqueue({ sessionName: 'legacy-name', clientMessageId: 'old', text: 'legacy', now: 10 });
    expect(store.readSnapshot('legacy-name').pendingMessageEntries).toHaveLength(1);
    // Nobody who proves an identity may claim it.
    expect(store.queueBelongsTo('legacy-name', A)).toBe(false);
    expect(store.markHandoffInFlight('legacy-name', ['old'], 60_000, 20, A)).toEqual([]);
  });

  it('survives a store reopen with the binding intact (restart)', () => {
    queueForA();
    const dbPath = join(dir, 'queue.sqlite');
    store.close();
    store = new TransportQueueStore({ dbPath });
    expect(store.queueBelongsTo(NAME, A)).toBe(true);
    expect(store.queueBelongsTo(NAME, B)).toBe(false);
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 30, B)).toEqual([]);
  });

  it('migrates a pre-identity database without delivering its rows to a new instance', () => {
    // Build a database with the OLD shape, then open it with the current store.
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE queue_meta (
        session_name TEXT PRIMARY KEY, queue_epoch TEXT NOT NULL, queue_authority_id TEXT NOT NULL,
        pending_message_version INTEGER NOT NULL DEFAULT 0, next_ordinal INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO queue_meta VALUES ('old-session', 'epoch-1', 'authority-1', 1, 1, 1);
    `);
    legacy.close();
    const migrated = new TransportQueueStore({ dbPath: legacyPath });
    try {
      // The migration added the columns rather than failing to open...
      expect(migrated.readSnapshot('old-session').queueEpoch).toBe('epoch-1');
      // ...and the unidentifiable legacy queue is claimed by nobody.
      expect(migrated.queueBelongsTo('old-session', A)).toBe(false);
      expect(migrated.queueBelongsTo('old-session', B)).toBe(false);
    } finally {
      migrated.close();
    }
  });

  it('scopes delivery tombstones to the queue epoch', () => {
    queueForA();
    const leased = store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, A);
    expect(leased).toHaveLength(1);
    store.finalizeSentBatch(NAME, ['m1'], 'frame-1', 30, A);
    expect(store.hasDeliveryTombstone(NAME, 'm1')).toBe(true);
    // A reset mints a new epoch; a tombstone from the previous epoch must not
    // suppress a legitimately re-queued id.
    store.reset(NAME, 'user_clear', 40);
    expect(store.hasDeliveryTombstone(NAME, 'm1')).toBe(false);
  });

  it('is idempotent: re-leasing the same id does not double-deliver', () => {
    queueForA();
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, A)).toHaveLength(1);
    // Already in flight, so a second lease returns nothing rather than a copy.
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 21, A)).toEqual([]);
  });
});

// The tombstone primary key includes queue_epoch, but the lookup omitted it, so
// a tombstone written under a PREVIOUS epoch suppressed a legitimately re-queued
// id. Passing an explicit epoch is what makes the filter observable.
describe('delivery tombstones are epoch-scoped', () => {
  const A = { sessionInstanceId: 'instance-A', runtimeEpoch: 'epoch-A' };

  it('does not let a previous epoch tombstone suppress the current one', () => {
    const NAME = 'epoch-scoped-tombstone';
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'm1', text: 'first', now: 10 });
    const firstEpoch = store.readSnapshot(NAME).queueEpoch;
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 20, A)).toHaveLength(1);
    store.finalizeSentBatch(NAME, ['m1'], 'frame-1', 30, A);
    expect(store.hasDeliveryTombstone(NAME, 'm1', firstEpoch)).toBe(true);

    // New epoch, same client id re-queued and delivered again.
    store.reset(NAME, 'user_clear', 40);
    const secondEpoch = store.readSnapshot(NAME).queueEpoch;
    expect(secondEpoch).not.toBe(firstEpoch);
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'm1', text: 'second', now: 50 });
    expect(store.markHandoffInFlight(NAME, ['m1'], 60_000, 60, A)).toHaveLength(1);
    store.finalizeSentBatch(NAME, ['m1'], 'frame-2', 70, A);

    // Each epoch answers for itself.
    expect(store.hasDeliveryTombstone(NAME, 'm1', secondEpoch)).toBe(true);
    expect(
      store.hasDeliveryTombstone(NAME, 'm1', firstEpoch),
      'a superseded epoch must not answer for the current one',
    ).toBe(false);
  });
});

// The live incident: rows sat in `handoff_inflight` with handoff_expires_at
// ~6,397s in the past because the lease was taken before a daemon restart and
// nothing on a generic path ever restored it.
describe('expired handoff leases survive restart and stay recoverable', () => {
  const A = { sessionInstanceId: 'instance-A', runtimeEpoch: 'epoch-A' };
  const NAME = 'stale-handoff-session';

  it('recovers an expired lease taken before a restart, and leaves an active one alone', () => {
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'stale', text: 'stale', now: 10 });
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'live', text: 'live', now: 11 });
    // 'stale' leased long ago with a tiny TTL; 'live' leased with a long one.
    expect(store.markHandoffInFlight(NAME, ['stale'], 1, 1_000, A)).toHaveLength(1);
    expect(store.markHandoffInFlight(NAME, ['live'], 600_000, 2_000, A)).toHaveLength(1);

    // Daemon restart: reopen the same database file.
    const dbPath = join(dir, 'queue.sqlite');
    store.close();
    store = new TransportQueueStore({ dbPath });

    const statusesBefore = new Map(
      store.readSnapshot(NAME).pendingMessageEntries.map((e) => [e.clientMessageId, e.status]),
    );
    expect(statusesBefore.get('stale')).toBe('handoff_inflight');
    expect(statusesBefore.get('live')).toBe('handoff_inflight');

    store.restoreExpiredHandoffs(NAME, 100_000);

    const statusesAfter = new Map(
      store.readSnapshot(NAME).pendingMessageEntries.map((e) => [e.clientMessageId, e.status]),
    );
    expect(statusesAfter.get('stale'), 'an expired lease must be recoverable').toBe('queued');
    expect(statusesAfter.get('live'), 'an active lease must not be yanked back').toBe('handoff_inflight');
  });

  it('is idempotent: repeating the recovery changes nothing further', () => {
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'stale', text: 'stale', now: 10 });
    store.markHandoffInFlight(NAME, ['stale'], 1, 1_000, A);
    store.restoreExpiredHandoffs(NAME, 100_000);
    const first = store.readSnapshot(NAME).pendingMessageEntries.map((e) => [e.clientMessageId, e.status]);
    store.restoreExpiredHandoffs(NAME, 100_001);
    expect(store.readSnapshot(NAME).pendingMessageEntries.map((e) => [e.clientMessageId, e.status])).toEqual(first);
  });

  it('moves the same message to explicit failed state after the bounded handoff budget', () => {
    store.enqueue({ sessionName: NAME, recipient: A, clientMessageId: 'exhausted', text: 'same message', now: 10 });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(store.markHandoffInFlight(NAME, ['exhausted'], 1, 100 + attempt * 10, A)).toHaveLength(1);
      store.restoreExpiredHandoffs(NAME, 102 + attempt * 10);
    }

    const snapshot = store.readSnapshot(NAME);
    expect(snapshot.pendingMessageEntries).toHaveLength(0);
    expect(snapshot.failedMessageEntries).toEqual([
      expect.objectContaining({ clientMessageId: 'exhausted', status: 'failed', failureReason: 'dispatch_failed' }),
    ]);
  });
});

// Every recipient-sensitive read/write must compare the CALLER's proven identity
// against the row, and fail closed when it is missing or different. Leaving drop
// / finalize / private-material ungated let a same-named successor destroy or
// read another instance's queued work even though it could not drain it.
describe('recipient-sensitive store operations are identity-gated', () => {
  const A = { sessionInstanceId: 'instance-A', runtimeEpoch: 'epoch-A' };
  const B = { sessionInstanceId: 'instance-B', runtimeEpoch: 'epoch-B' };
  const NAME = 'gated-ops-session';

  function queueForA() {
    store.enqueue({
      sessionName: NAME, recipient: A, clientMessageId: 'm-a', text: 'for A', now: 10,
      privateMaterialJson: JSON.stringify({ clientMessageId: 'm-a', text: 'for A' }),
    });
  }
  const pending = () => store.readSnapshot(NAME).pendingMessageEntries;

  it('B cannot drop A\'s row', () => {
    queueForA();
    store.drop(NAME, 'm-a', 'user_cleared', 20, B);
    expect(pending(), 'a same-name successor must not destroy A\'s queued work').toHaveLength(1);
  });

  it('a caller proving no identity cannot drop an identity-bound row', () => {
    queueForA();
    store.drop(NAME, 'm-a', 'user_cleared', 20);
    expect(pending()).toHaveLength(1);
  });

  it('A can drop its own row', () => {
    queueForA();
    store.drop(NAME, 'm-a', 'user_cleared', 20, A);
    expect(pending()).toHaveLength(0);
  });

  it('atomically carries queued work across a runtime-epoch rotation of the same logical instance', () => {
    queueForA();
    const next = { sessionInstanceId: A.sessionInstanceId, runtimeEpoch: 'epoch-A-next' };

    expect(store.rebindRecipientRuntimeEpoch(NAME, A, next, 20)).toBe(true);
    expect(store.queueBelongsTo(NAME, A)).toBe(false);
    expect(store.queueBelongsTo(NAME, next)).toBe(true);
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', A)).toBeUndefined();
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', next)).toBeTypeOf('string');
  });

  it('refuses recipient recovery across logical session instances', () => {
    queueForA();
    const replacement = { sessionInstanceId: 'instance-replacement', runtimeEpoch: 'epoch-new' };

    expect(store.rebindRecipientRuntimeEpoch(NAME, A, replacement, 20)).toBe(false);
    expect(store.queueBelongsTo(NAME, A)).toBe(true);
    expect(store.queueBelongsTo(NAME, replacement)).toBe(false);
  });

  it('refuses epoch rebinding when any recipient-bearing row conflicts with the expected identity', () => {
    queueForA();
    const dbPath = join(dir, 'queue.sqlite');
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare(`
        UPDATE queue_private_material
        SET recipient_session_instance_id = ?, recipient_runtime_epoch = ?
        WHERE session_name = ? AND client_message_id = ?
      `).run(B.sessionInstanceId, B.runtimeEpoch, NAME, 'm-a');
    } finally {
      raw.close();
    }
    const next = { sessionInstanceId: A.sessionInstanceId, runtimeEpoch: 'epoch-A-next' };

    expect(store.rebindRecipientRuntimeEpoch(NAME, A, next, 20)).toBe(false);
    expect(store.queueBelongsTo(NAME, A)).toBe(true);
    expect(store.queueBelongsTo(NAME, next)).toBe(false);
  });

  it('durably tombstones an accepted delete so a late enqueue cannot resurrect the same message', () => {
    queueForA();
    const cancelled = store.cancelQueuedMessage(NAME, 'm-a', A, 20);
    expect(cancelled.status).toBe('accepted');
    expect(cancelled.snapshot.pendingMessageEntries).toHaveLength(0);

    store.close();
    store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });

    const late = store.enqueueWithCapacityEviction({
      sessionName: NAME,
      recipient: A,
      clientMessageId: 'm-a',
      commandId: 'm-a',
      text: 'late callback',
      now: 30,
      privateMaterialJson: JSON.stringify({ clientMessageId: 'm-a', text: 'late callback' }),
    });
    expect(late.cancelled).toBe(true);
    expect(late.queueSnapshot.pendingMessageEntries).toHaveLength(0);
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', A)).toBeUndefined();
    expect(store.cancelQueuedMessage(NAME, 'm-a', A, 40).status).toBe('accepted');
  });

  it('keeps a cancellation final when a late callback carries the prior epoch of the same instance', () => {
    queueForA();
    expect(store.cancelQueuedMessage(NAME, 'm-a', A, 20).status).toBe('accepted');
    const rotated = { sessionInstanceId: A.sessionInstanceId, runtimeEpoch: 'epoch-A-current' };
    expect(store.rebindRecipientRuntimeEpoch(NAME, A, rotated, 21)).toBe(true);

    const late = store.enqueueWithCapacityEviction({
      sessionName: NAME,
      recipient: A,
      clientMessageId: 'm-a',
      commandId: 'legacy-command-id',
      text: 'stale callback must not resurrect',
      now: 22,
      privateMaterialJson: JSON.stringify({ text: 'stale callback must not resurrect' }),
    });
    expect(late.cancelled).toBe(true);
    expect(store.readSnapshot(NAME).pendingMessageEntries).toEqual([]);
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', A)).toBeUndefined();
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', rotated)).toBeUndefined();

    const reusedName = { sessionInstanceId: 'different-instance', runtimeEpoch: 'epoch-A-current' };
    const replacement = store.enqueueWithCapacityEviction({
      sessionName: NAME,
      recipient: reusedName,
      clientMessageId: 'm-a',
      text: 'different instance starts fresh after old aggregate is discarded',
      now: 23,
    });
    expect(replacement.cancelled).toBeUndefined();
    expect(replacement.queueSnapshot.pendingMessageEntries)
      .toEqual([expect.objectContaining({ clientMessageId: 'm-a' })]);
    expect(store.queueBelongsTo(NAME, reusedName)).toBe(true);
    expect(store.queueBelongsTo(NAME, rotated)).toBe(false);
  });

  it('can destructively discard stale queue state and rebound an empty queue to the current recipient', () => {
    store.enqueue({
      sessionName: NAME,
      recipient: A,
      clientMessageId: 'live',
      text: 'live private text',
      now: 10,
      privateMaterialJson: JSON.stringify({ text: 'live private text' }),
    });
    store.enqueue({
      sessionName: NAME,
      recipient: A,
      clientMessageId: 'sent',
      text: 'sent private text',
      now: 11,
      privateMaterialJson: JSON.stringify({ text: 'sent private text' }),
    });
    expect(store.markHandoffInFlight(NAME, ['sent'], 60_000, 12, A)).toHaveLength(1);
    store.finalizeSentBatch(NAME, ['sent'], 'frame-sent', 13, A);
    expect(store.cancelQueuedMessage(NAME, 'cancelled-before-enqueue', A, 14).status).toBe('accepted');

    const discarded = store.discardSessionQueueState(NAME, B, 20);

    expect(discarded).toEqual({
      queueEntries: 1,
      privateMaterials: 1,
      deliveryTombstones: 1,
      cancellationTombstones: 1,
      queueMeta: 1,
      rebound: true,
    });
    expect(store.queueBelongsTo(NAME, A)).toBe(false);
    expect(store.queueBelongsTo(NAME, B)).toBe(true);
    expect(store.readSnapshotForRecipient(NAME, B).pendingMessageEntries).toEqual([]);
    expect(store.readPrivateDispatchMaterial(NAME, 'live', A)).toBeUndefined();
    expect(store.hasDeliveryTombstone(NAME, 'sent')).toBe(false);
  });

  it('does not let a replacement instance tombstone or delete another instance queue row', () => {
    queueForA();
    const result = store.cancelQueuedMessage(NAME, 'm-a', B, 20);
    expect(result.status).toBe('identity_mismatch');
    expect(pending()).toHaveLength(1);
  });

  it('fails closed when a restarted identified runtime cancels a legacy NULL-identity row', () => {
    const legacyName = 'legacy-cancel-after-restart';
    store.enqueue({
      sessionName: legacyName,
      clientMessageId: 'legacy-message',
      text: 'must remain quarantined',
      now: 10,
      privateMaterialJson: JSON.stringify({ text: 'must remain quarantined' }),
    });
    store.close();
    store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });

    const first = store.cancelQueuedMessage(legacyName, 'legacy-message', A, 20);
    expect(first.status).toBe('identity_mismatch');
    // A refused delete is read-only. In particular, ensureMeta must not bind
    // queue_meta to the rejected caller while the child rows remain legacy.
    expect(store.queueBelongsTo(legacyName, A)).toBe(false);
    expect(first.snapshot.pendingMessageEntries).toEqual([
      expect.objectContaining({ clientMessageId: 'legacy-message' }),
    ]);
    expect(store.readPrivateDispatchMaterial(legacyName, 'legacy-message')).toContain('must remain quarantined');

    const repeated = store.cancelQueuedMessage(legacyName, 'legacy-message', A, 21);
    expect(repeated.status).toBe('identity_mismatch');
    expect(store.queueBelongsTo(legacyName, A)).toBe(false);
    expect(store.readSnapshot(legacyName).pendingMessageEntries).toHaveLength(1);
    expect(store.readPrivateDispatchMaterial(legacyName, 'legacy-message')).toContain('must remain quarantined');
  });

  it('purges pre-session legacy ghosts in bounded restart-durable batches without exposing private material', () => {
    const legacyName = 'legacy-stale-before-session';
    for (const [index, id] of ['ghost-1', 'ghost-2'].entries()) {
      store.enqueue({
        sessionName: legacyName,
        clientMessageId: id,
        commandId: id,
        text: `private ghost ${index + 1}`,
        now: 10 + index,
        privateMaterialJson: JSON.stringify({ text: `private ghost ${index + 1}` }),
      });
    }
    const adopt = () => store.adoptLegacyRecipientIdentity(
      legacyName,
      A,
      { sessionCreatedAt: 50 },
      { limit: 1 },
    );

    expect(adopt()).toMatchObject({ status: 'pending', migrated: 0, purged: 2 });
    expect(store.readSnapshot(legacyName).pendingMessageEntries).toHaveLength(1);
    store.close();
    store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });

    expect(adopt()).toMatchObject({ status: 'adopted', migrated: 0, purged: 2 });
    expect(store.readSnapshot(legacyName).pendingMessageEntries).toEqual([]);
    expect(store.readPrivateDispatchMaterial(legacyName, 'ghost-1', A)).toBeUndefined();
    expect(store.readPrivateDispatchMaterial(legacyName, 'ghost-2', A)).toBeUndefined();
    expect(store.queueBelongsTo(legacyName, A)).toBe(true);
    expect(adopt()).toEqual({ status: 'already_bound', migrated: 0 });

    // A duplicate delete remains accepted and durable; a late execution using
    // the same id cannot resurrect the purged private payload.
    expect(store.cancelQueuedMessage(legacyName, 'ghost-1', A, 100).status).toBe('accepted');
    expect(store.cancelQueuedMessage(legacyName, 'ghost-1', A, 101).status).toBe('accepted');
    const late = store.enqueueWithCapacityEviction({
      sessionName: legacyName,
      recipient: A,
      clientMessageId: 'ghost-1',
      commandId: 'ghost-1',
      text: 'must not return',
      now: 102,
      privateMaterialJson: JSON.stringify({ text: 'must not return' }),
    });
    expect(late.cancelled).toBe(true);
    expect(store.readPrivateDispatchMaterial(legacyName, 'ghost-1', A)).toBeUndefined();
  });

  it('adopts one original-session legacy queue in bounded restart-durable batches, then delete stays final', () => {
    const legacyName = 'legacy-adopt-after-restart';
    for (const [index, id] of ['legacy-1', 'legacy-2'].entries()) {
      store.enqueue({
        sessionName: legacyName,
        clientMessageId: id,
        commandId: id,
        text: `legacy ${index + 1}`,
        now: 100 + index,
        privateMaterialJson: JSON.stringify({ clientMessageId: id, text: `legacy ${index + 1}` }),
      });
    }
    const adopt = () => (store as unknown as {
      adoptLegacyRecipientIdentity(
        sessionName: string,
        recipient: typeof A,
        evidence: { sessionCreatedAt: number },
        options: { limit: number },
      ): { status: 'pending' | 'adopted' | 'already_bound' | 'identity_conflict'; migrated: number };
    }).adoptLegacyRecipientIdentity(legacyName, A, { sessionCreatedAt: 50 }, { limit: 1 });

    // R2's first fail-closed delete could bind queue_meta while leaving the
    // legacy child rows NULL. The aggregate must still expose unfinished
    // migration and let the restart-safe adoption resume.
    expect(store.cancelQueuedMessage(legacyName, 'legacy-1', A, 150).status).toBe('identity_mismatch');
    expect(store.hasLegacyRecipientRows(legacyName)).toBe(true);
    // The bound is one logical message id, so its public row and private
    // material migrate atomically in the same batch.
    expect(adopt()).toEqual({ status: 'pending', migrated: 2 });
    store.close();
    store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });

    let result = adopt();
    let calls = 1;
    while (result.status === 'pending' && calls < 8) {
      result = adopt();
      calls++;
    }
    // The first invocation before restart migrated logical id #1; the first
    // invocation after restart atomically migrates logical id #2 and finishes.
    expect(calls).toBe(1);
    expect(result.status).toBe('adopted');
    expect(store.queueBelongsTo(legacyName, A)).toBe(true);
    expect(store.readPrivateDispatchMaterial(legacyName, 'legacy-1', A)).toContain('legacy 1');

    expect(store.cancelQueuedMessage(legacyName, 'legacy-1', A, 200).status).toBe('accepted');
    expect(store.readPrivateDispatchMaterial(legacyName, 'legacy-1', A)).toBeUndefined();
    const late = store.enqueueWithCapacityEviction({
      sessionName: legacyName,
      recipient: A,
      clientMessageId: 'legacy-1',
      commandId: 'legacy-1',
      text: 'late duplicate',
      now: 201,
      privateMaterialJson: JSON.stringify({ text: 'late duplicate' }),
    });
    expect(late.cancelled).toBe(true);
    expect(store.readSnapshot(legacyName).pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['legacy-2']);
  });

  it('purges an older same-name legacy row but refuses equal-time or conflicting recipient evidence', () => {
    const legacyName = 'legacy-adopt-older';
    store.enqueue({
      sessionName: legacyName,
      clientMessageId: 'legacy',
      text: 'belongs to the earlier record',
      now: 100,
      privateMaterialJson: JSON.stringify({ text: 'belongs to the earlier record' }),
    });
    const adopter = store as unknown as {
      adoptLegacyRecipientIdentity(
        sessionName: string,
        recipient: typeof A,
        evidence: { sessionCreatedAt: number },
        options?: { limit?: number },
      ): { status: string; migrated: number };
    };

    expect(adopter.adoptLegacyRecipientIdentity(
      legacyName,
      A,
      { sessionCreatedAt: 101 },
    )).toEqual({ status: 'adopted', migrated: 0, purged: 2 });
    expect(store.readSnapshot(legacyName).pendingMessageEntries).toEqual([]);
    expect(store.readPrivateDispatchMaterial(legacyName, 'legacy')).toBeUndefined();

    const equalName = 'legacy-adopt-equal';
    store.enqueue({
      sessionName: equalName,
      clientMessageId: 'legacy',
      text: 'timestamp remains ambiguous',
      now: 100,
      privateMaterialJson: JSON.stringify({ text: 'timestamp remains ambiguous' }),
    });
    // Equal millisecond is not unique ownership evidence: a remove/recreate
    // can share the timestamp quantum with the old row, so adoption stays
    // fail-closed rather than guessing by name.
    expect(adopter.adoptLegacyRecipientIdentity(
      equalName,
      A,
      { sessionCreatedAt: 100 },
    )).toEqual({ status: 'identity_conflict', migrated: 0 });

    const conflictName = 'legacy-adopt-foreign';
    store.enqueue({
      sessionName: conflictName,
      clientMessageId: 'legacy',
      text: 'belongs to another recipient',
      now: 100,
      privateMaterialJson: JSON.stringify({ text: 'belongs to another recipient' }),
    });
    const raw = new DatabaseSync(join(dir, 'queue.sqlite'));
    try {
      raw.prepare(`
        UPDATE queue_private_material
        SET recipient_session_instance_id = ?, recipient_runtime_epoch = ?
        WHERE session_name = ? AND client_message_id = ?
      `).run(B.sessionInstanceId, B.runtimeEpoch, conflictName, 'legacy');
    } finally {
      raw.close();
    }
    expect(adopter.adoptLegacyRecipientIdentity(
      conflictName,
      A,
      { sessionCreatedAt: 50 },
    )).toEqual({ status: 'identity_conflict', migrated: 0 });
    expect(store.queueBelongsTo(conflictName, A)).toBe(false);
    expect(store.readPrivateDispatchMaterial(conflictName, 'legacy', A)).toBeUndefined();
    expect(store.readPrivateDispatchMaterial(conflictName, 'legacy', B)).toContain('another recipient');
  });

  it('reconciles a canonical SessionRecord across mixed epochs of the same instance before delete', () => {
    const name = 'same-instance-mixed-epochs';
    const canonical = { sessionInstanceId: 'stable-instance', runtimeEpoch: 'epoch-current' };
    const stale = { sessionInstanceId: canonical.sessionInstanceId, runtimeEpoch: 'epoch-stale' };
    store.enqueue({
      sessionName: name,
      recipient: stale,
      clientMessageId: 'older-runtime-row',
      text: 'same logical session before restart',
      now: 110,
      privateMaterialJson: JSON.stringify({ text: 'same logical session before restart' }),
    });
    // Reproduce the production split: queue_meta still names a stale runtime
    // generation while a later enqueue already carries the SessionRecord's
    // canonical generation. Ungated snapshots display the latter card, but a
    // meta-only identity check used to make its delete return not-found.
    store.enqueue({
      sessionName: name,
      recipient: canonical,
      clientMessageId: 'displayed-current-row',
      text: 'the card selected by the user',
      now: 120,
      privateMaterialJson: JSON.stringify({ text: 'the card selected by the user' }),
    });
    expect(store.readSnapshotForRecipient(name, canonical).pendingMessageEntries)
      .toEqual([expect.objectContaining({ clientMessageId: 'displayed-current-row' })]);
    expect(store.cancelQueuedMessage(name, 'displayed-current-row', canonical, 130).status)
      .toBe('identity_mismatch');

    expect(store.adoptLegacyRecipientIdentity(name, canonical, { sessionCreatedAt: 100 }))
      .toMatchObject({ status: 'adopted', migrated: 2 });
    expect(store.queueBelongsTo(name, canonical)).toBe(true);
    expect(store.readSnapshotForRecipient(name, canonical).pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['older-runtime-row', 'displayed-current-row']);
    expect(store.cancelQueuedMessage(name, 'displayed-current-row', canonical, 140).status)
      .toBe('accepted');
    expect(store.readPrivateDispatchMaterial(name, 'displayed-current-row', canonical)).toBeUndefined();

    // A same-named but different stable instance is never an epoch rotation.
    const foreign = { sessionInstanceId: 'foreign-instance', runtimeEpoch: 'epoch-current' };
    expect(store.adoptLegacyRecipientIdentity(name, foreign, { sessionCreatedAt: 100 }))
      .toEqual({ status: 'identity_conflict', migrated: 0 });
  });

  it('B cannot read A\'s private dispatch material', () => {
    queueForA();
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', B)).toBeUndefined();
    expect(store.readPrivateDispatchMaterial(NAME, 'm-a', A)).toBeTypeOf('string');
  });

  it('B cannot finalize A\'s row as delivered', () => {
    queueForA();
    expect(store.markHandoffInFlight(NAME, ['m-a'], 60_000, 20, A)).toHaveLength(1);
    store.finalizeSentBatch(NAME, ['m-a'], 'frame-B', 30, B);
    // Still present and NOT tombstoned by the wrong runtime.
    expect(pending()).toHaveLength(1);
    expect(store.hasDeliveryTombstone(NAME, 'm-a')).toBe(false);
    // A finalizes its own.
    store.finalizeSentBatch(NAME, ['m-a'], 'frame-A', 40, A);
    expect(store.hasDeliveryTombstone(NAME, 'm-a')).toBe(true);
  });
});
