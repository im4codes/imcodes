import { AGY_ACP_AGENT_NAME, AGY_CLI_PATH_ENV } from '../../shared/agy-agent.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyAcpProvider, createAgyProvider, supportsAgyAcp } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider, resolveAgyBinary } from '../../src/agent/providers/agy-sdk.js';
import { AGENT_DELEGATION_NOTIFICATION_RESULTS } from '../../shared/agent-delegation.js';
import { PROVIDER_ERROR_CODES, normalizeProviderPayload } from '../../src/agent/transport-provider.js';
import { AGY_NATIVE_START_NOT_ATTEMPTED } from '../../shared/agy-agent.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { onConfirmedProviderStop } from '../../src/agent/provider-stop-confirmation.js';
import type { SessionInfoUpdate } from '../../src/agent/transport-provider.js';

const resources: Array<{ provider: AgyAcpProvider; root: string }> = [];
afterEach(async () => { for (const { provider, root } of resources.splice(0)) { await provider.disconnect(); await rm(root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
async function setup(scenario = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-acp-'));
  const binary = path.join(root, 'agy');
  const fixture = path.resolve('test/fixtures/agy-acp.mjs');
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  const provider = new AgyAcpProvider(); resources.push({ provider, root });
  const log = path.join(root, 'rpc.jsonl');
  await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_SCENARIO: scenario } });
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { provider, root, binary, requests };
}
const notification = (id: string, text = id) => ({ notificationId: id, text });
async function route(provider: AgyAcpProvider, name = 'deck_test_agy_acp', extra = {}) {
  await provider.createSession({ sessionKey: name, sessionName: name, cwd: process.cwd(), agentId: 'model-a', ...extra }); return name;
}
describe('AG native ACP', () => {
  it.each(['normal', 'reordered'])('keeps A/B/C in one active native run and emits one terminal (%s)', async scenario => {
    const { provider, requests } = await setup(scenario);
    const id = await route(provider); const complete = vi.fn(), errors = vi.fn();
    provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A');
    await Promise.all([provider.notifyActiveDelegation(id, notification('B')), provider.notifyActiveDelegation(id, notification('C'))]);
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0]?.[1].content).toBe('A B C'); expect(errors).not.toHaveBeenCalled();
    const prompts = (await requests()).filter(x => x.method === 'session/prompt');
    expect(prompts.map(x => x.params.sessionId)).toEqual(['native-1', 'native-1', 'native-1']);
    expect((await requests()).some(x => x.method === 'session/cancel')).toBe(false);
    expect(complete.mock.calls[0]?.[1].metadata.usage).toEqual({ inputTokens: scenario === 'reordered' ? 30 : 10, outputTokens: scenario === 'reordered' ? 15 : 5 });
  });
  it('deduplicates durable ids, including retries after the superseded A response', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    await provider.send(id, 'A');
    await Promise.all([provider.notifyActiveDelegation(id, notification('B')), provider.notifyActiveDelegation(id, notification('B'))]);
    await provider.notifyActiveDelegation(id, notification('B'));
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2));
  });
  it('does not clear an active A/tool when only B RPC is rejected', async () => {
    const { provider } = await setup('reject-b'); const id = await route(provider), complete = vi.fn(), errors = vi.fn(); provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(complete).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1)); expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
  });
  it('Stop cancels the aggregate once without allowing delayed updates to revive it', async () => {
    const { provider } = await setup('reordered'); const id = await route(provider); const complete = vi.fn(), errors = vi.fn(); provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B')); await provider.cancelAndWait(id);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1)); expect(complete).not.toHaveBeenCalled();
    expect(await provider.notifyActiveDelegation(id, notification('C'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
  });
  it.each(['reordered', 'reject-b'])('Stop waits for all RPCs even after the last one settled (%s)', async scenario => {
    const { provider } = await setup(scenario), id = await route(provider), errors = vi.fn();
    provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    const state = (provider as any).sessions.get(id);
    // The last RPC has ended/rejected but the original native A is still live.
    await (provider as any).promptTerminals.get(state).catch(() => {});
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    const stopping = provider.cancelAndWait(id), confirmed = vi.fn();
    const off = onConfirmedProviderStop(stopping, confirmed);
    try {
      await expect(Promise.race([stopping.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('timeout'), 300))])).resolves.toBe('stopped');
      expect(confirmed).toHaveBeenCalledTimes(1);
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      await expect(provider.send(id, 'AFTER_STOP')).resolves.toBeUndefined();
    } finally { off(); }
  });
  it('confirms an aggregate Stop on captured child death, not a single RPC rejection', async () => {
    const { provider } = await setup('crash-on-cancel'), id = await route(provider), errors = vi.fn();
    provider.onError(errors); await provider.send(id, 'A');
    await provider.notifyActiveDelegation(id, notification('B'));
    await expect(provider.cancelAndWait(id)).resolves.toBeUndefined();
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });
  it('never cancels or confirms a replacement owner through a captured old Stop', async () => {
    const { provider, requests } = await setup(), id = await route(provider), complete = vi.fn();
    provider.onComplete(complete); await provider.send(id, 'A');
    const stopping = provider.cancelAndWait(id), confirmed = vi.fn();
    const rejected = expect(stopping).rejects.toThrow('changed');
    const off = onConfirmedProviderStop(stopping, confirmed);
    try {
      await route(provider, id, { fresh: true });
      await provider.send(id, 'NEW_OWNER'); await rejected;
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
      expect(complete.mock.calls[0]?.[1].content).toBe('NEW_OWNER');
      expect(confirmed).not.toHaveBeenCalled();
      expect((await requests()).some(x => x.method === 'session/cancel')).toBe(false);
    } finally { off(); }
  });
  it('holds session/new behind durable ownership and preserves queued no-start evidence', async () => {
    const { provider, requests } = await setup(); const id = await route(provider, undefined, { beforeNativeSessionStart: async () => { throw new Error('disk failed'); } });
    await expect(provider.send(id, 'A')).rejects.toMatchObject({ details: { [AGY_NATIVE_START_NOT_ATTEMPTED]: true } });
    expect((await requests()).some(x => x.method === 'session/new')).toBe(false);
  });
  it('does not prompt or publish a late new-session result after Stop', async () => {
    const { provider, requests } = await setup('late-new'); const id = await route(provider); const info = vi.fn(); provider.onSessionInfo(info);
    const sending = provider.send(id, 'A'); const rejected = expect(sending).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CANCELLED });
    await vi.waitFor(async () => expect((await requests()).some(x => x.method === 'session/new')).toBe(true));
    await provider.cancel(id); await rejected;
    expect((await requests()).some(x => x.method === 'session/prompt')).toBe(false); expect(info).not.toHaveBeenCalled();
  });
  it('resumes exact native IDs without fresh fallback or replay, and isolates main/sub routes', async () => {
    const { provider, requests } = await setup(); const a = await route(provider, 'deck_test_agy_main', { resumeId: 'persisted-main' }); const b = await route(provider, 'deck_test_agy_sub', { resumeId: 'persisted-sub' });
    await provider.send(a, 'A'); await provider.send(b, 'A');
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/resume').map(x => x.params.sessionId)).toEqual(['persisted-main', 'persisted-sub']); expect(rows.some(x => x.method === 'session/new' || x.method === 'session/load')).toBe(false);
    const missing = await route(provider, 'deck_test_agy_missing', { resumeId: 'missing-native' }); await expect(provider.send(missing, 'A')).rejects.toBeTruthy(); expect((await requests()).some(x => x.method === 'session/new')).toBe(false);
  });
  it('selects pending B only on the next idle turn and reports confirmed models', async () => {
    const { provider, requests } = await setup(); const id = await route(provider); const complete = vi.fn(), info: SessionInfoUpdate[] = []; provider.onComplete(complete); provider.onSessionInfo((_id, update) => info.push(update));
    await provider.send(id, 'A'); provider.setSessionAgentId(id, 'model-b');
    expect(info.filter(x => x.model === 'model-b')).toHaveLength(0);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1)); expect(complete.mock.calls[0]?.[1].metadata.model).toBe('model-a');
    await provider.send(id, 'A'); expect(info.some(x => x.model === 'model-b')).toBe(true);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    provider.setSessionAgentId(id, 'model-a'); await provider.send(id, 'A');
    expect((await requests()).filter(x => x.method === 'session/set_model').map(x => x.params.modelId)).toEqual(['model-b', 'model-a']);
  });
  it('ACKs busy selection without changing captured actual or steering, then uses B on the next turn', async () => {
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider);
    const hold = path.join(root, 'rpc.jsonl.hold');
    await writeFile(hold, 'hold');
    const complete = vi.fn(), info = vi.fn(); provider.onComplete(complete); provider.onSessionInfo(info);
    try {
      await provider.send(id, 'A');
      const switching = provider.applySessionModel(id, 'model-b');
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true));
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      const repeated = provider.applySessionModel(id, 'model-b');
      expect(await switching).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await repeated).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect((await requests()).filter(row => row.method === 'session/set_model')).toHaveLength(1);
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      await provider.notifyActiveDelegation(id, notification('STEER_AFTER_SELECTION'));
      await vi.waitFor(async () => expect((await requests()).filter(row => row.fixture === 'prompt-model').map(row => row.model)).toEqual(['model-a', 'model-a']));
    } finally { await unlink(hold); }
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0][1].metadata.model).toBe('model-a');
    await provider.send(id, 'NEXT_TURN');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1][1].metadata.model).toBe('model-b');
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(true);
    expect((await requests()).filter(row => row.fixture === 'prompt-model').at(-1).model).toBe('model-b');
  });

  it('orders C after a delayed B but never publishes the superseded B ACK', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    provider.onSessionInfo(info);
    const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CANCELLED });
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true));
    expect(await provider.applySessionModel(id, 'model-c')).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    expect(info.mock.calls.map(call => call[1].model)).toEqual(['model-c']);
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-c']);
  });
  it.each(['cancel', 'replace', 'disconnect'])('rejects a delayed model ACK after %s without stale actual', async action => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'A'); provider.onSessionInfo(info);
    const switching = provider.applySessionModel(id, 'model-b'); const rejected = expect(switching).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true));
    if (action === 'cancel') await provider.cancel(id);
    else if (action === 'replace') await route(provider, id, { fresh: true });
    else await provider.disconnect();
    await rejected;
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
  });
  it.each(['model-error', 'model-unsupported'])('does not report false model success on %s', async scenario => {
    const { provider } = await setup(scenario); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    provider.onSessionInfo(info);
    await expect(provider.applySessionModel(id, 'model-b')).rejects.toBeTruthy();
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
    await provider.send(id, 'after-rejection');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
  });
  it('reapplies A after a delayed superseded B instead of trusting the old A cache', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider);
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true));
    expect(await provider.applySessionModel(id, 'model-a')).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-a']);
  });
  it('returns to the retained selection if C fails after superseding a pending B', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    provider.onSessionInfo(info);
    const old = provider.applySessionModel(id, 'model-b'); const rejected = expect(old).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true));
    await expect(provider.applySessionModel(id, 'invalid')).rejects.toBeTruthy(); await rejected;
    await provider.send(id, 'after-failed-c');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'invalid', 'model-a']);
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
  });

  it('bounds a model RPC timeout, rejects its late ACK, and recovers on a new confirmed selection', async () => {
    const { provider } = await setup('model-timeout'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
    provider.onSessionInfo(info);
    await expect(provider.applySessionModel(id, 'model-b')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.PROVIDER_ERROR });
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
    expect(await provider.applySessionModel(id, 'model-c')).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect(info.mock.calls.map(call => call[1].model)).toEqual(['model-c']);
    await provider.send(id, 'after-timeout');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false));
  }, 10000);

  it('keeps an unloaded selection next-start without creating native work', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    expect((await requests()).some(row => row.method === 'session/new' || row.method === 'session/set_model')).toBe(false);
  });

  it.each(['deck_test_agy_main', 'deck_test_agy_sub'])('confirms a pending unloaded choice when restoring %s without native creation', async name => {
    const { provider, requests } = await setup();
    const id = await route(provider, name, { resumeId: 'owned-native' }); const info = vi.fn();
    provider.onSessionInfo(info);
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    expect(await provider.restoreSession(id)).toBe(true);
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(true);
    expect((await requests()).some(row => row.method === 'session/new')).toBe(false);
    expect((await requests()).find(row => row.method === 'session/set_model').params).toEqual({ sessionId: 'owned-native', modelId: 'model-b' });
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect((await requests()).filter(row => row.method === 'session/set_model')).toHaveLength(1);
  });

  it('passes combined native base-model/thought IDs unchanged and captures the original executor choice', async () => {
    const { provider, requests, root } = await setup();
    const id = await route(provider, undefined, { agentId: 'gemini-3.8-flash-low' }); const done = vi.fn(); provider.onComplete(done);
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(await provider.applySessionModel(id, 'gemini-3.8-flash-high')).toBe(SESSION_MODEL_APPLIED.LIVE);
    const hold = path.join(root, 'rpc.jsonl.hold'); await writeFile(hold, 'hold');
    try {
      await provider.send(id, 'A');
      expect(await provider.applySessionModel(id, 'gemini-4-carbon-medium')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    } finally { await unlink(hold); }
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2));
    expect(done.mock.calls[1][1].metadata.model).toBe('gemini-3.8-flash-high');
    await provider.send(id, 'next'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3));
    expect(done.mock.calls[2][1].metadata.model).toBe('gemini-4-carbon-medium');
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-4-carbon-medium']);
  });

  it('does not submit a prompt if native model selection fails', async () => {
    const { provider, requests } = await setup(); const id = await route(provider, undefined, { agentId: 'invalid' });
    await expect(provider.send(id, 'A')).rejects.toBeTruthy(); expect((await requests()).some(x => x.method === 'session/prompt')).toBe(false);
  });
  it('keeps a timed-out write pending and deduplicates its retry before native submission', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    await provider.send(id, 'A');
    const tracker = (provider as any).connection.connection;
    let release!: () => void; tracker.writeQueue = new Promise<void>(resolve => { release = resolve; });
    let admitted = false;
    const first = provider.notifyActiveDelegation(id, notification('B')).then(x => { admitted = true; return x; });
    await new Promise(resolve => setTimeout(resolve, 25)); expect(admitted).toBe(false);
    const retry = provider.notifyActiveDelegation(id, notification('B')); release();
    expect(await first).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED); expect(await retry).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2));
  });
  it('isolates child death to this provider and never replays the admitted B', async () => {
    const { provider, requests } = await setup('crash'); const id = await route(provider), errors = vi.fn(), complete = vi.fn();
    provider.onError(errors); provider.onComplete(complete);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2));
    expect(await provider.notifyActiveDelegation(id, notification('C'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
  });
  it('replaces a pending startup owner even when the canonical route is unchanged', async () => {
    const { provider, requests } = await setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const id = await route(provider, 'deck_test_agy_owner', { beforeNativeSessionStart: () => gate });
    const oldSend = provider.send(id, 'old-owner').then(() => 'sent', error => error.code);
    await new Promise(resolve => setTimeout(resolve, 15));
    try {
      await route(provider, id, { beforeNativeSessionStart: async () => {} });
      await expect(provider.send(id, 'new-owner')).resolves.toBeUndefined();
    } finally { release(); }
    expect(await oldSend).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt').map(x => x.params.prompt[0].text)).toEqual(['new-owner']));
  });
  it('ignores old native-session updates and terminals after delete/recreate of the route', async () => {
    const { provider } = await setup(); const id = await route(provider); const complete = vi.fn(), deltas = vi.fn(); provider.onComplete(complete); provider.onDelta(deltas);
    await provider.send(id, 'A');
    await provider.createSession({ sessionKey: id, cwd: process.cwd(), fresh: true, agentId: 'model-a' });
    await provider.send(id, 'new-owner'); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0]?.[1].content).toBe('new-owner');
    expect(deltas.mock.calls.some(x => x[1].delta === 'A')).toBe(false);
  });
  it('suppresses all resume replay and keeps the current real error visible', async () => {
    const { provider } = await setup('resume-history'); const id = await route(provider, undefined, { resumeId: 'saved-id' });
    const deltas = vi.fn(), complete = vi.fn(); provider.onDelta(deltas); provider.onComplete(complete);
    await provider.send(id, 'A'); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0]?.[1].content).toBe('A'); expect(deltas.mock.calls.some(x => x[1].delta.includes('OLD_ERROR'))).toBe(false);
  });
  it('includes stable system instructions once per native history and reasserts after refresh', async () => {
    const { provider, requests } = await setup(); const id = await route(provider), complete = vi.fn(); provider.onComplete(complete);
    const base = normalizeProviderPayload('A');
    const input = { ...base, sessionSystemText: 'IDENTITY_TEST_334', context: { ...base.context, sessionSystemText: 'IDENTITY_TEST_334' } };
    await provider.send(id, input); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await provider.send(id, input); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    provider.refreshSessionSystemText(id); await provider.send(id, input);
    // send resolves at native write, before the peer necessarily logs receipt.
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(3));
    const text = (await requests()).filter(x => x.method === 'session/prompt').map(x => x.params.prompt[0].text);
    expect(text.map(x => x.includes('IDENTITY_TEST_334'))).toEqual([true, false, true]);
  });
  it.each(['env', 'home'])('probes and initializes the same CLI without binaryPath on sparse PATH (%s)', async source => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-path-'));
    const binary = path.join(root, source === 'home' ? '.local/bin/agy' : 'chosen-agy');
    await mkdir(path.dirname(binary), { recursive: true });
    const argvLog = path.join(root, 'argv.log'), rpcLog = path.join(root, 'rpc.jsonl');
    await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
    vi.stubEnv('HOME', root); vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv(AGY_CLI_PATH_ENV, source === 'env' ? binary : '');
    const config = { env: { HOME: root, PATH: '/usr/bin:/bin', AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: rpcLog } };
    const provider = await createAgyProvider(config) as AgyAcpProvider;
    resources.push({ provider, root });
    // Resolution is frozen at the version probe, not repeated against changed env.
    vi.stubEnv(AGY_CLI_PATH_ENV, path.join(root, 'not-the-probed-cli'));
    await provider.connect(config);
    expect(provider).toBeInstanceOf(AgyAcpProvider);
    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual(['--version', 'acp --process-per-session']);
    const rows = (await readFile(rpcLog, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    expect(rows.some(x => x.method === 'initialize')).toBe(true);
  });
  it('keeps the Windows shim entrypoint/prepend args, not just node.exe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-shim-'));
    const platform = process.platform;
    try {
      const scriptDir = path.join(root, 'node_modules', 'test-agy');
      await mkdir(scriptDir, { recursive: true });
      const script = path.join(scriptDir, 'cli.js'), shim = path.join(root, 'agy.cmd');
      await writeFile(script, '#!/usr/bin/env node\n');
      await writeFile(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\test-agy\\cli.js" %*\r\n');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const config = { binaryPath: shim }, provider = new AgyAcpProvider();
      const spawned = (provider as any).resolveAcpExecutable(config);
      expect(spawned).toEqual(resolveAgyBinary(config));
      expect(spawned.prependArgs).toEqual([script]);
      expect(spawned.executable).toBe(process.execPath);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses version-only selection, preserving unsupported CLI stream FIFO without retrying ACP errors', async () => {
    const { root, binary } = await setup();
    const old = await createAgyProvider({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_VERSION: '1.4.12' } }); expect(old).toBeInstanceOf(AgySdkProvider);
    const current = await createAgyProvider({ binaryPath: binary, env: { HOME: root } }); expect(current).toBeInstanceOf(AgyAcpProvider);
    expect(supportsAgyAcp('unrecognized')).toBe(false); expect(supportsAgyAcp('1.5.0')).toBe(true);
  });
});
