import { ProviderStopConfirmation } from '../provider-stop-confirmation.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenCodeEvent } from '@opencode/sdk';
import type {
  ApprovalRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  RemoteSessionInfo,
  RemoteSessionListOptions,
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
  ProviderDelegationNotification,
  ProviderCancelOptions,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_CANCEL_ORIGINS,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { isTransientRequestFailure } from '../../../shared/request-failure.js';
import {
  CRON_CONTROL_PROTOCOL,
  isCronSilentResult,
} from '../../../shared/cron-types.js';
import { composeProviderSystemText } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import logger from '../../util/logger.js';
import { imcodesStatePath } from '../../util/imcodes-state-dir.js';
import { NativeAgentFenceSlot, OPENCODE_NATIVE_AGENT_TOOLS, fenceOf } from '../native-agent-fence.js';
import {
  NATIVE_AGENT_ADMISSION_MODES,
  NATIVE_AGENT_FENCES,
  type NativeAgentFence,
} from '../../../shared/native-collaboration-policy.js';
import type { NativeAgentFenceResolver } from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { InteractiveQuestionAnswerer } from '../pending-question-registry.js';
import {
  parseAskQuestionAnswers,
  type AskQuestionItem,
} from '../../../shared/ask-question-normalize.js';
import { INTERACTIVE_QUESTION_TOOL_NAME } from '../../../shared/codex-user-input.js';
import {
  OPENCODE_SDK_EFFORT_LEVELS,
  clampTransportEffort,
  normalizeSupportedEffortLevels,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';

const LOOPBACK_HOST = '127.0.0.1';
const MODEL_CACHE_TTL_MS = 30_000;
const PLUGIN_WARMUP_MAX_WAIT_MS = 4_000;
const PLUGIN_WARMUP_POLL_MS = 75;
// OpenCode loads its models.dev catalog (including each model's `limit.context`)
// asynchronously after an OpenCode host starts. A session created in that window
// primes the model→context-window map from a catalog that still lacks limits,
// so usage frames ship without an authoritative window and the UI falls back to
// a 1M guess. When a live usage frame can't resolve its model's window we force
// one throttled catalog refetch so the next frame self-heals.
const CONTEXT_WINDOW_REFRESH_MIN_INTERVAL_MS = 3_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPTANCE_RECHECK_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
const MISSING_FINAL_RECOVERY_TIMEOUT_MS = 15_000;
const MISSING_FINAL_RECOVERY_RECHECK_DELAYS_MS = [250, 1_000] as const;
const IMCODES_SYSTEM_INSTRUCTION_KEY = 'imcodes-system';
type PromptAcceptance = 'accepted' | 'absent' | 'unknown';
const OPENCODE_PERMISSION_EVENT = {
  ASKED: 'permission.asked',
  V2_ASKED: 'permission.v2.asked',
  LEGACY_UPDATED: 'permission.updated',
} as const;
const MISSING_FINAL_RECOVERY_PROMPT = [
  'The previous tool step finished, but you returned no final response.',
  "Continue from the existing results and answer the user's original request now.",
  'Do not repeat completed tool calls unless the existing result is insufficient.',
].join(' ');

export interface OpenCodeSessionInfoLike {
  id: string;
  title?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

export interface OpenCodeProviderInfoLike {
  id: string;
  name?: string;
  activation?: string;
}

export interface OpenCodeModelInfoLike {
  id?: string;
  modelID: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  type?: string;
  limit?: { context?: number; output?: number };
  variants?: Array<{ id?: string; name?: string; disabled?: boolean }>;
  capabilities?: { reasoning?: boolean };
}

export interface OpenCodeClientLike {
  sessions: {
    create(input: {
      location: { directory: string };
      title?: string;
      permissions?: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>;
    }): Promise<OpenCodeSessionInfoLike>;
    get(input: { sessionID: string }): Promise<OpenCodeSessionInfoLike>;
    prompt(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  session: {
    list(input?: { directory?: string }): Promise<{ data?: OpenCodeSessionInfoLike[]; cursor?: unknown }>;
    switchModel(input: {
      sessionID: string;
      model: { providerID: string; id: string; variant?: string };
    }): Promise<void>;
    compact(input: { sessionID: string }): Promise<Record<string, unknown>>;
    interrupt(input: { sessionID: string }): Promise<{ interrupted?: boolean } | void>;
    message: {
      get(input: { sessionID: string; messageID: string }): Promise<Record<string, unknown>>;
    };
    form?: {
      reply(input: {
        sessionID: string;
        formID: string;
        answer: Record<string, string | number | boolean | string[]>;
      }): Promise<void>;
      cancel(input: { sessionID: string; formID: string }): Promise<void>;
    };
  };
  message: {
    list(input: {
      sessionID: string;
      limit?: number;
      order?: 'asc' | 'desc';
    }): Promise<{ data?: Array<Record<string, unknown>>; cursor?: unknown }>;
  };
  model: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeModelInfoLike[] }>;
    default(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeModelInfoLike | null }>;
  };
  provider: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeProviderInfoLike[] }>;
  };
  permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'always' | 'reject';
    }): Promise<void>;
  };
  events: {
    subscribe(
      options?: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal },
    ): AsyncIterable<OpenCodeEvent | Record<string, unknown>> | Promise<AsyncIterable<OpenCodeEvent | Record<string, unknown>> | { stream: AsyncIterable<OpenCodeEvent | Record<string, unknown>> }>;
  };
  experimental?: {
    session?: {
      instructions?: {
        entry?: {
          put(input: { sessionID: string; key: string; value: string }): Promise<void>;
          remove(input: { sessionID: string; key: string }): Promise<void>;
        };
      };
      wait?(input: { sessionID: string }): Promise<void>;
    };
  };
  plugin?: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: Array<Record<string, unknown>> }>;
  };
  close?: () => Promise<void> | void;
}

interface OpenCodeServerLike {
  url: string;
  close(): void;
}

export interface OpenCodeSdkStartOptions {
  hostname: string;
  port: number;
  timeout: number;
  signal: AbortSignal;
  config?: Record<string, unknown>;
  databasePath?: string;
  directory?: string;
  warmupCatalog?: boolean;
}

export interface OpenCodeSdkRuntimeHooks {
  start(options: OpenCodeSdkStartOptions): Promise<{
    client: OpenCodeClientLike;
    server: OpenCodeServerLike;
  }>;
}

export const openCodeSdkRuntimeHooks: OpenCodeSdkRuntimeHooks = {
  async start(options) {
    // Dynamic import keeps the controlled-node thin bundle free of `@opencode/sdk` native addons.
    const { OpenCode } = await import('@opencode/sdk');
    if (options.signal.aborted) {
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const dbPath = options.databasePath?.trim()
      || process.env.IMCODES_OPENCODE_DB_PATH?.trim()
      || imcodesStatePath('opencode-sdk.db');
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
    }

    const content = options.config
      ? JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...options.config })
      : undefined;

    const opencode = await OpenCode.create({
      database: { path: dbPath },
      fs: { filewatcher: false },
      ...(content ? { config: { content } } : {}),
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void opencode.close().catch(() => {});
    };
    if (options.signal.aborted) {
      close();
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    options.signal.addEventListener('abort', close, { once: true });

    if (options.warmupCatalog) {
      // `PluginSupervisor` registers internal provider/model plugins asynchronously
      // after `OpenCode.create()` returns; poll the target location so initial `listModels()`
      // sees the populated catalog immediately after `connect()`.
      const warmupLocation = { directory: safeString(options.directory) ?? process.cwd() };
      const warmupMs = Math.min(options.timeout || 10_000, PLUGIN_WARMUP_MAX_WAIT_MS);
      const deadline = Date.now() + warmupMs;
      while (Date.now() < deadline && !options.signal.aborted) {
        try {
          const [providersRes, modelsRes] = await Promise.all([
            opencode.provider.list({ location: warmupLocation }),
            opencode.model.list({ location: warmupLocation }),
          ]);
          if ((providersRes?.data?.length ?? 0) > 0 && (modelsRes?.data?.length ?? 0) > 0) break;
        } catch {
          break;
        }
        await sleep(PLUGIN_WARMUP_POLL_MS);
      }
    }

    return {
      client: opencode as unknown as OpenCodeClientLike,
      server: { url: `http://${LOOPBACK_HOST}:${options.port}`, close },
    };
  },
};

interface NormalizedOpenCodePermission {
  id: string;
  operation?: string;
  title?: string;
  pattern?: string;
  callId?: string;
}

interface PendingOpenCodeForm {
  requestId: string;
  questions: AskQuestionItem[];
  fields: Array<{ key: string; type: string }>;
  callId?: string;
}

interface OpenCodeModelReasoningMeta {
  supportsReasoning: boolean;
  supportedEffortLevels?: readonly TransportEffortLevel[];
  variantKeys: readonly string[];
}

