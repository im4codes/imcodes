/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { loadSidebarCollapsed, saveSidebarCollapsed } from '../src/components/Sidebar.js';

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
