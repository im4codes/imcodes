import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_IDS, DEFAULT_CODEX_AUTOMATION_MODEL } from '../src/shared/models/options.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '../shared/context-model-defaults.js';
import { PEER_AUDIT_PROMPT_VERSION } from '../shared/peer-audit.js';
import {
  DEFAULT_SUPERVISION_BACKEND,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_AUDIT_MODES,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_DEFAULT_PROMPT_VERSION,
  SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
  DEFAULT_SUPERVISION_TIMEOUT_MS,
  SUPERVISION_MIN_TIMEOUT_MS,
  SUPERVISION_MODE,
  SUPERVISION_TRANSPORT_CONFIG_KEY,
  TASK_RUN_STATUS_MARKERS,
  embedSessionSupervisionSnapshot,
  extractSessionSupervisionSnapshot,
  getSessionSupervisionSnapshotIssues,
  hasInvalidSessionSupervisionSnapshot,
  getSupportedSupervisionAuditModes,
  isSupportedSupervisionAuditMode,
  mergeSupervisionCustomInstructions,
  mergeTransportConfigPreservingSupervision,
  normalizeSessionSupervisionSnapshot,
  normalizeSupervisorDefaultConfig,
  parseTaskRunTerminalStateFromText,
  patchPeerAuditTargetInTransportConfig,
  resolveEffectiveCustomInstructions,
} from '../shared/supervision-config.js';

