import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import type { CloudDocQuoteTarget } from '../cloud-docs-reference.js';
import type { WsClient } from '../ws-client.js';
import {
  RemoteDesktopConnectionManager,
  remoteDesktopHostKey,
} from '../remote-desktop-connection-manager.js';
import {
  REMOTE_DESKTOP_WALL_TAB_ID,
  REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS,
  REMOTE_DESKTOP_WORKSPACE_WINDOW_ID,
  remoteDesktopWorkspaceHosts,
  type RemoteDesktopWorkspaceMachine,
  type RemoteDesktopWorkspaceState,
  type RemoteDesktopWorkspaceTabId,
} from '../remote-desktop-workspace-state.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { openRemoteDesktopWindow } from '../remote-desktop-window.js';
import { useFullscreen } from '../hooks/useFullscreen.js';
import { useSyncedPreference } from '../hooks/useSyncedPreference.js';
import { isImeComposingKeyEvent } from '../ime-keyboard.js';
import {
  canHandleStandaloneRemoteDesktopTabShortcut,
  cycleOrderedId,
  isMacPlatform,
  KEYBOARD_SHORTCUTS_PREF_KEY,
  matchNavigationShortcutBinding,
  resolveKeyboardShortcutSlots,
  type KeyboardShortcutOverrides,
} from '../keyboard-shortcuts.js';
import { FloatingPanel } from './FloatingPanel.js';
import { RemoteDesktopPanel } from './RemoteDesktopPanel.js';
import {
  RemoteDesktopMinimizedDock,
  rememberMinimizeOrigin,
  type RemoteDesktopMinimizeOrigin,
} from './RemoteDesktopMinimizedDock.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { ControlledNodeMachineMenu } from './ControlledNodeMachineMenu.js';
import { CloudDocsMainChatFloat, type CloudDocsMainChatContext } from './CloudDocsMainChatFloat.js';
import { RemoteDesktopMenuBarRestoreButton } from './RemoteDesktopMenuBarControls.js';
import { REMOTE_DESKTOP_OVERLAY_CLASS } from '../remote-desktop-pointer-overlay.js';
import { isMobileKeyboardInputTarget } from '../mobile-keyboard.js';
import { isMobileDevice, subscribeDeviceLayoutChange } from '../mobile-device.js';
import { getActiveCssZoom } from '../ui-scale.js';
import { boundedVisualViewportHeight } from '../visual-viewport.js';
import './remote-desktop-workspace.css';
import { REMOTE_DESKTOP_STOP_ORIGIN } from '@shared/remote-desktop.js';

export const REMOTE_DESKTOP_MINI_CHAT_HEIGHT_STORAGE_KEY = 'imcodes_rd_mini_chat_height_v1';

function detectSystemKeyboardOpen(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const root = document.documentElement;
  if (root.classList.contains('kb-open')) return true;

  const activeEl = document.activeElement;
  const inputFocused = isMobileKeyboardInputTarget(activeEl);
  const vv = window.visualViewport;
  if (vv && typeof window.innerHeight === 'number' && window.innerHeight > 0) {
    const cssZoom = getActiveCssZoom(document);
    const viewportHeight = boundedVisualViewportHeight(
      vv.height,
      window.innerHeight,
      root.clientHeight,
      cssZoom,
    );
    if (viewportHeight !== null) {
      const shrink = Math.max(0, window.innerHeight - viewportHeight);
      if (shrink > 40 || (inputFocused && shrink > 15)) return true;
    }
  }

  const isCoarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  if (isCoarsePointer && (root.classList.contains('input-focused') || inputFocused)) {
    return true;
  }
  return false;
}

