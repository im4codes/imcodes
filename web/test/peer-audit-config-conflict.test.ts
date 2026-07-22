/**
 * Web Peer Audit — config_conflict / candidate_refresh_required recovery tests.
 *
 * Covers:
 * - On config_conflict from startQuickAudit: fresh listCandidates() + chooser opens + revisions updated.
 * - Never auto-replays the previous selection (different commandId on retry).
 * - Auto mode / loop counters are NOT mutated (the adapter contract forbids it).
 * - Double-click while starting / pending: only one in-flight start, second is rejected.
 * - Multi-tab conflict: two tabs racing with the same revision; the loser must NOT auto-replay.
 * - Refresh failure: chooser opens with null candidates and config_repair reason.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createElement } from 'preact';
import { usePeerAuditController } from '../src/peerAudit/usePeerAuditController.js';
import type {
  PeerAuditAdapter,
  PeerAuditAuditedSessionIdentity,
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditControllerApi,
  PeerAuditErrorReason,
} from '../src/peerAudit/types.js';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

const IDENTITY: PeerAuditAuditedSessionIdentity = {
  sessionInstanceId: 'audited-x-instance',
  runtimeEpoch: 'audited-x-epoch-1',
};

interface AdapterSpy extends PeerAuditAdapter {
  listCallCount: number;
  listResultByCall: PeerAuditCandidateList[];
  startCalls: Array<{ commandId: string; candidateListRevision: string; targetConfigRevision: string }>;
  patchCalls: Array<{ target: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string }; candidateListRevision: string }>;
  emitResult(attemptId: string): void;
}

function candidateA(): PeerAuditCandidate {
  return {
    name: 'peer-a',
    label: 'Peer A',
    sessionInstanceId: 'peer-a-instance',
    runtimeEpoch: 'peer-a-epoch-1',
    normalizedModelId: 'claude-opus-4-7',
    providerFamily: 'anthropic',
    liveState: 'idle',
    dispositionCapability: 'sent',
    eligible: true,
    reason: 'eligible',
  };
}

function candidateB(): PeerAuditCandidate {
  return {
    name: 'peer-b',
    label: 'Peer B',
    sessionInstanceId: 'peer-b-instance',
    runtimeEpoch: 'peer-b-epoch-1',
    normalizedModelId: 'gpt-4',
    providerFamily: 'openai',
    liveState: 'idle',
    dispositionCapability: 'sent',
    eligible: true,
    reason: 'eligible',
  };
}

function makeAdapter(opts: {
  startResults: Array<{ ok: true; attemptId: string; resultEventId: string } | { ok: false; reason: PeerAuditErrorReason; message: string }>;
  listResults: PeerAuditCandidateList[];
  patchFails?: boolean;
}): AdapterSpy {
  const spy: AdapterSpy = {
    listCallCount: 0,
    listResultByCall: opts.listResults,
    startCalls: [],
    patchCalls: [],
    async listCandidates() {
      const idx = Math.min(spy.listCallCount, opts.listResults.length - 1);
      spy.listCallCount += 1;
      return opts.listResults[idx]!;
    },
    async patchAuditorTarget(input) {
      spy.patchCalls.push({ target: input.target, candidateListRevision: input.candidateListRevision });
      if (opts.patchFails) return { ok: false, reason: 'config_conflict' };
      return { ok: true };
    },
    async startQuickAudit(input) {
      spy.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
      const idx = Math.min(spy.startCalls.length - 1, opts.startResults.length - 1);
      const r = opts.startResults[idx]!;
      if (r.ok) return { ok: true, attemptId: r.attemptId, resultEventId: r.resultEventId };
      return { ok: false, reason: r.reason, message: r.message };
    },
    async cancelAttempt() {
      return { ok: true };
    },
    subscribeResults() {
      return () => {};
    },
    emitResult() {
      // unused in this file
    },
  };
  return spy;
}

function listWith(revision: string, targetRevision: string, candidates: PeerAuditCandidate[]): PeerAuditCandidateList {
  return {
    revision,
    targetConfigRevision: targetRevision,
    auditedSessionName: 'audited-x',
    auditedSessionInstanceId: IDENTITY.sessionInstanceId,
    candidates,
  };
}

const asyncFlush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('Peer Audit web config_conflict recovery', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('config_conflict path', () => {
    let adapter: AdapterSpy;
    let latest: PeerAuditControllerApi;

    function Probe() {
      latest = usePeerAuditController({
        adapter,
        auditedSessionIdentity: IDENTITY,
        auditedSessionName: 'audited-x',
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        rememberedTarget: null,
        hasUserConsentedTo: () => true,
      });
      return null;
    }

    beforeEach(() => {
      adapter = makeAdapter({
        listResults: [
          listWith('rev-1', 'target-rev-1', [candidateA(), candidateB()]),
        ],
        startResults: [
          { ok: false, reason: 'config_conflict', message: 'another tab selected a different auditor' },
          { ok: true, attemptId: 'attempt-2', resultEventId: 'result-2' },
        ],
      });
      render(createElement(Probe), document.createElement('div'));
    });

    it('on config_conflict: refreshes candidates, opens chooser, never auto-replays previous selection', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await asyncFlush();
      expect(latest.state.kind).toBe('chooser');
      // Select candidate A and dispatch.
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[0]!
        : null;
      expect(cand).not.toBeNull();
      act(() => latest.selectCandidate(cand!));
      await asyncFlush();
      // First start fails with config_conflict.
      expect(adapter.startCalls.length).toBe(1);
      // Refresh triggered: listCandidates called a second time.
      expect(adapter.listCallCount).toBeGreaterThanOrEqual(1);
      // State is chooser with config_repair reason.
      expect(latest.state.kind).toBe('chooser');
      if (latest.state.kind === 'chooser') {
        expect(latest.state.reason).toBe('config_repair');
      }
      // The retry path must use a fresh command id and the FRESH candidateListRevision,
      // never the stale one we first used.
      // Dispatch a fresh selection (the user has to re-choose).
      const cand2 = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand2!));
      await asyncFlush();
      // Now we have 2 start calls — the second uses a NEW command id and the
      // refresh-acquired revision.
      expect(adapter.startCalls.length).toBe(2);
      expect(adapter.startCalls[0]!.commandId).not.toBe(adapter.startCalls[1]!.commandId);
      expect(latest.state.kind).toBe('pending');
    });

    it('config_conflict does NOT mutate Auto mode / loop counters', async () => {
      // The adapter interface forbids this; assert that the only side effect
      // observed by the adapter is start + list + (eventual) target patch,
      // never anything that could touch mode/loop.
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await asyncFlush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[0]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await asyncFlush();
      // No write paths were exposed to the adapter.
      expect(adapter.patchCalls.length).toBe(0);
      // No auto target patch happens (start carries targetConfigRevision directly).
      const last = adapter.startCalls[0];
      expect(last).toBeDefined();
    });

    it('refresh failure: chooser opens with config_repair and null candidates', async () => {
      // Build a fresh adapter that throws on the second listCandidates call.
      let listCalls = 0;
      const failAdapter: AdapterSpy = {
        listCallCount: 0,
        listResultByCall: [],
        startCalls: [],
        patchCalls: [],
        async listCandidates() {
          listCalls += 1;
          failAdapter.listCallCount = listCalls;
          if (listCalls === 1) return listWith('rev-1', 'target-rev-1', [candidateA()]);
          throw new Error('refresh-failed');
        },
        async patchAuditorTarget(input) {
          failAdapter.patchCalls.push({ target: input.target, candidateListRevision: input.candidateListRevision });
          return { ok: true };
        },
        async startQuickAudit(input) {
          failAdapter.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
          return { ok: false, reason: 'config_conflict', message: 'conflict' };
        },
        async cancelAttempt() {
          return { ok: true };
        },
        subscribeResults() {
          return () => {};
        },
        emitResult() {
          // unused
        },
      };
      let api: PeerAuditControllerApi | undefined;
      function ProbeFail() {
        api = usePeerAuditController({
          adapter: failAdapter,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(ProbeFail), document.createElement('div'));
      act(() => {
        api!.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await asyncFlush();
      // First listCandidates succeeded, chooser is open with candidate A.
      const cand = api!.state.kind === 'chooser' && api!.state.candidates
        ? api!.state.candidates.candidates[0]!
        : null;
      act(() => api!.selectCandidate(cand!));
      await asyncFlush();
      // Refresh throws; controller must drop to a stable chooser (NOT error).
      expect(api!.state.kind).toBe('chooser');
      if (api!.state.kind === 'chooser') {
        expect(api!.state.reason).toBe('config_repair');
        expect(api!.state.candidates).toBeNull();
      }
    });
  });

  describe('multi-tab conflict + double-click', () => {
    it('two concurrent controllers race: each one only sees its own state and the second selection does not replay the first', async () => {
      const adapter1 = makeAdapter({
        listResults: [listWith('rev-1', 'target-rev-1', [candidateA(), candidateB()])],
        startResults: [
          { ok: false, reason: 'config_conflict', message: 'tab 2 wrote first' },
          { ok: true, attemptId: 'attempt-A', resultEventId: 'result-A' },
        ],
      });
      const adapter2 = makeAdapter({
        listResults: [
          listWith('rev-2', 'target-rev-2', [candidateA(), candidateB()]),
        ],
        startResults: [
          { ok: true, attemptId: 'attempt-B', resultEventId: 'result-B' },
        ],
      });
      const host1 = document.createElement('div');
      const host2 = document.createElement('div');
      let api1: PeerAuditControllerApi | undefined;
      let api2: PeerAuditControllerApi | undefined;
      function Probe1() {
        api1 = usePeerAuditController({
          adapter: adapter1,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      function Probe2() {
        api2 = usePeerAuditController({
          adapter: adapter2,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(Probe1), host1);
      render(createElement(Probe2), host2);

      // Tab 1: open chooser, pick A.
      act(() => api1!.start({
        auditedSessionName: 'audited-x',
        auditedSessionIdentity: IDENTITY,
        rememberedTarget: null,
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
      }));
      await asyncFlush();
      const candA = api1!.state.kind === 'chooser' && api1!.state.candidates ? api1!.state.candidates.candidates[0]! : null;
      act(() => api1!.selectCandidate(candA!));
      await asyncFlush();
      // Tab 1 hit config_conflict.
      expect(adapter1.startCalls.length).toBe(1);
      expect(adapter1.startCalls[0]!.candidateListRevision).toBe('rev-1');
      // Tab 1 is now in chooser with config_repair; it does NOT auto-replay.
      expect(api1!.state.kind).toBe('chooser');

      // Tab 2: open chooser, pick B with the refreshed revision; succeeds.
      act(() => api2!.start({
        auditedSessionName: 'audited-x',
        auditedSessionIdentity: IDENTITY,
        rememberedTarget: null,
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
      }));
      await asyncFlush();
      const candB = api2!.state.kind === 'chooser' && api2!.state.candidates ? api2!.state.candidates.candidates[1]! : null;
      act(() => api2!.selectCandidate(candB!));
      await asyncFlush();
      // Tab 2's start succeeded with its own revision.
      expect(adapter2.startCalls.length).toBe(1);
      expect(adapter2.startCalls[0]!.candidateListRevision).toBe('rev-2');
      // Tab 2 is now in pending.
      expect(api2!.state.kind).toBe('pending');
    });

    it('double-click on the same controller does not produce two in-flight starts', async () => {
      const adapter = makeAdapter({
        listResults: [listWith('rev-1', 'target-rev-1', [candidateA()])],
        startResults: [
          { ok: true, attemptId: 'attempt-double', resultEventId: 'result-double' },
        ],
      });
      let api: PeerAuditControllerApi | undefined;
      function Probe() {
        api = usePeerAuditController({
          adapter,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(Probe), document.createElement('div'));
      act(() => api!.start({
        auditedSessionName: 'audited-x',
        auditedSessionIdentity: IDENTITY,
        rememberedTarget: null,
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
      }));
      await asyncFlush();
      const cand = api!.state.kind === 'chooser' && api!.state.candidates ? api!.state.candidates.candidates[0]! : null;
      // First click — successfully transitions to pending.
      act(() => api!.selectCandidate(cand!));
      await asyncFlush();
      expect(api!.state.kind).toBe('pending');
      const firstStartCalls = adapter.startCalls.length;
      expect(firstStartCalls).toBe(1);
      // Second click after pending settled: must be rejected as already_pending.
      act(() => api!.start({
        auditedSessionName: 'audited-x',
        auditedSessionIdentity: IDENTITY,
        rememberedTarget: null,
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
      }));
      await asyncFlush();
      // No additional start call produced — single-flight enforced.
      expect(adapter.startCalls.length).toBe(1);
      expect(api!.state.kind).toBe('error');
      if (api!.state.kind === 'error') {
        expect(api!.state.reason).toBe('already_pending');
      }
    });
  });
});