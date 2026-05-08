import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';

interface DesktopWindowMaximizeButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children' | 'title'> {
  maximized: boolean;
}

function stopWindowChromePropagation(event: Event): void {
  event.stopPropagation();
}

export function DesktopWindowMaximizeButton({
  maximized,
  class: className = 'subsession-minimize-btn',
  type = 'button',
  onPointerDown,
  onMouseDown,
  onClick,
  ...buttonProps
}: DesktopWindowMaximizeButtonProps) {
  const { t } = useTranslation();
  const label = maximized ? t('window.restore') : t('window.maximize');

  return (
    <button
      {...buttonProps}
      type={type}
      class={className}
      title={label}
      aria-label={label}
      onPointerDown={(event) => {
        stopWindowChromePropagation(event);
        onPointerDown?.(event);
      }}
      onMouseDown={(event) => {
        stopWindowChromePropagation(event);
        onMouseDown?.(event);
      }}
      onClick={(event) => {
        stopWindowChromePropagation(event);
        onClick?.(event);
      }}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </span>
    </button>
  );
}

function MaximizeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">
      <path d="M5.2 2.7H2.8v2.4" />
      <path d="M10.8 2.7h2.4v2.4" />
      <path d="M13.2 10.9v2.4h-2.4" />
      <path d="M5.2 13.3H2.8v-2.4" />
      <path d="M2.9 5.1 5.4 2.6" />
      <path d="M10.6 2.6 13.1 5.1" />
      <path d="M13.1 10.9 10.6 13.4" />
      <path d="M5.4 13.4 2.9 10.9" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">
      <rect x="3.2" y="5.2" width="7.6" height="7.6" rx="1.2" />
      <path d="M5.2 3.2h6.2c.8 0 1.4.6 1.4 1.4v6.2" />
    </svg>
  );
}
