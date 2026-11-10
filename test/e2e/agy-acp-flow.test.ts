import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { SESSION_MODEL_COMMAND } from '../../shared/session-control-commands.js';
import { AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES } from '../../shared/agent-delegation.js';
import { AGY_ACP_AGENT_NAME } from '../../shared/agy-agent.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectProvider, disconnectAll, getProvider } from '../../src/agent/provider-registry.js';
import { launchTransportSession, getTransportRuntime, stopTransportRuntimeSession } from '../../src/agent/session-manager.js';
import { getSession, flushStore, removeSession } from '../../src/store/session-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { AGY_NATIVE_SESSION_STATE, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { getTransportQueueStore } from '../../src/daemon/transport-queue-store.js';

const NAME = 'deck_e2e_agy_acp_brain';
const PROJECT = 'e2e_agy_acp';
let root: string, log: string, off: (() => void) | undefined;
let events: TimelineEvent[];
const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
const finalized = () => events.filter(e => e.type === 'assistant.text' && e.payload.streaming === false);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'imcodes-e2e-agy-acp-')); log = path.join(root, 'rpc.jsonl'); events = [];
  expect(isKnownTestSessionLike({ name: NAME, projectName: PROJECT, projectDir: root })).toBe(true);
  const binary = path.join(root, 'agy');
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
  off = timelineEmitter.on(e => { if (e.sessionId === NAME) events.push(e); });
  await connectProvider(AGY_SDK_PROVIDER_ID, { binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log } });
  await launchTransportSession({ name: NAME, projectName: PROJECT, projectDir: root, role: 'brain', agentType: AGY_SDK_PROVIDER_ID });
});
afterEach(async () => { off?.(); await stopTransportRuntimeSession(NAME); removeSession(NAME); await disconnectAll(); await rm(root, { recursive: true, force: true }); });
describe('real AG ACP SDK/runtime/durable store/relay', () => {
  it('admits human Append and MCP append during A, no premature completion/FIFO replay, persists exact native identity', async () => {
    const runtime = getTransportRuntime(NAME)!;
    expect(getProvider(AGY_SDK_PROVIDER_ID)?.capabilities.activeDelegationNotification).toBe(AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE);
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    runtime.send('RUN_A', 'e2e-agy-acp-a');
    await vi.waitFor(async () => expect((await requests()).some(x => x.method === 'session/prompt')).toBe(true));
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
    runtime.send('HUMAN_B', 'e2e-agy-acp-b');
    expect(runtime.pendingEntries.some(x => x.clientMessageId === 'e2e-agy-acp-b')).toBe(true);
    const appended = await runtime.appendPendingMessagesToActiveTurn(['e2e-agy-acp-b'], 'e2e-agy-acp-human-append');
    expect(appended.status).toBe('delivered');
    await runtime.appendExternalMessageToActiveTurn('MCP_C', 'e2e-agy-acp-c');
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(3));
    expect(finalized()).toHaveLength(0); expect(runtime.getStatus()).not.toBe('idle');
    await vi.waitFor(() => expect(finalized()).toHaveLength(1));
    expect(finalized()[0]?.payload.text).toContain('RUN_A');
    expect(finalized()[0]?.payload.text).toContain('HUMAN_B'); expect(finalized()[0]?.payload.text).toContain('MCP_C');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    expect(runtime.pendingCount).toBe(0);
    expect(getTransportQueueStore().hasDeliveryTombstone(NAME, 'e2e-agy-acp-b')).toBe(true);
    expect(getTransportQueueStore().hasDeliveryTombstone(NAME, 'e2e-agy-acp-c')).toBe(true);
    const rows = await requests(); const prompts = rows.filter(x => x.method === 'session/prompt');
    expect(new Set(prompts.map(x => x.params.sessionId)).size).toBe(1);
    expect(rows.some(x => x.method === 'session/cancel')).toBe(false);
    await flushStore();
    expect(getSession(NAME)?.providerResumeId).toBe(prompts[0]?.params.sessionId);
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
  });
  it('keeps ordinary busy messages in durable FIFO until the current native run completes', async () => {
    const runtime = getTransportRuntime(NAME)!; runtime.send('RUN_A', 'fifo-a');
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1));
    runtime.send('ORDINARY_D', 'fifo-d'); expect(runtime.pendingCount).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 40)); expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1);
    await vi.waitFor(() => expect(finalized()).toHaveLength(2));
    expect(finalized()[0]?.payload.text).not.toContain('ORDINARY_D'); expect(finalized()[1]?.payload.text).toContain('ORDINARY_D');
    expect(runtime.pendingCount).toBe(0);
  });
  it.each(['reordered', 'reject-b'])('Stop-and-send preserves selected IDs and FIFO after a retired/rejected last RPC (%s)', async scenario => {
    const runtime = getTransportRuntime(NAME)!, provider = getProvider(AGY_SDK_PROVIDER_ID)!;
    // Switch only the task-owned native peer before any model/session call.
    await provider.connect({ binaryPath: path.join(root, 'agy'), env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_SCENARIO: scenario, AGY_ACP_FIXTURE_REPLY_GAP_MS: '500' } });
    const selectedId = `stop-selected-${scenario}`, fifoId = `stop-fifo-${scenario}`;
    runtime.send('RUN_A', `stop-original-${scenario}`);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1));
    const providerSessionId = (runtime as any)._providerSessionId as string;
    expect(typeof providerSessionId).toBe('string');
    await provider.notifyActiveDelegation!(providerSessionId, { notificationId: 'stop-steer-b', text: 'B' });
    const state = (provider as any).sessions.get(providerSessionId);
    await (provider as any).promptTerminals.get(state).catch(() => {});
    expect(provider.getSessionDiagnostics!(providerSessionId)?.promptInFlight).toBe(true);
    // A model command is intentionally not a native delegation append. This
    // exercises the real strong-Stop fallback, not a mocked capability/ACK.
    const selected = `${SESSION_MODEL_COMMAND} model-b`;
    runtime.send(selected, selectedId);
    runtime.send('FIFO_D', fifoId);
    expect(runtime.pendingEntries.map(entry => entry.clientMessageId)).toEqual([selectedId, fifoId]);
    const operation = runtime.stopAndSendPendingMessages([selectedId], 'stop-click');
    await expect(operation).resolves.toMatchObject({ status: 'stopped_and_dispatched' });
    await vi.waitFor(() => expect(runtime.pendingCount).toBe(0));
    await vi.waitFor(async () => {
      const prompts = (await requests()).filter(x => x.method === 'session/prompt');
      expect(prompts).toHaveLength(4);
      expect(prompts.slice(2).map(x => x.params.prompt[0].text)).toEqual([expect.stringContaining(selected), expect.stringContaining('FIFO_D')]);
    });
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    expect(await runtime.stopAndSendPendingMessages([selectedId], 'same-id-retry')).toMatchObject({ status: 'already_delivered' });
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/cancel')).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/prompt' && x.params.prompt[0].text.includes(selected))).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/prompt' && x.params.prompt[0].text.includes('FIFO_D'))).toHaveLength(1);
    const output = finalized();
    expect(output.filter(e => e.payload.text.includes(selected))).toHaveLength(1);
    expect(output.filter(e => e.payload.text.includes('FIFO_D'))).toHaveLength(1);
    // The old run has one diagnostic terminal (partial text on Stop or a
    // real RPC error), plus exactly one final per subsequent queued turn.
    expect(output).toHaveLength(3);
    const oldTerminal = output.filter(e => e.payload.providerErrorCode);
    expect(oldTerminal).toHaveLength(1);
    expect(oldTerminal[0]?.payload.providerErrorCode).toBe(scenario === 'reject-b' ? PROVIDER_ERROR_CODES.PROVIDER_ERROR : PROVIDER_ERROR_CODES.CANCELLED);
  });
  it('retains native identity across actual provider process restart without session/new fallback', async () => {
    const runtime = getTransportRuntime(NAME)!; runtime.send('RUN_A', 'restart-a');
    await vi.waitFor(() => expect(finalized()).toHaveLength(1)); await flushStore();
    const saved = getSession(NAME)!; const native = saved.providerResumeId as string;
    const provider = getProvider(AGY_SDK_PROVIDER_ID)!;
    await provider.disconnect();
    const binary = path.join(root, 'agy'); await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log } });
    const resumed = await provider.createSession({ sessionKey: 'deck_e2e_agy_acp_restored', resumeId: native, cwd: root });
    const done = vi.fn(); const unsubscribe = provider.onComplete(done);
    try { await provider.send(resumed, 'after restart'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1)); }
    finally { unsubscribe(); }
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/new')).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/resume').map(x => x.params.sessionId)).toEqual([native]);
    expect(done.mock.calls[0]?.[1].metadata.resumeId).toBe(native);
  });
});
