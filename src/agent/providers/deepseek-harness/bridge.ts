/**
 * Cordis plugin mounted inside the DeepSeek Harness (`dsh`) process.
 *
 * The harness exposes no callable SDK: `ctx.agents` / `ctx.sessions` live
 * inside its plugin runtime, and token-level output is only observable by
 * subscribing to `session/event` from within that process. This plugin is that
 * subscriber. It owns exactly one agent, republishes its event stream as NDJSON
 * on stdout, and accepts NDJSON commands on stdin, so the IM.codes daemon can
 * drive the harness as an ordinary spawned transport child.
 *
 * Deliberately dependency-free: it imports nothing from `@deepseek-ai/*`. User
 * messages are plain frozen objects, which the harness accepts (verified
 * against dsh 0.2.2-rc.5), so the daemon never needs the harness's 195-package
 * dependency tree at build time and cannot break when that tree moves.
 *
 * STDOUT IS PROTOCOL-ONLY. Anything else written there corrupts the stream, so
 * diagnostics go to stderr.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  DSH_AGENT_EVENT,
  DSH_BRIDGE_COMMAND,
  DSH_BRIDGE_EVENT,
  DSH_BRIDGE_TOOL_STATUS,
  DSH_BRIDGE_TURN_REASON,
  DSH_BRIDGE_CWD_ENV,
  DSH_BRIDGE_MODEL_ENV,
  DSH_BRIDGE_PLUGIN_ID,
  DSH_BRIDGE_RESUME_ENV,
  DSH_CHUNK_TYPE,
  DSH_SESSION_EVENT,
  type DshBridgeCommand,
  type DshBridgeEvent,
  type DshBridgeTurnReason,
} from '../../../../shared/deepseek-harness.js';

// ── Minimal structural types for the harness runtime ────────────────────────
// dsh ships empty .d.ts files for its bundles, so these describe only the
// members this plugin actually touches.

interface DshSession {
  id: string;
  requestContext?(): { provider?: string; model?: string; contextWindow?: number } | undefined;
}

interface DshAgentModel {
  select?(selection: { provider: string; model: string }): void;
  current?(): DshModelSelection | undefined;
}

interface DshAgent {
  session: DshSession;
  model?: DshAgentModel;
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel?(cause?: { kind: string }): void;
}

interface DshCompactionService {
  compactNow?(
    agent: DshAgent,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<{ shadowedSeqs?: unknown[]; shadowedTokenCount?: number } | null>;
}

interface DshAgentHandle {
  agent: DshAgent;
}

interface DshAgentRegistry {
  create(options: Record<string, unknown>): Promise<DshAgentHandle>;
  resume(options: Record<string, unknown>): Promise<DshAgentHandle>;
}

interface DshModelSelection {
  provider?: string;
  model?: string;
}

interface DshSessionStore {
  flush(session: DshSession): Promise<void>;
}

interface DshPluginContext {
  get(key: string): unknown;
  on(event: typeof DSH_AGENT_EVENT.ASSISTANT_STREAM, listener: (payload: DshAssistantStreamPayload) => void): unknown;
  on(event: 'session/event', listener: (session: DshSession, event: DshSessionEvent) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

interface DshAssistantStreamPayload {
  agent?: { session?: DshSession };
  frame?: { type?: string; chunk?: unknown };
}

interface DshSessionEvent {
  type: string;
  seq?: number;
  surfaceOp?: string;
  data?: Record<string, unknown>;
}

export const name = DSH_BRIDGE_PLUGIN_ID;
export const inject = ['agents', 'agentDefaultModel', 'sessions'];

function emit(event: DshBridgeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${DSH_BRIDGE_PLUGIN_ID}: ${message}\n`);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface DshRequestContextSnapshot {
  model?: string;
  contextWindow?: number;
}

function readRequestContextSnapshot(raw: unknown): DshRequestContextSnapshot {
  const record = asRecord(raw);
  const model = readString(record?.model);
  const contextWindow = readPositiveNumber(record?.contextWindow);
  return {
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function readToolError(rawError: unknown): string | undefined {
  if (typeof rawError === 'string' && rawError) return rawError;
  const record = asRecord(rawError);
  if (!record) return undefined;
  return readString(record.message) ?? readString(record.code);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Concatenate the `text` blocks of a harness message. Assistant messages also
 * carry `tool-call` blocks, and tool results carry `tool-result` blocks; only
 * text is assistant-visible output.
 */
