/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../src/components/LanguageSwitcher.js', () => ({
  LanguageSwitcher: () => h('button', { type: 'button' }, 'Language'),
}));

vi.mock('../src/components/VoiceLanguageSwitcher.js', () => ({
  VoiceLanguageSwitcher: () => h('button', { type: 'button' }, 'VoiceLanguage'),
}));

import {
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  Sidebar,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from '../src/components/Sidebar.js';

describe('sidebar collapsed persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads both legacy and current persisted truthy values', () => {
    localStorage.setItem('sidebar_collapsed', 'true');
    expect(loadSidebarCollapsed()).toBe(true);

    localStorage.setItem('sidebar_collapsed', '1');
    expect(loadSidebarCollapsed()).toBe(true);
  });

  it('persists collapsed state using stable 1/0 values', () => {
    saveSidebarCollapsed(true);
    expect(localStorage.getItem('sidebar_collapsed')).toBe('1');
    expect(loadSidebarCollapsed()).toBe(true);

    saveSidebarCollapsed(false);
    expect(localStorage.getItem('sidebar_collapsed')).toBe('0');
    expect(loadSidebarCollapsed()).toBe(false);
  });
});

describe('desktop sidebar width default and persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(globalThis, '__BUILD_TIME__', {
      configurable: true,
      value: '2026-05-11T02:34:00.000Z',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the 380px default desktop width when no width is persisted or serverId is null', () => {
    expect(MIN_WIDTH).toBe(180);
    expect(MAX_WIDTH).toBe(560);
    expect(DEFAULT_WIDTH).toBe(380);

    const { container, rerender } = render(h(Sidebar, { collapsed: false, serverId: null }));
    const panel = container.querySelector('.sidebar-panel') as HTMLElement;
    expect(panel.style.width).toBe('380px');

    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-default' }));
    expect(panel.style.width).toBe('380px');
  });

  it('restores valid persisted per-server widths within [180, 560] and falls back to 380px for invalid values', () => {
    localStorage.setItem('sidebar_width_srv-valid', '280');
    localStorage.setItem('sidebar_width_srv-wide', '540');
    localStorage.setItem('sidebar_width_srv-too-narrow', '120');
    localStorage.setItem('sidebar_width_srv-too-wide', '620');
    localStorage.setItem('sidebar_width_srv-nan', 'abc');

    const { container, rerender } = render(h(Sidebar, { collapsed: false, serverId: 'srv-valid' }));
    const panel = container.querySelector('.sidebar-panel') as HTMLElement;
    expect(panel.style.width).toBe('280px');

    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-wide' }));
    expect(panel.style.width).toBe('540px');

    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-too-narrow' }));
    expect(panel.style.width).toBe('380px');

    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-too-wide' }));
    expect(panel.style.width).toBe('380px');

    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-nan' }));
    expect(panel.style.width).toBe('380px');
  });

  it('clamps mouse drag resizing to [180, 560] and keeps collapsed width at 0px', () => {
    const { container, rerender } = render(h(Sidebar, { collapsed: false, serverId: 'srv-drag' }));
    const panel = container.querySelector('.sidebar-panel') as HTMLElement;
    const handle = container.querySelector('.sidebar-resize-handle') as HTMLElement;

    expect(panel.style.width).toBe('380px');

    fireEvent.mouseDown(handle, { clientX: 380 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document, { clientX: 600 });
    expect(localStorage.getItem('sidebar_width_srv-drag')).toBe('560');
    expect(panel.style.width).toBe('560px');

    rerender(h(Sidebar, { collapsed: true, serverId: 'srv-drag' }));
    expect(panel.style.width).toBe('0px');
  });
});
