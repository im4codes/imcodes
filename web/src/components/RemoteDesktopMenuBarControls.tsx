import { REMOTE_DESKTOP_MENUBAR_RESTORE_CLASS, REMOTE_DESKTOP_OVERLAY_CLASS } from '../remote-desktop-pointer-overlay.js';

function stopPointerPropagation(event: Event): void {
  event.stopPropagation();
}

export interface RemoteDesktopMenuBarRestoreButtonProps {
  label: string;
  onRestore(): void;
}

/**
 * Unobtrusive floating top-edge pill used to bring back the Remote Desktop
 * menu bar(s) while remaining occluded from remote pointer forwarding.
 */
export function RemoteDesktopMenuBarRestoreButton({
  label,
  onRestore,
}: RemoteDesktopMenuBarRestoreButtonProps) {
  return (
    <button
      type="button"
      class={`${REMOTE_DESKTOP_MENUBAR_RESTORE_CLASS} ${REMOTE_DESKTOP_OVERLAY_CLASS}`}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onRestore();
      }}
      onPointerDown={stopPointerPropagation}
      onPointerUp={stopPointerPropagation}
      onPointerMove={stopPointerPropagation}
      onMouseDown={stopPointerPropagation}
      onMouseUp={stopPointerPropagation}
      onMouseMove={stopPointerPropagation}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5 8 5 5 5-5" />
      </svg>
    </button>
  );
}
