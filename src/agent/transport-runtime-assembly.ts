import type { TransportProvider } from './transport-provider.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';
import { selectRuntimeAuthoredContext } from './authored-context.js';
import { evaluateContextAuthority } from './context-authority.js';
import { buildContextDiagnostics } from './context-diagnostics.js';
import { getSharedContextCutoverFlags, type SharedContextCutoverFlags } from '../context/shared-context-flags.js';
import type { ProviderError } from './transport-provider.js';
import { incrementCounter } from '../util/metrics.js';
import type { ActivityGeneration } from '../../shared/session-activity-types.js';
import type {
  CompiledAgentContextArtifact,
  ContextAuthorityDecision,
  ContextNamespace,
  ContextSendSurface,
  MemoryRecallInjectionSurface,
  MemoryRecallSourceKind,
  ProviderContextPayload,
  ProviderSupportClass,
  RuntimeAuthoredContextBinding,
  TransportMemoryRecallArtifact,
  TransportMemoryRecallItem,
} from '../../shared/context-types.js';
import { buildRelatedPastWorkText, buildStartupProjectMemoryText } from '../../shared/memory-recall-format.js';
import { attachMemoryShortRefs } from '../context/memory-recall-refs.js';
import {
  buildFilePathReportingPrompt,
  buildTransportImcodesIdentityPrompt,
  REAL_DEVICE_TESTING_SYSTEM_GUIDANCE,
} from '../../shared/transport-runtime-prompts.js';
import { CAPABILITY_AI_SYSTEM_INSTRUCTIONS } from '../../shared/capability-management.js';
import { MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS } from '../../shared/mcp-tool-discovery.js';
import {
  buildBrainSupervisedWorkDelegationContract,
  buildBrainManualOnlyDelegationContract,
  buildBrainWorkDelegationContractRef,
} from '../daemon/supervision-prompts.js';
import { buildAuditConvergenceContract } from '../../shared/audit-convergence.js';
import { buildTaskPairMarkerContract } from '../../shared/task-pair.js';
import { CRON_CONTROL_PROTOCOL, CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../shared/cron-types.js';

/** Stable text: rendered once, registered in every managed session's system prompt. */
const AUDIT_CONVERGENCE_SYSTEM_CONTRACT = buildAuditConvergenceContract();
const TASK_PAIR_SYSTEM_CONTRACT = buildTaskPairMarkerContract();
import type { SessionRecord } from '../store/session-store.js';
import { identitySpanForSegment, joinSpanned } from './priority-preserving-context-cap.js';

export interface TransportRuntimeAssemblyInput {
  userMessage: string;
  /** Stable logical delivery identity retained across recoverable dispatch retries. */
  deliveryId?: string;
  description?: string;
  /** Resolved deterministic user/project/session Agent identity contract. */
  identityPrompt?: string;
  systemPrompt?: string;
  suppressMcpMemorySearchGuidance?: boolean;
  suppressAgentProgressGuidance?: boolean;
  suppressFilePathReportingGuidance?: boolean;
  messagePreamble?: string;
  /**
   * True once the full Brain work-delegation contract body has already been
   * registered for this thread. Later turns then re-assert it by reference
   * instead of resending the body; the body is registered again after a
   * thread start/resume or a compaction, which is when the prior text is gone.
   */
  brainContractRegistered?: boolean;
  /**
   * This turn's answer of `isAutomaticSupervisionEnabled` for the session.
   * Absent is treated exactly like false: a runtime that cannot establish the
   * mode must never hand a Brain the automatic supervision duties.
   * `brainContractRegistered` must refer to THIS variant's registration.
   */
  automaticSupervisionEnabled?: boolean;
  /** Full dynamic contracts that are not yet registered on this provider thread. */
  registeredSystemContractText?: string;
  attachments?: TransportAttachment[];
  namespace?: ContextNamespace;
  namespaceDiagnostics?: string[];
  remoteProcessedFreshness?: 'fresh' | 'stale' | 'missing';
  localProcessedFreshness?: 'fresh' | 'stale' | 'missing';
  retryExhausted?: boolean;
  sharedPolicyOverride?: {
    allowDegradedProvider?: boolean;
    allowLocalProcessedFallback?: boolean;
    requireFullProviderSupport?: boolean;
  };
  authoredContext?: RuntimeAuthoredContextBinding[];
  authoredContextRepository?: string;
  authoredContextLanguage?: string;
  authoredContextFilePath?: string;
  maxRequiredAuthoredChars?: number;
  maxAdvisoryAuthoredChars?: number;
  sourceSurface?: ContextSendSurface;
  startupMemory?: TransportMemoryRecallArtifact;
  memoryRecall?: TransportMemoryRecallArtifact;
  /**
   * Session-stable IM.codes identity injection. When present, the
   * identity block (exact session name + display label + `imcodes send`
   * guidance) is appended to `sessionSystemText` peer-level with
   * `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE` — outside the user-authored
   * 300-char cap. See p2p audit 37bfbb85-430 N-A.
   */
  /**
   * Authoritative session identity. `role` comes from the session record, never
   * from parsing sessionName/label and never from model or client free text: a
   * session that could impersonate a Brain would inherit delegation authority.
   */
  sessionIdentity?: { sessionName: string; label?: string | null; role?: SessionRecord['role'] };
  /** Runtime-minted lifecycle generation for provider active-work attribution. */
  activityGeneration?: ActivityGeneration;
}

export const MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE = [
  'For capabilities exposed by IM.codes MCP—memory, cron scheduling, aliases, inter-agent messaging, collaboration, and managed-machine operations—treat its tools as authoritative and prefer them over provider-native or improvised alternatives when relevant.',
  'Use the available memory MCP tools when the user asks about prior work, project history, past decisions, preferences, bugs, commits, deployments, or previously discussed context.',
  'Always call the exact tool identifier shown in the current tool list; MCP hosts may namespace logical tool names.',
  'Before answering those requests, use the available memory-search tool with a concise query based on the user message and current project.',
  'After memory search, inspect each hit\'s sourceLookup object. If a relevant hit may affect the answer and its summary is not enough, use the available memory source-expansion tool with the returned fields before answering. If startup memory gives only a compact ref such as obs:abc123, expand that ref with the same tool.',
  'Use source expansion for exact prior instructions, decisions, preferences, bug details, commit/deployment facts, or provenance-sensitive answers; do not invent details from summaries alone.',
  'Do not call memory for bare control messages like "continue", "go on", "ok", "yes", "commit", "push", "run tests", or other short commands without searchable context.',
].join('\n');

// "Sparse, key boundaries only" with no ceiling on silence let long tasks run
// for many minutes with nothing the user could see. High-signal stays the rule;
// silence now has an upper bound.
const AGENT_PROGRESS_SYSTEM_GUIDANCE = [
  'Keep work updates short and high-signal; never paste logs or diffs unless asked.',
  'Before any step likely to take more than about 2 minutes (builds, test suites, deploys, restarts, waits, polling, multi-step investigation), say in one line what you are doing and why.',
  'During long work, give a status at least every 5 minutes or every 15 tool calls, in one or two short sentences: what finished, what is running, what is next. Never work longer than that with no user-visible update; never turn a status into a long report.',
  'Say at once when a hypothesis is disproven, a plan changes, or you are blocked; skip routine narration and repeated summaries.',
  'Continue without confirmation unless blocked or the user requested a plan.',
].join('\n');

export interface DispatchSharedContextSendOptions {
  flags?: SharedContextCutoverFlags;
  onShadowDiagnostics?: (diagnostics: string[]) => void;
  resolveAuthoredContext?: (input: TransportRuntimeAssemblyInput) => Promise<RuntimeAuthoredContextBinding[]>;
  /**
   * Upper bound for the provider send-start RPC. This guards app-server/RPC
   * providers that can remain connected while never answering the start-turn
   * request. A value <= 0 disables the watchdog.
   */
  sendTimeoutMs?: number;
  /** Called immediately before provider.send() is invoked.
   *  TransportSessionRuntime uses this boundary to keep STOP highest-priority:
   *  a cancel that arrives during context assembly can still abort before the
   *  provider sees the turn, while a cancel after this callback delegates to
   *  the provider interrupt/abort implementation. */
  onBeforeProviderSend?: () => void;
}

export interface DispatchSharedContextSendResult {
  disposition: 'sent' | 'legacy-sent';
  payload?: ProviderContextPayload;
}

export interface EvaluatedTransportDispatchAuthority {
  supportClass: ProviderSupportClass;
  authority: ProviderContextPayload['authority'];
}

export class SharedContextDispatchError extends Error {
  readonly providerError: ProviderError;
  readonly payload?: ProviderContextPayload;

  constructor(providerError: ProviderError, payload?: ProviderContextPayload) {
    super(providerError.message);
    this.name = 'SharedContextDispatchError';
    this.providerError = providerError;
    this.payload = payload;
  }

  toProviderError(): ProviderError {
    return this.providerError;
  }
}

export function dispatchSharedContextSend(
  provider: TransportProvider,
  sessionId: string,
  input: TransportRuntimeAssemblyInput,
  options?: DispatchSharedContextSendOptions,
): Promise<DispatchSharedContextSendResult> {
  const flags = options?.flags ?? getSharedContextCutoverFlags();
  return resolveTransportRuntimeAssemblyInput(input, options).then(async (resolvedInput) => {
    const payload = buildProviderContextPayload(provider, resolvedInput);
    if (flags.shadowDiagnostics) {
      options?.onShadowDiagnostics?.(payload.diagnostics);
    }
    if (!flags.runtimeSend) {
      await sendProviderWithTimeout(provider, sessionId, input.userMessage, options);
      return { disposition: 'legacy-sent', payload };
    }
    enforceDispatchAuthority(payload);
    await sendProviderWithTimeout(provider, sessionId, payload, options);
    return { disposition: 'sent', payload };
  });
}

async function sendProviderWithTimeout(
  provider: TransportProvider,
  sessionId: string,
  payload: string | ProviderContextPayload,
  options: Pick<DispatchSharedContextSendOptions, 'sendTimeoutMs' | 'onBeforeProviderSend'> | undefined,
): Promise<void> {
  const timeoutMs = options?.sendTimeoutMs;
  options?.onBeforeProviderSend?.();
  const sendPromise = provider.send(sessionId, payload);
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    await sendPromise;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const providerError: ProviderError = {
            code: 'TRANSPORT_TURN_TIMEOUT',
            message: `Provider ${provider.id} did not accept the transport turn within ${Math.round(timeoutMs)}ms`,
            recoverable: false,
            details: { providerId: provider.id, sessionId, timeoutMs: Math.round(timeoutMs) },
          };
          reject(providerError);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && (err as ProviderError).code === 'TRANSPORT_TURN_TIMEOUT') {
      incrementCounter('transport.provider_send.timeout', { provider: provider.id });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildProviderContextPayload(
  provider: TransportProvider,
  input: TransportRuntimeAssemblyInput,
): ProviderContextPayload {
  const { supportClass, authority } = resolveTransportDispatchAuthority(provider, input);
  const cronSafeStartupMemory = filterObsoleteCronControlMemory(input.startupMemory);
  const cronSafeMemoryRecall = filterObsoleteCronControlMemory(input.memoryRecall);
  const sanitizedStartupMemory = filterStartupMemoryForAuthority(cronSafeStartupMemory, authority);
  const sanitizedRecall = {
    startupMemory: sanitizedStartupMemory,
    memoryRecall: cronSafeMemoryRecall,
  };
  const compiledContextInput = composeTransportMemoryInputs({
    ...input,
    startupMemory: sanitizedRecall.startupMemory,
    memoryRecall: sanitizedRecall.memoryRecall,
  });
  const compiledContext = compileAgentContextArtifact(compiledContextInput);
  const diagnostics = buildContextDiagnostics({
    authority,
    supportClass,
    artifact: compiledContext,
  });
  if (input.sourceSurface) {
    diagnostics.push(`surface:${input.sourceSurface}`);
  }
  for (const entry of input.namespaceDiagnostics ?? []) {
    if (!diagnostics.includes(entry)) diagnostics.push(entry);
  }
  if (input.startupMemory) {
    if (!cronSafeStartupMemory) {
      diagnostics.push('memory:start:filtered-obsolete-cron-control');
    } else {
      diagnostics.push(sanitizedStartupMemory
        ? (authority.authoritySource === 'processed_remote' && sanitizedStartupMemory.sourceKind === 'local_processed'
            ? 'memory:start:local-auxiliary'
            : 'memory:start')
        : 'memory:start:suppressed-authority');
    }
  }
  if (input.memoryRecall) {
    if (!cronSafeMemoryRecall) diagnostics.push('memory:message:filtered-obsolete-cron-control');
    else diagnostics.push(authority.authoritySource === 'processed_local' ? 'memory:message' : 'memory:message:local-auxiliary');
  }
  const recallInjectionSurface: MemoryRecallInjectionSurface = supportClass === 'degraded-message-side-context-mapping'
    ? 'degraded-message-side'
    : 'normalized-payload';
  const startupMemory = sanitizedRecall.startupMemory
    ? { ...sanitizedRecall.startupMemory, injectionSurface: recallInjectionSurface }
    : undefined;
  const memoryRecall = sanitizedRecall.memoryRecall
    ? { ...sanitizedRecall.memoryRecall, injectionSurface: recallInjectionSurface }
    : undefined;
  return {
    userMessage: input.userMessage,
    assembledMessage: renderAssembledMessage(input.userMessage, compiledContext.messagePreamble),
    ...(input.deliveryId?.trim() ? { deliveryId: input.deliveryId.trim() } : {}),
    ...(input.activityGeneration ? { activityGeneration: input.activityGeneration } : {}),
    sessionSystemText: compiledContext.sessionSystemText,
    turnSystemText: compiledContext.turnSystemText,
    ...(input.sessionIdentity?.role ? { sessionRole: input.sessionIdentity.role } : {}),
    systemText: compiledContext.systemText,
    messagePreamble: compiledContext.messagePreamble,
    attachments: input.attachments,
    ...(startupMemory ? { startupMemory } : {}),
    ...(memoryRecall ? { memoryRecall } : {}),
    context: compiledContext,
    authority,
    supportClass,
    diagnostics,
  };
}

/**
 * The cron wrapper's authority lives in the permanent provider system prompt.
 * Historical projections about that wrapper are therefore never valid
 * authority, even when they record a prior agent refusal or repeat a user's
 * question.  Injecting those projections message-side created a feedback loop:
 * a weak model called the wrapper prompt injection, memory summarized that
 * answer, and the next turn cited the summary as proof.
 *
 * Rebuild from structured items whenever the wrapper appears.  An artifact
 * whose rendered text mentions the wrapper but whose items do not is
 * incoherent, so fail closed instead of forwarding unbound text.
 */
function filterObsoleteCronControlMemory(
  artifact: TransportMemoryRecallArtifact | undefined,
): TransportMemoryRecallArtifact | undefined {
  if (!artifact) return undefined;
  const marker = CRON_CONTROL_PROTOCOL.TAG_NAME.toLowerCase();
  const mentionsMarker = (value: string): boolean => value.toLowerCase().includes(marker);
  const retainedItems = artifact.items.filter((item) => !mentionsMarker(item.summary));
  const removedItem = retainedItems.length !== artifact.items.length;
  const renderedMentionsMarker = mentionsMarker(artifact.injectedText);
  if (!removedItem && !renderedMentionsMarker) return artifact;
  if (!removedItem || retainedItems.length === 0) return undefined;
  return {
    ...artifact,
    items: retainedItems,
    injectedText: artifact.reason === 'startup'
      ? buildStartupProjectMemoryText(attachMemoryShortRefs(retainedItems))
      : buildRelatedPastWorkText(attachMemoryShortRefs(retainedItems)),
    sourceKind: resolveRecallSourceKind(retainedItems),
  };
}

function filterStartupMemoryForAuthority(
  startupMemory: TransportMemoryRecallArtifact | undefined,
  authority: ContextAuthorityDecision,
): TransportMemoryRecallArtifact | undefined {
  if (!startupMemory) return undefined;
  if (authority.authoritySource === 'processed_local') return startupMemory;
  if (authority.authoritySource !== 'processed_remote') return undefined;
  const remoteItems = startupMemory.items.filter((item) => (
    item.sourceKind === 'remote_processed'
    || (!item.sourceKind && startupMemory.sourceKind === 'remote_processed')
  ));
  if (remoteItems.length === 0) {
    return authority.namespace.scope === 'personal' ? startupMemory : undefined;
  }
  return {
    ...startupMemory,
    authoritySource: 'processed_remote',
    sourceKind: resolveRecallSourceKind(remoteItems),
    items: remoteItems,
    injectedText: buildStartupProjectMemoryText(attachMemoryShortRefs(remoteItems)),
  };
}

function resolveRecallSourceKind(items: readonly TransportMemoryRecallItem[]): MemoryRecallSourceKind {
  const hasRemote = items.some((item) => item.sourceKind === 'remote_processed');
  const hasLocal = items.some((item) => item.sourceKind !== 'remote_processed');
  if (hasRemote && hasLocal) return 'mixed_processed';
  if (hasRemote) return 'remote_processed';
  return 'local_processed';
}

export function resolveTransportDispatchAuthority(
  provider: TransportProvider,
  input: Pick<
    TransportRuntimeAssemblyInput,
    'namespace'
    | 'remoteProcessedFreshness'
    | 'localProcessedFreshness'
    | 'retryExhausted'
    | 'sharedPolicyOverride'
  >,
): EvaluatedTransportDispatchAuthority {
  const namespace = input.namespace ?? {
    scope: 'personal',
    projectId: 'transport-default',
  };
  const supportClass = getProviderSupportClass(provider);
  const sharedPolicyOverride = input.sharedPolicyOverride;
  const allowSharedDegraded = sharedPolicyOverride?.allowDegradedProvider ?? false;
  const authority = evaluateContextAuthority({
    namespace,
    providerSupport: supportClass,
    remoteProcessedFreshness: input.remoteProcessedFreshness,
    localProcessedFreshness: input.localProcessedFreshness,
    retryExhausted: input.retryExhausted,
    allowSharedDegraded,
    allowSharedLocalFallback: sharedPolicyOverride?.allowLocalProcessedFallback ?? false,
  });
  return { supportClass, authority };
}

function resolveTransportRuntimeAssemblyInput(
  input: TransportRuntimeAssemblyInput,
  options?: DispatchSharedContextSendOptions,
) : Promise<TransportRuntimeAssemblyInput> {
  if (input.authoredContext || !options?.resolveAuthoredContext) return Promise.resolve(input);
  return options.resolveAuthoredContext(input).then((authoredContext) => ({
    ...input,
    authoredContext,
  }));
}

export function compileAgentContextArtifact(input: TransportRuntimeAssemblyInput): CompiledAgentContextArtifact {
  const authoredContext = selectRuntimeAuthoredContext({
    bindings: input.authoredContext ?? [],
    repository: input.authoredContextRepository,
    language: input.authoredContextLanguage,
    filePath: input.authoredContextFilePath,
    maxRequiredChars: input.maxRequiredAuthoredChars,
    maxAdvisoryChars: input.maxAdvisoryAuthoredChars,
  });
  const hasRequiredBindings = (input.authoredContext ?? []).some(
    (binding) => binding.mode === 'required' && binding.active !== false && !binding.superseded,
  );
  if (hasRequiredBindings && authoredContext.required.length === 0) {
    throw new SharedContextDispatchError({
      code: 'SHARED_CONTEXT_REQUIRED_AUTHORED_CONTEXT_UNAVAILABLE',
      message: 'Required authored context could not be preserved in the compiled payload',
      recoverable: false,
      details: {
        diagnostics: authoredContext.diagnostics,
      },
    });
  }
  const renderedAuthoredSystemText = renderAuthoredSystemText(authoredContext.required, authoredContext.advisory);
  const memorySearchGuidance = input.suppressMcpMemorySearchGuidance ? undefined : MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE;
  const capabilityGuidance = input.suppressMcpMemorySearchGuidance ? undefined : CAPABILITY_AI_SYSTEM_INSTRUCTIONS;
  const mcpToolRefreshGuidance = input.suppressMcpMemorySearchGuidance
    ? undefined
    : MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS;
  const agentProgressGuidance = input.suppressAgentProgressGuidance ? undefined : AGENT_PROGRESS_SYSTEM_GUIDANCE;
  const filePathReportingGuidance = input.suppressFilePathReportingGuidance ? undefined : buildFilePathReportingPrompt();
  const realDeviceTestingGuidance = input.suppressMcpMemorySearchGuidance
    ? undefined
    : REAL_DEVICE_TESTING_SYSTEM_GUIDANCE;
  // Any session can audit, implement or orchestrate an audit, and audit messages
  // reference this contract by id only -- so its body belongs to the stable
  // system prompt of every managed session, never to a message.
  const auditConvergenceContract = input.suppressMcpMemorySearchGuidance
    ? undefined
    : AUDIT_CONVERGENCE_SYSTEM_CONTRACT;
  // Task-pair markers are the supervision protocol of the default `pairs`
  // engine; like the audit contract, messages reference it by id only.
  const taskPairContract = input.suppressMcpMemorySearchGuidance
    ? undefined
    : TASK_PAIR_SYSTEM_CONTRACT;
  // Execution authority is not optional MCP guidance. Keep it in the
  // provider's system/developer channel even for slash-control turns.
  const cronControlTrustedSystemClause = CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE;
  const automaticSupervision = input.automaticSupervisionEnabled === true;
  const brainDelegationContract = input.sessionIdentity?.role === 'brain'
    ? (input.brainContractRegistered
      ? buildBrainWorkDelegationContractRef(automaticSupervision)
      : automaticSupervision
        ? buildBrainSupervisedWorkDelegationContract()
        : buildBrainManualOnlyDelegationContract())
    : undefined;
  // Daemon-injected, session-stable identity block. NOT subject to
  // `USER_SESSION_TEXT_MAX_CHARS` — encodes IM.codes runtime behaviour
  // the model must always follow. p2p audit 37bfbb85-430 N-A: this used
  // to be folded into `systemPrompt` by session-manager and was then
  // silently truncated by `clampUserSessionText(300)`.
  //
  // The Generated Image Reporting protocol used to ride alongside the
  // identity block here, but it only applies to providers with native
  // image generation (currently Codex only). It now lives in Codex
  // SDK's `appendImcodesBaseInstructions` — sent once per thread, in
  // baseInstructions tail, picked up by prefix cache, zero cost for
  // non-Codex providers.
  const identityPart = input.sessionIdentity
    ? buildTransportImcodesIdentityPrompt(
        input.sessionIdentity.sessionName,
        input.sessionIdentity.label ?? undefined,
        input.sessionIdentity.role,
      )
    : undefined;
  // The identity span is recorded here, from the lengths of the parts being
  // joined, so providers with a context budget can shrink exactly the identity
  // body. It must never be recovered later by searching this string: the
  // description, system prompt and authored turn context are user-authored and may
  // contain forged identity delimiters.
  const identitySegment = input.identityPrompt?.trim();
  const composedSessionSystemText = joinSpanned([
    capabilityGuidance,
    mcpToolRefreshGuidance,
    cronControlTrustedSystemClause,
    brainDelegationContract,
    input.registeredSystemContractText,
    input.description?.trim(),
    input.systemPrompt?.trim(),
    identitySegment ? { text: identitySegment, identity: identitySpanForSegment(identitySegment) } : undefined,
    identityPart,
    filePathReportingGuidance,
    realDeviceTestingGuidance,
    auditConvergenceContract,
    taskPairContract,
    memorySearchGuidance,
    agentProgressGuidance,
  ], '\n\n');
  const sessionSystemText = composedSessionSystemText?.text;
  const sessionSystemTextIdentity = composedSessionSystemText?.identity;
  // Baseline delegation and registered IM.codes contracts are hard rules.
  // They belong to the provider system/developer channel, never in user text.
  //
  // It used to be deliberately independent of supervision.mode, on the theory
  // that with supervision off the Brain would "simply attach no auditPolicy and
  // run no audit lifecycle". Nothing enforced that: the contract is a set of
  // duties (delegate instead of implement, mint a task assignment, personally
  // repair blocked lifecycles), and a supervision-off Brain obeyed them -- on a
  // daily cron it minted a task, looped on recovery and dispatched its own audit.
  // Automatic supervision is now decided by the same single authority every
  // other automatic supervision action already asks. A supervision-off Brain
  // keeps what the baseline exists for (delegate through IM.codes, never
  // provider-native) and loses everything automatic; supervised work remains
  // available when a user explicitly arranges it.
  //
  // Authored turn context remains turn-scoped. It is not IM.codes authority.
  const turnSystemText = renderedAuthoredSystemText || undefined;
  return {
    sessionSystemText,
    ...(sessionSystemTextIdentity ? { sessionSystemTextIdentity } : {}),
    turnSystemText,
    systemText: [sessionSystemText, turnSystemText].filter(Boolean).join('\n\n') || undefined,
    messagePreamble: input.messagePreamble?.trim() || undefined,
    requiredAuthoredContext: authoredContext.required,
    advisoryAuthoredContext: authoredContext.advisory,
    appliedDocumentVersionIds: authoredContext.appliedDocumentVersionIds,
    diagnostics: authoredContext.diagnostics,
  };
}

function composeTransportMemoryInputs(input: TransportRuntimeAssemblyInput): TransportRuntimeAssemblyInput {
  const startupMemoryText = input.startupMemory?.injectedText?.trim();
  const memoryRecallText = input.memoryRecall?.injectedText?.trim();
  const uniqueMessagePreambleParts = dedupeTransportMemorySections([
    input.messagePreamble?.trim(),
    startupMemoryText,
    memoryRecallText,
  ]);
  const uniqueSystemPromptParts = dedupeTransportMemorySections([
    input.systemPrompt?.trim(),
  ]);
  return {
    ...input,
    systemPrompt: uniqueSystemPromptParts.join('\n\n') || undefined,
    messagePreamble: uniqueMessagePreambleParts.join('\n\n') || undefined,
  };
}

function dedupeTransportMemorySections(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const part of parts) {
    const trimmed = part?.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
}

export function getProviderSupportClass(provider: TransportProvider): ProviderSupportClass {
  return provider.capabilities.contextSupport ?? 'full-normalized-context-injection';
}

function renderAssembledMessage(userMessage: string, messagePreamble?: string): string {
  const preamble = messagePreamble?.trim();
  const message = userMessage.trim();
  if (!preamble) return userMessage;
  if (!message) return preamble;
  return `${preamble}\n\n${message}`;
}

function renderAuthoredSystemText(required: string[], advisory: string[]): string | undefined {
  const sections: string[] = [];
  if (required.length > 0) {
    sections.push(renderAuthoredSection('Required shared context', required));
  }
  if (advisory.length > 0) {
    sections.push(renderAuthoredSection('Advisory shared context', advisory));
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function renderAuthoredSection(title: string, entries: string[]): string {
  const lines = [title + ':'];
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  return lines.join('\n');
}

function enforceDispatchAuthority(payload: ProviderContextPayload): void {
  if (payload.supportClass === 'unsupported') {
    throw new SharedContextDispatchError({
      code: 'SHARED_CONTEXT_PROVIDER_UNSUPPORTED',
      message: 'Provider does not support the normalized shared-context contract',
      recoverable: false,
      details: { diagnostics: payload.diagnostics },
    }, payload);
  }
  if (payload.authority.retryScheduled) {
    throw new SharedContextDispatchError({
      code: 'SHARED_CONTEXT_RETRY_SCHEDULED',
      message: 'Shared context authority is not ready; retry has been scheduled',
      recoverable: true,
      details: { diagnostics: payload.diagnostics },
    }, payload);
  }
  if (payload.authority.authoritySource === 'none' && !payload.authority.fallbackAllowed) {
    throw new SharedContextDispatchError({
      code: 'SHARED_CONTEXT_AUTHORITY_UNAVAILABLE',
      message: 'Shared context authority is unavailable and fallback is not permitted',
      recoverable: false,
      details: { diagnostics: payload.diagnostics },
    }, payload);
  }
}
