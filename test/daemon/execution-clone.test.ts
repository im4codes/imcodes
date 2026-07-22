import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_TIMELINE,
  DEFAULT_CLONE_RETENTION_MS,
  MAX_CLONE_RETENTION_MS,
  defaultDedicatedExecutionRoutingPreference,
  type ExecutionCloneMetadata,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// The store is driven by a mutable in-memory map so getSession/listSessions/
// upsertSession behave like the real store within a test. subsession-manager
// and timeline-emitter are mocked so createExecutionClone / destroyExecutionClone
// exercise the real control flow without touching tmux or the live emitter.

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, SessionRecord>();
  return {
    sessions,
    getSession: vi.fn((name: string) => sessions.get(name)),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    upsertSession: vi.fn((record: SessionRecord) => {
      sessions.set(record.name, { ...record, updatedAt: Date.now() });
    }),
    removeSession: vi.fn((name: string) => {
      sessions.delete(name);
    }),
    startSubSession: vi.fn(async (_sub: { id: string; fresh?: boolean }) => {}),
    stopSubSession: vi.fn(async (_target: string) => ({ ok: true, closed: [], failed: [] })),
    emit: vi.fn((..._args: unknown[]) => {}),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  getSession: mocks.getSession,
  listSessions: mocks.listSessions,
  upsertSession: mocks.upsertSession,
  removeSession: mocks.removeSession,
}));

vi.mock('../../src/daemon/subsession-manager.js', async () => {
  // Side-effecting launch/stop entry points are stubbed. normalizeShellBinForHost
  // is reimplemented faithfully (a pure function over process.platform + fs) so
  // buildExecutionCloneSpec's shellBin copy/drop is exercised for real WITHOUT
  // importing the heavy real subsession-manager module (which pulls in tmux,
  // session-manager, etc.). The async factory can await node:fs safely.
  const { existsSync } = await import('node:fs');
  const normalizeShellBinForHost = (shellBin?: string | null): string | undefined => {
    if (!shellBin) return undefined;
    if (process.platform === 'win32') {
      if (!/[\\/]/.test(shellBin)) return shellBin;
      return existsSync(shellBin) ? shellBin : undefined;
    }
    if (/^[a-zA-Z]:[\\/]/.test(shellBin)) return undefined;
    if (shellBin.includes('\\')) return undefined;
    if (/\.exe$/i.test(shellBin)) return undefined;
    if (shellBin.includes('/')) return existsSync(shellBin) ? shellBin : undefined;
    return shellBin;
  };
  return {
    subSessionName: (id: string) => `deck_sub_${id}`,
    startSubSession: mocks.startSubSession,
    stopSubSession: mocks.stopSubSession,
    normalizeShellBinForHost,
  };
});

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.emit, on: vi.fn(() => () => {}) },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isExecutionClone,
  countActiveExecutionClones,
  validateExecutionTemplateCandidate,
  validateExecutionCloneRequest,
  buildExecutionCloneSpec,
  buildExecutionCloneMetadata,
  buildScrubbedSyncOverrides,
  createExecutionClone,
  destroyExecutionClone,
  completeExecutionCloneOnRuntimeExit,
  resolveExecutionCloneRetentionMs,
  sweepExecutionClones,
  ExecutionCloneError,
  EXECUTION_CLONE_COPY_ALLOWLIST,
  EXECUTION_CLONE_IDENTITY_DENYLIST,
  type ExecutionCloneRequest,
} from '../../src/daemon/execution-clone.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_w1',
    projectName: 'proj',
    role: 'w1',
    agentType: 'claude-code',
    projectDir: '/work/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** A template record carrying EVERY denylist identity field + config. */
function templateWithAllIdentity(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return baseRecord({
    name: 'deck_proj_w2',
    agentType: 'codex',
    runtimeType: 'transport',
    providerId: 'qwen',
    requestedModel: 'model-req',
    activeModel: 'model-active',
    qwenModel: 'qwen-max',
    effort: 'high',
    ccPreset: 'MiniMax',
    presetContextWindow: 200000,
    // identity — must NOT survive
    providerSessionId: 'psid-XYZ',
    providerResumeId: 'prid-XYZ',
    ccSessionId: 'cc-uuid',
    codexSessionId: 'codex-uuid',
    geminiSessionId: 'gemini-uuid',
    opencodeSessionId: 'oc-id',
    paneId: '%42',
    state: 'running',
    restarts: 5,
    restartTimestamps: [1, 2, 3],
    startupMemoryInjected: true,
    recentInjectionHistory: [['a'], ['b']],
    summarySyncFingerprints: ['summary-a'],
    qwenFreshOnResume: true,
    label: 'OC:main',
    quotaLabel: '1000/day',
    quotaUsageLabel: 'today 12/1000',
    // nested transport identity — must be scrubbed
    transportConfig: {
      supervision: 'on',
      sessionId: 'nested-sid',
      threadId: 'nested-thread',
      nested: { conversationId: 'deep-conv', keep: 'yes' },
    },
    ...overrides,
  });
}

function cloneMeta(overrides: Partial<ExecutionCloneMetadata> = {}): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_proj_w2',
    parentRunId: 'run-1',
    parentStage: 'generic_execution',
    createdBySessionName: 'deck_proj_brain',
    createdAt: 1000,
    hardTimeoutAt: 1000 + 60 * 60 * 1000,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
    ...overrides,
  };
}

function req(overrides: Partial<ExecutionCloneRequest> = {}): ExecutionCloneRequest {
  return {
    templateSessionName: 'deck_proj_w2',
    parentRunId: 'run-1',
    parentStage: 'generic_execution',
    ownerSessionName: 'deck_proj_brain',
    owningMainSessionName: 'deck_proj_brain',
    pref: defaultDedicatedExecutionRoutingPreference(),
    ...overrides,
  };
}

/**
 * Seed the owning-main/owner record (`deck_proj_brain`) into the store so
 * `validateExecutionCloneRequest` (owner+owningMain existence + role-compatible
 * main + same-project) passes for the happy-path create tests.
 */
function seedOwningMain(): void {
  mocks.sessions.set('deck_proj_brain', baseRecord({
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    state: 'running',
  }));
}

beforeEach(() => {
  mocks.sessions.clear();
  vi.clearAllMocks();
});

