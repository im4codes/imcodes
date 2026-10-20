/**
 * The Supervisor Brain chooses who audits and whether to cross vendor. The
 * daemon validates and delivers the EXACT route it was given, and fails closed
 * when that route is absent or ineligible.
 *
 * These are behavioral tests through dispatchSendMessage, not shape assertions
 * on the source, because the failure mode being guarded is a daemon that
 * silently substitutes a different auditor while still looking correct.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchSendMessage,
} from '../../src/daemon/send-tool.js';
import { AGENT_DELEGATION_PURPOSES } from '../../shared/agent-delegation.js';

function session(
  name: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance_${name}`,
    runtimeEpoch: `epoch_${name}`,
    projectName: 'alpha',
    role: 'w1',
    agentType: 'codex',
    projectDir: '/work/alpha',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    label: name,
    ...overrides,
  } as SessionRecord;
}

const BRAIN = 'deck_alpha_brain';
const AUDITED = 'deck_alpha_impl';
const AUDITOR_A = 'deck_alpha_reviewa';
const AUDITOR_B = 'deck_alpha_reviewb';
const NESTED = 'deck_alpha_nested';

/** Brain, audited impl, and TWO eligible peers on deliberately different vendors. */
function fleet(): SessionRecord[] {
  return [
    session(BRAIN, { role: 'brain' }),
    session(AUDITED, { parentSession: BRAIN }),
    session(AUDITOR_A, { parentSession: BRAIN, agentType: 'codex', label: 'A' }),
    session(AUDITOR_B, { parentSession: BRAIN, agentType: 'claude-code', label: 'B' }),
    // A CHILD of the audited session, not a sibling. It is a perfectly
    // resolvable send target -- so this case reaches the route validator
    // rather than being turned away earlier by scope resolution -- but it is
    // not a peer-audit candidate for the audited session.
    session(NESTED, { parentSession: AUDITED, label: 'N' }),
  ];
}

const caller = { userId: 'u', sessionName: BRAIN, projectName: 'alpha', projectRoot: '/work/alpha' };

async function routeAudit(target: string, auditedSessionName: string, sessions: SessionRecord[]) {
  const dispatchMessage = vi.fn(async () => undefined);
  const result = await dispatchSendMessage(caller, {
    target,
    message: 'audit brief',
    reply: true,
    audit: {
      kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      attemptId: 'attempt-abc123',
      auditedSessionName,
    },
  }, { listSessions: () => sessions, dispatchMessage, exactTargetOnly: true });
  return { result, dispatchMessage };
}

beforeEach(() => clearSendIdempotencyCacheForTests());

describe('supervision audit routing authority', () => {
  it('delivers to exactly the auditor the Brain named, and never the other eligible peer', async () => {
    const sessions = fleet();

    // Both A and B are genuinely eligible, so neither can be excused as a
    // "repair" of an unusable route. Only the Brain's statement distinguishes them.
    const toA = await routeAudit(AUDITOR_A, AUDITED, sessions);
    expect(toA.result.status).toBe('accepted');
    const aTargets = toA.dispatchMessage.mock.calls.map((call) => (call[0] as SessionRecord).name);
    expect(aTargets).toEqual([AUDITOR_A]);
    expect(aTargets).not.toContain(AUDITOR_B);

    clearSendIdempotencyCacheForTests();
    const toB = await routeAudit(AUDITOR_B, AUDITED, sessions);
    expect(toB.result.status).toBe('accepted');
    const bTargets = toB.dispatchMessage.mock.calls.map((call) => (call[0] as SessionRecord).name);
    expect(bTargets).toEqual([AUDITOR_B]);
    expect(bTargets).not.toContain(AUDITOR_A);
  });

  it('refuses a target that is not a candidate for the audited session', async () => {
    // The kill for provider-family substitution: a validator that searches the
    // candidate set by vendor instead of by NAME finds an unrelated eligible
    // peer here and wrongly accepts. Matching by name cannot.
    const { result, dispatchMessage } = await routeAudit(NESTED, AUDITED, fleet());
    expect(result).toMatchObject({
      status: 'error',
      reason: 'validation_failed',
      // Pinned so the refusal is provably the ROUTE validator's, not scope
      // resolution turning the target away before the route is ever checked.
      error: 'audit target is not a peer-audit candidate for the audited session',
    });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('rejects a self-audit by AUDITED identity, not by caller identity', async () => {
    // Caller is the Brain, which is neither auditor nor audited. Resolving the
    // audited session from the caller would read BRAIN here, see BRAIN !== impl,
    // and wave the self-audit through.
    const { result, dispatchMessage } = await routeAudit(AUDITED, AUDITED, fleet());
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the Brain supplied no audited session', async () => {
    const { result, dispatchMessage } = await routeAudit(AUDITOR_A, '   ', fleet());
    expect(result).toMatchObject({ status: 'error' });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});