function collectText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record || record.type !== 'text') return '';
      return readString(record.text) ?? '';
    })
    .join('');
}

/** Tool arguments arrive as a JSON string; hand back parsed input when possible. */
function parseToolArguments(value: unknown): unknown {
  const raw = readString(value);
  if (raw === undefined) return value ?? undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function mapTurnReason(reason: unknown): { reason: DshBridgeTurnReason; message?: string; code?: string } {
  const record = asRecord(reason);
  const kind = readString(record?.kind);
  if (kind === DSH_BRIDGE_TURN_REASON.ERROR) {
    const error = asRecord(record?.error);
    const message = readString(error?.message);
    const code = readString(error?.code);
    return {
      reason: DSH_BRIDGE_TURN_REASON.ERROR,
      ...(message ? { message } : {}),
      ...(code ? { code } : {}),
    };
  }
  if (kind === DSH_BRIDGE_TURN_REASON.CANCELLED || kind === 'aborted') {
    return { reason: DSH_BRIDGE_TURN_REASON.CANCELLED };
  }
  return { reason: DSH_BRIDGE_TURN_REASON.COMPLETED };
}

/**
 * Build a user message without importing the harness's message factory. The
 * factory only spreads the input, stamps a UUID id, and freezes the result.
 */
function buildUserMessage(text: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  });
}

/** Execute one validated daemon command against the live Harness agent. */
export function dispatchDshBridgeCommand(
  agent: DshAgent,
  command: DshBridgeCommand,
  requestExit: (code: number) => void,
  onCompact?: () => void,
  onCancel?: () => void,
): void {
  switch (command.type) {
    case DSH_BRIDGE_COMMAND.PROMPT:
      if (typeof command.text === 'string' && command.text) {
        agent.followup(buildUserMessage(command.text));
      }
      return;
    case DSH_BRIDGE_COMMAND.STEER:
      if (typeof command.text === 'string' && command.text) {
        agent.steer(buildUserMessage(command.text));
      }
      return;
    case DSH_BRIDGE_COMMAND.COMPACT:
      onCompact?.();
      return;
    case DSH_BRIDGE_COMMAND.CANCEL:
      onCancel?.();
      // dsh 0.2.x `ReactLoopAgent.cancel(cause)` reads `cause.kind`.
      agent.cancel?.({ kind: 'user' });
      return;
    case DSH_BRIDGE_COMMAND.SHUTDOWN:
      requestExit(0);
      return;
    default:
      warn('ignored unknown command');
  }
}

