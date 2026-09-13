import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import { useMachines } from '../hooks/useMachines.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import {
  MACHINE_GROUP_DIRECT,
  machineGroupTabs,
  machineGroupsOf,
  machinesInGroup,
} from '../machine-grouping.js';
import { MACHINE_IDENTITY_UNAVAILABLE } from '@shared/machine-reference.js';

export interface ControlledNodeMachineMenuProps {
  /** Element the menu hangs from. Clicks inside it do not count as "outside". */
  anchorRef: { current: HTMLElement | null };
  /** Where focus goes back to when Escape closes the menu. Defaults to the anchor. */
  returnFocusRef?: { current: HTMLElement | null };
  open: boolean;
  onClose(): void;
  /** A selectable row was activated. The menu has already asked to close. */
  onSelect(machine: MachineListItem): void;
  /** Which rows can be picked. Defaults to remote-desktop eligibility. */
  isSelectable?(machine: MachineListItem): boolean;
  /** Tooltip for a row that cannot be picked. Defaults to offline / exec-off. */
  disabledReason?(machine: MachineListItem): string | undefined;
  /** Extra entries rendered above the list (e.g. the sidebar's wall entry). */
  header?: ComponentChildren;
  /** A status line shown above the list (e.g. a host limit). */
  notice?: string;
  /** Accessible label and heading. Defaults to controlled_nodes.machines_title. */
  label?: string;
  emptyText?: string;
  errorText?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"])';

/**
 * The controlled-node machine dropdown, shared by the sidebar launcher and the
 * remote-desktop workspace "+" picker so both look and behave the same.
 *
 * Portalled with fixed positioning. Inside element fullscreen, anything outside
 * the fullscreen element is not painted, so the portal goes into the fullscreen
 * element when it holds the anchor.
 */
export function ControlledNodeMachineMenu(props: ControlledNodeMachineMenuProps) {
  if (!props.open || typeof document === 'undefined') return null;
  return <MachineMenuBody {...props} />;
}

function portalTarget(anchor: HTMLElement | null): Element {
  const fullscreen = document.fullscreenElement;
  if (fullscreen && anchor && fullscreen.contains(anchor)) return fullscreen;
  return document.body;
}

function MachineMenuBody({
  anchorRef,
  returnFocusRef,
  onClose,
  onSelect,
  isSelectable = canOpenRemoteDesktopMachine,
  disabledReason,
  header,
  notice,
  label,
  emptyText,
  errorText,
}: ControlledNodeMachineMenuProps) {
  const { t } = useTranslation();
  const { machines, loaded, error, refetch } = useMachines();
  const [group, setGroup] = useState<string>(MACHINE_GROUP_DIRECT);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [container, setContainer] = useState<Element>(() => portalTarget(anchorRef.current));
  const menuRef = useRef<HTMLDivElement>(null);
  const groups = machineGroupsOf(machines);
  const visible = machinesInGroup(machines, group);
  const title = label ?? t('controlled_nodes.machines_title');

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(360, Math.max(240, viewportWidth - 16));
    // Hang from the anchor's left edge; if that runs off the right side, align
    // the menu's right edge with the anchor's instead.
    let left = rect.left;
    if (left + width > viewportWidth - 8) left = rect.right - width;
    left = Math.max(8, Math.min(left, viewportWidth - width - 8));
    const top = Math.min(rect.bottom + 6, Math.max(8, viewportHeight - 176));
    setPosition({ left, top, width, maxHeight: Math.max(144, viewportHeight - top - 12) });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
    void refetch().catch(() => {});
    // Refetch once per opening (this body only mounts while open), not per render.
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (returnFocusRef ?? anchorRef).current?.focus();
      onClose();
    };
    const reposition = () => updatePosition();
    const onFullscreenChange = () => {
      setContainer(portalTarget(anchorRef.current));
      updatePosition();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorRef, onClose, returnFocusRef, updatePosition]);

  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  const reasonFor = (machine: MachineListItem): string => disabledReason?.(machine)
    ?? (machine.online ? t('controlled_nodes.exec_off') : t('controlled_nodes.offline'));

  if (!position) return null;

  return createPortal(
    <div
      ref={menuRef}
      class="controlled-node-quick-menu"
      role="menu"
      aria-label={title}
      onKeyDown={moveFocus}
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
    >
      <div class="controlled-node-quick-menu-head">
        <span>{title}</span>
        <span class="controlled-node-quick-count">{visible.length}</span>
      </div>
      {/* A team is a group you can share. Picking one here is the same act as
          picking one in the machines tab, so it is the same control. */}
      {groups.length > 0 && (
        <div class="controlled-node-quick-groups" role="none">
          {machineGroupTabs(machines).map(({ id, name, count }) => (
            <button
              key={id}
              type="button"
              role="none"
              class={`controlled-nodes-team-chip${group === id ? ' is-active' : ''}`}
              data-testid={`controlled-node-quick-group-${id}`}
              onClick={() => setGroup(id)}
            >
              {name ?? t(id === MACHINE_GROUP_DIRECT ? 'controlled_nodes.group_direct' : 'controlled_nodes.group_all')}
              <span class="controlled-nodes-team-chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {header}
      {notice && <div class="controlled-node-quick-notice" role="status">{notice}</div>}
      {!loaded && !error && <div class="controlled-node-quick-state">{t('common.loading')}</div>}
      {error != null && machines.length === 0 && (
        <div class="controlled-node-quick-state is-error" role="alert">{errorText ?? t('controlled_nodes.refresh_error')}</div>
      )}
      {loaded && visible.length === 0 && error == null && (
        <div class="controlled-node-quick-state">{emptyText ?? t('controlled_nodes.empty')}</div>
      )}
      {visible.length > 0 && (
        <ul class="controlled-node-quick-list" role="none">
          {visible.map((machine) => {
            const selectable = isSelectable(machine);
            return (
              <li key={machine.serverId} role="none">
                <button
                  type="button"
                  role="menuitem"
                  class={`controlled-node-quick-row${selectable ? '' : ' is-disabled'}`}
                  aria-disabled={selectable ? undefined : 'true'}
                  title={selectable ? undefined : reasonFor(machine)}
                  onClick={() => {
                    if (!selectable) return;
                    onClose();
                    onSelect(machine);
                  }}
                >
                  <span
                    class={`controlled-node-quick-presence ${machine.online ? 'is-online' : 'is-offline'}`}
                    aria-hidden="true"
                  />
                  <span class="controlled-node-quick-identity">
                    <strong>{machine.displayName}</strong>
                    <code>{machine.nodeId ?? MACHINE_IDENTITY_UNAVAILABLE}</code>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    container,
  );
}
