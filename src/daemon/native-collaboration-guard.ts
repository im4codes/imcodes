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
 * Native-agent classification is advisory at every provider boundary. The
 * formal pair contract governs Brain routing, while provider-native calls are
 * never vetoed or stopped here.
 *
 * - `pre_execution_gate` providers ask `evaluateNativeCollaborationPreExecution`
 *   before a native agent tool runs; the callback records advisory metadata
 *   and always admits the call.
 * - `session_fence` providers ask `isNativeAgentFenceRequired` on the path
 *   that launches, loads or sends. The resolver remains capability plumbing
 *   but never withholds native tools.
 * - For every provider, `enforceObservedNativeCollaboration` records optional
 *   advisory evidence without stopping turns or queuing corrections.
 */
import type { ToolCallEvent } from '../../shared/agent-message.js';
import {
  NATIVE_COLLABORATION_ENFORCEMENT,
  NATIVE_COLLABORATION_PARTICIPATION,
  NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT,
  NATIVE_COLLABORATION_POLICY_VERSION,
  classifyNativeCollaborationRequest,
  collectNativeAgentRequestStrings,
  readNativeCollaborationClassification,
  type NativeAgentAdmissionMode,
  type NativeCollaborationEnforcement,
  type NativeCollaborationGateDecision,
  type NativeCollaborationGateRequest,
  type NativeCollaborationParticipation,
  type NativeCollaborationTaskSignal,
  type NativeCollaborationUnclassifiedReason,
} from '../../shared/native-collaboration-policy.js';
import { SDK_SUBAGENT_DETAIL_KIND, parseSdkSubagentDetail } from '../../shared/sdk-subagent-status.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import { isTerminalSupervisionTaskStatus } from '../../shared/supervision-config.js';
import { getSession, listSessions } from '../store/session-store.js';
import { getSupervisionTaskRegistry, matchesDurableSupervisionParticipant } from './supervision-state-store.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';

/** Detail kind Codex uses for raw native collaboration function calls. */
export const NATIVE_COLLABORATION_TOOL_DETAIL_KIND = 'nativeCollaboration' as const;

export type ObservedNativeCollaborationOutcome =
  | 'ignored'
  | 'duplicate'
  | 'advised';

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

/** Native-agent capability query retained for provider plumbing. The pair
 * contract is advisory and never withholds provider-native tools. */
export function isNativeAgentFenceRequired(sessionName: string | undefined): boolean {
  // Keep the resolver in the provider capability plumbing, but do not turn
  // the contract into a provider-tool gate.
  void sessionName;
  return false;
}

/** Native-agent capability query for a process launch; always provider-default. */
export function isNativeAgentFenceRequiredForLaunch(input: {
  sessionName: string;
  role?: string | null;
  parentSession?: string | null;
}): boolean {
  void input;
  return false;
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

/**
 * Pre-execution decision for a native agent request made inside `sessionName`.
 *
 * Every scope is allowed. Classification and scope remain available for
 * advisory timeline evidence, while the pair contract (rather than this
 * callback) governs where project work is dispatched.
 */
export function evaluateNativeCollaborationPreExecution(
  sessionName: string,
  request: NativeCollaborationGateRequest,
): NativeCollaborationGateDecision {
  try {
    const scope = resolveNativeCollaborationScope(sessionName);
    if (scope === NATIVE_COLLABORATION_SCOPES.UNMANAGED) return { allow: true };
    const classification = classifyNativeCollaborationRequest(request.requestText);
    emitPolicyEvidence(sessionName, {
      key: request.toolUseId ?? deterministicSendMessageId(`native-collaboration-gate:${request.requestText}`),
      provider: request.provider,
      toolName: request.toolName,
      signals: classification.signals,
      enforcement: NATIVE_COLLABORATION_ENFORCEMENT.ADVISORY,
      outcome: 'allowed',
      scope,
      participation: classification.participation,
      ...(classification.unclassifiedReason ? { unclassifiedReason: classification.unclassifiedReason } : {}),
    });
    return { allow: true };
  } catch (error) {
    logger.warn({ error, sessionName, provider: request.provider, tool: request.toolName }, 'native collaboration advisory failed');
    return { allow: true };
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
 * Post-start advisory evidence for providers without a pre-execution gate.
 * Native-agent calls are allowed; this function only records one hidden
 * timeline row per observed request in a managed scope.
 */
export function enforceObservedNativeCollaboration(
  sessionName: string,
  providerId: string,
  tool: ToolCallEvent,
  options: { admissionMode: NativeAgentAdmissionMode },
): ObservedNativeCollaborationOutcome {
  void options;
  const request = readObservedNativeCollaborationRequest(providerId, tool);
  if (!request) return 'ignored';
  const scope = resolveNativeCollaborationScope(sessionName);
  if (scope === NATIVE_COLLABORATION_SCOPES.UNMANAGED) return 'ignored';
  const agentKey = `${sessionName}\0${request.key}`;
  if (!rememberEnforcedKey(agentKey)) return 'duplicate';
  emitPolicyEvidence(sessionName, {
    key: request.key,
    provider: request.provider,
    toolName: request.toolName,
    signals: request.signals,
    enforcement: NATIVE_COLLABORATION_ENFORCEMENT.ADVISORY,
    outcome: 'allowed',
    scope,
    participation: request.participation,
  });
  return 'advised';
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
  nativeAgentToolCalls.clear();
}
