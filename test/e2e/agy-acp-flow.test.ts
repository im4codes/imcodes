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
