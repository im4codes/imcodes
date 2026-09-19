import { useCallback, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import { openRemoteDesktopWindow } from '../remote-desktop-window.js';
import { ControlledNodeMachineMenu } from './ControlledNodeMachineMenu.js';

interface ControlledNodeQuickMenuProps {
  onOpenRemoteDesktop?(machine: MachineListItem): void;
  onOpenRemoteDesktopWall?(): void;
}

/**
 * Compact controlled-node launcher for the desktop sidebar.
 *
 * The management button remains responsible for enrollment/settings. This
 * split-button menu is deliberately read-only: it lists every accessible node
 * and jumps straight into remote control without opening the management panel.
 */
export function ControlledNodeQuickMenu({ onOpenRemoteDesktop, onOpenRemoteDesktopWall }: ControlledNodeQuickMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

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
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      <ControlledNodeMachineMenu
        anchorRef={rootRef}
        returnFocusRef={triggerRef}
        open={open}
        onClose={close}
        onSelect={(machine) => onOpenRemoteDesktop?.(machine)}
        onOpenInWindow={(machine) => { openRemoteDesktopWindow(machine.serverId); }}
        titleAction={onOpenRemoteDesktopWall && (
          <button
            type="button"
            class="controlled-node-quick-wall"
            role="menuitem"
            aria-label={t('remote_desktop.wall_short_title')}
            onClick={() => { close(); onOpenRemoteDesktopWall(); }}
          >{t('remote_desktop.wall_short_title')}</button>
        )}
      />
    </>
  );
}
