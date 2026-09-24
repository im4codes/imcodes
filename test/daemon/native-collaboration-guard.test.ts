import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const runtimes = vi.hoisted(() => new Map<string, { send: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }>());
const queueState = vi.hoisted(() => ({ tombstones: new Set<string>(), pending: [] as Array<{ clientMessageId: string }> }));
const registryState = vi.hoisted(() => ({
  tasks: [] as Array<{ projectName: string; status: string; assignments: Array<{ status: string; identity: { sessionName: string } }> }>,
  fail: false,
}));
const emitMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => sessions.get(name),
  listSessions: () => [...sessions.values()],
}));
vi.mock('../../src/daemon/supervision-state-store.js', () => ({
  getSupervisionTaskRegistry: () => ({
    list: () => {
      if (registryState.fail) throw new Error('registry offline');
      return registryState.tasks;
    },
  }),
  matchesDurableSupervisionParticipant: (input: {
    taskProjectName: string;
    assignmentSessionName: string;
    candidateProjectName: string;
    candidateSessionName: string;
  }) => input.taskProjectName === input.candidateProjectName && input.assignmentSessionName === input.candidateSessionName,
}));
vi.mock('../../src/agent/session-manager.js', () => ({
  resolveSessionName: (sid: string) => (sid.startsWith('ephemeral-') ? undefined : sid),
  isEphemeralProviderSid: (sid: string) => sid.startsWith('ephemeral-'),
  getTransportRuntime: (name: string) => runtimes.get(name),
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: emitMock } }));
vi.mock('../../src/daemon/transport-history.js', () => ({ appendTransportEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/daemon/cc-presets.js', () => ({ getCachedPresetContextWindow: vi.fn() }));
vi.mock('../../src/daemon/transport-queue-store.js', () => ({
  getTransportQueueStore: () => ({
    hasDeliveryTombstone: (_session: string, id: string) => queueState.tombstones.has(id),
    readSnapshot: () => ({ pendingMessageEntries: queueState.pending }),
  }),
}));

import { wireProviderToRelay } from '../../src/daemon/transport-relay.js';
import {
  NATIVE_COLLABORATION_REROUTE_COALESCE_MS,
  NATIVE_COLLABORATION_SCOPES,
  clearNativeCollaborationGuardForTests,
  enforceObservedNativeCollaboration,
  evaluateNativeCollaborationPreExecution,
  isNativeAgentFenceRequired,
  isNativeAgentFenceRequiredForLaunch,
  resolveNativeCollaborationScope,
} from '../../src/daemon/native-collaboration-guard.js';
import type { NativeAgentFenceResolver, TransportProvider } from '../../src/agent/transport-provider.js';
import type { ToolCallEvent } from '../../shared/agent-message.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import {
  NATIVE_AGENT_ADMISSION_MODES,
  NATIVE_COLLABORATION_POLICY_NOTICE_MARKER,
  NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT,
  type NativeCollaborationGate,
} from '../../shared/native-collaboration-policy.js';
import {
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  buildGenericRuntimeSubagentTool,
} from '../../shared/sdk-subagent-status.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';

const BRAIN = 'deck_cd_brain';
const BRAIN_CHILD = 'deck_sub_worker1';
const GRANDCHILD = 'deck_sub_worker1_child';
const NESTED_BRAIN = 'deck_sub_nested_brain';
const PARTICIPANT = 'deck_cd_w2';
const MARKED = 'deck_cd_w3';
const UNMANAGED = 'deck_other_w1';

const TASK_PROMPT = `${'Background notes for the helper. '.repeat(12)}Please implement the retry queue and git push the branch.`;
const ANALYSIS_PROMPT = 'Summarize how the restore path rebinds the provider thread';
const UNENFORCEABLE = { admissionMode: NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE };

function runtimeSubagentTool(sessionId: string, agentPath: string, prompt: string | undefined, status = 'running'): ToolCallEvent {
  const tool = buildGenericRuntimeSubagentTool({
    provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
    providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
    providerLabel: 'Codex',
    action: 'codex-runtime-subagent',
    sessionId,
    payload: { agent_path: agentPath, status, ...(prompt ? { prompt } : {}) },
  } as Parameters<typeof buildGenericRuntimeSubagentTool>[0]);
  if (!tool) throw new Error('runtime subagent tool not built');
  return tool;
}

function makeProvider(capabilities: Record<string, unknown> = {}, id = 'codex-sdk') {
  let toolCb: ((sid: string, tool: ToolCallEvent) => void) | undefined;
  let gate: NativeCollaborationGate | undefined;
  let fenceResolver: NativeAgentFenceResolver | undefined;
  const provider = {
    id,
    capabilities: { streaming: true, toolCalling: true, approval: false, sessionRestore: true, multiTurn: true, attachments: false, ...capabilities },
    onDelta: () => () => {},
    onComplete: () => () => {},
    onError: () => () => {},
    onToolCall: (cb: (sid: string, tool: ToolCallEvent) => void) => { toolCb = cb; },
    setNativeCollaborationGate: (next: NativeCollaborationGate) => { gate = next; },
    setNativeAgentFenceResolver: (next: NativeAgentFenceResolver) => { fenceResolver = next; },
  } as unknown as TransportProvider;
  wireProviderToRelay(provider);
  return {
    fireTool: (sid: string, tool: ToolCallEvent) => toolCb?.(sid, tool),
    gate: () => gate!,
    fenceResolver: () => fenceResolver!,
  };
}

const GATED = { nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.PRE_EXECUTION_GATE };
const policyEvents = () => emitMock.mock.calls.filter((call) => call[1] === NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT);
const toolProjections = () => emitMock.mock.calls.filter((call) => call[1] === 'tool.call' || call[1] === 'tool.result');
const noticeOf = (reason: string) => JSON.parse(reason.slice(reason.indexOf('{'))) as Record<string, unknown>;

describe('native collaboration supervision-authority guard', () => {
  beforeEach(() => {
    clearNativeCollaborationGuardForTests();
    emitMock.mockClear();
    sessions.clear();
    runtimes.clear();
    queueState.tombstones.clear();
    queueState.pending = [];
    registryState.tasks = [];
    registryState.fail = false;
    sessions.set(BRAIN, { name: BRAIN, projectName: 'cd', role: 'brain', sessionInstanceId: 'i-brain' });
    sessions.set(BRAIN_CHILD, { name: BRAIN_CHILD, projectName: 'cd', role: 'w1', parentSession: BRAIN, sessionInstanceId: 'i-child' });
    sessions.set(GRANDCHILD, { name: GRANDCHILD, projectName: 'cd', role: 'w1', parentSession: BRAIN_CHILD, sessionInstanceId: 'i-grand' });
    sessions.set(NESTED_BRAIN, { name: NESTED_BRAIN, projectName: 'cd', role: 'brain', parentSession: BRAIN, sessionInstanceId: 'i-nested' });
    sessions.set(PARTICIPANT, { name: PARTICIPANT, projectName: 'cd', role: 'w2', sessionInstanceId: 'i-participant' });
    sessions.set(MARKED, {
      name: MARKED, projectName: 'cd', role: 'w3', sessionInstanceId: 'i-marked',
      nativeAgentFenceRequired: { sessionInstanceId: 'i-marked', requiredAt: 1 },
    });
    sessions.set(UNMANAGED, { name: UNMANAGED, projectName: 'other', role: 'w1', sessionInstanceId: 'i-unmanaged' });
    registryState.tasks = [{
      projectName: 'cd',
      status: 'implementing',
      assignments: [{ status: 'implementing', identity: { sessionName: PARTICIPANT } }],
    }];
    for (const name of [BRAIN, BRAIN_CHILD, PARTICIPANT, UNMANAGED]) {
      runtimes.set(name, { send: vi.fn(() => 'queued'), cancel: vi.fn(async () => {}) });
    }
  });

  describe('scope from authoritative session facts', () => {
    it('manages every Brain, Brain descendant, live participant and marked instance; nothing else', () => {
      expect(resolveNativeCollaborationScope(BRAIN)).toBe(NATIVE_COLLABORATION_SCOPES.BRAIN);
      expect(resolveNativeCollaborationScope(NESTED_BRAIN)).toBe(NATIVE_COLLABORATION_SCOPES.BRAIN);
      expect(resolveNativeCollaborationScope(BRAIN_CHILD)).toBe(NATIVE_COLLABORATION_SCOPES.PARTICIPANT);
      expect(resolveNativeCollaborationScope(GRANDCHILD)).toBe(NATIVE_COLLABORATION_SCOPES.PARTICIPANT);
      expect(resolveNativeCollaborationScope(PARTICIPANT)).toBe(NATIVE_COLLABORATION_SCOPES.PARTICIPANT);
      expect(resolveNativeCollaborationScope(MARKED)).toBe(NATIVE_COLLABORATION_SCOPES.PARTICIPANT);
      expect(resolveNativeCollaborationScope(UNMANAGED)).toBe(NATIVE_COLLABORATION_SCOPES.UNMANAGED);
      expect(resolveNativeCollaborationScope('deck_missing')).toBe(NATIVE_COLLABORATION_SCOPES.UNMANAGED);
    });

    it('stops treating a finished assignment as authority, and never lets a marker cross instances', () => {
      registryState.tasks = [{ projectName: 'cd', status: 'finalized', assignments: [{ status: 'finalized', identity: { sessionName: PARTICIPANT } }] }];
      expect(resolveNativeCollaborationScope(PARTICIPANT)).toBe(NATIVE_COLLABORATION_SCOPES.UNMANAGED);
      // Same name, successor instance: the old instance's marker proves nothing.
      sessions.set(MARKED, { ...sessions.get(MARKED)!, sessionInstanceId: 'i-successor' });
      expect(resolveNativeCollaborationScope(MARKED)).toBe(NATIVE_COLLABORATION_SCOPES.UNMANAGED);
    });

    it('treats a registry that cannot answer as managed', () => {
      registryState.fail = true;
      expect(resolveNativeCollaborationScope(UNMANAGED)).toBe(NATIVE_COLLABORATION_SCOPES.UNVERIFIABLE);
      expect(isNativeAgentFenceRequired(UNMANAGED)).toBe(true);
    });

    it('decides the launch fence from the launch parameters of a session that has no record yet', () => {
      expect(isNativeAgentFenceRequiredForLaunch({ sessionName: 'deck_sub_new', role: 'w1', parentSession: BRAIN })).toBe(true);
      expect(isNativeAgentFenceRequiredForLaunch({ sessionName: 'deck_new_brain', role: 'brain' })).toBe(true);
      expect(isNativeAgentFenceRequiredForLaunch({ sessionName: 'deck_sub_plain', role: 'w1', parentSession: UNMANAGED })).toBe(false);
    });
  });

  describe('pre-execution gate installed on capable providers', () => {
    it('denies top-level Brain task participation with a marked reroute reason and hidden evidence', () => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const decision = gate()(BRAIN, { provider: 'claude-code-sdk', toolName: 'Agent', requestText: TASK_PROMPT, toolUseId: 'toolu_1' });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      expect(decision.reason.startsWith(NATIVE_COLLABORATION_POLICY_NOTICE_MARKER)).toBe(true);
      expect(noticeOf(decision.reason)).toMatchObject({
        outcome: 'native_agent_task_participation_denied',
        signals: ['repository_gate', 'implementation'],
      });
      expect(policyEvents()).toHaveLength(1);
      expect(policyEvents()[0]![2]).toMatchObject({ scope: 'brain', participation: 'task' });
      expect(policyEvents()[0]![3]).toMatchObject({ hidden: true, source: 'daemon' });
    });

    it.each([
      ['a Brain child sub-session', BRAIN_CHILD, 'participant'],
      ['a nested brain-role sub-session', NESTED_BRAIN, undefined],
      ['a live supervision participant', PARTICIPANT, 'participant'],
      ['a marked session instance', MARKED, 'participant'],
    ])('denies task work in %s', (_label, sessionId, requester) => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const decision = gate()(sessionId, { provider: 'claude-code-sdk', toolName: 'Agent', requestText: TASK_PROMPT });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      const notice = noticeOf(decision.reason);
      if (requester) expect(notice).toMatchObject({ requester });
      else expect(notice).not.toHaveProperty('requester');
    });

    it.each([
      ['analysis in a Brain', BRAIN, ANALYSIS_PROMPT],
      ['analysis in a participant', PARTICIPANT, ANALYSIS_PROMPT],
      ['task work in a genuinely unmanaged session', UNMANAGED, TASK_PROMPT],
      ['an ephemeral route', 'ephemeral-broker', TASK_PROMPT],
    ])('allows %s', (_label, sessionId, requestText) => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      expect(gate()(sessionId, { provider: 'claude-code-sdk', toolName: 'Agent', requestText })).toEqual({ allow: true });
      expect(policyEvents()).toHaveLength(0);
    });

    it('lets a formal participant delegate small bounded work with no authority/verdict/repository signal', () => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const smallImplementationOnly = 'Implement a small helper that trims trailing whitespace from each line.';
      const decision = gate()(PARTICIPANT, { provider: 'claude-code-sdk', toolName: 'Agent', requestText: smallImplementationOnly });
      expect(decision).toEqual({ allow: true });
      expect(policyEvents()).toHaveLength(0);

      // A Brain-descendant participant (not a top-level Brain) gets the same
      // carve-out -- it is still a formal participant, not a coordinating Brain.
      expect(gate()(BRAIN_CHILD, { provider: 'claude-code-sdk', toolName: 'Agent', requestText: smallImplementationOnly }))
        .toEqual({ allow: true });
    });

    it('never extends the delegation carve-out to a Brain, even for the same small bounded work', () => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const smallImplementationOnly = 'Implement a small helper that trims trailing whitespace from each line.';
      const decision = gate()(BRAIN, { provider: 'claude-code-sdk', toolName: 'Agent', requestText: smallImplementationOnly });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      expect(noticeOf(decision.reason)).toMatchObject({ outcome: 'native_agent_task_participation_denied', signals: ['implementation'] });
    });

    it.each([
      ['carries IM.codes task authority', 'Implement the fix, then call supervision_task_finish on asg_9k2.', ['implementation', 'imcodes_authority']],
      ['carries a PASS/REWORK verdict', 'Review this small helper and return PASS or REWORK.', ['task_verdict']],
      ['carries a repository/deploy gate', 'Implement the small helper and git push the branch.', ['implementation', 'repository_gate']],
    ])('still refuses a participant\'s delegation when the request also %s', (_label, requestText, expectedSignals) => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const decision = gate()(PARTICIPANT, { provider: 'claude-code-sdk', toolName: 'Agent', requestText });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      expect(noticeOf(decision.reason)).toMatchObject({ outcome: 'native_agent_task_participation_denied' });
      for (const signal of expectedSignals) expect(decision.signals).toContain(signal);
    });

    it('denies an unclassified request from a Brain, which never gets the participant carve-out', () => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      const decision = gate()(BRAIN, { provider: 'claude-code-sdk', toolName: 'Workflow', requestText: 'agent("x")' });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      expect(noticeOf(decision.reason)).toMatchObject({ outcome: 'native_agent_request_denied_unclassified' });
    });

    it('lets a formal participant delegate even an unclassified request -- no classifier-recognized intent required', () => {
      const { gate } = makeProvider(GATED, 'claude-code-sdk');
      // Neither PARTICIPANT nor a Brain-descendant (BRAIN_CHILD) needs the
      // request to be classifier-recognized as analysis/implementation/audit
      // any more: only the three never-delegable signals still refuse it.
      expect(gate()(PARTICIPANT, { provider: 'claude-code-sdk', toolName: 'Workflow', requestText: 'agent("x")' }))
        .toEqual({ allow: true });
      expect(gate()(BRAIN_CHILD, { provider: 'claude-code-sdk', toolName: 'Workflow', requestText: 'agent("x")' }))
        .toEqual({ allow: true });
    });

    it('answers the per-session fence resolver from the same scope', () => {
      const { fenceResolver } = makeProvider({ nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE });
      expect(fenceResolver()(BRAIN)).toBe(true);
      expect(fenceResolver()(UNMANAGED)).toBe(false);
      expect(fenceResolver()('ephemeral-compressor')).toBe(false);
      // A launch before route registration names the session itself.
      expect(fenceResolver()('route-not-registered-yet', PARTICIPANT)).toBe(true);
    });
  });

  describe('post-start evidence for providers without a pre-execution gate', () => {
    it('records evidence, stops the turn and queues one notice for a task-type native agent', () => {
      const { fireTool } = makeProvider({ nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE });
      const running = runtimeSubagentTool(BRAIN, 'agent-task-1', TASK_PROMPT);
      expect(String((running.input as { description?: string }).description)).not.toMatch(/implement/);

      fireTool(BRAIN, running);
      fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-task-1', TASK_PROMPT, 'completed'));

      const runtime = runtimes.get(BRAIN)!;
      expect(runtime.cancel).toHaveBeenCalledOnce();
      expect(runtime.send).toHaveBeenCalledOnce();
      const [notice, clientMessageId, attachments, preamble, metadata] = runtime.send.mock.calls[0]!;
      expect(String(notice).startsWith(NATIVE_COLLABORATION_POLICY_NOTICE_MARKER)).toBe(true);
      expect(String(notice)).toContain('native_agent_task_participation_turn_stopped');
      expect(String(notice)).toContain('send_message with task');
      expect(clientMessageId).toBe(deterministicSendMessageId(`native-collaboration-reroute:${BRAIN}:${running.id}`));
      expect(attachments).toBeUndefined();
      expect(preamble).toBeUndefined();
      // Queued, never appended into the turn that was just stopped.
      expect(metadata).toEqual({
        timelineCommitted: true,
        historyCommitted: true,
        deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      });
      expect(policyEvents()).toHaveLength(1);
      expect(policyEvents()[0]![2]).toMatchObject({ enforcement: 'observed_after_start', outcome: 'turn_stopped', scope: 'brain' });
      // The native agent itself stays visible: its tool events are still projected.
      expect(toolProjections().length).toBeGreaterThanOrEqual(2);
    });

    it('stops a participant too, telling it to do the work itself', () => {
      const { fireTool } = makeProvider({ nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE });
      fireTool(BRAIN_CHILD, runtimeSubagentTool(BRAIN_CHILD, 'agent-worker', TASK_PROMPT));
      expect(runtimes.get(BRAIN_CHILD)!.cancel).toHaveBeenCalledOnce();
      expect(String(runtimes.get(BRAIN_CHILD)!.send.mock.calls[0]![0])).toContain('"requester":"participant"');
    });

    it('never stops analysis, unmanaged sessions, or pre-execution providers', () => {
      makeProvider().fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-analysis', ANALYSIS_PROMPT));
      makeProvider().fireTool(UNMANAGED, runtimeSubagentTool(UNMANAGED, 'agent-unmanaged', TASK_PROMPT));
      makeProvider(GATED, 'claude-code-sdk').fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-claude', TASK_PROMPT));

      for (const name of [BRAIN, UNMANAGED]) {
        expect(runtimes.get(name)!.cancel).not.toHaveBeenCalled();
        expect(runtimes.get(name)!.send).not.toHaveBeenCalled();
      }
      expect(policyEvents()).toHaveLength(0);
    });

    it('treats a native agent with no classified request as unclassified, unless it was admitted as analysis', () => {
      const { fireTool } = makeProvider();
      fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-admitted', ANALYSIS_PROMPT));
      fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-admitted', undefined, 'completed'));
      expect(runtimes.get(BRAIN)!.cancel).not.toHaveBeenCalled();

      fireTool(BRAIN, runtimeSubagentTool(BRAIN, 'agent-unknown', undefined));
      expect(runtimes.get(BRAIN)!.cancel).toHaveBeenCalledOnce();
    });

    it('classifies follow-up work handed to an existing native agent', () => {
      const { fireTool } = makeProvider();
      const followUp = (id: string, message: string): ToolCallEvent => ({
        id,
        name: 'followup_task',
        status: 'running',
        detail: {
          kind: 'nativeCollaboration',
          summary: 'followup_task',
          meta: { callId: id, durability: 'non_durable' },
          raw: { type: 'function_call', name: 'followup_task', call_id: id, arguments: JSON.stringify({ agent_path: '/root/helper', message }) },
        },
      });
      fireTool(BRAIN, followUp('call-follow-analysis', 'Summarize the remaining logs'));
      expect(runtimes.get(BRAIN)!.send).not.toHaveBeenCalled();

      fireTool(BRAIN, followUp('call-follow-task', 'Now re-audit the frozen bundle and answer PASS or REWORK'));
      expect(runtimes.get(BRAIN)!.cancel).toHaveBeenCalledOnce();
      expect(runtimes.get(BRAIN)!.send).toHaveBeenCalledOnce();
    });

    it('classifies ordinary native task tool calls (Qwen/OpenCode `task`) by their structured request', () => {
      const { fireTool } = makeProvider({}, 'qwen');
      fireTool(BRAIN, { id: 'tool-list', name: 'task', status: 'running', input: { items: ['a'] } });
      expect(runtimes.get(BRAIN)!.send).not.toHaveBeenCalled();
      fireTool(BRAIN, { id: 'tool-task', name: 'task', status: 'running', input: { description: 'Repair', prompt: 'Please fix the failing CI job' } });
      expect(runtimes.get(BRAIN)!.cancel).toHaveBeenCalledOnce();
      expect(runtimes.get(BRAIN)!.send).toHaveBeenCalledOnce();
    });
  });

  describe('idempotency and failure handling', () => {
    it('is idempotent across restarts through durable delivery evidence', () => {
      const tool = runtimeSubagentTool(BRAIN, 'agent-restart', TASK_PROMPT);
      queueState.tombstones.add(deterministicSendMessageId(`native-collaboration-reroute:${BRAIN}:${tool.id}`));
      expect(enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', tool, UNENFORCEABLE)).toBe('duplicate');
      expect(runtimes.get(BRAIN)!.send).not.toHaveBeenCalled();
    });

    it('stops every turn but coalesces the notice for several native agents within one window', () => {
      vi.useFakeTimers();
      try {
        const first = enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', runtimeSubagentTool(BRAIN, 'a1', TASK_PROMPT), UNENFORCEABLE);
        const second = enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', runtimeSubagentTool(BRAIN, 'a2', TASK_PROMPT), UNENFORCEABLE);
        vi.advanceTimersByTime(NATIVE_COLLABORATION_REROUTE_COALESCE_MS + 1);
        const third = enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', runtimeSubagentTool(BRAIN, 'a3', TASK_PROMPT), UNENFORCEABLE);
        expect([first, second, third]).toEqual(['stopped', 'stopped_coalesced', 'stopped']);
        expect(runtimes.get(BRAIN)!.cancel).toHaveBeenCalledTimes(3);
        expect(runtimes.get(BRAIN)!.send).toHaveBeenCalledTimes(2);
        expect(policyEvents()).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records evidence even when the runtime is unavailable, and retries after a send failure', () => {
      runtimes.delete(BRAIN);
      const noRuntime = runtimeSubagentTool(BRAIN, 'no-rt', TASK_PROMPT);
      expect(enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', noRuntime, UNENFORCEABLE)).toBe('runtime_unavailable');
      expect(policyEvents()).toHaveLength(1);
      // The stop is still owed: the next event for the same native agent
      // delivers it once the runtime is back.
      const recovered = { send: vi.fn(() => 'sent'), cancel: vi.fn(async () => {}) };
      runtimes.set(BRAIN, recovered);
      expect(enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', runtimeSubagentTool(BRAIN, 'no-rt', TASK_PROMPT, 'completed'), UNENFORCEABLE))
        .toBe('stopped');
      expect(recovered.cancel).toHaveBeenCalledOnce();
      expect(recovered.send).toHaveBeenCalledOnce();
      clearNativeCollaborationGuardForTests();

      runtimes.set(BRAIN, { send: vi.fn(() => { throw new Error('not initialized'); }), cancel: vi.fn(async () => {}) });
      const tool = runtimeSubagentTool(BRAIN, 'fails-once', TASK_PROMPT);
      expect(enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', tool, UNENFORCEABLE)).toBe('delivery_failed');
      runtimes.set(BRAIN, { send: vi.fn(() => 'sent'), cancel: vi.fn(async () => {}) });
      expect(enforceObservedNativeCollaboration(BRAIN, 'codex-sdk', tool, UNENFORCEABLE)).toBe('stopped');
    });

    it('evaluates the pre-execution rule directly for callers without a relay', () => {
      expect(evaluateNativeCollaborationPreExecution(BRAIN, { provider: 'x', toolName: 'Agent', requestText: 'Run a peer audit on the latest changes' }))
        .toMatchObject({ allow: false, signals: ['audit'] });
    });

    it('fails closed when the pre-execution gate cannot evaluate a request', () => {
      // Pre-execution providers get no post-start stop, so an error here must
      // not become an allow.
      const decision = evaluateNativeCollaborationPreExecution(BRAIN, {
        provider: 'claude-code-sdk',
        toolName: 'Agent',
        requestText: undefined as unknown as string,
      });
      expect(decision.allow).toBe(false);
      if (decision.allow) return;
      expect(decision.signals).toEqual([]);
      expect(decision.reason.startsWith(NATIVE_COLLABORATION_POLICY_NOTICE_MARKER)).toBe(true);
      expect(noticeOf(decision.reason)).toMatchObject({
        outcome: 'native_agent_request_denied_policy_unavailable',
        provider: 'claude-code-sdk',
        tool: 'Agent',
      });
    });
  });
});