export interface RemoteDesktopWorkspaceProps {
  state: RemoteDesktopWorkspaceState;
  manager: RemoteDesktopConnectionManager;
  ws?: WsClient | null;
  minimized?: boolean;
  zIndex?: number;
  onFocus?(): void;
  onMinimize?(): void;
  onRestore?(): void;
  onOpenHost(machine: RemoteDesktopWorkspaceMachine): void;
  onActivateTab(tabId: RemoteDesktopWorkspaceTabId): void;
  onCloseHost(hostKey: string): void;
  onReorderHost(hostKey: string, direction: -1 | 1): void;
  onCloseWorkspace(): void;
  wallHostKeys?: ReadonlySet<string>;
  /**
   * Whether a host may be torn off into its own browser window. Off by
   * default, and off on mobile, where a popup either never opens or opens as a
   * tab you cannot get back from.
   */
  allowStandaloneWindow?: boolean;
  /**
   * The workspace is its own browser window: fill it edge to edge instead of
   * floating a remembered-size panel inside it. Mirrors RemoteDesktopWall's
   * own `standalone`.
   */
  standalone?: boolean;
  quickData?: UseQuickDataResult;
  mainChat?: CloudDocsMainChatContext | null;
  onOpenDoc?: (docId: string) => void;
  onRemoteDesktopClick?: (targetId: string) => void;
}

