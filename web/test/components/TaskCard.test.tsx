/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { TaskCard } from '../../src/components/TaskCard.js';
import type { AutoFixTaskStatus } from '../../src/types.js';

vi.mock('../../src/hooks/useNowTicker.js', () => ({
  useNowTicker: () => 61_000,
}));

afterEach(() => cleanup());

function makeTask(overrides: Partial<AutoFixTaskStatus> = {}): AutoFixTaskStatus {
  return {
    id: 'task-1',
    title: 'Fix flaky coverage job',
    state: 'planning',
    discussionRounds: 1,
    maxDiscussionRounds: 3,
    coderSession: 'deck_alpha_coder',
    auditorSession: 'deck_alpha_auditor',
    branch: 'fix/coverage',
    issueId: '123',
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('TaskCard', () => {
  it('renders compact task metadata and elapsed time', () => {
    render(<TaskCard task={makeTask()} priority={1} />);

    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('P1')).toBeTruthy();
    expect(screen.getByText('#123')).toBeTruthy();
    expect(screen.getByText('Fix flaky coverage job')).toBeTruthy();
    expect(screen.getByText('1m 0s')).toBeTruthy();
  });

  it('expands details and aborts non-terminal tasks without collapsing', () => {
    const onAbort = vi.fn();
    render(<TaskCard task={makeTask({ state: 'implementing' })} priority={0} onAbort={onAbort} />);

    fireEvent.click(screen.getByText('Fix flaky coverage job'));

    expect(screen.getByText('Branch:')).toBeTruthy();
    expect(screen.getByText('fix/coverage')).toBeTruthy();
    expect(screen.getByText('Coder:')).toBeTruthy();
    expect(screen.getByText('deck_alpha_coder')).toBeTruthy();
    expect(screen.getByText('Auditor:')).toBeTruthy();
    expect(screen.getByText('deck_alpha_auditor')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Branch:')).toBeTruthy();
  });

  it('shows retry for failed terminal tasks and hides abort', () => {
    const onAbort = vi.fn();
    const onRetry = vi.fn();
    render(
      <TaskCard
        task={makeTask({ state: 'failed', error: 'audit rejected the patch' })}
        onAbort={onAbort}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByText('Fix flaky coverage job'));

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Error:')).toBeTruthy();
    expect(screen.getByText('audit rejected the patch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });
});
