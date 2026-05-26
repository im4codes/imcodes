import { access, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline, { type Interface as ReadlineInterface } from 'node:readline';
import { killProcessTree } from '../../util/kill-process-tree.js';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import logger from '../../util/logger.js';
import { CODEX_SDK_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { getCodexBaseInstructions } from '../codex-runtime-config.js';
import { composeProviderSystemText, getProviderSystemTextParts } from '../provider-context-routing.js';
import { getDefaultCodexMcpArgs } from './getDefaultCodexMcpArgs.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';

const CODEX_BIN = 'codex';
const CANCEL_INTERRUPT_TIMEOUT_MS = 1_500;
const COMPACT_START_ACCEPT_TIMEOUT_MS = 15_000;
const COMPACT_NO_SIGNAL_SETTLE_MS = 5_000;
const COMPACT_HARD_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 32_000;
const MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 4_000;
const MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 128_000;
const IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER = '# IM.codes runtime instructions';


function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCodexAuthFailureMessage(message: string): boolean {
  return /401\s+Unauthorized/i.test(message)
    || /Missing bearer or basic authentication/i.test(message)
    || /not authenticated/i.test(message)
    || /authentication required/i.test(message);
}

function getCodexAuthPath(env: Record<string, string | undefined>): string {
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? resolve(env.CODEX_HOME.trim())
    : resolve(homedir(), '.codex');
  return resolve(codexHome, 'auth.json');
}

async function readCodexAuthFingerprint(env: Record<string, string | undefined>): Promise<string | null> {
  try {
    const authPath = getCodexAuthPath(env);
    const stats = await stat(authPath);
    return `${authPath}:${Math.trunc(stats.mtimeMs)}:${stats.size}`;
  } catch {
    return null;
  }
}

function isCodexThreadHistoryUnreadableError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes('failed to read thread')
    && (
      message.includes('failed to load thread history')
      || message.includes('thread-store internal error')
      || message.includes('valid utf-8')
    )
  );
}

function extractCodexJsonlPath(message: string): string | null {
  const match = /(?:^|\s)(\/[^\s:]+\.jsonl)(?::|\s|$)/.exec(message);
  if (!match) return null;
  const candidate = resolve(match[1]);
  const sessionsRoot = resolve(homedir(), '.codex', 'sessions');
  return candidate === sessionsRoot || candidate.startsWith(`${sessionsRoot}${sep}`) ? candidate : null;
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function repairCodexJsonlText(text: string): { text: string; droppedLineCount: number } {
  const repairedLines: string[] = [];
  let droppedLineCount = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      repairedLines.push(line);
    } catch {
      droppedLineCount += 1;
    }
  }
  return {
    text: repairedLines.length > 0 ? `${repairedLines.join('\n')}\n` : '',
    droppedLineCount,
  };
}

function getCodexSdkContextInjectionMaxChars(): number {
  const raw = process.env.IMCODES_CODEX_SDK_CONTEXT_MAX_CHARS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  if (parsed < MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS) return MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  if (parsed > MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS) return MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  return parsed;
}

