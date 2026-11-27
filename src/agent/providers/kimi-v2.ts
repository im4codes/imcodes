/**
 * KimiV2Provider — standalone TransportProvider for Kimi Code CLI (`kimi acp`).
 *
 * Aligns `kimi-sdk` with Kimi Code CLI v2 (`@moonshot-ai/kimi-code` 2.8.x)
 * while maintaining full backward compatibility with legacy Python `kimi-cli`
 * 1.x (`kimi acp`). Intentionally standalone from `kimi-sdk.ts` so sibling
 * subclasses (`agy-acp`, `grok-sdk`, `codebuddy`, `hermes-acp`) remain untouched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  ndJsonStream,
  RequestError,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk/unstable';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
  type ApprovalRequest,
  type ConnectionMode,
  type ProviderCancelOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderError,
  type ProviderModelInfo,
  type ProviderModelList,
  type ProviderUsageUpdate,
  type RemoteSessionInfo,
  type RemoteSessionListOptions,
  type SessionConfig,
  type SessionInfoUpdate,
  type SessionOwnership,
  type TransportProvider,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { ProviderActiveWorkSnapshot, SessionActivityBusyReason } from '../../../shared/session-activity-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { isSessionControlCommandText } from '../../../shared/session-control-commands.js';
import { SESSION_MODEL_APPLIED, type SessionModelApplied } from '../../../shared/session-model-control.js';
import { MEMORY_MCP_PROVIDER_STATUS_REASON, MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { createAcpClientConnection, type AcpClientConnection } from './acp-client-adapter.js';
import { filterAcpJsonLines } from './acp-json-filter.js';
import { acpPlanEntriesToInput } from './acp-plan.js';
import { getDefaultAcpMcpServers, type AcpMcpServerConfig } from './getDefaultMcpServers.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { confirmPromiseStop } from '../provider-stop-confirmation.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';
import {
  canonicalizeTransportCwd,
  normalizeTransportCwd,
  resolveExecutableForSpawn,
  resolveKimiPathForSdk,
  type ResolvedExecutable,
} from '../transport-paths.js';
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { withTimeoutOutcome } from '../../util/timeout-outcome.js';
import logger from '../../util/logger.js';

const INIT_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 30_000;
const MODEL_PROBE_TTL_MS = 30_000;
const CANCEL_GRACE_MS = 10_000;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 40;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

type JsonRecord = Record<string, unknown>;

export interface KimiV2ProviderOptions {
  initTimeoutMs?: number;
  sessionTimeoutMs?: number;
  cancelGraceMs?: number;
  modelProbeTtlMs?: number;
}

interface PendingTurn {
  messageId: string;
  accumulated: string;
  assistantTextClosed: boolean;
  userInitiatedCancel: boolean;
  cancelRejectCode: string | null;
  cancelGraceTimer: ReturnType<typeof setTimeout> | null;
  terminalTarget: object;
  settled: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
  settledPromise: Promise<void>;
  markSettled: () => void;
  wireSlot: Promise<void>;
}

interface PendingApproval {
  requestId: string;
  resolve: (res: RequestPermissionResponse) => void;
  reject: (err: Error) => void;
  options: RequestPermissionRequest['options'];
}

interface ActiveToolState {
  id: string;
  name: string;
  kind?: string;
  input?: unknown;
  status: 'running' | 'complete' | 'error';
}

interface KimiSessionState {
  sessionKey: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  mode?: string;
  systemText?: string;
  lastInjectedSessionSystemKey?: string;
  systemTextInjected: boolean;
  replaying: boolean;
  pendingTurn: PendingTurn | null;
  activeTools: Map<string, ActiveToolState>;
  pendingApprovals: Map<string, PendingApproval>;
  mcpServers: AcpMcpServerConfig[];
  env?: Record<string, string>;
}

interface AcpRoute {
  providerSessionId: string;
  state: KimiSessionState;
  stack: string[];
}

interface ExtractedModelCatalog {
  models: ProviderModelInfo[];
  defaultModel?: string;
  hasConfigOption: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    return err.code === -32800 || /cancel|abort/i.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /abort|cancel/i.test(msg);
}

function isAuthLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    if (err.code === -32000) return true;
    const dataMsg = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
    return /auth|unauthorized|api.?key|login|token/i.test(`${err.message} ${dataMsg}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /auth(?:entication)?\s+required|unauthorized|api.?key|not\s+logged\s+in|-32000/i.test(msg);
}

function isSessionNotFoundError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    if (err.code === -32002 || err.code === -32004) return true;
    const dataMsg = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
    if (/not\s*found|unknown\s+session|no\s+such\s+session|session\s+does\s+not\s+exist/i.test(`${err.message} ${dataMsg}`)) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /session\s+(?:not\s+found|does\s+not\s+exist|expired|unknown)|not\s+found/i.test(msg);
}

function isMethodNotFoundError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError && err.code === -32601) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /method\s+not\s+found|-32601/i.test(msg);
}

function inferErrorCode(err: unknown): string {
  if (isAuthLikeError(err)) return PROVIDER_ERROR_CODES.AUTH_FAILED;
  const code = asRecord(err)?.code;
  if (code === 'ENOENT') return PROVIDER_ERROR_CODES.CONFIG_ERROR;
  if (isSessionNotFoundError(err)) return PROVIDER_ERROR_CODES.SESSION_NOT_FOUND;
  if (isAbortLikeError(err)) return PROVIDER_ERROR_CODES.CANCELLED;
  return PROVIDER_ERROR_CODES.PROVIDER_ERROR;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => extractTextFromContent(part)).filter(Boolean).join('');
  }
  const rec = asRecord(content);
  if (!rec) return '';
  if (typeof rec.text === 'string') return rec.text;
  if (rec.content !== undefined) return extractTextFromContent(rec.content);
  return '';
}

function extractToolOutputText(content: ToolCallContent[] | null | undefined, rawOutput: unknown): string | undefined {
  const chunks: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec.type === 'content') {
        const text = extractTextFromContent(rec.content);
        if (text) chunks.push(text);
      } else if (rec.type === 'diff') {
        const filePath = isNonEmptyString(rec.path) ? rec.path : 'diff';
        chunks.push(`[diff: ${filePath}]`);
      } else if (rec.type === 'terminal' && isNonEmptyString(rec.terminalId)) {
        chunks.push(`[terminal: ${rec.terminalId}]`);
      }
    }
  }
  if (chunks.length > 0) return chunks.join('\n');
  if (typeof rawOutput === 'string') return rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return String(rawOutput);
    }
  }
  return undefined;
}

function extractModelCatalog(resp: unknown): ExtractedModelCatalog {
  const rec = asRecord(resp);
  if (!rec) return { models: [], hasConfigOption: false };

  // Kimi Code CLI v2 exposes models through ACP `configOptions` (category/id === 'model').
  if (Array.isArray(rec.configOptions)) {
    for (const rawOpt of rec.configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      if (opt.category !== 'model' && opt.id !== 'model') continue;
      const models: ProviderModelInfo[] = [];
      const seen = new Set<string>();
      const pushOption = (entry: unknown) => {
        const item = asRecord(entry);
        if (!item) return;
        if (Array.isArray(item.options)) {
          for (const nested of item.options) pushOption(nested);
          return;
        }
        const value = isNonEmptyString(item.value) ? item.value.trim() : isNonEmptyString(item.id) ? item.id.trim() : '';
        if (!value || seen.has(value)) return;
        seen.add(value);
        models.push({
          id: value,
          name: isNonEmptyString(item.name) ? item.name.trim() : value,
        });
      };
      if (Array.isArray(opt.options)) {
        for (const entry of opt.options) pushOption(entry);
      }
      const currentValue = isNonEmptyString(opt.currentValue) ? opt.currentValue.trim() : undefined;
      if (models.length > 0 || currentValue) {
        if (currentValue && !seen.has(currentValue)) {
          models.unshift({ id: currentValue, name: currentValue });
        }
        return {
          models,
          defaultModel: currentValue ?? models[0]?.id,
          hasConfigOption: true,
        };
      }
    }
  }

  // Legacy Kimi CLI 1.x returns `result.models = { availableModels, currentModelId }`.
  const legacyModels = asRecord(rec.models);
  if (legacyModels && Array.isArray(legacyModels.availableModels)) {
    const models: ProviderModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of legacyModels.availableModels) {
      const m = asRecord(item);
      if (!m) continue;
      const id = isNonEmptyString(m.modelId) ? m.modelId.trim() : isNonEmptyString(m.id) ? m.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name: isNonEmptyString(m.name) ? m.name.trim() : id,
      });
    }
    const currentModelId = isNonEmptyString(legacyModels.currentModelId) ? legacyModels.currentModelId.trim() : undefined;
    if (currentModelId && !seen.has(currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    return {
      models,
      defaultModel: currentModelId ?? models[0]?.id,
      hasConfigOption: false,
    };
  }

  return { models: [], hasConfigOption: false };
}

function inferImageMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

function computeExecutableFingerprint(bin: ResolvedExecutable): string {
  const target = bin.prependArgs[0] ?? bin.executable;
  try {
    const stat = statSync(target);
    return `${bin.executable}:${target}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${bin.executable}:${target}`;
  }
}

export class KimiV2Provider implements TransportProvider {
  readonly id = 'kimi-sdk';
  readonly connectionMode: ConnectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership: SessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: false,
    compact: {
      execution: 'slash-command',
      providerCommand: '/compact',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: false,
    },
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS,
  };

  private readonly initTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly modelProbeTtlMs: number;

  private providerConfig: ProviderConfig | null = null;
  private child: ChildProcess | null = null;
  private connection: AcpClientConnection | null = null;
  private connectingPromise: Promise<void> | null = null;
  private connectedFingerprint: string | null = null;
  private connectedEnvKey: string | null = null;
  private stderrTail: string[] = [];

  private agentInfo: { name?: string; version?: string } | null = null;
  private promptImageSupported = false;
  private promptEmbeddedContextSupported = false;
  private sessionResumeSupported = false;
  private sessionListSupported = false;
  private sessionCloseSupported = false;
  private loadSessionSupported = false;
  private useConfigOptionForModel = false;

  private readonly routes = new Map<string, AcpRoute>();
  private readonly sessionKeyToProviderId = new Map<string, string>();

  private cachedModels: ProviderModelList | null = null;
  private cachedModelsAt = 0;
  private lastErrorCode: string | null = null;

  private wireOrderTail: Promise<void> = Promise.resolve();

  private readonly deltaHandlers = new Set<(sessionId: string, delta: MessageDelta) => void>();
  private readonly completeHandlers = new Set<(sessionId: string, message: AgentMessage) => void>();
  private readonly errorHandlers = new Set<(sessionId: string, error: ProviderError) => void>();
  private readonly sessionInfoHandlers = new Set<(sessionId: string, info: SessionInfoUpdate) => void>();
  private readonly usageHandlers = new Set<(sessionId: string, update: ProviderUsageUpdate) => void>();
  private readonly toolCallHandlers = new Set<(sessionId: string, tool: ToolCallEvent) => void>();
  private readonly approvalHandlers = new Set<(sessionId: string, req: ApprovalRequest) => void>();

  constructor(options: KimiV2ProviderOptions = {}) {
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.modelProbeTtlMs = options.modelProbeTtlMs ?? MODEL_PROBE_TTL_MS;
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaHandlers.add(cb);
    return () => { this.deltaHandlers.delete(cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeHandlers.add(cb);
    return () => { this.completeHandlers.delete(cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorHandlers.add(cb);
    return () => { this.errorHandlers.delete(cb); };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoHandlers.add(cb);
    return () => { this.sessionInfoHandlers.delete(cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageHandlers.add(cb);
    return () => { this.usageHandlers.delete(cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallHandlers.add(cb);
  }

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalHandlers.add(cb);
  }

  async connect(config: ProviderConfig): Promise<void> {
    this.providerConfig = config;
  }

  async disconnect(): Promise<void> {
    const routes = Array.from(this.routes.values());
    for (const route of routes) {
      this.rejectPendingApprovals(route.state, new Error('Provider disconnected'));
      if (route.state.pendingTurn) {
        this.failTurn(route.state, new Error('Provider disconnected'), PROVIDER_ERROR_CODES.CONNECTION_LOST, true);
      }
    }
    this.routes.clear();
    this.sessionKeyToProviderId.clear();
    await this.teardownChildProcess();
  }

  private resolveBinaryCommand(env: NodeJS.ProcessEnv): ResolvedExecutable {
    const raw = resolveKimiPathForSdk('kimi', env);
    return resolveExecutableForSpawn(raw);
  }

  private buildSpawnEnv(sessionConfig?: SessionConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.providerConfig?.apiKey && typeof this.providerConfig.apiKey === 'string') {
      env.KIMI_API_KEY = this.providerConfig.apiKey;
    }
    if (sessionConfig?.authContext?.env) {
      for (const [k, v] of Object.entries(sessionConfig.authContext.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    if (sessionConfig?.env) {
      for (const [k, v] of Object.entries(sessionConfig.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return env;
  }

  private isChildAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed);
  }

  private async teardownChildProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.connectedFingerprint = null;
    this.connectedEnvKey = null;
    if (child) {
      await killProcessTree(child, { ownsProcessGroup: true });
    }
  }

  private async ensureConnected(sessionConfig?: SessionConfig): Promise<AcpClientConnection> {
    const env = this.buildSpawnEnv(sessionConfig);
    const bin = this.resolveBinaryCommand(env);
    const fingerprint = computeExecutableFingerprint(bin);
    const envKey = `${env.KIMI_API_KEY ?? ''}\0${env.KIMI_CODE_HOME ?? ''}\0${env.KIMI_CLI_PATH ?? ''}`;

    if (
      this.connection
      && this.isChildAlive()
      && (!this.connectedFingerprint || this.connectedFingerprint === fingerprint)
      && (this.routes.size > 0 || this.connectedEnvKey === envKey)
    ) {
      return this.connection;
    }

    if (this.connectingPromise) {
      await this.connectingPromise;
      if (this.connection && this.isChildAlive()) return this.connection;
    }

    // Recycle stale idle child when the binary upgraded on disk.
    const hasActiveTurns = Array.from(this.routes.values()).some((r) => r.state.pendingTurn !== null);
    if (this.child && !hasActiveTurns) {
      await this.teardownChildProcess();
    }

    const connectTask = (async () => {
      const cwd = normalizeTransportCwd(canonicalizeTransportCwd(sessionConfig?.cwd)) || process.cwd();
      this.stderrTail = [];

      const child = spawn(bin.executable, [...bin.prependArgs, 'acp'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.child = child;
      this.connectedFingerprint = fingerprint;
      this.connectedEnvKey = envKey;

      const spawnErrorPromise = new Promise<never>((_, reject) => {
        child.once('error', (err) => reject(err));
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.shift();
        }
      });

      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this.connection = null;
        this.connectedFingerprint = null;
        this.connectedEnvKey = null;
        const exitMsg = `kimi acp exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        for (const route of this.routes.values()) {
          this.rejectPendingApprovals(route.state, new Error(exitMsg));
          if (route.state.pendingTurn) {
            this.failTurn(route.state, new Error(exitMsg), PROVIDER_ERROR_CODES.CONNECTION_LOST, true);
          }
        }
      });

      if (!child.stdout || !child.stdin) {
        await this.teardownChildProcess();
        throw new Error('Failed to open stdio pipes for kimi acp');
      }

      const filteredStdout = filterAcpJsonLines(child.stdout, (line, count) => {
        if (count <= 5 || count % 50 === 0) {
          logger.debug({ provider: this.id, count, line: line.slice(0, 200) }, 'kimi-v2 dropped non-JSON ACP line');
        }
      });
      const gatedStdout = gateChildStream(filteredStdout);

      const readable = Readable.toWeb(gatedStdout) as ReadableStream<Uint8Array>;
      const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(writable, readable);

      const connection = createAcpClientConnection(
        {
          sessionUpdate: async (notification: SessionNotification) => {
            await this.enqueueWireOrder(() => this.handleSessionUpdate(notification));
          },
          requestPermission: async (params: RequestPermissionRequest) => this.handleRequestPermission(params),
          readTextFile: async (params: ReadTextFileRequest) => this.handleReadTextFile(params),
          writeTextFile: async (params: WriteTextFileRequest) => this.handleWriteTextFile(params),
        },
        stream,
      );
      this.connection = connection;

      const initRace = Promise.race([
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
          },
          clientInfo: { name: 'imcodes', version: '1.0.0' },
        }),
        spawnErrorPromise,
      ]);

      const initOutcome = await withTimeoutOutcome(initRace, this.initTimeoutMs);
      if (initOutcome.timedOut) {
        await this.teardownChildProcess();
        throw new Error(`kimi acp initialize timed out after ${this.initTimeoutMs}ms`);
      }

      this.applyInitializeResult(initOutcome.value);
    })();

    this.connectingPromise = connectTask;
    try {
      await connectTask;
    } catch (err) {
      await this.teardownChildProcess();
      throw this.normalizeProviderException(err);
    } finally {
      if (this.connectingPromise === connectTask) {
        this.connectingPromise = null;
      }
    }

    if (!this.connection) {
      throw new Error('kimi acp connection unavailable after initialize');
    }
    return this.connection;
  }

  private applyInitializeResult(result: InitializeResponse): void {
    const rec = asRecord(result);
    const agentInfo = asRecord(rec?.agentInfo);
    this.agentInfo = agentInfo
      ? {
          name: isNonEmptyString(agentInfo.name) ? agentInfo.name : undefined,
          version: isNonEmptyString(agentInfo.version) ? agentInfo.version : undefined,
        }
      : null;

    const caps = asRecord(rec?.agentCapabilities);
    const promptCaps = asRecord(caps?.promptCapabilities);
    const sessionCaps = asRecord(caps?.sessionCapabilities);

    this.promptImageSupported = promptCaps?.image === true;
    this.promptEmbeddedContextSupported = promptCaps?.embeddedContext === true;
    this.loadSessionSupported = caps?.loadSession === true;
    this.sessionResumeSupported = sessionCaps?.resume != null && sessionCaps.resume !== false;
    this.sessionListSupported = sessionCaps?.list != null && sessionCaps.list !== false;
    this.sessionCloseSupported = sessionCaps?.close != null && sessionCaps.close !== false;
  }

  private normalizeProviderException(err: unknown): Error & { code?: string } {
    const code = inferErrorCode(err);
    this.lastErrorCode = code;
    if (code === PROVIDER_ERROR_CODES.CONFIG_ERROR) {
      const wrapped = new Error(
        `Kimi CLI binary not found or failed to launch (${err instanceof Error ? err.message : String(err)}). Install @moonshot-ai/kimi-code or set KIMI_CLI_PATH.`,
      ) as Error & { code?: string };
      wrapped.code = code;
      return wrapped;
    }
    if (code === PROVIDER_ERROR_CODES.AUTH_FAILED) {
      const wrapped = new Error(
        'Kimi CLI authentication required. Run `kimi` and complete `/login` (or `kimi acp --login`), or set KIMI_API_KEY.',
      ) as Error & { code?: string };
      wrapped.code = code;
      return wrapped;
    }
    if (err instanceof Error) {
      const enriched = err as Error & { code?: string };
      if (!enriched.code) enriched.code = code;
      return enriched;
    }
    const wrapped = new Error(String(err)) as Error & { code?: string };
    wrapped.code = code;
    return wrapped;
  }

  private enqueueWireOrder(fn: () => Promise<void> | void): Promise<void> {
    const next = this.wireOrderTail.then(() => fn()).catch((err) => {
      logger.warn({ provider: this.id, err: err instanceof Error ? err.message : String(err) }, 'kimi-v2 wire handler error');
    });
    this.wireOrderTail = next;
    return next;
  }

  private reserveWireSlot(): Promise<void> {
    return this.wireOrderTail;
  }

  private resolveRoute(sessionKeyOrProviderId: string): AcpRoute | undefined {
    const providerId = this.sessionKeyToProviderId.get(sessionKeyOrProviderId) ?? sessionKeyOrProviderId;
    return this.routes.get(providerId);
  }

  private registerRoute(providerSessionId: string, state: KimiSessionState): void {
    const existing = this.routes.get(providerSessionId);
    const stack = existing ? existing.stack.filter((k) => k !== state.sessionKey) : [];
    stack.push(state.sessionKey);
    this.routes.set(providerSessionId, { providerSessionId, state, stack });
    this.sessionKeyToProviderId.set(state.sessionKey, providerSessionId);
  }

  private releaseRoute(sessionKey: string): { route: AcpRoute; becameEmpty: boolean } | null {
    const providerSessionId = this.sessionKeyToProviderId.get(sessionKey);
    if (!providerSessionId) return null;
    this.sessionKeyToProviderId.delete(sessionKey);

    const route = this.routes.get(providerSessionId);
    if (!route) return null;

    route.stack = route.stack.filter((k) => k !== sessionKey);
    if (route.stack.length === 0) {
      this.routes.delete(providerSessionId);
      return { route, becameEmpty: true };
    }

    const nextKey = route.stack[route.stack.length - 1]!;
    route.state.sessionKey = nextKey;
    return { route, becameEmpty: false };
  }

  private cacheModelsFromResponse(resp: unknown): ExtractedModelCatalog {
    const catalog = extractModelCatalog(resp);
    if (catalog.hasConfigOption) {
      this.useConfigOptionForModel = true;
    }
    if (catalog.models.length > 0 || catalog.defaultModel) {
      this.cachedModels = {
        models: catalog.models,
        defaultModel: catalog.defaultModel,
        isAuthenticated: true,
        modelCatalogSource: 'live',
      };
      this.cachedModelsAt = Date.now();
    }
    return catalog;
  }

  private async switchProviderModel(
    connection: AcpClientConnection,
    providerSessionId: string,
    modelId: string,
  ): Promise<void> {
    if (this.useConfigOptionForModel) {
      await connection.setSessionConfigOption?.({
        sessionId: providerSessionId,
        configId: 'model',
        value: modelId,
      });
      return;
    }
    if (typeof connection.unstable_setSessionModel === 'function') {
      try {
        await connection.unstable_setSessionModel({
          sessionId: providerSessionId,
          modelId,
        });
        return;
      } catch (err) {
        if (!isMethodNotFoundError(err)) throw err;
        this.useConfigOptionForModel = true;
      }
    }
    await connection.setSessionConfigOption?.({
      sessionId: providerSessionId,
      configId: 'model',
      value: modelId,
    });
  }

  async createSession(config: SessionConfig): Promise<string> {
    await config.beforeNativeSessionStart?.();

    const connection = await this.ensureConnected(config);
    const cwd = normalizeTransportCwd(canonicalizeTransportCwd(config.cwd)) || process.cwd();
    const mcpServers = getDefaultAcpMcpServers(config);
    const systemParts = getProviderSystemTextParts({
      userMessage: '',
      assembledMessage: '',
      sessionSystemText: config.identityPrompt ?? config.systemPrompt,
      systemText: config.systemPrompt ?? config.description,
      context: {
        sessionSystemText: config.identityPrompt ?? config.systemPrompt,
        systemText: config.systemPrompt ?? config.description,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: config.contextNamespace ?? { scope: 'personal', projectId: 'default' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });

    const requestedResumeId = !config.fresh
      ? (isNonEmptyString(config.bindExistingKey) ? config.bindExistingKey : isNonEmptyString(config.resumeId) ? config.resumeId : undefined)
      : undefined;

    const requestedModel = isNonEmptyString(config.model)
      ? config.model.trim()
      : isNonEmptyString(config.agentId)
        ? config.agentId.trim()
        : undefined;

    if (config.skipCreate && requestedResumeId) {
      const existing = this.routes.get(requestedResumeId);
      if (existing) {
        existing.state.sessionKey = config.sessionKey;
        this.registerRoute(requestedResumeId, existing.state);
        return config.sessionKey;
      }
    }

    const state: KimiSessionState = {
      sessionKey: config.sessionKey,
      providerSessionId: requestedResumeId ?? '',
      cwd,
      model: requestedModel,
      mode: 'default',
      systemText: systemParts.sessionSystemText,
      systemTextInjected: Boolean(config.startupMemoryAlreadyInjected),
      lastInjectedSessionSystemKey: config.startupMemoryAlreadyInjected
        ? sessionSystemContractKey(systemParts.sessionSystemText)
        : undefined,
      replaying: false,
      pendingTurn: null,
      activeTools: new Map(),
      pendingApprovals: new Map(),
      mcpServers,
      env: config.env,
    };

    let response: NewSessionResponse | LoadSessionResponse | null = null;
    let resolvedProviderId = requestedResumeId ?? '';

    if (requestedResumeId && ((this.sessionResumeSupported && typeof connection.resumeSession === 'function') || (this.loadSessionSupported && typeof connection.loadSession === 'function'))) {
      this.registerRoute(requestedResumeId, state);
      const tryResume = this.sessionResumeSupported && typeof connection.resumeSession === 'function';
      try {
        if (tryResume) {
          const outcome = await withTimeoutOutcome(
            connection.resumeSession!({ sessionId: requestedResumeId, cwd, mcpServers }),
            this.sessionTimeoutMs,
          );
          if (outcome.timedOut) throw new Error(`kimi acp resumeSession timed out after ${this.sessionTimeoutMs}ms`);
          response = outcome.value;
        } else {
          state.replaying = true;
          const outcome = await withTimeoutOutcome(
            connection.loadSession!({ sessionId: requestedResumeId, cwd, mcpServers }),
            this.sessionTimeoutMs,
          );
          if (outcome.timedOut) throw new Error(`kimi acp loadSession timed out after ${this.sessionTimeoutMs}ms`);
          response = (outcome.value as LoadSessionResponse | undefined) ?? null;
        }
      } catch (err) {
        this.releaseRoute(config.sessionKey);
        if (!isSessionNotFoundError(err)) {
          throw this.normalizeProviderException(err);
        }
        resolvedProviderId = '';
      } finally {
        state.replaying = false;
      }
    }

    if (!resolvedProviderId) {
      try {
        const outcome = await withTimeoutOutcome(
          connection.newSession({ cwd, mcpServers }),
          this.sessionTimeoutMs,
        );
        if (outcome.timedOut) {
          throw new Error(`kimi acp newSession timed out after ${this.sessionTimeoutMs}ms`);
        }
        const created = outcome.value;
        resolvedProviderId = created.sessionId;
        response = created;
        state.providerSessionId = resolvedProviderId;
        this.registerRoute(resolvedProviderId, state);
      } catch (err) {
        throw this.normalizeProviderException(err);
      }
    }

    const catalog = this.cacheModelsFromResponse(response);
    if (!state.model && catalog.defaultModel) {
      state.model = catalog.defaultModel;
    }

    const modes = asRecord(asRecord(response)?.modes);
    if (isNonEmptyString(modes?.currentModeId)) {
      state.mode = modes.currentModeId;
    }

    if (requestedModel && (!catalog.defaultModel || requestedModel !== catalog.defaultModel)) {
      try {
        await this.switchProviderModel(connection, resolvedProviderId, requestedModel);
        state.model = requestedModel;
      } catch (err) {
        throw this.normalizeProviderException(err);
      }
    }

    this.emitSessionInfo(config.sessionKey, {
      resumeId: resolvedProviderId,
      model: state.model,
    });

    return config.sessionKey;
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const route = this.resolveRoute(sessionId);
    if (!route) return false;
    try {
      const connection = await this.ensureConnected({
        sessionKey: route.state.sessionKey,
        cwd: route.state.cwd,
        env: route.state.env,
      });
      if (this.sessionResumeSupported && typeof connection.resumeSession === 'function') {
        const resp = await connection.resumeSession({
          sessionId: route.providerSessionId,
          cwd: route.state.cwd,
          mcpServers: route.state.mcpServers,
        });
        this.cacheModelsFromResponse(resp);
        return true;
      }
      if (this.loadSessionSupported && typeof connection.loadSession === 'function') {
        route.state.replaying = true;
        try {
          const resp = await connection.loadSession({
            sessionId: route.providerSessionId,
            cwd: route.state.cwd,
            mcpServers: route.state.mcpServers,
          });
          this.cacheModelsFromResponse(resp);
          return true;
        } finally {
          route.state.replaying = false;
        }
      }
      return this.isChildAlive();
    } catch (err) {
      if (isSessionNotFoundError(err)) return false;
      throw this.normalizeProviderException(err);
    }
  }

  async listSessions(options?: RemoteSessionListOptions): Promise<RemoteSessionInfo[]> {
    const connection = await this.ensureConnected();
    if ((!this.sessionListSupported && typeof connection.listSessions !== 'function') || typeof connection.listSessions !== 'function') {
      return Array.from(this.routes.values()).map((r) => ({
        key: r.providerSessionId,
        directory: r.state.cwd,
        agentId: r.state.model,
      }));
    }
    const resp = await connection.listSessions({
      cwd: options?.directory ? normalizeTransportCwd(canonicalizeTransportCwd(options.directory)) : undefined,
    });
    return (resp.sessions ?? []).map((entry) => ({
      key: entry.sessionId,
      displayName: entry.title ?? undefined,
      directory: entry.cwd,
      updatedAt: entry.updatedAt ? Date.parse(entry.updatedAt) || undefined : undefined,
    }));
  }

  async detachSession(sessionId: string): Promise<void> {
    const released = this.releaseRoute(sessionId);
    if (!released) return;
    if (released.becameEmpty && released.route.state.pendingTurn) {
      this.rejectPendingApprovals(released.route.state, new Error('Session detached'));
      this.failTurn(released.route.state, new Error('Session detached'), PROVIDER_ERROR_CODES.CANCELLED, true);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const released = this.releaseRoute(sessionId);
    if (!released) return;
    const { route, becameEmpty } = released;
    if (!becameEmpty) return;

    this.rejectPendingApprovals(route.state, new Error('Session ended'));
    if (route.state.pendingTurn) {
      this.failTurn(route.state, new Error('Session ended'), PROVIDER_ERROR_CODES.CANCELLED, true);
    }
    if (this.sessionCloseSupported && this.connection?.closeSession && this.isChildAlive()) {
      try {
        await this.connection.closeSession({ sessionId: route.providerSessionId });
      } catch {
        /* best-effort remote close */
      }
    }
    if (this.routes.size === 0) {
      await this.teardownChildProcess();
    }
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const route = this.resolveRoute(sessionId);
    if (route) {
      route.state.model = agentId;
    }
  }

  async applySessionModel(sessionId: string, agentId: string): Promise<SessionModelApplied> {
    const route = this.resolveRoute(sessionId);
    if (!route) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    route.state.model = agentId;
    if (!this.connection || !this.isChildAlive()) {
      return SESSION_MODEL_APPLIED.NEXT_START;
    }
    await this.switchProviderModel(this.connection, route.providerSessionId, agentId);
    this.emitSessionInfo(route.state.sessionKey, { model: agentId });
    return route.state.pendingTurn ? SESSION_MODEL_APPLIED.NEXT_START : SESSION_MODEL_APPLIED.LIVE;
  }

  async listModels(force = false): Promise<ProviderModelList> {
    const now = Date.now();
    if (!force && this.cachedModels && now - this.cachedModelsAt < this.modelProbeTtlMs) {
      return this.cachedModels;
    }

    // Reuse any already-discovered models from live sessions before spawning an ephemeral probe.
    const anyRoute = this.routes.values().next().value as AcpRoute | undefined;
    if (!force && anyRoute && this.cachedModels?.models.length) {
      return this.cachedModels;
    }

    try {
      const connection = await this.ensureConnected();
      const probe = await withTimeoutOutcome(
        connection.newSession({ cwd: process.cwd(), mcpServers: [] }),
        this.sessionTimeoutMs,
      );
      if (probe.timedOut) {
        return { models: [], isAuthenticated: false, error: 'Model discovery timed out' };
      }
      const catalog = this.cacheModelsFromResponse(probe.value);
      if (this.sessionCloseSupported && probe.value.sessionId && connection.closeSession) {
        void connection.closeSession({ sessionId: probe.value.sessionId }).catch(() => {});
      }
      return {
        models: catalog.models,
        defaultModel: catalog.defaultModel,
        isAuthenticated: true,
        modelCatalogSource: 'live',
      };
    } catch (err) {
      if (this.routes.size === 0) {
        await this.teardownChildProcess();
      }
      const normalized = this.normalizeProviderException(err);
      return {
        models: [],
        isAuthenticated: false,
        error: normalized.message,
      };
    }
  }

  async send(
    sessionId: string,
    payload: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const route = this.resolveRoute(sessionId);
    if (!route) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const { state } = route;
    const normalized = normalizeProviderPayload(payload, attachments, extraSystemPrompt);

    const turnId = `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const terminalTarget = {};
    let resolveTurn!: () => void;
    let rejectTurn!: (err: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    let markSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      markSettled = resolve;
    });

    const turn: PendingTurn = {
      messageId: turnId,
      accumulated: '',
      assistantTextClosed: false,
      userInitiatedCancel: false,
      cancelRejectCode: null,
      cancelGraceTimer: null,
      terminalTarget,
      settled: false,
      resolve: resolveTurn,
      reject: rejectTurn,
      settledPromise,
      markSettled,
      wireSlot: this.reserveWireSlot(),
    };
    state.pendingTurn = turn;

    const connectionReady = this.connection && this.isChildAlive() ? this.connection : null;
    if (connectionReady) {
      const contentBlocks = this.prepareTurnPromptBlocks(state, normalized, attachments);
      void this.drivePrompt(connectionReady, state, turn, contentBlocks);
      return promise;
    }

    void (async () => {
      try {
        const connection = await this.ensureConnected({
          sessionKey: state.sessionKey,
          cwd: state.cwd,
          env: state.env,
        });
        if (turn.settled || turn.userInitiatedCancel) {
          this.failTurn(state, new Error('Turn cancelled'), PROVIDER_ERROR_CODES.CANCELLED, true);
          return;
        }
        const contentBlocks = this.prepareTurnPromptBlocks(state, normalized, attachments);
        await this.drivePrompt(connection, state, turn, contentBlocks);
      } catch (err) {
        const normalizedErr = this.normalizeProviderException(err);
        const code = (normalizedErr as { code?: string }).code ?? inferErrorCode(err);
        this.failTurn(state, normalizedErr, code, code === PROVIDER_ERROR_CODES.CANCELLED);
      }
    })();
    return promise;
  }

  private prepareTurnPromptBlocks(
    state: KimiSessionState,
    normalized: ProviderContextPayload,
    attachments?: TransportAttachment[],
  ): ContentBlock[] {
    const isCompact = isSessionControlCommandText(normalized.userMessage, 'compact');
    let promptText: string;
    if (isCompact) {
      state.lastInjectedSessionSystemKey = undefined;
      state.systemTextInjected = false;
      promptText = '/compact';
    } else {
      const systemParts = getProviderSystemTextParts(normalized);
      const injectSessionSystem = shouldInjectSessionSystemContract(
        state.lastInjectedSessionSystemKey,
        systemParts.sessionSystemText,
      ) || !state.systemTextInjected;
      promptText = composeMessageSideProviderPrompt(normalized, {
        includeSessionSystemText: injectSessionSystem,
        labelContextInstructions: true,
      });
      if (injectSessionSystem && systemParts.sessionSystemText) {
        state.lastInjectedSessionSystemKey = sessionSystemContractKey(systemParts.sessionSystemText);
        state.systemTextInjected = true;
      }
    }

    return this.buildPromptContentBlocks(
      promptText,
      normalized.attachments ?? attachments,
    );
  }

  private buildPromptContentBlocks(
    text: string,
    attachments?: TransportAttachment[],
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: 'text', text }];
    if (!attachments?.length) return blocks;

    for (const att of attachments) {
      if (!att.daemonPath) continue;
      const mime = att.mime ?? inferImageMime(att.daemonPath) ?? undefined;
      const isImage = att.type === 'image' || Boolean(mime && mime.startsWith('image/'));
      if (isImage && this.promptImageSupported) {
        try {
          const st = statSync(att.daemonPath);
          if (st.isFile() && st.size > 0 && st.size <= MAX_INLINE_IMAGE_BYTES) {
            const data = readFileSync(att.daemonPath).toString('base64');
            blocks.push({
              type: 'image',
              data,
              mimeType: mime ?? 'image/png',
            });
            continue;
          }
        } catch {
          /* fall through to resource_link */
        }
      }
      blocks.push({
        type: 'resource_link',
        name: att.originalName || path.basename(att.daemonPath),
        uri: pathToFileURL(att.daemonPath).href,
        ...(mime ? { mimeType: mime } : {}),
        ...(typeof att.size === 'number' ? { size: att.size } : {}),
      });
    }
    return blocks;
  }

  private async drivePrompt(
    connection: AcpClientConnection,
    state: KimiSessionState,
    turn: PendingTurn,
    prompt: ContentBlock[],
  ): Promise<void> {
    try {
      const response: PromptResponse = await connection.prompt({
        sessionId: state.providerSessionId,
        prompt,
      });
      await turn.wireSlot;
      if (turn.settled) return;
      const stopReason: StopReason | undefined = response?.stopReason;
      if (stopReason === 'cancelled') {
        const err = new Error('Turn cancelled');
        this.failTurn(state, err, PROVIDER_ERROR_CODES.CANCELLED, true);
        return;
      }
      this.settleTurn(state, turn);
    } catch (err) {
      await turn.wireSlot;
      if (turn.settled) return;
      const normalized = this.normalizeProviderException(err);
      const code = turn.userInitiatedCancel && turn.cancelRejectCode
        ? turn.cancelRejectCode
        : (normalized as { code?: string }).code ?? inferErrorCode(err);
      this.failTurn(state, normalized, code, code === PROVIDER_ERROR_CODES.CANCELLED);
    }
  }

  private settleTurn(state: KimiSessionState, turn: PendingTurn): void {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.cancelGraceTimer) {
      clearTimeout(turn.cancelGraceTimer);
      turn.cancelGraceTimer = null;
    }
    if (state.pendingTurn === turn) {
      state.pendingTurn = null;
    }
    this.clearActiveTools(state);
    this.emitComplete(state.sessionKey, {
      id: turn.messageId,
      sessionId: state.sessionKey,
      kind: 'text',
      role: 'assistant',
      content: turn.accumulated,
      timestamp: Date.now(),
      status: 'complete',
      ...(state.model ? { metadata: { model: state.model } } : {}),
    });
    turn.markSettled();
    turn.resolve();
  }

  private failTurn(state: KimiSessionState, err: Error, code: string, recoverable: boolean): void {
    const turn = state.pendingTurn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    if (turn.cancelGraceTimer) {
      clearTimeout(turn.cancelGraceTimer);
      turn.cancelGraceTimer = null;
    }
    if (state.pendingTurn === turn) {
      state.pendingTurn = null;
    }
    this.clearActiveTools(state);
    this.lastErrorCode = code;
    this.emitError(state.sessionKey, {
      code,
      message: err.message,
      recoverable,
    });
    turn.markSettled();
    turn.reject(err);
  }

  private clearActiveTools(state: KimiSessionState): void {
    if (state.activeTools.size === 0) return;
    for (const tool of state.activeTools.values()) {
      if (tool.status === 'running') {
        this.emitToolCall(state.sessionKey, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          input: tool.input,
        });
      }
    }
    state.activeTools.clear();
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const route = this.resolveRoute(sessionId);
    if (!route) return;
    const { state } = route;
    const turn = state.pendingTurn;
    if (turn) {
      turn.userInitiatedCancel = true;
      turn.cancelRejectCode = options?.reason === 'user_stop' ? PROVIDER_ERROR_CODES.CANCELLED : PROVIDER_ERROR_CODES.CANCELLED;
      if (!turn.cancelGraceTimer) {
        turn.cancelGraceTimer = setTimeout(() => {
          if (state.pendingTurn === turn && !turn.settled) {
            this.failTurn(state, new Error('kimi acp cancel grace timeout'), PROVIDER_ERROR_CODES.CANCELLED, true);
          }
        }, this.cancelGraceMs);
        turn.cancelGraceTimer.unref?.();
      }
    }
    if (this.connection && this.isChildAlive()) {
      try {
        await this.connection.cancel({ sessionId: route.providerSessionId });
      } catch {
        /* ignore cancel RPC failure if child already exited */
      }
    }
  }

  async cancelAndWait(sessionId: string): Promise<void> {
    const route = this.resolveRoute(sessionId);
    if (!route) return;
    const { state } = route;
    const turn = state.pendingTurn;
    if (!turn) return;
    const connection = this.connection;
    if (!connection || !this.isChildAlive()) {
      await turn.settledPromise;
      return;
    }
    await confirmPromiseStop(
      turn.terminalTarget,
      turn.settledPromise,
      async () => {
        await this.cancel(sessionId);
      },
      () => this.routes.get(route.providerSessionId)?.state === state
        && (state.pendingTurn === turn || state.pendingTurn === null),
    );
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const route = this.routes.get(notification.sessionId);
    if (!route) return;
    const { state } = route;
    if (state.replaying) return;

    const update: SessionUpdate = notification.update;
    const u = asRecord(update);
    if (!u || !isNonEmptyString(u.sessionUpdate)) return;

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractTextFromContent(u.content);
        if (!text) break;
        const turn = state.pendingTurn;
        if (turn) {
          if (turn.assistantTextClosed) {
            turn.messageId = `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            turn.accumulated = '';
            turn.assistantTextClosed = false;
          }
          turn.accumulated += text;
        }
        const messageId = turn?.messageId ?? `kimi-stream-${state.providerSessionId}`;
        this.emitDelta(state.sessionKey, {
          messageId,
          type: 'text',
          delta: text,
          role: 'assistant',
        });
        break;
      }

      case 'agent_thought_chunk': {
        // Thoughts are internal reasoning chunks in ACP; ignore rather than mixing into visible assistant text.
        break;
      }

      case 'tool_call': {
        const tc = update as ToolCall & { sessionUpdate: 'tool_call' };
        if (state.pendingTurn && state.pendingTurn.accumulated.length > 0) {
          state.pendingTurn.assistantTextClosed = true;
        }
        const status = mapToolCallStatus(tc.status);
        const toolName = tc.title || tc.kind || 'tool';
        if (status === 'running') {
          state.activeTools.set(tc.toolCallId, {
            id: tc.toolCallId,
            name: toolName,
            kind: tc.kind,
            input: tc.rawInput,
            status,
          });
        } else {
          state.activeTools.delete(tc.toolCallId);
        }
        this.emitToolCall(state.sessionKey, {
          id: tc.toolCallId,
          name: toolName,
          status,
          input: tc.rawInput,
          output: extractToolOutputText(tc.content, tc.rawOutput),
          detail: {
            kind: tc.kind,
            input: tc.rawInput,
            output: tc.rawOutput,
          },
        });
        break;
      }

      case 'tool_call_update': {
        const tu = update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' };
        const prev = state.activeTools.get(tu.toolCallId);
        const status = mapToolCallStatus(tu.status ?? (prev ? prev.status : 'in_progress'));
        const name = tu.title || prev?.name || tu.kind || 'tool';
        const input = tu.rawInput ?? prev?.input;
        if (status === 'running') {
          state.activeTools.set(tu.toolCallId, {
            id: tu.toolCallId,
            name,
            kind: tu.kind ?? prev?.kind,
            input,
            status,
          });
        } else {
          state.activeTools.delete(tu.toolCallId);
        }
        this.emitToolCall(state.sessionKey, {
          id: tu.toolCallId,
          name,
          status,
          input,
          output: extractToolOutputText(tu.content, tu.rawOutput),
          detail: {
            kind: tu.kind ?? prev?.kind,
            input,
            output: tu.rawOutput,
          },
        });
        break;
      }

      case 'plan': {
        if (!Array.isArray(u.entries)) break;
        const planInput = acpPlanEntriesToInput(u.entries as Parameters<typeof acpPlanEntriesToInput>[0]);
        this.emitToolCall(state.sessionKey, {
          id: `plan-${state.providerSessionId}`,
          name: 'plan',
          status: 'complete',
          input: planInput,
          detail: { kind: 'plan', input: planInput },
        });
        break;
      }

      case 'current_mode_update': {
        if (isNonEmptyString(u.currentModeId)) {
          state.mode = u.currentModeId;
        }
        break;
      }

      case 'config_option_update': {
        const catalog = this.cacheModelsFromResponse({ configOptions: u.configOptions });
        if (catalog.defaultModel && catalog.defaultModel !== state.model) {
          state.model = catalog.defaultModel;
          this.emitSessionInfo(state.sessionKey, { model: catalog.defaultModel });
        }
        break;
      }

      case 'usage_update': {
        const tokens = asRecord(u.tokens);
        const used = typeof u.used === 'number'
          ? u.used
          : typeof tokens?.input === 'number'
            ? tokens.input
            : undefined;
        const size = typeof u.size === 'number'
          ? u.size
          : typeof tokens?.limit === 'number'
            ? tokens.limit
            : undefined;
        const output = typeof tokens?.output === 'number' ? tokens.output : undefined;
        const cached = typeof tokens?.cached === 'number' ? tokens.cached : undefined;

        if (used !== undefined || size !== undefined || output !== undefined || cached !== undefined) {
          this.emitUsage(state.sessionKey, {
            messageId: state.pendingTurn?.messageId,
            model: state.model,
            usage: {
              ...(used !== undefined ? { input_tokens: used } : {}),
              ...(output !== undefined ? { output_tokens: output } : {}),
              ...(cached !== undefined ? { cached_input_tokens: cached, cache_read_input_tokens: cached } : {}),
              ...(size !== undefined ? { model_context_window: size } : {}),
            },
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private async handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const route = this.routes.get(params.sessionId);
    if (!route) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const { state } = route;
    const options = params.options ?? [];

    if (this.approvalHandlers.size === 0) {
      const allowOpt = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }

    const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toolName = params.toolCall.title || params.toolCall.kind || 'tool';
    const preview = params.toolCall.rawInput !== undefined ? JSON.stringify(params.toolCall.rawInput).slice(0, 300) : undefined;

    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      state.pendingApprovals.set(reqId, { requestId: reqId, resolve, reject, options });
      const approval: ApprovalRequest = {
        id: reqId,
        description: toolName,
        tool: toolName,
        provider: this.id,
        providerToolUseId: params.toolCall.toolCallId,
        inputPreview: preview,
      };
      for (const cb of this.approvalHandlers) {
        cb(state.sessionKey, approval);
      }
    });
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const route = this.resolveRoute(sessionId);
    if (!route) return;
    const pending = route.state.pendingApprovals.get(requestId);
    if (!pending) return;
    route.state.pendingApprovals.delete(requestId);

    const chosen = approved
      ? pending.options.find((o) => o.kind === 'allow_once') ?? pending.options.find((o) => o.kind === 'allow_always') ?? pending.options[0]
      : pending.options.find((o) => o.kind === 'reject_once') ?? pending.options.find((o) => o.kind === 'reject_always');

    if (chosen) {
      pending.resolve({ outcome: { outcome: 'selected', optionId: chosen.optionId } });
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private rejectPendingApprovals(state: KimiSessionState, err: Error): void {
    for (const pending of state.pendingApprovals.values()) {
      pending.reject(err);
    }
    state.pendingApprovals.clear();
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const raw = await readFile(params.path, 'utf8');
    if (params.line == null && params.limit == null) {
      return { content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, (params.line ?? 1) - 1);
    const endIdx = params.limit != null ? startIdx + Math.max(0, params.limit) : lines.length;
    return { content: lines.slice(startIdx, endIdx).join('\n') };
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await writeFile(params.path, params.content, 'utf8');
    return {};
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const route = this.resolveRoute(sessionId);
    if (!route) return null;
    const { state } = route;
    const activeToolCount = state.activeTools.size;
    const activeWorkCount = (state.pendingTurn ? 1 : 0) + activeToolCount + state.pendingApprovals.size;
    const busyReasons: SessionActivityBusyReason[] = [];
    if (state.pendingTurn) busyReasons.push('runtime_dispatch');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    if (state.pendingApprovals.size > 0) busyReasons.push('provider_wait');
    return {
      status: 'current',
      activeWorkCount,
      activeToolCount,
      busyReasons,
    };
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (!this.connection || !this.isChildAlive()) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.UNKNOWN,
        connected: false,
        degradedReasons: [MEMORY_MCP_PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED],
      };
    }
    return {
      providerId: this.id,
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const route = this.resolveRoute(sessionId);
    if (!route) return null;
    const { state } = route;
    return {
      provider: this.id,
      implementation: 'kimi-v2',
      connected: Boolean(this.connection && this.isChildAlive()),
      pid: this.child?.pid ?? null,
      providerSessionId: state.providerSessionId,
      agentInfo: this.agentInfo,
      capabilities: {
        resume: this.sessionResumeSupported,
        list: this.sessionListSupported,
        close: this.sessionCloseSupported,
        loadSession: this.loadSessionSupported,
        image: this.promptImageSupported,
        embeddedContext: this.promptEmbeddedContextSupported,
      },
      model: state.model ?? null,
      mode: state.mode ?? null,
      inFlightTurn: Boolean(state.pendingTurn),
      activeToolCount: state.activeTools.size,
      pendingApprovalCount: state.pendingApprovals.size,
      mcpServerCount: state.mcpServers.length,
      lastErrorCode: this.lastErrorCode,
      stderrLineCount: this.stderrTail.length,
    };
  }

  private emitDelta(sessionId: string, delta: MessageDelta): void {
    for (const cb of this.deltaHandlers) cb(sessionId, delta);
  }

  private emitComplete(sessionId: string, message: AgentMessage): void {
    for (const cb of this.completeHandlers) cb(sessionId, message);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorHandlers) cb(sessionId, error);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoHandlers) cb(sessionId, info);
  }

  private emitUsage(sessionId: string, update: ProviderUsageUpdate): void {
    for (const cb of this.usageHandlers) cb(sessionId, update);
  }

  private emitToolCall(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallHandlers) cb(sessionId, tool);
  }
}

function mapToolCallStatus(status: string | null | undefined): 'running' | 'complete' | 'error' {
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'error') return 'error';
  return 'running';
}
