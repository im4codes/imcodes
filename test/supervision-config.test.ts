import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_CHANGE_PROPORTIONALITY,
  SUPERVISION_GATE_ENFORCEMENT,
  SUPERVISION_MODE,
  supervisionTaskAuditPolicyFromSnapshot,
} from '../shared/supervision-config.js';
import { PROVIDER_ERROR_CODES } from '../src/agent/transport-provider.js';
import { CODEX_MODEL_IDS, DEFAULT_CODEX_AUTOMATION_MODEL } from '../src/shared/models/options.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '../shared/context-model-defaults.js';
import { PEER_AUDIT_PROMPT_VERSION } from '../shared/peer-audit.js';
import {
  DEFAULT_SUPERVISION_BACKEND,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_AUDIT_MODES,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_CONTRACTS_IN_FORCE_REFERENCE,
  evaluateAutomaticSupervisionEnablement,
  SUPERVISION_DEFAULT_PROMPT_VERSION,
  SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
  DEFAULT_SUPERVISION_TIMEOUT_MS,
  SUPERVISION_MIN_TIMEOUT_MS,
  SUPERVISION_MODE,
  SUPERVISION_EXECUTION_STATUS_MARKERS,
  SUPERVISION_TRANSPORT_CONFIG_KEY,
  TASK_RUN_STATUS_MARKERS,
  embedSessionSupervisionSnapshot,
  extractSessionSupervisionSnapshot,
  getSessionSupervisionSnapshotIssues,
  hasInvalidSessionSupervisionSnapshot,
  getSupportedSupervisionAuditModes,
  isSupportedSupervisionAuditMode,
  isAutomaticSupervisionEnabled,
  mergeSupervisionCustomInstructions,
  mergeTransportConfigPreservingSupervision,
  normalizeSessionSupervisionSnapshot,
  normalizeSupervisionUiLocale,
  normalizeSupervisorDefaultConfig,
  parseSupervisionExecutionStateDetailsFromText,
  parseSupervisionExecutionStateFromText,
  parseTaskRunTerminalStateFromText,
  patchPeerAuditTargetInTransportConfig,
  projectSharedSessionSupervisionMode,
  resolveEffectiveCustomInstructions,
  SUPERVISION_UNAVAILABLE_REASONS,
  SUPERVISION_PAUSE_CATEGORIES,
  SUPERVISION_RECOVERABLE_CONTINUATION_CONDITIONS,
  classifySupervisionContinuationFailure,
  classifySupervisionInterruption,
} from '../shared/supervision-config.js';