// ── Detection + counting ──────────────────────────────────────────────────────

describe('isExecutionClone', () => {
  it('is true only for records with execution_clone metadata kind', () => {
    expect(isExecutionClone(undefined)).toBe(false);
    expect(isExecutionClone(baseRecord())).toBe(false);
    expect(isExecutionClone(baseRecord({ executionCloneMetadata: cloneMeta() }))).toBe(true);
  });
});

describe('countActiveExecutionClones', () => {
  it('counts only active clones for the given parentRunId', () => {
    // Only the `active` clone is RUNNING and occupies a cap slot. A `collecting`
    // clone's worker has already exited (completed, awaiting retention reap) and
    // `destroying`/`destroyed` clones are gone — all three are cap-neutral.
    mocks.sessions.set('deck_sub_a', baseRecord({ name: 'deck_sub_a', executionCloneMetadata: cloneMeta({ cleanupState: 'active' }) }));
    mocks.sessions.set('deck_sub_b', baseRecord({ name: 'deck_sub_b', executionCloneMetadata: cloneMeta({ cleanupState: 'collecting' }) }));
    mocks.sessions.set('deck_sub_c', baseRecord({ name: 'deck_sub_c', executionCloneMetadata: cloneMeta({ cleanupState: 'destroying' }) }));
    mocks.sessions.set('deck_sub_d', baseRecord({ name: 'deck_sub_d', executionCloneMetadata: cloneMeta({ cleanupState: 'destroyed' }) }));
    // different parent run — excluded
    mocks.sessions.set('deck_sub_e', baseRecord({ name: 'deck_sub_e', executionCloneMetadata: cloneMeta({ parentRunId: 'run-OTHER' }) }));
    // non-clone — excluded
    mocks.sessions.set('deck_proj_w1', baseRecord());

    // run-1 has only ONE `active` clone (deck_sub_a); b/c/d are cap-neutral.
    expect(countActiveExecutionClones('run-1')).toBe(1);
    expect(countActiveExecutionClones('run-OTHER')).toBe(1);
    expect(countActiveExecutionClones('run-none')).toBe(0);
  });
});

// ── validateExecutionTemplateCandidate (shared base predicate) ─────────────────

describe('validateExecutionTemplateCandidate', () => {
  it('accepts an eligible idle worker template', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2' }))).toEqual({ ok: true });
  });

  it('accepts a running worker template', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', state: 'running' }))).toEqual({ ok: true });
  });

  it('rejects a missing record with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(undefined)).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects a stopped template with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', state: 'stopped' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an error-state template with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', state: 'error' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects a blank projectDir with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', projectDir: '' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', projectDir: '   ' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an unknown/unsupported agentType with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2', agentType: 'totally-not-an-agent' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects a clone-of-clone with clone_of_clone_forbidden', () => {
    const t = baseRecord({ name: 'deck_sub_x', executionCloneMetadata: cloneMeta() });
    expect(validateExecutionTemplateCandidate(t)).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN,
    });
  });

  it('rejects a main/brain template with template_ineligible', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_brain', role: 'brain' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('does NOT apply the self-clone exclusion when no caller is given', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2' }))).toEqual({ ok: true });
  });

  it('applies the self-clone exclusion when caller === record name', () => {
    expect(validateExecutionTemplateCandidate(baseRecord({ name: 'deck_proj_w2' }), { callerSessionName: 'deck_proj_w2' })).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });
});

// ── validateExecutionCloneRequest (resolve + validate owner/main/project) ──────

