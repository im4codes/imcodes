import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { agentResourceOwner, bindAgentProcessResource, type AgentProcessResource } from './agent-process-resource.js';
import type { SessionResourceOwner } from '../../daemon/session-resource-registry.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderActiveWorkSnapshot } from '../../../shared/session-activity-types.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type {
  TransportProvider, ProviderCapabilities, ProviderConfig, ProviderError, SessionConfig,
  SessionInfoUpdate, ProviderStatusUpdate, ProviderUsageUpdate, ProviderModelList,
} from '../transport-provider.js';
import { CONNECTION_MODES, SESSION_OWNERSHIP, PROVIDER_ERROR_CODES, normalizeProviderPayload, BACKGROUND_SUBAGENT_WAKE_MODES } from '../transport-provider.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { buildClaudeAgentEnv } from '../env-isolation.js';
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '../../../shared/agent-types.js';
import { CLAUDE_CODE_MODEL_IDS } from '../../shared/models/options.js';

export const CLAUDE_CODE_CLI_SDK_ID = CLAUDE_CODE_CLI_SDK_AGENT_TYPE;
export const CLAUDE_CODE_CLI_SDK_ARGS = [
  '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--permission-mode', 'bypassPermissions',
] as const;

export type ClaudeCliStreamEvent = Record<string, unknown>;

/** Parse one Claude CLI stream-json event. Non-JSON lines are diagnostics, not assistant text. */
export function parseClaudeCliStreamJsonLine(line: string): ClaudeCliStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeCliStreamEvent : null;
  } catch {
    return null;
  }
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const row = item as Record<string, unknown>;
    return typeof row.text === 'string' ? row.text : '';
  }).join('');
}

function eventText(event: ClaudeCliStreamEvent): string {
  const delta = event.delta;
  if (delta && typeof delta === 'object') {
    const text = (delta as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  const nested = event.event;
  if (nested && typeof nested === 'object') {
    const row = nested as Record<string, unknown>;
    const inner = row.delta;
    if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).text === 'string') return (inner as Record<string, unknown>).text as string;
  }
  return textFromContent(event.content) || textFromContent(event.message);
}

function sessionIdFromEvent(event: ClaudeCliStreamEvent): string | undefined {
  for (const key of ['session_id', 'sessionId', 'conversation_id']) {
    if (typeof event[key] === 'string' && (event[key] as string).trim()) return event[key] as string;
  }
  return undefined;
}

interface CliState {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  description?: string;
  systemPrompt?: string;
  resumeId: string;
  started: boolean;
  child: ChildProcessWithoutNullStreams | null;
  resourceOwner?: SessionResourceOwner | null;
  agentResource?: AgentProcessResource;
  busy: boolean;
  cancelled: boolean;
  text: string;
  messageId: string;
  stderr: string;
  sessionSystemTextInjected?: string;
  runtimeActivityGeneration?: unknown;
}

