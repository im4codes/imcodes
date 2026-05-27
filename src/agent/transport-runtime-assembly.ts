import type { TransportProvider } from './transport-provider.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';
import { selectRuntimeAuthoredContext } from './authored-context.js';
import { evaluateContextAuthority } from './context-authority.js';
import { buildContextDiagnostics } from './context-diagnostics.js';
import { getSharedContextCutoverFlags, type SharedContextCutoverFlags } from '../context/shared-context-flags.js';
import type { ProviderError } from './transport-provider.js';
import { incrementCounter } from '../util/metrics.js';
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
import { buildStartupProjectMemoryText } from '../../shared/memory-recall-format.js';
import { buildTransportImcodesIdentityPrompt } from '../../shared/transport-runtime-prompts.js';

export interface TransportRuntimeAssemblyInput {
  userMessage: string;
  description?: string;
  systemPrompt?: string;
  suppressMcpMemorySearchGuidance?: boolean;
  suppressAgentProgressGuidance?: boolean;
  messagePreamble?: string;
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
  sessionIdentity?: { sessionName: string; label?: string | null };
}

export const MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE = [
  'Use memory MCP search when the user asks about prior work, project history, past decisions, preferences, bugs, commits, deployments, or previously discussed context.',
  'Before answering those requests, call search_memory with a concise query based on the user message and current project.',
  'After search_memory, inspect each hit\'s sourceLookup object. If a relevant hit may affect the answer and its summary is not enough, call get_memory_sources with the returned sourceLookup fields before answering. If startup memory gives only a compact ref such as obs:abc123, call get_memory_sources with that ref.',
  'Use get_memory_sources for exact prior instructions, decisions, preferences, bug details, commit/deployment facts, or provenance-sensitive answers; do not invent details from summaries alone.',
  'Do not call memory for bare control messages like "continue", "go on", "ok", "yes", "commit", "push", "run tests", or other short commands without searchable context.',
].join('\n');

const AGENT_PROGRESS_SYSTEM_GUIDANCE = [
  'Work transparently while you act.',
  'For non-trivial tasks, briefly state what you are checking or changing before long scans, edits, tests, or waits.',
  'Keep updates short and useful; do not narrate every tiny step.',
  'Continue working without asking for confirmation unless blocked or the user asked for a plan first.',
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
  const sanitizedStartupMemory = filterStartupMemoryForAuthority(input.startupMemory, authority);
  const sanitizedRecall = {
    startupMemory: sanitizedStartupMemory,
    memoryRecall: input.memoryRecall,
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
    diagnostics.push(sanitizedStartupMemory
      ? (authority.authoritySource === 'processed_remote' && sanitizedStartupMemory.sourceKind === 'local_processed'
          ? 'memory:start:local-auxiliary'
          : 'memory:start')
      : 'memory:start:suppressed-authority');
  }
  if (input.memoryRecall) diagnostics.push(authority.authoritySource === 'processed_local' ? 'memory:message' : 'memory:message:local-auxiliary');
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
    sessionSystemText: compiledContext.sessionSystemText,
    turnSystemText: compiledContext.turnSystemText,
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
    injectedText: buildStartupProjectMemoryText(remoteItems),
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
  const agentProgressGuidance = input.suppressAgentProgressGuidance ? undefined : AGENT_PROGRESS_SYSTEM_GUIDANCE;
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
      )
    : undefined;
  const sessionSystemText = [
    input.description?.trim(),
    input.systemPrompt?.trim(),
    identityPart,
    memorySearchGuidance,
    agentProgressGuidance,
  ].filter(Boolean).join('\n\n') || undefined;
  const turnSystemText = renderedAuthoredSystemText;
  return {
    sessionSystemText,
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
