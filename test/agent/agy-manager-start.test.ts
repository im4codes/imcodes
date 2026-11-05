import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AgySdkProvider } from '../../src/agent/providers/agy-sdk.js';
import * as store from '../../src/store/session-store.js';
import { getTransportRuntime, launchTransportSession, stopTransportRuntimeSession } from '../../src/agent/session-manager.js';
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
let provider: AgySdkProvider;
let home: string;
const names = ['deck_realproj_ag_brain', 'deck_sub_ag_start_fixture'];
beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'imcodes-ag-manager-'));
  mkdirSync(path.join(home, '.imcodes'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('IMCODES_HOME', path.join(home, '.imcodes'));
  resetTransportQueueStoreForTests(); store.resetSessionStoreAuthorityForTests(); await store.loadStore({ probe: false });
  const bin = writeAgyNativeChildFixture(home);
  provider = new AgySdkProvider(); await provider.connect({ binaryPath: bin });
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
    await vi.waitFor(() => expect(readFileSync(path.join(home, 'inputs'), 'utf8').trim()).not.toBe(''), { timeout: 3000 });
    expect(store.getSession(name)?.providerSessionId).toBe(before.providerSessionId);
    expect(store.getSession(name)?.runtimeEpoch).toBe(before.runtimeEpoch);
  });

  it('keeps the learned owned native ID and queued work across repeated old projections', async () => {
    const name = names[1];
    await launchTransportSession({ name, projectName: 'realproj', role: 'w1', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, fresh: true, identityPrompt: 'fixture' });
    const runtime = getTransportRuntime(name)!;
    runtime.send('before reconnect', 'ag-before');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(store.getSession(name)?.providerResumeId).toBeTruthy());
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
    await vi.waitFor(() => expect(runtime.lastProviderError?.message).toBe('AG start owner changed'));
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
    await expect(launchTransportSession({ name, projectName: 'realproj', role: 'brain', agentType: AGY_SDK_PROVIDER_ID, projectDir: home, identityPrompt: 'fixture' })).rejects.toThrow('trusted resume id');
    expect(readFileSync(path.join(home, 'launches'), 'utf8')).toBe('');
  });

});
