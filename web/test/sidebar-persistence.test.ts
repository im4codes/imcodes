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

  it('falls back to legacy per-server width when global sidebar_width is absent and ignores invalid/out-of-range values', () => {
    // Global key takes precedence over legacy per-server keys
    localStorage.setItem('sidebar_width', '430');
    localStorage.setItem('sidebar_width_srv-1', '280');
    const first = render(h(Sidebar, { collapsed: false, serverId: 'srv-1' }));
    expect((first.container.querySelector('.sidebar-panel') as HTMLElement).style.width).toBe('430px');
    first.rerender(h(Sidebar, { collapsed: false, serverId: 'srv-2' }));
    expect((first.container.querySelector('.sidebar-panel') as HTMLElement).style.width).toBe('430px');
    first.unmount();

    // Without global key, valid legacy key is read cleanly
    localStorage.clear();
    localStorage.setItem('sidebar_width_srv-legacy', '280');
    const legacyRender = render(h(Sidebar, { collapsed: false, serverId: 'srv-legacy' }));
    expect((legacyRender.container.querySelector('.sidebar-panel') as HTMLElement).style.width).toBe('280px');
    legacyRender.rerender(h(Sidebar, { collapsed: false, serverId: 'srv-other' }));
    expect((legacyRender.container.querySelector('.sidebar-panel') as HTMLElement).style.width).toBe('280px');
    legacyRender.unmount();

    // Invalid or out-of-range values fall back to 380px default
    for (const invalid of ['120', '620', 'abc', '250px']) {
      localStorage.clear();
      localStorage.setItem('sidebar_width', invalid);
      const r = render(h(Sidebar, { collapsed: false, serverId: 'srv-bad' }));
      expect((r.container.querySelector('.sidebar-panel') as HTMLElement).style.width).toBe('380px');
      r.unmount();
    }
  });

  it('persists width globally under sidebar_width across server switches and null serverId, clamping to [180, 560] and keeping collapsed at 0px', () => {
    const { container, rerender } = render(h(Sidebar, { collapsed: false, serverId: 'srv-1' }));
    const panel = container.querySelector('.sidebar-panel') as HTMLElement;
    const handle = container.querySelector('.sidebar-resize-handle') as HTMLElement;

    expect(panel.style.width).toBe('380px');

    fireEvent.mouseDown(handle, { clientX: 380 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document, { clientX: 600 });
    expect(localStorage.getItem('sidebar_width')).toBe('560');
    expect(panel.style.width).toBe('560px');

    // Switching serverId to another server or null keeps the exact resized global width
    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-2' }));
    expect(panel.style.width).toBe('560px');
    rerender(h(Sidebar, { collapsed: false, serverId: null }));
    expect(panel.style.width).toBe('560px');

    // Dragging while serverId === null still persists globally
    fireEvent.mouseDown(handle, { clientX: 560 });
    fireEvent.mouseMove(document, { clientX: 460 });
    fireEvent.mouseUp(document, { clientX: 460 });
    expect(localStorage.getItem('sidebar_width')).toBe('460');
    expect(panel.style.width).toBe('460px');
    rerender(h(Sidebar, { collapsed: false, serverId: 'srv-3' }));
    expect(panel.style.width).toBe('460px');

    rerender(h(Sidebar, { collapsed: true, serverId: 'srv-3' }));
    expect(panel.style.width).toBe('0px');
  });
});
