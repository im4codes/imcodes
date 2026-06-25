/**
 * Deterministic, DB-free unit test for the daemon-side execution-clone metadata
 * sync mapping (`buildSubSessionSyncPayload` in `src/daemon/subsession-sync.ts`).
 *
 * Contract under test (server-side persistence relies on it):
 *  - An execution-clone SessionRecord (executionCloneMetadata.kind ===
 *    'execution_clone') produces a sync payload whose runtime IDENTITY fields
 *    are nulled out (so stale identity NEVER replicates to Postgres) while the
 *    executionCloneMetadata itself IS carried through.
 *  - A normal (non-clone) sub-session payload is UNCHANGED: identity fields are
 *    preserved and executionCloneMetadata is null.
 *
 * The function is daemon-side and imports several agent runtime/display helpers
 * with side effects; they are mocked to keep this test hermetic. The daemon
 * `session-store` is mocked so `getSession` returns the record under test
 * without touching `~/.imcodes/sessions.json`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  type ExecutionCloneMetadata,
} from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

// ── Mock the daemon session store: getSession returns whatever the active test
//    registered for the resolved sub-session name (`deck_sub_<id>`). ───────────
const sessionByName = new Map<string, SessionRecord>();

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string): SessionRecord | undefined => sessionByName.get(name),
}));

// ── Stub agent runtime/display/quota helpers so the payload builder has no
//    real side effects and returns a deterministic shape. ────────────────────
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: async () => ({}),
}));
vi.mock('../../src/agent/codex-display.js', () => ({
  mergeCodexDisplayMetadata: (base: Record<string, unknown>) => base,
}));
vi.mock('../../src/agent/provider-display.js', () => ({
  getQwenDisplayMetadata: () => ({}),
}));
vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: () => undefined,
}));
vi.mock('../../src/agent/sdk-runtime-config.js', () => ({
  getClaudeSdkRuntimeConfig: async () => ({}),
}));
vi.mock('../../src/agent/claude-usage-quota.js', () => ({
  getClaudeUsageQuota: async () => null,
}));

// Import AFTER the mocks are registered.
const { buildSubSessionSyncPayload } = await import('../../src/daemon/subsession-sync.js');

const CLONE_ID = 'clone1234';
const NORMAL_ID = 'normal567';

function cloneMetadata(): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_proj_exec',
    parentRunId: 'run-abc',
    parentStage: 'generic_execution',
    createdBySessionName: 'deck_proj_brain',
    createdAt: 1_700_000_000_000,
    hardTimeoutAt: 1_700_000_600_000,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
  };
}

beforeEach(() => {
  sessionByName.clear();
});

describe('buildSubSessionSyncPayload — execution clone identity scrub', () => {
  it('nulls every runtime identity field but carries executionCloneMetadata for a clone', async () => {
    const metadata = cloneMetadata();
    sessionByName.set(`deck_sub_${CLONE_ID}`, {
      agentType: 'claude-code-sdk',
      state: 'idle',
      // Populated runtime identity that MUST NOT replicate for a clone.
      ccSessionId: 'cc-should-not-leak',
      codexSessionId: 'codex-should-not-leak',
      geminiSessionId: 'gemini-should-not-leak',
      opencodeSessionId: 'oc-should-not-leak',
      providerSessionId: 'provider-should-not-leak',
      providerResumeId: 'resume-should-not-leak',
      executionCloneMetadata: metadata,
    } as unknown as SessionRecord);

    const payload = await buildSubSessionSyncPayload(CLONE_ID);
    expect(payload).not.toBeNull();
    const p = payload as Record<string, unknown>;

    // executionCloneMetadata is carried through verbatim.
    expect(p.executionCloneMetadata).toEqual(metadata);
    expect((p.executionCloneMetadata as ExecutionCloneMetadata).kind).toBe(EXECUTION_CLONE_KIND);

    // Identity fields present on the wire payload are nulled.
    expect(p.ccSessionId).toBeNull();
    expect(p.geminiSessionId).toBeNull();
    expect(p.providerSessionId).toBeNull();

    // The leaked values never appear anywhere in the serialized payload.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain('should-not-leak');
  });
});

describe('buildSubSessionSyncPayload — normal sub-session unchanged', () => {
  it('preserves identity fields and emits no executionCloneMetadata', async () => {
    sessionByName.set(`deck_sub_${NORMAL_ID}`, {
      agentType: 'claude-code-sdk',
      state: 'idle',
      ccSessionId: 'cc-keep',
      geminiSessionId: 'gemini-keep',
      providerSessionId: 'provider-keep',
      // no executionCloneMetadata → not a clone
    } as unknown as SessionRecord);

    const payload = await buildSubSessionSyncPayload(NORMAL_ID);
    expect(payload).not.toBeNull();
    const p = payload as Record<string, unknown>;

    // Identity preserved.
    expect(p.ccSessionId).toBe('cc-keep');
    expect(p.geminiSessionId).toBe('gemini-keep');
    expect(p.providerSessionId).toBe('provider-keep');

    // No clone metadata for a normal sub-session.
    expect(p.executionCloneMetadata ?? null).toBeNull();
  });

  it('does not scrub when metadata kind is not an execution clone', async () => {
    sessionByName.set(`deck_sub_${NORMAL_ID}`, {
      agentType: 'claude-code-sdk',
      state: 'idle',
      ccSessionId: 'cc-keep',
      providerSessionId: 'provider-keep',
      // A non-clone metadata-ish value must NOT trigger the scrub.
      executionCloneMetadata: { kind: 'something_else' } as unknown,
    } as unknown as SessionRecord);

    const payload = await buildSubSessionSyncPayload(NORMAL_ID);
    const p = payload as Record<string, unknown>;
    expect(p.ccSessionId).toBe('cc-keep');
    expect(p.providerSessionId).toBe('provider-keep');
  });
});
