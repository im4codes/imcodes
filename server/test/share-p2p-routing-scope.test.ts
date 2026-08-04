/**
 * `evaluateP2pSendTargetScope` inspected four structured routing fields while
 * the daemon honours sixteen — and, more importantly, also routes on control
 * tokens parsed out of the message TEXT.
 *
 * The reachable bypass was the text one: `@@discuss(<session>, <mode>)` and
 * `@@all(<mode>)` let a participant sharing a single tab name any session in
 * the store, or the whole domain, in plain prose. That is what the `in-text
 * routing tokens` block covers.
 *
 * The launch-envelope field is a forward guard, not a reproduction: the shipped
 * `P2pWorkflowLaunchEnvelope` carries no routing targets — participants are
 * bound daemon-side. An earlier version of this file asserted against an
 * invented `participants` array on the envelope, which read as if it
 * reproduced a live bypass. The envelope cases are now written against the real
 * type and labelled for what they are.
 *
 * The sweep is driven by the shared routing-field list, so these also serve as
 * the regression for the daemon's list and the share checker's drifting apart.
 */
import { describe, expect, it } from 'vitest';
import { evaluateP2pSendTargetScope } from '../src/share/p2p-send-scope.js';
import { P2P_ROUTING_FIELDS, collectP2pRoutedSessionNames } from '../../shared/p2p-routing-fields.js';
import type { ShareTarget } from '../../shared/tab-sharing.js';

const serverId = 'srv-p2p-1';
const covered = 'deck_proj_brain';
const uncovered = 'deck_secret_brain';
const target: ShareTarget = { kind: 'main', serverId, sessionName: covered };
const coversSession = (name: string) => name === covered;

const evaluate = (msg: Record<string, unknown>) => evaluateP2pSendTargetScope({ msg, target, coversSession });

describe('P2P send scope — launch envelope', () => {
  // The real `P2pWorkflowLaunchEnvelope` (shared/p2p-workflow-types.ts:41-73)
  // carries no routing targets today: it holds `legacy` / `advancedDraft` /
  // `oldAdvanced` / `launchContext`, and the daemon binds participants itself
  // from the session store. An earlier version of these tests invented a
  // `participants` array on the envelope, which made them look like they
  // reproduced a live bypass when the shape does not occur. They are kept as
  // forward guards, described as such — the real reachable text path is
  // covered in the `in-text routing tokens` block below.

  it('denies an envelope whose launchContext names an uncovered session', () => {
    // `launchContext.sessionName` is the originating session and is normally
    // covered. Naming another one is not a legitimate shape, so failing closed
    // here is the intended answer rather than a false positive.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: {
        workflowSchemaVersion: 1,
        workflowKind: 'advanced',
        launchContext: { sessionName: uncovered, requestId: 'req-1' },
      },
    })).toBe('share-direct-surface-denied');
  });

  it('allows a real envelope that names no session at all', () => {
    // The common case. Denying this would break shared advanced launches.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: {
        workflowSchemaVersion: 1,
        workflowKind: 'advanced',
        oldAdvanced: {
          advancedPresetKey: 'preset-alpha',
          advancedRounds: [{ id: 'r1', title: 'review', preset: 'review' }],
        },
        launchContext: { sessionName: covered, requestId: 'req-1' },
      },
    })).toBeNull();
  });

  it('would catch a future envelope shape that nests a target session', () => {
    // Forward guard only — no shipped envelope has this shape. Key-driven, so
    // a new layout that still calls its target `sessionName` is scoped without
    // this file changing.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: {
        workflowSchemaVersion: 1,
        workflowKind: 'advanced',
        advancedDraft: { nodes: [{ id: 'n1', sessionName: uncovered }] },
      },
    })).toBe('share-direct-surface-denied');
  });
});

