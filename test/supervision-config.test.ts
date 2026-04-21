import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '../shared/context-model-defaults.js';
import {
  AUDIT_VERDICT_MARKERS,
  DEFAULT_SUPERVISION_BACKEND,
  SUPERVISION_AUDIT_MODES,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_DEFAULT_AUDIT_MODE,
  SUPERVISION_DEFAULT_PROMPT_VERSION,
  SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
  DEFAULT_SUPERVISION_TIMEOUT_MS,
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
  parseAuditVerdictFromText,
  parseTaskRunTerminalStateFromText,
  resolveEffectiveCustomInstructions,
} from '../shared/supervision-config.js';

describe('supervision config helpers', () => {
  it('uses 12 seconds as the default supervision timeout (design.md §5)', () => {
    expect(DEFAULT_SUPERVISION_TIMEOUT_MS).toBe(12_000);
  });

  it('normalizes supervisor defaults with backend inference and defaults', () => {
    const config = normalizeSupervisorDefaultConfig({
      model: CODEX_MODEL_IDS[0],
    });

    expect(config.backend).toBe('codex-sdk');
    expect(config.model).toBe(CODEX_MODEL_IDS[0]);
    expect(config.timeoutMs).toBe(DEFAULT_SUPERVISION_TIMEOUT_MS);
    expect(config.promptVersion).toBe(SUPERVISION_DEFAULT_PROMPT_VERSION);
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
    expect(config.timeoutMs).toBe(15_000);
    expect(config.promptVersion).toBe('custom_prompt_v1');
  });

  it('normalizes a heavy-mode session snapshot with audit defaults', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'claude-code-sdk',
      model: DEFAULT_PRIMARY_CONTEXT_MODEL,
      timeoutMs: 8_000,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION_REPAIR,
      customInstructions: '  Prefer tests before complete.  ',
      maxParseRetries: 2,
      auditMode: 'audit>plan',
      maxAuditLoops: 3,
      taskRunPromptVersion: SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS,
    });

    expect(snapshot.mode).toBe(SUPERVISION_MODE.SUPERVISED_AUDIT);
    expect(snapshot.backend).toBe('claude-code-sdk');
    expect(snapshot.model).toBe(DEFAULT_PRIMARY_CONTEXT_MODEL);
    expect(snapshot.timeoutMs).toBe(8_000);
    expect(snapshot.promptVersion).toBe(SUPERVISION_CONTRACT_IDS.DECISION_REPAIR);
    expect(snapshot.customInstructions).toBe('Prefer tests before complete.');
    expect(snapshot.maxParseRetries).toBe(2);
    expect(snapshot.auditMode).toBe('audit>plan');
    expect(snapshot.maxAuditLoops).toBe(3);
    expect(snapshot.taskRunPromptVersion).toBe(SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS);
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

  it('exposes the audit-mode allowlist from built-in combos', () => {
    expect(getSupportedSupervisionAuditModes()).toEqual(SUPERVISION_AUDIT_MODES);
    expect(isSupportedSupervisionAuditMode('audit')).toBe(true);
    expect(isSupportedSupervisionAuditMode('audit>plan')).toBe(true);
    expect(isSupportedSupervisionAuditMode('brainstorm>discuss>plan')).toBe(false);
  });

  it('accepts exactly one task-run or verdict marker and rejects duplicates', () => {
    expect(parseTaskRunTerminalStateFromText(`hello\n${TASK_RUN_STATUS_MARKERS.COMPLETE}`)).toBe('complete');
    expect(parseTaskRunTerminalStateFromText(`${TASK_RUN_STATUS_MARKERS.NEEDS_INPUT}\n${TASK_RUN_STATUS_MARKERS.BLOCKED}`)).toBeNull();
    expect(parseAuditVerdictFromText(`before\n${AUDIT_VERDICT_MARKERS.PASS}`)).toBe('PASS');
    expect(parseAuditVerdictFromText(`${AUDIT_VERDICT_MARKERS.PASS}\n${AUDIT_VERDICT_MARKERS.REWORK}`)).toBeNull();
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
