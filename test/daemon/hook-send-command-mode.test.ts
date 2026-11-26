/**
 * `imcodes send --command` / MCP command mode through the real hook server:
 * the dedicated `/send-command` path delivers exactly the trimmed text to a
 * transport and a process target, refuses invalid combinations, keeps `/stop`
 * on the priority stop path, and never lets a command ride the ordinary `/send`.
 */
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../shared/chat-message-origin.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const timelineEmitMock = vi.hoisted(() => vi.fn(() => ({})));
const sendProcessSessionMessageForAutomationMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stopSessionNowMock = vi.hoisted(() => vi.fn(() => true));
const getTransportRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn() },
}));
vi.mock('../../src/daemon/command-handler.js', () => ({
  sendProcessSessionMessageForAutomation: sendProcessSessionMessageForAutomationMock,
  stopSessionNow: stopSessionNowMock,
}));
vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
  ensureTransportRuntimeAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/daemon/watcher-controls.js', () => ({
  refreshSessionWatcher: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';
import { AGENT_DELEGATION_SENDER_MARKER } from '../../shared/agent-delegation.js';
import { SEND_COMMAND_ERRORS, SEND_COMMAND_HOOK_PATH } from '../../shared/send-command-mode.js';
import { getDelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';

function makeSession(overrides: Record<string, unknown>) {
  return {
    name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', agentType: 'claude-code', projectDir: '/work/alpha',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2, ...overrides,
  };
}

function post(port: number, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)), Connection: 'close' },
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: response ? JSON.parse(response) as Record<string, unknown> : {} }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('hook-server /send-command', () => {
  let server: http.Server;
  let port: number;
  const brain = makeSession({ name: 'deck_alpha_brain' });
  const processTarget = makeSession({ name: 'deck_sub_cmdproc', role: 'w1', agentType: 'codex', parentSession: 'deck_alpha_brain' });
  const claudeSdk = makeSession({ name: 'deck_sub_cmdclaude', role: 'w2', agentType: 'claude-code-sdk', runtimeType: 'transport', parentSession: 'deck_alpha_brain' });
  const codexSdk = makeSession({ name: 'deck_sub_cmdcodex', role: 'w3', agentType: 'codex-sdk', runtimeType: 'transport', parentSession: 'deck_alpha_brain' });
  const all = [brain, processTarget, claudeSdk, codexSdk];

  const idleRuntime = () => ({
    providerSessionId: 'provider-session',
    send: vi.fn().mockReturnValue('sent'),
    appendExternalMessageToActiveTurn: vi.fn().mockResolvedValue('sent'),
    getStatus: vi.fn().mockReturnValue('idle'),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    stopSessionNowMock.mockReturnValue(true);
    getSessionMock.mockImplementation((name: string) => all.find((entry) => entry.name === name) ?? null);
    listSessionsMock.mockReturnValue(all as never);
    clearQueues();
    const started = await startHookServer(vi.fn());
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const openRecords = () => getDelegationReplyStore().listOpenByOriginSession('deck_alpha_brain').length;

  it.each([
    ['claude-code-sdk', 'deck_sub_cmdclaude'],
    ['codex-sdk', 'deck_sub_cmdcodex'],
  ])('delivers exactly the trimmed text to an idle %s transport target', async (_agent, name) => {
    const runtime = idleRuntime();
    getTransportRuntimeMock.mockReturnValue(runtime);
    const before = openRecords();
    const raw = '\n  first line\n    second line — 第三行 ✓  \n';
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: name, message: raw, depth: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: true, target: name });
    expect(res.body).not.toHaveProperty('delegationId');
    const exact = raw.trim();
    expect(runtime.appendExternalMessageToActiveTurn).toHaveBeenCalledTimes(1);
    const [text, messageId, , , privateMetadata] = runtime.appendExternalMessageToActiveTurn.mock.calls[0]!;
    expect(Buffer.from(text).equals(Buffer.from(exact))).toBe(true);
    expect(text).not.toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(privateMetadata).toEqual({
      timelineCommitted: false,
      messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
      commandMode: true,
      sharedActor: expect.objectContaining({
        actionId: messageId,
        actorUserId: brain.name,
        actorDisplayName: brain.name,
        snapshot: expect.objectContaining({ target: expect.objectContaining({ subSessionId: name }) }),
      }),
    });
    expect(timelineEmitMock).toHaveBeenCalledWith(
      name,
      'user.message',
      expect.objectContaining({ text: exact, [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.AGENT }),
      expect.objectContaining({ eventId: `transport-user:${messageId}` }),
    );
    expect(openRecords()).toBe(before);
  });

  it('a busy transport that cannot append falls back to the FIFO carrying the command marker', async () => {
    const runtime = idleRuntime();
    runtime.appendExternalMessageToActiveTurn.mockResolvedValue('unsupported');
    runtime.send.mockReturnValue('queued');
    getTransportRuntimeMock.mockReturnValue(runtime);
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: 'deck_sub_cmdclaude', message: ' do it ' });
    expect(res.body).toMatchObject({ ok: true, queued: true });
    expect(runtime.send).toHaveBeenCalledWith('do it', res.body.messageId, undefined, undefined, expect.objectContaining({
      messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
      commandMode: true,
    }));
  });

  it('explicit queue mode never appends and still marks the queued command', async () => {
    const runtime = idleRuntime();
    runtime.send.mockReturnValue('queued');
    getTransportRuntimeMock.mockReturnValue(runtime);
    const res = await post(port, SEND_COMMAND_HOOK_PATH, {
      from: 'deck_alpha_brain', to: 'deck_sub_cmdcodex', message: 'later', deliveryMode: 'queue',
    });
    expect(res.body).toMatchObject({ ok: true, queued: true });
    expect(runtime.appendExternalMessageToActiveTurn).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledWith('later', res.body.messageId, undefined, undefined, expect.objectContaining({
      messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
      commandMode: true,
    }));
  });

  it('delivers exactly the trimmed text to a process agent, verbatim (no recall/rewrite)', async () => {
    const raw = '  \n/compact now\n  ';
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: 'deck_sub_cmdproc', message: raw });
    expect(res.body).toMatchObject({ ok: true, delivered: true, target: 'deck_sub_cmdproc' });
    expect(sendProcessSessionMessageForAutomationMock).toHaveBeenCalledWith(
      'deck_sub_cmdproc',
      raw.trim(),
      { userMessageMetadata: { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.AGENT }, verbatim: true },
    );
  });

  it('counterexample: the ordinary /send wraps the same text and never marks it as a command', async () => {
    const res = await post(port, '/send', { from: 'deck_alpha_brain', to: 'deck_sub_cmdproc', message: 'plain text' });
    expect(res.body).toMatchObject({ ok: true, delivered: true });
    const [, text, options] = sendProcessSessionMessageForAutomationMock.mock.calls[0]!;
    expect(text).toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(options).not.toHaveProperty('verbatim');
  });

  it.each([
    ['reply', { reply: true }, SEND_COMMAND_ERRORS.WITH_REPLY],
    ['files', { files: ['a.ts'] }, SEND_COMMAND_ERRORS.WITH_FILES],
    ['a supervision binding', { supervision: { taskId: 't', assignmentId: 'a' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
  ])('refuses command with %s (400, nothing delivered)', async (_name, extra, error) => {
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: 'deck_sub_cmdproc', message: '/compact', ...extra });
    expect(res).toEqual({ status: 400, body: { ok: false, error } });
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('refuses an empty command (400)', async () => {
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: 'deck_sub_cmdproc', message: '   ' });
    expect(res.status).toBe(400);
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('a command flag on the ordinary /send is refused, never delivered wrapped', async () => {
    const res = await post(port, '/send', { from: 'deck_alpha_brain', to: 'deck_sub_cmdproc', message: '/compact', command: true });
    expect(res).toEqual({ status: 400, body: { ok: false, error: `command mode requires ${SEND_COMMAND_HOOK_PATH}` } });
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('/stop as a command takes the priority stop path, not the send queue', async () => {
    const runtime = idleRuntime();
    getTransportRuntimeMock.mockReturnValue(runtime);
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: 'deck_sub_cmdclaude', message: ' /stop ' });
    expect(res.body).toMatchObject({ ok: true, stopped: true, target: 'deck_sub_cmdclaude' });
    expect(stopSessionNowMock).toHaveBeenCalledWith('deck_sub_cmdclaude');
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.appendExternalMessageToActiveTurn).not.toHaveBeenCalled();
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('broadcast delivers the identical raw text to every sibling', async () => {
    getTransportRuntimeMock.mockReturnValue(idleRuntime());
    const res = await post(port, SEND_COMMAND_HOOK_PATH, { from: 'deck_alpha_brain', to: '*', message: ' /compact ' });
    expect(res.status).toBe(200);
    expect(sendProcessSessionMessageForAutomationMock).toHaveBeenCalledWith(
      'deck_sub_cmdproc', '/compact', expect.objectContaining({ verbatim: true }),
    );
  });
});