export function RemoteDesktopWorkspace({
  state,
  manager,
  ws = null,
  minimized = false,
  zIndex,
  onFocus,
  onMinimize,
  onRestore,
  onOpenHost,
  onActivateTab,
  onCloseHost,
  onReorderHost,
  onCloseWorkspace,
  wallHostKeys = new Set(),
  allowStandaloneWindow = false,
  standalone = false,
  quickData,
  mainChat = null,
  onOpenDoc,
  onRemoteDesktopClick,
}: RemoteDesktopWorkspaceProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const minimizeOriginRef = useRef<RemoteDesktopMinimizeOrigin | null>(null);
  const wasMinimizedRef = useRef(minimized);
  const [mobileDevice, setMobileDevice] = useState(() => isMobileDevice());
  useEffect(() => subscribeDeviceLayoutChange(() => setMobileDevice(isMobileDevice()), { includeResize: false }), []);
  const [mobileKeyboardOpenByHost, setMobileKeyboardOpenByHost] = useState<Record<string, boolean>>({});
  const [systemKeyboardOpen, setSystemKeyboardOpen] = useState<boolean>(() => detectSystemKeyboardOpen());

  const handleHostKeyboardOpenChange = useCallback((hostKey: string, open: boolean) => {
    setMobileKeyboardOpenByHost((prev) => {
      const current = Boolean(prev[hostKey]);
      if (current === open) return prev;
      if (!open) {
        const next = { ...prev };
        delete next[hostKey];
        return next;
      }
      return { ...prev, [hostKey]: true };
    });
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let focusOutTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      setSystemKeyboardOpen(detectSystemKeyboardOpen());
    };
    const onFocusOut = () => {
      sync();
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer);
      focusOutTimer = setTimeout(sync, 0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') sync();
    };
    sync();

    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => sync())
      : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer);
      observer?.disconnect();
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const wasMinimized = wasMinimizedRef.current;
    wasMinimizedRef.current = minimized;
    if (!minimized || wasMinimized) return;
    if (state.activeTabId) {
      manager.releaseInput(state.activeTabId);
    }
    if (
      typeof document !== 'undefined'
      && document.fullscreenElement
      && workspaceRef.current?.contains(document.fullscreenElement)
      && typeof document.exitFullscreen === 'function'
    ) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [manager, minimized, state.activeTabId]);
  // Fullscreen on the workspace, not on the active panel: the tab bar has to
  // come with it, or fullscreen becomes a one-way door out of every other
  // machine you had open.
  const fullscreen = useFullscreen(workspaceRef);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuBarHidden, setMenuBarHidden] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const tabButtonsRef = useRef(new Map<RemoteDesktopWorkspaceTabId, HTMLButtonElement>());
  const hosts = remoteDesktopWorkspaceHosts(state);
  const activeHost = state.activeTabId === REMOTE_DESKTOP_WALL_TAB_ID
    ? null
    : (hosts.find(({ hostKey }) => hostKey === state.activeTabId) ?? null);
  const activeRemoteDesktopQuote = useMemo<CloudDocQuoteTarget | null>(() => {
    if (!activeHost) return null;
    const { machine } = activeHost;
    const targetId = machine.nodeId?.trim() || machine.serverId?.trim() || '';
    if (!targetId) return null;
    return {
      kind: 'remote_desktop',
      id: targetId,
      serverId: machine.serverId,
      ...(machine.nodeId ? { nodeId: machine.nodeId } : {}),
      name: machine.displayName,
    };
  }, [activeHost]);

  const atHostLimit = hosts.length >= REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS;
  const hostLimitNotice = t('remote_desktop.workspace_limit', { count: REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS });
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const toggleMenuBar = useCallback(() => {
    setMenuBarHidden((current) => {
      const next = !current;
      if (next) setPickerOpen(false);
      return next;
    });
  }, []);
  // A host already open is always pickable: picking it just brings it forward.
  // At the limit, only those remain pickable.
  const isPickable = useCallback((machine: MachineListItem) => canOpenRemoteDesktopMachine(machine)
    && (!atHostLimit || !!state.hosts[remoteDesktopHostKey(machine)]), [atHostLimit, state.hosts]);
  const pickDisabledReason = useCallback((machine: MachineListItem) => (
    canOpenRemoteDesktopMachine(machine) ? hostLimitNotice : undefined
  ), [hostLimitNotice]);

  const activate = useCallback((tabId: RemoteDesktopWorkspaceTabId) => {
    if (tabId === state.activeTabId) return;
    manager.releaseInput(state.activeTabId);
    onActivateTab(tabId);
  }, [manager, onActivateTab, state.activeTabId]);

  const activateFromShortcut = useCallback((fromTabId: RemoteDesktopWorkspaceTabId, nextTabId: RemoteDesktopWorkspaceTabId) => {
    manager.releaseInput(fromTabId);
    onActivateTab(nextTabId);
  }, [manager, onActivateTab]);

  const closeHost = useCallback((hostKey: string) => {
    if (!wallHostKeys.has(hostKey)) {
      manager.stop(hostKey, REMOTE_DESKTOP_STOP_ORIGIN.WORKSPACE_HOST_CLOSE);
    }
    onCloseHost(hostKey);
  }, [manager, onCloseHost, wallHostKeys]);

  const closeWorkspace = useCallback(() => {
    if (state.orderedHostKeys.length > 1 && !window.confirm(t(
      'remote_desktop.workspace_close_confirm',
      { count: state.orderedHostKeys.length },
    ))) return;
    for (const hostKey of state.orderedHostKeys) {
      if (!wallHostKeys.has(hostKey)) {
        manager.stop(hostKey, REMOTE_DESKTOP_STOP_ORIGIN.WORKSPACE_CLOSE);
      }
    }
    onCloseWorkspace();
  }, [manager, onCloseWorkspace, state.orderedHostKeys, t, wallHostKeys]);

  /**
   * Move the active host into its own window.
   *
   * The tab closes here once the window is actually open. Leaving it would
   * keep a second live session on the same machine, and the two would fight
   * over control of it. If the popup was blocked, nothing is closed -- losing
   * the session to a blocker you cannot see would be the worst of both.
   */
  const openActiveInWindow = useCallback(() => {
    const hostKey = state.activeTabId;
    const machine = state.hosts[hostKey]?.machine;
    if (!machine) return;
    if (openRemoteDesktopWindow(machine.serverId)) closeHost(hostKey);
  }, [closeHost, state.activeTabId, state.hosts]);

  const selectHost = useCallback((machine: RemoteDesktopWorkspaceMachine) => {
    setPickerOpen(false);
    onOpenHost(machine);
  }, [onOpenHost]);

  const tabIds = [...state.orderedHostKeys];
  const handleTabKeyDown = (event: KeyboardEvent, tabId: RemoteDesktopWorkspaceTabId) => {
    const index = tabIds.indexOf(tabId);
    let nextIndex: number | null = null;
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      onReorderHost(tabId, -1);
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      onReorderHost(tabId, 1);
      return;
    }
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabIds.length) % tabIds.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabIds.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabIds.length - 1;
    if (event.key === 'Delete') {
      event.preventDefault();
      closeHost(tabId);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTabId = tabIds[nextIndex];
    activate(nextTabId);
    requestAnimationFrame(() => tabButtonsRef.current.get(nextTabId)?.focus());
  };

  const content = (
    <div
      class={`remote-desktop-workspace${menuBarHidden ? ' is-menubar-hidden' : ''}`}
      ref={workspaceRef}
      data-active-tab={state.activeTabId}
      // Machine names and window chrome are controls, not selectable page
      // text. This also fences the native Copy/Translate menu if a WebView
      // emits contextmenu despite the CSS callout suppression.
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      <div class="remote-desktop-workspace-tabbar" hidden={menuBarHidden}>
        <div role="tablist" aria-label={t('remote_desktop.workspace_tabs')}>
          {hosts.map(({ hostKey, machine }) => (
            <span
              class={`remote-desktop-workspace-host-tab${state.activeTabId === hostKey ? ' is-active' : ''}`}
              key={hostKey}
            >
              <button
                class="remote-desktop-workspace-tab"
                type="button"
                role="tab"
                ref={(element) => {
                  if (element) tabButtonsRef.current.set(hostKey, element);
                  else tabButtonsRef.current.delete(hostKey);
                }}
                aria-selected={state.activeTabId === hostKey}
                tabIndex={state.activeTabId === hostKey ? 0 : -1}
                onClick={() => activate(hostKey)}
                onKeyDown={(event) => handleTabKeyDown(event, hostKey)}
              >{machine.displayName}</button>
              <button
                class="remote-desktop-workspace-tab-close"
                type="button"
                onClick={() => closeHost(hostKey)}
                aria-label={t('remote_desktop.workspace_close_tab', { machine: machine.displayName })}
              ><svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg></button>
            </span>
          ))}
        </div>
        <button
          type="button"
          class="remote-desktop-workspace-add remote-desktop-workspace-icon-button"
          ref={addButtonRef}
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          aria-label={t('remote_desktop.workspace_add')}
          onClick={() => setPickerOpen((current) => !current)}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
        <div class="remote-desktop-workspace-actions">
          <button
            class="remote-desktop-workspace-chrome-button remote-desktop-workspace-menubar-toggle"
            type="button"
            aria-pressed={menuBarHidden}
            onClick={toggleMenuBar}
            aria-label={t(menuBarHidden ? 'remote_desktop.show_menubar' : 'remote_desktop.hide_menubar')}
            title={t(menuBarHidden ? 'remote_desktop.show_menubar' : 'remote_desktop.hide_menubar')}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button>
          {allowStandaloneWindow && hosts.length > 0 && (
            <button
              class="remote-desktop-workspace-chrome-button remote-desktop-workspace-open-window"
              type="button"
              onClick={openActiveInWindow}
              aria-label={t('remote_desktop.workspace_open_new_window')}
              title={t('remote_desktop.workspace_open_new_window')}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 4h5v5M16 4l-7 7M14 11v5H4V6h5" /></svg></button>
          )}
          {fullscreen.supported && !mobileDevice && (
            <button
              class="remote-desktop-workspace-chrome-button remote-desktop-workspace-fullscreen"
              type="button"
              aria-pressed={fullscreen.active}
              onClick={() => { void fullscreen.toggle(); }}
              aria-label={t(fullscreen.active
                ? 'remote_desktop.workspace_exit_fullscreen'
                : 'remote_desktop.workspace_fullscreen')}
              title={t(fullscreen.active
                ? 'remote_desktop.workspace_exit_fullscreen'
                : 'remote_desktop.workspace_fullscreen')}
            >{fullscreen.active
              ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3v5H3M12 17v-5h5" /></svg>
              : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8V4h4M16 12v4h-4M16 8V4h-4M4 12v4h4" /></svg>}</button>
          )}
          {onMinimize && (
            <button
              class="remote-desktop-workspace-chrome-button"
              type="button"
              onClick={(event) => {
                rememberMinimizeOrigin(minimizeOriginRef, event.currentTarget);
                onMinimize();
              }}
              aria-label={t('window.minimize')}
              title={t('window.minimize')}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 13h10" /></svg></button>
          )}
          <button
            class="remote-desktop-workspace-chrome-button is-danger"
            type="button"
            onClick={closeWorkspace}
            aria-label={t('remote_desktop.workspace_close')}
            title={t('remote_desktop.workspace_close')}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg></button>
        </div>
      </div>

      <label class="remote-desktop-workspace-mobile-selector" hidden={menuBarHidden}>
        <span>{t('remote_desktop.workspace_select')}</span>
        <select value={state.activeTabId} onInput={(event) => activate(event.currentTarget.value)}>
          {hosts.map(({ hostKey, machine }) => (
            <option value={hostKey} key={hostKey}>{machine.displayName}</option>
          ))}
        </select>
      </label>

      {menuBarHidden && (
        <RemoteDesktopMenuBarRestoreButton
          label={t('remote_desktop.show_menubar')}
          onRestore={() => setMenuBarHidden(false)}
        />
      )}

      <ControlledNodeMachineMenu
        anchorRef={addButtonRef}
        open={pickerOpen}
        onClose={closePicker}
        onSelect={selectHost}
        onOpenInWindow={allowStandaloneWindow
          ? (machine) => { openRemoteDesktopWindow(machine.serverId); }
          : undefined}
        isSelectable={isPickable}
        disabledReason={pickDisabledReason}
        label={t('remote_desktop.workspace_picker')}
        emptyText={t('remote_desktop.workspace_picker_empty')}
        errorText={t('remote_desktop.workspace_picker_failed')}
        notice={atHostLimit ? hostLimitNotice : undefined}
      />

      {hosts.map(({ hostKey, machine }) => (
        <RemoteDesktopPanel
          key={hostKey}
          machine={machine}
          connectionManager={manager}
          ws={ws}
          embedded
          active={state.activeTabId === hostKey}
          visible={state.activeTabId === hostKey && !minimized}
          inputActive={state.activeTabId === hostKey && !minimized}
          menuBarHidden={menuBarHidden}
          onShowMenuBar={() => setMenuBarHidden(false)}
          quickData={quickData}
          onClose={() => closeHost(hostKey)}
          onAuthorityLost={() => closeHost(hostKey)}
          onMobileKeyboardOpenChange={(open) => handleHostKeyboardOpenChange(hostKey, open)}
        />
      ))}
      {mainChat && (
        <CloudDocsMainChatFloat
          mainChat={mainChat}
          activePreviewQuote={activeRemoteDesktopQuote}
          onOpenDoc={onOpenDoc}
          onRemoteDesktopClick={onRemoteDesktopClick}
          heightStorageKey={REMOTE_DESKTOP_MINI_CHAT_HEIGHT_STORAGE_KEY}
          overlayClassName={REMOTE_DESKTOP_OVERLAY_CLASS}
          visible={!minimized}
          hideFab={Boolean(activeHost && mobileKeyboardOpenByHost[activeHost.hostKey]) || systemKeyboardOpen}
        />
      )}
    </div>
  );

  if (standalone) {
    return (
      <div class="remote-desktop-workspace-standalone">
        <StandaloneRemoteDesktopTabShortcuts
          enabled={!minimized && hosts.length > 1}
          tabIds={tabIds}
          activeTabId={state.activeTabId}
          pickerOpen={pickerOpen}
          onActivateShortcutTab={activateFromShortcut}
        />
        {content}
      </div>
    );
  }

  return (
    <>
      <div
        class="remote-desktop-workspace-window"
        hidden={minimized}
        aria-hidden={minimized ? 'true' : undefined}
        inert={minimized || undefined}
      >
        <FloatingPanel
          id={REMOTE_DESKTOP_WORKSPACE_WINDOW_ID}
          title={t('remote_desktop.workspace_title')}
          onClose={closeWorkspace}
          zIndex={zIndex ?? 10020}
          onFocus={onFocus}
          defaultW={1240}
          defaultH={800}
          minW={680}
          minH={460}
          className="remote-desktop-workspace-shell"
          enableMaximize
          isMaximized={maximized}
          onToggleMaximized={() => setMaximized((current) => !current)}
          hideTitleBar
          dragHandleSelector=".remote-desktop-workspace-tabbar"
        >{content}</FloatingPanel>
      </div>
      {minimized && (
        <RemoteDesktopMinimizedDock
          originRef={minimizeOriginRef}
          onRestore={() => {
            onRestore?.();
            onFocus?.();
          }}
          ariaLabel={t('remote_desktop.workspace_restore', { count: hosts.length })}
          label={`${t('remote_desktop.workspace_title')} · ${hosts.length}`}
        />
      )}
    </>
  );
}

