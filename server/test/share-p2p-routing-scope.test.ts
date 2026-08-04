/**
 * `evaluateP2pSendTargetScope` hand-parsed four routing fields while the daemon
 * honoured sixteen. The gap that mattered was `p2pWorkflowLaunchEnvelope`,
 * whose targets sit at `participants[].sessionName`: with none of the four
 * fields present the checker reported "no P2P routing" and let the send through
 * unscoped, so a share recipient could fan work out to sessions their share
 * does not cover.
 *
 * The sweep is now driven by the shared routing-field list, so these also serve
 * as the regression for the two lists drifting apart again.
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

describe('P2P send scope', () => {
  it('denies a workflow envelope naming an uncovered participant', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: {
        workflowKind: 'advanced',
        participants: [{ sessionName: covered }, { sessionName: uncovered }],
      },
    })).toBe('share-direct-surface-denied');
  });

  it('denies the legacy envelope field too', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      workflowLaunchEnvelope: { participants: [{ sessionName: uncovered }] },
    })).toBe('share-direct-surface-denied');
  });

  it('denies a target buried in launchScope rather than participants', () => {
    // Key-driven, not shape-driven: a new envelope layout that still calls its
    // target `sessionName` is caught without touching the checker.
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: { launchScope: { serverId, sessionName: uncovered } },
    })).toBe('share-direct-surface-denied');
  });

  it('allows an envelope whose participants are all covered', () => {
    expect(evaluate({
      type: 'session.send',
      sessionName: covered,
      p2pWorkflowLaunchEnvelope: { participants: [{ sessionName: covered }] },
    })).toBeNull();
  });

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
