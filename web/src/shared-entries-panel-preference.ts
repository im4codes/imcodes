export const SHARED_ENTRIES_PANEL_COLLAPSED_STORAGE_KEY = 'imcodes.web.shared-entries-panel.collapsed.v1';

export function loadSharedEntriesPanelCollapsed(
  storage?: Pick<Storage, 'getItem'>,
): boolean {
  try {
    const resolvedStorage = storage ?? globalThis.localStorage;
    return resolvedStorage.getItem(SHARED_ENTRIES_PANEL_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSharedEntriesPanelCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    const resolvedStorage = storage ?? globalThis.localStorage;
    resolvedStorage.setItem(SHARED_ENTRIES_PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Local UI preferences are fail-soft in privacy mode or at storage quota.
  }
}
