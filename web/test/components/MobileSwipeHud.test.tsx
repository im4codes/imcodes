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
  'release_to_switch_step',
  'no_target',
] as const;

const makeProgress = (overrides: Partial<MobileNavigationGestureProgress> = {}): MobileNavigationGestureProgress => ({
  dx: 0,
  dy: 0,
  direction: null,
  action: null,
  distance: 0,
  threshold: 56,
  progress: 0,
  armed: false,
  step: 0,
  maxSteps: 3,
  horizontalMaxSteps: 3,
  verticalMaxSteps: 3,
  ...overrides,
});

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

    const initial = makeProgress({
      dx: 0,
      dy: -28,
      direction: 'up',
      action: 'serverPrev',
      distance: 28,
      progress: 0.5,
      armed: false,
      step: 0,
    });

    const view = render(<MobileSwipeHud progress={initial} />);
    const hud = screen.getByTestId('mobile-swipe-hud');
    expect(hud.getAttribute('aria-hidden')).toBe('true');
    expect(hud.getAttribute('data-direction')).toBe('up');
    expect(hud.getAttribute('data-armed')).toBe('false');
    expect(hud.getAttribute('data-step')).toBe('0');
    expect(screen.getByTestId('mobile-swipe-hud-progress').textContent).toBe('50%');
    expect((screen.getByTestId('mobile-swipe-hud-progress-bar') as HTMLElement).style.width).toBe('50%');
    expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe('Drag past threshold to switch');
    expect(screen.getByTestId('mobile-swipe-hud-center-badge').textContent).not.toContain('2F');

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

    // Drag past threshold -> armed state updates hint, center badge, and direction highlight
    view.rerender(
      <MobileSwipeHud
        progress={makeProgress({
          dx: 64,
          dy: 0,
          direction: 'right',
          action: 'tabNext',
          distance: 64,
          progress: 1,
          armed: true,
          step: 1,
        })}
      />,
    );

    expect(hud.getAttribute('data-direction')).toBe('right');
    expect(hud.getAttribute('data-armed')).toBe('true');
    expect(hud.getAttribute('data-step')).toBe('1');
    expect(screen.getByTestId('mobile-swipe-hud-center-badge').textContent).toBe('L1');
    expect(screen.getByTestId('mobile-swipe-hud-progress').textContent).toBe('100%');
    expect((screen.getByTestId('mobile-swipe-hud-progress-bar') as HTMLElement).style.width).toBe('100%');
    expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe('Release to switch');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-right').getAttribute('data-armed')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-active')).toBe('false');

    // Step 2 drag shows L2 badge and step hint
    view.rerender(
      <MobileSwipeHud
        progress={makeProgress({
          dx: 108,
          dy: 0,
          direction: 'right',
          action: 'tabNext',
          distance: 108,
          progress: 1,
          armed: true,
          step: 2,
        })}
      />,
    );
    expect(screen.getByTestId('mobile-swipe-hud-center-badge').textContent).toBe('L2');
    expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe('Release to switch (L2)');
  });

  it('has complete, localized HUD translations across all 7 locales with zero 2-finger labels', async () => {
    const activeProgress = makeProgress({
      dx: 0,
      dy: 60,
      direction: 'down',
      action: 'serverNext',
      distance: 60,
      progress: 1,
      armed: true,
      step: 1,
    });
    const forbiddenTwoFingerPattern = /2F|2-Finger|2本指|双指|雙指|두\s*손가락|2\s*dedos|двумя\s*пальцами/i;

    for (const locale of SUPPORTED_LOCALES) {
      const raw = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      ) as { mobile_gesture?: { hud?: Record<string, unknown> } };
      const hudStrings = raw.mobile_gesture?.hud;
      expect(hudStrings, `${locale} missing mobile_gesture.hud`).toBeTruthy();

      for (const key of HUD_KEYS) {
        expect(typeof hudStrings?.[key], `${locale}.mobile_gesture.hud.${key}`).toBe('string');
        const val = hudStrings?.[key] as string;
        expect(val.trim().length, `${locale}.${key} empty`).toBeGreaterThan(0);
        expect(val, `${locale}.${key} leaked 2-finger wording`).not.toMatch(forbiddenTwoFingerPattern);
      }

      await act(async () => {
        await i18n.changeLanguage(locale);
      });
      render(<MobileSwipeHud progress={activeProgress} />);

      expect(screen.getByTestId('mobile-swipe-hud').textContent).not.toMatch(forbiddenTwoFingerPattern);
      expect(screen.getByTestId('mobile-swipe-hud-dir-up').textContent).toContain(hudStrings!.up as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-down').textContent).toContain(hudStrings!.down as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-left').textContent).toContain(hudStrings!.left as string);
      expect(screen.getByTestId('mobile-swipe-hud-dir-right').textContent).toContain(hudStrings!.right as string);
      expect(screen.getByTestId('mobile-swipe-hud-hint').textContent).toBe(hudStrings!.release_to_switch as string);
      cleanup();
    }
  });

  it('renders multi-level targets, highlights only active selected step, and dims unavailable null directions', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });

    const progress = makeProgress({
      dx: 0,
      dy: -115,
      direction: 'up',
      action: 'serverPrev',
      distance: 115,
      progress: 1,
      armed: true,
      step: 2,
    });

    const view = render(
      <MobileSwipeHud
        progress={progress}
        targets={{
          up: [
            { step: 1, id: 's1', label: 'mini-1' },
            { step: 2, id: 's2', label: 'mini-2' },
            { step: 3, id: 's3', label: 'mini-3' },
          ],
          down: [
            { step: 1, id: 's4', label: 'prod-1' },
            { step: 2, id: 's5', label: 'prod-2' },
          ],
          left: [{ step: 1, id: 't1', label: 'cd' }],
          right: [{ step: 1, id: 't2', label: 'clawd' }],
        }}
      />,
    );

    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up').textContent).toBe('mini-1');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up-2').textContent).toBe('mini-2');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up-3').textContent).toBe('mini-3');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up').getAttribute('data-selected')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up-2').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-up-3').getAttribute('data-selected')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-down').getAttribute('data-selected')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-up').getAttribute('data-available')).toBe('true');

    // Unavailable dimension renders localized placeholder + unavailable state
    view.rerender(
      <MobileSwipeHud
        progress={progress}
        targets={{
          up: 'mini-2',
          down: 'prod-eu-west',
          left: [],
          right: null,
        }}
      />,
    );

    expect(screen.getByTestId('mobile-swipe-hud-dir-left').className).toContain('is-unavailable');
    expect(screen.getByTestId('mobile-swipe-hud-dir-left').getAttribute('data-available')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-left').textContent).toBe('No other target');
    expect(screen.getByTestId('mobile-swipe-hud-dir-target-right').textContent).toBe('No other target');
  });

  it('renders instant directional edge arrow indicator in direct_horizontal mode with carousel-matched target labels', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });

    const targets = {
      left: [{ step: 1, id: 'tab-left', label: 'left-session' }],
      right: [{ step: 1, id: 'tab-right', label: 'right-session' }],
    };

    // Swiping left (dx < 0) -> right edge indicator with '→' + next right tab label
    const view = render(
      <MobileSwipeHud
        progress={makeProgress({
          mode: 'direct_horizontal',
          dx: -60,
          dy: 0,
          direction: 'left',
          action: 'tabNext',
          swipeAction: 'tabNext',
          distance: 60,
          threshold: 116,
          progress: 60 / 116,
          armed: false,
          step: 0,
          maxSteps: 1,
          horizontalMaxSteps: 1,
          verticalMaxSteps: 1,
        })}
        targets={targets}
      />,
    );

    expect(document.querySelector('.mobile-swipe-hud-card')).toBeNull();
    const hud = screen.getByTestId('mobile-swipe-hud');
    expect(hud.getAttribute('data-mode')).toBe('direct_horizontal');
    const indicator = screen.getByTestId('mobile-swipe-edge-indicator');
    expect(indicator.getAttribute('data-edge')).toBe('right');
    expect(indicator.getAttribute('data-action')).toBe('tabNext');
    expect(indicator.getAttribute('data-armed')).toBe('false');
    expect(screen.getByTestId('mobile-swipe-edge-arrow').textContent).toBe('→');
    expect(screen.getByTestId('mobile-swipe-edge-label').textContent).toBe('right-session');

    // Crossing threshold sets armed=true
    view.rerender(
      <MobileSwipeHud
        progress={makeProgress({
          mode: 'direct_horizontal',
          dx: -128,
          dy: 0,
          direction: 'left',
          action: 'tabNext',
          swipeAction: 'tabNext',
          distance: 128,
          threshold: 116,
          progress: 1,
          armed: true,
          step: 1,
          maxSteps: 1,
          horizontalMaxSteps: 1,
          verticalMaxSteps: 1,
        })}
        targets={targets}
      />,
    );
    expect(screen.getByTestId('mobile-swipe-edge-indicator').getAttribute('data-armed')).toBe('true');
    expect(screen.getByTestId('mobile-swipe-edge-indicator').className).toContain('is-armed');

    // Swiping right (dx > 0) -> left edge indicator with '←' + previous left tab label
    view.rerender(
      <MobileSwipeHud
        progress={makeProgress({
          mode: 'direct_horizontal',
          dx: 128,
          dy: 0,
          direction: 'right',
          action: 'tabPrev',
          swipeAction: 'tabPrev',
          distance: 128,
          threshold: 116,
          progress: 1,
          armed: true,
          step: 1,
          maxSteps: 1,
          horizontalMaxSteps: 1,
          verticalMaxSteps: 1,
        })}
        targets={targets}
      />,
    );
    const leftIndicator = screen.getByTestId('mobile-swipe-edge-indicator');
    expect(leftIndicator.getAttribute('data-edge')).toBe('left');
    expect(leftIndicator.getAttribute('data-action')).toBe('tabPrev');
    expect(screen.getByTestId('mobile-swipe-edge-arrow').textContent).toBe('←');
    expect(screen.getByTestId('mobile-swipe-edge-label').textContent).toBe('left-session');

    // Empty target slot hides edge indicator cleanly
    view.rerender(
      <MobileSwipeHud
        progress={makeProgress({
          mode: 'direct_horizontal',
          dx: -60,
          dy: 0,
          direction: 'left',
          action: 'tabNext',
          swipeAction: 'tabNext',
          distance: 60,
          threshold: 116,
          progress: 0.5,
          armed: false,
        })}
        targets={{ left: [], right: [] }}
      />,
    );
    expect(screen.queryByTestId('mobile-swipe-edge-indicator')).toBeNull();
  });
});

