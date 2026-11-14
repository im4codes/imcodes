import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { switchSessionModelNow, restartSessionNow, handoffSessionConversation } from '../../src/daemon/command-handler.js';
import { PROVIDER_ERROR_CODES } from '../../shared/provider-error-codes.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { AgyAcpProvider } from '../../src/agent/providers/agy-acp.js';
import { AGY_ACP_AGENT_NAME } from '../../shared/agy-agent.js';
import { AgySdkProvider } from '../../src/agent/providers/agy-sdk.js';
import * as store from '../../src/store/session-store.js';
import { getTransportRuntime, launchTransportSession, stopTransportRuntimeSession, relaunchSessionWithSettings } from '../../src/agent/session-manager.js';
import { rebuildSubSessions } from '../../src/daemon/subsession-manager.js';
import { AGY_NATIVE_START_NOT_ATTEMPTED, AGY_NATIVE_SESSION_STATE, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { writeAgyNativeChildFixture } from '../helpers/agy-native-child.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

vi.mock('../../src/agent/provider-registry.js', () => ({
  ensureProviderConnected: async () => provider, getProvider: () => provider,
}));
vi.mock('../../src/agent/runtime-context-bootstrap.js', () => ({
  resolveTransportContextBootstrap: async () => ({ namespace: undefined, diagnostics: [] }),
  buildTransportStartupMemory: async () => undefined,
}));
vi.mock('../../src/daemon/session-resource-service.js', () => ({
  registerTmuxSessionResource: async () => undefined,
  releaseSessionChildResources: async () => ({ released: 0, failed: 0 }),
  releaseSessionResources: async () => ({ released: 0, failed: 0 }),
  initializeSessionResourceLifecycle: async () => ({ released: 0, preserved: 0, failed: 0 }),
  resourceOwnerEnv: () => ({}),
}));
let provider: AgySdkProvider | AgyAcpProvider;
let home: string;
const names = ['deck_realproj_ag_brain', 'deck_sub_ag_start_fixture'];
beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'imcodes-ag-manager-'));
  mkdirSync(path.join(home, '.imcodes'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('IMCODES_HOME', path.join(home, '.imcodes'));
  resetTransportQueueStoreForTests(); store.resetSessionStoreAuthorityForTests(); await store.loadStore({ probe: false });
  const bin = writeAgyNativeChildFixture(home, { controlledTurns: true });
  provider = new AgySdkProvider(); await provider.connect({ binaryPath: bin });
  vi.spyOn(provider, 'listModels').mockResolvedValue({ models: [] });
});
afterEach(async () => {
  for (const name of names) await stopTransportRuntimeSession(name).catch(() => {});
  await provider?.disconnect(); vi.restoreAllMocks(); await store.flushStore().catch(() => {}); await store.waitForSessionStoreSnapshotForTests();
  resetTransportQueueStoreForTests(); store.resetSessionStoreAuthorityForTests(); vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
describe('AG manager start ownership (real runtime, SQLite and SDK child)', () => {
  it.each(names)('first send for %s', async name => {
    await launchTransportSession({ name, projectName: 'realproj', role: name === names[0] ? 'brain' : 'w1',
      agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!;
    expect(runtime.recipientIdentity).toEqual({ sessionInstanceId: store.getSession(name)!.sessionInstanceId, runtimeEpoch: store.getSession(name)!.runtimeEpoch });
    runtime.send('fixture first', 'ag-first');
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim()).not.toBe(''), { timeout: 5000 });
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'launches'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('keeps a live AG start owner when a server rebuild replays an older route', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!;
    const before = { ...store.getSession(name)! };
    await rebuildSubSessions([{ id: name.slice('deck_sub_'.length), type: AGY_SDK_PROVIDER_ID, cwd: home,
      providerSessionId: 'stale-server-projection-route', providerResumeId: 'foreign-projected-native', providerId: AGY_SDK_PROVIDER_ID, state: 'idle' }]);
    expect(store.getSession(name)?.providerResumeId).toBeUndefined();
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    runtime.send('first after reconnect', 'ag-reconnect-first');
    await new Promise(resolve => setTimeout(resolve, 400));
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim()).not.toBe(''), { timeout: 5000 });
    expect(store.getSession(name)?.providerSessionId).toBe(before.providerSessionId);
    expect(store.getSession(name)?.runtimeEpoch).toBe(before.runtimeEpoch);
  });

  it('keeps the learned owned native ID and queued work across repeated old projections', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!;
    runtime.send('before reconnect', 'ag-before');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(store.getSession(name)?.providerResumeId).toBeTruthy(), { timeout: 5000 });
    const before = { ...store.getSession(name)! };
    const sends = vi.spyOn(provider, 'send');
    for (let i=0;i<5;i++) {
      await rebuildSubSessions([{ id: name.slice('deck_sub_'.length), type: AGY_SDK_PROVIDER_ID, cwd: home,
        providerSessionId: 'older-server-route', providerResumeId: 'foreign-server-native', label: 'updated label', requestedModel: 'fixture-model' }]);
      runtime.rehydratePendingFromStore(); runtime.drainPendingIfIdle();
    }
    expect(sends).not.toHaveBeenCalled();
    expect(store.getSession(name)).toMatchObject({ providerResumeId: before.providerResumeId,
      providerSessionId: before.providerSessionId, runtimeEpoch: before.runtimeEpoch, label: 'updated label', requestedModel: 'fixture-model' });
    runtime.send('after reconnect', 'ag-after');
    await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'launches'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(2);
    for (const id of ['ag-before', 'ag-after']) expect(getTransportQueueStore().hasDeliveryTombstone(name, id)).toBe(true);
  });

  it.each(['epoch', 'route', 'delete', 'recreate', 'stop'] as const)('refuses old native spawn/info after real %s replacement', async action => {
    const name = names[1]; const create = vi.spyOn(provider, 'createSession');
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!; const old = { ...store.getSession(name)! };
    const barrier = create.mock.calls[0][0].beforeNativeSessionStart!;
    if (action === 'stop') await stopTransportRuntimeSession(name, { preserveTransportQueue: true });
    else if (action === 'delete') store.removeSession(name);
    else if (action === 'recreate') { store.removeSession(name); store.upsertSession(old); }
    else store.upsertSession({ ...old, ...(action === 'epoch' ? { runtimeEpoch: 'replacement-epoch' } : { providerSessionId: 'replacement-route' }) });
    if (action === 'epoch' || action === 'recreate') await rebuildSubSessions([{ id: name.slice('deck_sub_'.length), type: AGY_SDK_PROVIDER_ID, cwd: home, providerSessionId: old.providerSessionId }]);
    const replacement = store.getSession(name);
    await expect(barrier()).rejects.toMatchObject({ recoverable: false, details: { [AGY_NATIVE_START_NOT_ATTEMPTED]: true } });
    (provider as any).emitSessionInfo(runtime.providerSessionId, { resumeId: 'late-old-native' });
    expect(store.getSession(name)).toEqual(replacement);
    expect(readFileSync(path.join(home, 'launches'), 'utf8')).toBe('');
    expect(readFileSync(path.join(home, 'inputs'), 'utf8')).toBe('');
  });

  it('transfers a no-start rejected queued message to the valid successor once, without replay', async () => {
    const name = names[1];
    const options = { name, projectName: 'realproj', role: 'w1' as const, agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' };
    await launchTransportSession({ ...options, fresh: true });
    const runtime = getTransportRuntime(name)!;
    getTransportQueueStore().enqueue({ sessionName: name, recipient: runtime.recipientIdentity, text: 'preserved before native start', clientMessageId: 'ag-preserved' });
    store.upsertSession({ ...store.getSession(name)!, runtimeEpoch: 'legitimate-next-owner' });
    expect(runtime.rehydratePendingFromStore()).toBe(1);
    runtime.drainPendingIfIdle();
    await vi.waitFor(() => expect(runtime.lastProviderError?.message).toBe('AG start owner changed'), { timeout: 5000 });
    await stopTransportRuntimeSession(name, { preserveTransportQueue: true });
    expect(readFileSync(path.join(home, 'inputs'), 'utf8')).toBe('');
    await launchTransportSession(options);
    const successor = getTransportRuntime(name)!;
    await vi.waitFor(() => expect(getTransportQueueStore().hasDeliveryTombstone(name, 'ag-preserved')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(successor.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(1);
    for(let i=0;i<5;i++){ successor.rehydratePendingFromStore(); successor.drainPendingIfIdle(); }
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
  });

  it('keeps concurrent new main/sub first sends isolated and single-started', async () => {
    await Promise.all(names.map(name => launchTransportSession({ name, projectName: 'realproj', role: name === names[0] ? 'brain' : 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' })));
    for (const name of names) getTransportRuntime(name)!.send('isolated ' + name, name + '-first');
    await vi.waitFor(() => { for(const name of names) expect(getTransportQueueStore().hasDeliveryTombstone(name, name + '-first')).toBe(true); }, { timeout: 5000 });
    for (const name of names) await vi.waitFor(() => expect(getTransportRuntime(name)!.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'launches'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(store.getSession(names[0])?.providerResumeId).not.toBe(store.getSession(names[1])?.providerResumeId);
  });

  it.each(['codex-sdk', 'claude-code'])('keeps a live AG owner across older %s projections, while explicit relaunch still works', async oldType => {
    const name = names[1]; const options = { name, projectName: 'realproj', role: 'w1' as const, agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' };
    await launchTransportSession({ ...options, fresh: true });
    const before = { ...store.getSession(name)! };
    await rebuildSubSessions([{ id: name.slice('deck_sub_'.length), type: oldType, providerId: oldType, cwd: home, providerSessionId: 'prior-provider-route', providerResumeId: 'foreign-native' }]);
    expect(store.getSession(name)).toMatchObject({ agentType: AGY_SDK_PROVIDER_ID, providerId: AGY_SDK_PROVIDER_ID, runtimeEpoch: before.runtimeEpoch, providerSessionId: before.providerSessionId });
    const first = getTransportRuntime(name)!;
    first.send('first native turn', 'owned-first');
    await vi.waitFor(() => expect(getTransportQueueStore().hasDeliveryTombstone(name, 'owned-first')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(first.sending).toBe(false), { timeout: 5000 });
    const native = store.getSession(name)!.providerResumeId!;
    await stopTransportRuntimeSession(name, { preserveTransportQueue: true });
    await launchTransportSession(options);
    getTransportRuntime(name)!.send('second native turn', 'owned-second');
    await vi.waitFor(() => expect(getTransportQueueStore().hasDeliveryTombstone(name, 'owned-second')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(getTransportRuntime(name)!.sending).toBe(false), { timeout: 5000 });
    const launches = readFileSync(path.join(home, 'launches'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(launches).toEqual([{ id: native, resumed: false }, { id: native, resumed: true }]);
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('never turns legacy unknown without a native ID into an implicit fresh launch', async () => {
    const name = names[0];
    store.upsertSession({ name, projectName: 'realproj', role: 'brain', agentType: AGY_SDK_PROVIDER_ID, providerId: AGY_SDK_PROVIDER_ID, projectDir: home, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 });
    const legacy = store.getSession(name)!;
    getTransportQueueStore().enqueue({ sessionName: name, recipient: { sessionInstanceId: legacy.sessionInstanceId!, runtimeEpoch: legacy.runtimeEpoch! }, text: 'keep legacy pending', clientMessageId: 'legacy-pending' });
    await expect(launchTransportSession({ name, projectName: 'realproj', role: 'brain', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' })).rejects.toThrow('trusted resume id');
    expect(getTransportQueueStore().hasDurableQueueAdmission(name, 'legacy-pending')).toBe(true);
    expect(readFileSync(path.join(home, 'launches'), 'utf8')).toBe('');
  });

  it.each(names)('keeps %s pre-native model choice through disk and one first spawn', async name => {
    const options = { name, projectName: 'realproj', role: name === names[0] ? 'brain' as const : 'w1' as const,
      agentType: AGY_SDK_PROVIDER_ID, projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture' };
    await launchTransportSession({ ...options, fresh: true });
    await expect(switchSessionModelNow(name, 'fixture-B')).resolves.toMatchObject({ ok: true, model: 'fixture-B' });
    await store.flushStore({ requireWrite: true });
    await stopTransportRuntimeSession(name);
    await store.loadStore({ probe: false });
    expect(store.getSession(name)?.requestedModel).toBe('fixture-B');
    await launchTransportSession({ ...options, requestedModel: undefined });
    const runtime = getTransportRuntime(name)!;
    runtime.send('after model choice', 'model-first');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim().split('\n').map(s => JSON.parse(s))).toEqual(['fixture-B']);
  });

  it('uses the selected model on the next native process after a busy turn finishes', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true });
    const runtime = getTransportRuntime(name)!;
    runtime.send('fixture-hold', 'model-hold');
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8')).toContain('fixture-hold'), { timeout: 5000 });
    await vi.waitFor(() => expect(store.getSession(name)?.providerResumeId).toBeTruthy(), { timeout: 5000 });
    const native = store.getSession(name)!.providerResumeId;
    const completedModels: unknown[] = [];
    const off = provider.onComplete((_sid, message) => completedModels.push(message.metadata?.model));
    const result = await switchSessionModelNow(name, 'fixture-B');
    expect(store.getSession(name)).toMatchObject({ requestedModel: 'fixture-B', activeModel: 'fixture-A' });
    writeFileSync(path.join(home, 'release'), 'go');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    runtime.send('next model turn', 'model-next');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim().split('\n').map(s => JSON.parse(s))).toEqual(['fixture-A', 'fixture-B']);
    expect(store.getSession(name)?.providerResumeId).toBe(native);
    expect(result).toMatchObject({ ok: true, applied: SESSION_MODEL_APPLIED.NEXT_START });
    expect(completedModels).toEqual(['fixture-A', 'fixture-B']);
    off();
  });

  it('does not restore a stale owner after asynchronous model validation', async () => {
    const name = names[1];
    const options = { name, projectName: 'realproj', role: 'w1' as const, agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true };
    await launchTransportSession(options);
    let release!: (value: { models: [] }) => void;
    const validation = vi.spyOn(provider, 'listModels').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const switching = switchSessionModelNow(name, 'fixture-B');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 5000 });
    await stopTransportRuntimeSession(name);
    await launchTransportSession({ ...options, requestedModel: 'fixture-C' });
    const next = { ...store.getSession(name)! };
    release({ models: [] });
    const switched = await switching;
    expect.soft(store.getSession(name)).toEqual(next);
    expect.soft(switched).toMatchObject({ ok: false });
    validation.mockRestore();
    const runtime = getTransportRuntime(name)!;
    runtime.send('valid new owner', 'model-valid');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect.soft(runtime.lastProviderError?.message).not.toBe('AG start owner changed');
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim()).toBe(JSON.stringify('fixture-C'));
  });

  it.each(names)('keeps owned native context across idle A-B-A and reload for %s', async name => {
    const options = { name, projectName: 'realproj', role: name === names[0] ? 'brain' as const : 'w1' as const,
      agentType: AGY_SDK_PROVIDER_ID, projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture' };
    await launchTransportSession({ ...options, fresh: true });
    const runtime = getTransportRuntime(name)!;
    runtime.send('first model', 'aba-first');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(store.getSession(name)?.providerResumeId).toBeTruthy(), { timeout: 5000 });
    const native = store.getSession(name)!.providerResumeId;
    for (const [model, id] of [['fixture-B', 'aba-second'], ['fixture-A', 'aba-third']]) {
      await expect(switchSessionModelNow(name, model)).resolves.toMatchObject({ ok: true, applied: SESSION_MODEL_APPLIED.NEXT_START });
      runtime.send('turn on ' + model, id);
      await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
      expect(store.getSession(name)?.activeModel).toBe(model);
    }
    await store.flushStore({ requireWrite: true });
    await stopTransportRuntimeSession(name);
    await store.loadStore({ probe: false });
    expect(store.getSession(name)).toMatchObject({ providerResumeId: native, requestedModel: 'fixture-A', activeModel: 'fixture-A' });
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim().split('\n').map(s => JSON.parse(s))).toEqual(['fixture-A', 'fixture-B', 'fixture-A']);
    const launches = readFileSync(path.join(home, 'launches'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(launches).toEqual([{ id: native, resumed: false }, { id: native, resumed: true }, { id: native, resumed: true }]);
  });

  it('keeps a queued next turn on the saved model without replay', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true });
    const runtime = getTransportRuntime(name)!;
    runtime.send('fixture-hold', 'queued-old');
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8')).toContain('fixture-hold'), { timeout: 5000 });
    await switchSessionModelNow(name, 'fixture-B');
    expect(runtime.send('queued next model', 'queued-new')).toBe('queued');
    writeFileSync(path.join(home, 'release'), 'go');
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8')).toContain('queued next model'), { timeout: 5000 });
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    for (let i = 0; i < 3; i++) { runtime.rehydratePendingFromStore(); runtime.drainPendingIfIdle(); }
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim().split('\n').map(s => JSON.parse(s))).toEqual(['fixture-A', 'fixture-B']);
  });

  it('refuses a model operation queued behind an owner replacement, then accepts a fresh retry', async () => {
    const name = names[1];
    const options = { name, projectName: 'realproj', role: 'w1' as const, agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true };
    await launchTransportSession(options);
    let release!: (value: { models: [] }) => void;
    vi.spyOn(provider, 'listModels').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = switchSessionModelNow(name, 'fixture-B');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 5000 });
    const queued = switchSessionModelNow(name, 'fixture-D');
    await stopTransportRuntimeSession(name);
    await launchTransportSession({ ...options, requestedModel: 'fixture-C' });
    const next = { ...store.getSession(name)! };
    release({ models: [] });
    await expect(first).resolves.toMatchObject({ ok: false });
    await expect(queued).resolves.toMatchObject({ ok: false });
    expect(store.getSession(name)).toEqual(next);
    await expect(switchSessionModelNow(name, 'fixture-B')).resolves.toMatchObject({ ok: true });
    const runtime = getTransportRuntime(name)!;
    runtime.send('fresh retry', 'retry-new');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim()).toBe(JSON.stringify('fixture-B'));
  });

  it('refuses an already mismatched runtime and invalid whitespace without touching current authority', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true });
    store.upsertSession({ ...store.getSession(name)!, runtimeEpoch: 'next-model-owner' });
    const current = { ...store.getSession(name)! };
    await expect(switchSessionModelNow(name, 'fixture-B')).resolves.toMatchObject({ ok: false });
    await expect(switchSessionModelNow(name, 'invalid model')).resolves.toMatchObject({ ok: false });
    expect(store.getSession(name)).toEqual(current);
    expect(readFileSync(path.join(home, 'launches'), 'utf8')).toBe('');
  });

  it('keeps the pending selection and native ID after cancelling the active old-model turn', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID,
      projectDir: home, requestedModel: 'fixture-A', identityPrompt: 'fixture', fresh: true });
    const runtime = getTransportRuntime(name)!;
    runtime.send('fixture-hold', 'cancel-old');
    await vi.waitFor(() => expect(store.getSession(name)?.providerResumeId).toBeTruthy(), { timeout: 5000 });
    const native = store.getSession(name)!.providerResumeId;
    await switchSessionModelNow(name, 'fixture-B');
    await runtime.cancel({ waitForProvider: true });
    runtime.send('after cancel', 'cancel-new');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(store.getSession(name)).toMatchObject({ providerResumeId: native, requestedModel: 'fixture-B', activeModel: 'fixture-B' });
    expect(readFileSync(path.join(home, 'models'), 'utf8').trim().split('\n').map(s => JSON.parse(s))).toEqual(['fixture-A', 'fixture-B']);
    expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

// Real ACP SDK + runtime + SQLite; no account, credentials or network.
describe('AG provider-switch failure recovery', () => {
  async function acp(scenario = 'unsupported-carbon') {
    await provider.disconnect();
    const binary = path.join(home, 'agy-acp');
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
    provider = new AgyAcpProvider();
    await provider.connect({ binaryPath: binary, env: { HOME: home, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME,
      AGY_ACP_FIXTURE_LOG: path.join(home, 'rpc.jsonl'), AGY_ACP_FIXTURE_SCENARIO: scenario } });
  }
  const rows = () => readFileSync(path.join(home, 'rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  async function send(name: string, id: string) {
    const runtime = getTransportRuntime(name)!;
    runtime.send(id, id);
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(runtime.lastProviderError).toBeNull();
  }
  it.each(names)('does not inherit a foreign model/resume or Gemini auth when switching %s to AG', async name => {
    await acp();
    mkdirSync(path.join(home, '.gemini'));
    writeFileSync(path.join(home, '.gemini/oauth_creds.json'), JSON.stringify({ access_token: 'opaque-fixture-only' }));
    store.upsertSession({ name, projectName: 'realproj', role: name === names[0] ? 'brain' : 'w1',
      agentType: 'gemini-sdk', providerId: 'gemini-sdk', runtimeType: 'transport', providerSessionId: 'old-route',
      providerResumeId: 'foreign-native', requestedModel: 'gemini-4-carbon-medium', projectDir: home,
      state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 });
    await relaunchSessionWithSettings(store.getSession(name)!, { agentType: AGY_SDK_PROVIDER_ID, identityPrompt: 'fixture' });
    await send(name, 'after-switch');
    expect(store.getSession(name)?.providerResumeId).not.toBe('foreign-native');
    expect(rows().filter(row => row.method === 'session/resume')).toHaveLength(0);
    expect(rows().filter(row => row.method === 'session/set_model').some(row => row.params.modelId === 'gemini-4-carbon-medium')).toBe(false);
  });
  it('rejects an unsupported model, accepts a supported selection, resumes after disk reload and resets explicitly', async () => {
    await acp(); const name = names[0];
    const options = { name, projectName: 'realproj', role: 'brain' as const, agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' };
    await launchTransportSession({ ...options, fresh: true, requestedModel: 'gemini-4-carbon-medium' });
    const runtime = getTransportRuntime(name)!; runtime.send('rejected', 'unsupported');
    await vi.waitFor(() => expect(runtime.lastProviderError).toBeTruthy(), { timeout: 5000 });
    const native = store.getSession(name)!.providerResumeId;
    expect(native).toBeTruthy();
    expect(rows().some(row => row.method === 'session/prompt')).toBe(false);
    expect(runtime.lastProviderError?.message).toMatch(/model.*unavailable/i);
    await expect(switchSessionModelNow(name, 'model-b')).resolves.toMatchObject({ ok: true });
    await send(name, 'supported');
    await store.flushStore({ requireWrite: true });
    await stopTransportRuntimeSession(name); await store.loadStore({ probe: false });
    await restartSessionNow(name, { reset: false }); await send(name, 'resumed');
    expect(rows().filter(row => row.method === 'session/resume').at(-1).params.sessionId).toBe(native);
    await Promise.all([restartSessionNow(name, { reset: false }), restartSessionNow(name, { reset: true })]);
    expect(store.getSession(name)?.providerResumeId).toBeUndefined();
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    await send(name, 'reset');
    expect(store.getSession(name)?.providerResumeId).not.toBe(native);
  });
  it.each(['new-error-once', 'new-crash-once'])('keeps uncertain native creation (%s) closed to implicit retry but makes explicit reset recoverable', async scenario => {
    await acp(scenario); const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!; runtime.send('first', 'creation-failed');
    await vi.waitFor(() => expect(runtime.lastProviderError).toBeTruthy(), { timeout: 5000 });
    expect(store.getSession(name)?.providerResumeId).toBeUndefined();
    const failedRoute = store.getSession(name)!.providerSessionId;
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
    expect(runtime.lastProviderError?.message).toContain('session_restart reset=true');
    // A second ordinary message cannot silently duplicate upstream creation.
    runtime.send('implicit retry', 'creation-retry');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(runtime.lastProviderError).toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(runtime.lastProviderError?.message).toContain('no trusted resume id or unused proof');
    expect(runtime.lastProviderError?.message).not.toContain('durable owner check failed');
    expect(rows().filter(row => row.method === 'session/new')).toHaveLength(1);
    await expect(restartSessionNow(name, { reset: false })).rejects.toThrow(/start over|reset=true/i);
    await restartSessionNow(name, { reset: true });
    expect(store.getSession(name)?.providerSessionId).not.toBe(failedRoute);
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    await send(name, 'after-reset');
    expect(store.getSession(name)?.providerResumeId).toBeTruthy();
    expect(rows().filter(row => row.method === 'session/new')).toHaveLength(2);
  });
  it('treats fresh as authoritative even if its caller carries a stale native handle', async () => {
    await acp(); const name = names[0];
    await launchTransportSession({ name, projectName: 'realproj', role: 'brain', agentType: AGY_SDK_PROVIDER_ID, projectDir: home,
      identityPrompt: 'fixture', fresh: true, providerResumeId: 'stale-conversation' });
    await send(name, 'fresh-with-stale-input');
    expect(rows().some(row => row.method === 'session/resume')).toBe(false);
    expect(rows().filter(row => row.method === 'session/new')).toHaveLength(1);
  });

  it('handoff resets AG native conversation, zeros usage, and injects concise handoff pack once on fresh turn', async () => {
    await acp();
    const name = names[0];
    await launchTransportSession({ name, projectName: 'realproj', role: 'brain', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture', fresh: true });
    await send(name, 'prior goal turn');
    const oldNativeId = store.getSession(name)?.providerResumeId;
    expect(oldNativeId).toBeTruthy();

    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([
      { eventId: 'u1', sessionId: name, ts: 10, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'HANDOFF_GOAL_ALPHA' } },
      { eventId: 'a1', sessionId: name, ts: 20, seq: 2, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'HANDOFF_REPLY_BETA', streaming: false } },
    ]);
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsub = timelineEmitter.on((ev) => {
      if (ev.sessionId === name) emitted.push({ type: ev.type, payload: ev.payload });
    });
    try {
      const started = performance.now();
      await handoffSessionConversation(store.getSession(name)!);
      const localHandoffMs = performance.now() - started;
      expect(localHandoffMs).toBeLessThan(2000);
    } finally {
      unsub();
    }

    expect(store.getSession(name)?.providerResumeId).toBeUndefined();
    expect(store.getSession(name)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    expect(emitted.some((e) => e.type === 'usage.update' && e.payload.inputTokens === 0 && e.payload.cacheTokens === 0)).toBe(true);

    // First turn after handoff starts a brand-new session/new (never session/resume) and receives the handoff pack once.
    await send(name, 'continue after handoff');
    expect(rows().some((row) => row.method === 'session/resume')).toBe(false);
    expect(rows().filter((row) => row.method === 'session/new')).toHaveLength(2);
    expect(store.getSession(name)?.providerResumeId).not.toBe(oldNativeId);
    const prompts = rows().filter((row) => row.method === 'session/prompt');
    const handoffPrompt = JSON.stringify(prompts.at(-1));
    expect(handoffPrompt).toContain('HANDOFF_GOAL_ALPHA');
    expect(handoffPrompt).toContain('HANDOFF_REPLY_BETA');

    // Second turn must NOT re-inject the one-shot handoff pack.
    await send(name, 'second turn clean');
    const secondPrompt = JSON.stringify(rows().filter((row) => row.method === 'session/prompt').at(-1));
    expect(secondPrompt).not.toContain('HANDOFF_GOAL_ALPHA');
  });
});