/**
 * Capture-phase `tabPrev`/`tabNext` tab-switching handler mounted ONLY inside
 * standalone multi-tab Remote Desktop windows (`standalone === true`).
 */
function StandaloneRemoteDesktopTabShortcuts({
  enabled,
  tabIds,
  activeTabId,
  pickerOpen,
  onActivateShortcutTab,
}: {
  enabled: boolean;
  tabIds: readonly RemoteDesktopWorkspaceTabId[];
  activeTabId: RemoteDesktopWorkspaceTabId;
  pickerOpen: boolean;
  onActivateShortcutTab: (fromTabId: RemoteDesktopWorkspaceTabId, nextTabId: RemoteDesktopWorkspaceTabId) => void;
}) {
  const [shortcutOverrides] = useSyncedPreference<KeyboardShortcutOverrides>(
    KEYBOARD_SHORTCUTS_PREF_KEY,
    {},
    0,
  );
  const resolvedShortcutSlots = useMemo(
    () => resolveKeyboardShortcutSlots(shortcutOverrides, isMacPlatform()),
    [shortcutOverrides],
  );

  const slotsRef = useRef(resolvedShortcutSlots);
  slotsRef.current = resolvedShortcutSlots;
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const effectiveActiveTabIdRef = useRef(activeTabId);
  useEffect(() => {
    effectiveActiveTabIdRef.current = activeTabId;
  }, [activeTabId]);
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;
  const activateShortcutRef = useRef(onActivateShortcutTab);
  activateShortcutRef.current = onActivateShortcutTab;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const suppressedKeyUpCodes = new Set<string>();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingKeyEvent(event)) return;
      const matched = matchNavigationShortcutBinding(event, slotsRef.current);
      if (!matched || (matched.action !== 'tabPrev' && matched.action !== 'tabNext')) return;

      if (!canHandleStandaloneRemoteDesktopTabShortcut(event.target, document.activeElement, {
        hasBlockingOverlay: pickerOpenRef.current,
        isComposing: isImeComposingKeyEvent(event),
      })) {
        return;
      }

      const ids = tabIdsRef.current;
      if (ids.length <= 1) return;
      const fromTabId = effectiveActiveTabIdRef.current;
      const currentIndex = ids.indexOf(fromTabId);
      const step = matched.action === 'tabNext' ? 1 : -1;
      const nextTabId = currentIndex < 0
        ? ids[0]
        : (cycleOrderedId(ids, ids[currentIndex], step) ?? ids[0]);

      event.preventDefault();
      event.stopPropagation();
      if (event.code) {
        suppressedKeyUpCodes.add(event.code);
      }
      effectiveActiveTabIdRef.current = nextTabId;
      activateShortcutRef.current(fromTabId, nextTabId);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.code || !suppressedKeyUpCodes.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const onBlur = () => {
      suppressedKeyUpCodes.clear();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      suppressedKeyUpCodes.clear();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);

  return null;
}
