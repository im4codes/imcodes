/**
 * Runtime enforcement of the supervision-authority policy for provider-native
 * collaboration agents (shared/native-collaboration-policy.ts).
 *
 * Scope comes from authoritative session facts only
 * (`resolveNativeCollaborationScope`): any Brain, execution clone, Brain child
 * sub-session, live supervision participant, or a session carrying the sticky
 * fence-required marker is MANAGED; a registry that cannot answer is
 * UNVERIFIABLE and treated as managed; everything else is genuinely unmanaged
 * and keeps provider defaults.
 *
 * - `pre_execution_gate` providers ask `evaluateNativeCollaborationPreExecution`
 *   before a native agent tool runs. A Brain admits proven analysis only. A
 *   formal participant (never a Brain) additionally admits ANY request --
 *   proven analysis, unclassified, or task work -- as long as it carries none
 *   of the three never-delegable signals (`isDelegableParticipantWork`): the
 *   participant remains the accountable executor either way.
 * - `session_fence` providers ask `isNativeAgentFenceRequired` on the path that
 *   launches, loads or sends, and withhold native agent tools for managed
 *   sessions. Supervised dispatch checks the proven fence separately
 *   (src/daemon/native-agent-admission.ts).
 * - For every non-gate provider, a task-bearing native agent still OBSERVED in
 *   a managed session is evidence of an unproven fence or an unenforceable
 *   runtime: `enforceObservedNativeCollaboration` records it and stops the
 *   turn. Observation is never the enforcing boundary.
 */
import type { ToolCallEvent } from '../../shared/agent-message.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import {
  NATIVE_AGENT_ADMISSION_MODES,
  NATIVE_COLLABORATION_ENFORCEMENT,
  NATIVE_COLLABORATION_PARTICIPATION,
  NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT,
  NATIVE_COLLABORATION_POLICY_VERSION,
  buildNativeCollaborationRerouteNotice,
  classifyNativeCollaborationRequest,
  collectNativeAgentRequestStrings,
  denyNativeCollaborationGateUnavailable,
  formatNativeCollaborationPolicyNotice,
  isDelegableParticipantWork,
  readNativeCollaborationClassification,
  NATIVE_COLLABORATION_REQUESTERS,
  type NativeAgentAdmissionMode,
  type NativeCollaborationEnforcement,
  type NativeCollaborationGateDecision,
  type NativeCollaborationGateRequest,
  type NativeCollaborationParticipation,
  type NativeCollaborationRequester,
  type NativeCollaborationTaskSignal,
  type NativeCollaborationUnclassifiedReason,
} from '../../shared/native-collaboration-policy.js';
import { SDK_SUBAGENT_DETAIL_KIND, parseSdkSubagentDetail } from '../../shared/sdk-subagent-status.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import { isTerminalSupervisionTaskStatus } from '../../shared/supervision-config.js';
import { getSession, listSessions } from '../store/session-store.js';
import { getSupervisionTaskRegistry, matchesDurableSupervisionParticipant } from './supervision-state-store.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import { getTransportQueueStore } from './transport-queue-store.js';

/** Detail kind Codex uses for raw native collaboration function calls. */
export const NATIVE_COLLABORATION_TOOL_DETAIL_KIND = 'nativeCollaboration' as const;

export type ObservedNativeCollaborationOutcome =
  | 'ignored'
  | 'duplicate'
  | 'stopped'
  | 'stopped_coalesced'
  | 'runtime_unavailable'
  | 'delivery_failed';

/**
 * Native sub-agent tools that some providers surface as ordinary tool calls
 * (Qwen/OpenCode `task`, generic `Agent`) rather than as SDK sub-agent
 * snapshots. A structured request field is required so unrelated tools that
 * merely share a short name are not classified.
 */
export const NATIVE_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task', 'Task', 'agent', 'Agent', 'spawn_agent', 'spawnAgent',
]);
const NATIVE_AGENT_REQUEST_FIELDS = ['prompt', 'description', 'message', 'instructions', 'subagent_type'] as const;

