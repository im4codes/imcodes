/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { TeamDiscussionGuide } from '../src/components/TeamDiscussionGuide.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('TeamDiscussionGuide', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('anchors a one-time callout to the Team discussion button', async () => {
    const onDismiss = vi.fn();
    const target = document.createElement('button');
    target.setAttribute('data-onboarding', 'p2p-mode');
    target.getBoundingClientRect = () => ({
      top: 520,
      left: 440,
      width: 86,
      height: 28,
      right: 526,
      bottom: 548,
      x: 440,
      y: 520,
      toJSON: () => ({}),
    });
    document.body.appendChild(target);

    render(<TeamDiscussionGuide open onDismiss={onDismiss} />);

    await waitFor(() => expect(screen.getByTestId('team-discussion-guide')).toBeTruthy());
    expect(screen.getByText('onboarding.team_discussion_guide.title')).toBeTruthy();
    expect(screen.getByText('onboarding.team_discussion_guide.body_2')).toBeTruthy();

    fireEvent.click(screen.getByText('onboarding.team_discussion_guide.dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stays hidden until the Team button exists', () => {
    render(<TeamDiscussionGuide open onDismiss={vi.fn()} />);

    expect(screen.queryByTestId('team-discussion-guide')).toBeNull();
  });
});
