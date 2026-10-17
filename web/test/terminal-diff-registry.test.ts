import { describe, expect, it, vi } from 'vitest';
import { TerminalDiffRegistry } from '../src/terminal-diff-registry.js';
import type { TerminalDiff } from '../src/types.js';

const diff = (marker: string): TerminalDiff => ({ rows: 1, lines: [[0, marker]], fullFrame: true } as TerminalDiff);

describe('TerminalDiffRegistry', () => {
  it('delivers a session\'s frames to EVERY registered view, and only to that session', () => {
    const registry = new TerminalDiffRegistry();
    const preview = vi.fn();
    const window = vi.fn();
    const other = vi.fn();
    registry.register('s1', preview);
    registry.register('s1', window);
    registry.register('s2', other);
    registry.dispatch('s1', diff('x'));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(window).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('a view that leaves takes only its own registration with it (the survivor keeps receiving)', () => {
    const registry = new TerminalDiffRegistry();
    const preview = vi.fn();
    const window = vi.fn();
    registry.register('s1', preview);
    const closeWindow = registry.register('s1', window);
    closeWindow();
    registry.dispatch('s1', diff('after-close'));
    expect(window).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(registry.size('s1')).toBe(1);
  });

  it('re-registering (a parent re-render) replaces nothing: unregister then register leaves one entry', () => {
    const registry = new TerminalDiffRegistry();
    const handler = vi.fn();
    const unregister = registry.register('s1', handler);
    unregister();
    registry.register('s1', handler);
    expect(registry.size('s1')).toBe(1);
  });

  it('one view throwing does not starve its twin, and unregistering twice is harmless', () => {
    const registry = new TerminalDiffRegistry();
    const broken = vi.fn(() => { throw new Error('view blew up'); });
    const healthy = vi.fn();
    const unregisterBroken = registry.register('s1', broken);
    registry.register('s1', healthy);
    expect(() => registry.dispatch('s1', diff('x'))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    unregisterBroken();
    expect(() => unregisterBroken()).not.toThrow();
  });

  it('a handler that unregisters itself while handling does not corrupt the dispatch', () => {
    const registry = new TerminalDiffRegistry();
    const second = vi.fn();
    let unregisterFirst = () => {};
    unregisterFirst = registry.register('s1', () => { unregisterFirst(); });
    registry.register('s1', second);
    registry.dispatch('s1', diff('x'));
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size('s1')).toBe(1);
  });

  it('dispatching to a session nobody watches is a no-op', () => {
    expect(() => new TerminalDiffRegistry().dispatch('nobody', diff('x'))).not.toThrow();
  });
});
