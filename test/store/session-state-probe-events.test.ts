import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importFreshProbeEvents() {
  vi.resetModules();
  return import('../../src/store/session-state-probe-events.js');
}

describe('session-state probe event bridge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delivers one correction with its exact session and state', async () => {
    const bridge = await importFreshProbeEvents();
    const observer = vi.fn();
    const unregister = bridge.registerSessionStateProbeObserver(observer);

    bridge.emitSessionStateProbeCorrection('deck_probe_brain', 'idle');

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith('deck_probe_brain', 'idle');
    unregister();
  });

  it('restores the previous observer when an override unregisters', async () => {
    const bridge = await importFreshProbeEvents();
    const previous = vi.fn();
    const next = vi.fn();
    const unregisterPrevious = bridge.registerSessionStateProbeObserver(previous);
    const unregisterNext = bridge.registerSessionStateProbeObserver(next);

    bridge.emitSessionStateProbeCorrection('deck_probe_brain', 'running');
    unregisterNext();
    bridge.emitSessionStateProbeCorrection('deck_probe_brain', 'idle');

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith('deck_probe_brain', 'running');
    expect(previous).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledWith('deck_probe_brain', 'idle');
    unregisterPrevious();
  });

  it('does nothing safely when no observer is registered', async () => {
    const bridge = await importFreshProbeEvents();
    expect(() => bridge.emitSessionStateProbeCorrection('deck_probe_brain', 'idle')).not.toThrow();
  });

  it('contains a throwing observer', async () => {
    const bridge = await importFreshProbeEvents();
    const unregister = bridge.registerSessionStateProbeObserver(() => {
      throw new Error('observer failed');
    });

    expect(() => bridge.emitSessionStateProbeCorrection('deck_probe_brain', 'idle')).not.toThrow();
    unregister();
  });
});
