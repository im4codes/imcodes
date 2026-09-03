import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('the receipt display path spends nothing', () => {
  const root = join(import.meta.dirname, '..', '..');
  const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

  /**
   * The daemon-side join, sliced out of a file that legitimately does other
   * things. Asserting on the whole of send-tool would prove nothing.
   */
  const joinBody = (): string => {
    const source = read('src/daemon/send-tool.ts');
    const start = source.indexOf('function resolveDeliveryExecution');
    expect(start, 'resolveDeliveryExecution must exist').toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\nfunction ', start + 1));
  };

  // Every file a dispatch receipt passes through on its way to a reader.
  const DISPLAY_PATH = [
    'shared/supervision-execution-summary.ts',
    'shared/delegation-claim.ts',
    'web/src/components/DelegationClaimBadge.tsx',
  ] as const;

  it('imports no model client and reaches no network from any display file', () => {
    // The cheap way to build this feature would have been to hand a task object
    // to a model and ask it for a one-line summary. That is a token cost and a
    // latency cost on every rendered turn, for facts the registry already
    // holds exactly. Naming the temptation in a test is the only way it stays
    // refused after everyone has forgotten why.
    const forbiddenImport = /^\s*import[^;]*from\s*'([^']*(?:anthropic|openai|langchain|genai|mistral|cohere|ollama|llm|completion)[^']*)'/gim;
    const forbiddenCall = /\b(fetch|XMLHttpRequest|axios|generateText|createMessage|createCompletion)\s*\(/;
    for (const relative of DISPLAY_PATH) {
      const source = read(relative);
      expect([...source.matchAll(forbiddenImport)].map((m) => m[1]), relative).toEqual([]);
      expect(forbiddenCall.test(source), `${relative} must not call out`).toBe(false);
    }
  });

  it('resolves the summary synchronously, with no awaited work', () => {
    // A pure function cannot quietly grow a lookup. If this ever needs `await`,
    // something has been added that this test exists to catch.
    const source = read('shared/supervision-execution-summary.ts');
    expect(source).not.toContain('await ');
    expect(source).not.toContain('async ');
  });

  it('spends at most the one O(1) assignment read on the daemon side', () => {
    const body = joinBody();
    expect((body.match(/getSupervisionTaskRegistry\(\)/g) ?? []).length).toBe(1);
    expect((body.match(/\.getAssignment\(/g) ?? []).length).toBe(1);
    // No unbounded registry reads, and no second trip for the same receipt.
    for (const unbounded of ['.list(', '.listEvents(', '.listAuditReceipts(', '.get(']) {
      expect(body, `resolveDeliveryExecution must not call ${unbounded}`).not.toContain(unbounded);
    }
    expect(body).not.toMatch(/\bfor\s*\(|\.map\(|\.filter\(/);
  });

  it('generates nothing and calls nothing out from inside the real join', () => {
    // The counting assertion above is not enough on its own: a `generateText`
    // call added inside this function adds no registry read, no `.list(`, and
    // no loop, so it would sail past every other check here. The join is where
    // a per-receipt token cost would actually be introduced, so it is asserted
    // directly rather than by proximity to the display files.
    const body = joinBody();
    const forbiddenCall =
      /\b(fetch|XMLHttpRequest|axios|generateText|generateObject|streamText|createMessage|createCompletion|complete|summarize|prompt|invokeModel|chat)\s*\(/;
    const offender = body.match(forbiddenCall)?.[1];
    expect(offender, `resolveDeliveryExecution must not call ${offender ?? ''}`).toBeUndefined();
    expect(body).not.toMatch(/\bawait\b/);

    // send-tool talks to the network for other reasons, so call-shape scanning
    // has to stay scoped -- but importing a model client is never legitimate
    // anywhere in this file, and that is checkable file-wide.
    const source = read('src/daemon/send-tool.ts');
    const forbiddenImport =
      /^\s*import[^;]*from\s*'([^']*(?:anthropic|openai|langchain|genai|mistral|cohere|ollama|llm|completion)[^']*)'/gim;
    expect([...source.matchAll(forbiddenImport)].map((m) => m[1])).toEqual([]);
  });
});