function capCodexSdkContextInjection(text: string, maxChars = getCodexSdkContextInjectionMaxChars()): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[IM.codes: injected context truncated from ${text.length} to ${maxChars} chars to prevent SDK auto-compaction.]`;
  if (maxChars <= marker.length + 16) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function buildCodexTurnInput(payload: ProviderContextPayload, sessionSystemTextUpdate?: string): string {
  const contextParts: string[] = [];
  const split = getProviderSystemTextParts(payload);
  const systemText = split.hasSplitSystemText
    ? composeProviderSystemText(payload, { includeSession: false, includeTurn: true })
    : payload.systemText?.trim();
  const messagePreamble = payload.messagePreamble?.trim();
  const stableUpdate = sessionSystemTextUpdate?.trim();
  if (stableUpdate) {
    contextParts.push(`${IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER} updated:\n${stableUpdate}`);
  }
  if (systemText) contextParts.push(`Context instructions:\n${systemText}`);
  if (messagePreamble) contextParts.push(messagePreamble);
  if (contextParts.length === 0) return payload.assembledMessage;

  const contextText = capCodexSdkContextInjection(contextParts.join('\n\n'));
  const userMessage = messagePreamble ? payload.userMessage : payload.assembledMessage;
  const trimmedUserMessage = userMessage.trim();
  return trimmedUserMessage ? `${contextText}\n\n${trimmedUserMessage}` : contextText;
}

function appendImcodesBaseInstructions(baseInstructions: string, payload: ProviderContextPayload): string {
  const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
  if (!sessionSystemText) return baseInstructions;
  if (baseInstructions.includes(IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER)) return baseInstructions;
  return `${baseInstructions.trimEnd()}\n\n${IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER}\n\n${capCodexSdkContextInjection(sessionSystemText)}`;
}

/**
 * Provider-neutral fallback `baseInstructions` used when codex's own
 * `~/.codex/models_cache.json` does not have a matching `base_instructions`
 * for the active model — e.g. `codex-MiniMax-M2.5` routed via
 * `[model_providers.minimax]` with `wire_api = "responses"`.
 *
 * Background: codex forwards `baseInstructions` as the OpenAI Responses API
 * `instructions` field. Starting with codex-cli 0.125 + the April 2026
 * Responses API protocol change, an empty/missing `instructions` is
 * rejected with:
 *
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error",
 *     "message":"Instructions are required"}}
 *
 * For catalog models (gpt-5.x), we lift the full per-model prompt straight
 * out of `~/.codex/models_cache.json` so there is no quality regression.
 * For non-catalog / custom-provider models we send this short fallback so
 * the upstream request is at least well-formed. The user's per-turn
 * `systemText` is still prepended into `turn/start` input.
 */
const FALLBACK_BASE_INSTRUCTIONS =
  'You are Codex, an AI coding assistant integrated into IM.codes. ' +
  'Follow the user\'s instructions precisely. ' +
  'Use available tools to inspect, edit, and run code as needed.';

/**
 * Resolve the `baseInstructions` to send with `thread/start` /
 * `thread/resume`. Always returns a non-empty string — codex-cli 0.125's
 * `session_startup_prewarm` will otherwise hand the upstream Responses API
 * an empty `instructions` field, which OpenAI now rejects with 400.
 *
 * Resolution order:
 *   1. `~/.codex/models_cache.json` → per-model `base_instructions`
 *      (preserves codex's full 12–22 KB per-model prompt, no regression)
 *   2. `FALLBACK_BASE_INSTRUCTIONS` (provider-neutral, short)
 */
async function resolveBaseInstructionsOverride(model: string | undefined): Promise<string> {
  if (model) {
    try {
      const cached = await getCodexBaseInstructions(model);
      if (cached && cached.length > 0) return cached;
    } catch {
      // Fall through to fallback.
    }
  }
  return FALLBACK_BASE_INSTRUCTIONS;
}

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: Record<string, any>;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export interface CodexDiscoveredModel {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  isDefault?: boolean;
}

interface CodexSdkSessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  mcpConfig?: Record<string, unknown>;
  model?: string;
  effort?: TransportEffortLevel;
  threadId?: string;
  loaded: boolean;
  runningTurnId?: string;
  runningCompact: boolean;
  currentMessageId: string | null;
  currentText: string;
  pendingComplete?: AgentMessage;
  cancelled: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  compactSettleTimer: ReturnType<typeof setTimeout> | null;
  compactHardTimer: ReturnType<typeof setTimeout> | null;
  compactObserved: boolean;
  lastInjectedSessionSystemText?: string;
  lastUsage?: {
    /**
     * Context-bar usage must represent the current prompt/window occupancy,
     * not cumulative billing/thread totals. Codex app-server emits both
     * `last` and `total`; `total` grows across turns and can exceed the model
     * context window, so provider-neutral fields normalize from `last` when
     * available and keep cumulative `total` fields only for diagnostics.
     */
    input_tokens: number;
    cache_read_input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    codex_total_input_tokens?: number;
    codex_total_cached_input_tokens?: number;
    codex_total_output_tokens?: number;
    codex_last_input_tokens?: number;
    codex_last_cached_input_tokens?: number;
    codex_last_output_tokens?: number;
  };
  lastStatusSignature: string | null;
}

function buildCodexMcpThreadConfig(config: SessionConfig): Record<string, unknown> | undefined {
  const server = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME];
  if (!server) return undefined;
  return {
    mcp_servers: {
      [IMCODES_MEMORY_MCP_SERVER_NAME]: {
        command: server.command,
        args: server.args,
        env: server.env,
      },
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizeCodexTokenUsage(params: Record<string, any>): CodexSdkSessionState['lastUsage'] | undefined {
  const tokenUsage = params.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined;

  const total = tokenUsage.total && typeof tokenUsage.total === 'object'
    ? tokenUsage.total as Record<string, unknown>
    : undefined;
  const last = tokenUsage.last && typeof tokenUsage.last === 'object'
    ? tokenUsage.last as Record<string, unknown>
    : undefined;
  if (!total && !last) return undefined;

  const totalInput = finiteNumber(total?.inputTokens);
  const totalCached = finiteNumber(total?.cachedInputTokens);
  const totalOutput = finiteNumber(total?.outputTokens);
  const lastInput = finiteNumber(last?.inputTokens);
  const lastCached = finiteNumber(last?.cachedInputTokens);
  const lastOutput = finiteNumber(last?.outputTokens);

  const inputTokens = lastInput ?? totalInput;
  const cachedTokens = lastCached ?? totalCached;
  const outputTokens = lastOutput ?? totalOutput;
  if (inputTokens === undefined && cachedTokens === undefined && outputTokens === undefined) return undefined;
  const cachedForUi = cachedTokens ?? 0;
  // Codex/OpenAI-style `inputTokens` includes cached input as a subset
  // (`totalTokens === inputTokens + outputTokens` in Codex JSONL). The web ctx
  // bar renders `inputTokens + cacheTokens`, matching Anthropic's split fields.
  // Therefore expose the uncached remainder as provider-neutral `input_tokens`
  // and carry the raw Codex total separately for diagnostics.
  const inputForUi = Math.max(0, (inputTokens ?? 0) - cachedForUi);

  const modelContextWindow = finiteNumber(tokenUsage.modelContextWindow)
    // Backward-compat with older tests / adapters that briefly placed this
    // beside `tokenUsage`; generated app-server types now nest it inside.
    ?? finiteNumber(params.modelContextWindow);

  return {
    input_tokens: inputForUi,
    cache_read_input_tokens: cachedForUi,
    // Keep Codex's native name too for diagnostics and direct provider users.
    cached_input_tokens: cachedForUi,
    output_tokens: outputTokens ?? 0,
    ...(finiteNumber(total?.totalTokens) !== undefined ? { total_tokens: finiteNumber(total?.totalTokens)! } : {}),
    ...(finiteNumber(total?.reasoningOutputTokens) !== undefined ? { reasoning_output_tokens: finiteNumber(total?.reasoningOutputTokens)! } : {}),
    ...(modelContextWindow !== undefined && modelContextWindow > 0 ? { model_context_window: modelContextWindow } : {}),
    ...(totalInput !== undefined ? { codex_total_input_tokens: totalInput } : {}),
    ...(totalCached !== undefined ? { codex_total_cached_input_tokens: totalCached } : {}),
    ...(totalOutput !== undefined ? { codex_total_output_tokens: totalOutput } : {}),
    ...(lastInput !== undefined ? { codex_last_input_tokens: lastInput } : {}),
    ...(lastCached !== undefined ? { codex_last_cached_input_tokens: lastCached } : {}),
    ...(lastOutput !== undefined ? { codex_last_output_tokens: lastOutput } : {}),
  };
}

function readParamThreadId(params: Record<string, any>): string | undefined {
  const threadId = params.threadId ?? params.thread_id ?? params.thread?.id ?? params.thread?.threadId ?? params.thread?.thread_id;
  return typeof threadId === 'string' && threadId.trim() ? threadId : undefined;
}

function readParamTurnId(params: Record<string, any>): string | undefined {
  const turnId = params.turnId ?? params.turn_id ?? params.turn?.id ?? params.turn?.turnId ?? params.turn?.turn_id;
  return typeof turnId === 'string' && turnId.trim() ? turnId : undefined;
}

function readThreadStatus(params: Record<string, any>): string | undefined {
  const raw = params.status ?? params.threadStatus ?? params.thread_status ?? params.thread?.status;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (!raw || typeof raw !== 'object') return undefined;
  const nested = (raw as Record<string, any>).type
    ?? (raw as Record<string, any>).kind
    ?? (raw as Record<string, any>).state
    ?? (raw as Record<string, any>).status;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function normalizeStatusName(status: string | undefined): string {
  return (status ?? '').replace(/[_\s-]+/g, '').toLowerCase();
}

function isThreadActiveStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'active'
    || normalized === 'running'
    || normalized === 'busy'
    || normalized === 'compacting'
    || normalized === 'inprogress';
}

function isThreadIdleStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'idle'
    || normalized === 'ready'
    || normalized === 'complete'
    || normalized === 'completed'
    || normalized === 'notloaded';
}

function toolFromItem(item: Record<string, any>, lifecycle: 'started' | 'completed'): ToolCallEvent | null {
  const meaningfulString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  switch (item.type) {
    case 'commandExecution':
      return {
        id: item.id,
        name: 'Bash',
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: { command: item.command },
        ...(item.status !== 'inProgress' ? { output: item.aggregatedOutput ?? item.output ?? '' } : {}),
        detail: {
          kind: 'commandExecution',
          summary: item.command,
          input: {
            command: item.command,
            cwd: item.cwd,
            actions: item.commandActions,
          },
          output: item.aggregatedOutput ?? item.output ?? '',
          meta: {
            status: item.status,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
            processId: item.processId,
          },
          raw: item,
        },
      };
    case 'mcpToolCall':
      return {
        id: item.id,
        name: `mcp:${item.server}:${item.tool}`,
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: item.arguments,
        ...(item.status === 'completed'
          ? { output: JSON.stringify(item.result?.structuredContent ?? item.result?.content ?? '') }
          : item.status === 'failed'
            ? { output: item.error?.message ?? 'failed' }
            : {}),
        detail: {
          kind: 'mcpToolCall',
          summary: `${item.server}:${item.tool}`,
          input: item.arguments,
          output: item.result?.structuredContent ?? item.result?.content ?? item.error?.message,
          meta: {
            server: item.server,
            tool: item.tool,
            status: item.status,
          },
          raw: item,
        },
      };
    case 'fileChange':
      return {
        id: item.id,
        name: 'Patch',
        status: lifecycle === 'started' || item.status === 'inProgress'
          ? 'running'
          : item.status === 'completed'
            ? 'complete'
            : 'error',
        input: { changes: item.changes },
        detail: {
          kind: 'fileChange',
          summary: Array.isArray(item.changes) ? `${item.changes.length} change(s)` : undefined,
          input: { changes: item.changes },
          output: item.output,
          meta: { status: item.status },
          raw: item,
        },
      };
    case 'webSearch': {
      // The Codex CLI emits `WebSearchAction` as a tagged enum:
      //   { type: 'search',        query: '...' }
      //   { type: 'find_in_page',  pattern: '...', url?: '...' }
      //   { type: 'open_page',     url:   '...' }
      //   { type: 'other' }                       // unknown / catch-all
      //
      // Older CLI versions also surfaced a top-level `item.query`. The
      // current binary does NOT — for the `search` variant the query is
      // nested under `item.action.query`, and for the catch-all `other`
      // there's no query at all.
      //
      // Rendering contract: `input` is the flat summary payload the web UI
      // shows next to the tool name; `detail.raw` keeps the original item
      // for the expand panel. Do NOT inline the raw `action` object into
      // `input` — `summarizeToolInput` walks `TOOL_INPUT_SUMMARY_KEYS`
      // (`query` first); when `query` is an empty string it's treated as
      // not-useful, the walker falls through to all keys, and with two
      // entries (`query` + `action`) the renderer fallbacks to
      // `JSON.stringify(input)` — that's where the
      // `{"query":"","action":{"type":"other"}}` screen artifact came from.
      const action = item.action as Record<string, unknown> | undefined;
      const actionType = meaningfulString(action?.type);
      const actionQuery = meaningfulString(action?.query);
      const actionPattern = meaningfulString(action?.pattern);
      const actionUrl = meaningfulString(action?.url);
      const topLevelQuery = meaningfulString(item.query);
      // Pick the single best human-readable label for the flat `input.query`
      // slot. Priority: explicit query → pattern → url → bracketed action
      // type (`(other)` / `(open_page)`) for the no-info fallback. The UI
      // treats the result as an opaque string, so any of these values flow
      // through `summarizeToolInput` without triggering the empty-string
      // fallback branch.
      const bestLabel = topLevelQuery
        ?? actionQuery
        ?? actionPattern
        ?? actionUrl
        ?? (actionType ? `(${actionType})` : '(web_search)');
      return {
        id: item.id,
        name: 'WebSearch',
        status: lifecycle === 'started' ? 'running' : 'complete',
        input: {
          // Single-key payload: `summarizeToolInput` picks `query` first
          // and short-circuits, so the chat row reads `WebSearch <label>`
          // regardless of which enum variant Codex produced.
          query: bestLabel,
        },
        detail: {
          kind: 'webSearch',
          summary: bestLabel,
          input: {
            query: bestLabel,
            ...(actionPattern ? { pattern: actionPattern } : {}),
            ...(actionUrl ? { url: actionUrl } : {}),
            action,
          },
          meta: { actionType },
          raw: item,
        },
      };
    }
    default:
      return null;
  }
}

export class CodexSdkProvider implements TransportProvider {
  readonly id = 'codex-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: CODEX_SDK_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
    compact: {
      execution: 'sdk-rpc',
      verified: true,
      completion: 'provider-event',
      cancellation: 'local-cancel',
    },
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CodexSdkSessionState>();
  private threadToSession = new Map<string, string>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, update: ProviderUsageUpdate) => void> = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private appServerAuthFingerprint: string | null = null;
  private appServerRestart: Promise<void> | null = null;

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.resolveBinaryPath(config);
    // Resolve the binary (handles npm .cmd shims on Windows) and verify it.
    const resolved = resolveExecutableForSpawn(binaryPath);
    await access(resolved.executable, fsConstants.X_OK).catch(async () => {
      // Fall back to spawn-based version probe (works for things on PATH).
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
    });
    await this.startAppServer(binaryPath, config, { clearSessions: true });
    logger.info({ provider: this.id, resolved: resolved.executable, prepend: resolved.prependArgs }, 'Codex SDK provider connected via app-server');
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config && this.child ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config && this.child),
      degradedReasons: [],
    };
  }

  async disconnect(): Promise<void> {
    await this.stopAppServer({ clearSessions: true });
  }

  async createSession(config: SessionConfig): Promise<string> {
    await this.refreshAppServerForLatestAuth('create-session');
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    this.sessions.set(routeId, {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: { ...(existing?.env ?? {}), ...((config.env as Record<string, string> | undefined) ?? {}) },
      mcpConfig: buildCodexMcpThreadConfig(config) ?? existing?.mcpConfig,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      effort: config.effort ?? existing?.effort,
      threadId: config.resumeId ?? existing?.threadId,
      loaded: false,
      runningTurnId: undefined,
      runningCompact: false,
      currentMessageId: null,
      currentText: '',
      pendingComplete: undefined,
      cancelled: false,
      cancelTimer: null,
      compactSettleTimer: null,
      compactHardTimer: null,
      compactObserved: false,
      lastInjectedSessionSystemText: existing?.lastInjectedSessionSystemText,
      lastUsage: undefined,
      lastStatusSignature: null,
    });
    if (config.resumeId || config.effort) this.emitSessionInfo(routeId, { ...(config.resumeId ? { resumeId: config.resumeId } : {}), ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);
    if (state.threadId && state.loaded) {
      await this.request('thread/unsubscribe', { threadId: state.threadId }).catch(() => {});
      this.threadToSession.delete(state.threadId);
    }
    this.sessions.delete(sessionId);
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => {
      const idx = this.deltaCallbacks.indexOf(cb);
      if (idx >= 0) this.deltaCallbacks.splice(idx, 1);
    };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => {
      const idx = this.completeCallbacks.indexOf(cb);
      if (idx >= 0) this.completeCallbacks.splice(idx, 1);
    };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => {
      const idx = this.errorCallbacks.indexOf(cb);
      if (idx >= 0) this.errorCallbacks.splice(idx, 1);
    };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => {
      const idx = this.sessionInfoCallbacks.indexOf(cb);
      if (idx >= 0) this.sessionInfoCallbacks.splice(idx, 1);
    };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      const idx = this.statusCallbacks.indexOf(cb);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
    };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => {
      const idx = this.usageCallbacks.indexOf(cb);
      if (idx >= 0) this.usageCallbacks.splice(idx, 1);
    };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    this.emitSessionInfo(sessionId, { effort });
  }

  async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload, attachments?: TransportAttachment[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Codex SDK session: ${sessionId}`, false);
    }
    if (state.runningTurnId || state.runningCompact) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex SDK session is already busy', true);
    }
    await this.refreshAppServerForLatestAuth('send');
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }

    state.currentText = '';
    state.currentMessageId = null;
    state.pendingComplete = undefined;
    state.cancelled = false;
    this.clearCancelTimer(state);
    state.lastUsage = undefined;
    state.lastStatusSignature = null;
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (this.isCompactCommand(payload)) {
      await this.startCompact(sessionId, state);
      return;
    }
    await this.startTurn(sessionId, state, payload);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    // Mark cancellation before checking threadId/runningTurnId. STOP can land
    // while Codex app-server is still answering thread/start or turn/start; in
    // that window there is not yet a turn id to interrupt. The cancelled flag
    // carries the request across those async boundaries so startTurn() issues
    // turn/interrupt as soon as Codex exposes the id.
    state.cancelled = true;
    if (!state.threadId) return;
    if (state.runningCompact) {
      const turnId = state.runningTurnId;
      if (turnId) {
        void this.request('turn/interrupt', {
          threadId: state.threadId,
          turnId,
        }).catch(() => {});
      }
      this.cancelCompactLocally(sessionId, state);
      return;
    }
    const turnId = state.runningTurnId;
    if (!turnId) return;
    await this.interruptRunningTurn(sessionId, state, turnId);
  }

  private async interruptRunningTurn(
    sessionId: string,
    state: CodexSdkSessionState,
    turnId: string,
  ): Promise<void> {
    state.cancelled = true;
    if (!state.threadId) return;
    // Fire-and-watchdog. Do not await turn/interrupt acknowledgement before
    // arming the local cancellation timer; an app-server/RPC hang must not
    // leave the UI stuck in "stopping" forever.
    void this.request('turn/interrupt', {
      threadId: state.threadId,
      turnId,
    }, CANCEL_INTERRUPT_TIMEOUT_MS).catch(() => {});
    this.clearCancelTimer(state);
    state.cancelTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (state.runningTurnId !== turnId) return;
      this.clearStatus(sessionId, state);
      state.runningTurnId = undefined;
      state.pendingComplete = undefined;
      this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
    }, CANCEL_INTERRUPT_TIMEOUT_MS);
    state.cancelTimer.unref?.();
  }

  private buildSpawnEnv(config: ProviderConfig): Record<string, string | undefined> {
    return { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) };
  }

  private async stopAppServer(options: { clearSessions: boolean }): Promise<void> {
    this.rejectPending(new Error('Codex app-server disconnected'));
    this.rl?.close();
    this.rl = null;
    for (const [sessionId, state] of this.sessions) {
      this.clearCancelTimer(state);
      this.clearCompactTimers(state);
      if (!options.clearSessions) {
        this.clearStatus(sessionId, state);
        state.loaded = false;
        state.runningTurnId = undefined;
        state.runningCompact = false;
        state.compactObserved = false;
        state.currentMessageId = null;
        state.currentText = '';
        state.pendingComplete = undefined;
        state.cancelled = false;
        state.lastStatusSignature = null;
      }
    }
    // `child.kill('SIGTERM')` only terminates the node wrapper; the native
    // codex binary it spawned lives on and leaks ~60MB per abandoned pair.
    // Walk the descendant tree and tree-kill instead.
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      void killProcessTree(child);
    }
    this.threadToSession.clear();
    this.appServerAuthFingerprint = null;
    if (options.clearSessions) {
      this.sessions.clear();
      this.config = null;
    }
  }

  private async startAppServer(
    binaryPath: string,
    config: ProviderConfig,
    options: { clearSessions: boolean },
  ): Promise<void> {
    await this.stopAppServer({ clearSessions: options.clearSessions }).catch(() => {});
    // Resolve npm .cmd shims into (node.exe, [scriptPath]) so spawn works
    // without shell:true (which has its own quoting issues on Windows).
    const resolved = resolveExecutableForSpawn(binaryPath);
    const args = [...resolved.prependArgs, ...getDefaultCodexMcpArgs(), 'app-server'];
    const spawnEnv = this.buildSpawnEnv(config);
    const authFingerprint = await readCodexAuthFingerprint(spawnEnv);
    const child = spawn(resolved.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      windowsHide: true,
    });
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) logger.debug({ provider: this.id, stderr: text.trim() }, 'Codex app-server stderr');
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      const err = new Error(`Codex app-server exited with code ${code ?? 'unknown'}`);
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.appServerAuthFingerprint = null;
    });
    // CRITICAL: must listen for 'error' or spawn failures (e.g. ENOENT) become
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      if (this.child !== child) return;
      logger.error({ provider: this.id, err }, 'Codex app-server spawn error');
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.appServerAuthFingerprint = null;
    });

    try {
      await this.request('initialize', {
        clientInfo: { name: 'imcodes', title: 'IM.codes', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.config = config;
      this.appServerAuthFingerprint = authFingerprint;
    } catch (err) {
      await this.stopAppServer({ clearSessions: options.clearSessions }).catch(() => {});
      throw err;
    }
  }

  private async refreshAppServerForLatestAuth(reason: string): Promise<void> {
    if (this.appServerRestart) await this.appServerRestart;
    if (!this.config || !this.child) return;
    const current = await readCodexAuthFingerprint(this.buildSpawnEnv(this.config));
    if (current === this.appServerAuthFingerprint) return;
    logger.info({
      provider: this.id,
      reason,
      previousAuthPresent: this.appServerAuthFingerprint !== null,
      currentAuthPresent: current !== null,
    }, 'Codex auth file changed; restarting app-server to load latest authentication');
    await this.restartAppServerPreservingSessions(reason);
  }

  private async restartAppServerPreservingSessions(reason: string): Promise<void> {
    if (this.appServerRestart) return this.appServerRestart;
    const config = this.config;
    if (!config) return;
    const binaryPath = this.resolveBinaryPath(config);
    this.appServerRestart = (async () => {
      await this.startAppServer(binaryPath, config, { clearSessions: false });
    })().finally(() => {
      this.appServerRestart = null;
    });
    return this.appServerRestart;
  }

  private async restartAppServerAfterAuthFailure(reason: string, error: ProviderError): Promise<void> {
    logger.warn({
      provider: this.id,
      reason,
      code: error.code,
      message: error.message,
    }, 'Codex app-server authentication failed; restarting to load latest authentication');
    await this.restartAppServerPreservingSessions(reason);
  }

  private async startTurn(sessionId: string, state: CodexSdkSessionState, payload: ProviderContextPayload): Promise<void> {
    try {
      const desiredSessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
      const shouldInjectStableUpdate = !!(
        state.threadId
        && state.loaded
        && desiredSessionSystemText
        && state.lastInjectedSessionSystemText !== desiredSessionSystemText
      );
      await this.ensureThreadLoaded(sessionId, state, payload);
      const inputText = buildCodexTurnInput(payload, shouldInjectStableUpdate ? desiredSessionSystemText : undefined);
      const result = await this.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: inputText }],
        cwd: state.cwd,
        ...this.sessionEnvironmentParams(state),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(state.model ? { model: state.model } : {}),
        ...(state.effort ? { effort: state.effort } : {}),
      });
      if (desiredSessionSystemText) state.lastInjectedSessionSystemText = desiredSessionSystemText;
      state.runningTurnId = result?.turn?.id;
      if (state.cancelled && state.runningTurnId) {
        await this.interruptRunningTurn(sessionId, state, state.runningTurnId);
      }
    } catch (err) {
      state.runningTurnId = undefined;
      const error = this.normalizeError(err);
      if (this.isCodexAuthError(error)) {
        await this.restartAppServerAfterAuthFailure('start-turn', error).catch((restartErr) => {
          logger.warn({ provider: this.id, err: restartErr }, 'Codex app-server auth refresh restart failed');
        });
      }
      this.emitError(sessionId, error);
    }
  }

  private isCompactCommand(payload: ProviderContextPayload): boolean {
    // Codex slash commands are app-client controls, not ordinary model text.
    // The daemon still forwards `/compact` through the ordinary transport send
    // path; this provider adapter is the SDK boundary that maps the raw command
    // to Codex app-server's native compaction RPC. Using `assembledMessage`
    // here would be wrong because shared-context/preference preambles may wrap
    // the provider-visible text, while `userMessage` preserves the user's raw
    // command token.
    return isSessionControlCommandText(payload.userMessage, 'compact');
  }

  private async startCompact(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    try {
      await this.ensureThreadLoaded(sessionId, state);
      state.runningCompact = true;
      state.compactObserved = false;
      state.currentText = '';
      state.currentMessageId = null;
      this.emitStatus(sessionId, state, {
        status: 'compacting',
        label: 'Compacting context...',
      });
      this.armCompactHardTimeout(sessionId, state);
      const result = await this.request('thread/compact/start', {
        threadId: state.threadId,
      }, COMPACT_START_ACCEPT_TIMEOUT_MS);
      // Some Codex app-server builds accept `thread/compact/start` as a
      // synchronous/no-op request when there is no compactable turn and never
      // emit `thread/compacted` or a `contextCompaction` item. Do not leave the
      // IM.codes runtime permanently busy in that accepted-but-silent state;
      // give the native event stream a short grace window, then settle the UI
      // as a completed native compact request. If a real compaction item/status
      // arrives, `compactObserved` cancels this fallback and we wait for the
      // native completion signal instead.
      if (state.runningCompact && !state.compactObserved) {
        this.armCompactNoSignalSettle(sessionId, state, readParamTurnId(result ?? {}));
      }
    } catch (err) {
      this.clearCompactTimers(state);
      this.clearStatus(sessionId, state);
      state.runningCompact = false;
      state.runningTurnId = undefined;
      state.compactObserved = false;
      this.emitError(sessionId, this.normalizeError(err));
    }
  }

  private async ensureThreadLoaded(sessionId: string, state: CodexSdkSessionState, payload?: ProviderContextPayload): Promise<void> {
    if (state.threadId && state.loaded) return;

    // Always send `baseInstructions`. Catalog models get codex's full
    // per-model prompt (lifted from `~/.codex/models_cache.json`); unknown
    // models fall back to a short provider-neutral default. Either way, the
    // Responses API never sees an empty `instructions` field, which it now
    // rejects with `{"type":"invalid_request_error","message":"Instructions
    // are required"}`.
    const resolvedBaseInstructions = await resolveBaseInstructionsOverride(state.model);
    const baseInstructions = payload
      ? appendImcodesBaseInstructions(resolvedBaseInstructions, payload)
      : resolvedBaseInstructions;
    const sessionSystemText = payload ? getProviderSystemTextParts(payload).sessionSystemText : undefined;

    if (state.threadId) {
      try {
        await this.resumeThread(sessionId, state, baseInstructions);
        state.lastInjectedSessionSystemText = sessionSystemText;
        return;
      } catch (err) {
        if (!isCodexThreadHistoryUnreadableError(err)) throw err;

        const repaired = await this.repairUnreadableThreadHistory(err).catch((repairErr) => {
          logger.warn({ provider: this.id, sessionId, threadId: state.threadId, err: repairErr }, 'Codex SDK failed to repair unreadable thread history');
          return false;
        });
        if (repaired) {
          try {
            await this.resumeThread(sessionId, state, baseInstructions);
            state.lastInjectedSessionSystemText = sessionSystemText;
            return;
          } catch (retryErr) {
            logger.warn({ provider: this.id, sessionId, threadId: state.threadId, err: retryErr }, 'Codex SDK resume still failed after thread history repair');
          }
        }

        const oldThreadId = state.threadId;
        logger.warn({ provider: this.id, sessionId, threadId: oldThreadId, err }, 'Codex SDK stored thread history is unreadable; starting replacement thread');
        if (oldThreadId) this.threadToSession.delete(oldThreadId);
        state.threadId = undefined;
        state.loaded = false;
      }
    }

    await this.startNewThread(sessionId, state, baseInstructions);
    state.lastInjectedSessionSystemText = sessionSystemText;
  }

  private async resumeThread(sessionId: string, state: CodexSdkSessionState, baseInstructions: string): Promise<void> {
    if (!state.threadId) throw new Error('Codex SDK resume requested without a thread id');
    // Resume must carry the same `baseInstructions`: previously-broken
    // threads were persisted with empty base_instructions, and codex's
    // resolution priority (override > stored history > model default)
    // means supplying it on resume is the only way to repair them
    // mid-flight.
    const result = await this.request('thread/resume', {
      threadId: state.threadId,
      ...this.sessionEnvironmentParams(state),
      ...this.sessionMcpConfigParams(state),
      ...(state.model ? { model: state.model } : {}),
      baseInstructions,
    });
    const resumedId = result?.thread?.id ?? state.threadId;
    state.threadId = resumedId;
    state.loaded = true;
    this.threadToSession.set(resumedId, sessionId);
    this.emitSessionInfo(sessionId, { resumeId: resumedId, ...(state.model ? { model: state.model } : {}) });
  }

  private async startNewThread(sessionId: string, state: CodexSdkSessionState, baseInstructions: string): Promise<void> {
    const result = await this.request('thread/start', {
      cwd: state.cwd,
      ...this.sessionEnvironmentParams(state),
      ...this.sessionMcpConfigParams(state),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      personality: 'none',
      ...(state.model ? { model: state.model } : {}),
      baseInstructions,
    });
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id');
    }
    state.threadId = threadId;
    state.loaded = true;
    this.threadToSession.set(threadId, sessionId);
    this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
  }

  private async repairUnreadableThreadHistory(err: unknown): Promise<boolean> {
    const message = errorMessage(err);
    const filePath = extractCodexJsonlPath(message);
    if (!filePath) return false;

    const before = await readFile(filePath);
    const hadInvalidUtf8 = !isValidUtf8(before);
    const repaired = repairCodexJsonlText(before.toString('utf8'));
    if (!hadInvalidUtf8 && repaired.droppedLineCount === 0) return false;

    const backupPath = `${filePath}.invalid-history-${Date.now()}.bak`;
    await copyFile(filePath, backupPath);
    await writeFile(filePath, Buffer.from(repaired.text, 'utf8'));
    logger.warn({ provider: this.id, filePath, backupPath, hadInvalidUtf8, droppedLineCount: repaired.droppedLineCount }, 'Codex SDK repaired unreadable thread history');
    return true;
  }

  private sessionEnvironmentParams(state: CodexSdkSessionState): { env?: Record<string, string> } {
    return state.env && Object.keys(state.env).length > 0 ? { env: state.env } : {};
  }

  private sessionMcpConfigParams(state: CodexSdkSessionState): { config?: Record<string, unknown> } {
    return state.mcpConfig ? { config: state.mcpConfig } : {};
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logger.warn({ provider: this.id, line: trimmed, err }, 'Failed to parse Codex app-server line');
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'Codex app-server request failed'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleNotification(method: string, params: Record<string, any>): void {
    if (method === 'thread/started') {
      const threadId = params.thread?.id;
      if (!threadId) return;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) return;
      const state = this.sessions.get(sessionId);
      if (!state) return;
      state.threadId = threadId;
      state.loaded = true;
      this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const normalizedUsage = normalizeCodexTokenUsage(params);
      if (!normalizedUsage) return;
      state.lastUsage = normalizedUsage;
      for (const cb of this.usageCallbacks) cb(sessionId, {
        usage: normalizedUsage,
        ...(state.model ? { model: state.model } : {}),
      });
      return;
    }

    if (method === 'thread/compacted') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state || !state.runningCompact) return;
      this.completeCompact(sessionId, state, readParamTurnId(params));
      return;
    }

    if (method === 'thread/status/changed') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state || !state.runningCompact) return;
      const status = readThreadStatus(params);
      if (isThreadActiveStatus(status)) {
        state.compactObserved = true;
        this.clearCompactSettleTimer(state);
        this.emitStatus(sessionId, state, {
          status: 'compacting',
          label: 'Compacting context...',
        });
        return;
      }
      if (isThreadIdleStatus(status)) {
        this.completeCompact(sessionId, state, readParamTurnId(params));
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      if (state.cancelled) return;
      this.clearStatus(sessionId, state);
      state.currentMessageId = params.itemId;
      state.currentText += String(params.delta ?? '');
      const delta: MessageDelta = {
        messageId: params.itemId,
        type: 'text',
        delta: state.currentText,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionId, delta);
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;

      const item = params.item as Record<string, any> | undefined;
      if (!item) return;

      if (item.type === 'contextCompaction') {
        state.runningCompact = true;
        state.compactObserved = true;
        this.clearCompactSettleTimer(state);
        state.runningTurnId = readParamTurnId(params) ?? state.runningTurnId;
        if (method === 'item/completed') {
          this.completeCompact(sessionId, state, readParamTurnId(params));
          return;
        }
        this.emitStatus(sessionId, state, {
          status: 'compacting',
          label: 'Compacting context...',
        });
        return;
      }

      if (state.cancelled) return;

      if (item.type === 'reasoning') {
        this.emitStatus(sessionId, state, {
          status: 'thinking',
          label: 'Thinking...',
        });
        return;
      }

      this.clearStatus(sessionId, state);

      const tool = toolFromItem(item, method === 'item/started' ? 'started' : 'completed');
      if (tool) {
        for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
      }

      if (item.type === 'agentMessage') {
        state.currentMessageId = item.id;
        if (method === 'item/completed' && typeof item.text === 'string') {
          const prior = state.currentText;
          state.currentText = item.text;
          if (!prior && item.text) {
            const delta: MessageDelta = {
              messageId: item.id,
              type: 'text',
              delta: item.text,
              role: 'assistant',
            };
            for (const cb of this.deltaCallbacks) cb(sessionId, delta);
          }
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const turn = params.turn ?? {};
      const status = turn.status;

      if (status === 'failed') {
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        this.clearStatus(sessionId, state);
        state.runningCompact = false;
        state.compactObserved = false;
        state.runningTurnId = undefined;
        const error = this.normalizeError(turn.error?.message ?? 'Codex turn failed', turn.error);
        if (this.isCodexAuthError(error)) {
          void this.restartAppServerAfterAuthFailure('turn-failed', error).catch((restartErr) => {
            logger.warn({ provider: this.id, err: restartErr }, 'Codex app-server auth refresh restart failed');
          });
        }
        this.emitError(sessionId, error);
        return;
      }
      if (status === 'interrupted') {
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        state.runningCompact = false;
        state.compactObserved = false;
        if (!state.runningTurnId && state.cancelled) {
          state.cancelled = false;
          return;
        }
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
      }

      if (state.runningCompact) {
        this.completeCompact(sessionId, state, typeof turn.id === 'string' ? turn.id : undefined);
        return;
      }

      if (state.cancelled) {
        this.clearCancelTimer(state);
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        state.pendingComplete = undefined;
        state.currentMessageId = null;
        state.currentText = '';
        state.cancelled = false;
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
      }

      this.clearCancelTimer(state);
      this.clearStatus(sessionId, state);
      state.pendingComplete = {
        id: state.currentMessageId ?? `${sessionId}:agent-message`,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: state.currentText,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          ...(state.lastUsage ? { usage: state.lastUsage } : {}),
          ...(state.model ? { model: state.model } : {}),
          ...(state.threadId ? { resumeId: state.threadId } : {}),
        },
      };
      state.runningTurnId = undefined;
      const completed = state.pendingComplete;
      state.pendingComplete = undefined;
      if (completed) {
        for (const cb of this.completeCallbacks) cb(sessionId, completed);
      }
      return;
    }
  }

  private request(method: string, params: Record<string, any>, timeoutMs?: number): Promise<any> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          if (!this.pendingRequests.delete(id)) return;
          reject(new Error(`Codex app-server request ${method} did not settle within ${Math.round(timeoutMs)}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pendingRequests.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.child!.stdin.write(`${payload}\n`);
    });
  }

  private completeCompact(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);
    this.clearStatus(sessionId, state);
    state.runningCompact = false;
    state.runningTurnId = undefined;
    state.compactObserved = false;
    state.currentMessageId = null;
    state.currentText = '';
    const completed: AgentMessage = {
      id: turnId ? `${turnId}:context-compaction` : `${sessionId}:context-compaction:${Date.now()}`,
      sessionId,
      kind: 'system',
      role: 'system',
      content: 'Codex context compacted.',
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        event: 'thread/compacted',
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        ...(state.threadId ? { resumeId: state.threadId } : {}),
        ...(turnId ? { turnId } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, completed);
  }

  /**
   * Expose the `account/rateLimits/read` RPC over the already-connected
   * app-server so callers (e.g. the daemon's rate-limit probe) can reuse
   * this singleton instead of spawning a one-shot codex child. Returns
   * `undefined` if the provider isn't connected or the RPC doesn't include
   * a `rateLimits` payload — the caller then falls back to a fresh spawn.
   *
   * Keeping this method on the provider (rather than exposing `request`
   * publicly) keeps the RPC surface area explicit: future reuse targets
   * (usage summary, plan type, etc.) should each get their own public
   * wrapper.
   */
  async readRateLimits(): Promise<Record<string, unknown> | undefined> {
    if (!this.child || !this.child.stdin.writable) return undefined;
    try {
      await this.refreshAppServerForLatestAuth('rate-limits').catch(() => {});
      const result = await this.request('account/rateLimits/read', {});
      if (result && typeof result === 'object' && 'rateLimits' in (result as Record<string, unknown>)) {
        const payload = (result as Record<string, unknown>).rateLimits;
        return payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    try {
      const { getCodexRuntimeConfig } = await import('../codex-runtime-config.js');
      const cfg = await getCodexRuntimeConfig(force ?? false);
      return {
        models: (cfg.models ?? []).map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
        })),
        ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
        ...(typeof cfg.isAuthenticated === 'boolean' ? { isAuthenticated: cfg.isAuthenticated } : {}),
        ...(cfg.probeError ? { error: cfg.probeError } : {}),
      };
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async readModelList(): Promise<CodexDiscoveredModel[] | undefined> {
    if (!this.child || !this.child.stdin.writable) return undefined;
    try {
      await this.refreshAppServerForLatestAuth('model-list').catch(() => {});
      const discovered: CodexDiscoveredModel[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await this.request('model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        const data = Array.isArray(result?.data) ? result.data : [];
        for (const entry of data) {
          if (!entry || typeof entry !== 'object') continue;
          const modelId = typeof entry.model === 'string' && entry.model.trim()
            ? entry.model.trim()
            : typeof entry.id === 'string' && entry.id.trim()
              ? entry.id.trim()
              : '';
          if (!modelId || seen.has(modelId)) continue;
          seen.add(modelId);
          discovered.push({
            id: modelId,
            ...(typeof entry.displayName === 'string' && entry.displayName.trim()
              ? { name: entry.displayName.trim() }
              : {}),
            ...(Array.isArray(entry.supportedReasoningEfforts) && entry.supportedReasoningEfforts.length > 0
              ? { supportsReasoningEffort: true }
              : {}),
            ...(entry.isDefault === true ? { isDefault: true } : {}),
          });
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor.trim()
          ? result.nextCursor.trim()
          : null;
      } while (cursor);
      return discovered;
    } catch {
      return undefined;
    }
  }

  private notify(method: string, params: Record<string, any>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(err);
    this.pendingRequests.clear();
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: CodexSdkSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({
      status: status.status,
      label: status.label ?? null,
    });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: CodexSdkSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private cancelCompactLocally(sessionId: string, state: CodexSdkSessionState): void {
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);
    this.clearStatus(sessionId, state);
    state.runningCompact = false;
    state.runningTurnId = undefined;
    state.compactObserved = false;
    state.currentMessageId = null;
    state.currentText = '';
    state.pendingComplete = undefined;
    this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex compact cancelled', true));
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CODEX_BIN;
  }

  private normalizeError(err: unknown, details?: unknown): ProviderError {
    const message = errorMessage(err);
    if (/ENOENT|not found|spawn .*codex/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Codex binary not found: ${message}`, false, err);
    }
    if (isCodexAuthFailureMessage(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, details ?? err);
    }
    if (isCodexThreadHistoryUnreadableError(err) || (/resume|thread/i.test(message) && /not found|invalid|unknown/i.test(message))) {
      return this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, message, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  private isCodexAuthError(error: ProviderError): boolean {
    return error.code === PROVIDER_ERROR_CODES.AUTH_FAILED || isCodexAuthFailureMessage(error.message);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }

  private clearCancelTimer(state: CodexSdkSessionState): void {
    if (!state.cancelTimer) return;
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }

  private armCompactNoSignalSettle(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    this.clearCompactSettleTimer(state);
    state.compactSettleTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (!state.runningCompact || state.compactObserved) return;
      this.completeCompact(sessionId, state, turnId);
    }, COMPACT_NO_SIGNAL_SETTLE_MS);
    state.compactSettleTimer.unref?.();
  }

  private armCompactHardTimeout(sessionId: string, state: CodexSdkSessionState): void {
    this.clearCompactHardTimer(state);
    state.compactHardTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (!state.runningCompact) return;
      this.clearCompactTimers(state);
      this.clearStatus(sessionId, state);
      state.runningCompact = false;
      state.runningTurnId = undefined;
      state.compactObserved = false;
      state.currentMessageId = null;
      state.currentText = '';
      this.emitError(sessionId, this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        `Codex SDK compact did not complete within ${Math.round(COMPACT_HARD_TIMEOUT_MS)}ms`,
        true,
      ));
    }, COMPACT_HARD_TIMEOUT_MS);
    state.compactHardTimer.unref?.();
  }

  private clearCompactSettleTimer(state: CodexSdkSessionState): void {
    if (!state.compactSettleTimer) return;
    clearTimeout(state.compactSettleTimer);
    state.compactSettleTimer = null;
  }

  private clearCompactHardTimer(state: CodexSdkSessionState): void {
    if (!state.compactHardTimer) return;
    clearTimeout(state.compactHardTimer);
    state.compactHardTimer = null;
  }

  private clearCompactTimers(state: CodexSdkSessionState): void {
    this.clearCompactSettleTimer(state);
    this.clearCompactHardTimer(state);
  }
}
