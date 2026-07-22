import { describe, expect, it } from 'vitest';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  resolvePeerAuditCandidate,
  resolvePeerAuditCandidateList,
  revalidatePeerAuditCandidateSelection,
} from '../../src/daemon/peer-audit-candidates.js';

function session(name: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  const isMain = name.endsWith('_brain');
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `runtime-${name}`,
    projectName: 'proj',
    projectDir: '/repo',
    role: isMain ? 'brain' : 'w1',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: 'openai',
    activeModel: isMain ? 'gpt-5' : 'claude-sonnet',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function candidate(
  auditedSessionName: string,
  targetSessionName: string,
  allSessions: SessionRecord[],
) {
  const result = resolvePeerAuditCandidate({ auditedSessionName, targetSessionName, allSessions });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.candidate;
}

describe('peer-audit candidate authority', () => {
  it('accepts main-to-direct-child and sub-to-sibling relationships', () => {
    const main = session('deck_proj_brain');
    const child = session('deck_sub_child', { parentSession: main.name });
    const sibling = session('deck_sub_sibling', { parentSession: main.name });
    const all = [main, child, sibling];

    expect(candidate(main.name, child.name, all)).toMatchObject({
      eligible: true,
      reason: 'eligible',
      dispositionCapability: 'sent',
    });
    expect(candidate(child.name, sibling.name, all)).toMatchObject({ eligible: true, reason: 'eligible' });
  });

  it.each([
    ['self', (main: SessionRecord, child: SessionRecord) => [child.name, child.name, [main, child]], 'self'],
    ['main target', (main: SessionRecord, child: SessionRecord) => [child.name, main.name, [main, child]], 'not_direct_child'],
    ['nested child', (main: SessionRecord, child: SessionRecord) => {
      const nested = session('deck_sub_nested', { parentSession: child.name });
      return [main.name, nested.name, [main, child, nested]];
    }, 'not_direct_child'],
    ['orphan', (main: SessionRecord, child: SessionRecord) => {
      const orphan = session('deck_sub_orphan', { parentSession: undefined });
      return [main.name, orphan.name, [main, child, orphan]];
    }, 'not_direct_child'],
    ['cross project', (main: SessionRecord, child: SessionRecord) => {
      const cross = session('deck_sub_cross', { parentSession: undefined, projectName: 'other' });
      return [main.name, cross.name, [main, child, cross]];
    }, 'cross_project'],
    ['execution clone', (main: SessionRecord, child: SessionRecord) => {
      const clone = session('deck_sub_clone', {
        parentSession: main.name,
        executionCloneMetadata: { kind: EXECUTION_CLONE_KIND } as SessionRecord['executionCloneMetadata'],
      });
      return [main.name, clone.name, [main, child, clone]];
    }, 'execution_clone'],
    ['stopped', (main: SessionRecord, child: SessionRecord) => {
      const stopped = session('deck_sub_stopped', { parentSession: main.name, state: 'stopped' });
      return [main.name, stopped.name, [main, child, stopped]];
    }, 'busy_state'],
    ['error', (main: SessionRecord, child: SessionRecord) => {
      const errored = session('deck_sub_error', { parentSession: main.name, state: 'error' });
      return [main.name, errored.name, [main, child, errored]];
    }, 'busy_state'],
    ['not reply capable', (main: SessionRecord, child: SessionRecord) => {
      const shell = session('deck_sub_shell', { parentSession: main.name, agentType: 'shell', runtimeType: 'process' });
      return [main.name, shell.name, [main, child, shell]];
    }, 'not_reply_capable'],
    ['unknown identity', (main: SessionRecord, child: SessionRecord) => {
      const legacy = session('deck_sub_legacy', { parentSession: main.name, sessionInstanceId: undefined });
      return [main.name, legacy.name, [main, child, legacy]];
    }, 'unknown_identity'],
  ] as const)('rejects %s with one stable reason', (_label, build, expectedReason) => {
    const main = session('deck_proj_brain');
    const child = session('deck_sub_child', { parentSession: main.name });
    const [auditedName, targetName, all] = build(main, child);
    expect(candidate(auditedName as string, targetName as string, all as SessionRecord[])).toMatchObject({
      eligible: false,
      reason: expectedReason,
    });
  });

  it('queues busy transports but rejects busy processes as uncancellable', () => {
    const main = session('deck_proj_brain');
    const busyTransport = session('deck_sub_transport', {
      parentSession: main.name,
      state: 'running',
    });
    const busyProcess = session('deck_sub_process', {
      parentSession: main.name,
      agentType: 'codex',
      runtimeType: 'process',
      state: 'running',
    });
    const idleProcess = session('deck_sub_idle_process', {
      parentSession: main.name,
      agentType: 'codex',
      runtimeType: 'process',
      state: 'idle',
    });
    const all = [main, busyTransport, busyProcess, idleProcess];

    expect(candidate(main.name, busyTransport.name, all)).toMatchObject({
      eligible: true,
      dispositionCapability: 'queued',
    });
    expect(candidate(main.name, busyProcess.name, all)).toMatchObject({
      eligible: false,
      reason: 'busy_state',
      dispositionCapability: 'sent_unrevocable',
    });
    expect(candidate(main.name, idleProcess.name, all)).toMatchObject({
      eligible: true,
      dispositionCapability: 'sent_unrevocable',
    });
  });

  it('lists only ordinary direct siblings/children and recommends cross-provider peers first', () => {
    const main = session('deck_proj_brain', { providerId: 'openai' });
    const audited = session('deck_sub_audited', { parentSession: main.name, providerId: 'openai' });
    const sameProvider = session('deck_sub_same', { parentSession: main.name, providerId: 'openai', label: 'A' });
    const crossProvider = session('deck_sub_cross', { parentSession: main.name, providerId: 'anthropic', label: 'Z' });
    const legacyProjectName = session('deck_sub_legacy-project', {
      parentSession: main.name,
      projectName: 'deck_sub_legacy-project',
      providerId: 'anthropic',
      label: 'Legacy',
    });
    const nested = session('deck_sub_nested', { parentSession: audited.name });
    const clone = session('deck_sub_clone', {
      parentSession: main.name,
      executionCloneMetadata: { kind: EXECUTION_CLONE_KIND } as SessionRecord['executionCloneMetadata'],
    });

    const result = resolvePeerAuditCandidateList({
      auditedSessionName: audited.name,
      allSessions: [main, audited, sameProvider, crossProvider, legacyProjectName, nested, clone],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.candidates.map((item) => item.name)).toEqual([
      legacyProjectName.name,
      crossProvider.name,
      sameProvider.name,
    ]);
  });

  it('never exposes an internal deck id as the candidate display label', () => {
    const main = session('deck_proj_brain');
    const target = session('deck_sub_unlabelled', { parentSession: main.name, label: undefined, agentType: 'claude-code-sdk' });
    const result = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: [main, target] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.candidates[0]).toMatchObject({ name: target.name, label: 'CC' });
    expect(result.list.candidates[0]?.label).not.toContain('deck_');
  });

  it('changes revision for every identity/state/model/provider/group/capability authority input', () => {
    const main = session('deck_proj_brain');
    const target = session('deck_sub_target', { parentSession: main.name });
    const base = [main, target];
    const revision = (sessions: SessionRecord[]) => {
      const result = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: sessions });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      return result.list.revision;
    };
    const original = revision(base);
    const mutations: Array<Partial<SessionRecord>> = [
      { sessionInstanceId: 'instance-recreated' },
      { runtimeEpoch: 'runtime-replaced' },
      { state: 'running' },
      { activeModel: 'different-model' },
      { providerId: 'anthropic' },
      { parentSession: 'deck_other_brain' },
      { runtimeType: 'process', agentType: 'codex' },
    ];
    for (const patch of mutations) {
      expect(revision([main, { ...target, ...patch }])).not.toBe(original);
    }
  });

  it('rejects stale Quick selection revisions and same-name recreation before dispatch', () => {
    const main = session('deck_proj_brain');
    const target = session('deck_sub_target', { parentSession: main.name });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: [main, target] });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const recreated = { ...target, sessionInstanceId: 'recreated-instance', runtimeEpoch: 'recreated-runtime' };
    const stale = revalidatePeerAuditCandidateSelection({
      auditedSessionName: main.name,
      targetSessionName: recreated.name,
      targetSessionInstanceId: target.sessionInstanceId!,
      targetRuntimeEpoch: target.runtimeEpoch!,
      expectedRevision: listed.list.revision,
      allSessions: [main, recreated],
    });
    expect(stale).toMatchObject({ ok: false, error: 'candidate_refresh_required' });
  });
});