interface OpenCodeSessionState {
  routeId: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  effort?: TransportEffortLevel;
  appliedModelSignature: string | null;
  systemInstructionSet: boolean;
  busy: boolean;
  compacting: boolean;
  compactCompletionEmitted: boolean;
  generation: number;
  cancelled: boolean;
  completionEmitted: boolean;
  terminalErrorEmitted: boolean;
  missingFinalRecoveryAttempted: boolean;
  missingFinalRecoveryInFlight: boolean;
  cronControlActive: boolean;
  silentToolResult: string | null;
  deliveryMessageId: string | null;
  currentMessageId: string | null;
  textParts: Map<string, string>;
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  toolSignatures: Map<string, string>;
  surfacedQuestionCallIds: Set<string>;
  lastUsageSignature: string | null;
  lastUsage: ProviderUsageUpdate['usage'];
  lastUsageMessageId: string | null;
  client: OpenCodeClientLike;
  server: OpenCodeServerLike;
  abort: AbortController;
  eventLoop: Promise<void>;
  pendingPermissions: Map<string, ReturnType<typeof setTimeout>>;
  runtimeConfig: SessionConfig;
  /** The native-agent fence this session's own OpenCode runtime was started with. */
  nativeAgentFence: NativeAgentFence;
}

class OpenCodeRequestTimeoutError extends Error {
  constructor(operation: string) {
    super(`OpenCode ${operation} timed out after ${MISSING_FINAL_RECOVERY_TIMEOUT_MS}ms`);
    this.name = 'OpenCodeRequestTimeoutError';
  }
}

function withOpenCodeRequestTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OpenCodeRequestTimeoutError(operation)),
      MISSING_FINAL_RECOVERY_TIMEOUT_MS,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorHttpStatus(error: unknown): number | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.status === 'number' && Number.isFinite(record.status)) return record.status;
    if (record.cause !== undefined) pending.push(record.cause);
  }
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  if (errorHttpStatus(error) === 404) return true;
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.includes('NotFound')) return true;
  }
  const msg = errorMessage(error);
  return /\b404\b/.test(msg) || /\bnot found\b/i.test(msg);
}

function openCodePromptMessageId(providerSessionId: string, deliveryId: string | undefined): string {
  const stableInput = deliveryId?.trim() || randomUUID();
  const digest = createHash('sha256')
    .update(providerSessionId)
    .update('\0')
    .update(stableInput)
    .digest('hex')
    .slice(0, 26);
  return `msg_${digest}`;
}

