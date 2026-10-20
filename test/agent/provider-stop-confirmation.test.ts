import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderStopConfirmation, confirmChildStop, onConfirmedProviderStop, confirmCapturedChildExit } from '../../src/agent/provider-stop-confirmation.js';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';
import { GeminiSdkProvider } from '../../src/agent/providers/gemini-sdk.js';
import { TRANSPORT_STOP_QUEUE_TIMEOUT_MS } from '../../shared/transport-queue-types.js';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('captured provider Stop confirmation', () => {
  afterEach(() => vi.useRealTimers());

  it.each([true, false])('accepts captured terminal before/after request settlement (%s), never unrelated target', async (early) => {
    const confirmation = new ProviderStopConfirmation();
    const target = {};
    let settle!: () => void;
    const request = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const stopping = confirmation.confirm(target, request, () => true);
    expect(confirmation.confirm(target, request, () => true)).toBe(stopping);
    await flush();
    confirmation.complete({});
    let done = false;
    void stopping.then(() => { done = true; });
    if (early) confirmation.complete(target);
    settle();
    if (early) await stopping;
    else {
      await flush();
      expect(done).toBe(false);
      confirmation.complete(target);
      await stopping;
    }
    expect(request).toHaveBeenCalledOnce();
  });

  it('times out without terminal, disposes its waiter/timer, and allows a fresh confirmation', async () => {
    vi.useFakeTimers();
    const confirmation = new ProviderStopConfirmation();
    const target = {};
    const stopping = confirmation.confirm(target, async () => {}, () => true);
    const failed = expect(stopping).rejects.toThrow('terminal confirmation timed out');
    await vi.advanceTimersByTimeAsync(TRANSPORT_STOP_QUEUE_TIMEOUT_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    const retry = confirmation.confirm(target, async () => {}, () => true);
    confirmation.complete(target);
    await retry;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept terminal for a replaced instance and cleans up request failure', async () => {
    const confirmation = new ProviderStopConfirmation();
    const target = {};
    const stopping = confirmation.confirm(target, async () => {}, () => false);
    confirmation.complete(target);
    await expect(stopping).rejects.toThrow('instance changed');
    await expect(confirmation.confirm(target, async () => { throw new Error('cancel failed'); }, () => true)).rejects.toThrow('cancel failed');
    const retry = confirmation.confirm(target, async () => {}, () => true);
    confirmation.complete(target);
    await retry;
  });

  it('does not accept kill receipt as physical child exit and removes listeners after failure', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as ChildProcess;
    const stopping = confirmChildStop(child, async () => {}, () => true);
    const failed = expect(stopping).rejects.toThrow('terminal confirmation timed out');
    await vi.advanceTimersByTimeAsync(TRANSPORT_STOP_QUEUE_TIMEOUT_MS);
    await failed;
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    const retry = confirmChildStop(child, async () => {}, () => true);
    child.emit('exit', 0, null);
    await retry;
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('preserves late physical child proof after timeout without retaining temporary listeners', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as ChildProcess;
    const stopping = confirmChildStop(child, async () => {}, () => true);
    const failed = expect(stopping).rejects.toThrow('terminal confirmation timed out');
    await vi.advanceTimersByTimeAsync(TRANSPORT_STOP_QUEUE_TIMEOUT_MS);
    await failed;
    const observed = vi.fn();
    onConfirmedProviderStop(stopping, observed);
    expect(child.listenerCount('exit')).toBe(0);
    confirmCapturedChildExit(Object.assign(new EventEmitter(), {}) as unknown as ChildProcess);
    expect(observed).not.toHaveBeenCalled();
    confirmCapturedChildExit(child);
    confirmCapturedChildExit(child);
    expect(observed).toHaveBeenCalledOnce();
  });

  it('isolates observers and rejects late proof from a replaced captured target', async () => {
    const confirmation = new ProviderStopConfirmation();
    const target = {};
    let current = true;
    const stopping = confirmation.confirm(target, async () => { throw new Error('request failed'); }, () => current);
    await expect(stopping).rejects.toThrow('request failed');
    const observed = vi.fn();
    onConfirmedProviderStop(stopping, () => { throw new Error('observer failed'); });
    onConfirmedProviderStop(stopping, observed);
    current = false;
    confirmation.complete(target);
    expect(observed).not.toHaveBeenCalled();
    current = true;
    expect(() => confirmation.complete(target)).not.toThrow();
    expect(observed).toHaveBeenCalledOnce();
  });

  it.each([KimiSdkProvider, GeminiSdkProvider])('%s uses its original ACP prompt terminal, not cancel notification receipt', async (Provider) => {
    const provider = new Provider();
    let finish!: (response: { stopReason: 'cancelled' }) => void;
    const connection = {
      newSession: vi.fn(async () => ({ sessionId: 'acp-stop-proof' })),
      prompt: vi.fn(() => new Promise<{ stopReason: 'cancelled' }>((resolve) => { finish = resolve; })),
      cancel: vi.fn(async () => {}),
      connection: { writeQueue: Promise.resolve() },
    };
    // Reuse the ACP protocol boundary without spawning a real CLI or touching
    // its default account; createSession/send still execute the adapter code.
    Object.assign(provider, { config: {}, connection, initPromise: Promise.resolve() });
    const route = await provider.createSession({ sessionKey: 'deck_test_acp_stop', cwd: process.cwd() });
    await provider.send(route, 'foreground');
    await flush();
    expect(connection.prompt).toHaveBeenCalledOnce();
    let settled = false;
    const stopping = provider.cancelAndWait(route).then(() => { settled = true; });
    await flush();
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'acp-stop-proof' });
    expect(settled).toBe(false);
    finish({ stopReason: 'cancelled' });
    await stopping;
    expect(settled).toBe(true);
  });
});
