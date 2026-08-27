import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  SupervisionTaskRegistry,
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../src/daemon/send-tool.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { SUPERVISION_TASK_REGISTRY_CONTRACT } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { resolvePeerAuditProviderFamily } from '../../shared/peer-audit.js';

/** Adapts the real registry to the audited handler port. */
function supervisionRegistryPort() {
  const registry = getSupervisionTaskRegistry();
  return {
    getStatus: (taskId: string) => registry.get(taskId)?.status,
    applyIntent: () => {},
    list: (filter: never) => registry.list(filter) as never,
    get: (taskId: string) => registry.get(taskId) as never,
    recover: () => {},
  };
}

function persistedExecutionBinding(name: string) {
  const requested = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6' };
  return {
    pool: 'primary' as const,
    requested: { ...requested, capabilityId: buildSupervisionExecutionCapabilityId(requested) },
    actual: { sessionName: name, sessionInstanceId: `instance-${name}`, runtimeEpoch: `epoch-${name}`, ...requested },
    origin: 'reused' as const,
  };
}

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function identity(name: string, agentType = 'codex-sdk'): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType,
    providerFamily: resolvePeerAuditProviderFamily({ agentType }),
  };
}

function session(name: string, projectName = 'alpha', agentType = 'codex-sdk'): SessionRecord {
  const selected = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-5.6' };
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName,
    role: name.endsWith('_brain') ? 'brain' : 'w1',
    agentType,
    projectDir: `/work/${projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    label: name,
    requestedModel: 'gpt-5.6',
    activeModel: 'gpt-5.6',
    runtimeType: 'transport',
    transportConfig: name.endsWith('_brain') ? {
      supervision: {
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: { configs: [{ ...selected, capabilityId: buildSupervisionExecutionCapabilityId(selected) }] },
          economyTaskPool: { configs: [] },
        },
      },
    } : undefined,
  } as SessionRecord;
}

function makeRegistry(): SupervisionTaskRegistry {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
}

beforeEach(() => {
  resetSupervisionTaskRegistryForTests();
  clearSendIdempotencyCacheForTests();
});

describe('SupervisionTaskRegistry', () => {
  it('scopes task rows and idempotency keys by project', () => {
    const registry = makeRegistry();
    const alpha = registry.createOrGet({ projectName: 'alpha', objective: 'same request', idempotencyKey: 'same-key' });
    const beta = registry.createOrGet({ projectName: 'beta', objective: 'same request', idempotencyKey: 'same-key' });
    expect(alpha.ok && beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) throw new Error('expected scoped tasks');
    expect(alpha.value.taskId).not.toBe(beta.value.taskId);
    expect(registry.list({ projectName: 'alpha' }).map((task) => task.taskId)).toEqual([alpha.value.taskId]);
    expect(registry.list({ projectName: 'beta' }).map((task) => task.taskId)).toEqual([beta.value.taskId]);
    registry.close();
  });

  it('publishes the caller-reported-only file tracking limitation in the machine contract', () => {
    expect(SUPERVISION_TASK_REGISTRY_CONTRACT.fileTracking).toStrictEqual({
      mode: 'caller_reported_only',
      automaticProviderToolHook: false,
      filesystemOrGitScanner: false,
      reconciliationMode: 'caller_supplied_observations_only',
      detectsUnreportedWrites: false,
    });
  });

  it('rejects illegal lifecycle jumps that would bypass audit or finalization gates', () => {
    const registry = makeRegistry();
    expect(registry.createOrGet({ taskId: 'task-transition-task', objective: 'task transitions' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'task-transition-task', status: 'pushed' })).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });

    expect(registry.createOrGet({ taskId: 'task-transition-assignment', objective: 'assignment transitions' }).ok).toBe(true);
    const owner = identity('deck_sub_transition');
    const assignment = registry.createAssignment({
      taskId: 'task-transition-assignment',
      role: 'implementer',
      identity: owner,
      scopeFiles: ['src/transition.ts'],
    });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status }).ok).toBe(true);
    }
    for (const status of ['committed', 'pushed', 'finalized'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status })).toEqual({
        ok: false,
        reason: 'invalid_transition',
      });
    }
    expect(registry.get('task-transition-assignment')?.assignments[0]?.status).toBe('rework');
    registry.close();
  });

  it('keeps one task with multiple disjoint implementer assignments', () => {
    const registry = makeRegistry();
    const task = registry.createOrGet({ taskId: 'task-top', topLevelTaskId: 'top', objective: 'feature', classification: 'integration_task' });
    expect(task.ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-top', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['src/a.ts'], claimMode: 'exclusive' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-top', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['src/b.ts'], claimMode: 'exclusive' }).ok).toBe(true);

    const item = registry.get('task-top');
    expect(item?.assignments.map((assignment) => assignment.identity.sessionName)).toEqual(['deck_sub_a', 'deck_sub_b']);
    expect(item?.fileClaims.map((claim) => `${claim.path}:${claim.claimMode}`)).toEqual(['src/a.ts:exclusive', 'src/b.ts:exclusive']);
    registry.close();
  });

  it('rejects illegal exclusive overlaps but permits explicit shared claims with an integration owner', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'task-shared', topLevelTaskId: 'top', objective: 'shared file', classification: 'integration_task' });
    registry.createAssignment({ taskId: 'task-shared', role: 'integration_owner', identity: identity('deck_brain'), required: true });
    expect(registry.createAssignment({ taskId: 'task-shared', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['shared/x.ts'], claimMode: 'shared' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-shared', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['shared/x.ts'], claimMode: 'shared' }).ok).toBe(true);
    expect(registry.findByFile('shared/x.ts')?.[0]?.fileClaims).toHaveLength(2);

    registry.createOrGet({ taskId: 'task-exclusive', topLevelTaskId: 'top2', objective: 'exclusive', classification: 'integration_slice' });
    expect(registry.createAssignment({ taskId: 'task-exclusive', role: 'implementer', identity: identity('deck_sub_c'), scopeFiles: ['src/y.ts'], claimMode: 'exclusive' }).ok).toBe(true);
    expect(registry.createAssignment({ taskId: 'task-exclusive', role: 'implementer', identity: identity('deck_sub_d'), scopeFiles: ['src/y.ts'], claimMode: 'exclusive' })).toEqual({ ok: false, reason: 'shared_file_conflict' });
    registry.close();
  });

  it('binds file events to assignment runtime, blocks auditor writes, stale runtime and outside-scope drift', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'task-files', objective: 'file hooks' });
    const implementer = identity('deck_sub_impl');
    const auditor = identity('deck_sub_audit', 'claude-code-sdk');
    const impl = registry.createAssignment({ taskId: 'task-files', role: 'implementer', identity: implementer, scopeFiles: ['src/ok.ts'], claimMode: 'exclusive' });
    const audit = registry.createAssignment({ taskId: 'task-files', role: 'auditor', identity: auditor, scopeFiles: ['src/ok.ts'] });
    if (!impl.ok || !audit.ok) throw new Error('assignments should create');

    expect(registry.recordFileEvent({ assignmentId: audit.value.assignmentId, identity: auditor, path: 'src/ok.ts', operation: 'modify' })).toEqual({ ok: false, reason: 'role_forbidden' });
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: { ...implementer, runtimeEpoch: 'old' }, path: 'src/ok.ts', operation: 'modify' })).toEqual({ ok: false, reason: 'owner_mismatch' });
    const first = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    const replay = registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/ok.ts', operation: 'modify', beforeHash: 'a', afterHash: 'b', tool: 'apply_patch', idempotencyKey: 'edit-1' });
    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, replay: true });
    expect(registry.listFileEvents('task-files')).toHaveLength(1);
    expect(registry.recordFileEvent({ assignmentId: impl.value.assignmentId, identity: implementer, path: 'src/out.ts', operation: 'create' })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(registry.get('task-files')?.status).toBe('blocked');
    registry.close();
  });

  it('worker finish only closes its assignment; aggregate waits for required siblings', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'task-aggregate', objective: 'aggregate' });
    const a = registry.createAssignment({ taskId: 'task-aggregate', role: 'implementer', identity: identity('deck_sub_a'), scopeFiles: ['a.ts'] });
    const b = registry.createAssignment({ taskId: 'task-aggregate', role: 'implementer', identity: identity('deck_sub_b'), scopeFiles: ['b.ts'] });
    if (!a.ok || !b.ok) throw new Error('assignments should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: a.value.assignmentId, identity: identity('deck_sub_a'), status }).ok).toBe(true);
    }
    expect(registry.get('task-aggregate')?.status).toBe('delegated');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'rework'] as const) {
      expect(registry.updateAssignment({ assignmentId: b.value.assignmentId, identity: identity('deck_sub_b'), status }).ok).toBe(true);
    }
    expect(registry.get('task-aggregate')?.status).toBe('rework');
    registry.close();
  });

  it('projects committed/pushed lifecycle from events for the OpenSpec 14.3-14.5 sample', () => {
    const registry = makeRegistry();
    registry.createOrGet({
      taskId: 'openspec-14-3-14-5-lifecycle-crash',
      topLevelTaskId: 'openspec-14-3-14-5-lifecycle-crash',
      objective: 'OpenSpec 14.3-14.5 lifecycle/crash',
      classification: 'independent_top_level',
      currentRevision: '0c59b53b581e14ec195e12701416850a25d591b4',
    });
    const owner = identity('deck_sub_581a235r');
    const assignment = registry.createAssignment({ taskId: 'openspec-14-3-14-5-lifecycle-crash', role: 'implementer', identity: owner, scopeFiles: ['server/test/remote-desktop-lifecycle-crash.integration.test.ts'], auditAttemptId: 'rd-lifecycle-crash-audit-20260827-ds1-r2-47f81d', auditRevision: '0c59b53b581e14ec195e12701416850a25d591b4' });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status, auditAttemptId: 'rd-lifecycle-crash-audit-20260827-ds1-r2-47f81d', revision: '0c59b53b581e14ec195e12701416850a25d591b4', verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'finalizing' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'committed', commitSha: '0c59b53b581e14ec195e12701416850a25d591b4' }).ok).toBe(true);
    expect(registry.updateTask({ taskId: 'openspec-14-3-14-5-lifecycle-crash', status: 'pushed', pushRemoteRef: 'refs/heads/dev' }).ok).toBe(true);
    const task = registry.get('openspec-14-3-14-5-lifecycle-crash');
    expect(task?.status).toBe('pushed');
    expect(task?.assignments[0]?.verdict).toBe('PASS');
    expect(task?.commitSha).toBe('0c59b53b581e14ec195e12701416850a25d591b4');
    expect(task?.pushRemoteRef).toBe('refs/heads/dev');
    expect(registry.listEvents('openspec-14-3-14-5-lifecycle-crash').map((event) => event.eventType)).toEqual(expect.arrayContaining(['audit_replied', 'committed', 'pushed']));
    registry.close();
  });

  it('keeps slice PASS separate from parent readiness for macOS auto-unlock isolation', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'cc1-complete-macos-build-graph', topLevelTaskId: 'cc1-complete-macos-build-graph', objective: 'CC1 complete macOS build-graph transaction', classification: 'integration_task' });
    registry.createAssignment({ taskId: 'cc1-complete-macos-build-graph', role: 'integration_owner', identity: identity('deck_cd_brain'), required: true });
    registry.createOrGet({ taskId: 'macos-auto-unlock-default-shipping-isolation', topLevelTaskId: 'cc1-complete-macos-build-graph', objective: 'macOS auto-unlock default-shipping isolation', classification: 'integration_slice' });
    const owner = identity('deck_sub_26624c1t');
    const files = [
      'native/macos-remote-desktop/BUILD.gn',
      'native/macos-remote-desktop/auto_unlock.cc',
      'native/macos-remote-desktop/auto_unlock.h',
      'native/macos-remote-desktop/auto_unlock_test.cc',
      'test/spec/macos-auto-unlock-build.test.ts',
      'test/spec/macos-remote-desktop-build.test.ts',
      'scripts/build-worker.ps1',
    ];
    const assignment = registry.createAssignment({ taskId: 'macos-auto-unlock-default-shipping-isolation', role: 'implementer', identity: owner, scopeFiles: files, auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf' });
    if (!assignment.ok) throw new Error('assignment should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: assignment.value.assignmentId, identity: owner, status, auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf', verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    const slice = registry.get('macos-auto-unlock-default-shipping-isolation');
    const parent = registry.get('cc1-complete-macos-build-graph');
    expect(slice?.status).toBe('ready_for_integration');
    expect(slice?.assignments[0]).toMatchObject({ status: 'ready_for_integration', auditAttemptId: 'macos-auto-unlock-isolation-audit-20260827-cx6-r3-1947bf', verdict: 'PASS' });
    expect(slice?.fileClaims).toHaveLength(7);
    expect(parent?.status).toBe('delegated');
    expect(parent?.assignments[0]?.role).toBe('integration_owner');
    registry.close();
  });

  it('projects assignment REWORK then matching PASS without downgrading sibling PASS assignments', () => {
    const registry = makeRegistry();
    registry.createOrGet({ taskId: 'supervision-provider-integration', topLevelTaskId: 'supervision-provider-integration', objective: 'provider/supervision integration', classification: 'integration_task' });
    const providerLimited = registry.createAssignment({ taskId: 'supervision-provider-integration', role: 'implementer', identity: identity('deck_sub_provider'), scopeFiles: ['src/daemon/provider-limit.ts'] });
    const codex = registry.createAssignment({ taskId: 'supervision-provider-integration', role: 'implementer', identity: identity('deck_sub_4s48141x'), scopeFiles: ['src/agent/codex-runtime-config.ts'], auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb' });
    if (!providerLimited.ok || !codex.ok) throw new Error('assignments should create');
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({ assignmentId: providerLimited.value.assignmentId, identity: identity('deck_sub_provider'), status, verdict: status === 'passed' ? 'PASS' : undefined }).ok).toBe(true);
    }
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing'] as const) {
      expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status, auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb' }).ok).toBe(true);
    }
    expect(registry.updateAssignment({
      assignmentId: codex.value.assignmentId,
      identity: identity('deck_sub_4s48141x'),
      status: 'rework',
      auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r2-350feb',
      blocker: 'raw resetsAt unit unknown but forwarded to canonical epoch-seconds field, causing garbage quota label; owner repair request sent',
      verdict: 'REWORK',
    }).ok).toBe(true);
    let task = registry.get('supervision-provider-integration');
    expect(task?.status).toBe('rework');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === providerLimited.value.assignmentId)?.status).toBe('ready_for_integration');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)).toMatchObject({ status: 'rework', verdict: 'REWORK', blocker: expect.stringContaining('resetsAt unit unknown') });

    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'auditing', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'passed', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77', verdict: 'PASS' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: codex.value.assignmentId, identity: identity('deck_sub_4s48141x'), status: 'ready_for_integration', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' }).ok).toBe(true);
    task = registry.get('supervision-provider-integration');
    expect(task?.status).toBe('ready_for_integration');
    expect(task?.assignments.find((assignment) => assignment.assignmentId === providerLimited.value.assignmentId)).toMatchObject({ status: 'ready_for_integration', verdict: 'PASS' });
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)).toMatchObject({ status: 'ready_for_integration', verdict: 'PASS', auditAttemptId: 'codex-limit-producer-audit-20260827-cc2-r3-9f6a77' });
    expect(task?.assignments.find((assignment) => assignment.assignmentId === codex.value.assignmentId)?.blocker).toBeUndefined();
    registry.close();
  });

  it('reconciles hooks against declared scope, duplicate deliveries, rename/delete and restart recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-task-registry-'));
    const dbPath = join(dir, 'tasks.sqlite');
    try {
      const registry = new SupervisionTaskRegistry({ dbPath });
      registry.createOrGet({ taskId: 'task-restart', objective: 'restartable hooks', idempotencyKey: 'task-restart' });
      const owner = identity('deck_sub_restart');
      const assignment = registry.createAssignment({ taskId: 'task-restart', role: 'implementer', identity: owner, scopeFiles: ['src/old.ts', 'src/new.ts'], idempotencyKey: 'assignment', executionBinding: persistedExecutionBinding('deck_sub_restart') });
      if (!assignment.ok) throw new Error('assignment should create');
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/old.ts', operation: 'rename', beforeHash: 'old', afterHash: 'new', idempotencyKey: 'rename-1' }).ok).toBe(true);
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/old.ts', operation: 'rename', beforeHash: 'old', afterHash: 'new', idempotencyKey: 'rename-1' })).toMatchObject({ ok: true, replay: true });
      expect(registry.recordFileEvent({ assignmentId: assignment.value.assignmentId, identity: owner, path: 'src/new.ts', operation: 'delete', beforeHash: 'new', idempotencyKey: 'delete-1' }).ok).toBe(true);
      expect(registry.reconcileScope({ taskId: 'task-restart', trackedPaths: ['src/old.ts', 'src/new.ts'], currentRevision: 'rev1' }).ok).toBe(true);
      expect(registry.reconcileScope({ taskId: 'task-restart', trackedPaths: ['src/old.ts', 'src/new.ts', 'src/untracked.ts'] })).toEqual({ ok: false, reason: 'manifest_mismatch' });
      registry.close();
      const reopened = new SupervisionTaskRegistry({ dbPath });
      expect(reopened.get('task-restart')?.touchedFiles).toEqual(['src/new.ts', 'src/old.ts']);
      expect(reopened.get('task-restart')?.currentRevision).toBe('rev1');
      expect(reopened.get('task-restart')?.assignments[0]?.executionBinding).toStrictEqual(persistedExecutionBinding('deck_sub_restart'));
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps one session with two queued assignments attributable only by assignmentId', () => {
    const registry = makeRegistry();
    const same = identity('deck_sub_same');
    registry.createOrGet({ taskId: 'task-one', objective: 'first' });
    registry.createOrGet({ taskId: 'task-two', objective: 'second' });
    const one = registry.createAssignment({ taskId: 'task-one', role: 'implementer', identity: same, scopeFiles: ['src/one.ts'], idempotencyKey: 'one' });
    const two = registry.createAssignment({ taskId: 'task-two', role: 'implementer', identity: same, scopeFiles: ['src/two.ts'], idempotencyKey: 'two' });
    if (!one.ok || !two.ok) throw new Error('assignments should create');
    expect(registry.recordFileEvent({ assignmentId: one.value.assignmentId, identity: same, path: 'src/two.ts', operation: 'modify' })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(registry.recordFileEvent({ assignmentId: two.value.assignmentId, identity: same, path: 'src/two.ts', operation: 'modify' }).ok).toBe(true);
    expect(registry.get('task-one')?.status).toBe('blocked');
    expect(registry.get('task-two')?.touchedFiles).toEqual(['src/two.ts']);
    registry.close();
  });

  it('projects external CI recovery run/task ids from assignment events', () => {
    const registry = makeRegistry();
    registry.createOrGet({
      taskId: 'ci-android-release-recovery-33034747853',
      topLevelTaskId: 'ci-android-release-recovery-33034747853',
      objective: 'Android Release Build/Create GitHub Release recovery',
      classification: 'independent_top_level',
      currentRevision: '0c59b53b581e14ec195e12701416850a25d591b4',
    });
    registry.createAssignment({ taskId: 'ci-android-release-recovery-33034747853', role: 'coordinator', identity: identity('deck_cd_brain'), required: false });
    const target = identity('deck_sub_0h4a1o3i');
    const assignment = registry.createAssignment({
      taskId: 'ci-android-release-recovery-33034747853',
      assignmentId: 'ci-release-recovery-pi1-v1',
      role: 'implementer',
      identity: target,
      scopeFiles: ['.github/workflows/android-release.yml'],
      required: true,
    });
    if (!assignment.ok) throw new Error('assignment should create');
    expect(registry.updateAssignment({
      assignmentId: 'ci-release-recovery-pi1-v1',
      identity: target,
      status: 'retrying_external_ci',
      externalRunId: '33034747853',
      externalHeadSha: '0c59b53b581e14ec195e12701416850a25d591b4',
      externalTaskId: 'ci-android-release-recovery-33034747853',
      blocker: 'Android Release Build/Create GitHub Release transient Unicorn; all tests/build/typecheck/lint passed; 3/4 assets uploaded, global APK missing.',
    }).ok).toBe(true);
    let task = registry.get('ci-android-release-recovery-33034747853');
    expect(task?.status).toBe('retrying_external_ci');
    expect(task?.assignments.find((item) => item.assignmentId === 'ci-release-recovery-pi1-v1')).toMatchObject({
      status: 'retrying_external_ci',
      externalRunId: '33034747853',
      externalHeadSha: '0c59b53b581e14ec195e12701416850a25d591b4',
      externalTaskId: 'ci-android-release-recovery-33034747853',
      blocker: expect.stringContaining('transient Unicorn'),
    });
    expect(registry.updateAssignment({ assignmentId: 'ci-release-recovery-pi1-v1', identity: target, status: 'recovered' }).ok).toBe(true);
    expect(registry.updateAssignment({ assignmentId: 'ci-release-recovery-pi1-v1', identity: target, status: 'finalized' }).ok).toBe(true);
    task = registry.get('ci-android-release-recovery-33034747853');
    expect(task?.status).toBe('finalized');
    expect(task?.assignments.find((item) => item.assignmentId === 'ci-release-recovery-pi1-v1')).toMatchObject({ status: 'finalized', externalRunId: '33034747853' });
    expect(registry.listEvents('ci-android-release-recovery-33034747853').map((event) => event.eventType)).toEqual(expect.arrayContaining(['retrying_external_ci', 'recovered', 'finalized']));
    registry.close();
  });

  it('send_message task metadata creates one assignment and idempotency replay reuses it', async () => {
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const result = await dispatchSendMessage({ userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' }, {
      target: 'deck_alpha_w1', message: 'do task', idempotencyKey: 'same', task: { topLevelTaskId: 'top', objective: 'task via send', ownedFiles: ['src/a.ts'] },
    }, { listSessions: () => sessions, dispatchMessage: async () => undefined, exactTargetOnly: true });
    const replay = await dispatchSendMessage({ userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' }, {
      target: 'deck_alpha_w1', message: 'do task', idempotencyKey: 'same', task: { topLevelTaskId: 'top', objective: 'task via send', ownedFiles: ['src/a.ts'] },
    }, { listSessions: () => sessions, dispatchMessage: async () => undefined, exactTargetOnly: true });
    if (result.status !== 'accepted' || replay.status !== 'accepted') throw new Error('expected accepted');
    expect(result.taskId).toBeTruthy();
    expect(result.assignmentId).toBeTruthy();
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.taskId).toBe(result.taskId);
    expect(replay.assignmentId).toBe(result.assignmentId);
    expect(getSupervisionTaskRegistry().get(result.taskId!)?.assignments[0]?.executionBinding).toMatchObject({
      pool: 'primary',
      requested: { providerFamily: 'openai', model: 'gpt-5.6' },
      actual: { sessionName: 'deck_alpha_w1', sessionInstanceId: 'instance-deck_alpha_w1', runtimeEpoch: 'epoch-deck_alpha_w1', model: 'gpt-5.6' },
      origin: 'reused',
    });
  });

  it('keeps one canonical provider identity across send_message and delegate task-report tools', async () => {
    const selected = {
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      runtimeType: 'transport' as const,
      model: 'opus[1M]',
    };
    const brain = session('deck_alpha_brain');
    brain.transportConfig = {
      supervision: {
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{
              ...selected,
              capabilityId: buildSupervisionExecutionCapabilityId(selected),
            }],
          },
          economyTaskPool: { configs: [] },
        },
      },
    } as SessionRecord['transportConfig'];
    const worker = session('deck_alpha_w1', 'alpha', 'claude-code-sdk');
    worker.requestedModel = 'claude-opus-5';
    worker.activeModel = 'claude-opus-5';
    const sessions = [brain, worker];

    const sent = await dispatchSendMessage(
      { userId: 'u', sessionName: brain.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      {
        target: worker.name,
        message: 'implement the cross-entrypoint task',
        idempotencyKey: 'cross-entrypoint-provider-family',
        task: { objective: 'canonical provider family', ownedFiles: ['src/cross-entrypoint.ts'] },
      },
      { listSessions: () => sessions, dispatchMessage: async () => undefined, exactTargetOnly: true },
    );
    expect(sent).toMatchObject({ status: 'accepted', taskId: expect.any(String), assignmentId: expect.any(String) });
    if (sent.status !== 'accepted' || !sent.assignmentId || !sent.taskId) throw new Error('expected task assignment');

    const registry = getSupervisionTaskRegistry();
    const assignment = registry.getAssignment(sent.assignmentId);
    expect(assignment?.identity).toMatchObject({
      sessionName: worker.name,
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
    });
    if (!assignment) throw new Error('assignment missing');

    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: worker.name, projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => sessions } },
    );
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]({
      assignmentId: assignment.assignmentId,
      revision: 'revision-1',
    })).toMatchObject({ status: 'ok' });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({
      assignmentId: assignment.assignmentId,
      filePath: 'src/cross-entrypoint.ts',
      operation: 'modify',
      beforeHash: 'before',
      afterHash: 'after',
    })).toMatchObject({ status: 'ok' });

    for (const status of [
      'implementing', 'validated', 'ready_for_audit', 'auditing', 'passed',
      'ready_for_integration', 'integrating', 'final_audit', 'passed',
      'finalizing', 'committed', 'pushed',
    ] as const) {
      expect(registry.updateAssignment({
        assignmentId: assignment.assignmentId,
        identity: assignment.identity,
        status,
      }).ok, status).toBe(true);
    }
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({
      assignmentId: assignment.assignmentId,
      revision: 'revision-2',
      evidence: 'delegate completed',
    })).toMatchObject({ status: 'ok', item: { status: 'finalized' } });
  });

  it('send_message binds a visible existing task and idempotency replay keeps the same assignment', async () => {
    const registry = getSupervisionTaskRegistry();
    const task = registry.createOrGet({ projectName: 'alpha', taskId: 'existing-visible-task', objective: 'existing task' });
    expect(task).toMatchObject({ ok: true, value: { taskId: 'existing-visible-task' } });
    expect(registry.createAssignment({
      taskId: 'existing-visible-task',
      role: 'coordinator',
      identity: identity('deck_alpha_brain'),
      scopeFiles: [],
    }).ok).toBe(true);

    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const dispatchMessage = vi.fn(async () => undefined);
    const request = {
      target: 'deck_alpha_w1',
      message: 'continue the existing task',
      idempotencyKey: 'bind-existing-once',
      task: { taskId: 'existing-visible-task', objective: 'must not mint a replacement' },
    } as const;
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true };

    const first = await dispatchSendMessage(
      { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' },
      request,
      deps,
    );
    const replay = await dispatchSendMessage(
      { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' },
      request,
      deps,
    );

    expect(first).toMatchObject({ status: 'accepted', taskId: 'existing-visible-task' });
    if (first.status !== 'accepted' || replay.status !== 'accepted') throw new Error('expected accepted');
    expect(first.taskId).toBe('existing-visible-task');
    expect(replay).toMatchObject({
      idempotentReplay: true,
      taskId: 'existing-visible-task',
      assignmentId: first.assignmentId,
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('existing-visible-task')?.assignments.map((item) => item.identity.sessionName).sort())
      .toEqual(['deck_alpha_brain', 'deck_alpha_w1']);
  });

  it('send_message rejects missing and inaccessible explicit task ids without minting or dispatching', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'other-owner-task', objective: 'private task' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'other-owner-task',
      role: 'coordinator',
      identity: identity('deck_alpha_other'),
      scopeFiles: [],
    }).ok).toBe(true);
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const dispatchMessage = vi.fn(async () => undefined);
    const deps = { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true };
    const runtimeCaller = { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' };

    const inaccessible = await dispatchSendMessage(runtimeCaller, {
      target: 'deck_alpha_w1', message: 'must not dispatch',
      task: { taskId: 'other-owner-task', objective: 'must not replace' },
    }, deps);
    const missing = await dispatchSendMessage(runtimeCaller, {
      target: 'deck_alpha_w1', message: 'must not dispatch',
      task: { taskId: 'missing-task', objective: 'must not create' },
    }, deps);

    expect(inaccessible).toEqual({
      status: 'error', reason: 'identity_rejected', error: 'task is not visible to this caller',
    });
    expect(missing).toEqual(inaccessible);
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('missing-task')).toBeUndefined();
  });

  it('MCP task_list/task_get use registry projection and reject unrelated session enumeration', async () => {
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1'), session('deck_alpha_w2')];
    const handlers = createMemoryMcpToolHandlers({ userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' }, { sendDeps: { listSessions: () => sessions } });
    const start = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({ role: 'implementer', objective: 'visible', scopeFiles: ['src/a.ts'], idempotencyKey: 'visible' });
    expect(start.status).toBe('ok');
    // list/get are now owned by the audited supervision handlers; the legacy
    // duplicates were removed in the consolidation merge.
    const own = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w1' } as never, { registry: supervisionRegistryPort() },
    );
    const list: any = await own[SUPERVISION_MCP_TOOLS.LIST]({});
    expect(list.status).toBe('ok');
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]?.taskId).toBe((start as { taskId: string }).taskId);
    const get: any = await own[SUPERVISION_MCP_TOOLS.GET]({ taskId: (start as { taskId: string }).taskId });
    expect(get.status).toBe('ok');

    const other = createSupervisionMcpToolHandlers(
      { sessionName: 'deck_alpha_w2' } as never, { registry: supervisionRegistryPort() },
    );
    const invisible = await other[SUPERVISION_MCP_TOOLS.GET]({ taskId: (start as { taskId: string }).taskId });
    expect(invisible).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('supervision_task_start treats taskId as a visible reference and replays one assignment', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'existing-start-task', objective: 'existing' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'existing-start-task', role: 'coordinator', identity: identity('deck_alpha_w1'), scopeFiles: [],
    }).ok).toBe(true);
    const sessions = [session('deck_alpha_brain'), session('deck_alpha_w1')];
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => sessions } },
    );
    const request = {
      taskId: 'existing-start-task', role: 'implementer', objective: 'join existing',
      scopeFiles: ['src/join.ts'], idempotencyKey: 'join-existing-once',
    } as const;
    const first = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START](request);
    const replay = await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START](request);
    expect(first).toMatchObject({ status: 'ok', taskId: 'existing-start-task' });
    expect(replay).toMatchObject({
      status: 'ok', taskId: 'existing-start-task',
      assignmentId: first.assignmentId, idempotentReplay: true,
    });
    expect(registry.list({ projectName: 'alpha' })).toHaveLength(1);
    expect(registry.get('existing-start-task')?.assignments).toHaveLength(2);
  });

  it('supervision_task_start makes missing, foreign-project and inaccessible task ids indistinguishable', async () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({ projectName: 'alpha', taskId: 'private-start-task', objective: 'private' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'private-start-task', role: 'coordinator', identity: identity('deck_alpha_other'), scopeFiles: [],
    }).ok).toBe(true);
    expect(registry.createOrGet({ projectName: 'beta', taskId: 'foreign-start-task', objective: 'foreign' }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'foreign-start-task', role: 'coordinator', identity: identity('deck_alpha_w1'), scopeFiles: [],
    }).ok).toBe(true);
    const handlers = createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: 'deck_alpha_w1', projectName: 'alpha', projectRoot: '/work/alpha' },
      { sendDeps: { listSessions: () => [session('deck_alpha_brain'), session('deck_alpha_w1')] } },
    );
    const results = await Promise.all(['missing-start-task', 'private-start-task', 'foreign-start-task'].map((taskId) => (
      handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
        taskId, role: 'implementer', objective: 'must not reveal', idempotencyKey: `probe-${taskId}`,
      })
    )));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual({
      status: 'error', reason: 'identity_rejected', message: 'task is not visible to this caller', recoverable: false,
    });
    expect(registry.get('missing-start-task')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });
});