/** One policy notice per session within this window; evidence and stops stay per request. */
export const NATIVE_COLLABORATION_REROUTE_COALESCE_MS = 30_000;

const ENFORCED_KEY_LIMIT = 2_000;
const enforcedKeys = new Set<string>();
const admittedAnalysisKeys = new Set<string>();
const lastRerouteNoticeAt = new Map<string, number>();

function rememberBoundedKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false;
  keys.add(key);
  if (keys.size > ENFORCED_KEY_LIMIT) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  return true;
}

const rememberEnforcedKey = (key: string): boolean => rememberBoundedKey(enforcedKeys, key);

/** Who a native collaboration request is made by, as far as supervision authority is concerned. */
export const NATIVE_COLLABORATION_SCOPES = {
  /** A plain session with no supervision role: native agents stay unrestricted. */
  UNMANAGED: 'unmanaged',
  /** Any Brain, top-level or nested: it owns dispatch and audit authority. */
  BRAIN: 'brain',
  /** A formal IM.codes participant bound to a live supervision assignment, or an execution clone. */
  PARTICIPANT: 'participant',
  /** The registry could not say; treated as managed so a failure never opens the gate. */
  UNVERIFIABLE: 'unverifiable',
} as const;
export type NativeCollaborationScope = typeof NATIVE_COLLABORATION_SCOPES[keyof typeof NATIVE_COLLABORATION_SCOPES];

/** Ancestors walked when deciding whether a sub-session descends from a Brain. */
const BRAIN_LINEAGE_MAX_DEPTH = 8;

/** Does a session with this parent chain sit under a Brain (at any depth)? */
function descendsFromBrain(sessionName: string, parentSession: string | null | undefined): boolean {
  const visited = new Set<string>([sessionName]);
  let parentName = parentSession ?? undefined;
  for (let depth = 0; parentName && depth < BRAIN_LINEAGE_MAX_DEPTH && !visited.has(parentName); depth += 1) {
    visited.add(parentName);
    const parent = getSession(parentName);
    if (!parent) return false;
    if (parent.role === 'brain') return true;
    parentName = parent.parentSession;
  }
  return false;
}

/**
 * The supervision scope of a session, from authoritative facts only: the
 * session role, the execution-clone marker, the parent chain up to a Brain,
 * the instance-bound fence-required marker, and a live supervision assignment
 * bound to this exact durable participant (project + session name). Nothing is
 * inferred from names or prose, and a registry that cannot answer is managed.
 */
export function resolveNativeCollaborationScope(sessionName: string | undefined): NativeCollaborationScope {
  if (!sessionName) return NATIVE_COLLABORATION_SCOPES.UNMANAGED;
  try {
    const record = getSession(sessionName);
    if (!record) return NATIVE_COLLABORATION_SCOPES.UNMANAGED;
    if (record.role === 'brain') return NATIVE_COLLABORATION_SCOPES.BRAIN;
    if (record.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND) return NATIVE_COLLABORATION_SCOPES.PARTICIPANT;
    // The marker is authority for this exact instance only; a same-named
    // successor instance does not inherit it.
    if (record.nativeAgentFenceRequired
      && record.nativeAgentFenceRequired.sessionInstanceId === record.sessionInstanceId) {
      return NATIVE_COLLABORATION_SCOPES.PARTICIPANT;
    }
    // A Brain's sub-session (at any depth) works under that Brain's authority.
    if (descendsFromBrain(record.name, record.parentSession)) return NATIVE_COLLABORATION_SCOPES.PARTICIPANT;
    const projectName = resolveEffectiveProjectName(record, listSessions()) ?? record.projectName;
    const bound = getSupervisionTaskRegistry().list({ projectName, ownerSessionName: sessionName })
      .some((task) => !isTerminalSupervisionTaskStatus(task.status) && task.assignments.some((assignment) => (
        !isTerminalSupervisionTaskStatus(assignment.status)
        && matchesDurableSupervisionParticipant({
          taskProjectName: task.projectName,
          assignmentSessionName: assignment.identity.sessionName,
          candidateProjectName: projectName,
          candidateSessionName: sessionName,
        })
      )));
    return bound ? NATIVE_COLLABORATION_SCOPES.PARTICIPANT : NATIVE_COLLABORATION_SCOPES.UNMANAGED;
  } catch (error) {
    logger.warn({ error, sessionName }, 'native collaboration scope unverifiable; treating session as managed');
    return NATIVE_COLLABORATION_SCOPES.UNVERIFIABLE;
  }
}