export class ClaudeCodeCliSdkProvider implements TransportProvider {
  readonly id = CLAUDE_CODE_CLI_SDK_ID;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.LOCAL;
  readonly capabilities: ProviderCapabilities = {
    streaming: true, toolCalling: false, approval: false, sessionRestore: true,
    multiTurn: true, attachments: false, turnCwd: true,
    contextSupport: 'full-normalized-context-injection',
    backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.UNSUPPORTED,
    activeDelegationNotification: 'unsupported',
    nativeAgentAdmission: 'unenforceable',
    compact: { execution: 'unsupported', verified: false, completion: 'none', cancellation: 'local-cancel', reason: 'Claude CLI stream-json does not expose a verified compact RPC.' },
  };
  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CliState>();
  private deltaCallbacks: Array<(id: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(id: string, msg: AgentMessage) => void> = [];
  private errorCallbacks: Array<(id: string, error: ProviderError) => void> = [];
  private infoCallbacks: Array<(id: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(id: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks: Array<(id: string, usage: ProviderUsageUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> { this.config = config; }
  async listModels(): Promise<ProviderModelList> {
    return { models: CLAUDE_CODE_MODEL_IDS.map((id) => ({ id })), defaultModel: CLAUDE_CODE_MODEL_IDS[0] };
  }
  async disconnect(): Promise<void> { for (const id of this.sessions.keys()) await this.endSession(id); this.config = null; }
  async createSession(config: SessionConfig): Promise<string> {
    const id = config.bindExistingKey ?? config.sessionKey;
    const old = this.sessions.get(id);
    const resumeId = config.resumeId ?? old?.resumeId ?? randomUUID();
    this.sessions.set(id, { id, cwd: normalizeTransportCwd(config.cwd) ?? old?.cwd ?? process.cwd(), env: config.env ?? old?.env, model: typeof config.agentId === 'string' ? config.agentId : old?.model, description: config.description ?? old?.description, systemPrompt: config.systemPrompt ?? old?.systemPrompt, resumeId, started: Boolean(config.resumeId || config.skipCreate || old?.started), child: old?.child ?? null, resourceOwner: agentResourceOwner(config) ?? old?.resourceOwner ?? null, busy: false, cancelled: false, text: '', messageId: randomUUID(), stderr: '' });
    this.emitInfo(id, { resumeId });
    return id;
  }
  async endSession(id: string): Promise<void> { const s = this.sessions.get(id); if (s?.child) await killProcessTree(s.child, { ownsProcessGroup: true }); this.sessions.delete(id); }
  onDelta(cb: (id: string, delta: MessageDelta) => void): () => void { this.deltaCallbacks.push(cb); return () => { this.deltaCallbacks = this.deltaCallbacks.filter((x) => x !== cb); }; }
  onComplete(cb: (id: string, msg: AgentMessage) => void): () => void { this.completeCallbacks.push(cb); return () => { this.completeCallbacks = this.completeCallbacks.filter((x) => x !== cb); }; }
  onError(cb: (id: string, error: ProviderError) => void): () => void { this.errorCallbacks.push(cb); return () => { this.errorCallbacks = this.errorCallbacks.filter((x) => x !== cb); }; }
  onSessionInfo(cb: (id: string, info: SessionInfoUpdate) => void): () => void { this.infoCallbacks.push(cb); return () => { this.infoCallbacks = this.infoCallbacks.filter((x) => x !== cb); }; }
  onStatus(cb: (id: string, status: ProviderStatusUpdate) => void): () => void { this.statusCallbacks.push(cb); return () => { this.statusCallbacks = this.statusCallbacks.filter((x) => x !== cb); }; }
  onUsage(cb: (id: string, usage: ProviderUsageUpdate) => void): () => void { this.usageCallbacks.push(cb); return () => { this.usageCallbacks = this.usageCallbacks.filter((x) => x !== cb); }; }
  setSessionAgentId(id: string, agentId: string): void {
    const state = this.sessions.get(id);
    if (state && agentId.trim()) state.model = agentId.trim();
  }
  getActiveWorkSnapshot(id: string): ProviderActiveWorkSnapshot | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      status: 'current',
      activeWorkCount: s.busy ? 1 : 0,
      activeToolCount: 0,
      busyReasons: s.busy ? ['provider_wait'] : [],
      providerDiagnosticGeneration: s.messageId,
      updatedAt: Date.now(),
    };
  }
  async cancel(id: string): Promise<void> { const s = this.sessions.get(id); if (!s?.child) return; s.cancelled = true; await killProcessTree(s.child, { ownsProcessGroup: true }); s.child = null; s.busy = false; s.started = false; }
  async send(id: string, payload: string | ProviderContextPayload): Promise<void> {
    const s = this.sessions.get(id); if (!s) throw this.error(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `Unknown session ${id}`, false); if (s.busy) throw this.error(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Claude CLI session is already busy', true);
    const normalized = normalizeProviderPayload(payload);
    const isSlashControl = normalized.userMessage?.trim().startsWith('/') === true;
    const systemParts = getProviderSystemTextParts(normalized);
    const includeSessionSystemText = !isSlashControl
      && !!systemParts.sessionSystemText
      && s.sessionSystemTextInjected !== systemParts.sessionSystemText;
    const prompt = isSlashControl
      ? (normalized.assembledMessage || normalized.userMessage)
      : composeMessageSideProviderPrompt(normalized, { includeSessionSystemText });
    if (!prompt?.trim()) return;
    const sessionSystemTextToInject = includeSessionSystemText ? systemParts.sessionSystemText : undefined;
    s.busy = true; s.cancelled = false; s.text = ''; s.messageId = randomUUID();
    const args = [...CLAUDE_CODE_CLI_SDK_ARGS, ...(s.model ? ['--model', s.model] : []), ...(s.started ? ['--resume', s.resumeId] : [])];
    const resolved = resolveExecutableForSpawn((this.config?.binary as string | undefined) ?? 'claude');
    // Never inherit the daemon's ambient environment. Claude's child may only
    // receive explicitly scoped Claude variables, safe runtime variables, and
    // the verified auth UDS projection from buildClaudeAgentEnv.
    const childEnv = buildClaudeAgentEnv({ ...(this.config?.env as Record<string, string> | undefined), ...(s.env ?? {}) });
    const child = spawn(resolved.executable, [...resolved.prependArgs, ...args], { cwd: s.cwd, detached: process.platform !== 'win32', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    s.child = child; s.agentResource = bindAgentProcessResource(s.resourceOwner ?? null, child);
    const emitDelta = (text: string) => { if (!text || s.cancelled) return; s.text += text; this.deltaCallbacks.forEach((cb) => cb(id, { messageId: s.messageId, type: 'text', delta: text, role: 'assistant' })); };
    const finish = (metadata?: Record<string, unknown>) => {
      if (!s.busy) return;
      s.busy = false; s.started = true;
      if (sessionSystemTextToInject) s.sessionSystemTextInjected = sessionSystemTextToInject;
      const resultText = typeof metadata?.result === 'string' ? metadata.result : undefined;
      const content = s.text || resultText || '';
      const msg: AgentMessage = { id: s.messageId, sessionId: id, kind: 'text', role: 'assistant', content, timestamp: Date.now(), status: 'complete', ...(metadata ? { metadata } : {}) };
      this.completeCallbacks.forEach((cb) => cb(id, msg));
    };
    const fail = (message: string) => { if (!s.busy) return; s.busy = false; this.errorCallbacks.forEach((cb) => cb(id, this.error(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, true))); };
    const rl = readline.createInterface({ input: gateChildStream(child.stdout) });
    rl.on('line', (line) => {
      const event = parseClaudeCliStreamJsonLine(line); if (!event) return;
      const sid = sessionIdFromEvent(event);
      if (sid && sid !== s.resumeId) { s.resumeId = sid; this.emitInfo(id, { resumeId: sid }); }
      if (typeof event.model === 'string' && event.model.trim()) this.emitInfo(id, { model: event.model.trim() });
      const type = typeof event.type === 'string' ? event.type : '';
      const status = typeof event.status === 'string' ? event.status : (typeof event.subtype === 'string' && (type === 'status' || type === 'system') ? event.subtype : undefined);
      if (status) this.statusCallbacks.forEach((cb) => cb(id, { status }));
      if (event.usage && typeof event.usage === 'object') {
        this.usageCallbacks.forEach((cb) => cb(id, { messageId: s.messageId, usage: event.usage as ProviderUsageUpdate['usage'], finalized: type === 'result' }));
      }
      // `message_stop` terminates the Anthropic message stream, but Claude CLI
      // emits the authoritative `result` frame immediately afterwards (with
      // usage/error metadata). Wait for that frame; falling back to process
      // close below still handles older CLI versions that omit it.
      if (type === 'result' || event.subtype === 'success') {
        finish({ ...(typeof event.result === 'string' ? { result: event.result } : {}), ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}) }); return;
      }
      const text = eventText(event); if (text) emitDelta(text);
      if (type === 'error' || event.error) fail(typeof event.error === 'string' ? event.error : 'Claude CLI stream-json error');
    });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); s.stderr = stderr.slice(-4_000); });
    child.once('error', (err) => fail(err.message));
    child.stdin.on('error', (err) => {
      // The CLI may exit after emitting its final frame before the parent has
      // finished writing the request. Handle that expected EPIPE without an
      // unhandled exception; other write failures still reach the provider.
      if (s.busy && (err as NodeJS.ErrnoException).code !== 'EPIPE') fail(err.message);
    });
    child.once('close', (code) => {
      rl.close();
      s.child = null;
      if (!s.busy) return;
      if (code === 0) finish();
      else fail(s.stderr || `Claude CLI exited with code ${code ?? 'unknown'}`);
    });
    const input = JSON.stringify({ type: 'user', session_id: s.resumeId, message: { role: 'user', content: prompt } });
    try {
      child.stdin.write(`${input}\n`);
      child.stdin.end();
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'EPIPE') fail(errno.message);
    }
  }
  private emitInfo(id: string, info: SessionInfoUpdate): void { this.infoCallbacks.forEach((cb) => cb(id, info)); }
  private error(code: string, message: string, recoverable: boolean): ProviderError { return { code, message, recoverable }; }
}

export default ClaudeCodeCliSdkProvider;
