import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderContextPayload,
  dispatchSharedContextSend,
  MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE,
} from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import type { TransportMemoryRecallArtifact } from '../../shared/context-types.js';
import { CAPABILITY_AI_SYSTEM_INSTRUCTIONS } from '../../shared/capability-management.js';
import { MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS } from '../../shared/mcp-tool-discovery.js';
import { TRANSPORT_SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import { SUPERVISION_CONTRACT_IDS } from '../../shared/supervision-config.js';
import { REAL_DEVICE_TESTING_SYSTEM_GUIDANCE } from '../../shared/transport-runtime-prompts.js';
import { VERIFICATION_MACHINE_MCP_TOOLS } from '../../shared/verification-machine.js';
import { ALIAS_MCP_TOOLS } from '../../shared/alias-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { AUDIT_CONVERGENCE_CONTRACT_ID } from '../../shared/audit-convergence.js';
import { TASK_PAIR_CONTRACT_ID } from '../../shared/task-pair.js';
import { buildFileOutputContract } from '../../shared/file-output-contract.js';
import { CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../shared/cron-types.js';
import { buildBrainWorkDelegationContractRef } from '../../src/daemon/supervision-prompts.js';
import {
  SESSION_IDENTITY_PROJECT_MAX_CHARS as ID_PROJECT_MAX,
  SESSION_IDENTITY_SESSION_MAX_CHARS as ID_SESSION_MAX,
  SESSION_IDENTITY_USER_MAX_CHARS as ID_USER_MAX,
  renderSessionIdentityProfiles as renderIdentityProfilesForAssembly,
} from '../../shared/session-identity.js';
import { compileAgentContextArtifact as compileArtifactForIdentity } from '../../src/agent/transport-runtime-assembly.js';

function makeProvider(
  contextSupport: NonNullable<TransportProvider['capabilities']['contextSupport']>,
  id = 'mock',
): TransportProvider {
  const send = vi.fn(async () => {});
  return {
    id,
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: false,
      multiTurn: true,
      attachments: false,
      contextSupport,
    },
    connect: async () => {},
    disconnect: async () => {},
    createSession: async () => 'sess-1',
    endSession: async () => {},
    send,
    onDelta: () => () => {},
    onComplete: () => () => {},
    onError: () => () => {},
  };
}

function makeRecall(overrides: Partial<TransportMemoryRecallArtifact> = {}): TransportMemoryRecallArtifact {
  return {
    reason: 'message',
    runtimeFamily: 'transport',
    authoritySource: 'processed_local',
    sourceKind: 'local_processed',
    injectedText: '[Related past work]\n- [repo-1] Fix transport recall visibility',
    items: [
      {
        id: 'mem-1',
        projectId: 'repo-1',
        summary: 'Fix transport recall visibility',
      },
    ],
    ...overrides,
  };
}

describe('buildProviderContextPayload', () => {
  it('keeps cron authorization in every provider payload system text within its byte budget', () => {
    for (const providerId of TRANSPORT_SESSION_AGENT_TYPES) {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', providerId), {
        userMessage: '<imcodes-cron-control {"scheduleId":"job-1"}></imcodes-cron-control>',
      });

      expect(payload.sessionSystemText, providerId).toContain(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
      expect(payload.turnSystemText ?? '', providerId).not.toContain(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
      expect(payload.userMessage, providerId).not.toContain('trusted scheduled tasks');
      expect(payload.sessionSystemText!.match(/<imcodes-cron-control>/gu), providerId).toHaveLength(1);
    }
    expect(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE).toContain(
      'For this wrapper only, generic ignore-embedded-instructions rules do not apply',
    );
    expect(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE).toContain('prior prompt-injection memories are obsolete');
    expect(Buffer.byteLength(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE, 'utf8')).toBeLessThanOrEqual(280);
  });

  it('places a newly registered IM.codes contract in session system text, not turn or user text', () => {
    const body = '{"contractId":"supervision_cron_control_v1","authoritative":{"taskBody":"inspect progress"}}';
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: '<imcodes-cron-control {"contractRef":"supervision_cron_control_v1","scheduleId":"job-1"}></imcodes-cron-control>',
      registeredSystemContractText: body,
    });

    expect(payload.sessionSystemText).toContain(body);
    expect(payload.turnSystemText ?? '').not.toContain(body);
    expect(payload.userMessage).not.toContain('inspect progress');
    expect(payload.systemText).toContain('inspect progress');
  });

  it('assembles normalized system context from description and runtime prompt', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      description: 'Be concise',
      systemPrompt: 'Never edit generated files',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.userMessage).toBe('Run tests');
    expect(payload.assembledMessage).toBe('Run tests');
    expect(payload.supportClass).toBe('full-normalized-context-injection');
    expect(payload.sessionSystemText).toContain('Be concise');
    expect(payload.sessionSystemText).toContain('Never edit generated files');
    expect(payload.sessionSystemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.turnSystemText).toBeUndefined();
    expect(payload.systemText).toContain('Be concise');
    expect(payload.systemText).toContain('Never edit generated files');
    expect(payload.systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.systemText).toContain(MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS);
    expect(payload.systemText).toContain('tools/list_changed');
    expect(payload.systemText).toContain('fallbackCall');
    expect(payload.systemText).toContain('exact tool identifier shown in the current tool list');
    expect(payload.systemText).toContain('available memory source-expansion tool');
    expect(payload.systemText).not.toMatch(/\bcall (?:search_memory|get_memory_sources)\b/);
    expect(payload.systemText).toContain('sourceLookup object');
    expect(payload.systemText).toContain('Keep work updates short and high-signal');
    expect(payload.systemText).toContain('at least every 5 minutes or every 15 tool calls');
    expect(payload.systemText).toContain('"contractId":"file_output_v1"');
    expect(payload.systemText).toContain('[display name](/absolute/full/path)');
  });

  it('keeps the synchronized identity contract intact in stable session system text', () => {
    const identityPrompt = '<imcodes-agent-identity>\n<user>account rule</user>\n<project>project rule</project>\n<session>session rule</session>\n</imcodes-agent-identity>';
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      identityPrompt,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.sessionSystemText).toContain(identityPrompt);
    expect(payload.turnSystemText).toBeUndefined();
    expect(payload.userMessage).not.toContain(identityPrompt);
  });

  // A Brain's delegation duty does not depend on supervision being enabled, and
  // it must survive restart/resume and compaction. Field incident: the contract
  // last appeared far earlier in the rollout, was never re-injected after
  // compaction, and the session carried no supervision binding at all -- so the
  // Brain fell back to provider-native collaboration with no IM authority.
  // IM.codes authority belongs to sessionSystemText. Once the full contract body has been
  // registered for the thread, later turns must re-assert it BY REFERENCE
  // (contractRefs + binding + delta) rather than resending the ~830-char body.
  // `contractId` vs `contractRef` is the mechanical distinction the prompt
  // module already uses: carrying the contract vs referencing it.
  it('registers the full Brain contract once, then re-asserts it by reference', () => {
    const build = (brainContractRegistered: boolean) => buildProviderContextPayload(
      makeProvider('compact-contract-reassertion'),
      {
        userMessage: 'assign these to sub-windows',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        brainContractRegistered,
      },
    );

    const firstPayload = build(false);
    const first = firstPayload.sessionSystemText ?? '';
    expect(first, 'the first turn must register the full contract body').toContain('"contractId"');
    expect(first).toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
    expect(firstPayload.turnSystemText ?? '').not.toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);

    const laterPayload = build(true);
    const later = laterPayload.sessionSystemText ?? '';
    expect(later, 'the later turn must still bind the contract by reference')
      .toContain(buildBrainWorkDelegationContractRef(false));
    expect(later).toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
    expect(laterPayload.turnSystemText ?? '').not.toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
    expect(
      later.length,
      'the compact re-assertion must be materially smaller than the body',
    ).toBeLessThan(first.length);
  });

  it('does not re-assert any contract for a non-Brain session', () => {
    const payload = buildProviderContextPayload(
      makeProvider('compact-contract-non-brain'),
      {
        userMessage: 'do the work',
        sessionIdentity: { sessionName: 'deck_proj_w1', label: 'W1', role: 'w1' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        brainContractRegistered: true,
      },
    );
    const text = payload.sessionSystemText ?? '';
    expect(text).not.toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
  });

  // The mode dimension, now REAL. The matrix this replaces iterated a mode
  // variable it never passed into the assembly (and one of its three values,
  // 'manual', is not even a supervision mode), so it proved only the role gate
  // and would have passed for any mode at all.
  //
  // `automaticSupervisionEnabled` is the per-turn answer of the single mode
  // authority, isAutomaticSupervisionEnabled(session supervision snapshot).
  // Field incident behind the split: a supervision-OFF Brain on a daily cron
  // received the full supervised-delegation contract every turn, so it minted a
  // supervision task, drove recovery/rebind loops and dispatched its own audit
  // for a morning report nobody asked to supervise.
  const brainSystemText = (input: { automaticSupervisionEnabled?: boolean; brainContractRegistered?: boolean }) => (
    buildProviderContextPayload(
      makeProvider('full-normalized-context-injection'),
      {
        userMessage: 'assign these to sub-windows',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        ...input,
      },
    ).sessionSystemText ?? ''
  );

  const AUTOMATIC_SUPERVISION_MARKERS = [
    'task_assignment',
    'coordinate_not_implement',
    'blockedRecoveryDuty',
    'authorityDuty',
  ] as const;

  // Absent is the fail-closed case: a runtime whose mode cannot be established
  // must never be told to run supervision automatically.
  for (const [label, automaticSupervisionEnabled] of [['off', false], ['absent', undefined]] as const) {
    it(`gives a supervision-${label} Brain the manual-only contract and none of the automatic task route`, () => {
      for (const turn of [1, 2]) {
        const text = brainSystemText({ automaticSupervisionEnabled });
        // The per-turn baseline itself survives: the compaction fix stands.
        expect(text, `turn ${turn} must still carry the delegation contract`)
          .toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
        expect(text).toContain('"automaticSupervision":false');
        // Supervised work is arranged by hand, never on the Brain's own initiative.
        expect(text).toContain('explicit_user_request');
        // The routing constraint the baseline exists for is preserved: when a
        // Brain does delegate task work, it delegates through IM.codes. Native
        // agents remain available for read-only analysis, never as participants.
        expect(text).toContain('provider_native_task_participation');
        expect(text).toContain('ephemeral_read_only_analysis');
        for (const automatic of AUTOMATIC_SUPERVISION_MARKERS) {
          expect(text, `${automatic} must not reach a supervision-${label} Brain`).not.toContain(automatic);
        }
      }
    });
  }

  it('keeps the full supervised-delegation contract for a Brain with automatic supervision enabled', () => {
    const text = brainSystemText({ automaticSupervisionEnabled: true });
    expect(text).toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
    expect(text).toContain('"automaticSupervision":true');
    for (const automatic of AUTOMATIC_SUPERVISION_MARKERS) {
      expect(text, `${automatic} is part of the automatic contract`).toContain(automatic);
    }
  });

  it('makes every re-assertion name its variant, so an off reference can never stand in for the on body', () => {
    const offRef = brainSystemText({ automaticSupervisionEnabled: false, brainContractRegistered: true });
    const onRef = brainSystemText({ automaticSupervisionEnabled: true, brainContractRegistered: true });
    expect(offRef).toContain(buildBrainWorkDelegationContractRef(false));
    expect(onRef).toContain(buildBrainWorkDelegationContractRef(true));
    expect(offRef).toContain('"automaticSupervision":false');
    expect(offRef, 'an off reference must not name the supervised carrier').not.toContain('"fullText"');
    expect(onRef).toContain('"fullText":"supervisionDecision"');
    expect(onRef).not.toContain('"automaticSupervision":false');
  });

  // Delegation authority never drags the audit lifecycle in with it, in either
  // variant. The audit lifecycle lives in the supervision broker's decision and
  // continuation channel, which is already mode-conditional; audit contracts
  // must not be duplicated into turn-scoped authored context.
  for (const automaticSupervisionEnabled of [false, true, undefined]) {
    it(`keeps the baseline layer audit-free (automaticSupervisionEnabled=${String(automaticSupervisionEnabled)})`, () => {
      const text = brainSystemText({ automaticSupervisionEnabled });
      expect(text).toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
      expect(text).not.toContain(SUPERVISION_CONTRACT_IDS.TASK_FINALIZATION);
      expect(text).not.toContain(SUPERVISION_CONTRACT_IDS.CONTEXTUAL_AUDIT);
    });
  }

  it('never injects Brain delegation authority into a non-Brain session', () => {
    // Control: proves the assertion above is about the ROLE, not about every
    // session getting the contract.
    const payload = buildProviderContextPayload(
      makeProvider('full-normalized-context-injection'),
      {
        userMessage: 'do the work',
        sessionIdentity: { sessionName: 'deck_proj_w1', label: 'W1', role: 'w1' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      },
    );
    expect(payload.sessionSystemText ?? '').not.toContain(SUPERVISION_CONTRACT_IDS.BRAIN_WORK_DELEGATION);
  });

  // Any session can be an auditor, an implementer or an orchestrator, and audit
  // messages only reference the convergence contract by id. So the body must be
  // registered in the stable system prompt of every managed session -- once per
  // thread, never resent through the per-turn channel or the user message.
  it('registers the task-pair marker contract in the stable system prompt of every managed provider', () => {
    const body = `[Contract: ${TASK_PAIR_CONTRACT_ID}]`;
    for (const providerId of TRANSPORT_SESSION_AGENT_TYPES.filter((id) => id !== 'openclaw')) {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', providerId), {
        userMessage: 'work on the task',
        sessionIdentity: { sessionName: 'deck_proj_w1', label: 'W1', role: 'w1' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      expect(payload.sessionSystemText, providerId).toContain(body);
      expect(payload.userMessage, providerId).not.toContain(body);
    }
  });

  it('registers the audit convergence contract in the stable system prompt of every managed provider', () => {
    const body = `"contractId":"${AUDIT_CONVERGENCE_CONTRACT_ID}"`;
    const structuredEvidencePolicy = 'default-accept exact-bound implementer structured test results';
    const rawArtifactPolicy = 'raw logs, transcripts, hashes, and bundle attachments are never PASS prerequisites';
    const providerIds = TRANSPORT_SESSION_AGENT_TYPES.filter((providerId) => providerId !== 'openclaw');
    for (const providerId of providerIds) {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', providerId), {
        userMessage: 'review the change',
        sessionIdentity: { sessionName: 'deck_proj_w1', label: 'W1', role: 'w1' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      expect(payload.sessionSystemText, providerId).toContain(body);
      expect(payload.sessionSystemText, providerId).toContain(structuredEvidencePolicy);
      expect(payload.sessionSystemText, providerId).toContain(rawArtifactPolicy);
      expect(payload.sessionSystemText, providerId).not.toContain('"missing":"P1"');
      expect(payload.turnSystemText ?? '', providerId).not.toContain(body);
      expect(payload.userMessage, providerId).not.toContain(body);
    }
    const slashControl = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: '/compact',
      suppressMcpMemorySearchGuidance: true,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });
    expect(slashControl.sessionSystemText ?? '').not.toContain(body);
  });

  // Field complaint: long tasks ran for many minutes with no user-visible word.
  // The old guidance only said "sparse, key boundaries only" and set no ceiling.
  it('bounds how long a session may work without a user-visible progress update', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'run the full regression and deploy',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });
    const text = payload.sessionSystemText ?? '';
    expect(text).toContain('at least every 5 minutes or every 15 tool calls');
    expect(text).toContain('Never work longer than that with no user-visible update');
    expect(text).toContain('never turn a status into a long report');
    expect(text).toContain('Before any step likely to take more than about 2 minutes');
    expect(text).not.toContain('At key boundaries only');
  });

  it('adds shared system guidance for every managed SDK provider id', () => {
    const providerIds = TRANSPORT_SESSION_AGENT_TYPES.filter((providerId) => providerId !== 'openclaw');

    for (const providerId of providerIds) {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', providerId), {
        userMessage: 'What did we decide about memory recall last week?',
        namespace: { scope: 'personal', projectId: 'repo-1' },
        identityPrompt: '<imcodes-agent-identity>cross-sdk identity sentinel</imcodes-agent-identity>',
      });

      expect(payload.systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
      expect(payload.systemText).toContain('treat its tools as authoritative');
      expect(payload.systemText).toContain('prefer them over provider-native or improvised alternatives when relevant');
      expect(payload.systemText).toContain('Do not call memory for bare control messages');
      expect(payload.systemText).toContain('exact tool identifier shown in the current tool list');
      expect(payload.systemText).toContain('available memory source-expansion tool with the returned fields');
      expect(payload.systemText).not.toMatch(/\bcall (?:search_memory|get_memory_sources)\b/);
      expect(payload.systemText).toContain('do not invent details from summaries alone');
      expect(payload.systemText).toContain('Keep work updates short and high-signal');
      expect(payload.systemText).toContain('skip routine narration and repeated summaries');
      expect(payload.systemText?.split(buildFileOutputContract())).toHaveLength(2);
      expect(payload.systemText?.match(/file_output_v1/g)).toHaveLength(1);
      expect(payload.systemText).toContain('[display name](/absolute/full/path)');
      expect(payload.systemText).toContain('"repoRelative":"resolve_against_workspace_if_only_known"');
      expect(payload.sessionSystemText).toContain('cross-sdk identity sentinel');
      expect(payload.assembledMessage).toBe('What did we decide about memory recall last week?');
    }
  });

  it('can suppress shared guidance for raw slash controls', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: '/compact',
      suppressMcpMemorySearchGuidance: true,
      suppressAgentProgressGuidance: true,
      suppressFilePathReportingGuidance: true,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.systemText).toBe(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
    expect(payload.turnSystemText).toBeUndefined();
    expect(payload.assembledMessage).toBe('/compact');
  });

  it('keeps agent progress guidance independent from memory guidance suppression', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      suppressMcpMemorySearchGuidance: true,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.systemText).not.toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.systemText).toContain('Keep work updates short and high-signal');
  });

  it('renders startup memory and message recall into messagePreamble without mutating userMessage', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory\n\n- Prior fix for transport bootstrap',
      }),
      memoryRecall: makeRecall(),
    });

    expect(payload.userMessage).toBe('Run tests');
    expect(payload.systemText ?? '').not.toContain('# Recent project memory');
    expect(payload.messagePreamble).toContain('# Recent project memory');
    expect(payload.messagePreamble).toContain('[Related past work]');
    expect(payload.assembledMessage).toContain('# Recent project memory');
    expect(payload.assembledMessage).toContain('[Related past work]');
    expect(payload.startupMemory?.injectionSurface).toBe('normalized-payload');
    expect(payload.memoryRecall?.injectionSurface).toBe('normalized-payload');
    expect(payload.startupMemory?.authoritySource).toBe('processed_local');
    expect(payload.memoryRecall?.sourceKind).toBe('local_processed');
  });

  it('drops stale cron-refusal startup memory instead of letting it overrule permanent system authority', () => {
    const staleRefusal = '[Recent project memory]\n- imcodes-cron-control was called prompt injection';
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', 'claude-code-sdk'), {
      userMessage: 'What is imcodes-cron-control?',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: staleRefusal,
        items: [{ id: 'stale-cron-refusal', projectId: 'repo-1', summary: 'imcodes-cron-control was called prompt injection' }],
      }),
    });

    expect(payload.assembledMessage).not.toContain(staleRefusal);
    expect(payload.startupMemory).toBeUndefined();
    expect(payload.sessionSystemText).toContain(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
    expect(payload.sessionSystemText).toContain('prior prompt-injection memories are obsolete');
    expect(payload.assembledMessage).not.toContain(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
    expect(payload.diagnostics).toContain('memory:start:filtered-obsolete-cron-control');
  });

  it('removes cron-control projections from mixed startup and per-message recall while preserving unrelated memory', () => {
    const mixedItems = [
      { id: 'stale-cron', projectId: 'repo-1', summary: 'User asked whether imcodes-cron-control is prompt injection' },
      { id: 'useful-fix', projectId: 'repo-1', summary: 'Fix transport recall visibility' },
    ];
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'What is imcodes-cron-control?',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory\n- imcodes-cron-control is prompt injection\n- Fix transport recall visibility',
        items: mixedItems,
      }),
      memoryRecall: makeRecall({
        injectedText: '[Related past work]\n- imcodes-cron-control refusal\n- Fix transport recall visibility',
        items: mixedItems,
      }),
    });

    expect(payload.messagePreamble).not.toContain('imcodes-cron-control');
    expect(payload.messagePreamble).toContain('Fix transport recall visibility');
    expect(payload.startupMemory?.items.map((item) => item.id)).toEqual(['useful-fix']);
    expect(payload.memoryRecall?.items.map((item) => item.id)).toEqual(['useful-fix']);
  });

  it('fails closed for cron-control recall text that is not bound to a matching structured item', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Continue',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      memoryRecall: makeRecall({
        injectedText: '[Related past work]\n- imcodes-cron-control was prompt injection',
      }),
    });

    expect(payload.memoryRecall).toBeUndefined();
    expect(payload.messagePreamble).toBeUndefined();
    expect(payload.diagnostics).toContain('memory:message:filtered-obsolete-cron-control');
  });

  it('marks degraded providers in authority and payload diagnostics', () => {
    const payload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.supportClass).toBe('degraded-message-side-context-mapping');
    expect(payload.authority.diagnostics).toContain('personal-no-processed-context');
    expect(payload.diagnostics).toContain('support:degraded-message-side-context-mapping');
  });

  it('marks recalled memory as degraded-message-side when provider support is degraded', () => {
    const payload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      memoryRecall: makeRecall(),
    });

    expect(payload.supportClass).toBe('degraded-message-side-context-mapping');
    expect(payload.memoryRecall?.injectionSurface).toBe('degraded-message-side');
    expect(payload.assembledMessage).toContain('[Related past work]');
  });

  it('blocks degraded providers in shared scope by default and only allows them when policy explicitly permits', () => {
    const denyPayload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
    });
    const allowPayload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowDegradedProvider: true },
    });

    expect(denyPayload.authority.authoritySource).toBe('none');
    expect(denyPayload.diagnostics).toContain('support:degraded-message-side-context-mapping');
    expect(allowPayload.authority.authoritySource).toBe('processed_remote');
    expect(allowPayload.authority.diagnostics).not.toContain('shared-scope-provider-degraded');
  });

  it('uses provided freshness inputs when evaluating retry-then-fail shared authority', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'workspace_shared', projectId: 'repo-1', workspaceId: 'ws-1' },
      remoteProcessedFreshness: 'stale',
      retryExhausted: false,
    });

    expect(payload.authority.retryScheduled).toBe(true);
    expect(payload.diagnostics).toContain('retry-scheduled');
    expect(payload.diagnostics).toContain('freshness:stale');
  });

  it('does not expose raw processed-state freshness fields to downstream payload consumers', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'workspace_shared', projectId: 'repo-1', workspaceId: 'ws-1' },
      remoteProcessedFreshness: 'stale',
      localProcessedFreshness: 'fresh',
      retryExhausted: false,
    });

    expect(payload).not.toHaveProperty('remoteProcessedFreshness');
    expect(payload).not.toHaveProperty('localProcessedFreshness');
    expect(payload).not.toHaveProperty('retryExhausted');
    expect(payload.authority).toMatchObject({
      authoritySource: 'none',
      freshness: 'stale',
      retryScheduled: true,
    });
  });

  it('does not fall back to local processed context in shared scope without explicit policy', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'org_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(payload.authority.authoritySource).toBe('none');
    expect(payload.authority.fallbackAllowed).toBe(false);
  });

  it('keeps per-message local recall as auxiliary context even when authority resolves to processed_remote', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory=\"true\">\n- Prior fix\n</recent-project-memory>',
      }),
      memoryRecall: makeRecall({ authoritySource: 'processed_remote' }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toBeUndefined();
    expect(payload.memoryRecall).toEqual(expect.objectContaining({
      sourceKind: 'local_processed',
      authoritySource: 'processed_remote',
      injectionSurface: 'normalized-payload',
    }));
    expect(payload.systemText ?? '').not.toContain('Recent project memory');
    expect(payload.messagePreamble).toContain('[Related past work]');
    expect(payload.diagnostics).toContain('memory:start:suppressed-authority');
    expect(payload.diagnostics).toContain('memory:message:local-auxiliary');
  });

  it('keeps personal local startup memory as auxiliary when remote authority has no startup hits', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory="true">\n- Local personal startup memory\n</recent-project-memory>',
      }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toEqual(expect.objectContaining({
      sourceKind: 'local_processed',
      authoritySource: 'processed_local',
      injectionSurface: 'normalized-payload',
    }));
    expect(payload.messagePreamble).toContain('Local personal startup memory');
    expect(payload.assembledMessage).toContain('Local personal startup memory');
    expect(payload.diagnostics).toContain('memory:start:local-auxiliary');
  });

  it('injects remote startup memory when remote processed context is authoritative', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        authoritySource: 'processed_remote',
        sourceKind: 'mixed_processed',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory=\"true\">\n- [important] Cloud startup memory\n- [recent] Local startup memory\n</recent-project-memory>',
        items: [
          {
            id: 'cloud-startup',
            projectId: 'repo-1',
            summary: 'Cloud startup memory',
            projectionClass: 'durable_memory_candidate',
            sourceKind: 'remote_processed',
          },
          {
            id: 'local-startup',
            projectId: 'repo-1',
            summary: 'Local startup memory',
            projectionClass: 'recent_summary',
            sourceKind: 'local_processed',
          },
        ],
      }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toEqual(expect.objectContaining({
      sourceKind: 'remote_processed',
      authoritySource: 'processed_remote',
      injectionSurface: 'normalized-payload',
      items: [
        expect.objectContaining({
          id: 'cloud-startup',
          sourceKind: 'remote_processed',
        }),
      ],
    }));
    expect(payload.messagePreamble).toContain('Cloud startup memory');
    expect(payload.assembledMessage).toContain('Cloud startup memory');
    expect(payload.systemText ?? '').not.toContain('Cloud startup memory');
    expect(payload.systemText ?? '').not.toContain('Local startup memory');
    expect(payload.diagnostics).toContain('memory:start');
  });

  it('allows shared local processed fallback only when explicit policy permits it', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'org_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowLocalProcessedFallback: true },
    });

    expect(payload.authority.authoritySource).toBe('processed_local');
    expect(payload.authority.fallbackAllowed).toBe(true);
  });

  it('compiles required authored context before advisory context and surfaces applied versions in diagnostics', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      authoredContextRepository: 'github.com/acme/repo',
      authoredContext: [
        {
          bindingId: 'project-required',
          documentVersionId: 'doc-v2',
          mode: 'required',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'Project required standard',
        },
        {
          bindingId: 'org-advisory',
          documentVersionId: 'doc-v1',
          mode: 'advisory',
          scope: 'org_shared',
          content: 'Org advisory guidance',
        },
      ],
    });

    expect(payload.context.requiredAuthoredContext).toEqual(['Project required standard']);
    expect(payload.context.advisoryAuthoredContext).toEqual(['Org advisory guidance']);
    expect(payload.context.appliedDocumentVersionIds).toEqual(['doc-v2', 'doc-v1']);
    expect(payload.diagnostics).toContain('document-version:doc-v2');
    expect(payload.diagnostics).toContain('document-version:doc-v1');
  });

  it('fails closed when required authored context cannot fit into the compiled payload budget', () => {
    expect(() => buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      maxRequiredAuthoredChars: 5,
      authoredContext: [
        {
          bindingId: 'project-required',
          documentVersionId: 'doc-v2',
          mode: 'required',
          scope: 'project_shared',
          content: 'Project required standard',
        },
      ],
    })).toThrow(/required authored context/i);
  });

  it('rolls back to raw user-message send when runtime-send cutover is disabled', async () => {
    const provider = makeProvider('full-normalized-context-injection');

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      description: 'Be concise',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: false,
        legacyInjectionDisabled: false,
        shadowDiagnostics: false,
      },
    });

    expect(provider.send).toHaveBeenCalledWith('sess-1', 'Run tests');
  });

  it('emits shadow diagnostics without altering the live payload when shadow mode is enabled before cutover', async () => {
    const provider = makeProvider('full-normalized-context-injection');
    const onShadowDiagnostics = vi.fn();

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      description: 'Be concise',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'stale',
      retryExhausted: false,
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: false,
        legacyInjectionDisabled: false,
        shadowDiagnostics: true,
      },
      onShadowDiagnostics,
    });

    expect(onShadowDiagnostics).toHaveBeenCalledWith(expect.arrayContaining(['freshness:stale', 'retry-scheduled']));
    expect(provider.send).toHaveBeenCalledWith('sess-1', 'Run tests');
  });

  it('can resolve backend-managed authored bindings before runtime compilation', async () => {
    const provider = makeProvider('full-normalized-context-injection');
    const resolveAuthoredContext = vi.fn().mockResolvedValue([
      {
        bindingId: 'binding-project',
        documentVersionId: 'doc-v2',
        mode: 'required',
        scope: 'project_shared',
        repository: 'github.com/acme/repo',
        content: 'Project coding standard',
      },
    ]);

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      authoredContextRepository: 'github.com/acme/repo',
    }, {
      resolveAuthoredContext,
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: true,
        legacyInjectionDisabled: true,
        shadowDiagnostics: false,
      },
    });

    expect(resolveAuthoredContext).toHaveBeenCalledWith(expect.objectContaining({
      namespace: expect.objectContaining({
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
      }),
    }));
    expect(provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      sessionSystemText: expect.stringContaining(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE),
      turnSystemText: 'Required shared context:\n- Project coding standard',
      systemText: expect.stringContaining('Required shared context:\n- Project coding standard'),
      context: expect.objectContaining({
        turnSystemText: 'Required shared context:\n- Project coding standard',
        requiredAuthoredContext: ['Project coding standard'],
        appliedDocumentVersionIds: ['doc-v2'],
      }),
    }));
  });

  it('blocks shared-scope dispatch when authority resolution yields no authoritative shared source', async () => {
    const provider = makeProvider('full-normalized-context-injection');

    await expect(dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      remoteProcessedFreshness: 'missing',
      retryExhausted: true,
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: true,
        legacyInjectionDisabled: true,
        shadowDiagnostics: false,
      },
    })).rejects.toThrow(/shared context authority is unavailable/i);

    expect(provider.send).not.toHaveBeenCalled();
  });

  // ── IM.codes identity injection (p2p 37bfbb85-430 N-A) ────────────────
  describe('sessionIdentity', () => {
    it('injects identity into sessionSystemText, intact and untruncated', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'short user description',
        systemPrompt: 'short user system prompt',
        sessionIdentity: { sessionName: 'deck_myapp_brain', label: 'My App Brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).toContain('short user description');
      expect(systemText).toContain('short user system prompt');
      expect(systemText).toContain('IM.codes session identity:');
      expect(systemText).toContain('Exact session name: deck_myapp_brain');
      expect(systemText).toContain('Display label: My App Brain');
      expect(systemText).toContain('imcodes send');
      expect(systemText).toContain('[display name](/absolute/full/path)');
      expect(systemText).toContain(REAL_DEVICE_TESTING_SYSTEM_GUIDANCE);
      expect(systemText).toContain('perform it before audit');
      // Discovery comes BEFORE asking. The guidance used to go straight from
      // "use controlled nodes" to "ask the user", with no way to learn which
      // machines were already authorized for this user and project -- so the
      // verification machines configured for exactly this went unused.
      expect(systemText).toContain(`call ${VERIFICATION_MACHINE_MCP_TOOLS.LIST}`);
      expect(systemText.indexOf(VERIFICATION_MACHINE_MCP_TOOLS.LIST))
        .toBeLessThan(systemText.indexOf('ask the user for that specific authorization'));
      // Both kinds the list can return, each with the tool that reaches it.
      expect(systemText).toContain(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE);
      expect(systemText).toContain(ALIAS_MCP_TOOLS.RESOLVE);
      expect(systemText).toContain(CAPABILITY_AI_SYSTEM_INSTRUCTIONS);
      expect(systemText).toContain('the user\'s latest explicit instruction is authoritative');
      expect(systemText).toContain('This does not override platform system/developer instructions');
      expect(systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    });

    it('does NOT inject Generated Image Reporting at assembly layer (it lives in Codex baseInstructions tail now)', () => {
      // p2p 37bfbb85-430 N-A follow-up: image-reporting is Codex-only,
      // sent once per thread/start via `appendImcodesBaseInstructions`.
      // Other providers must not pay the per-turn token cost.
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        sessionIdentity: { sessionName: 'deck_no_image_brain', label: 'No Image' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).not.toContain('Generated images:');
      expect(systemText).not.toContain('Generated Image Reporting:');
      expect(systemText).not.toContain('repo-relative inside workspace');
    });

    it('falls back to the exact session name when label is null / undefined / blank', () => {
      const cases: Array<string | null | undefined> = [null, undefined, '', '   '];
      for (const label of cases) {
        const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
          userMessage: 'hi',
          sessionIdentity: { sessionName: 'deck_unlabeled_brain', label },
          namespace: { scope: 'personal', projectId: 'repo-1' },
        });
        const systemText = payload.sessionSystemText ?? '';
        expect(systemText).toContain('Exact session name: deck_unlabeled_brain');
        expect(systemText).toContain('Display label: deck_unlabeled_brain');
      }
    });

    it('tells a brain-role session it leads the whole session group', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        sessionIdentity: { sessionName: 'deck_myapp_brain', label: 'My App Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).toContain('Your role: Brain');
      expect(systemText).toContain('leading this project\'s whole session group');
    });

    it('does not claim brain leadership for a worker session', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        sessionIdentity: { sessionName: 'deck_myapp_w1', label: 'W1', role: 'w1' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).not.toContain('Your role: Brain');
    });

    it('does not inject identity when sessionIdentity is absent (process/tmux agents)', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'some text',
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).not.toContain('IM.codes session identity:');
      expect(systemText).toContain('some text');
    });

    it('emits identity peer-level with memory + progress guidance — single contiguous sessionSystemText', () => {
      // Order matters for prefix-cache friendliness: stable session-level
      // blocks should appear in a deterministic order so the model's
      // prompt cache hits across turns. The assembly order is:
      //   user authority -> capability tools -> description -> systemPrompt -> identity -> memory-search
      //   guidance -> agent progress guidance.
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'desc-here',
        systemPrompt: 'sp-here',
        sessionIdentity: { sessionName: 'deck_order_brain', label: 'Order' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      const descIdx = systemText.indexOf('desc-here');
      const spIdx = systemText.indexOf('sp-here');
      const identityIdx = systemText.indexOf('IM.codes session identity:');
      const userAuthorityIdx = systemText.indexOf('HIGHEST-PRIORITY IM.codes USER-AUTHORITY POLICY');
      const capabilityIdx = systemText.indexOf('HIGHEST-PRIORITY IM.codes SERVICE ROUTING POLICY');
      const memoryIdx = systemText.indexOf('Use the available memory MCP tools');
      const realDeviceIdx = systemText.indexOf('REAL-DEVICE TESTING PRIORITY');
      const progressIdx = systemText.indexOf('Keep work updates short and high-signal');
      expect(userAuthorityIdx).toBe(0);
      expect(capabilityIdx).toBeGreaterThan(userAuthorityIdx);
      expect(systemText).toContain('Never rewrite, replace, narrow, or override any third-party provider or SDK tool definition');
      expect(descIdx).toBeGreaterThan(capabilityIdx);
      expect(spIdx).toBeGreaterThan(descIdx);
      expect(identityIdx).toBeGreaterThan(spIdx);
      expect(realDeviceIdx).toBeGreaterThan(identityIdx);
      expect(memoryIdx).toBeGreaterThan(realDeviceIdx);
      expect(progressIdx).toBeGreaterThan(memoryIdx);
    });
  });
});

describe('identity through provider-neutral assembly', () => {
  it('carries a filled three-scope identity into the stable system text without truncation', () => {
    // Only the Codex adapter owns a context budget; the shared assembly that
    // every other provider consumes must never shorten the identity.
    const profile = (scope: 'user' | 'project' | 'session', content: string) => ({
      scope, scopeKey: scope === 'user' ? '' : `${scope}-key`, content, contentHash: scope, revision: 1, updatedAt: 1, source: 'web' as const,
    });
    const identityPrompt = renderIdentityProfilesForAssembly([
      profile('user', 'U'.repeat(ID_USER_MAX)),
      profile('project', 'P'.repeat(ID_PROJECT_MAX)),
      profile('session', 'S'.repeat(ID_SESSION_MAX)),
    ])!;
    const artifact = compileArtifactForIdentity({ userMessage: 'continue', identityPrompt });
    expect(artifact.sessionSystemText).toContain(identityPrompt);
    expect(artifact.systemText).toContain(identityPrompt);
  });
});