describe('validateExecutionCloneRequest', () => {
  function seedBrain(over: Partial<SessionRecord> = {}): void {
    mocks.sessions.set('deck_proj_brain', baseRecord({
      name: 'deck_proj_brain', projectName: 'proj', role: 'brain', state: 'running', ...over,
    }));
  }

  it('resolves template/owner/owningMain on a valid same-project request', () => {
    seedBrain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    const res = validateExecutionCloneRequest(req());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.template.name).toBe('deck_proj_w2');
      expect(res.owner.name).toBe('deck_proj_brain');
      expect(res.owningMain.name).toBe('deck_proj_brain');
    }
  });

  it('rejects when the owner session does not exist', () => {
    // No deck_proj_brain seeded → owner (and owningMain) missing.
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    expect(validateExecutionCloneRequest(req())).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects when the owning main session does not exist', () => {
    // Owner exists, but owningMain points at a different, unseeded session.
    seedBrain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    expect(validateExecutionCloneRequest(req({
      ownerSessionName: 'deck_proj_brain',
      owningMainSessionName: 'deck_proj_missingmain',
    }))).toEqual({ ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
  });

  it('rejects when the owning main is not a role-compatible main session', () => {
    // A worker record (not a brain) used as the owning main is rejected.
    mocks.sessions.set('deck_proj_w9', baseRecord({ name: 'deck_proj_w9', projectName: 'proj', role: 'w1' }));
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    expect(validateExecutionCloneRequest(req({
      ownerSessionName: 'deck_proj_w9',
      owningMainSessionName: 'deck_proj_w9',
    }))).toEqual({ ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
  });

  it('rejects when the template is in a different project than owner/main', () => {
    seedBrain();
    // Template lives in a DIFFERENT project than the owner/owningMain (proj).
    mocks.sessions.set('deck_other_w2', baseRecord({ name: 'deck_other_w2', projectName: 'other' }));
    expect(validateExecutionCloneRequest(req({ templateSessionName: 'deck_other_w2' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects when the owner is in a different project than the template/main', () => {
    seedBrain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    // Owner record exists but in a different project; still a brain so it is a
    // role-compatible main for ITS own project, but the cross-project scope fails.
    mocks.sessions.set('deck_other_brain', baseRecord({
      name: 'deck_other_brain', projectName: 'other', role: 'brain', state: 'running',
    }));
    expect(validateExecutionCloneRequest(req({ ownerSessionName: 'deck_other_brain' }))).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an error-state template before resolving owner/main', () => {
    seedBrain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj', state: 'error' }));
    expect(validateExecutionCloneRequest(req())).toEqual({
      ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });
});

// ── Identity isolation: spec + metadata carry no template identity ────────────

describe('buildExecutionCloneSpec — identity denylist', () => {
  it('copies only allowlist config and carries NONE of the denylist identity', () => {
    const template = templateWithAllIdentity();
    const spec = buildExecutionCloneSpec(template, req());

    // fresh is mandatory + provider-family-independent
    expect(spec.fresh).toBe(true);

    // allowlist config carried
    expect(spec.agentType).toBe('codex');
    expect(spec.runtimeType).toBe('transport');
    expect(spec.providerId).toBe('qwen');
    expect(spec.projectDir).toBe('/work/proj');
    expect(spec.requestedModel).toBe('model-req');
    expect(spec.activeModel).toBe('model-active');
    expect(spec.qwenModel).toBe('qwen-max');
    expect(spec.effort).toBe('high');
    expect(spec.ccPreset).toBe('MiniMax');
    expect(spec.presetContextWindow).toBe(200000);

    // EVERY denylist key absent from the spec object
    const specKeys = new Set(Object.keys(spec));
    for (const denied of EXECUTION_CLONE_IDENTITY_DENYLIST) {
      expect(specKeys.has(denied)).toBe(false);
    }

    // nested transport identity scrubbed; non-identity config retained
    expect(spec.transportConfig).toBeDefined();
    const tc = spec.transportConfig as Record<string, unknown>;
    expect(tc.supervision).toBe('on');
    expect('sessionId' in tc).toBe(false);
    expect('threadId' in tc).toBe(false);
    expect((tc.nested as Record<string, unknown>).keep).toBe('yes');
    expect('conversationId' in (tc.nested as Record<string, unknown>)).toBe(false);
  });

  it('allowlist and denylist are disjoint', () => {
    for (const k of EXECUTION_CLONE_COPY_ALLOWLIST) {
      expect(EXECUTION_CLONE_IDENTITY_DENYLIST).not.toContain(k);
    }
  });

  it('copies shellBin only for shell/script templates (host-normalized)', () => {
    // shell template with a host-portable bare command → copied.
    const shellTemplate = baseRecord({ name: 'deck_proj_w2', agentType: 'shell', shellBin: 'bash' });
    expect(buildExecutionCloneSpec(shellTemplate, req()).shellBin).toBe('bash');

    // script template → copied too.
    const scriptTemplate = baseRecord({ name: 'deck_proj_w2', agentType: 'script', shellBin: 'fish' });
    expect(buildExecutionCloneSpec(scriptTemplate, req()).shellBin).toBe('fish');

    // non-shell template → shellBin is never carried, even if present.
    const codexTemplate = baseRecord({ name: 'deck_proj_w2', agentType: 'codex', shellBin: 'bash' });
    expect('shellBin' in buildExecutionCloneSpec(codexTemplate, req())).toBe(false);
  });

  it('drops a cross-OS-incompatible shellBin via host normalization', () => {
    // On a Unix host a Windows-style path is not runnable → dropped (not copied broken).
    // (On Windows CI this would instead drop a bare unix path; both directions are
    //  covered by normalizeShellBinForHost's own unit tests — here we assert the
    //  Unix-host direction that this test environment exercises.)
    const winShell = baseRecord({ name: 'deck_proj_w2', agentType: 'shell', shellBin: 'C:\\Windows\\System32\\cmd.exe' });
    const spec = buildExecutionCloneSpec(winShell, req());
    if (process.platform === 'win32') {
      // On Windows the path may resolve; only assert the Unix-host drop elsewhere.
      expect(true).toBe(true);
    } else {
      expect(spec.shellBin).toBeUndefined();
      expect('shellBin' in spec).toBe(false);
    }
  });
});

// ── Metadata timer math ────────────────────────────────────────────────────────

describe('buildExecutionCloneMetadata', () => {
  it('sets createdAt/hardTimeoutAt/retentionExpiresAt/cleanupState correctly', () => {
    const now = 5_000_000;
    const pref: DedicatedExecutionRoutingGlobalPreference = {
      ...defaultDedicatedExecutionRoutingPreference(),
      cloneHardTimeoutMs: 123_456,
    };
    const meta = buildExecutionCloneMetadata(req(), now, pref);

    expect(meta.kind).toBe(EXECUTION_CLONE_KIND);
    expect(meta.ephemeral).toBe(true);
    expect(meta.createdAt).toBe(now);
    expect(meta.hardTimeoutAt).toBe(now + 123_456);
    expect(meta.retentionExpiresAt).toBeNull();
    expect(meta.cleanupState).toBe('active');
    expect(meta.autoDestroy).toBe(true);
    expect(meta.cloneOfSessionName).toBe('deck_proj_w2');
    expect(meta.parentRunId).toBe('run-1');
    expect(meta.parentStage).toBe('generic_execution');
    expect(meta.createdBySessionName).toBe('deck_proj_brain');
    expect(meta.completedAt).toBeUndefined();
    expect(meta.destroyRequestedAt).toBeUndefined();
  });

  it('persists cloneRetentionMs from the (normalized) preference for the completion paths to read', () => {
    const now = 5_000_000;
    const pref: DedicatedExecutionRoutingGlobalPreference = {
      ...defaultDedicatedExecutionRoutingPreference(),
      cloneRetentionMs: 90_000,
    };
    const meta = buildExecutionCloneMetadata(req(), now, pref);
    expect(meta.cloneRetentionMs).toBe(90_000);
  });
});

// ── Daemon→server identity-scrub overrides ─────────────────────────────────────

describe('buildScrubbedSyncOverrides', () => {
  it('nulls all identity ids for a clone record', () => {
    const clone = templateWithAllIdentity({ executionCloneMetadata: cloneMeta() });
    const overrides = buildScrubbedSyncOverrides(clone);

    for (const key of ['ccSessionId', 'codexSessionId', 'geminiSessionId', 'opencodeSessionId', 'providerSessionId', 'providerResumeId', 'paneId'] as const) {
      expect(key in overrides).toBe(true);
      expect(overrides[key]).toBeUndefined();
    }
  });

  it('returns an empty object for non-clone records', () => {
    expect(buildScrubbedSyncOverrides(baseRecord())).toEqual({});
  });
});

// ── Sweep precedence ───────────────────────────────────────────────────────────

describe('sweepExecutionClones', () => {
  // Creator-liveness sweep: the parent-terminal branch is driven by a POSITIVE
  // predicate over the clone record (its creator session gone/stopped/error).
  // By default the creator is alive (parent NOT terminal) so timer branches are
  // exercised in isolation.
  function makeDeps(over: Partial<{
    parentTerminal: (r: SessionRecord) => boolean;
    running: (r: SessionRecord) => boolean;
  }> = {}) {
    const destroyed: Array<{ target: string; reason: string }> = [];
    const deps = {
      isCloneParentTerminal: over.parentTerminal ?? (() => false),
      destroy: vi.fn(async (target: string, reason: string) => { destroyed.push({ target, reason }); }),
      isRunning: over.running ?? (() => true),
    };
    return { deps, destroyed };
  }

  /**
   * Production-faithful creator-liveness predicate: a clone's parent is terminal
   * iff its `createdBySessionName` session is absent / stopped / errored. Mirrors
   * the lifecycle.ts periodic-sweep wiring so these tests lock the real behavior,
   * not a stub. Reads the in-memory mock store via mocks.getSession.
   */
  const creatorLiveness = (rec: SessionRecord): boolean => {
    const creator = rec.executionCloneMetadata?.createdBySessionName;
    if (!creator) return false; // no creator info → protect
    const s = mocks.getSession(creator);
    return !s || s.state === 'stopped' || s.state === 'error';
  };

  it('destroys a running clone with hard_timeout once now >= hardTimeoutAt', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ hardTimeoutAt: 1000, retentionExpiresAt: null }),
    }));
    const { deps, destroyed } = makeDeps({ running: () => true });

    const res = await sweepExecutionClones(2000, deps);

    expect(res.swept).toEqual(['deck_sub_a']);
    expect(destroyed).toEqual([{ target: 'deck_sub_a', reason: 'hard_timeout' }]);
  });

  it('does NOT touch a running clone before hardTimeout with an active parent', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      // retention already elapsed, but it is still RUNNING and within hard timeout
      executionCloneMetadata: cloneMeta({ hardTimeoutAt: 10_000, retentionExpiresAt: 500 }),
    }));
    const { deps, destroyed } = makeDeps({ running: () => true });

    const res = await sweepExecutionClones(2000, deps);

    expect(res.swept).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('sweeps a non-running clone past its retention deadline', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ hardTimeoutAt: 1_000_000, retentionExpiresAt: 1500, completedAt: 1000 }),
    }));
    const { deps, destroyed } = makeDeps({ running: () => false });

    const res = await sweepExecutionClones(2000, deps);

    expect(res.swept).toEqual(['deck_sub_a']);
    expect(destroyed).toEqual([{ target: 'deck_sub_a', reason: 'sweep' }]);
  });

  it('does NOT sweep a non-running clone whose retentionExpiresAt is null', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ hardTimeoutAt: 1_000_000, retentionExpiresAt: null }),
    }));
    const { deps, destroyed } = makeDeps({ running: () => false });

    const res = await sweepExecutionClones(2_000_000, deps);

    expect(res.swept).toEqual([]);
    expect(destroyed).toEqual([]);
  });

  it('sweeps a clone whose parent (creator) is terminal regardless of timers', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      // brand new, far from any timeout — but the creator session is gone
      executionCloneMetadata: cloneMeta({ hardTimeoutAt: 9_999_999, retentionExpiresAt: null }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: () => true, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual(['deck_sub_a']);
    expect(destroyed).toEqual([{ target: 'deck_sub_a', reason: 'sweep' }]);
  });

  // ── R1/N4: creator-liveness reclaim + reverse-safety (registry-independent) ──

  it('R1 reclaim: a transport clone whose creator session is STOPPED is swept by creator-liveness', async () => {
    // Creator orchestrator session present but stopped (crashed/torn down).
    mocks.sessions.set('deck_proj_brain', baseRecord({ name: 'deck_proj_brain', role: 'brain', state: 'stopped' }));
    // Transport clone: no tmux pane, so pane-death completion never fires; only
    // the creator-liveness branch (or hard timeout) can reclaim it.
    mocks.sessions.set('deck_sub_orphan', baseRecord({
      name: 'deck_sub_orphan',
      runtimeType: 'transport',
      agentType: 'qwen',
      // Far from hard timeout, never completed → would linger until hardTimeoutAt
      // under the old inert `() => true` wiring. parentRunId is in NO registry.
      executionCloneMetadata: cloneMeta({
        createdBySessionName: 'deck_proj_brain',
        parentRunId: 'generic-run-not-registered',
        hardTimeoutAt: 9_999_999,
        retentionExpiresAt: null,
      }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: creatorLiveness, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual(['deck_sub_orphan']);
    expect(destroyed).toEqual([{ target: 'deck_sub_orphan', reason: 'sweep' }]);
  });

  it('R1 reclaim: a clone whose creator session is ABSENT is swept by creator-liveness', async () => {
    // No creator record at all (session gone entirely) → provably terminal.
    mocks.sessions.set('deck_sub_orphan', baseRecord({
      name: 'deck_sub_orphan',
      executionCloneMetadata: cloneMeta({
        createdBySessionName: 'deck_proj_brain', // not present in the store
        parentRunId: 'run-not-registered',
        hardTimeoutAt: 9_999_999,
        retentionExpiresAt: null,
      }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: creatorLiveness, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual(['deck_sub_orphan']);
    expect(destroyed).toEqual([{ target: 'deck_sub_orphan', reason: 'sweep' }]);
  });

  it('N4 reverse-safety: an ALIVE-creator running clone with an UNREGISTERED parentRunId is NOT swept', async () => {
    // The exact false-positive a naive registry `has()` implementation would
    // mis-kill: parentRunId is in NO registry (a generic/MCP clone), the worker
    // is running, and the creator session is alive (idle). It MUST be protected.
    mocks.sessions.set('deck_proj_brain', baseRecord({ name: 'deck_proj_brain', role: 'brain', state: 'idle' }));
    mocks.sessions.set('deck_sub_live', baseRecord({
      name: 'deck_sub_live',
      runtimeType: 'transport',
      agentType: 'qwen',
      executionCloneMetadata: cloneMeta({
        createdBySessionName: 'deck_proj_brain',
        parentRunId: 'generic-run-never-registered',
        hardTimeoutAt: 9_999_999, // well within the running bound
        retentionExpiresAt: null,
      }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: creatorLiveness, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('finished-run, creator-alive: parent-terminal branch does NOT fire; left for retention/hardTimeout', async () => {
    // Simulates an eager-destroy miss: the P2P run completed (its registry entry
    // was deleted) but the creator brain is still idle. Creator-liveness must NOT
    // treat this as terminal — the clone is left for retention/hardTimeout. Here
    // it is running and within its hard timeout, so nothing is swept this tick.
    mocks.sessions.set('deck_proj_brain', baseRecord({ name: 'deck_proj_brain', role: 'brain', state: 'idle' }));
    mocks.sessions.set('deck_sub_done', baseRecord({
      name: 'deck_sub_done',
      executionCloneMetadata: cloneMeta({
        createdBySessionName: 'deck_proj_brain',
        parentRunId: 'completed-run-deleted-from-registry',
        hardTimeoutAt: 9_999_999,
        retentionExpiresAt: null,
      }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: creatorLiveness, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual([]);
    expect(destroyed).toEqual([]);
  });

  it('T-#2 sub-creator orphan: a clone whose SUB-SESSION creator is STOPPED is swept by creator-liveness', async () => {
    // Documented sub-session-creator orphan coupling (distinct from the brain-
    // creator R1 test above): a clone can be created by another sub-session, not
    // only a brain. When that sub-session creator is stopped/gone the clone is an
    // orphan (nobody will read its output) and must be swept regardless of timers.
    mocks.sessions.set('deck_sub_worker', baseRecord({ name: 'deck_sub_worker', role: 'w1', state: 'stopped' }));
    mocks.sessions.set('deck_sub_orphan', baseRecord({
      name: 'deck_sub_orphan',
      runtimeType: 'transport',
      agentType: 'qwen',
      executionCloneMetadata: cloneMeta({
        cleanupState: 'active',
        createdBySessionName: 'deck_sub_worker', // sub-session creator, not a brain
        parentRunId: 'generic-run-not-registered',
        hardTimeoutAt: 9_999_999, // far future — only creator-liveness can reclaim it
        retentionExpiresAt: null,
      }),
    }));
    const { deps, destroyed } = makeDeps({ parentTerminal: creatorLiveness, running: () => true });

    const res = await sweepExecutionClones(1, deps);

    expect(res.swept).toEqual(['deck_sub_orphan']);
    expect(destroyed).toEqual([{ target: 'deck_sub_orphan', reason: 'sweep' }]);
  });

  it('ignores non-clone records', async () => {
    mocks.sessions.set('deck_proj_w1', baseRecord());
    const { deps, destroyed } = makeDeps();
    const res = await sweepExecutionClones(Number.MAX_SAFE_INTEGER, deps);
    expect(res.swept).toEqual([]);
    expect(destroyed).toEqual([]);
  });
});

// ── createExecutionClone integration (store + launch path) ─────────────────────

describe('createExecutionClone', () => {
  it('persists the record WITH metadata in the first upsert, before launching', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', templateWithAllIdentity());

    // Capture store state at the moment startSubSession is first called.
    let recordAtLaunch: SessionRecord | undefined;
    let upsertsBeforeLaunch = 0;
    mocks.startSubSession.mockImplementationOnce(async (sub) => {
      recordAtLaunch = mocks.sessions.get(`deck_sub_${sub.id}`);
      upsertsBeforeLaunch = mocks.upsertSession.mock.calls.length;
    });

    const result = await createExecutionClone(req());

    expect(result.target).toBe(result.sessionName);
    expect(result.sessionName).toMatch(/^deck_sub_[0-9a-f]{12}$/);

    // First upsert happened before launch and carried the clone metadata.
    expect(upsertsBeforeLaunch).toBeGreaterThanOrEqual(1);
    expect(recordAtLaunch).toBeDefined();
    expect(recordAtLaunch?.executionCloneMetadata?.kind).toBe(EXECUTION_CLONE_KIND);
    expect(recordAtLaunch?.parentSession).toBe('deck_proj_brain');
    expect(recordAtLaunch?.executionCloneMetadata?.cloneOfSessionName).toBe('deck_proj_w2');

    // No template identity leaked onto the persisted clone record.
    expect(recordAtLaunch?.ccSessionId).toBeUndefined();
    expect(recordAtLaunch?.codexSessionId).toBeUndefined();
    expect(recordAtLaunch?.providerSessionId).toBeUndefined();
    expect(recordAtLaunch?.providerResumeId).toBeUndefined();
    expect(recordAtLaunch?.paneId).toBeUndefined();
    expect(recordAtLaunch?.restarts).toBe(0);

    // Launch was forced fresh.
    const subArg = mocks.startSubSession.mock.calls[0]?.[0];
    expect(subArg?.fresh).toBe(true);
  });

  // ── N5a: launch-model fallback + qwenModel threading ──────────────────────

  it('N5a: a template with only activeModel launches with requestedModel === activeModel', async () => {
    seedOwningMain();
    // No requestedModel; only activeModel is set on the template.
    mocks.sessions.set('deck_proj_w2', baseRecord({
      name: 'deck_proj_w2', projectName: 'proj', agentType: 'codex',
      runtimeType: 'transport', providerId: 'codex',
      activeModel: 'gpt-active-only',
    }));

    await createExecutionClone(req());

    const subArg = mocks.startSubSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(subArg.requestedModel).toBe('gpt-active-only');
  });

  it('N5a: a template with only qwenModel launches with requestedModel === qwenModel and qwenModel preserved', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({
      name: 'deck_proj_w2', projectName: 'proj', agentType: 'qwen',
      runtimeType: 'transport', providerId: 'qwen',
      qwenModel: 'qwen3-coder-only',
    }));

    await createExecutionClone(req());

    const subArg = mocks.startSubSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(subArg.requestedModel).toBe('qwen3-coder-only');
    expect(subArg.qwenModel).toBe('qwen3-coder-only');
  });

  it('N5a regression: model fields are NOT identity — they are copied, never scrubbed', async () => {
    // requestedModel/activeModel/qwenModel are config, so they must reach the
    // launch record. They must also NOT appear in the identity denylist.
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', templateWithAllIdentity());

    await createExecutionClone(req());

    const subArg = mocks.startSubSession.mock.calls[0]?.[0] as Record<string, unknown>;
    // requestedModel present on the template wins the fallback.
    expect(subArg.requestedModel).toBe('model-req');
    expect(subArg.activeModel).toBe('model-active');
    expect(subArg.qwenModel).toBe('qwen-max');
    for (const field of ['requestedModel', 'activeModel', 'qwenModel']) {
      expect(EXECUTION_CLONE_IDENTITY_DENYLIST).not.toContain(field);
    }
  });

  // ── N5b: shellBin data plane (shell/script only) ──────────────────────────

  it('N5b: a shell template with shellBin carries the same shellBin on the first record AND the launch record', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({
      name: 'deck_proj_w2', projectName: 'proj', agentType: 'shell',
      // Bare command name is host-portable and survives normalization on any OS.
      shellBin: 'bash',
    }));

    let recordAtLaunch: SessionRecord | undefined;
    mocks.startSubSession.mockImplementationOnce(async (sub) => {
      recordAtLaunch = mocks.sessions.get(`deck_sub_${sub.id}`);
    });

    await createExecutionClone(req());

    // First persisted clone record carries the shellBin.
    expect(recordAtLaunch?.shellBin).toBe('bash');
    // Launch record carries the same shellBin.
    const subArg = mocks.startSubSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(subArg.shellBin).toBe('bash');
  });

  it('N5b: a non-shell (codex/transport) template carries NO shellBin', async () => {
    seedOwningMain();
    // Even if a stray shellBin somehow sat on a non-shell record, it must not be copied.
    mocks.sessions.set('deck_proj_w2', baseRecord({
      name: 'deck_proj_w2', projectName: 'proj', agentType: 'codex',
      runtimeType: 'transport', providerId: 'codex',
      shellBin: 'bash',
    }));

    let recordAtLaunch: SessionRecord | undefined;
    mocks.startSubSession.mockImplementationOnce(async (sub) => {
      recordAtLaunch = mocks.sessions.get(`deck_sub_${sub.id}`);
    });

    await createExecutionClone(req());

    expect(recordAtLaunch?.shellBin).toBeUndefined();
    const subArg = mocks.startSubSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('shellBin' in subArg).toBe(false);
  });

  it('throws capacity_full when the per-parent-run cap is already reached', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2' }));
    const pref = { ...defaultDedicatedExecutionRoutingPreference(), maxParallelClones: 1 };
    // already one active clone for run-1
    mocks.sessions.set('deck_sub_existing', baseRecord({ name: 'deck_sub_existing', executionCloneMetadata: cloneMeta() }));

    await expect(createExecutionClone(req({ pref }))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
  });

  // ── T-I: a completed (collecting) clone is cap-neutral; only `active` counts ──

  it('T-I-create: a `collecting` clone (worker already exited) does NOT hold a cap slot — a new create at cap 1 succeeds', async () => {
    // Finding I: a `collecting` clone's worker has ALREADY EXITED (state:'stopped',
    // completedAt set) — it occupies no running concurrency slot, so it must not
    // reserve the lone per-run cap slot for its retention window. Pre-fix the
    // create below would throw capacity_full.
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2' }));
    const pref = { ...defaultDedicatedExecutionRoutingPreference(), maxParallelClones: 1 };
    // Exactly ONE existing clone for run-1, COMPLETED + awaiting retention reap.
    mocks.sessions.set('deck_sub_collecting', baseRecord({
      name: 'deck_sub_collecting',
      state: 'stopped',
      executionCloneMetadata: cloneMeta({
        cleanupState: 'collecting',
        completedAt: 500,            // worker exited in the past
        retentionExpiresAt: 9_999_999, // still within its retention window
      }),
    }));

    const result = await createExecutionClone(req({ pref }));

    // A fresh clone was allocated + launched — the collecting clone did not block it.
    expect(result.sessionName).toMatch(/^deck_sub_[0-9a-f]{12}$/);
    expect(mocks.startSubSession).toHaveBeenCalledTimes(1);
    const subArg = mocks.startSubSession.mock.calls[0]?.[0];
    expect(subArg?.fresh).toBe(true);
  });

  it('T-I-active-still-blocks: a lone `active` clone DOES hold the cap slot — a new create at cap 1 throws capacity_full', async () => {
    // Regression lock: the fix must NOT relax the cap for genuinely running
    // clones. An `active` clone still occupies the lone slot.
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2' }));
    const pref = { ...defaultDedicatedExecutionRoutingPreference(), maxParallelClones: 1 };
    mocks.sessions.set('deck_sub_active', baseRecord({
      name: 'deck_sub_active',
      executionCloneMetadata: cloneMeta({ cleanupState: 'active' }),
    }));

    await expect(createExecutionClone(req({ pref }))).rejects.toMatchObject({
      code: EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL,
    });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
  });

  // ── T-A-timer: create normalizes a non-finite cloneHardTimeoutMs ──────────

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('T-A-timer: a %s cloneHardTimeoutMs is normalized so metadata.hardTimeoutAt is finite + sweep-expirable', async (_label, badTimeout) => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2' }));

    let recordAtLaunch: SessionRecord | undefined;
    mocks.startSubSession.mockImplementationOnce(async (sub) => {
      recordAtLaunch = mocks.sessions.get(`deck_sub_${sub.id}`);
    });

    const pref = {
      ...defaultDedicatedExecutionRoutingPreference(),
      cloneHardTimeoutMs: badTimeout as number,
    };
    const result = await createExecutionClone(req({ pref }));

    // The cap check did not silently disable (a NaN cap would make count>=NaN
    // false and never throw) — the create succeeded with a finite timer.
    const ht = recordAtLaunch?.executionCloneMetadata?.hardTimeoutAt;
    expect(typeof ht).toBe('number');
    expect(Number.isFinite(ht)).toBe(true);
    expect(result.metadata.hardTimeoutAt).toBe(ht);
    // hardTimeoutAt must be strictly after createdAt so the sweep can expire it.
    expect(ht!).toBeGreaterThan(recordAtLaunch!.executionCloneMetadata!.createdAt);
  });

  it('throws a typed error for an ineligible template and never launches', async () => {
    mocks.sessions.set('deck_proj_brain', baseRecord({ name: 'deck_proj_brain', role: 'brain' }));
    await expect(
      createExecutionClone(req({ templateSessionName: 'deck_proj_brain' })),
    ).rejects.toBeInstanceOf(ExecutionCloneError);
    expect(mocks.startSubSession).not.toHaveBeenCalled();
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it('best-effort destroys the partial clone when launch fails', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2' }));
    mocks.startSubSession.mockRejectedValueOnce(new Error('launch boom'));

    await expect(createExecutionClone(req())).rejects.toThrow('launch boom');

    // destroy path stopped the partial clone
    expect(mocks.stopSubSession).toHaveBeenCalledTimes(1);
    const stopTarget = mocks.stopSubSession.mock.calls[0]?.[0];
    expect(stopTarget).toMatch(/^deck_sub_/);
  });

  // Request-level validation (validateExecutionCloneRequest) is enforced BEFORE
  // the cap check and the first upsert: every rejection below must throw and
  // never launch or persist anything.
  it('rejects a cross-project template (owner/main in another project) without launching', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_other_w2', baseRecord({ name: 'deck_other_w2', projectName: 'other' }));
    await expect(createExecutionClone(req({ templateSessionName: 'deck_other_w2' })))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it('rejects when the owner session is missing without launching', async () => {
    // Template present, but no deck_proj_brain owner/main seeded.
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    await expect(createExecutionClone(req()))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it('rejects when the owning main is missing without launching', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    await expect(createExecutionClone(req({ owningMainSessionName: 'deck_proj_missingmain' })))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it('rejects when the owning main is not a role-compatible main without launching', async () => {
    mocks.sessions.set('deck_proj_w9', baseRecord({ name: 'deck_proj_w9', projectName: 'proj', role: 'w1' }));
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj' }));
    await expect(createExecutionClone(req({ ownerSessionName: 'deck_proj_w9', owningMainSessionName: 'deck_proj_w9' })))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it.each(['error', 'stopped'] as const)('rejects a %s-state template without launching', async (state) => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj', state }));
    await expect(createExecutionClone(req()))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
  });

  it('rejects a blank-projectDir template without launching', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj', projectDir: '' }));
    await expect(createExecutionClone(req()))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown-agentType template without launching', async () => {
    seedOwningMain();
    mocks.sessions.set('deck_proj_w2', baseRecord({ name: 'deck_proj_w2', projectName: 'proj', agentType: 'totally-not-an-agent' }));
    await expect(createExecutionClone(req()))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE });
    expect(mocks.startSubSession).not.toHaveBeenCalled();
  });
});

// ── destroyExecutionClone authz + lifecycle ────────────────────────────────────

describe('destroyExecutionClone', () => {
  it('throws target_not_found when the record is missing', async () => {
    await expect(destroyExecutionClone({ target: 'deck_sub_missing', reason: 'destroyed' }))
      .rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND });
  });

  it('rejects a non-creator caller with destroy_forbidden', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ createdBySessionName: 'deck_proj_brain' }),
    }));
    await expect(
      destroyExecutionClone({ target: 'deck_sub_a', callerSessionName: 'deck_proj_w9', reason: 'destroyed' }),
    ).rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN });
    expect(mocks.stopSubSession).not.toHaveBeenCalled();
  });

  it('allows the creator, marks destroying, stops, and emits the terminal event', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ createdBySessionName: 'deck_proj_brain', parentRunId: 'run-1' }),
    }));

    await destroyExecutionClone({ target: 'deck_sub_a', callerSessionName: 'deck_proj_brain', reason: 'destroyed' });

    // marked destroying with completedAt/destroyRequestedAt set
    const upserted = mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord;
    expect(upserted.executionCloneMetadata?.cleanupState).toBe('destroying');
    expect(typeof upserted.executionCloneMetadata?.completedAt).toBe('number');
    expect(typeof upserted.executionCloneMetadata?.destroyRequestedAt).toBe('number');

    expect(mocks.stopSubSession).toHaveBeenCalledWith('deck_sub_a');
    expect(mocks.emit).toHaveBeenCalledWith(
      'deck_sub_a',
      EXECUTION_CLONE_TIMELINE.TERMINAL,
      expect.objectContaining({ sessionName: 'deck_sub_a', parentRunId: 'run-1', reason: 'destroyed' }),
    );
  });

  it('bypasses authz for daemon GC (bypassAuth)', async () => {
    mocks.sessions.set('deck_sub_a', baseRecord({
      name: 'deck_sub_a',
      executionCloneMetadata: cloneMeta({ createdBySessionName: 'deck_proj_brain' }),
    }));
    await destroyExecutionClone({ target: 'deck_sub_a', callerSessionName: 'someone_else', reason: 'sweep', bypassAuth: true });
    expect(mocks.stopSubSession).toHaveBeenCalledWith('deck_sub_a');
  });

  it('clone-kind guard: bypassAuth against a normal (non-clone) sub-session → target_not_found, NEVER stops it', async () => {
    // A real sub-session that is NOT an execution clone (no metadata). Even a GC
    // bypassAuth caller must fail closed and never tear it down.
    mocks.sessions.set('deck_sub_normal', baseRecord({ name: 'deck_sub_normal' }));
    await expect(
      destroyExecutionClone({ target: 'deck_sub_normal', reason: 'sweep', bypassAuth: true }),
    ).rejects.toMatchObject({ code: EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND });
    expect(mocks.stopSubSession).not.toHaveBeenCalled();
    // And the guard fires before any metadata mutation upsert.
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });
});

