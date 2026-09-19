/**
 * send_list_targets must actually return the fields the delegation-eligibility
 * contract requires.
 *
 * SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS is published to every
 * supervised model as a HARD GATE: call send_list_targets and require these
 * fields before delegating. The tool returned only `status`, so a model obeying
 * the contract could never satisfy it — the gate was unsatisfiable by
 * construction, and the honest response to it was to refuse every delegation.
 *
 * The required-field list is read from the contract constant rather than
 * restated here, so the two cannot drift apart again.
 */
import { describe, expect, it } from 'vitest';
import { SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS } from '../../shared/supervision-config.js';
import { DELEGATION_AVAILABILITY } from '../../shared/delegation-availability.js';
import { listSendTargets } from '../../src/daemon/send-tool.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function session(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance_${name}`,
    runtimeEpoch: `epoch_${name}`,
    projectName: 'alpha',
    role: 'w1',
    agentType: 'claude-code-sdk',
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

const caller = { userId: 'u', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' };

function listWith(sessions: SessionRecord[]) {
  const result = listSendTargets(caller, {}, { listSessions: () => sessions });
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.items;
}

describe('send_list_targets delegation-eligibility projection', () => {
  it('returns every field the published eligibility contract requires', () => {
    const items = listWith([
      session('deck_alpha_brain', { role: 'brain' }),
      session('deck_alpha_w1'),
    ]);
    expect(items.length).toBeGreaterThan(0);

    // `targetSession` in the contract is this projection's `sessionName`; every
    // other required field is named identically.
    const contractToProjection: Record<string, string> = { targetSession: 'sessionName' };
    for (const item of items) {
      for (const field of SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS) {
        const key = contractToProjection[field] ?? field;
        expect(item, `contract field ${field} -> ${key}`).toHaveProperty(key);
        expect((item as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
      }
    }
  });

  it('reports availability from real session state, not a constant', () => {
    const items = listWith([
      session('deck_alpha_brain', { role: 'brain' }),
      session('deck_alpha_idle', { state: 'idle' }),
      session('deck_alpha_busy', { state: 'running' }),
      session('deck_alpha_down', { state: 'stopped' }),
      session('deck_alpha_broken', { state: 'error' }),
    ]);
    const byName = new Map(items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_idle')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
    expect(byName.get('deck_alpha_busy')?.availability).toBe(DELEGATION_AVAILABILITY.BUSY);
    // A stopped session is not a discoverable send target at all, so it is
    // absent rather than listed as offline. Asserting the absence keeps that
    // distinction honest instead of implying we report on it.
    expect(byName.has('deck_alpha_down')).toBe(false);
    // A session in error is KNOWN unusable, not merely unobserved. Reporting
    // `unknown` would let a caller treat it as maybe-ready.
    expect(byName.get('deck_alpha_broken')?.availability).toBe(DELEGATION_AVAILABILITY.OFFLINE);
  });

  it('reports replyCapable from the agent type, not from liveness', () => {
    const items = listWith([
      session('deck_alpha_brain', { role: 'brain' }),
      session('deck_alpha_sdk', { agentType: 'claude-code-sdk' }),
      session('deck_alpha_shell', { agentType: 'shell' }),
    ]);
    const byName = new Map(items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_sdk')?.replyCapable).toBe(true);
    expect(byName.get('deck_alpha_shell')?.replyCapable).toBe(false);
  });

  it('uses the audit/task provider-family resolver rather than the quota limit group', () => {
    const items = listWith([
      session('deck_alpha_brain', { role: 'brain' }),
      session('deck_alpha_codex', { agentType: 'codex-sdk' }),
      session('deck_alpha_claude', { agentType: 'claude-code-sdk' }),
      session('deck_alpha_oc_sdk', { agentType: 'opencode-sdk' }),
      session('deck_alpha_oc', { agentType: 'opencode' }),
      session('deck_alpha_override', { agentType: 'opencode-sdk', providerId: 'anthropic' }),
    ]);
    const byName = new Map(items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_codex')).toMatchObject({ providerFamily: 'openai', limitGroup: 'codex' });
    expect(byName.get('deck_alpha_claude')).toMatchObject({ providerFamily: 'anthropic', limitGroup: 'claude' });
    expect(byName.get('deck_alpha_oc_sdk')?.providerFamily).toBe('opencode');
    expect(byName.get('deck_alpha_oc')?.providerFamily).toBe('opencode');
    expect(byName.get('deck_alpha_override')?.providerFamily).toBe('anthropic');
  });
});