describe('supervision config helpers', () => {
  it('projects only a validated supervision mode across shared-tab boundaries', () => {
    const privateConfig = {
      provider: { token: 'must-not-leak' },
      supervision: {
        mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
        prompt: 'must-not-leak',
        customInstructions: 'must-not-leak',
        identity: { sessionName: 'must-not-leak' },
      },
    };

    expect(projectSharedSessionSupervisionMode(privateConfig))
      .toBe(SUPERVISION_MODE.SUPERVISED_AUDIT);
    expect(projectSharedSessionSupervisionMode(JSON.stringify(privateConfig)))
      .toBe(SUPERVISION_MODE.SUPERVISED_AUDIT);
    expect(projectSharedSessionSupervisionMode({ supervision: { mode: 'forged' } })).toBeNull();
    expect(projectSharedSessionSupervisionMode('{broken')).toBeNull();
    expect(projectSharedSessionSupervisionMode(null)).toBeNull();
  });

  it('registers the canonical Brain work-delegation contract in every standing reference', () => {
    expect(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION)
      .toBe('supervision_brain_work_delegation_v1');
    expect(SUPERVISION_CONTRACTS_IN_FORCE_REFERENCE)
      .toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
  });

  it('uses one fail-closed authority for automatic supervision mode', () => {
    expect(isAutomaticSupervisionEnabled(null)).toBe(false);
    expect(isAutomaticSupervisionEnabled(undefined)).toBe(false);
    expect(isAutomaticSupervisionEnabled(SUPERVISION_MODE.OFF)).toBe(false);
    expect(isAutomaticSupervisionEnabled({ mode: SUPERVISION_MODE.OFF })).toBe(false);
    expect(isAutomaticSupervisionEnabled(SUPERVISION_MODE.SUPERVISED)).toBe(true);
    expect(isAutomaticSupervisionEnabled({ mode: SUPERVISION_MODE.SUPERVISED_AUDIT })).toBe(true);
  });
  it('accepts only the seven supported UI locales for supervision output', () => {
    expect(normalizeSupervisionUiLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeSupervisionUiLocale(' ja ')).toBe('ja');
    expect(normalizeSupervisionUiLocale('en-US')).toBeUndefined();

    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      uiLocale: 'zh-TW',
    });
    expect(snapshot.uiLocale).toBe('zh-TW');
    expect(getSessionSupervisionSnapshotIssues({ ...snapshot, uiLocale: 'fr' })).toContain('invalid_ui_locale');
  });

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

  it('normalizes an optional backup runtime with the same preset rules as memory processing', () => {
    const config = normalizeSupervisorDefaultConfig({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      backupBackend: 'qwen',
      backupModel: 'MiniMax-M2.7',
      backupPreset: 'minimax2.7',
    });

    expect(config).toMatchObject({
      backupBackend: 'qwen',
      backupModel: 'MiniMax-M2.7',
      backupPreset: 'minimax2.7',
    });
    expect(normalizeSupervisorDefaultConfig({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      backupBackend: 'codex-sdk',
      backupModel: CODEX_MODEL_IDS[0],
      backupPreset: 'ignored',
    }).backupPreset).toBeUndefined();
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

  it('accepts targetless automatic audit only with a canonical explicit live pool route', () => {
    const base = {
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk',
      model: 'gpt-5.6-sol',
      timeoutMs: SUPERVISION_MIN_TIMEOUT_MS,
      promptVersion: SUPERVISION_CONTRACT_IDS.DECISION,
      maxParseRetries: 1,
      maxAutoContinueStreak: 2,
      maxAutoContinueTotal: 0,
      maxAuditLoops: 2,
      taskRunPromptVersion: SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
    } as const;
    const livePool = {
      state: 'configured',
      primaryDevelopmentPool: {
        configs: [{
          capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
          agentType: 'codex-sdk',
          providerFamily: 'openai',
          runtimeType: 'transport',
          model: 'gpt-5.6-sol',
        }],
        controls: {},
      },
      economyTaskPool: { configs: [], controls: {} },
    } as const;

    expect(hasInvalidSessionSupervisionSnapshot({ supervision: { ...base, executionPools: livePool } })).toBe(false);
    expect(getSessionSupervisionSnapshotIssues({ ...base, executionPools: livePool })).not.toContain('missing_audit_target');

    const malformedPool = {
      ...livePool,
      primaryDevelopmentPool: { configs: [{}], controls: {} },
    };
    expect(hasInvalidSessionSupervisionSnapshot({ supervision: { ...base, executionPools: malformedPool } })).toBe(true);
    expect(getSessionSupervisionSnapshotIssues({ ...base, executionPools: malformedPool })).toContain('missing_audit_target');

    // Targetless snapshots written before pool routing remain readable for the
    // legacy repair flow, but they are not valid automatic-audit writes.
    expect(extractSessionSupervisionSnapshot({ supervision: base })).not.toBeNull();
    expect(hasInvalidSessionSupervisionSnapshot({ supervision: base })).toBe(true);
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

  it('accepts exactly one fully-prefixed execution marker and ignores bare status words', () => {
    expect(parseSupervisionExecutionStateFromText(
      `still working\n${SUPERVISION_EXECUTION_STATUS_MARKERS.ADVANCE}`,
    )).toBe('advance');
    expect(parseSupervisionExecutionStateFromText(SUPERVISION_EXECUTION_STATUS_MARKERS.AUDIT_READY)).toBe('audit_ready');
    expect(parseSupervisionExecutionStateFromText(SUPERVISION_EXECUTION_STATUS_MARKERS.NEEDS_INPUT)).toBe('needs_input');
    expect(parseSupervisionExecutionStateFromText(SUPERVISION_EXECUTION_STATUS_MARKERS.WAITING)).toBe('waiting');

    for (const text of ['ADVANCE', 'AUDIT_READY', 'NEEDS_INPUT', 'WAITING', '<!-- IMCODES_TASK_RUN: ADVANCE -->']) {
      expect(parseSupervisionExecutionStateFromText(text)).toBeNull();
    }
  });

  it('selects the last assistant-authored execution marker exactly once', () => {
    expect(parseSupervisionExecutionStateDetailsFromText(
      `${SUPERVISION_EXECUTION_STATUS_MARKERS.ADVANCE}\n${SUPERVISION_EXECUTION_STATUS_MARKERS.AUDIT_READY}`,
    )).toEqual({ state: 'audit_ready', markerCount: 2 });
  });

  it('does not require the marker to be the final bytes of assistant content', () => {
    const marker = SUPERVISION_EXECUTION_STATUS_MARKERS.AUDIT_READY;
    expect(parseSupervisionExecutionStateDetailsFromText(`${marker}\nmore text`))
      .toEqual({ state: 'audit_ready', markerCount: 1 });
    expect(parseSupervisionExecutionStateDetailsFromText(
      `${marker}\n已授权派发：1\n执行于: deck_sub_reviewer · claude-opus-5 · primary`,
    )).toEqual({ state: 'audit_ready', markerCount: 1 });
    expect(parseSupervisionExecutionStateFromText(`done\n  ${marker}\n`)).toBe('audit_ready');
  });

  it('ignores quoted and fenced marker examples before selecting the last authored marker', () => {
    const advance = SUPERVISION_EXECUTION_STATUS_MARKERS.ADVANCE;
    const ready = SUPERVISION_EXECUTION_STATUS_MARKERS.AUDIT_READY;
    expect(parseSupervisionExecutionStateDetailsFromText([
      `> ${advance}`,
      '```md',
      ready,
      '```',
      `The prompt said \`${advance}\`.`,
      ready,
    ].join('\n'))).toEqual({ state: 'audit_ready', markerCount: 1 });
    expect(parseSupervisionExecutionStateDetailsFromText(`> ${advance}\n\`\`\`\n${ready}\n\`\`\``))
      .toEqual({ state: null, markerCount: 0 });
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

describe('supervision gate scope and change proportionality', () => {
  it('binds gates only under supervision and treats them as advice when it is off', () => {
    // A gate that blocks a human working by hand is an obstacle, not quality
    // control; a gate that stops binding under automation is useless. Both ends
    // are asserted so neither can drift alone.
    expect(SUPERVISION_GATE_ENFORCEMENT.bindingModes).toContain(SUPERVISION_MODE.SUPERVISED);
    expect(SUPERVISION_GATE_ENFORCEMENT.bindingModes).toContain(SUPERVISION_MODE.SUPERVISED_AUDIT);
    expect(SUPERVISION_GATE_ENFORCEMENT.advisoryModes).toContain(SUPERVISION_MODE.OFF);
    expect(SUPERVISION_GATE_ENFORCEMENT.bindingModes).not.toContain(SUPERVISION_MODE.OFF);
    // Advisory still leaves a trace, but the daemon derives it: asking the user
    // who they are, to waive a gate, would bill them for what the runtime knows.
    expect(SUPERVISION_GATE_ENFORCEMENT.advisoryBehaviour).toBe('warn_once_then_proceed');
    expect(SUPERVISION_GATE_ENFORCEMENT.identityFromRuntimeCaller).toBe(true);
    expect(SUPERVISION_GATE_ENFORCEMENT.neverPromptUserForWaiverDetails).toBe(true);
  });

  it('lets documentation skip audit while any behaviour change is always audited', () => {
    expect(SUPERVISION_CHANGE_PROPORTIONALITY.docOnlySkipsAuditEvenWhenSupervised).toBe(true);
    expect(SUPERVISION_CHANGE_PROPORTIONALITY.docOnlyShapes).toContain('no_executable_line_changed');
    // The floor: this must stay true no matter how small the change looks.
    expect(SUPERVISION_CHANGE_PROPORTIONALITY.functionalChangeAlwaysAudited).toBe(true);
    // ...and the trivial tier can never be reached by a production-byte change.
    expect(SUPERVISION_CHANGE_PROPORTIONALITY.trivialRequiresAll).toContain('no_production_byte_change');
  });
});

describe('automatic supervision enablement gate', () => {
  function snapshot(mode: string, pools: unknown) {
    return { mode, executionPools: pools, uiLocale: 'zh-CN' } as never;
  }
  const configured = {
    state: 'configured',
    primaryDevelopmentPool: {
      configs: [{
        agentType: 'codex-sdk',
        providerFamily: 'openai',
        runtimeType: 'transport',
        model: 'gpt-5.6-sol',
      }],
      controls: {},
    },
    economyTaskPool: { configs: [], controls: {} },
  };

  it('lets a non-automatic mode through untouched', () => {
    // Turning supervision OFF must never be blocked by pool configuration.
    expect(evaluateAutomaticSupervisionEnablement(snapshot('off', {})).ok).toBe(true);
  });

  it('refuses to enable automatic supervision on unconfigured pools', () => {
    for (const mode of ['supervised', 'supervised_audit']) {
      const gate = evaluateAutomaticSupervisionEnablement(snapshot(mode, {}));
      expect(gate.ok).toBe(false);
      expect(gate.ok === false && gate.reason).toBeTruthy();
      // The refusal must carry actionable operator guidance, localized.
      expect(gate.ok === false && gate.guidance.length).toBeGreaterThan(0);
    }
  });

  it('admits automatic supervision once a pool is genuinely selected', () => {
    for (const mode of ['supervised', 'supervised_audit']) {
      expect(evaluateAutomaticSupervisionEnablement(snapshot(mode, configured)).ok).toBe(true);
    }
  });

  it('localizes the refusal to the snapshot ui locale', () => {
    const zh = evaluateAutomaticSupervisionEnablement(snapshot('supervised', {}));
    const en = evaluateAutomaticSupervisionEnablement(
      { mode: 'supervised', executionPools: {}, uiLocale: 'en' } as never,
    );
    expect(zh.ok).toBe(false);
    expect(en.ok).toBe(false);
    expect(zh.ok === false && en.ok === false && zh.guidance === en.guidance).toBe(false);
  });
});

describe('supervision interruption classification', () => {
  // The heartbeat is the Brain main session's only way to keep supervising a
  // task whose work lives in child sessions. A transient supervisor-side
  // failure must therefore never end the run: only a condition a human must
  // personally clear may pause it.
  const resumes: Array<[string, Parameters<typeof classifySupervisionInterruption>[0]]> = [
    ['an ordinary supervisor decision timeout', { unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT }],
    ['a queue/capacity timeout', { unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT }],
    ['an unparseable supervisor decision', { unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT }],
    ['a disconnected supervisor provider', { unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_NOT_CONNECTED }],
    ['a transient provider error', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailureCode: PROVIDER_ERROR_CODES.CONNECTION_LOST,
    }],
    // A rate limit is a throttle with a reset, not exhausted quota. The
    // requirement pauses only on quota that is *explicitly* exhausted, so this
    // has to come back through the durable heartbeat rather than stop.
    ['a rate-limited provider', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailureCode: PROVIDER_ERROR_CODES.RATE_LIMITED,
    }],
  ];

  for (const [label, input] of resumes) {
    it(`resumes supervision after ${label}`, () => {
      expect(classifySupervisionInterruption(input)).toEqual({ kind: 'resume' });
    });
  }

  const pauses: Array<[string, Parameters<typeof classifySupervisionInterruption>[0], string]> = [
    ['credentials that must be re-authorized', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailureCode: PROVIDER_ERROR_CODES.AUTH_FAILED,
    }, SUPERVISION_PAUSE_CATEGORIES.REAUTHORIZATION_REQUIRED],
    ['a supervisor config the human must repair', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailureCode: PROVIDER_ERROR_CODES.CONFIG_ERROR,
    }, SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED],
    ['a missing supervisor provider', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailureCode: PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND,
    }, SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED],
    ['an invalid supervision snapshot', {
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT,
    }, SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED],
    // No machine reason at all means the supervisor itself decided a human is
    // needed; that is the explicit human-input request.
    ['a bare ask_human with no machine reason', {}, SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED],
  ];

  for (const [label, input, category] of pauses) {
    it(`pauses supervision for ${label}`, () => {
      expect(classifySupervisionInterruption(input)).toEqual({ kind: 'pause', category });
    });
  }

  it('only ever admits the four sanctioned pause categories', () => {
    // Guards against a future reason quietly inventing a fifth way to stop.
    expect(Object.values(SUPERVISION_PAUSE_CATEGORIES).sort()).toEqual([
      'brain_only_authority',
      'human_input_requested',
      'quota_exhausted',
      'reauthorization_required',
    ]);
    for (const reason of Object.values(SUPERVISION_UNAVAILABLE_REASONS)) {
      const outcome = classifySupervisionInterruption({ unavailableReason: reason });
      if (outcome.kind === 'pause') {
        expect(Object.values(SUPERVISION_PAUSE_CATEGORIES)).toContain(outcome.category);
      }
    }
  });
});

describe('supervision continuation repair (repair_then_resume)', () => {
  // A delegated task whose continuation trips a recoverable control-plane
  // fault must be REPAIRED and RESUMED, never abandoned. Stopping here is how
  // a task silently dies while its child sessions are still holding work.
  const recoverable = Object.values(SUPERVISION_RECOVERABLE_CONTINUATION_CONDITIONS);

  for (const condition of recoverable) {
    it(`resumes after the recoverable control-plane condition ${condition}`, () => {
      expect(classifySupervisionContinuationFailure({ condition }))
        .toEqual({ kind: 'resume' });
    });
  }

  it('names exactly the five user-specified recoverable conditions', () => {
    expect([...recoverable].sort()).toEqual([
      'ambiguous_assignment_worktree',
      'identity_rejected_after_runtime_change',
      'old_runtime_identity',
      'role_continuation_routing_gap',
      'stale_lease_or_pointer',
    ]);
  });

  it('never resumes a cross-project or cross-user takeover, however recoverable it looks', () => {
    // Repair authority stops at the project boundary. Every recoverable
    // condition must still refuse when the work belongs to someone else.
    for (const condition of recoverable) {
      expect(classifySupervisionContinuationFailure({ condition, crossProject: true }))
        .toEqual({
          kind: 'pause',
          category: SUPERVISION_PAUSE_CATEGORIES.BRAIN_ONLY_AUTHORITY,
        });
    }
  });

  it('pauses conservatively on an unrecognized condition rather than inventing a repair', () => {
    expect(classifySupervisionContinuationFailure({ condition: 'something_new' }))
      .toEqual({
        kind: 'pause',
        category: SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED,
      });
    expect(classifySupervisionContinuationFailure({}))
      .toEqual({
        kind: 'pause',
        category: SUPERVISION_PAUSE_CATEGORIES.HUMAN_INPUT_REQUESTED,
      });
  });

  it('reuses the existing pause vocabulary instead of a parallel enum', () => {
    const outcome = classifySupervisionContinuationFailure({ condition: 'nope', crossProject: true });
    expect(outcome.kind).toBe('pause');
    if (outcome.kind === 'pause') {
      expect(Object.values(SUPERVISION_PAUSE_CATEGORIES)).toContain(outcome.category);
    }
  });
});

describe('automatic audit policy source (tsk_5ny)', () => {
  // The policy may come ONLY from the authoritative session supervision mode
  // captured when the task is created. Brain role, contract presence, provider,
  // model, prior config and defaults are all non-authoritative: inferring a
  // policy from any of them silently hands an auditor to a task that never
  // opted in, and "no policy" is a durable fact rather than a gap to repair.
  it('derives the task audit policy from the authoritative mode and nothing else', () => {
    expect(supervisionTaskAuditPolicyFromSnapshot({ mode: SUPERVISION_MODE.SUPERVISED_AUDIT }))
      .toBe('auto_allow_degraded');

    for (const mode of Object.values(SUPERVISION_MODE)) {
      if (mode === SUPERVISION_MODE.SUPERVISED_AUDIT) continue;
      expect(
        supervisionTaskAuditPolicyFromSnapshot({ mode }),
        `${mode} must not carry an automatic audit policy`,
      ).toBeUndefined();
    }

    // Exhaustive over the mode enum, so a mode added later cannot quietly
    // default into an automatic policy without this test being updated.
    const enabling = Object.values(SUPERVISION_MODE)
      .filter((mode) => supervisionTaskAuditPolicyFromSnapshot({ mode }) !== undefined);
    expect(enabling).toEqual([SUPERVISION_MODE.SUPERVISED_AUDIT]);

    // The mere existence of a snapshot is not evidence of opt-in, and an
    // absent snapshot fails closed rather than falling back to a default.
    expect(supervisionTaskAuditPolicyFromSnapshot(null)).toBeUndefined();
    expect(supervisionTaskAuditPolicyFromSnapshot(undefined)).toBeUndefined();
  });
});
