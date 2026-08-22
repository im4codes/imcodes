import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import { useMachines } from '../hooks/useMachines.js';
import { canOpenRemoteDesktop } from './RemoteDesktopPanel.js';

interface ControlledNodeQuickMenuProps {
  onOpenRemoteDesktop(machine: MachineListItem): void;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * Compact controlled-node launcher for the desktop sidebar.
 *
 * The management button remains responsible for enrollment/settings. This
 * split-button menu is deliberately read-only: it lists every accessible node
 * and jumps straight into remote control without opening the management panel.
 */
export function ControlledNodeQuickMenu({ onOpenRemoteDesktop }: ControlledNodeQuickMenuProps) {
  const { t } = useTranslation();
  const { machines, loaded, loading, error, refetch } = useMachines();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const anchor = rootRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(360, Math.max(240, viewportWidth - 16));
    const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    const top = Math.min(rect.bottom + 6, Math.max(8, viewportHeight - 176));
    setPosition({ left, top, width, maxHeight: Math.max(144, viewportHeight - top - 12) });
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    updatePosition();
    setOpen(true);
    void refetch().catch(() => {});
  }, [close, open, refetch, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    const reposition = () => updatePosition();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [close, open, updatePosition]);

  const menu = open && position && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuRef}
      class="controlled-node-quick-menu"
      role="menu"
      aria-label={t('controlled_nodes.machines_title')}
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
    >
      <div class="controlled-node-quick-menu-head">
        <span>{t('controlled_nodes.machines_title')}</span>
        <span class="controlled-node-quick-count">{machines.length}</span>
      </div>
      {!loaded && loading && <div class="controlled-node-quick-state">{t('common.loading')}</div>}
      {loaded && error && machines.length === 0 && (
        <div class="controlled-node-quick-state is-error">{t('controlled_nodes.refresh_error')}</div>
      )}
      {loaded && machines.length === 0 && !error && (
        <div class="controlled-node-quick-state">{t('controlled_nodes.empty')}</div>
      )}
      {machines.length > 0 && (
        <ul class="controlled-node-quick-list">
          {machines.map((machine) => {
            const available = canOpenRemoteDesktop(machine);
            return (
              <li key={machine.serverId} class="controlled-node-quick-row" role="none">
                <span
                  class={`controlled-node-quick-presence ${machine.online ? 'is-online' : 'is-offline'}`}
                  aria-hidden="true"
                />
                <span class="controlled-node-quick-identity">
                  <strong>{machine.displayName}</strong>
                  <code>{machine.refName}</code>
                </span>
                <button
                  type="button"
                  class="controlled-node-quick-remote"
                  role="menuitem"
                  disabled={!available}
                  title={available ? t('remote_desktop.open') : (machine.online
                    ? t('controlled_nodes.exec_off')
                    : t('controlled_nodes.offline'))}
                  onClick={() => {
                    close();
                    onOpenRemoteDesktop(machine);
                  }}
                >
                  <span aria-hidden="true">🖥</span>
                  {t('remote_desktop.open')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={rootRef} class="controlled-nodes-shortcut">
        <button
          ref={triggerRef}
          type="button"
          class="btn controlled-nodes-quick-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('controlled_nodes.machines_title')}
          title={t('controlled_nodes.machines_title')}
          onClick={toggle}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      {menu}
    </>
  );
}