function openCodeRecoveryMessageId(providerSessionId: string, deliveryMessageId: string): string {
  return openCodePromptMessageId(providerSessionId, `${deliveryMessageId}\0missing-final-recovery`);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isTerminalFinish(finish: unknown): boolean {
  const normalized = safeString(finish)?.toLowerCase();
  // OpenCode finishes each intermediate tool-call step with `tool-calls` (or `unknown`).
  // Only an explicit terminal finish ends the turn; `session.execution.succeeded` and
  // `session.idle` remain the fallback for steps omitting a terminal finish.
  return normalized !== undefined && normalized !== 'tool-calls' && normalized !== 'unknown';
}

function isTerminalAssistantMessage(msg: Record<string, any> | undefined): boolean {
  if (!msg || msg.type !== 'assistant') return false;
  if (msg.error) return true;
  return isTerminalFinish(msg.finish);
}

function sessionIdFromEvent(event: Record<string, any>): string | undefined {
  const data = event.data ?? event.properties;
  return safeString(data?.sessionID)
    ?? safeString(data?.form?.sessionID)
    ?? safeString(data?.part?.sessionID)
    ?? safeString(data?.info?.sessionID);
}

function permissionPattern(value: unknown): string | undefined {
  if (!Array.isArray(value)) return safeString(value);
  const items = value.map(safeString).filter((item): item is string => item !== undefined);
  return items.length > 0 ? items.join(', ') : undefined;
}

function normalizePermissionEvent(
  eventType: unknown,
  payload: Record<string, any> | undefined,
): NormalizedOpenCodePermission | undefined {
  const id = safeString(payload?.id);
  if (!id) return undefined;
  if (eventType === OPENCODE_PERMISSION_EVENT.ASKED) {
    return {
      id,
      operation: safeString(payload?.action) ?? safeString(payload?.permission),
      title: safeString(payload?.message),
      pattern: permissionPattern(payload?.resources ?? payload?.patterns),
      callId: safeString(payload?.source?.callID ?? payload?.tool?.callID),
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.V2_ASKED) {
    return {
      id,
      operation: safeString(payload?.action),
      title: safeString(payload?.message),
      pattern: permissionPattern(payload?.resources),
      callId: safeString(payload?.source?.callID),
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED) {
    return {
      id,
      operation: safeString(payload?.type),
      title: safeString(payload?.title),
      pattern: permissionPattern(payload?.pattern),
      callId: safeString(payload?.callID),
    };
  }
  return undefined;
}

function normalizeFormToQuestions(form: Record<string, any> | undefined): {
  requestId: string;
  questions: AskQuestionItem[];
  fields: Array<{ key: string; type: string }>;
} | undefined {
  const requestId = safeString(form?.id);
  if (!requestId || !Array.isArray(form?.fields) || form.fields.length === 0) return undefined;
  const header = safeString(form.title) ?? 'Question';
  const questions: AskQuestionItem[] = [];
  const fields: Array<{ key: string; type: string }> = [];
  for (const field of form.fields) {
    if (!field || typeof field !== 'object') continue;
    const key = safeString(field.key);
    const type = safeString(field.type) ?? 'string';
    if (!key) continue;
    const questionText = safeString(field.title) ?? safeString(field.description) ?? key;
    const rawOptions: unknown[] | undefined = Array.isArray(field.options) ? field.options : undefined;
    const mappedOptions = rawOptions
      ?.map((opt: any): { label: string; description?: string } | undefined => {
        const label = safeString(opt?.label ?? opt?.value ?? opt);
        if (!label) return undefined;
        const description = safeString(opt?.description);
        return description ? { label, description } : { label };
      })
      .filter((item): item is { label: string; description?: string } => item !== undefined);
    const options = mappedOptions && mappedOptions.length > 0 ? mappedOptions : undefined;
    questions.push({
      header,
      question: questionText,
      ...(options ? { options } : {}),
      ...(type === 'multiselect' ? { multiSelect: true } : {}),
    });
    fields.push({ key, type });
  }
  if (questions.length === 0) return undefined;
  return { requestId, questions, fields };
}

function formatFormAnswerRecord(
  fields: Array<{ key: string; type: string }>,
  parsedAnswers: string[][],
  rawFallback: string,
): Record<string, string | number | boolean | string[]> {
  const record: Record<string, string | number | boolean | string[]> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const selected = parsedAnswers[i] ?? [];
    if (field.type === 'multiselect') {
      record[field.key] = selected;
    } else if (field.type === 'boolean') {
      const token = (selected[0] ?? rawFallback).trim().toLowerCase();
      record[field.key] = token === 'true' || token === 'yes' || token === '1' || token === 'y';
    } else if (field.type === 'number' || field.type === 'integer') {
      const raw = selected[0] ?? rawFallback;
      const num = Number(raw);
      record[field.key] = Number.isFinite(num) ? num : raw;
    } else {
      record[field.key] = selected[0] ?? rawFallback;
    }
  }
  return record;
}

function parseModelIdentity(value: string | undefined): { providerID: string; modelID: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function extractModelReasoningMeta(model: Record<string, any> | undefined): OpenCodeModelReasoningMeta {
  const disabledVariants = new Set<string>();
  const variantKeys: string[] = [];
  if (Array.isArray(model?.variants)) {
    for (const variant of model.variants) {
      const id = safeString(typeof variant === 'string' ? variant : variant?.id);
      if (!id) continue;
      if (variant && typeof variant === 'object' && variant.disabled === true) {
        disabledVariants.add(id);
        continue;
      }
      variantKeys.push(id);
    }
  } else if (model?.variants && typeof model.variants === 'object') {
    for (const [key, value] of Object.entries(model.variants as Record<string, any>)) {
      const normalizedKey = safeString(key);
      if (!normalizedKey) continue;
      if (value && typeof value === 'object' && (value as Record<string, unknown>).disabled === true) {
        disabledVariants.add(normalizedKey);
        continue;
      }
      variantKeys.push(normalizedKey);
    }
  }

  const effortValues: string[] = [];
  if (Array.isArray(model?.reasoning_options)) {
    for (const option of model.reasoning_options) {
      if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
      for (const value of option.values) {
        const normalizedValue = safeString(value);
        if (!normalizedValue || disabledVariants.has(normalizedValue)) continue;
        effortValues.push(normalizedValue);
      }
    }
  }

  const combinedKeys = [...new Set([...effortValues, ...variantKeys])];
  const supportedEffortLevels = normalizeSupportedEffortLevels(combinedKeys);
  const supportsReasoning = Boolean(
    model?.capabilities?.reasoning
    || model?.reasoning
    || combinedKeys.length > 0
    || (supportedEffortLevels && supportedEffortLevels.length > 0),
  );

  return {
    supportsReasoning,
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    variantKeys: combinedKeys,
  };
}

function extractToolContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (typeof record.text === 'string') {
      parts.push(record.text);
    } else {
      try { parts.push(JSON.stringify(record)); } catch { /* ignore */ }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function providerError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
  return { code, message, recoverable, ...(details === undefined ? {} : { details }) };
}

function promptFiles(attachments: TransportAttachment[] | undefined): Array<{
  uri: string;
  source: { type: 'uri'; uri: string };
  name?: string;
}> {
  return (attachments ?? []).map((attachment) => {
    const uri = pathToFileURL(attachment.daemonPath).href;
    return {
      uri,
      source: { type: 'uri' as const, uri },
      ...(attachment.originalName ? { name: attachment.originalName } : {}),
    };
  });
}

function textPartKey(messageId: unknown, ordinal: unknown): string {
  const msg = safeString(messageId) ?? 'assistant';
  const ord = typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : 0;
  return `${msg}:${ord}`;
}

export class OpenCodeSdkProvider implements TransportProvider, InteractiveQuestionAnswerer {
  readonly id = 'opencode-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: true,
    supportedEffortLevels: OPENCODE_SDK_EFFORT_LEVELS,
    contextSupport: 'full-normalized-context-injection',
    compact: {
      execution: 'sdk-rpc',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: true,
    },
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    restartDurableDeliveryId: {
      restartDurable: true,
      replayAfterAcceptance: 'deduplicated',
    },
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
  };

  private client: OpenCodeClientLike | null = null;
  private server: OpenCodeServerLike | null = null;
  private lifecycleAbort: AbortController | null = null;
  private databasePath: string | undefined;
  private catalogDirectory = process.cwd();
  private sessions = new Map<string, OpenCodeSessionState>();
  private readonly pendingQuestions = new Map<string, PendingOpenCodeForm>();
  private readonly nativeAgentFence = new NativeAgentFenceSlot('opencode-sdk');
  private providerToRoute = new Map<string, string>();
  private providerRouteOrder = new Map<string, string[]>();
  private modelCache: { at: number; value: ProviderModelList } | null = null;
  private modelContextWindows = new Map<string, number>();
  private modelReasoningMeta = new Map<string, OpenCodeModelReasoningMeta>();
  private lastContextWindowRefreshAt = 0;
  private contextWindowRefreshInFlight = false;
  private approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private approvalCallbacks: Array<(sessionId: string, request: ApprovalRequest) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, usage: ProviderUsageUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    if (this.client && this.server) return;
    const abort = new AbortController();
    const port = positiveNumber(config.port) || 0;
    const timeout = positiveNumber(config.startupTimeoutMs) || 10_000;
    const databasePath = safeString(config.databasePath);
    const catalogDirectory = safeString(config.cwd) ?? process.cwd();
    this.databasePath = databasePath;
    this.catalogDirectory = catalogDirectory;
    try {
      const started = await openCodeSdkRuntimeHooks.start({
        hostname: LOOPBACK_HOST,
        port,
        timeout,
        signal: abort.signal,
        directory: catalogDirectory,
        warmupCatalog: true,
        ...(databasePath ? { databasePath } : {}),
      });
      const url = new URL(started.server.url);
      if (url.hostname !== LOOPBACK_HOST && url.hostname !== 'localhost' && url.hostname !== '::1') {
        started.server.close();
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK server did not bind to loopback', false);
      }
      this.client = started.client;
      this.server = started.server;
      this.lifecycleAbort = abort;
      this.approvalTimeoutMs = positiveNumber(config.approvalTimeoutMs) || DEFAULT_APPROVAL_TIMEOUT_MS;
      logger.info({ provider: this.id, server: url.origin }, 'OpenCode SDK provider connected');
    } catch (error) {
      abort.abort();
      this.server?.close();
      this.server = null;
      this.client = null;
      this.lifecycleAbort = null;
      throw this.normalizeError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    const states = [...this.sessions.values()];
    this.sessions.clear();
    this.providerToRoute.clear();
    this.providerRouteOrder.clear();
    for (const state of states) await this.closeSessionState(state);
    this.pendingQuestions.clear();
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    this.server?.close();
    this.server = null;
    this.client = null;
    this.modelCache = null;
    this.modelContextWindows.clear();
    this.modelReasoningMeta.clear();
    this.lastContextWindowRefreshAt = 0;
    this.contextWindowRefreshInFlight = false;
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.client ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.client),
      degradedReasons: [],
    };
  }

  async createSession(config: SessionConfig): Promise<string> {
    this.assertConnected();
    if (!this.modelCache) await this.listModels(false);
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(routeId);
    if (existing && !config.fresh) {
      if (safeString(config.agentId)) existing.model = config.agentId!.trim();
      if (config.effort) existing.effort = config.effort;
      existing.appliedModelSignature = null;
      this.emitSessionInfo(existing);
      return routeId;
    }
    if (existing) await this.endSession(routeId);

    const cwd = safeString(config.cwd) ?? process.cwd();
    const nativeAgentsFenced = this.nativeAgentFence.required(routeId, config.sessionName);
    const sessionRuntime = await this.startSessionRuntime(config, cwd, nativeAgentsFenced);
    let info: Record<string, any>;
    if (config.skipCreate && safeString(config.resumeId)) {
      try {
        info = await sessionRuntime.client.sessions.get({ sessionID: config.resumeId! });
      } catch (error) {
        await this.closeStartedRuntime(sessionRuntime);
        throw this.normalizeError(error, 'restore');
      }
    } else {
      try {
        info = await sessionRuntime.client.sessions.create({
          location: { directory: cwd },
          title: safeString(config.label) ?? config.sessionName ?? config.sessionKey,
          ...(nativeAgentsFenced
            ? {
              permissions: OPENCODE_NATIVE_AGENT_TOOLS.map((action) => ({
                action,
                resource: '*',
                effect: 'deny' as const,
              })),
            }
            : {}),
        });
      } catch (error) {
        await this.closeStartedRuntime(sessionRuntime);
        throw this.normalizeError(error, 'create');
      }
    }
    const providerSessionId = safeString(info?.id);
    if (!providerSessionId) {
      await this.closeStartedRuntime(sessionRuntime);
      throw providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'OpenCode did not return a session ID', false);
    }
    const state: OpenCodeSessionState = {
      routeId,
      providerSessionId,
      cwd,
      model: safeString(config.agentId),
      effort: config.effort,
      appliedModelSignature: null,
      systemInstructionSet: false,
      busy: false,
      compacting: false,
      compactCompletionEmitted: false,
      generation: 0,
      cancelled: false,
      completionEmitted: false,
      terminalErrorEmitted: false,
      missingFinalRecoveryAttempted: false,
      missingFinalRecoveryInFlight: false,
      cronControlActive: false,
      silentToolResult: null,
      deliveryMessageId: null,
      currentMessageId: null,
      textParts: new Map(),
      toolNames: new Map(),
      toolInputs: new Map(),
      toolSignatures: new Map(),
      surfacedQuestionCallIds: new Set(),
      lastUsageSignature: null,
      lastUsage: undefined,
      lastUsageMessageId: null,
      client: sessionRuntime.client,
      server: sessionRuntime.server,
      abort: sessionRuntime.abort,
      eventLoop: Promise.resolve(),
      pendingPermissions: new Map(),
      runtimeConfig: { ...config },
      nativeAgentFence: fenceOf(nativeAgentsFenced),
    };
    this.sessions.set(routeId, state);
    this.registerProviderRoute(providerSessionId, routeId);
    state.eventLoop = this.consumeEvents(sessionRuntime.stream, sessionRuntime.abort.signal);
    if (state.model || state.effort) {
      await this.syncSessionModelAndEffort(state).catch(() => {});
    }
    this.emitSessionInfo(state);
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(state.routeId);
    const removedSoleProviderRoute = this.releaseProviderRoute(state);
    if (state.busy && removedSoleProviderRoute) {
      await state.client.session.interrupt({ sessionID: state.providerSessionId }).catch(() => {});
    }
    await this.closeSessionState(state);
  }

  async detachSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(state.routeId);
    this.releaseProviderRoute(state);
    await this.closeSessionState(state);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const client = this.assertConnected();
    try {
      const session = await client.sessions.get({ sessionID: sessionId });
      return safeString(session?.id) === sessionId;
    } catch {
      return false;
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    const client = this.assertConnected();
    const directory = safeString(options.directory);
    const result = await client.session.list(directory ? { directory } : undefined);
    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows.map((session) => {
      const displayName = safeString(session.title);
      const dir = safeString(session.location?.directory);
      const updatedAt = positiveNumber(session.time?.updated);
      return {
        key: String(session.id),
        ...(displayName ? { displayName } : {}),
        ...(dir ? { directory: dir } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
    });
  }

  async listModels(force = false): Promise<ProviderModelList> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.value;
    }
    try {
      const client = this.assertConnected();
      const location = { directory: this.catalogDirectory };
      const [providersRes, modelsRes, defaultRes] = await Promise.all([
        client.provider.list({ location }),
        client.model.list({ location }),
        client.model.default({ location }).catch(() => ({ location, data: null })),
      ]);
      const activeProviders = (Array.isArray(providersRes?.data) ? providersRes.data : [])
        .filter((provider) => provider.activation !== 'disabled');
      const providerNames = new Map(activeProviders.map((provider) => [provider.id, provider.name || provider.id]));
      const rawModels = Array.isArray(modelsRes?.data) ? modelsRes.data : [];
      const nextContextWindows = new Map<string, number>();
      const nextReasoningMeta = new Map<string, OpenCodeModelReasoningMeta>();
      const models = rawModels
        .filter((model) => model && model.enabled !== false && (!model.type || model.type === 'chat'))
        .map((model) => {
          const id = `${model.providerID}/${model.modelID}`;
          const providerName = providerNames.get(model.providerID) ?? model.providerID;
          const contextWindow = positiveNumber(model.limit?.context);
          if (contextWindow !== undefined && contextWindow > 0) nextContextWindows.set(id, contextWindow);
          const reasoningMeta = extractModelReasoningMeta(model as unknown as Record<string, any>);
          nextReasoningMeta.set(id, reasoningMeta);
          return {
            id,
            name: `${providerName} · ${model.name ?? model.modelID}`,
            ...(reasoningMeta.supportsReasoning ? { supportsReasoningEffort: true } : {}),
            ...(reasoningMeta.supportedEffortLevels ? { supportedEffortLevels: reasoningMeta.supportedEffortLevels } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const defaultModelData = defaultRes?.data;
      const defaultModel = defaultModelData?.providerID && defaultModelData?.modelID
        ? `${defaultModelData.providerID}/${defaultModelData.modelID}`
        : models[0]?.id;
      const isAuthenticated = activeProviders.length > 0 || models.length > 0;
      const value: ProviderModelList = {
        models,
        isAuthenticated,
        ...(defaultModel ? { defaultModel } : {}),
        ...(!isAuthenticated ? { error: 'OpenCode has no connected model provider' } : {}),
      };
      // Merge rather than replace so an authoritative window, once learned,
      // survives a later cold/partial/failed refresh or a transient provider
      // disconnect. disconnect() clears the map when the provider closes.
      for (const [id, windowTokens] of nextContextWindows) this.modelContextWindows.set(id, windowTokens);
      for (const [id, meta] of nextReasoningMeta) this.modelReasoningMeta.set(id, meta);
      if (isAuthenticated) {
        this.modelCache = { at: Date.now(), value };
      }
      return value;
    } catch (error) {
      return { models: [], isAuthenticated: false, error: errorMessage(error) };
    }
  }

  /**
   * When a live usage frame cannot resolve its model's window, force one
   * throttled catalog refetch so the next frame carries the authoritative
   * limit instead of the UI's 1M fallback. No-op once the window is known.
   */
  private scheduleContextWindowRefresh(model: string): void {
    if (this.modelContextWindows.has(model)) return;
    if (this.contextWindowRefreshInFlight) return;
    const now = Date.now();
    if (now - this.lastContextWindowRefreshAt < CONTEXT_WINDOW_REFRESH_MIN_INTERVAL_MS) return;
    this.lastContextWindowRefreshAt = now;
    this.contextWindowRefreshInFlight = true;
    void this.listModels(true)
      .catch(() => {})
      .finally(() => { this.contextWindowRefreshInFlight = false; });
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !agentId.trim()) return;
    state.model = agentId.trim();
    state.appliedModelSignature = null;
    this.emitSessionInfo(state);
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    state.appliedModelSignature = null;
    this.emitSessionInfo(state);
  }

  private resolvePromptVariant(state: OpenCodeSessionState): string | undefined {
    const effort = state.effort;
    if (!effort) return undefined;
    const modelId = state.model ?? this.modelCache?.value.defaultModel;
    const meta = modelId ? this.modelReasoningMeta.get(modelId) : undefined;
    if (!meta || !meta.supportsReasoning) return undefined;
    if (meta.variantKeys.length > 0) {
      if (meta.variantKeys.includes(effort)) return effort;
      if (meta.supportedEffortLevels && meta.supportedEffortLevels.length > 0) {
        const clamped = clampTransportEffort(effort, meta.supportedEffortLevels);
        if (clamped && meta.variantKeys.includes(clamped)) return clamped;
      }
      return undefined;
    }
    return clampTransportEffort(effort, OPENCODE_SDK_EFFORT_LEVELS);
  }

  private async syncSessionModelAndEffort(state: OpenCodeSessionState): Promise<void> {
    const targetModelId = state.model ?? (state.effort ? this.modelCache?.value.defaultModel : undefined);
    const parsed = parseModelIdentity(targetModelId);
    if (!parsed) return;
    const variant = this.resolvePromptVariant(state);
    const sig = `${parsed.providerID}/${parsed.modelID}:${variant ?? ''}`;
    if (state.appliedModelSignature === sig) return;
    await state.client.session.switchModel({
      sessionID: state.providerSessionId,
      model: {
        providerID: parsed.providerID,
        id: parsed.modelID,
        ...(variant ? { variant } : {}),
      },
    });
    state.appliedModelSignature = sig;
  }

  private async applySystemInstruction(state: OpenCodeSessionState, system: string | undefined): Promise<void> {
    const entryApi = state.client.experimental?.session?.instructions?.entry;
    if (!entryApi) return;
    if (system) {
      await entryApi.put({
        sessionID: state.providerSessionId,
        key: IMCODES_SYSTEM_INSTRUCTION_KEY,
        value: system,
      });
      state.systemInstructionSet = true;
    } else if (state.systemInstructionSet) {
      await entryApi.remove({
        sessionID: state.providerSessionId,
        key: IMCODES_SYSTEM_INSTRUCTION_KEY,
      }).catch(() => {});
      state.systemInstructionSet = false;
    }
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    if (state.busy) throw providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'OpenCode session is already busy', true);

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (isSessionControlCommandText(payload.userMessage, 'compact')) {
      await this.compactSession(state);
      return;
    }
    const generation = ++state.generation;
    state.busy = true;
    state.compacting = false;
    state.compactCompletionEmitted = false;
    state.cancelled = false;
    state.completionEmitted = false;
    state.terminalErrorEmitted = false;
    state.missingFinalRecoveryAttempted = false;
    state.missingFinalRecoveryInFlight = false;
    state.cronControlActive = payload.assembledMessage.includes(CRON_CONTROL_PROTOCOL.OPEN_TAG);
    state.silentToolResult = null;
    state.deliveryMessageId = null;
    state.currentMessageId = null;
    state.textParts.clear();
    state.toolNames.clear();
    state.toolInputs.clear();
    state.toolSignatures.clear();
    state.lastUsageSignature = null;
    state.lastUsage = undefined;
    state.lastUsageMessageId = null;
    this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });

    const files = promptFiles(payload.attachments);
    const system = composeProviderSystemText(payload);
    const messageId = openCodePromptMessageId(state.providerSessionId, payload.deliveryId);
    state.deliveryMessageId = messageId;
    try {
      if (await this.hasAcceptedPrompt(state, messageId)) {
        return;
      }
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await this.syncSessionModelAndEffort(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await this.applySystemInstruction(state, system);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await state.client.sessions.prompt({
        sessionID: state.providerSessionId,
        id: messageId,
        text: payload.assembledMessage,
        ...(files.length > 0 ? { files } : {}),
      });
    } catch (error) {
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      if (isTransientRequestFailure(error)) {
        try {
          const acceptance = await this.waitForPromptAcceptance(state, generation, messageId);
          if (acceptance === 'accepted' || !this.isCurrent(state, generation) || state.cancelled) return;
          if (acceptance === 'unknown') {
            logger.warn(
              { provider: this.id, sessionId: state.routeId, messageId },
              'OpenCode prompt acceptance remained unknown after transient lookup failures; retrying with the same message ID',
            );
          }
        } catch (acceptanceError) {
          state.busy = false;
          this.emitStatus(state.routeId, { status: null, label: null });
          throw this.normalizeError(acceptanceError, 'prompt acceptance check');
        }
      }
      state.busy = false;
      this.emitStatus(state.routeId, { status: null, label: null });
      throw this.normalizeError(error, 'prompt submission');
    }
  }

  private async compactSession(state: OpenCodeSessionState): Promise<void> {
    const compact = typeof state.client.session?.compact === 'function'
      ? state.client.session.compact.bind(state.client.session)
      : undefined;
    if (!compact) {
      const error = providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode compact failed: SDK session.compact is unavailable',
        false,
      );
      this.emitError(state.routeId, error);
      throw error;
    }

    const generation = ++state.generation;
    state.busy = true;
    state.compacting = true;
    state.compactCompletionEmitted = false;
    state.cancelled = false;
    state.completionEmitted = false;
    state.terminalErrorEmitted = false;
    this.emitStatus(state.routeId, { status: 'compacting', label: 'Compacting conversation...' });

    try {
      await this.syncSessionModelAndEffort(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await compact({ sessionID: state.providerSessionId });
    } catch (error) {
      if (!this.isCurrent(state, generation) || state.cancelled || state.compactCompletionEmitted) return;
      const normalized = this.normalizeError(error, 'compact');
      this.failOnce(state, normalized);
      throw normalized;
    }
  }

  private completeCompactOnce(state: OpenCodeSessionState, source: string): void {
    if (!state.compacting || state.compactCompletionEmitted || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) {
      return;
    }
    state.compactCompletionEmitted = true;
    state.completionEmitted = true;
    state.compacting = false;
    state.busy = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    const message: AgentMessage = {
      id: `${state.providerSessionId}:context-compaction:${Date.now()}`,
      sessionId: state.routeId,
      kind: 'system',
      role: 'system',
      content: 'OpenCode context compacted.',
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        providerSessionId: state.providerSessionId,
        event: source,
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        resumeId: state.providerSessionId,
        ...(state.model ? { model: state.model } : {}),
      },
    };
    for (const callback of this.completeCallbacks) callback(state.routeId, message);
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state?.busy || state.cancelled) return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    await state.client.sessions.prompt({
      sessionID: state.providerSessionId,
      id: notification.notificationId,
      text: notification.text,
      delivery: 'steer',
      resume: true,
    });
    // A successful prompt RPC is the irreversible provider admission ACK.
    // Do not post-check generation/idle after success: doing so would retain
    // and replay a message that OpenCode has already accepted.
    return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
  }

  private readonly stopConfirmations = new ProviderStopConfirmation();

  cancelAndWait(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.reject(new Error('OpenCode session unavailable for Stop'));
    const providerSessionId = state.providerSessionId;
    const generation = state.generation;
    const cancelledGeneration = generation + (state.busy ? 1 : 0);
    return this.stopConfirmations.confirm(state, () => this.cancel(sessionId),
      () => this.sessions.get(sessionId) === state && state.providerSessionId === providerSessionId
        && (state.generation === generation || state.generation === cancelledGeneration));
  }

  answerPendingQuestion(sessionName: string, answer: string): boolean {
    for (const [routeId, state] of this.sessions) {
      if ((state.runtimeConfig.sessionName ?? routeId) !== sessionName) continue;
      const pending = this.pendingQuestions.get(routeId);
      if (!pending) return false;
      this.pendingQuestions.delete(routeId);
      const parsed = parseAskQuestionAnswers(pending.questions, answer);
      const formAnswer = formatFormAnswerRecord(pending.fields, parsed, answer);
      if (!state.client.session?.form?.reply) return false;
      void state.client.session.form.reply({
        sessionID: state.providerSessionId,
        formID: pending.requestId,
        answer: formAnswer,
      }).catch((error) => {
        logger.warn({ provider: this.id, sessionId: routeId, requestId: pending.requestId, error }, 'OpenCode form reply failed');
      });
      return true;
    }
    return false;
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearPendingQuestion(state, true);
    if (!state.busy) return;
    const wasCompacting = state.compacting;
    state.cancelled = true;
    state.compacting = false;
    state.generation += 1;
    try {
      await state.client.session.interrupt({ sessionID: state.providerSessionId });
    } finally {
      this.failOnce(state, providerError(
        PROVIDER_ERROR_CODES.CANCELLED,
        options?.origin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG
          ? 'OpenCode was unresponsive and was automatically recovered.'
          : wasCompacting
            ? 'OpenCode compact cancelled'
            : 'OpenCode turn cancelled',
        true,
        options ? { cancelOrigin: options.origin, reason: options.reason } : undefined,
      ));
    }
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { this.deltaCallbacks = this.deltaCallbacks.filter((item) => item !== cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { this.completeCallbacks = this.completeCallbacks.filter((item) => item !== cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { this.errorCallbacks = this.errorCallbacks.filter((item) => item !== cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onApprovalRequest(cb: (sessionId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => { this.sessionInfoCallbacks = this.sessionInfoCallbacks.filter((item) => item !== cb); };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((item) => item !== cb); };
  }

  onUsage(cb: (sessionId: string, usage: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => { this.usageCallbacks = this.usageCallbacks.filter((item) => item !== cb); };
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    const timer = state.pendingPermissions.get(requestId);
    if (timer) clearTimeout(timer);
    state.pendingPermissions.delete(requestId);
    await this.replyPermission(state, requestId, approved);
  }

  private async replyPermission(
    state: OpenCodeSessionState,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    try {
      await state.client.permission.reply({
        sessionID: state.providerSessionId,
        requestID: requestId,
        decision: approved ? 'once' : 'reject',
      });
    } catch (error) {
      throw this.normalizeError(error, 'permission');
    }
  }

  private async hasAcceptedPrompt(state: OpenCodeSessionState, messageId: string): Promise<boolean> {
    try {
      const msg = await state.client.session.message.get({
        sessionID: state.providerSessionId,
        messageID: messageId,
      }) as Record<string, any> | undefined;
      return safeString(msg?.id) === messageId && msg?.type === 'user';
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async waitForPromptAcceptance(
    state: OpenCodeSessionState,
    generation: number,
    messageId: string,
  ): Promise<PromptAcceptance> {
    let lastObservation: PromptAcceptance = 'unknown';
    for (const delayMs of PROMPT_ACCEPTANCE_RECHECK_DELAYS_MS) {
      await sleep(delayMs);
      if (!this.isCurrent(state, generation) || state.cancelled) return 'unknown';
      try {
        if (await this.hasAcceptedPrompt(state, messageId)) {
          logger.warn(
            { provider: this.id, sessionId: state.routeId, messageId },
            'OpenCode prompt submission response failed after the message was accepted; suppressing duplicate replay',
          );
          return 'accepted';
        }
        lastObservation = 'absent';
      } catch (error) {
        if (!isTransientRequestFailure(error)) throw error;
        // A later failed lookup invalidates an earlier absence observation:
        // the server may have accepted the message in between. Retry remains
        // safe because every dispatch attempt reuses this exact message ID.
        lastObservation = 'unknown';
      }
    }
    return lastObservation;
  }

  private async consumeEvents(stream: AsyncIterable<Record<string, any>>, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        this.handleEvent(event);
      }
      if (!signal.aborted) throw new Error('OpenCode event stream ended');
    } catch (error) {
      if (signal.aborted) return;
      const normalized = this.normalizeError(error, 'events');
      for (const state of this.sessions.values()) {
        if (!state.busy) continue;
        this.failOnce(state, normalized);
      }
    }
  }

  setNativeAgentFenceResolver(resolver: NativeAgentFenceResolver): void {
    this.nativeAgentFence.install(resolver);
  }

  /**
   * The fence of the live runtime serving this route: fixed when that runtime
   * started. A relaunch starts a new runtime and decides again.
   */
  async getNativeAgentFence(providerSessionId: string): Promise<NativeAgentFence> {
    return this.sessions.get(providerSessionId)?.nativeAgentFence ?? NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
  }

  private async startSessionRuntime(config: SessionConfig, cwd: string, nativeAgentsFenced: boolean): Promise<{
    client: OpenCodeClientLike;
    server: OpenCodeServerLike;
    abort: AbortController;
    stream: AsyncIterable<Record<string, any>>;
  }> {
    const abort = new AbortController();
    const mcpServers = getDefaultMcpServers(config);
    let started: Awaited<ReturnType<OpenCodeSdkRuntimeHooks['start']>> | null = null;
    const mcpServersConfig = Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, {
      type: 'local',
      command: [server.command, ...server.args],
      environment: server.env,
      disabled: false,
    }]));
    try {
      started = await openCodeSdkRuntimeHooks.start({
        hostname: LOOPBACK_HOST,
        port: 0,
        timeout: 10_000,
        signal: abort.signal,
        directory: cwd,
        warmupCatalog: true,
        ...(this.databasePath ? { databasePath: this.databasePath } : {}),
        config: {
          share: 'disabled',
          mcp: { servers: mcpServersConfig },
          ...(nativeAgentsFenced
            ? {
              permissions: OPENCODE_NATIVE_AGENT_TOOLS.map((action) => ({
                action,
                resource: '*',
                effect: 'deny',
              })),
            }
            : {}),
        },
      });
      const url = new URL(started.server.url);
      if (url.hostname !== LOOPBACK_HOST && url.hostname !== 'localhost' && url.hostname !== '::1') {
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK session server did not bind to loopback', false);
      }
      const subscription = await started.client.events.subscribe({}, { signal: abort.signal }) as unknown as
        | AsyncIterable<Record<string, any>>
        | { stream: AsyncIterable<Record<string, any>> };
      const stream = 'stream' in subscription ? subscription.stream : subscription;
      return { client: started.client, server: started.server, abort, stream };
    } catch (error) {
      abort.abort();
      started?.server.close();
      throw this.normalizeError(error, 'session server startup');
    }
  }

  private async closeStartedRuntime(runtime: {
    server: OpenCodeServerLike;
    abort: AbortController;
  }): Promise<void> {
    runtime.abort.abort();
    runtime.server.close();
  }

  private async closeSessionState(state: OpenCodeSessionState): Promise<void> {
    this.clearPendingQuestion(state, true);
    for (const timer of state.pendingPermissions.values()) clearTimeout(timer);
    state.pendingPermissions.clear();
    state.surfacedQuestionCallIds.clear();
    state.abort.abort();
    state.server.close();
    await state.eventLoop.catch(() => {});
  }

  private releaseProviderRoute(state: OpenCodeSessionState): boolean {
    const ownsCurrentRoute = this.providerToRoute.get(state.providerSessionId) === state.routeId;
    const remainingRoutes = (this.providerRouteOrder.get(state.providerSessionId) ?? [])
      .filter((routeId) => (
        routeId !== state.routeId
        && this.sessions.get(routeId)?.providerSessionId === state.providerSessionId
      ));
    if (remainingRoutes.length > 0) this.providerRouteOrder.set(state.providerSessionId, remainingRoutes);
    else this.providerRouteOrder.delete(state.providerSessionId);
    if (!ownsCurrentRoute) return false;
    if (remainingRoutes.length > 0) {
      this.providerToRoute.set(state.providerSessionId, remainingRoutes[remainingRoutes.length - 1]!);
      return false;
    }
    this.providerToRoute.delete(state.providerSessionId);
    return true;
  }

  private registerProviderRoute(providerSessionId: string, routeId: string): void {
    const routes = (this.providerRouteOrder.get(providerSessionId) ?? [])
      .filter((candidate) => candidate !== routeId && this.sessions.has(candidate));
    routes.push(routeId);
    this.providerRouteOrder.set(providerSessionId, routes);
    this.providerToRoute.set(providerSessionId, routeId);
  }

  private handleEvent(event: Record<string, any>): void {
    if (event.type === 'model.updated' || event.type === 'provider.updated') {
      this.modelCache = null;
      return;
    }
    const providerSessionId = sessionIdFromEvent(event);
    if (!providerSessionId) return;
    const routeId = this.providerToRoute.get(providerSessionId);
    const state = routeId ? this.sessions.get(routeId) : undefined;
    if (!state) return;
    const data = (event.data ?? event.properties) as Record<string, any> | undefined;

    switch (event.type) {
      case 'session.step.started': {
        if (!state.busy) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const providerID = safeString(data?.model?.providerID);
        const modelID = safeString(data?.model?.id);
        if (providerID && modelID) {
          const model = `${providerID}/${modelID}`;
          if (state.model !== model) {
            state.model = model;
            this.emitSessionInfo(state);
          }
        }
        return;
      }
      case 'session.text.started': {
        if (!state.busy) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        if (!state.textParts.has(key)) state.textParts.set(key, '');
        return;
      }
      case 'session.text.delta': {
        if (!state.busy) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        const previous = state.textParts.get(key) ?? '';
        const chunk = typeof data?.delta === 'string' ? data.delta : '';
        if (!chunk) return;
        state.textParts.set(key, previous + chunk);
        this.emitTextDelta(state);
        return;
      }
      case 'session.text.ended': {
        if (!state.busy) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        if (typeof data?.text === 'string' && state.textParts.get(key) !== data.text) {
          state.textParts.set(key, data.text);
          this.emitTextDelta(state);
        }
        return;
      }
      case 'session.reasoning.started':
      case 'session.reasoning.delta': {
        if (!state.busy) return;
        this.emitStatus(state.routeId, { status: 'thinking', label: 'OpenCode is thinking…' });
        return;
      }
      case 'session.tool.input.started': {
        if (!state.busy) return;
        const id = safeString(data?.id);
        const name = safeString(data?.name);
        if (id && name) state.toolNames.set(id, name);
        return;
      }
      case 'session.tool.called': {
        if (!state.busy) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        state.toolNames.set(id, name);
        if (data?.input !== undefined) state.toolInputs.set(id, data.input);
        this.emitToolCallEvent(state, { id, name, status: 'running', input: data?.input });
        return;
      }
      case 'session.tool.success': {
        if (!state.busy) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        const output = extractToolContentText(data?.content);
        this.emitToolCallEvent(state, {
          id,
          name,
          status: 'complete',
          input: state.toolInputs.get(id),
          output,
        });
        return;
      }
      case 'session.tool.failed': {
        if (!state.busy) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        const output = extractToolContentText(data?.content)
          ?? safeString(data?.error?.message)
          ?? (data?.error ? errorMessage(data.error) : undefined);
        this.emitToolCallEvent(state, {
          id,
          name,
          status: 'error',
          input: state.toolInputs.get(id),
          output,
        });
        return;
      }
      case 'session.usage.updated': {
        this.emitUsage(state, state.currentMessageId, data?.tokens, data?.cost, false);
        return;
      }
      case 'session.step.ended': {
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        this.emitUsage(state, data?.assistantMessageID, data?.tokens, data?.cost, true);
        if (isTerminalFinish(data?.finish)) {
          this.completeOnce(state, 'session.step.ended');
        }
        return;
      }
      case 'session.step.failed': {
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        this.emitUsage(state, data?.assistantMessageID, data?.tokens, data?.cost, true);
        this.failOnce(state, this.normalizeError(data?.error, 'step'));
        return;
      }
      case 'session.execution.started': {
        if (state.busy && !state.compacting) {
          this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        }
        return;
      }
      case 'session.execution.succeeded': {
        this.stopConfirmations.complete(state);
        if (state.compacting) {
          this.completeCompactOnce(state, 'session.execution.succeeded');
          return;
        }
        this.completeOnce(state, 'session.execution.succeeded');
        return;
      }
      case 'session.execution.failed': {
        this.stopConfirmations.complete(state);
        this.failOnce(state, this.normalizeError(data?.error, 'session'));
        return;
      }
      case 'session.execution.interrupted': {
        this.stopConfirmations.complete(state);
        if (state.busy && !state.cancelled) {
          this.failOnce(state, providerError(
            PROVIDER_ERROR_CODES.CANCELLED,
            `OpenCode execution interrupted (${safeString(data?.reason) ?? 'user'})`,
            true,
          ));
        }
        return;
      }
      case 'session.retry.scheduled': {
        if (!state.busy || state.compacting) return;
        const msg = safeString(data?.error?.message) ?? `OpenCode is retrying (attempt ${data?.attempt ?? 1})…`;
        this.emitStatus(state.routeId, { status: 'retrying', label: msg });
        return;
      }
      case OPENCODE_PERMISSION_EVENT.ASKED:
      case OPENCODE_PERMISSION_EVENT.V2_ASKED:
      case OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED:
        this.processPermission(state, normalizePermissionEvent(event.type, data));
        return;
      case 'form.created':
        this.processFormCreated(state, data?.form);
        return;
      case 'form.replied':
      case 'form.cancelled': {
        const requestId = safeString(data?.id);
        const pending = this.pendingQuestions.get(state.routeId);
        if (pending && (!requestId || pending.requestId === requestId)) {
          this.pendingQuestions.delete(state.routeId);
        }
        return;
      }
      case 'session.status': {
        const status = data?.status;
        if (state.compacting) {
          if (status?.type === 'idle') this.stopConfirmations.complete(state);
          return;
        }
        if (status?.type === 'idle') {
          this.stopConfirmations.complete(state);
          this.completeOnce(state, 'session.status');
          return;
        }
        // Only surface progress while a turn is live; delayed/out-of-order busy/retry
        // frames after turn settlement must not strand the footer indicator.
        if (!state.busy) return;
        if (status?.type === 'busy') this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        else if (status?.type === 'retry') this.emitStatus(state.routeId, { status: 'retrying', label: safeString(status.message) ?? 'OpenCode is retrying…' });
        return;
      }
      case 'session.compaction.started':
        if (state.compacting && !state.cancelled) {
          this.emitStatus(state.routeId, { status: 'compacting', label: 'Compacting conversation...' });
        }
        return;
      case 'session.compaction.ended':
      case 'session.compacted':
        this.stopConfirmations.complete(state);
        if (state.compacting && !state.cancelled) {
          this.completeCompactOnce(state, event.type);
        }
        return;
      case 'session.compaction.failed':
        this.stopConfirmations.complete(state);
        if (state.compacting && !state.cancelled) {
          this.failOnce(state, this.normalizeError(data?.error, 'compact'));
        }
        return;
      case 'session.idle':
        this.stopConfirmations.complete(state);
        if (state.compacting) return;
        this.completeOnce(state, 'session.idle');
        return;
      default:
        return;
    }
  }

  private processAssistantMessageRecord(state: OpenCodeSessionState, msg: Record<string, any> | undefined): boolean {
    if (!msg || msg.type !== 'assistant') return false;
    state.currentMessageId = safeString(msg.id) ?? state.currentMessageId;
    if (safeString(msg.model?.providerID) && safeString(msg.model?.id)) {
      const model = `${msg.model.providerID}/${msg.model.id}`;
      if (state.model !== model) {
        state.model = model;
        this.emitSessionInfo(state);
      }
    }
    this.emitUsage(state, msg.id, msg.tokens, msg.cost, true);
    if (Array.isArray(msg.content)) {
      let ordinal = 0;
      for (const item of msg.content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') {
          const key = textPartKey(msg.id, ordinal++);
          if (state.textParts.get(key) !== item.text) {
            state.textParts.set(key, item.text);
            this.emitTextDelta(state);
          }
        } else if (item.type === 'tool') {
          const id = safeString(item.id) ?? randomUUID();
          const name = safeString(item.name) ?? 'tool';
          const toolState = item.state ?? {};
          const status: ToolCallEvent['status'] = toolState.status === 'completed'
            ? 'complete'
            : toolState.status === 'error'
              ? 'error'
              : 'running';
          const output = status === 'error'
            ? (extractToolContentText(toolState.content) ?? safeString(toolState.error?.message))
            : extractToolContentText(toolState.content);
          this.emitToolCallEvent(state, { id, name, status, input: toolState.input, output });
        }
      }
    }
    if (msg.error) {
      this.failOnce(state, this.normalizeError(msg.error, 'message'));
    }
    return isTerminalAssistantMessage(msg);
  }

  private emitTextDelta(state: OpenCodeSessionState): void {
    const content = [...state.textParts.values()].join('');
    if (!content) return;
    const messageId = state.currentMessageId ?? `${state.providerSessionId}:assistant`;
    const update: MessageDelta = { messageId, type: 'text', delta: content, role: 'assistant' };
    for (const callback of this.deltaCallbacks) callback(state.routeId, update);
  }

  private emitToolCallEvent(
    state: OpenCodeSessionState,
    params: { id: string; name: string; status: ToolCallEvent['status']; input?: unknown; output?: string },
  ): void {
    if ((params.name === 'question' || params.name === 'form') && (params.status === 'running' || state.surfacedQuestionCallIds.has(params.id))) {
      return;
    }
    const signature = JSON.stringify([params.status, params.input, params.output]);
    if (state.toolSignatures.get(params.id) === signature) return;
    state.toolSignatures.set(params.id, signature);
    const event: ToolCallEvent = {
      id: params.id,
      name: params.name,
      status: params.status,
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(params.output !== undefined ? { output: params.output } : {}),
      detail: {
        kind: 'opencode.tool',
        summary: params.name,
        input: params.input,
        output: params.output,
        meta: { provider: this.id, providerSessionId: state.providerSessionId },
      },
    };
    for (const callback of this.toolCallbacks) callback(state.routeId, event);
    if (
      params.status === 'complete'
      && state.cronControlActive
      && isCronSilentResult(params.output)
    ) {
      state.silentToolResult = CRON_CONTROL_PROTOCOL.SILENT_RESULT;
      this.finishOnce(state, CRON_CONTROL_PROTOCOL.SILENT_RESULT, 'cron.tool.silent');
    }
  }

  private processFormCreated(state: OpenCodeSessionState, form: Record<string, any> | undefined): void {
    const normalized = normalizeFormToQuestions(form);
    if (!normalized) return;
    const { requestId, questions, fields } = normalized;
    const callId = safeString(form?.metadata?.callID);
    if (callId) state.surfacedQuestionCallIds.add(callId);
    const previous = this.pendingQuestions.get(state.routeId);
    if (previous && previous.requestId !== requestId && state.client.session?.form?.cancel) {
      void state.client.session.form.cancel({
        sessionID: state.providerSessionId,
        formID: previous.requestId,
      }).catch(() => {});
    }
    this.pendingQuestions.set(state.routeId, { requestId, questions, fields, ...(callId ? { callId } : {}) });
    const event: ToolCallEvent = {
      id: callId ?? requestId,
      name: INTERACTIVE_QUESTION_TOOL_NAME,
      status: 'complete',
      input: { questions },
    };
    for (const callback of this.toolCallbacks) callback(state.routeId, event);
  }

  private clearPendingQuestion(state: OpenCodeSessionState, cancelPending: boolean): void {
    const pending = this.pendingQuestions.get(state.routeId);
    if (!pending) return;
    this.pendingQuestions.delete(state.routeId);
    if (cancelPending && state.client.session?.form?.cancel) {
      void state.client.session.form.cancel({
        sessionID: state.providerSessionId,
        formID: pending.requestId,
      }).catch(() => {});
    }
  }

  private processPermission(state: OpenCodeSessionState, permission: NormalizedOpenCodePermission | undefined): void {
    if (!permission) return;
    const { id, operation, title, pattern, callId } = permission;
    const request: ApprovalRequest = {
      id,
      description: title ?? `Allow OpenCode ${operation ?? 'operation'}${pattern ? `: ${pattern}` : ''}`,
      ...(operation ? { tool: operation } : {}),
      provider: this.id,
      providerGeneration: state.generation,
      ...(callId ? { providerToolUseId: callId } : {}),
      ...(pattern ? { inputPreview: pattern.slice(0, 300) } : {}),
    };
    if (this.approvalCallbacks.length === 0) {
      void this.replyPermission(state, id, false).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
      });
      return;
    }
    if (state.pendingPermissions.has(id)) return;
    const timer = setTimeout(() => {
      if (!state.pendingPermissions.delete(id)) return;
      void this.replyPermission(state, id, false).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission timeout'));
      });
    }, this.approvalTimeoutMs);
    timer.unref?.();
    state.pendingPermissions.set(id, timer);
    for (const callback of this.approvalCallbacks) callback(state.routeId, request);
  }

  private emitUsage(state: OpenCodeSessionState, messageId: unknown, tokens: any, cost: unknown, finalized: boolean): void {
    if (!tokens || typeof tokens !== 'object') return;
    const modelContextWindow = state.model ? this.modelContextWindows.get(state.model) : undefined;
    if (state.model && modelContextWindow === undefined) this.scheduleContextWindowRefresh(state.model);
    const inputTokens = positiveNumber(tokens.input) ?? 0;
    const outputTokens = positiveNumber(tokens.output) ?? 0;
    const cacheReadTokens = positiveNumber(tokens.cache?.read) ?? 0;
    const cacheWriteTokens = positiveNumber(tokens.cache?.write) ?? 0;
    const normalizedMessageId = safeString(messageId);

    // OpenCode emits zero-token snapshots before the step finishes. Expose the
    // authoritative context limit without publishing a finalized 0-usage frame.
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
      if (state.lastUsage || modelContextWindow === undefined) return;
      const metadataOnlyUsage = { model_context_window: modelContextWindow };
      const metadataOnlySignature = JSON.stringify(metadataOnlyUsage);
      if (metadataOnlySignature === state.lastUsageSignature) return;
      state.lastUsageSignature = metadataOnlySignature;
      const update: ProviderUsageUpdate = {
        ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
        finalized: false,
        usage: metadataOnlyUsage,
        ...(state.model ? { model: state.model } : {}),
      };
      for (const callback of this.usageCallbacks) callback(state.routeId, update);
      return;
    }

    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheWriteTokens,
      ...(modelContextWindow !== undefined ? { model_context_window: modelContextWindow } : {}),
      ...(positiveNumber(cost) !== undefined ? { cost_usd: cost } : {}),
    };
    state.lastUsage = usage;
    state.lastUsageMessageId = normalizedMessageId ?? state.lastUsageMessageId;
    const signature = JSON.stringify(usage);
    if (signature === state.lastUsageSignature) return;
    state.lastUsageSignature = signature;
    const update: ProviderUsageUpdate = {
      ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
      finalized,
      usage,
      ...(state.model ? { model: state.model } : {}),
    };
    for (const callback of this.usageCallbacks) callback(state.routeId, update);
  }

  private completeOnce(state: OpenCodeSessionState, source: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    const content = [...state.textParts.values()].join('');
    if (!content.trim()) {
      if (state.cronControlActive && state.silentToolResult) {
        this.finishOnce(state, state.silentToolResult, 'cron.tool.silent');
        return;
      }
      // Wait for step/execution completion if `session.step.ended` arrived without text.
      if (source === 'session.step.ended' || state.missingFinalRecoveryInFlight) return;
      if (!state.missingFinalRecoveryAttempted) {
        this.recoverMissingFinalOnce(state);
        return;
      }
      this.failOnce(state, providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode ended the turn without a final response.',
        false,
        { source },
      ));
      return;
    }
    this.finishOnce(state, content, source);
  }

  private finishOnce(state: OpenCodeSessionState, content: string, source: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    state.completionEmitted = true;
    state.busy = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    const message: AgentMessage = {
      id: state.currentMessageId ?? state.lastUsageMessageId ?? `${state.providerSessionId}:${state.generation}`,
      sessionId: state.routeId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        providerSessionId: state.providerSessionId,
        source,
        ...(state.model ? { model: state.model } : {}),
        ...(state.lastUsage ? { usage: state.lastUsage } : {}),
      },
    };
    for (const callback of this.completeCallbacks) callback(state.routeId, message);
  }

  private recoverMissingFinalOnce(state: OpenCodeSessionState): void {
    if (
      !state.busy
      || state.cancelled
      || state.missingFinalRecoveryAttempted
      || state.missingFinalRecoveryInFlight
    ) return;
    state.missingFinalRecoveryAttempted = true;
    state.missingFinalRecoveryInFlight = true;
    const generation = state.generation;
    void this.runMissingFinalRecovery(state, generation);
  }

  private async runMissingFinalRecovery(state: OpenCodeSessionState, generation: number): Promise<void> {
    const deliveryMessageId = state.deliveryMessageId
      ?? openCodePromptMessageId(state.providerSessionId, `${state.routeId}:${generation}`);
    const recoveryMessageId = openCodeRecoveryMessageId(state.providerSessionId, deliveryMessageId);
    let lastError: unknown;

    for (const delayMs of MISSING_FINAL_RECOVERY_RECHECK_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      try {
        const recovered = await this.tryMissingFinalRecovery(state, recoveryMessageId);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        if (recovered) {
          state.missingFinalRecoveryInFlight = false;
          this.completeOnce(state, 'recovery.prompt.result');
          return;
        }
        lastError = undefined;
      } catch (error) {
        lastError = error;
        if (!isTransientRequestFailure(error) && !(error instanceof OpenCodeRequestTimeoutError)) break;
      }
    }

    if (!this.isCurrent(state, generation) || state.cancelled) return;
    if (lastError) {
      try {
        const restarted = await this.restartSessionRuntime(state, generation);
        if (!restarted) return;
        const recovered = await this.tryMissingFinalRecovery(state, recoveryMessageId);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        if (recovered) {
          state.missingFinalRecoveryInFlight = false;
          this.completeOnce(state, 'recovery.prompt.result.after-reconnect');
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!this.isCurrent(state, generation) || state.cancelled) return;
    state.missingFinalRecoveryInFlight = false;
    const normalized = lastError
      ? this.normalizeError(lastError, 'missing final response recovery')
      : providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode ended the turn without a final response after bounded recovery.',
        false,
        { recoveryMessageId },
      );
    this.failOnce(state, normalized);
  }

  private async tryMissingFinalRecovery(
    state: OpenCodeSessionState,
    recoveryMessageId: string,
  ): Promise<boolean> {
    await withOpenCodeRequestTimeout(
      state.client.sessions.get({ sessionID: state.providerSessionId }),
      'session health check',
    );

    const accepted = await withOpenCodeRequestTimeout(
      this.hasAcceptedPrompt(state, recoveryMessageId),
      'missing final acceptance check',
    );
    if (accepted) return this.loadAcceptedRecoveryResult(state, recoveryMessageId);

    await this.syncSessionModelAndEffort(state);
    await withOpenCodeRequestTimeout(
      state.client.sessions.prompt({
        sessionID: state.providerSessionId,
        id: recoveryMessageId,
        text: MISSING_FINAL_RECOVERY_PROMPT,
      }),
      'missing final recovery prompt',
    );
    if (state.client.experimental?.session?.wait) {
      await withOpenCodeRequestTimeout(
        state.client.experimental.session.wait({ sessionID: state.providerSessionId }),
        'missing final recovery wait',
      );
    }
    return this.loadAcceptedRecoveryResult(state, recoveryMessageId);
  }

  private async loadAcceptedRecoveryResult(
    state: OpenCodeSessionState,
    recoveryMessageId: string,
  ): Promise<boolean> {
    if (state.completionEmitted) return true;
    const res = await withOpenCodeRequestTimeout(
      state.client.message.list({ sessionID: state.providerSessionId, limit: 100, order: 'desc' }),
      'missing final recovery reconciliation',
    );
    const items = Array.isArray(res?.data) ? (res.data as Array<Record<string, any>>) : [];
    const recoveryUserIdx = items.findIndex((item) => item?.id === recoveryMessageId && item?.type === 'user');
    const searchPool = recoveryUserIdx >= 0 ? items.slice(0, recoveryUserIdx) : items;
    const recovered = searchPool.find((item) => isTerminalAssistantMessage(item));
    if (!recovered) return false;
    return this.processAssistantMessageRecord(state, recovered)
      && Boolean([...state.textParts.values()].join('').trim());
  }

  private async restartSessionRuntime(state: OpenCodeSessionState, generation: number): Promise<boolean> {
    // A replacement runtime preserves any active fence for this session.
    const nativeAgentsFenced = state.nativeAgentFence === NATIVE_AGENT_FENCES.DISABLED
      || this.nativeAgentFence.required(state.routeId, state.runtimeConfig.sessionName);
    const replacement = await this.startSessionRuntime(state.runtimeConfig, state.cwd, nativeAgentsFenced);
    try {
      await withOpenCodeRequestTimeout(
        replacement.client.sessions.get({ sessionID: state.providerSessionId }),
        'session reconnect verification',
      );
    } catch (error) {
      await this.closeStartedRuntime(replacement);
      throw error;
    }

    if (!this.isCurrent(state, generation) || state.cancelled) {
      await this.closeStartedRuntime(replacement);
      return false;
    }

    const previous = {
      abort: state.abort,
      server: state.server,
      eventLoop: state.eventLoop,
    };
    state.client = replacement.client;
    state.server = replacement.server;
    state.abort = replacement.abort;
    state.nativeAgentFence = fenceOf(nativeAgentsFenced);
    state.eventLoop = this.consumeEvents(replacement.stream, replacement.abort.signal);
    previous.abort.abort();
    previous.server.close();
    void previous.eventLoop.catch(() => {});
    logger.warn(
      { provider: this.id, sessionId: state.routeId, providerSessionId: state.providerSessionId },
      'OpenCode session runtime reconnected during missing-final recovery',
    );
    return true;
  }

  private failOnce(state: OpenCodeSessionState, error: ProviderError): void {
    if (state.completionEmitted || state.terminalErrorEmitted) return;
    state.terminalErrorEmitted = true;
    state.busy = false;
    state.compacting = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    this.emitError(state.routeId, error);
  }

  private emitSessionInfo(state: OpenCodeSessionState): void {
    const info: SessionInfoUpdate = {
      resumeId: state.providerSessionId,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
    };
    for (const callback of this.sessionInfoCallbacks) callback(state.routeId, info);
  }

  private emitStatus(routeId: string, status: ProviderStatusUpdate): void {
    for (const callback of this.statusCallbacks) callback(routeId, status);
  }

  private emitError(routeId: string, error: ProviderError): void {
    for (const callback of this.errorCallbacks) callback(routeId, error);
  }

  private isCurrent(state: OpenCodeSessionState, generation: number): boolean {
    return this.sessions.get(state.routeId) === state && state.generation === generation;
  }

  private assertConnected(): OpenCodeClientLike {
    if (!this.client) throw providerError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'OpenCode SDK provider is not connected', true);
    return this.client;
  }

  private normalizeError(error: unknown, operation: string): ProviderError {
    if (error && typeof error === 'object' && 'code' in error && 'recoverable' in error && 'message' in error) {
      return error as ProviderError;
    }
    const status = errorHttpStatus(error);
    const message = errorMessage(error);
    const lower = message.toLowerCase();
    const errorType = error && typeof error === 'object' ? safeString((error as { type?: unknown }).type)?.toLowerCase() ?? '' : '';
    const errorName = error && typeof error === 'object' ? safeString((error as { name?: unknown }).name)?.toLowerCase() ?? '' : '';

    if (
      lower.includes('enoent')
      || lower.includes('err_module_not_found')
      || (lower.includes('opencode') && (lower.includes('cannot find package') || (lower.includes('not found') && lower.includes('package'))))
    ) {
      return providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        'OpenCode SDK runtime is unavailable. Ensure `@opencode/sdk` (>= 2.4.2) is installed; if connecting to an external OpenCode server, upgrade it via `opencode upgrade --major`.',
        false,
      );
    }
    if (lower.includes('unsupportedcontenttype') || (errorName === 'clienterror' && (status === 404 || status === 405 || lower.includes('unexpectedstatus')))) {
      return providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `OpenCode ${operation} failed against an incompatible OpenCode v1 endpoint: ${message}. Upgrade the OpenCode runtime to v2 (opencode upgrade --major).`,
        false,
      );
    }
    if (
      errorName.includes('signedout')
      || errorName.includes('ssorequired')
      || lower.includes('providerautherror')
      || lower.includes('unauthorized')
      || lower.includes('authentication')
      || status === 401
      || status === 403
    ) {
      return providerError(PROVIDER_ERROR_CODES.AUTH_FAILED, `OpenCode ${operation} failed: ${message}`, false);
    }
    if (
      errorType.includes('free-limit')
      || errorType.includes('rate-limit')
      || lower.includes('free usage limit')
      || (lower.includes('rate') && lower.includes('limit'))
      || status === 429
    ) {
      return providerError(PROVIDER_ERROR_CODES.RATE_LIMITED, `OpenCode ${operation} failed: ${message}`, true);
    }
    if (lower.includes('abort') || lower.includes('cancel')) {
      return providerError(PROVIDER_ERROR_CODES.CANCELLED, `OpenCode ${operation} cancelled`, true);
    }
    if (errorName.includes('sessionnotfound') || status === 404 || (lower.includes('session') && lower.includes('not found'))) {
      return providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `OpenCode session was not found during ${operation}`, false);
    }
    if (isTransientRequestFailure(error)) {
      return providerError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `OpenCode ${operation} failed: ${message}`, true);
    }
    return providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `OpenCode ${operation} failed: ${message}`, true);
  }
}
