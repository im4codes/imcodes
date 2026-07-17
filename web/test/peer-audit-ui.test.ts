/**
 * Focused tests for the Peer Audit UI slice.
 *
 * Coverage:
 * - Identity gating: refuse to start without authoritative sessionInstanceId
 *   + runtimeEpoch (no name fallback).
 * - Locale parity across 7 locales for peerAuditQuick.* + peerAuditResult.*.
 * - Single-flight + already_pending.
 * - Target-only CAS (patchAuditorTarget adapter invoked, no other fields).
 * - Real candidateListRevision (taken from list_candidates response.revision)
 *   is passed to startQuickAudit — never derived from candidate fields.
 * - Result de-dup (same attemptId fires once).
 * - Cancel pending + reported cancelled result.
 * - Consent flow opens before dispatch on remembered different-model target.
 * - Same-model remembered target opens chooser with same_model_remembered.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createElement } from 'preact';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import { usePeerAuditController } from '../src/peerAudit/usePeerAuditController.js';
import { createWsPeerAuditAdapter } from '../src/peerAudit/wsAdapter.js';
import { PeerAuditAuditorChooser } from '../src/peerAudit/PeerAuditAuditorChooser.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';
import type { PeerAuditAdapter, PeerAuditControllerApi, PeerAuditAuditedSessionIdentity } from '../src/peerAudit/types.js';

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
  startCalls: Array<{ commandId: string; candidateListRevision: string; targetConfigRevision: string }>;
  patchCalls: Array<{ target: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string }; candidateListRevision: string }>;
  cancelCalls: Array<{ attemptId: string }>;
  resultListener: ((event: { kind: 'result'; attemptId: string; verdict: string; auditorLabel: string; elapsedMs: number }) => void) | null;
  emitResult: (attemptId: string, verdict?: 'PASS' | 'REWORK' | 'cancelled' | 'timeout' | 'unavailable') => void;
}

function makeAdapter(): AdapterSpy {
  const spy: AdapterSpy = {
    startCalls: [],
    patchCalls: [],
    cancelCalls: [],
    resultListener: null,
    async listCandidates(input) {
      if (!input.auditedSessionIdentity.sessionInstanceId || !input.auditedSessionIdentity.runtimeEpoch) {
        throw new Error('identity_missing');
      }
      return {
        revision: 'rev-authoritative-42',
        targetConfigRevision: 'target-config-revision-42',
        auditedSessionName: input.auditedSessionName,
        auditedSessionInstanceId: input.auditedSessionIdentity.sessionInstanceId,
        candidates: [
          {
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
          },
          {
            name: 'peer-b',
            label: 'Peer B (process)',
            sessionInstanceId: 'peer-b-instance',
            runtimeEpoch: 'peer-b-epoch-1',
            normalizedModelId: 'gpt-4',
            providerFamily: 'openai',
            liveState: 'idle',
            dispositionCapability: 'sent_unrevocable',
            eligible: true,
            reason: 'eligible',
          },
        ],
      };
    },
    async patchAuditorTarget(input) {
      spy.patchCalls.push({ target: input.target, candidateListRevision: input.candidateListRevision });
      return { ok: true };
    },
    async startQuickAudit(input) {
      spy.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
      const attemptId = `att-${spy.startCalls.length}`;
      return { ok: true, attemptId, resultEventId: `result-${attemptId}` };
    },
    async cancelAttempt(input) {
      spy.cancelCalls.push({ attemptId: input.attemptId });
      return { ok: true };
    },
    subscribeResults(input) {
      spy.resultListener = input.onResult as unknown as AdapterSpy['resultListener'];
      return () => {
        spy.resultListener = null;
      };
    },
    emitResult(attemptId: string, verdict = 'PASS') {
      if (!spy.resultListener) return;
      spy.resultListener({
        kind: 'result',
        attemptId,
        verdict,
        auditorLabel: 'Peer A',
        elapsedMs: 1500,
      });
    },
  };
  return spy;
}

const locales: Record<string, Record<string, unknown>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  es,
  ru,
  ja,
  ko,
};

describe('Peer Audit UI slice', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('locale parity', () => {
    const REQUIRED_KEYS = [
      'peerAuditQuick.iconLabel',
      'peerAuditQuick.tooltip',
      'peerAuditQuick.chooserTitle',
      'peerAuditQuick.consentTitle',
      'peerAuditQuick.consentBody',
      'peerAuditQuick.consentConfirm',
      'peerAuditQuick.selectionWillPersist',
      'peerAuditQuick.noCandidate',
      'peerAuditQuick.ineligibleCollapsed',
      'peerAuditQuick.chooserReason.missing_target',
      'peerAuditQuick.chooserReason.self_target',
      'peerAuditQuick.chooserReason.stale_target',
      'peerAuditQuick.chooserReason.same_model_remembered',
      'peerAuditQuick.chooserReason.unknown_model_remembered',
      'peerAuditQuick.chooserReason.no_candidate',
      'peerAuditQuick.chooserReason.model_changed_since_click',
      'peerAuditQuick.chooserReason.config_repair',
      'peerAuditQuick.not_direct_child',
      'peerAuditQuick.unknown_identity',
      'peerAuditQuick.disposition.sent',
      'peerAuditQuick.disposition.queued',
      'peerAuditQuick.disposition.sent_unrevocable',
      'peerAuditQuick.pending_preparing',
      'peerAuditQuick.pending_sent',
      'peerAuditQuick.pending_queued',
      'peerAuditQuick.pending_sent_unrevocable',
      'peerAuditQuick.pending_waiting_reply',
      'peerAuditQuick.pending',
      'peerAuditQuick.result_pass',
      'peerAuditQuick.result_rework',
      'peerAuditQuick.result_timeout',
      'peerAuditQuick.result_unavailable',
      'peerAuditQuick.result_cancelled',
      'peerAuditQuick.result_error',
      'peerAuditQuick.acknowledge',
      'peerAuditQuick.cancel_pending',
      'peerAuditQuick.providerBadge',
      'peerAuditResult.title',
      'peerAuditResult.attributionAuditor',
      'peerAuditResult.elapsedMs',
      'peerAuditResult.findingsPreview',
    ];

    for (const [name, dict] of Object.entries(locales)) {
      it(`locale ${name} contains every required peerAuditQuick/peerAuditResult key`, () => {
        for (const key of REQUIRED_KEYS) {
          const value = resolveKey(dict, key);
          expect(typeof value === 'string' && value.length > 0, `${name}:${key}`).toBe(true);
        }
      });
    }

    it('does not introduce new peerAuditQuick top-level keys outside the v1 set', () => {
      const top = Object.keys(en.peerAuditQuick as Record<string, unknown>);
      const EXPECTED = [
        'iconLabel', 'tooltip', 'chooserTitle', 'consentTitle', 'consentBody',
        'consentConfirm', 'selectionWillPersist', 'noCandidate', 'ineligibleCollapsed', 'providerBadge',
        'chooserReason', 'self_target', 'not_direct_child', 'cross_project', 'execution_clone',
        'not_reply_capable', 'wrong_state', 'disposition',
        'unknown_identity',
        'pending', 'pending_preparing', 'pending_sent', 'pending_queued',
        'pending_sent_unrevocable', 'pending_waiting_reply',
        'result_pass', 'result_rework', 'result_timeout',
        'result_unavailable', 'result_cancelled', 'result_error',
        'acknowledge', 'cancel_pending',
      ];
      for (const key of top) {
        expect(EXPECTED).toContain(key);
      }
    });
  });

  describe('typed WebSocket adapter', () => {
    it('ignores wrong response type/id and settles only the exact correlated candidate reply', async () => {
      const listeners = new Set<(message: ServerMessage) => void>();
      const sent: Array<Record<string, unknown>> = [];
      const ws = {
        send(message: Record<string, unknown>) { sent.push(message); },
        onMessage(listener: (message: ServerMessage) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as WsClient;
      const adapter = createWsPeerAuditAdapter(ws);
      let settled = false;
      const pending = adapter.listCandidates({
        auditedSessionName: 'audited-x',
        auditedSessionIdentity: IDENTITY,
      }).then((value) => {
        settled = true;
        return value;
      });
      const commandId = String(sent[0]!.commandId);
      const validList = {
        revision: 'revision_123',
        targetConfigRevision: 'target_revision_123',
        auditedSessionName: 'audited-x',
        auditedSessionInstanceId: IDENTITY.sessionInstanceId,
        candidates: [],
      };
      for (const listener of listeners) {
        listener({ type: 'peer_audit.quick_result', commandId, ok: true } as unknown as ServerMessage);
        listener({ type: 'peer_audit.candidates', commandId: 'wrong_command_123', ok: true, list: validList } as unknown as ServerMessage);
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      for (const listener of listeners) {
        listener({ type: 'peer_audit.candidates', commandId, ok: true, list: validList } as unknown as ServerMessage);
      }
      await expect(pending).resolves.toMatchObject({ revision: 'revision_123' });
    });
  });

  describe('auditor chooser rendering', () => {
    it('shows exact model/provider/state and process unrevocable limitation', () => {
      const adapter = makeAdapter();
      const candidateList = {
        revision: 'revision_123',
        targetConfigRevision: 'target_revision_123',
        auditedSessionName: 'audited-x',
        auditedSessionInstanceId: IDENTITY.sessionInstanceId,
        candidates: [{
          name: 'deck_sub_process',
          label: 'Process Peer',
          sessionInstanceId: 'process_instance',
          runtimeEpoch: 'process_epoch',
          normalizedModelId: 'claude-opus',
          providerFamily: 'anthropic',
          liveState: 'idle',
          dispositionCapability: 'sent_unrevocable' as const,
          eligible: true,
          reason: 'eligible' as const,
        }],
      };
      const api: PeerAuditControllerApi = {
        state: { kind: 'chooser', reason: 'missing_target', candidates: candidateList },
        start: vi.fn(), confirmConsent: vi.fn(), cancelConsent: vi.fn(), selectCandidate: vi.fn(),
        cancelChooser: vi.fn(), acknowledgeResult: vi.fn(), cancelPending: vi.fn(),
      };
      const { getByTestId } = render(createElement(PeerAuditAuditorChooser, { api, onClose: vi.fn() }));
      const row = getByTestId('peer-audit-chooser-row');
      expect(row.textContent).toContain('claude-opus');
      expect(row.textContent).toContain('idle');
      expect(row.textContent).toContain('peerAuditQuick.disposition.sent_unrevocable');
    });

    it('shows model/provider and the future automatic-target side effect in consent', () => {
      const api: PeerAuditControllerApi = {
        state: {
          kind: 'consent',
          providerFamily: 'anthropic',
          normalizedModelId: 'claude-opus',
          auditorLabel: 'Peer CC',
        },
        start: vi.fn(), confirmConsent: vi.fn(), cancelConsent: vi.fn(), selectCandidate: vi.fn(),
        cancelChooser: vi.fn(), acknowledgeResult: vi.fn(), cancelPending: vi.fn(),
      };
      const { getByTestId, getByText } = render(createElement(PeerAuditAuditorChooser, { api, onClose: vi.fn() }));
      expect(getByTestId('peer-audit-consent-identity').textContent).toContain('claude-opus · anthropic');
      expect(getByText('peerAuditQuick.selectionWillPersist')).toBeDefined();
    });
  });

  describe('identity gating', () => {
    it('refuses to start when auditedSessionIdentity is null', () => {
      let latest: PeerAuditControllerApi | undefined;
      const adapter = makeAdapter();
      function Probe() {
        latest = usePeerAuditController({
          adapter,
          auditedSessionIdentity: null,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(Probe), document.createElement('div'));
      expect(latest!.state.kind).toBe('idle');
      act(() => {
        latest!.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: null as unknown as PeerAuditAuditedSessionIdentity,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      expect(latest!.state.kind).toBe('error');
      if (latest!.state.kind === 'error') {
        expect(latest!.state.reason).toBe('identity_missing');
      }
      expect(adapter.startCalls.length).toBe(0);
    });

    it('accepts authoritative identity and proceeds through chooser', async () => {
      let latest: PeerAuditControllerApi | undefined;
      const adapter = makeAdapter();
      function Probe() {
        latest = usePeerAuditController({
          adapter,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => false,
        });
        return null;
      }
      render(createElement(Probe), document.createElement('div'));
      act(() => {
        latest!.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      expect(latest!.state.kind).toBe('chooser');
    });
  });

  describe('controller state machine', () => {
    let adapter: AdapterSpy;
    let latest: PeerAuditControllerApi;

    function Probe() {
      latest = usePeerAuditController({
        adapter,
        auditedSessionIdentity: IDENTITY,
        auditedSessionName: 'audited-x',
        auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        rememberedTarget: null,
        hasUserConsentedTo: () => false,
      });
      return null;
    }

    beforeEach(() => {
      adapter = makeAdapter();
      render(createElement(Probe), document.createElement('div'));
    });

    it('passes the real candidateListRevision (not candidate fields) to startQuickAudit', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      expect(latest.state.kind).toBe('chooser');
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(adapter.startCalls.length).toBe(1);
      // The revision must come from list.revision, NOT from any candidate
      // field. This guards the "use actual candidateRevision, not
      // candidate.sessionInstanceId" requirement.
      expect(adapter.startCalls[0]!.candidateListRevision).toBe('rev-authoritative-42');
      expect(adapter.startCalls[0]!.targetConfigRevision).toBe('target-config-revision-42');
      expect(adapter.startCalls[0]!.candidateListRevision).not.toBe(cand!.sessionInstanceId);
      expect(adapter.startCalls[0]!.candidateListRevision).not.toBe(cand!.runtimeEpoch);
    });

    it('refreshes candidates and returns to the chooser on a daemon revision mismatch', async () => {
      const originalList = adapter.listCandidates.bind(adapter);
      adapter.listCandidates = vi.fn(originalList);
      adapter.startQuickAudit = async (input) => {
        adapter.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
        return { ok: false, reason: 'candidate_refresh_required', message: 'candidate_refresh_required' };
      };

      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const candidate = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(candidate!));
      await flush();

      expect(adapter.listCandidates).toHaveBeenCalledTimes(2);
      expect(latest.state.kind).toBe('chooser');
      if (latest.state.kind === 'chooser') expect(latest.state.reason).toBe('config_repair');
    });

    it('uses globally unique command ids even when starts occur in the same millisecond', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      const first = makeAdapter();
      const second = makeAdapter();
      let firstApi: PeerAuditControllerApi | undefined;
      let secondApi: PeerAuditControllerApi | undefined;
      function Pair() {
        firstApi = usePeerAuditController({
          adapter: first,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        secondApi = usePeerAuditController({
          adapter: second,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: null,
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(Pair), document.createElement('div'));
      act(() => {
        for (const api of [firstApi!, secondApi!]) api.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      act(() => {
        firstApi!.selectCandidate((firstApi!.state as Extract<typeof firstApi.state, { kind: 'chooser' }>).candidates!.candidates[1]!);
        secondApi!.selectCandidate((secondApi!.state as Extract<typeof secondApi.state, { kind: 'chooser' }>).candidates!.candidates[1]!);
      });
      await flush();
      expect(first.startCalls[0]!.commandId).not.toBe(second.startCalls[0]!.commandId);
      vi.mocked(Date.now).mockRestore();
    });

  it('persists the selected target atomically in quick_start without a second Web patch', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(adapter.startCalls.length).toBe(1);
      expect(adapter.startCalls[0]!.candidateListRevision).toBe('rev-authoritative-42');
      expect(adapter.patchCalls.length).toBe(0);
    });

  it('target-only CAS does not mutate supervision mode or loop fields in Web', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const target = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(target!));
      await flush();
      expect(adapter.patchCalls).toHaveLength(0);
      expect(adapter.startCalls).toHaveLength(1);
    });

    it('rejects second start() while pending with already_pending', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(latest.state.kind).toBe('pending');
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      expect(latest.state.kind).toBe('error');
      if (latest.state.kind === 'error') {
        expect(latest.state.reason).toBe('already_pending');
      }
    });

    it('deduplicates result events with the same attemptId', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(latest.state.kind).toBe('pending');
      const pendingAttemptId = latest.state.kind === 'pending' ? latest.state.attemptId : '';
      const resultEventId = latest.state.kind === 'pending' ? latest.state.resultEventId : '';
      act(() => adapter.emitResult(resultEventId));
      act(() => adapter.emitResult(resultEventId));
      expect(latest.state.kind).toBe('result');
      if (latest.state.kind === 'result') {
        expect(latest.state.attemptId).toBe(pendingAttemptId);
        expect(latest.state.verdict).toBe('PASS');
      }
    });

    it('ignores replayed or unrelated result events while idle and pending', async () => {
      act(() => adapter.emitResult('result-old-attempt'));
      expect(latest.state.kind).toBe('idle');
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(latest.state.kind).toBe('pending');
      act(() => adapter.emitResult('result-another-attempt'));
      expect(latest.state.kind).toBe('pending');
    });

    it('buffers an exact terminal result that arrives before the start acknowledgement', async () => {
      let resolveStart!: (value: { ok: true; attemptId: string; resultEventId: string }) => void;
      adapter.startQuickAudit = async (input) => {
        adapter.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
        return new Promise((resolve) => { resolveStart = resolve; });
      };
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      expect(latest.state.kind).toBe('starting');
      act(() => adapter.emitResult('result-att-early'));
      expect(latest.state.kind).toBe('starting');
      act(() => resolveStart({ ok: true, attemptId: 'att-early', resultEventId: 'result-att-early' }));
      await flush();
      expect(latest.state.kind).toBe('result');
      if (latest.state.kind === 'result') expect(latest.state.attemptId).toBe('att-early');
    });

    it('cancels with the authoritative attempt id when cancel is clicked before the start acknowledgement', async () => {
      let resolveStart!: (value: { ok: true; attemptId: string; resultEventId: string }) => void;
      adapter.startQuickAudit = async (input) => {
        adapter.startCalls.push({ commandId: input.commandId, candidateListRevision: input.candidateListRevision, targetConfigRevision: input.targetConfigRevision });
        return new Promise((resolve) => { resolveStart = resolve; });
      };
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      expect(latest.state.kind).toBe('starting');
      act(() => latest.cancelPending());
      expect(latest.state.kind).toBe('starting');
      act(() => resolveStart({ ok: true, attemptId: 'att-cancelled-early', resultEventId: 'result-att-cancelled-early' }));
      await flush();
      expect(adapter.cancelCalls).toEqual([{ attemptId: 'att-cancelled-early' }]);
      expect(latest.state.kind).toBe('pending');
      act(() => adapter.emitResult('result-att-cancelled-early', 'cancelled'));
      expect(latest.state.kind).toBe('result');
    });

    it('cancels pending attempt and reports cancelled result', async () => {
      act(() => {
        latest.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: null,
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      const cand = latest.state.kind === 'chooser' && latest.state.candidates
        ? latest.state.candidates.candidates[1]!
        : null;
      act(() => latest.selectCandidate(cand!));
      await flush();
      expect(latest.state.kind).toBe('pending');
      act(() => latest.cancelPending());
      await flush();
      expect(adapter.cancelCalls.length).toBe(1);
      expect(latest.state.kind).toBe('pending');
      act(() => adapter.emitResult('result-att-1', 'cancelled'));
      expect(latest.state.kind).toBe('result');
      if (latest.state.kind === 'result') {
        expect(latest.state.verdict).toBe('cancelled');
      }
    });

  it('consent flow: remembered different-provider target opens consent before dispatching', async () => {
      const consentingHost = document.createElement('div');
      let consentingApi: PeerAuditControllerApi | undefined;
      function ProbeConsent() {
        consentingApi = usePeerAuditController({
          adapter,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
          rememberedTarget: {
            sessionName: 'peer-a',
            sessionInstanceId: 'peer-a-instance',
            runtimeEpoch: 'peer-a-epoch-1',
            normalizedModelId: 'claude-opus-4-7',
            providerFamily: 'anthropic',
            fingerprint: 'fingerprint-x',
          },
          hasUserConsentedTo: () => false,
        });
        return null;
      }
      render(createElement(ProbeConsent), consentingHost);
      act(() => {
        consentingApi!.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: {
            sessionName: 'peer-a',
            sessionInstanceId: 'peer-a-instance',
            runtimeEpoch: 'peer-a-epoch-1',
            normalizedModelId: 'claude-opus-4-7',
            providerFamily: 'anthropic',
            fingerprint: 'fingerprint-x',
          },
          auditedModel: { normalizedModelId: 'gpt-4', providerFamily: 'openai' },
        });
      });
      await flush();
      expect(consentingApi!.state.kind).toBe('consent');
      expect(adapter.startCalls.length).toBe(0);
    });

    it('same-model remembered target opens chooser with same_model_remembered reason', async () => {
      const host2 = document.createElement('div');
      let api: PeerAuditControllerApi | undefined;
      function ProbeSame() {
        api = usePeerAuditController({
          adapter,
          auditedSessionIdentity: IDENTITY,
          auditedSessionName: 'audited-x',
          auditedModel: { normalizedModelId: 'claude-opus-4-7', providerFamily: 'anthropic' },
          rememberedTarget: {
            sessionName: 'peer-same',
            sessionInstanceId: 'peer-same-instance',
            runtimeEpoch: 'peer-same-epoch-1',
            normalizedModelId: 'claude-opus-4-7',
            providerFamily: 'anthropic',
            fingerprint: 'fingerprint-y',
          },
          hasUserConsentedTo: () => true,
        });
        return null;
      }
      render(createElement(ProbeSame), host2);
      act(() => {
        api!.start({
          auditedSessionName: 'audited-x',
          auditedSessionIdentity: IDENTITY,
          rememberedTarget: {
            sessionName: 'peer-same',
            sessionInstanceId: 'peer-same-instance',
            runtimeEpoch: 'peer-same-epoch-1',
            normalizedModelId: 'claude-opus-4-7',
            providerFamily: 'anthropic',
            fingerprint: 'fingerprint-y',
          },
          auditedModel: { normalizedModelId: 'claude-opus-4-7', providerFamily: 'anthropic' },
        });
      });
      await flush();
      expect(api!.state.kind).toBe('chooser');
      if (api!.state.kind === 'chooser') {
        expect(api!.state.reason).toBe('same_model_remembered');
      }
    });
  });
});

function resolveKey(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
