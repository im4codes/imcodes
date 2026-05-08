/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { DesktopWindowMaximizeButton } from '../../src/components/DesktopWindowMaximizeButton.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'window.maximize': 'Maximize',
      'window.restore': 'Restore',
    }[key] ?? key),
  }),
}));

afterEach(() => {
  cleanup();
});

function activateNativeButton(button: HTMLButtonElement, key: 'Enter' | ' '): void {
  button.focus();
  const defaultAllowed = fireEvent.keyDown(button, { key });
  if (defaultAllowed) {
    fireEvent.click(button);
  }
}

describe('DesktopWindowMaximizeButton', () => {
  it('uses localized maximize labels in normal state', () => {
    render(<DesktopWindowMaximizeButton maximized={false} onClick={() => {}} />);

    const button = screen.getByRole('button', { name: 'Maximize' });
    expect(button.getAttribute('title')).toBe('Maximize');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('uses localized restore labels in maximized state', () => {
    render(<DesktopWindowMaximizeButton maximized onClick={() => {}} />);

    const button = screen.getByRole('button', { name: 'Restore' });
    expect(button.getAttribute('title')).toBe('Restore');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('stops chrome gesture events from bubbling while preserving its own handlers', () => {
    const onParentPointerDown = vi.fn();
    const onParentMouseDown = vi.fn();
    const onParentClick = vi.fn();
    const onPointerDown = vi.fn();
    const onMouseDown = vi.fn();
    const onClick = vi.fn();

    render(
      <div onPointerDown={onParentPointerDown} onMouseDown={onParentMouseDown} onClick={onParentClick}>
        <DesktopWindowMaximizeButton
          maximized={false}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onClick={onClick}
        />
      </div>,
    );

    const button = screen.getByRole('button', { name: 'Maximize' });
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    fireEvent.click(button);

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onParentMouseDown).not.toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('is focusable and activates from Enter or Space via native button semantics', () => {
    const onClick = vi.fn();
    render(<DesktopWindowMaximizeButton maximized={false} onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Maximize' }) as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);

    activateNativeButton(button, 'Enter');
    activateNativeButton(button, ' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