describe('resolveMobileSwipeTargets', () => {
  const servers = [
    { id: 'srv-1', name: 'mini-1' },
    { id: 'srv-2', name: 'mini-2' },
    { id: 'srv-3', name: '' },
    { id: 'srv-4', name: 'mini-4' },
    { id: 'srv-5', name: 'mini-5' },
    { id: 'srv-6', name: 'mini-6' },
  ];
  const tabs = [
    { name: 'deck_cd_brain', label: 'cd', project: 'codedeck' },
    { name: 'deck_clawd_brain', label: null, project: 'clawd' },
    { name: 'deck_raw_brain', label: null, project: null },
    { name: 'deck_four_brain', label: 'four', project: null },
    { name: 'deck_five_brain', label: 'five', project: null },
  ];

  it('resolves 3 horizontal steps and 3/4/5 vertical steps without duplicating targets or wrapping onto self', () => {
    const res3 = resolveMobileSwipeTargets({
      servers,
      currentServerId: 'srv-2',
      tabs,
      activeSession: 'deck_cd_brain',
      selectedServerId: 'srv-2',
      manualDashboard: false,
      verticalMaxSteps: 3,
      horizontalMaxSteps: 3,
    });
    expect(res3.up).toEqual([
      { step: 1, id: 'srv-1', label: 'mini-1' },
      { step: 2, id: 'srv-6', label: 'mini-6' },
      { step: 3, id: 'srv-5', label: 'mini-5' },
    ]);
    expect(res3.down).toEqual([
      { step: 1, id: 'srv-3', label: 'srv-3' },
      { step: 2, id: 'srv-4', label: 'mini-4' },
      { step: 3, id: 'srv-5', label: 'mini-5' },
    ]);
    expect(res3.left).toEqual([
      { step: 1, id: 'deck_five_brain', label: 'five' },
      { step: 2, id: 'deck_four_brain', label: 'four' },
      { step: 3, id: 'deck_raw_brain', label: 'deck_raw_brain' },
    ]);
    expect(res3.right).toEqual([
      { step: 1, id: 'deck_clawd_brain', label: 'clawd' },
      { step: 2, id: 'deck_raw_brain', label: 'deck_raw_brain' },
      { step: 3, id: 'deck_four_brain', label: 'four' },
    ]);

    const res5 = resolveMobileSwipeTargets({
      servers,
      currentServerId: 'srv-2',
      tabs,
      activeSession: 'deck_cd_brain',
      selectedServerId: 'srv-2',
      manualDashboard: false,
      verticalMaxSteps: 5,
      horizontalMaxSteps: 3,
    });
    expect(res5.up).toHaveLength(5);
    expect(res5.down).toHaveLength(5);
    expect(res5.left).toHaveLength(3);
    expect(res5.right).toHaveLength(3);
  });

  it('caps available steps cleanly when fewer distinct targets exist', () => {
    const res = resolveMobileSwipeTargets({
      servers: servers.slice(0, 3),
      currentServerId: 'srv-2',
      tabs: tabs.slice(0, 3),
      activeSession: 'deck_cd_brain',
      selectedServerId: 'srv-2',
      manualDashboard: false,
      verticalMaxSteps: 5,
      horizontalMaxSteps: 3,
    });
    expect(res.up).toEqual([
      { step: 1, id: 'srv-1', label: 'mini-1' },
      { step: 2, id: 'srv-3', label: 'srv-3' },
    ]);
    expect(res.down).toEqual([
      { step: 1, id: 'srv-3', label: 'srv-3' },
      { step: 2, id: 'srv-1', label: 'mini-1' },
    ]);
    expect(res.left).toEqual([
      { step: 1, id: 'deck_raw_brain', label: 'deck_raw_brain' },
      { step: 2, id: 'deck_clawd_brain', label: 'clawd' },
    ]);
    expect(res.right).toEqual([
      { step: 1, id: 'deck_clawd_brain', label: 'clawd' },
      { step: 2, id: 'deck_raw_brain', label: 'deck_raw_brain' },
    ]);
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
        tabs: tabs.slice(0, 3),
        activeSession: 'deck_cd_brain',
        selectedServerId: 'srv-1',
        manualDashboard: false,
      }),
    ).toEqual({
      up: [{ step: 1, id: 'srv-1', label: 'Owned Host' }],
      down: [{ step: 1, id: 'srv-1', label: 'Owned Host' }],
      left: [
        { step: 1, id: 'deck_raw_brain', label: 'deck_raw_brain' },
        { step: 2, id: 'deck_clawd_brain', label: 'clawd' },
      ],
      right: [
        { step: 1, id: 'deck_clawd_brain', label: 'clawd' },
        { step: 2, id: 'deck_raw_brain', label: 'deck_raw_brain' },
      ],
    });
  });

  it('returns empty arrays for single server, single session, missing server, and manualDashboard mode', () => {
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
      up: [],
      down: [],
      left: [],
      right: [],
    });

    // Manual dashboard: servers remain switchable while sessions are blocked
    expect(
      resolveMobileSwipeTargets({
        servers: servers.slice(0, 3),
        currentServerId: null,
        tabs,
        activeSession: 'deck_cd_brain',
        selectedServerId: null,
        manualDashboard: true,
      }),
    ).toEqual({
      up: [
        { step: 1, id: 'srv-3', label: 'srv-3' },
        { step: 2, id: 'srv-2', label: 'mini-2' },
        { step: 3, id: 'srv-1', label: 'mini-1' },
      ],
      down: [
        { step: 1, id: 'srv-1', label: 'mini-1' },
        { step: 2, id: 'srv-2', label: 'mini-2' },
        { step: 3, id: 'srv-3', label: 'srv-3' },
      ],
      left: [],
      right: [],
    });
  });
});