/** Is this session governed by the formal supervision authority policy? */
export function isNativeCollaborationManagedSession(sessionName: string | undefined): boolean {
  return resolveNativeCollaborationScope(sessionName) !== NATIVE_COLLABORATION_SCOPES.UNMANAGED;
}

/**
 * Must the runtime serving this IM.codes session withhold native agent tools?
 * Asked by `session_fence` providers and process launches on the path that
 * launches, loads or sends. A session that cannot be resolved to an IM.codes
 * session (an out-of-band broker or compressor route) keeps provider defaults;
 * a scope that cannot be verified is fenced.
 */
export function isNativeAgentFenceRequired(sessionName: string | undefined): boolean {
  if (!sessionName) return false;
  return resolveNativeCollaborationScope(sessionName) !== NATIVE_COLLABORATION_SCOPES.UNMANAGED;
}

/**
 * The fence decision for a PROCESS launch, whose record may not exist yet (a
 * brand-new sub-session) or may not carry the launch's role and parent: the
 * launch parameters count as authority too. Any failure fences.
 */
export function isNativeAgentFenceRequiredForLaunch(input: {
  sessionName: string;
  role?: string | null;
  parentSession?: string | null;
}): boolean {
  try {
    if (input.role === 'brain') return true;
    if (descendsFromBrain(input.sessionName, input.parentSession)) return true;
    return isNativeAgentFenceRequired(input.sessionName);
  } catch (error) {
    logger.warn({ error, sessionName: input.sessionName }, 'native agent launch scope unverifiable; fencing');
    return true;
  }
}

function emitPolicyEvidence(sessionName: string, input: {
  key: string;
  provider: string;
  toolName: string;
  signals: readonly NativeCollaborationTaskSignal[];
  enforcement: NativeCollaborationEnforcement;
  outcome: string;
  scope?: NativeCollaborationScope;
  participation?: NativeCollaborationParticipation;
  unclassifiedReason?: NativeCollaborationUnclassifiedReason;
}): void {
  try {
    timelineEmitter.emit(sessionName, NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT, {
      policy: NATIVE_COLLABORATION_POLICY_VERSION,
      provider: input.provider,
      tool: input.toolName,
      signals: [...input.signals],
      enforcement: input.enforcement,
      outcome: input.outcome,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.participation ? { participation: input.participation } : {}),
      ...(input.unclassifiedReason ? { unclassifiedReason: input.unclassifiedReason } : {}),
      memoryExcluded: true,
    }, {
      source: 'daemon',
      confidence: 'high',
      eventId: `native-collaboration-policy:${sessionName}:${input.key}:${input.enforcement}`,
      hidden: true,
    });
  } catch (error) {
    logger.warn({ error, sessionName }, 'native collaboration policy evidence emit failed');
  }
}

/** The requester a refusal notice addresses for a managed scope. */
const requesterFor = (scope: NativeCollaborationScope): NativeCollaborationRequester => (
  scope === NATIVE_COLLABORATION_SCOPES.PARTICIPANT
    ? NATIVE_COLLABORATION_REQUESTERS.PARTICIPANT
    : NATIVE_COLLABORATION_REQUESTERS.BRAIN
);

