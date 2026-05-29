/**
 * @vitest-environment jsdom
 */
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

// t() returns the key so assertions are language-agnostic; saveUserPref is a noop.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));
vi.mock('../src/api.js', () => ({ saveUserPref: vi.fn().mockResolvedValue(undefined) }));

import { StartDiscussionDialog } from '../src/components/StartDiscussionDialog.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function startButton(container: HTMLElement): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button'))
    .find((b) => b.textContent?.includes('discussion.start_button'));
  if (!btn) throw new Error('start button not found');
  return btn as HTMLButtonElement;
}

describe('StartDiscussionDialog — App-owned start (9.2)', () => {
  it('dispatches onStartRequested at most once for a rapid double-click (synchronous guard)', () => {
    const onStartRequested = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        onClose={onClose}
        existingSessions={[]}
        defaultCwd="/work/app"
      />,
    );

    fireEvent.input(container.querySelector('textarea')!, { target: { value: 'Should we ship v2?' } });
    const btn = startButton(container);
    // Two synchronous clicks before the dialog unmounts (onClose is a noop here).
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(onStartRequested).toHaveBeenCalledTimes(1);
    expect(onStartRequested).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'Should we ship v2?', cwd: '/work/app' }),
    );
    // App (not the dialog) mints the requestId — the payload carries none.
    expect(onStartRequested.mock.calls[0][0]).not.toHaveProperty('requestId');
  });

  it('does not dispatch when the topic is blank', () => {
    const onStartRequested = vi.fn();
    const { container } = render(
      <StartDiscussionDialog onStartRequested={onStartRequested} onClose={vi.fn()} existingSessions={[]} />,
    );
    fireEvent.click(startButton(container)); // empty topic → guarded no-op
    expect(onStartRequested).not.toHaveBeenCalled();
  });
});
