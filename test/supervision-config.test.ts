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
  hasInvalidSessionSupervisionSnapshot,
  getSupportedSupervisionAuditModes,
  isSupportedSupervisionAuditMode,
  normalizeSessionSupervisionSnapshot,
  normalizeSupervisorDefaultConfig,
  parseAuditVerdictFromText,
  parseTaskRunTerminalStateFromText,
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
});
