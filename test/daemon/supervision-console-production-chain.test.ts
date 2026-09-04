import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { WsBridge } from '../../server/src/ws/bridge.js';
import { sha256Hex } from '../../server/src/security/crypto.js';
import type { Database } from '../../server/src/db/client.js';
import {
  createProductionSupervisionConsoleBinding,
  type SupervisionConsoleLink,
} from '../../src/daemon/supervision-console-binding.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import {
  SUPERVISION_CONSOLE_UNAVAILABLE_REASONS,
  SUPERVISION_TASK_CONSOLE_MSG,
} from '../../shared/supervision-task-console.js';
import type { EffectiveCoverage, ShareTarget } from '../../server/src/ws/share-policy.js';

class LoopbackWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  onSend?: (data: string | Buffer) => void;

  send(data: string | Buffer, _options?: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    this.onSend?.(data);
    callback?.();
  }

  close(): void { this.readyState = 3; this.emit('close'); }

  get sentJson(): Record<string, unknown>[] {
    return this.sent.flatMap((entry) => {
      try { return [JSON.parse(entry.toString()) as Record<string, unknown>]; }
      catch { return []; }
    });
  }
}

function serverDb(): Database {
  return {
    queryOne: async (sql: string) => sql.includes('SELECT token_hash')
      ? { token_hash: sha256Hex('token') }
      : null,
    query: async () => [],
    execute: async () => ({ changes: 0 }),
    exec: async () => undefined,
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(serverDb()),
    close: () => undefined,
  } as unknown as Database;
}

function coverage(target: ShareTarget, role: 'viewer' | 'participant'): EffectiveCoverage {
  return {
    target,
    effectiveRole: role,
    historyCutoffAt: 0,
    nextCoverageRecheckAt: null,
    coveringShareIds: ['share-console'],
    primaryShareId: 'share-console',
    authorizedAt: 1,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('browser -> server bridge -> daemon registry -> browser task-console chain', () => {
  afterEach(() => { WsBridge.getAll().clear(); });

  it('returns the authoritative project snapshot to shared MAIN viewers and participants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-console-chain-'));
    const databasePath = join(dir, 'supervision-state.sqlite');
    const serverId = 'server-console-chain';
    const scope = { projectName: 'alpha', coordinatorSessionName: 'deck_alpha_brain' };
    try {
      const registry = new SupervisionTaskRegistry({ dbPath: databasePath });
      expect(registry.createOrGet({
        taskId: 'task-chain', projectName: 'alpha', objective: 'real production chain',
        currentRevision: 'current-r2',
      }).ok).toBe(true);
      const identity = (sessionName: string) => ({
        sessionName, sessionInstanceId: `${sessionName}-instance`, runtimeEpoch: 'epoch',
        agentType: 'codex-sdk', providerFamily: 'openai',
      });
      expect(registry.createAssignment({
        assignmentId: 'old-worker', taskId: 'task-chain', role: 'implementer',
        identity: identity('deck_alpha_old'), auditRevision: 'old-r1',
      }).ok).toBe(true);
      registry.close();
      const authority = new DatabaseSync(databasePath);
      authority.prepare("UPDATE supervision_tasks SET status='ready_for_integration' WHERE task_id='task-chain'").run();
      authority.prepare("UPDATE supervision_task_assignments SET status='implementing' WHERE assignment_id='old-worker'").run();
      authority.prepare(`INSERT INTO supervision_task_assignments
        (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
         agent_type, provider_family, lease_id, generation, audit_revision, verdict, payload_json, created_at, updated_at)
        VALUES ('current-auditor','task-chain','auditor','finalized','deck_alpha_current','current-instance','epoch',
         'claude-code','anthropic','',1,'current-r2','PASS','{}',2,2)`).run();
      authority.close();

      const bridge = WsBridge.get(serverId);
      const target: ShareTarget = { kind: 'main', serverId, sessionName: scope.coordinatorSessionName };
      bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer'));
      const daemon = new LoopbackWs();
      bridge.handleDaemonConnection(daemon as never, serverDb(), {} as never);
      daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'token' }));
      await flush();

      const inbound: Array<(message: unknown) => void> = [];
      const daemonLink: SupervisionConsoleLink = {
        send: (message) => { daemon.emit('message', JSON.stringify(message)); },
        onMessage: (handler) => { inbound.push(handler); },
      };
      const binding = createProductionSupervisionConsoleBinding({
        databasePath,
        serverLink: daemonLink,
        authorize: (candidate) => candidate.projectName === scope.projectName
          && candidate.coordinatorSessionName === scope.coordinatorSessionName,
        now: () => 9,
        newEpoch: () => 'chain-epoch',
      });
      daemon.onSend = (raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        for (const handler of inbound) handler(parsed);
      };
      daemon.sent.length = 0;

      const viewer = new LoopbackWs();
      bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', serverDb(), {
        ticketId: 'viewer-ticket', target, snapshot: coverage(target, 'viewer'),
      });
      const participant = new LoopbackWs();
      bridge.handleShareBrowserConnection(participant as never, 'participant-user', serverDb(), {
        ticketId: 'participant-ticket', target, snapshot: coverage(target, 'participant'),
      });

      viewer.emit('message', JSON.stringify({
        type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
        subscriptionId: 'viewer-subscription', scope, afterEventId: null, reason: 'initial',
      }));
      participant.emit('message', JSON.stringify({
        type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
        subscriptionId: 'participant-subscription', scope, afterEventId: null, reason: 'initial',
      }));
      await flush();

      for (const browser of [viewer, participant]) {
        expect(browser.sentJson).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
            scope,
            projectionVersion: 0,
            tasks: [expect.objectContaining({
              taskId: 'task-chain', status: 'ready_for_integration',
              currentRevision: 'current-r2',
            })],
            assignments: expect.arrayContaining([
              expect.objectContaining({ assignmentId: 'old-worker', status: 'implementing', auditRevision: 'old-r1' }),
              expect.objectContaining({ assignmentId: 'current-auditor', status: 'finalized', auditRevision: 'current-r2', auditVerdict: 'PASS' }),
            ]),
          }),
        ]));
      }

      // A future authority-query failure must cross the same browser/server/
      // daemon chain as an exact correlated error, never as silence or a fake
      // empty snapshot.
      const breaker = new DatabaseSync(databasePath);
      breaker.exec('DROP TABLE supervision_tasks;');
      breaker.close();
      viewer.sent.length = 0;
      viewer.emit('message', JSON.stringify({
        type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
        subscriptionId: 'viewer-projection-failure', scope, afterEventId: null, reason: 'initial',
      }));
      await flush();
      expect(viewer.sentJson).toEqual([{
        type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
        subscriptionId: 'viewer-projection-failure',
        scope,
        reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
        retryable: true,
      }]);
      binding.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
