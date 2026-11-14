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
import {
  MobileSwipeHud,
  resolveMobileSwipeTargets,
} from '../../src/components/MobileSwipeHud.js';
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
  'no_target',
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

  it('renders resolved server and session target names and dims unavailable null directions', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });

    const progress: MobileNavigationGestureProgress = {
      dx: 0,
      dy: -60,
      direction: 'up',
      action: 'serverPrev',
      distance: 60,
      threshold: 56,
      progress: 1,
      armed: true,
    };

    const view = render(
      <MobileSwipeHud
        progress={progress}
        targets={{
          up: 'mini-2',
          down: 'prod-eu-west',
          left: 'cd',
          right: 'clawd',
        }}
      />,
    );

    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up').textContent).toBe('mini-2');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-down').textContent).toBe('prod-eu-west');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-left').textContent).toBe('cd');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-right').textContent).toBe('clawd');
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-available')).toBe('true');

    // Unavailable dimension renders localized placeholder + unavailable state
    view.rerender(
      <MobileSwipeHud
        progress={progress}
        targets={{
          up: 'mini-2',
          down: 'prod-eu-west',
          left: null,
          right: null,
        }}
      />,
    );

    expect(screen.getByTestId('mobile-swipe-hud-dir-left').className).toContain('is-unavailable');
    expect(screen.getByTestId('mobile-swipe-hud-dir-left').getAttribute('data-available')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-left').textContent).toBe('No other target');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-right').textContent).toBe('No other target');
  });
});

describe('resolveMobileSwipeTargets', () => {
  const servers = [
    { id: 'srv-1', name: 'mini-1' },
    { id: 'srv-2', name: 'mini-2' },
    { id: 'srv-3', name: '' },
  ];
  const tabs = [
    { name: 'deck_cd_brain', label: 'cd', project: 'codedeck' },
    { name: 'deck_clawd_brain', label: null, project: 'clawd' },
    { name: 'deck_raw_brain', label: null, project: null },
  ];

  it('cycles servers and sessions matching app navigation rules and naming fallbacks', () => {
    expect(
      resolveMobileSwipeTargets({
        servers,
        currentServerId: 'srv-2',
        tabs,
        activeSession: 'deck_cd_brain',
        selectedServerId: 'srv-2',
        manualDashboard: false,
      }),
    ).toEqual({
      up: 'mini-1',
      down: 'srv-3', // falls back to srv.id when name is empty
      left: 'deck_raw_brain', // wraps around and falls back to session.name
      right: 'clawd', // falls back to session.project
    });
  });

  it('handles shared-in server selection and wraps to owned server with same id if share target active', () => {
    expect(
      resolveMobileSwipeTargets({
        servers: [
          { id: 'srv-1', name: 'Owned Host', isSharedIn: false },
          { id: 'srv-1', name: 'Shared Entry', isSharedIn: true },
        ],
        currentServerId: 'srv-1',
        hasActiveShareTarget: true,
        tabs,
        activeSession: 'deck_cd_brain',
        selectedServerId: 'srv-1',
        manualDashboard: false,
      }),
    ).toEqual({
      up: 'Owned Host',
      down: 'Owned Host',
      left: 'deck_raw_brain',
      right: 'clawd',
    });
  });

  it('returns null for single server, single session, missing server, and manualDashboard mode', () => {
    expect(
      resolveMobileSwipeTargets({
        servers: [{ id: 'srv-1', name: 'only-host' }],
        currentServerId: 'srv-1',
        tabs: [{ name: 'deck_one', label: 'one' }],
        activeSession: 'deck_one',
        selectedServerId: 'srv-1',
        manualDashboard: false,
      }),
    ).toEqual({
      up: null,
      down: null,
      left: null,
      right: null,
    });

    // Manual dashboard: servers remain switchable while sessions are blocked
    expect(
      resolveMobileSwipeTargets({
        servers,
        currentServerId: null,
        tabs,
        activeSession: 'deck_cd_brain',
        selectedServerId: null,
        manualDashboard: true,
      }),
    ).toEqual({
      up: 'srv-3',
      down: 'mini-1',
      left: null,
      right: null,
    });
  });
});
