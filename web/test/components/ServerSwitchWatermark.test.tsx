/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { h } from 'preact';
import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_SWITCH_WATERMARK_EXIT_MS,
  SERVER_SWITCH_WATERMARK_HOLD_MS,
  ServerSwitchWatermark,
} from '../../src/components/ServerSwitchWatermark.js';

describe('ServerSwitchWatermark', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing when visible is false', () => {
    render(
      <ServerSwitchWatermark
        visible={false}
        triggerKey={1}
        serverName="prod-eu"
        sessionName="deck_api_brain"
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('server-switch-watermark')).toBeNull();
  });

  it('renders non-interactive aria-hidden HUD with server name, session name, and triggered shortcut keycaps', () => {
    render(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="prod-eu"
        sessionName="deck_api_brain"
        fallbackLabel="Loading…"
        shortcutKeycaps={['Ctrl', '↓']}
        onDismiss={vi.fn()}
      />,
    );

    const hud = screen.getByTestId('server-switch-watermark');
    expect(hud.getAttribute('aria-hidden')).toBe('true');
    expect(hud.getAttribute('data-state')).toBe('visible');
    expect(hud.className).toContain('server-switch-watermark');
    expect(hud.className).not.toContain('is-exiting');

    expect(screen.getByTestId('server-switch-watermark-server').textContent).toBe('prod-eu');
    const sessionEl = screen.getByTestId('server-switch-watermark-session');
    expect(sessionEl.textContent).toBe('deck_api_brain');
    expect(sessionEl.parentElement?.className).not.toContain('is-muted');

    const shortcutRow = screen.getByTestId('server-switch-watermark-shortcut');
    const kbds = Array.from(shortcutRow.querySelectorAll('kbd')).map((el) => el.textContent);
    expect(kbds).toEqual(['Ctrl', '↓']);
  });

  it('renders muted fallback when sessionName is null, and omits session/shortcut rows when empty', () => {
    const { rerender } = render(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="prod-eu"
        sessionName={null}
        fallbackLabel="Loading…"
        onDismiss={vi.fn()}
      />,
    );

    const fallbackEl = screen.getByTestId('server-switch-watermark-session');
    expect(fallbackEl.textContent).toBe('Loading…');
    expect(fallbackEl.parentElement?.className).toContain('is-muted');
    expect(screen.queryByTestId('server-switch-watermark-shortcut')).toBeNull();

    rerender(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="prod-eu"
        sessionName={null}
        fallbackLabel={null}
        shortcutKeycaps={['⌘', '↑']}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('server-switch-watermark-server').textContent).toBe('prod-eu');
    expect(screen.queryByTestId('server-switch-watermark-session')).toBeNull();
    expect(
      Array.from(screen.getByTestId('server-switch-watermark-shortcut').querySelectorAll('kbd')).map((el) => el.textContent),
    ).toEqual(['⌘', '↑']);
  });

  it('holds for holdMs, fades for exitMs, invokes onDismiss, and updates sessionName dynamically without resetting timer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    const { rerender } = render(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="Server Two"
        sessionName={null}
        fallbackLabel="Loading…"
        onDismiss={onDismiss}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('server-switch-watermark').getAttribute('data-state')).toBe('visible');

    // Resolving sessionName dynamically (same triggerKey) updates displayed text without resetting the 1000ms timer.
    rerender(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="Server Two"
        sessionName="my-project"
        fallbackLabel="No session"
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId('server-switch-watermark-session').textContent).toBe('my-project');

    act(() => {
      vi.advanceTimersByTime(SERVER_SWITCH_WATERMARK_HOLD_MS - 400 - 1);
    });
    expect(screen.getByTestId('server-switch-watermark').getAttribute('data-state')).toBe('visible');
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const hud = screen.getByTestId('server-switch-watermark');
    expect(hud.getAttribute('data-state')).toBe('exiting');
    expect(hud.className).toContain('is-exiting');
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SERVER_SWITCH_WATERMARK_EXIT_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('resets hold and exit timers cleanly when triggerKey increments mid-hold or mid-exit', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    const { rerender } = render(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="Server One"
        sessionName="alpha"
        shortcutKeycaps={['Ctrl', '↓']}
        onDismiss={onDismiss}
      />,
    );

    // Advance into exiting phase (1050ms > 1000ms holdMs)
    act(() => {
      vi.advanceTimersByTime(SERVER_SWITCH_WATERMARK_HOLD_MS + 50);
    });
    expect(screen.getByTestId('server-switch-watermark').getAttribute('data-state')).toBe('exiting');

    // Rapid switch updates triggerKey -> exits exiting state immediately, updates keycaps, and restarts full holdMs window
    rerender(
      <ServerSwitchWatermark
        visible
        triggerKey={2}
        serverName="Server Two"
        sessionName="delta"
        shortcutKeycaps={['Ctrl', '↑']}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId('server-switch-watermark').getAttribute('data-state')).toBe('visible');
    expect(screen.getByTestId('server-switch-watermark-server').textContent).toBe('Server Two');
    expect(
      Array.from(screen.getByTestId('server-switch-watermark-shortcut').querySelectorAll('kbd')).map((el) => el.textContent),
    ).toEqual(['Ctrl', '↑']);

    act(() => {
      vi.advanceTimersByTime(SERVER_SWITCH_WATERMARK_HOLD_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId('server-switch-watermark').getAttribute('data-state')).toBe('visible');

    act(() => {
      vi.advanceTimersByTime(1 + SERVER_SWITCH_WATERMARK_EXIT_MS);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clears pending timers on unmount without calling onDismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { unmount } = render(
      <ServerSwitchWatermark
        visible
        triggerKey={1}
        serverName="Server One"
        sessionName="alpha"
        onDismiss={onDismiss}
      />,
    );

    unmount();
    act(() => {
      vi.advanceTimersByTime(SERVER_SWITCH_WATERMARK_HOLD_MS + SERVER_SWITCH_WATERMARK_EXIT_MS + 500);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('defines pointer-events: none, centered fixed overlay, frosted glass, light-mode, and reduced-motion CSS rules', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../../src/styles.css'), 'utf8');
    const blockStart = css.indexOf('.server-switch-watermark {');
    expect(blockStart).toBeGreaterThan(-1);
    const tail = css.slice(blockStart);

    expect(tail).toMatch(/\.server-switch-watermark\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;[\s\S]*pointer-events:\s*none;[\s\S]*user-select:\s*none;/);
    expect(tail).toMatch(/\.server-switch-watermark-card\s*\{[\s\S]*backdrop-filter:\s*blur\(16px\)\s*saturate\(150%\);/);
    expect(tail).toContain('.server-switch-watermark-kbd');
    expect(tail).toContain('@media (prefers-color-scheme: light)');
    expect(tail).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tail).toContain('@media (max-width: 480px)');
  });
});
