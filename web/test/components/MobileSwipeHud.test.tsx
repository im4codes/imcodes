/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h } from 'preact';
import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const { default: i18next } = await import('i18next');
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => i18next.t(key, opts),
      i18n: i18next,
    }),
  };
});

import i18n from '../../src/i18n/index.js';
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';
import { MobileSwipeHud } from '../../src/components/MobileSwipeHud.js';
import type { MobileNavigationGestureProgress } from '../../src/mobile-navigation-gestures.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
const HUD_KEYS = [
  'title',
  'up',
  'down',
  'left',
  'right',
  'drag_to_threshold',
  'release_to_switch',
] as const;

describe('MobileSwipeHud', () => {
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('renders nothing when progress is null', () => {
    render(<MobileSwipeHud progress={null} />);
    expect(screen.queryByTestId('mobile-swipe-hud')).toBeNull();
  });

  it('shows all 4 directions, unarmed drag progress, and armed release state', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });

    const initial: MobileNavigationGestureProgress = {
      dx: 0,
      dy: -28,
      direction: 'up',
      action: 'serverPrev',
      distance: 28,
      threshold: 56,
      progress: 0.5,
      armed: false,
    };

    const view = render(<MobileSwipeHud progress={initial} />);
    const hud = screen.getByTestId('mobile-swipe-hud');
    expect(hud.getAttribute('aria-hidden')).toBe('true');
    expect(hud.getAttribute('data-direction')).toBe('up');
    expect(hud.getAttribute('data-armed')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-progress').textContent).toBe('50%');
    expect((screen.getByTestId('mobile-swipe-hud-progress-bar') as HTMLElement).style.width).toBe('50%');
    expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe('Drag past threshold to switch');

    // All 4 directions are displayed simultaneously
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').textContent).toContain('Previous Server');
    expect(screen.getByTestId('mobile-swipe-hud-dir-down').textContent).toContain('Next Server');
    expect(screen.getByTestId('mobile-swipe-hud-dir-left').textContent).toContain('Previous Session');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').textContent).toContain('Next Session');

    // Only active direction is marked active; none armed yet
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-armed')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-down').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-left').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').getAttribute('data-active')).toBe('false');

    // Drag past threshold -> armed state updates hint and direction highlight
    view.rerender(
      <MobileSwipeHud
        progress={{
          dx: 64,
          dy: 0,
          direction: 'right',
          action: 'tabNext',
          distance: 64,
          threshold: 56,
          progress: 1,
          armed: true,
        }}
      />,
    );

    expect(hud.getAttribute('data-direction')).toBe('right');
    expect(hud.getAttribute('data-armed')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-progress').textContent).toBe('100%');
    expect((screen.getByTestId('mobile-swipe-hud-progress-bar') as HTMLElement).style.width).toBe('100%');
    expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe('Release to switch');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').getAttribute('data-armed')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-active')).toBe('false');
  });

  it('has complete and localized HUD translations across all 7 supported locales', async () => {
    const activeProgress: MobileNavigationGestureProgress = {
      dx: 0,
      dy: 60,
      direction: 'down',
      action: 'serverNext',
      distance: 60,
      threshold: 56,
      progress: 1,
      armed: true,
    };

    for (const locale of SUPPORTED_LOCALES) {
      const raw = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      ) as { mobile_gesture?: { hud?: Record<string, unknown> } };
      const hudStrings = raw.mobile_gesture?.hud;
      expect(hudStrings, `${locale} missing mobile_gesture.hud`).toBeTruthy();

      for (const key of HUD_KEYS) {
        expect(typeof hudStrings?.[key], `${locale}.mobile_gesture.hud.${key}`).toBe('string');
        expect((hudStrings?.[key] as string).trim().length, `${locale}.${key} empty`).toBeGreaterThan(0);
      }

      await act(async () => {
        await i18n.changeLanguage(locale);
      });
      render(<MobileSwipeHud progress={activeProgress} />);

      expect(screen.getByTestId('mobile-swipe-hud-dir-up').textContent).toContain(hudStrings!.up as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-down').textContent).toContain(hudStrings!.down as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-left').textContent).toContain(hudStrings!.left as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-right').textContent).toContain(hudStrings!.right as string);
      expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe(hudStrings!.release_to_switch as string);
      cleanup();
    }
  });
});
