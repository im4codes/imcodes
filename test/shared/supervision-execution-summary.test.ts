import { describe, expect, it } from 'vitest';
import {
  buildSupervisionExecutionSummary,
  type SupervisionExecutionSummaryCandidate,
} from '../../shared/supervision-execution-summary.js';
import type { SupervisionExecutionBinding } from '../../shared/supervision-execution-pool.js';

const BINDING: SupervisionExecutionBinding = {
  pool: 'primary',
  origin: 'configured',
  requested: {
    capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:opus',
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
    runtimeType: 'transport',
    model: 'opus',
  },
  actual: {
    sessionName: 'deck_cd_w1',
    sessionInstanceId: 'inst-1',
    runtimeEpoch: 'epoch-1',
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
    runtimeType: 'transport',
    model: 'claude-opus-5',
  },
};

const live = (over: Partial<SupervisionExecutionSummaryCandidate> = {}): SupervisionExecutionSummaryCandidate => ({
  sessionName: 'deck_cd_w1',
  label: 'worker one',
  agentType: 'codex-sdk',
  providerFamily: 'openai',
  model: 'gpt-5.6',
  status: 'idle',
  pool: 'economy',
  ...over,
});

describe('buildSupervisionExecutionSummary', () => {
  it('prefers the persisted assignment binding over anything live', () => {
    // The binding is what the work was actually admitted under. A live catalog
    // can drift (a session re-created under the same name on another provider)
    // and must never be allowed to relabel completed or in-flight work.
    const summary = buildSupervisionExecutionSummary({
      binding: BINDING,
      assignmentStatus: 'delegated',
      // Same name, present and live, reporting a different provider/model/pool.
      // Both inputs are available, which is the only arrangement that can tell
      // a real ranking from one that simply never saw the alternative.
      sessionName: 'deck_cd_w1',
      candidates: [live()],
    });
    expect(summary).toEqual({
      sessionName: 'deck_cd_w1',
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      model: 'claude-opus-5',
      runtimeType: 'transport',
      pool: 'primary',
      assignmentStatus: 'delegated',
      source: 'assignment',
    });
  });

  it('carries the pool through for an economy binding', () => {
    const summary = buildSupervisionExecutionSummary({
      binding: { ...BINDING, pool: 'economy' },
      assignmentStatus: 'implementing',
    });
    expect(summary).toMatchObject({ pool: 'economy', assignmentStatus: 'implementing', source: 'assignment' });
  });

  it('falls back to a unique live match when an old assignment has no binding', () => {
    const summary = buildSupervisionExecutionSummary({
      assignmentStatus: 'delegated',
      sessionName: 'deck_cd_w1',
      candidates: [live(), live({ sessionName: 'deck_cd_w2' })],
    });
    expect(summary).toEqual({
      sessionName: 'deck_cd_w1',
      label: 'worker one',
      agentType: 'codex-sdk',
      providerFamily: 'openai',
      model: 'gpt-5.6',
      pool: 'economy',
      assignmentStatus: 'delegated',
      source: 'live',
    });
  });

  it('refuses to guess when the name is ambiguous', () => {
    // Two live sessions answering to one name is exactly when a wrong answer
    // would be most expensive, so it is the one case that must stay silent.
    expect(buildSupervisionExecutionSummary({
      sessionName: 'deck_cd_w1',
      candidates: [live(), live({ label: 'other', providerFamily: 'openai' })],
    })).toBeNull();
  });

  it('refuses a stopped or errored session as evidence of where work runs', () => {
    for (const status of ['stopped', 'error'] as const) {
      expect(buildSupervisionExecutionSummary({
        sessionName: 'deck_cd_w1',
        candidates: [live({ status })],
      })).toBeNull();
    }
  });

  it('returns null rather than a half-populated summary when nothing matches', () => {
    expect(buildSupervisionExecutionSummary({ sessionName: 'deck_cd_gone', candidates: [live()] })).toBeNull();
    expect(buildSupervisionExecutionSummary({ candidates: [live()] })).toBeNull();
    expect(buildSupervisionExecutionSummary({})).toBeNull();
  });

  it('omits absent optional facts instead of emitting empty strings', () => {
    const summary = buildSupervisionExecutionSummary({
      sessionName: 'deck_cd_w1',
      candidates: [live({ label: null, pool: undefined, model: '' })],
    });
    expect(summary).not.toHaveProperty('label');
    expect(summary).not.toHaveProperty('pool');
    expect(summary).not.toHaveProperty('model');
    expect(summary).not.toHaveProperty('assignmentStatus');
  });
});