// ── completeExecutionCloneOnRuntimeExit (transport runtime-exit completion) ────

describe('completeExecutionCloneOnRuntimeExit', () => {
  it('marks a clone collecting with completedAt/retentionExpiresAt and emits the terminal event', () => {
    const clone = baseRecord({
      name: 'deck_sub_t',
      // Old/rolling record with NO cloneRetentionMs persisted → falls back to default.
      executionCloneMetadata: cloneMeta({ parentRunId: 'run-1', cleanupState: 'active' }),
    });
    mocks.sessions.set('deck_sub_t', clone);

    completeExecutionCloneOnRuntimeExit(clone, 'pane_death');

    const upserted = mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord;
    expect(upserted.state).toBe('stopped');
    expect(upserted.executionCloneMetadata?.cleanupState).toBe('collecting');
    expect(typeof upserted.executionCloneMetadata?.completedAt).toBe('number');
    expect(typeof upserted.executionCloneMetadata?.retentionExpiresAt).toBe('number');
    expect(upserted.executionCloneMetadata?.retentionExpiresAt).toBe(
      (upserted.executionCloneMetadata?.completedAt ?? 0) + DEFAULT_CLONE_RETENTION_MS,
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      'deck_sub_t',
      EXECUTION_CLONE_TIMELINE.TERMINAL,
      expect.objectContaining({ sessionName: 'deck_sub_t', parentRunId: 'run-1', reason: 'pane_death' }),
    );
  });

  // ── T-retention: the persisted cloneRetentionMs governs the reap deadline ──

  it('T-retention: a custom (shorter) cloneRetentionMs is honored — retentionExpiresAt = completedAt + custom', () => {
    const clone = baseRecord({
      name: 'deck_sub_short',
      executionCloneMetadata: cloneMeta({ parentRunId: 'run-1', cloneRetentionMs: 60_000 }),
    });
    mocks.sessions.set('deck_sub_short', clone);

    completeExecutionCloneOnRuntimeExit(clone, 'reply');

    const meta = (mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord).executionCloneMetadata!;
    expect(meta.retentionExpiresAt).toBe((meta.completedAt ?? 0) + 60_000);
    expect(meta.retentionExpiresAt).not.toBe((meta.completedAt ?? 0) + DEFAULT_CLONE_RETENTION_MS);
  });

  it('T-retention: a custom (longer) cloneRetentionMs is honored', () => {
    const clone = baseRecord({
      name: 'deck_sub_long',
      executionCloneMetadata: cloneMeta({ parentRunId: 'run-1', cloneRetentionMs: 30 * 60 * 1000 }),
    });
    mocks.sessions.set('deck_sub_long', clone);

    completeExecutionCloneOnRuntimeExit(clone, 'reply');

    const meta = (mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord).executionCloneMetadata!;
    expect(meta.retentionExpiresAt).toBe((meta.completedAt ?? 0) + 30 * 60 * 1000);
  });

  it('T-retention: cloneRetentionMs:0 sets retentionExpiresAt === completedAt (reaped on the next eligible sweep)', () => {
    const clone = baseRecord({
      name: 'deck_sub_zero',
      executionCloneMetadata: cloneMeta({ parentRunId: 'run-1', cloneRetentionMs: 0 }),
    });
    mocks.sessions.set('deck_sub_zero', clone);

    completeExecutionCloneOnRuntimeExit(clone, 'reply');

    const meta = (mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord).executionCloneMetadata!;
    expect(meta.retentionExpiresAt).toBe(meta.completedAt);
  });

  it('T-retention: missing cloneRetentionMs (old record) falls back to DEFAULT_CLONE_RETENTION_MS', () => {
    const clone = baseRecord({
      name: 'deck_sub_old',
      executionCloneMetadata: cloneMeta({ parentRunId: 'run-1' }), // no cloneRetentionMs
    });
    mocks.sessions.set('deck_sub_old', clone);

    completeExecutionCloneOnRuntimeExit(clone, 'reply');

    const meta = (mocks.upsertSession.mock.calls.at(-1)?.[0] as SessionRecord).executionCloneMetadata!;
    expect(meta.retentionExpiresAt).toBe((meta.completedAt ?? 0) + DEFAULT_CLONE_RETENTION_MS);
  });

  it('is a no-op for a non-clone record', () => {
    completeExecutionCloneOnRuntimeExit(baseRecord({ name: 'deck_sub_x' }), 'pane_death');
    expect(mocks.upsertSession).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('is a no-op when already completed or destroying/destroyed', () => {
    for (const meta of [
      cloneMeta({ completedAt: 123 }),
      cloneMeta({ cleanupState: 'destroying' }),
      cloneMeta({ cleanupState: 'destroyed' }),
    ]) {
      mocks.upsertSession.mockClear();
      mocks.emit.mockClear();
      completeExecutionCloneOnRuntimeExit(baseRecord({ name: 'deck_sub_y', executionCloneMetadata: meta }), 'pane_death');
      expect(mocks.upsertSession).not.toHaveBeenCalled();
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  });
});

// ── resolveExecutionCloneRetentionMs (shared by BOTH completion paths) ─────────
//
// completeExecutionCloneOnRuntimeExit (this module) AND
// completeExecutionCloneOnPaneDeath (lifecycle.ts) both compute their reap
// deadline as `completedAt + resolveExecutionCloneRetentionMs(meta)`. Locking
// this helper locks the retention math for BOTH completion paths in one place.

describe('resolveExecutionCloneRetentionMs', () => {
  it('returns the persisted custom retention verbatim when within bounds', () => {
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: 60_000 }))).toBe(60_000);
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: 30 * 60 * 1000 }))).toBe(30 * 60 * 1000);
  });

  it('returns 0 for cloneRetentionMs:0 (immediate-reap configuration)', () => {
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: 0 }))).toBe(0);
  });

  it('falls back to DEFAULT_CLONE_RETENTION_MS for missing/undefined metadata (old/rolling records)', () => {
    expect(resolveExecutionCloneRetentionMs(cloneMeta())).toBe(DEFAULT_CLONE_RETENTION_MS);
    expect(resolveExecutionCloneRetentionMs(undefined)).toBe(DEFAULT_CLONE_RETENTION_MS);
  });

  it('sanitizes a malformed persisted value through the parser (NaN/negative → default; over-bound → MAX)', () => {
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: NaN }))).toBe(DEFAULT_CLONE_RETENTION_MS);
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: Infinity }))).toBe(DEFAULT_CLONE_RETENTION_MS);
    // Negative clamps to MIN (0).
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: -5 }))).toBe(0);
    // Finite out-of-bounds clamps to MAX, NOT passed through.
    expect(resolveExecutionCloneRetentionMs(cloneMeta({ cloneRetentionMs: 99 * 60 * 60 * 1000 }))).toBe(MAX_CLONE_RETENTION_MS);
  });
});