function subscribe(ctx: DshPluginContext, agent: DshAgent): void {
  // The daemon only needs to know THAT the model is reasoning. Emitting a frame
  // per reasoning token would push thousands of lines the daemon's status
  // dedupe discards after the first.
  let reasoningAnnounced = false;
  // Initialized from persisted session context (dsh 0.2.x resume) and replaced
  // atomically on each `request/context` event so route switches clear stale values.
  let currentRequestContext = readRequestContextSnapshot(agent.session.requestContext?.());

  const emitUsage = (rawUsage: unknown, finalized = false): void => {
    const usage = asRecord(rawUsage);
    if (!usage) return;
    const inputTokens = readNumber(usage.inputTokens);
    const outputTokens = readNumber(usage.outputTokens);
    const cacheReadTokens = readNumber(usage.cacheReadTokens);
    const cacheWriteTokens = readNumber(usage.cacheWriteTokens);
    const totalTokens = readNumber(usage.totalTokens);
    emit({
      type: DSH_BRIDGE_EVENT.USAGE,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(currentRequestContext.contextWindow !== undefined ? { contextWindow: currentRequestContext.contextWindow } : {}),
      ...(currentRequestContext.model ? { model: currentRequestContext.model } : {}),
      ...(finalized ? { finalized: true } : {}),
    });
  };

  const emitToolResult = (
    id: string,
    toolName: string,
    isError: boolean,
    content: unknown,
    rawError?: unknown,
  ): void => {
    const output = collectText(content) || (isError ? readToolError(rawError) : undefined);
    emit({
      type: DSH_BRIDGE_EVENT.TOOL,
      id,
      name: toolName,
      status: isError ? DSH_BRIDGE_TOOL_STATUS.ERROR : DSH_BRIDGE_TOOL_STATUS.COMPLETE,
      ...(output ? { output } : {}),
    });
  };

  const handleStreamChunk = (rawChunk: unknown): void => {
    const chunk = asRecord(rawChunk);
    const chunkType = readString(chunk?.type);
    if (chunkType === DSH_CHUNK_TYPE.TEXT_DELTA) {
      const text = readString(chunk?.text);
      if (text) emit({ type: DSH_BRIDGE_EVENT.DELTA, text });
      return;
    }
    if (chunkType === DSH_CHUNK_TYPE.REASONING_DELTA) {
      if (!reasoningAnnounced) {
        reasoningAnnounced = true;
        emit({ type: DSH_BRIDGE_EVENT.REASONING });
      }
      return;
    }
    if (chunkType === DSH_CHUNK_TYPE.USAGE) {
      emitUsage(chunk?.usage);
    }
  };

  ctx.on(DSH_AGENT_EVENT.ASSISTANT_STREAM, (payload) => {
    const subject = payload?.agent;
    if ((subject as unknown) !== (agent as unknown) && subject?.session?.id !== agent.session.id) return;
    if (payload?.frame?.type === 'chunk') {
      handleStreamChunk(payload.frame.chunk);
    }
  });

  ctx.on('session/event', (session, event) => {
    // Subagents publish on their own sessions through the same channel; only
    // this bridge's own agent is the daemon-facing conversation.
    if (session?.id !== agent.session.id) return;
    const data = event.data ?? {};

    if (event.type === DSH_SESSION_EVENT.REQUEST_CONTEXT) {
      currentRequestContext = readRequestContextSnapshot(data);
      return;
    }

    if (event.type === DSH_SESSION_EVENT.COMPACTION_START) {
      emit({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      return;
    }

    if (event.type === DSH_SESSION_EVENT.COMPACTION_END) {
      emit({
        type: DSH_BRIDGE_EVENT.COMPACTING,
        active: false,
        ...(data.error === undefined ? { committed: true } : {}),
      });
      return;
    }

    if (event.type === DSH_SESSION_EVENT.ASSISTANT_CHUNK) {
      handleStreamChunk(data.chunk);
      return;
    }

    if (event.type === DSH_SESSION_EVENT.ASSISTANT_MESSAGE) {
      const message = asRecord(data.message);
      const text = collectText(message?.content);
      // A tool-call-only assistant message has no text; emitting it empty would
      // blank the daemon's in-flight bubble mid-turn.
      if (text) emit({ type: DSH_BRIDGE_EVENT.MESSAGE, text });
      if (data.usage !== undefined) emitUsage(data.usage, true);
      return;
    }

    if (event.type === DSH_SESSION_EVENT.TOOL_CALL) {
      const id = readString(data.callId);
      const toolName = readString(data.name);
      if (!id || !toolName) return;
      const input = parseToolArguments(data.arguments);
      emit({
        type: DSH_BRIDGE_EVENT.TOOL,
        id,
        name: toolName,
        status: DSH_BRIDGE_TOOL_STATUS.RUNNING,
        ...(input !== undefined ? { input } : {}),
      });
      return;
    }

    if (event.type === DSH_SESSION_EVENT.TOOL_RESULT) {
      // Compaction/surface rewrites emit replaced historical results; only live appends are new tool outputs.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
      const message = asRecord(data.message);
      if (!message) return;
      const emittedIds = new Set<string>();
      // First-class `role: 'tool'` result (`dsh-llm` createToolResultMessage):
      // `toolCallId` and `isError` live on `message`, while `content` holds result blocks directly.
      const topLevelId = readString(message.toolCallId);
      if (topLevelId) {
        emittedIds.add(topLevelId);
        emitToolResult(
          topLevelId,
          readString(message.toolName) ?? '',
          message.isError === true,
          message.content,
          data.error,
        );
      }
      // Fallback for block-wrapped `tool-result` payloads without duplicating any id already emitted above.
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        const record = asRecord(block);
        if (!record || record.type !== 'tool-result') continue;
        const id = readString(record.toolCallId);
        if (!id || emittedIds.has(id)) continue;
        emittedIds.add(id);
        emitToolResult(
          id,
          readString(record.toolName) ?? '',
          record.isError === true,
          record.content,
          data.error,
        );
      }
      return;
    }

    if (event.type === DSH_SESSION_EVENT.TURN_END) {
      reasoningAnnounced = false;
      emit({ type: DSH_BRIDGE_EVENT.TURN_END, ...mapTurnReason(data.reason) });
    }
  });
}

async function start(ctx: DshPluginContext): Promise<void> {
  const loader = ctx.get('loader') as { await?: () => Promise<void> } | undefined;
  await loader?.await?.();

  const agents = ctx.get('agents') as DshAgentRegistry | undefined;
  const sessions = ctx.get('sessions') as DshSessionStore | undefined;
  const defaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): DshModelSelection }
    | undefined;
  if (!agents || !sessions || !defaultModel) {
    emit({ type: DSH_BRIDGE_EVENT.ERROR, message: 'harness core services unavailable' });
    return;
  }

  const selection = defaultModel.currentSelection();
  const resumeSessionId = process.env[DSH_BRIDGE_RESUME_ENV]?.trim();
  const cwd = process.env[DSH_BRIDGE_CWD_ENV]?.trim() || process.cwd();
  // The route always comes from the user's own `~/.dsh` or preset selection;
  // only the model is overridable by IM.codes on spawn/resume.
  const rawRequestedModel = process.env[DSH_BRIDGE_MODEL_ENV]?.trim();
  const providerPrefix = selection.provider ? `${selection.provider}/` : '';
  const requestedModel = providerPrefix && rawRequestedModel?.startsWith(providerPrefix)
    ? rawRequestedModel.slice(providerPrefix.length)
    : rawRequestedModel;
  const effectiveModel = requestedModel || selection.model;
  const agentOptions = {
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
  };

  let handle: DshAgentHandle;
  let resumed = false;
  if (resumeSessionId) {
    try {
      // dsh 0.2.x expects `resumeSessionId`; `sessionId` is retained for 0.1.x compatibility.
      // Explicitly apply requestedModel in setup() because `AgentModel.current()` keeps the
      // previously recorded `lastUsed` selection unless a new `model/selection` is written.
      handle = await agents.resume({
        resumeSessionId,
        sessionId: resumeSessionId,
        agentOptions,
        ...(requestedModel && selection.provider
          ? {
              setup: (_agentCtx: unknown, resumedAgent: DshAgent) => {
                resumedAgent.model?.select?.({ provider: selection.provider!, model: requestedModel });
              },
            }
          : {}),
      });
      resumed = true;
    } catch (err) {
      // A resume target can be missing after a session-store prune. Falling
      // back to a fresh agent keeps the session usable; the daemon learns the
      // new id from the ready frame and repoints its resume record.
      warn(`resume failed for ${resumeSessionId}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      handle = await agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd }, agentOptions });
    }
  } else {
    handle = await agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd }, agentOptions });
  }

  const { agent } = handle;
  subscribe(ctx, agent);
  await agent.whenIdle();

  const liveModel = readString(agent.model?.current?.()?.model);
  const readyModel = liveModel ?? (resumed ? readString(agent.session.requestContext?.()?.model) : undefined) ?? effectiveModel;
  emit({
    type: DSH_BRIDGE_EVENT.READY,
    sessionId: agent.session.id,
    resumed,
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(readyModel ? { model: readyModel } : {}),
  });

  const rl = createInterface({ input: process.stdin });
  let activeCompactAbort: AbortController | null = null;
  const runManualCompact = async (): Promise<void> => {
    if (activeCompactAbort) {
      emit({
        type: DSH_BRIDGE_EVENT.COMPACT_RESULT,
        ok: false,
        message: 'Compaction already in progress.',
      });
      return;
    }
    const compaction = ctx.get('compaction') as DshCompactionService | undefined;
    if (!compaction?.compactNow) {
      emit({
        type: DSH_BRIDGE_EVENT.COMPACT_RESULT,
        ok: false,
        message: 'Compaction service unavailable.',
      });
      return;
    }
    const abort = new AbortController();
    activeCompactAbort = abort;
    try {
      const result = await compaction.compactNow(agent, abort.signal);
      if (result === null) {
        emit({
          type: DSH_BRIDGE_EVENT.COMPACT_RESULT,
          ok: false,
          message: 'No compactable history yet.',
        });
        return;
      }
      await sessions.flush(agent.session).catch(() => {});
      emit({
        type: DSH_BRIDGE_EVENT.COMPACT_RESULT,
        ok: true,
        committed: true,
        ...(Array.isArray(result.shadowedSeqs) ? { shadowedCount: result.shadowedSeqs.length } : {}),
        ...(typeof result.shadowedTokenCount === 'number' ? { shadowedTokenCount: result.shadowedTokenCount } : {}),
      });
    } catch (err) {
      emit({
        type: DSH_BRIDGE_EVENT.COMPACT_RESULT,
        ok: false,
        ...(abort.signal.aborted ? { cancelled: true } : {}),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (activeCompactAbort === abort) activeCompactAbort = null;
    }
  };

  // Two paths request termination — an explicit `shutdown` command and the
  // daemon closing stdin — and they can race. Windows makes that race fatal:
  // calling process.exit() while libuv is still closing the stdio handles trips
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in src/win/async.c.
  // So exit once, and prefer the launcher's own `appExit` hook, which lets the
  // harness unwind its handles instead of tearing the process down under them.
  let exiting = false;
  const requestExit = (code: number): void => {
    if (exiting) return;
    exiting = true;
    activeCompactAbort?.abort();
    rl.close();
    void sessions.flush(agent.session).catch(() => {}).then(() => {
      const appExit = ctx.get('appExit');
      if (typeof appExit === 'function') {
        (appExit as (value: number) => void)(code);
        return;
      }
      // No launcher hook: yield a tick so the stdio handles finish closing.
      setImmediate(() => process.exit(code));
    });
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let command: DshBridgeCommand;
    try {
      command = JSON.parse(trimmed) as DshBridgeCommand;
    } catch {
      warn('ignored malformed command line');
      return;
    }
    dispatchDshBridgeCommand(
      agent,
      command,
      requestExit,
      () => { void runManualCompact(); },
      () => { activeCompactAbort?.abort(); },
    );
  });
  // The daemon closing stdin is a terminal signal: flush and leave rather than
  // lingering as an orphan holding the session lock.
  rl.on('close', () => { requestExit(0); });
}

export function apply(ctx: DshPluginContext): void {
  start(ctx).catch((err) => {
    emit({ type: DSH_BRIDGE_EVENT.ERROR, message: err instanceof Error ? err.message : String(err) });
  });
}