describe('P2P send scope', () => {
  it('leaves an ordinary send alone', () => {
    expect(evaluate({ type: 'session.send', sessionName: covered, text: 'hello' })).toBeNull();
  });

  it('does not deny an ordinary send for naming a parent session outside coverage', () => {
    // The sweep is scoped to routing fields on purpose. Context like
    // `parentSession` is not a routing decision and must not deny the send.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      parentSession: uncovered,
      text: 'hello',
    })).toBeNull();
  });

  it('still denies the previously-handled shapes', () => {
    expect(evaluate({ type: 'session.send', directTargetSession: uncovered })).toBe('share-direct-surface-denied');
    expect(evaluate({ type: 'session.send', p2pAtTargets: [{ session: uncovered }] })).toBe('share-direct-surface-denied');
    expect(evaluate({ type: 'session.send', p2pMode: 'debate' })).toBe('share-direct-surface-denied');
  });

  it('does not read a mode, locale or preset key as a session name', () => {
    // The sweep first added the bare string value of EVERY routing field, so
    // `p2pMode: 'debate'` looked like a routed session no share could cover.
    // It denied correctly there only by accident, and denied bounded `__all__`
    // sends that should have been allowed.
    const config = { [covered]: { enabled: true, mode: 'reply' } };
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pMode: 'debate',
      p2pLocale: 'zh-CN',
      p2pAdvancedPresetKey: 'preset-alpha',
      p2pSessionConfig: config,
    })).toBeNull();
  });

  it('allows a bounded __all__ send whose enabled config targets are covered', () => {
    // `__all__` is a fan-out sentinel, not a session. Collecting it as one
    // denied this outright — caught by the existing share integration test.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      directTargetSession: '__all__',
      p2pSessionConfig: { [covered]: { enabled: true, mode: 'reply' } },
    })).toBeNull();
  });
});

describe('routing field inventory', () => {
  it('sweeps every field the daemon treats as routing', () => {
    // Guard against a field being added to the list but the sweep quietly
    // ignoring it: each one, given a nested session name, must be found.
    for (const field of P2P_ROUTING_FIELDS) {
      const found = collectP2pRoutedSessionNames({ [field]: { participants: [{ sessionName: uncovered }] } });
      expect(found, `${field} was not swept`).toContain(uncovered);
    }
  });

  it('never treats the fan-out sentinel as a session', () => {
    expect(collectP2pRoutedSessionNames({ directTargetSession: '__all__' })).toEqual([]);
    expect(collectP2pRoutedSessionNames({ p2pAtTargets: [{ session: '__all__' }] })).toEqual([]);
  });

  it('ignores session names outside the routing fields', () => {
    expect(collectP2pRoutedSessionNames({ sessionName: covered, detail: { sessionName: uncovered } })).toEqual([]);
  });
});

describe('in-text routing tokens', () => {
  it('denies @@discuss naming an uncovered session', () => {
    // The daemon parses these straight out of the message text and fans the
    // turn out. A structured-fields-only check let a participant sharing one
    // tab route work anywhere in the domain by typing it in prose.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      text: `@@discuss(${uncovered}, audit) please inspect`,
    })).toBe('share-direct-surface-denied');
  });

  it('denies @@all outright as an unbounded fan-out', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      text: '@@all(audit) inspect',
    })).toBe('share-direct-surface-denied');
  });

  it('allows @@discuss naming only covered sessions', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      text: `@@discuss(${covered}, audit) inspect`,
    })).toBeNull();
  });

  it('leaves ordinary prose mentioning a session name alone', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      text: `I was looking at ${uncovered} yesterday`,
    })).toBeNull();
  });

  it('answers the same way on repeated calls', () => {
    // `ALL_TOKEN_RE.test()` on a /g/ regex advances lastIndex and would flip
    // between allow and deny for identical input.
    const msg = { type: 'session.send', sessionName: covered, text: '@@all(audit) go' };
    expect(evaluate(msg)).toBe('share-direct-surface-denied');
    expect(evaluate(msg)).toBe('share-direct-surface-denied');
    expect(evaluate(msg)).toBe('share-direct-surface-denied');
  });
});
