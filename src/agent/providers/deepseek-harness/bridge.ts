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
 * against dsh 0.1.0-rc.7), so the daemon never needs the harness's 195-package
 * dependency tree at build time and cannot break when that tree moves.
 *
 * STDOUT IS PROTOCOL-ONLY. Anything else written there corrupts the stream, so
 * diagnostics go to stderr.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
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
}

interface DshAgent {
  session: DshSession;
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel?(): void;
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
  on(event: string, listener: (session: DshSession, event: DshSessionEvent) => void): unknown;
}

interface DshSessionEvent {
  type: string;
  seq?: number;
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
  if (kind === DSH_BRIDGE_TURN_REASON.CANCELLED) return { reason: DSH_BRIDGE_TURN_REASON.CANCELLED };
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
    case DSH_BRIDGE_COMMAND.CANCEL:
      agent.cancel?.();
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
  ctx.on('session/event', (session, event) => {
    // Subagents publish on their own sessions through the same channel; only
    // this bridge's own agent is the daemon-facing conversation.
    if (session?.id !== agent.session.id) return;
    const data = event.data ?? {};

    if (event.type === DSH_SESSION_EVENT.ASSISTANT_CHUNK) {
      const chunk = asRecord(data.chunk);
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
        const usage = asRecord(chunk?.usage);
        const inputTokens = readNumber(usage?.inputTokens);
        const outputTokens = readNumber(usage?.outputTokens);
        const cacheReadTokens = readNumber(usage?.cacheReadTokens);
        emit({
          type: DSH_BRIDGE_EVENT.USAGE,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        });
      }
      return;
    }

    if (event.type === DSH_SESSION_EVENT.ASSISTANT_MESSAGE) {
      const message = asRecord(data.message);
      const text = collectText(message?.content);
      // A tool-call-only assistant message has no text; emitting it empty would
      // blank the daemon's in-flight bubble mid-turn.
      if (text) emit({ type: DSH_BRIDGE_EVENT.MESSAGE, text });
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
      const message = asRecord(data.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        const record = asRecord(block);
        if (!record || record.type !== 'tool-result') continue;
        const id = readString(record.toolCallId);
        if (!id) continue;
        // Tool results are the largest payloads in the stream; walk once.
        const output = collectText(record.content);
        emit({
          type: DSH_BRIDGE_EVENT.TOOL,
          id,
          // The daemon keys tool cards by id; the name came with tool/call.
          name: readString(record.toolName) ?? '',
          status: record.isError === true ? DSH_BRIDGE_TOOL_STATUS.ERROR : DSH_BRIDGE_TOOL_STATUS.COMPLETE,
          ...(output ? { output } : {}),
        });
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
  // The route always comes from the user's own `~/.dsh` selection; only the
  // model is overridable by IM.codes, which is why it can be applied on the
  // very first boot without needing to know the route.
  const requestedModel = process.env[DSH_BRIDGE_MODEL_ENV]?.trim();
  const effectiveModel = requestedModel || selection.model;
  const agentOptions = {
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
  };

  let handle: DshAgentHandle;
  let resumed = false;
  if (resumeSessionId) {
    try {
      handle = await agents.resume({ sessionId: resumeSessionId, agentOptions });
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

  emit({
    type: DSH_BRIDGE_EVENT.READY,
    sessionId: agent.session.id,
    resumed,
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
  });

  const rl = createInterface({ input: process.stdin });

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
    dispatchDshBridgeCommand(agent, command, requestExit);
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