/**
 * Pre-execution decision for a native agent request made inside `sessionName`.
 *
 * An unmanaged session is always allowed. Inside a managed session (any Brain,
 * any formal participant, or a session whose scope cannot be verified) ONLY a
 * request the policy proves to be analysis runs: task work and unclassified
 * requests are both refused before execution. A gate that cannot evaluate
 * fails CLOSED.
 */
export function evaluateNativeCollaborationPreExecution(
  sessionName: string,
  request: NativeCollaborationGateRequest,
): NativeCollaborationGateDecision {
  try {
    const scope = resolveNativeCollaborationScope(sessionName);
    if (scope === NATIVE_COLLABORATION_SCOPES.UNMANAGED) return { allow: true };
    const classification = classifyNativeCollaborationRequest(request.requestText);
    if (classification.participation === NATIVE_COLLABORATION_PARTICIPATION.ANALYSIS) return { allow: true };
    // A formal participant (never a Brain) may hand any of its OWN assigned
    // work -- including unclassified or long narrative requests -- to its own
    // native subagent, as long as nothing in the request touches IM.codes
    // task authority, a verdict, or a Git/deploy gate -- see
    // isDelegableParticipantWork. The participant remains the accountable
    // executor of the task itself.
    if (scope === NATIVE_COLLABORATION_SCOPES.PARTICIPANT && isDelegableParticipantWork(classification)) {
      return { allow: true };
    }
    emitPolicyEvidence(sessionName, {
      key: request.toolUseId ?? deterministicSendMessageId(`native-collaboration-gate:${request.requestText}`),
      provider: request.provider,
      toolName: request.toolName,
      signals: classification.signals,
      enforcement: NATIVE_COLLABORATION_ENFORCEMENT.DENIED_BEFORE_EXECUTION,
      outcome: 'denied',
      scope,
      participation: classification.participation,
      ...(classification.unclassifiedReason ? { unclassifiedReason: classification.unclassifiedReason } : {}),
    });
    return {
      allow: false,
      signals: classification.signals,
      reason: formatNativeCollaborationPolicyNotice(buildNativeCollaborationRerouteNotice({
        provider: request.provider,
        toolName: request.toolName,
        signals: classification.signals,
        enforcement: NATIVE_COLLABORATION_ENFORCEMENT.DENIED_BEFORE_EXECUTION,
        requester: requesterFor(scope),
        ...(classification.unclassifiedReason ? { unclassifiedReason: classification.unclassifiedReason } : {}),
      })),
    };
  } catch (error) {
    logger.warn({ error, sessionName, provider: request.provider, tool: request.toolName }, 'native collaboration gate failed closed');
    return denyNativeCollaborationGateUnavailable(request);
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

interface ObservedNativeCollaborationRequest {
  key: string;
  provider: string;
  toolName: string;
  participation: NativeCollaborationParticipation;
  signals: NativeCollaborationTaskSignal[];
}

/** Read the classified native collaboration request carried by one tool event. */
export function readObservedNativeCollaborationRequest(
  providerId: string,
  tool: ToolCallEvent,
): ObservedNativeCollaborationRequest | undefined {
  const sdkDetail = parseSdkSubagentDetail(tool.detail);
  if (sdkDetail.kind === 'ok') {
    const meta = sdkDetail.detail.meta;
    // A native agent whose request was never classified (no prompt reached the
    // provider adapter, a malformed classification) is not provably analysis.
    const classification = readNativeCollaborationClassification(meta.taskParticipation, meta.taskParticipationSignals)
      ?? { participation: NATIVE_COLLABORATION_PARTICIPATION.UNCLASSIFIED, signals: [] };
    return {
      key: meta.canonicalKey,
      provider: meta.provider,
      toolName: tool.name,
      participation: classification.participation,
      signals: classification.signals,
    };
  }
  const detail = asRecord(tool.detail);
  if (detail?.kind === NATIVE_COLLABORATION_TOOL_DETAIL_KIND) {
    // Follow-up / message tools hand MORE work to an existing native agent, so
    // they are classified exactly like a spawn prompt.
    const raw = asRecord(detail.raw);
    const args = parseJsonRecord(raw?.arguments) ?? parseJsonRecord(raw?.input);
    const texts = collectNativeAgentRequestStrings(args ?? tool.input);
    if (texts.length === 0) return undefined;
    const classification = classifyNativeCollaborationRequest(texts);
    return {
      key: tool.id,
      provider: providerId,
      toolName: tool.name,
      participation: classification.participation,
      signals: classification.signals,
    };
  }
  if (!NATIVE_AGENT_TOOL_NAMES.has(tool.name)) return undefined;
  const input = asRecord(tool.input);
  if (!input || !NATIVE_AGENT_REQUEST_FIELDS.some((field) => typeof input[field] === 'string')) return undefined;
  const texts = NATIVE_AGENT_REQUEST_FIELDS
    .filter((field) => field !== 'subagent_type')
    .map((field) => input[field])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (texts.length === 0) return undefined;
  const classification = classifyNativeCollaborationRequest(texts);
  return {
    key: tool.id,
    provider: providerId,
    toolName: tool.name,
    participation: classification.participation,
    signals: classification.signals,
  };
}

/**
 * Post-start EVIDENCE for providers without a pre-execution gate. A
 * task-bearing (or unclassified) native agent observed in a managed session
 * means the runtime's fence was not in effect or the runtime is unenforceable,
 * so the daemon records hidden durable evidence, stops the turn that started
 * the agent, and queues one policy notice the model reads on its next turn.
 * Idempotent per (session, native agent) across restarts: the notice uses a
 * deterministic delivery id and durable queue evidence.
 */
export function enforceObservedNativeCollaboration(
  sessionName: string,
  providerId: string,
  tool: ToolCallEvent,
  options: { admissionMode: NativeAgentAdmissionMode },
): ObservedNativeCollaborationOutcome {
  // A gated provider already refused task requests before execution and
  // delivered the reason in-turn; what it let through is proven analysis.
  if (options.admissionMode === NATIVE_AGENT_ADMISSION_MODES.PRE_EXECUTION_GATE) return 'ignored';
  // Every tool event passes through here: recognize a native agent first (no
  // I/O) and resolve the session's authority only for one.
  const request = readObservedNativeCollaborationRequest(providerId, tool);
  if (!request) return 'ignored';
  const scope = resolveNativeCollaborationScope(sessionName);
  if (scope === NATIVE_COLLABORATION_SCOPES.UNMANAGED) return 'ignored';
  const agentKey = `${sessionName}\0${request.key}`;
  if (request.participation === NATIVE_COLLABORATION_PARTICIPATION.ANALYSIS) {
    // Later progress/completion snapshots of this agent carry no request text;
    // they inherit the analysis admission instead of reading as unclassified.
    rememberBoundedKey(admittedAnalysisKeys, agentKey);
    return 'ignored';
  }
  if (request.participation === NATIVE_COLLABORATION_PARTICIPATION.UNCLASSIFIED
    && request.signals.length === 0
    && admittedAnalysisKeys.has(agentKey)) return 'ignored';
  if (!rememberEnforcedKey(agentKey)) return 'duplicate';

  const clientMessageId = deterministicSendMessageId(`native-collaboration-reroute:${sessionName}:${request.key}`);
  try {
    const store = getTransportQueueStore();
    const alreadyQueued = store.hasDeliveryTombstone(sessionName, clientMessageId)
      || store.readSnapshot(sessionName).pendingMessageEntries.some((entry) => entry.clientMessageId === clientMessageId);
    if (alreadyQueued) return 'duplicate';
  } catch (error) {
    logger.warn({ error, sessionName }, 'native collaboration notice dedupe lookup failed');
  }

  emitPolicyEvidence(sessionName, {
    key: request.key,
    provider: request.provider,
    toolName: request.toolName,
    signals: request.signals,
    enforcement: NATIVE_COLLABORATION_ENFORCEMENT.OBSERVED_AFTER_START,
    outcome: 'turn_stopped',
    scope,
    participation: request.participation,
  });

  const runtime = getTransportRuntime(sessionName);
  if (!runtime) {
    // Evidence is recorded; the stop is still owed. Forget the key so the next
    // event for this native agent (progress, completion) retries it.
    enforcedKeys.delete(agentKey);
    return 'runtime_unavailable';
  }
  // Stop first: the turn that started the agent must not go on consuming it.
  void runtime.cancel().catch((error: unknown) => {
    logger.warn({ error, sessionName, provider: request.provider }, 'native collaboration turn stop failed');
  });

  // One provider spawn can surface as several events (ordinary tool call plus
  // runtime snapshot). The notice is the same rule, so coalesce it.
  const now = Date.now();
  const previousNoticeAt = lastRerouteNoticeAt.get(sessionName);
  if (previousNoticeAt !== undefined && now - previousNoticeAt < NATIVE_COLLABORATION_REROUTE_COALESCE_MS) {
    return 'stopped_coalesced';
  }
  const notice = formatNativeCollaborationPolicyNotice(buildNativeCollaborationRerouteNotice({
    provider: request.provider,
    toolName: request.toolName,
    signals: request.signals,
    enforcement: NATIVE_COLLABORATION_ENFORCEMENT.OBSERVED_AFTER_START,
    requester: requesterFor(scope),
  }));
  try {
    // Queued, never appended: the stopped turn must not receive it.
    runtime.send(notice, clientMessageId, undefined, undefined, {
      timelineCommitted: true,
      historyCommitted: true,
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
    });
    lastRerouteNoticeAt.set(sessionName, now);
    return 'stopped';
  } catch (error) {
    enforcedKeys.delete(agentKey);
    logger.warn({ error, sessionName, provider: request.provider }, 'native collaboration notice delivery failed');
    return 'delivery_failed';
  }
}

const nativeAgentToolCalls = new Set<string>();

/**
 * Is this timeline row the work of a provider-native collaboration agent (its
 * spawn/follow-up call, its runtime snapshot, or the result it hands back)?
 * Such rows are never evidence that a formal IM.codes participant is executing
 * its assignment.
 */
export function isNativeCollaborationTimelineEvent(event: {
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}): boolean {
  if (event.type !== 'tool.call' && event.type !== 'tool.result') return false;
  const detail = asRecord(event.payload.detail);
  const toolCallId = typeof event.payload.toolCallId === 'string' && event.payload.toolCallId
    ? `${event.sessionId}\0${event.payload.toolCallId}`
    : undefined;
  const native = detail?.kind === SDK_SUBAGENT_DETAIL_KIND
    || detail?.kind === NATIVE_COLLABORATION_TOOL_DETAIL_KIND
    || (event.type === 'tool.call' && typeof event.payload.tool === 'string' && NATIVE_AGENT_TOOL_NAMES.has(event.payload.tool));
  if (event.type === 'tool.call') {
    if (native && toolCallId) {
      nativeAgentToolCalls.add(toolCallId);
      if (nativeAgentToolCalls.size > ENFORCED_KEY_LIMIT) {
        const oldest = nativeAgentToolCalls.values().next().value;
        if (oldest !== undefined) nativeAgentToolCalls.delete(oldest);
      }
    }
    return native;
  }
  // A result is terminal for its call: forget the call id either way.
  const handsBackNativeWork = toolCallId ? nativeAgentToolCalls.delete(toolCallId) : false;
  return native || handsBackNativeWork;
}

export function clearNativeCollaborationGuardForTests(): void {
  enforcedKeys.clear();
  admittedAnalysisKeys.clear();
  lastRerouteNoticeAt.clear();
  nativeAgentToolCalls.clear();
}