describe('supervision config helpers', () => {
  it('defaults automatic supervision and audit to Codex 5.3 Spark', () => {
    const config = normalizeSupervisorDefaultConfig(null);

    expect(DEFAULT_SUPERVISION_BACKEND).toBe('codex-sdk');
    expect(config.backend).toBe('codex-sdk');
    expect(config.model).toBe(DEFAULT_CODEX_AUTOMATION_MODEL);
  });

  it('uses 30 seconds as both the default and minimum supervision timeout', () => {
    expect(DEFAULT_SUPERVISION_TIMEOUT_MS).toBe(30_000);
    expect(SUPERVISION_MIN_TIMEOUT_MS).toBe(30_000);
  });

  it('normalizes supervisor defaults with backend inference and defaults', () => {
    const config = normalizeSupervisorDefaultConfig({
      model: CODEX_MODEL_IDS[0],
    });

    expect(config.backend).toBe('codex-sdk');
    expect(config.model).toBe(CODEX_MODEL_IDS[0]);
    expect(config.timeoutMs).toBe(DEFAULT_SUPERVISION_TIMEOUT_MS);
    expect(config.promptVersion).toBe(SUPERVISION_DEFAULT_PROMPT_VERSION);
    expect(config.maxAutoContinueStreak).toBe(DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK);
    expect(config.maxAutoContinueTotal).toBe(DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL);
  });

  it('falls back to the backend default model when the model is invalid', () => {
    const config = normalizeSupervisorDefaultConfig({
      backend: 'qwen',
      model: 'not-a-real-model',
      timeoutMs: 15_000,
      promptVersion: 'custom_prompt_v1',
    });

    expect(config.backend).toBe('qwen');
    expect(config.model).toBe('qwen3-coder-plus');
    expect(config.timeoutMs).toBe(SUPERVISION_MIN_TIMEOUT_MS);
    expect(config.promptVersion).toBe('custom_prompt_v1');
  });

  it('upgrades legacy positive timeouts to the 30-second minimum without invalidating the snapshot', () => {
    const transportConfig = {
      supervision: {
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
      },
    };

    expect(hasInvalidSessionSupervisionSnapshot(transportConfig)).toBe(false);
    expect(extractSessionSupervisionSnapshot(transportConfig)?.timeoutMs).toBe(SUPERVISION_MIN_TIMEOUT_MS);
  });

  it('normalizes a peer-audit snapshot and omits the deprecated audit pipeline', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'claude-code-sdk',
      model: DEFAULT_PRIMARY_CONTEXT_MODEL,
      timeoutMs: 8_000,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION_REPAIR,
      customInstructions: '  Prefer tests before complete.  ',
      maxParseRetries: 2,
      auditMode: 'audit>plan',
      auditTargetSessionName: 'deck_sub_auditor1',
      auditTargetFingerprint: {
        sessionInstanceId: 'logical_instance_1',
        normalizedModelId: 'claude-sonnet-4-6',
        providerFamily: 'anthropic',
      },
      maxAuditLoops: 3,
      taskRunPromptVersion: SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS,
    });

    expect(snapshot.mode).toBe(SUPERVISION_MODE.SUPERVISED_AUDIT);
    expect(snapshot.backend).toBe('claude-code-sdk');
    expect(snapshot.model).toBe(DEFAULT_PRIMARY_CONTEXT_MODEL);
    expect(snapshot.timeoutMs).toBe(SUPERVISION_MIN_TIMEOUT_MS);
    expect(snapshot.promptVersion).toBe(SUPERVISION_CONTRACT_IDS.DECISION_REPAIR);
    expect(snapshot.customInstructions).toBe('Prefer tests before complete.');
    expect(snapshot.maxParseRetries).toBe(2);
    expect(snapshot.maxAutoContinueStreak).toBe(DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK);
    expect(snapshot.maxAutoContinueTotal).toBe(DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL);
    expect(snapshot.auditMode).toBeUndefined();
    expect(snapshot.auditTargetSessionName).toBe('deck_sub_auditor1');
    expect(snapshot.auditTargetFingerprint).toEqual({
      sessionInstanceId: 'logical_instance_1',
      normalizedModelId: 'claude-sonnet-4-6',
      providerFamily: 'anthropic',
    });
    expect(snapshot.peerAuditPromptVersion).toBe(PEER_AUDIT_PROMPT_VERSION);
    expect(snapshot.maxAuditLoops).toBe(3);
    expect(snapshot.taskRunPromptVersion).toBe(SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS);
  });

  it('accepts zero auto-continue limits and preserves them in snapshots', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      maxAutoContinueStreak: 0,
      maxAutoContinueTotal: 0,
    });

    expect(snapshot.maxAutoContinueStreak).toBe(0);
    expect(snapshot.maxAutoContinueTotal).toBe(0);
  });

  it('parses sparse persisted snapshots by filling optional tuning defaults', () => {
    const snapshot = extractSessionSupervisionSnapshot({
      supervision: {
        mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
      },
    });

    expect(snapshot).toMatchObject({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: SUPERVISION_MIN_TIMEOUT_MS,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
      maxParseRetries: 1,
      maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
      maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
      maxAuditLoops: 2,
      taskRunPromptVersion: SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
    });
    expect(snapshot?.auditMode).toBeUndefined();
    expect(hasInvalidSessionSupervisionSnapshot({ supervision: {
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: SUPERVISION_MIN_TIMEOUT_MS,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
    } })).toBe(true);
  });

  it('flags invalid persisted supervision snapshots instead of silently activating normalized automation', () => {
    const transportConfig = {
      keep: true,
      supervision: {
        mode: 'not-a-mode',
        backend: 'invalid-backend' as never,
        model: '',
        timeoutMs: -1,
        promptVersion: '',
        customInstructions: { invalid: true },
        maxParseRetries: 0,
        maxAutoContinueStreak: -1,
        maxAutoContinueTotal: -1,
        auditMode: 'not-an-audit-mode' as never,
        maxAuditLoops: 0,
        taskRunPromptVersion: '',
      },
    } as Record<string, unknown>;

    expect(transportConfig.keep).toBe(true);
    const snapshot = extractSessionSupervisionSnapshot(transportConfig);
    expect(snapshot).toBeNull();
    expect(hasInvalidSessionSupervisionSnapshot(transportConfig)).toBe(true);
    expect(transportConfig[SUPERVISION_TRANSPORT_CONFIG_KEY]).toBeDefined();
  });

  describe('peer-audit snapshot migration', () => {
    const base = {
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk' as const,
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
      maxParseRetries: 1,
      maxAuditLoops: 0,
      taskRunPromptVersion: SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
    };

    it('reads an audit-mode-only legacy snapshot but keeps it repair-required', () => {
      const transportConfig = { supervision: { ...base, auditMode: 'audit>review>plan' } };
      const snapshot = extractSessionSupervisionSnapshot(transportConfig);
      expect(snapshot?.auditMode).toBe('audit>review>plan');
      expect(snapshot?.maxAuditLoops).toBe(0);
      expect(snapshot?.auditTargetFingerprint).toBeUndefined();
      expect(hasInvalidSessionSupervisionSnapshot(transportConfig)).toBe(true);
      expect(getSessionSupervisionSnapshotIssues(transportConfig.supervision)).toContain('legacy_audit_mode_requires_repair');
    });

    it('accepts and preserves a name-only audit target', () => {
      const transportConfig = { supervision: { ...base, auditTargetSessionName: 'deck_sub_legacy1' } };
      const snapshot = extractSessionSupervisionSnapshot(transportConfig);
      expect(snapshot?.auditTargetSessionName).toBe('deck_sub_legacy1');
      expect(hasInvalidSessionSupervisionSnapshot(transportConfig)).toBe(false);
      expect(embedSessionSupervisionSnapshot(null, snapshot).supervision).toMatchObject({
        auditTargetSessionName: 'deck_sub_legacy1',
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      });
    });

    it('writes a repaired fingerprint and never emits auditMode', () => {
      const normalized = normalizeSessionSupervisionSnapshot({
        ...base,
        auditMode: 'audit',
        auditTargetSessionName: 'deck_sub_peer2',
        auditTargetFingerprint: {
          sessionInstanceId: 'logical_peer_2',
          normalizedModelId: 'gpt-5.6',
          providerFamily: 'openai',
        },
      });
      expect(normalized).toMatchObject({
        maxAuditLoops: 0,
        auditTargetSessionName: 'deck_sub_peer2',
        auditTargetFingerprint: {
          sessionInstanceId: 'logical_peer_2',
          normalizedModelId: 'gpt-5.6',
          providerFamily: 'openai',
        },
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      });
      expect(normalized).not.toHaveProperty('auditMode');
    });

    it('preserves a confirmed Quick target while mode is off', () => {
      const persisted = embedSessionSupervisionSnapshot(null, {
        mode: SUPERVISION_MODE.OFF,
        auditTargetSessionName: 'deck_sub_peer3',
        auditTargetFingerprint: {
          sessionInstanceId: 'logical_peer_3',
          normalizedModelId: 'claude-opus-4-6',
          providerFamily: 'anthropic',
        },
      });
      expect(extractSessionSupervisionSnapshot(persisted)).toMatchObject({
        mode: SUPERVISION_MODE.OFF,
        auditTargetSessionName: 'deck_sub_peer3',
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      });
    });

    it('drops invalid optional fingerprint metadata without dropping the selected target name', () => {
      const invalid = {
        ...base,
        auditTargetSessionName: 'deck_sub_peer4',
        auditTargetFingerprint: {
          sessionInstanceId: 'not valid!',
          normalizedModelId: 'gpt-5.6',
          providerFamily: 'openai',
        },
      };
      expect(getSessionSupervisionSnapshotIssues(invalid)).not.toContain('invalid_audit_target_fingerprint');
      expect(normalizeSessionSupervisionSnapshot(invalid as never)).toMatchObject({
        auditTargetSessionName: 'deck_sub_peer4',
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      });
      expect(normalizeSessionSupervisionSnapshot(invalid as never)).not.toHaveProperty('auditTargetFingerprint');
    });
  });

  it('exposes the supervision audit-mode allowlist independently from default Team combos', () => {
    expect(getSupportedSupervisionAuditModes()).toEqual(SUPERVISION_AUDIT_MODES);
    expect(isSupportedSupervisionAuditMode('audit')).toBe(true);
    expect(isSupportedSupervisionAuditMode('audit>plan')).toBe(true);
    expect(isSupportedSupervisionAuditMode('brainstorm>discuss>plan')).toBe(false);
  });

  it('accepts exactly one task-run marker and rejects duplicates', () => {
    expect(parseTaskRunTerminalStateFromText(`hello\n${TASK_RUN_STATUS_MARKERS.COMPLETE}`)).toBe('complete');
    expect(parseTaskRunTerminalStateFromText(`${TASK_RUN_STATUS_MARKERS.NEEDS_INPUT}\n${TASK_RUN_STATUS_MARKERS.BLOCKED}`)).toBeNull();
  });

  describe('mergeTransportConfigPreservingSupervision', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'claude-code-sdk',
      model: DEFAULT_PRIMARY_CONTEXT_MODEL,
      timeoutMs: DEFAULT_SUPERVISION_TIMEOUT_MS,
      promptVersion: SUPERVISION_DEFAULT_PROMPT_VERSION,
    });
    const existingWithSupervision = embedSessionSupervisionSnapshot(null, snapshot);

    it('returns existing when the incoming payload is null or undefined', () => {
      expect(mergeTransportConfigPreservingSupervision(null, existingWithSupervision)).toEqual(existingWithSupervision);
      expect(mergeTransportConfigPreservingSupervision(undefined, existingWithSupervision)).toEqual(existingWithSupervision);
      expect(mergeTransportConfigPreservingSupervision(null, null)).toBeNull();
    });

    it('preserves existing supervision when a stale broadcast drops the supervision key', () => {
      // Regression: users reported the Auto dropdown "自动跳回关闭状态" (auto-reverting
      // to off). Cause: naive `incoming ?? existing` let a daemon broadcast with an
      // empty `{}` overwrite the user's freshly-saved supervision before the daemon's
      // authoritative post-PATCH session_list arrived.
      const incoming = {};
      const merged = mergeTransportConfigPreservingSupervision(incoming, existingWithSupervision);
      expect(merged).toMatchObject({
        [SUPERVISION_TRANSPORT_CONFIG_KEY]: snapshot,
      });
    });

    it('preserves existing supervision when incoming has unrelated keys but no supervision', () => {
      const incoming = { someOtherKey: 'value' };
      const merged = mergeTransportConfigPreservingSupervision(incoming, existingWithSupervision);
      expect(merged).toMatchObject({
        someOtherKey: 'value',
        [SUPERVISION_TRANSPORT_CONFIG_KEY]: snapshot,
      });
    });

    it('uses incoming as authoritative when it carries its own supervision key (including explicit off)', () => {
      const incomingWithOffSupervision = embedSessionSupervisionSnapshot(null, { mode: SUPERVISION_MODE.OFF });
      const merged = mergeTransportConfigPreservingSupervision(incomingWithOffSupervision, existingWithSupervision);
      expect(merged).toEqual(incomingWithOffSupervision);
      expect((merged as Record<string, unknown>)[SUPERVISION_TRANSPORT_CONFIG_KEY]).toMatchObject({
        mode: SUPERVISION_MODE.OFF,
      });
    });

    it('returns incoming unchanged when existing has no supervision either', () => {
      const incoming = { someOtherKey: 'value' };
      expect(mergeTransportConfigPreservingSupervision(incoming, null)).toEqual(incoming);
      expect(mergeTransportConfigPreservingSupervision(incoming, {})).toEqual(incoming);
    });
  });

  it('patches only peer-audit target fields over the latest supervision config', () => {
    const latest = embedSessionSupervisionSnapshot({ unrelated: { keep: true } }, {
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      customInstructions: 'keep concurrent instructions',
      maxAuditLoops: 7,
      maxAutoContinueStreak: 4,
    });

    const patched = patchPeerAuditTargetInTransportConfig(latest, {
      auditTargetSessionName: 'deck_sub_peer_target',
      auditTargetFingerprint: {
        sessionInstanceId: 'logical_peer_instance',
        normalizedModelId: 'claude-sonnet-4-6',
        providerFamily: 'anthropic',
      },
    });

    expect(patched.unrelated).toEqual({ keep: true });
    expect(extractSessionSupervisionSnapshot(patched)).toMatchObject({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      customInstructions: 'keep concurrent instructions',
      maxAuditLoops: 7,
      maxAutoContinueStreak: 4,
      auditTargetSessionName: 'deck_sub_peer_target',
      peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
    });
  });

  describe('global custom instructions (supervision-global-custom-instructions)', () => {
    describe('mergeSupervisionCustomInstructions', () => {
      it('returns empty string when both sides are empty and override is false', () => {
        expect(mergeSupervisionCustomInstructions('', '', false)).toBe('');
        expect(mergeSupervisionCustomInstructions(undefined, undefined, undefined)).toBe('');
      });

      it('returns global when session is empty and override is false', () => {
        expect(mergeSupervisionCustomInstructions('global text', '', false)).toBe('global text');
        expect(mergeSupervisionCustomInstructions('global text', '   ', undefined)).toBe('global text');
      });

      it('returns session when global is empty and override is false', () => {
        expect(mergeSupervisionCustomInstructions('', 'session text', false)).toBe('session text');
      });

      it('concatenates with double newline when both non-empty and override is false', () => {
        expect(mergeSupervisionCustomInstructions('A', 'B', false)).toBe('A\n\nB');
        expect(mergeSupervisionCustomInstructions('  line one  ', '  line two  ', undefined))
          .toBe('line one\n\nline two');
      });

      it('returns only the session value when override is true, ignoring global', () => {
        expect(mergeSupervisionCustomInstructions('G', 'S', true)).toBe('S');
        expect(mergeSupervisionCustomInstructions('G', '', true)).toBe('');
      });
    });

    it('round-trips optional global customInstructions on SupervisorDefaultConfig', () => {
      const withString = normalizeSupervisorDefaultConfig({ customInstructions: '  always test  ' });
      expect(withString.customInstructions).toBe('always test');

      const empty = normalizeSupervisorDefaultConfig({ customInstructions: '   ' });
      expect(empty.customInstructions).toBeUndefined();

      const missing = normalizeSupervisorDefaultConfig({});
      expect(missing.customInstructions).toBeUndefined();
    });

    it('normalizes session snapshot override flag (default false, preserves true)', () => {
      const defaulted = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
      });
      expect(defaulted.customInstructionsOverride).toBeUndefined(); // omitted when false

      const override = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        customInstructionsOverride: true,
      });
      expect(override.customInstructionsOverride).toBe(true);
    });

    it('surfaces invalid_custom_instructions_override when the flag is non-boolean', () => {
      const issues = getSessionSupervisionSnapshotIssues({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_DEFAULT_PROMPT_VERSION,
        maxParseRetries: 1,
        // @ts-expect-error intentionally wrong type
        customInstructionsOverride: 'yes',
      });
      expect(issues).toContain('invalid_custom_instructions_override');
    });

    it('surfaces invalid auto-continue limit issues for negative values', () => {
      const issues = getSessionSupervisionSnapshotIssues({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_DEFAULT_PROMPT_VERSION,
        maxParseRetries: 1,
        maxAutoContinueStreak: -1,
        maxAutoContinueTotal: -2,
      });

      expect(issues).toContain('invalid_max_auto_continue_streak');
      expect(issues).toContain('invalid_max_auto_continue_total');
    });

    it('round-trips globalCustomInstructions cache on the session snapshot', () => {
      const snapshot = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        customInstructions: 'session',
        globalCustomInstructions: '  global  ',
      });
      expect(snapshot.globalCustomInstructions).toBe('global');
      expect(snapshot.customInstructions).toBe('session');
    });

    it('qwen preset round-trips through SupervisorDefaultConfig', () => {
      const config = normalizeSupervisorDefaultConfig({
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        preset: 'MiniMax',
      });
      expect(config.preset).toBe('MiniMax');
    });

    it('preset is stripped when backend does not support presets', () => {
      const config = normalizeSupervisorDefaultConfig({
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        // @ts-expect-error intentionally passing preset to a non-preset backend
        preset: 'ShouldBeDropped',
      });
      expect(config.preset).toBeUndefined();
    });

    it('preset-pinned qwen model passes snapshot validation', () => {
      const issues = getSessionSupervisionSnapshotIssues({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'qwen',
        model: 'MiniMax-M2.5',
        preset: 'MiniMax',
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_DEFAULT_PROMPT_VERSION,
        maxParseRetries: 1,
      });
      expect(issues).not.toContain('invalid_model');
    });

    it('unknown qwen model without preset still fails validation', () => {
      const issues = getSessionSupervisionSnapshotIssues({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'qwen',
        model: 'some-unreleased-model',
        timeoutMs: 12_000,
        promptVersion: SUPERVISION_DEFAULT_PROMPT_VERSION,
        maxParseRetries: 1,
      });
      expect(issues).toContain('invalid_model');
    });

    it('resolveEffectiveCustomInstructions reads from the snapshot fields', () => {
      const concat = resolveEffectiveCustomInstructions({
        customInstructions: 'S',
        globalCustomInstructions: 'G',
        customInstructionsOverride: false,
      });
      expect(concat).toBe('G\n\nS');

      const overridden = resolveEffectiveCustomInstructions({
        customInstructions: 'S',
        globalCustomInstructions: 'G',
        customInstructionsOverride: true,
      });
      expect(overridden).toBe('S');

      expect(resolveEffectiveCustomInstructions(null)).toBe('');
      expect(resolveEffectiveCustomInstructions({})).toBe('');
    });
  });
});
