import { describe, expect, it, vi } from 'vitest';
import { injectPeerAuditBriefIntoProcessSession } from '../../src/daemon/peer-audit-process-injector.js';
import type { PeerAuditProcessInjectorDeps } from '../../src/daemon/peer-audit-process-injector.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const INSTANCE = 'instance_audit123';
const EPOCH = 'runtime_audit123';
const SESSION = 'deck_sub_audit123';

function record(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: SESSION,
    sessionInstanceId: INSTANCE,
    runtimeEpoch: EPOCH,
    projectName: 'p',
    projectDir: '/repo',
    role: 'w1',
    parentSession: 'deck_p_brain',
    agentType: 'codex',
    runtimeType: 'process',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function harness(overrides: Partial<PeerAuditProcessInjectorDeps> = {}) {
  const writePrivateText = vi.fn(() => {});
  const deps: Partial<PeerAuditProcessInjectorDeps> = {
    getSession: () => record(),
    withProcessSendLock: async (_name, fn) => fn(),
    preparePrivateWriter: async () => writePrivateText,
    ...overrides,
  };
  return { deps, writePrivateText };
}

function invoke(deps: Partial<PeerAuditProcessInjectorDeps>, isEffectCurrent?: () => boolean) {
  return injectPeerAuditBriefIntoProcessSession({
    targetSessionName: SESSION,
    expectedSessionInstanceId: INSTANCE,
    expectedRuntimeEpoch: EPOCH,
    brief: 'peer audit brief with capability',
    ...(isEffectCurrent ? { isEffectCurrent } : {}),
  }, deps);
}

describe('peer-audit process-private injector', () => {
  it('injects the verbatim brief with the live agent type under the send lock', async () => {
    let heldDuringInject = false;
    let held = false;
    const { deps, writePrivateText } = harness({
      withProcessSendLock: async (_name, fn) => {
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      },
    });
    const preparedWriter = vi.fn(() => { heldDuringInject = held; });
    deps.preparePrivateWriter = async () => preparedWriter;

    await expect(invoke(deps)).resolves.toEqual({ ok: true });
    expect(preparedWriter).toHaveBeenCalledWith('peer audit brief with capability');
    expect(heldDuringInject).toBe(true);
    expect(held).toBe(false);
    expect(writePrivateText).not.toHaveBeenCalled();
  });

  it('re-reads authoritative state inside the lock, so a busy flip while acquiring sends nothing', async () => {
    // The record is idle when the caller decides to dispatch, and only turns
    // busy while this attempt waits for the lock. A pre-lock snapshot would
    // have injected here.
    let state: SessionRecord['state'] = 'idle';
    const { deps, writePrivateText } = harness({
      getSession: () => record({ state }),
      withProcessSendLock: async (_name, fn) => {
        state = 'running';
        return fn();
      },
    });

    await expect(invoke(deps)).resolves.toEqual({ ok: false, error: 'target_runtime_busy_uncancellable' });
    expect(writePrivateText).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted target', undefined, 'target_ineligible'],
    ['delete/recreate under the same name', record({ sessionInstanceId: 'instance_other' }), 'target_ineligible'],
    ['runtime replacement', record({ runtimeEpoch: 'runtime_other' }), 'target_ineligible'],
    ['runtime kind flip to transport', record({ runtimeType: 'transport' }), 'target_ineligible'],
    ['missing identity', record({ sessionInstanceId: undefined }), 'target_ineligible'],
    ['busy runtime', record({ state: 'running' }), 'target_runtime_busy_uncancellable'],
  ] as const)('sends nothing on %s', async (_label, live, error) => {
    const { deps, writePrivateText } = harness({ getSession: () => live });

    await expect(invoke(deps)).resolves.toEqual({ ok: false, error });
    expect(writePrivateText).not.toHaveBeenCalled();
  });

  it('treats a cancelled or superseded effect as the last gate before the write', async () => {
    const { deps, writePrivateText } = harness();

    await expect(invoke(deps, () => false)).resolves.toEqual({ ok: false, error: 'attempt_not_found' });
    expect(writePrivateText).not.toHaveBeenCalled();
  });

  it('checks effect currency after identity and idle, immediately before injecting', async () => {
    const order: string[] = [];
    const { deps } = harness({
      getSession: () => {
        order.push('read_state');
        return record();
      },
      preparePrivateWriter: async () => (text: string) => { void text; order.push('inject'); },
    });

    await expect(invoke(deps, () => {
      order.push('effect_check');
      return true;
    })).resolves.toEqual({ ok: true });
    expect(order).toEqual(['read_state', 'effect_check', 'inject']);
  });

  it('defaults to injecting when the caller supplies no effect barrier', async () => {
    const { deps, writePrivateText } = harness();

    await expect(invoke(deps)).resolves.toEqual({ ok: true });
    expect(writePrivateText).toHaveBeenCalledTimes(1);
  });

  it('finishes asynchronous backend preparation before the final authority check', async () => {
    const order: string[] = [];
    const { deps } = harness({
      preparePrivateWriter: async () => {
        order.push('prepare');
        await Promise.resolve();
        order.push('prepared');
        return () => { order.push('write'); };
      },
      getSession: () => { order.push('read_state'); return record(); },
    });

    await expect(invoke(deps, () => { order.push('effect_check'); return true; })).resolves.toEqual({ ok: true });
    expect(order).toEqual(['prepare', 'prepared', 'read_state', 'effect_check', 'write']);
  });
});
