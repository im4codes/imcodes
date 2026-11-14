/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { R2RelayToggle } from '../../src/components/R2RelayToggle.js';
import {
  readFileRelayMode,
  saveFileRelayMode,
  setFileRelayUser,
  setServerR2RelayEnabled,
} from '../../src/r2-relay-preference.js';
import { FILE_RELAY_MODE } from '@shared/r2-relay.js';

describe('R2RelayToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    setFileRelayUser(null);
    setServerR2RelayEnabled(false);
  });

  afterEach(() => {
    cleanup();
    setFileRelayUser(null);
    setServerR2RelayEnabled(false);
  });

  it('renders nothing fail-closed when backend has R2 disabled or user is unset', () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    setFileRelayUser('user-a');
    const first = render(<R2RelayToggle />);
    expect(first.container.querySelector('input[type="checkbox"]')).toBeNull();

    act(() => {
      setServerR2RelayEnabled(true);
    });
    expect(first.container.querySelector('input[type="checkbox"]')).not.toBeNull();

    act(() => {
      setFileRelayUser(null);
    });
    expect(first.container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('hides reactively when server disables R2 and preserves saved opt-in preference when re-enabled', () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    setFileRelayUser('user-a');
    setServerR2RelayEnabled(true);

    const { container } = render(<R2RelayToggle />);
    const checkbox = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox()?.checked).toBe(true);

    act(() => {
      setServerR2RelayEnabled(false);
    });
    expect(checkbox()).toBeNull();
    expect(readFileRelayMode('user-a')).toBe(FILE_RELAY_MODE.R2);

    act(() => {
      setServerR2RelayEnabled(true);
    });
    expect(checkbox()?.checked).toBe(true);
  });

  it('synchronizes checked state across multiple mounted R2RelayToggle instances', () => {
    setFileRelayUser('user-a');
    setServerR2RelayEnabled(true);

    const { container } = render(
      <div>
        <R2RelayToggle />
        <R2RelayToggle />
      </div>,
    );
    const checkboxes = () => Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checkboxes()).toHaveLength(2);
    expect(checkboxes().every((cb) => !cb.checked)).toBe(true);

    fireEvent.click(checkboxes()[0]!);
    expect(checkboxes().every((cb) => cb.checked)).toBe(true);
    expect(readFileRelayMode('user-a')).toBe(FILE_RELAY_MODE.R2);
  });
});
