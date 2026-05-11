/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { IssueQueue } from '../../src/components/IssueQueue.js';
import { ServerList } from '../../src/components/ServerList.js';
import { StatsBar } from '../../src/components/StatsBar.js';
import type { TrackerIssue } from '../../src/types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function issue(overrides: Partial<TrackerIssue> & { id: string; priority: TrackerIssue['priority'] }): TrackerIssue {
  return {
    id: overrides.id,
    title: overrides.title ?? `Issue ${overrides.id}`,
    body: overrides.body ?? '',
    priority: overrides.priority,
    labels: overrides.labels ?? [],
    url: overrides.url ?? `https://example.test/issues/${overrides.id}`,
    state: overrides.state ?? 'open',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...overrides,
  };
}

describe('AutoFix dashboard widgets', () => {
  it('renders stats with success rate and rounded average duration', () => {
    render(<StatsBar total={12} active={2} completed={10} failed={2} avgDurationMs={90 * 60_000} />);

    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getAllByText('2')).toHaveLength(2);
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Success Rate')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('Avg Duration')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();
  });

  it('renders empty, current, queued, and completed issue states', () => {
    const issues = [
      issue({ id: 'high', priority: 0, title: 'Patch production crash', labels: ['bug'] }),
      issue({ id: 'current', priority: 1, title: 'Audit current patch', labels: ['review'] }),
      issue({ id: 'low', priority: 3, title: 'Polish logs' }),
    ];

    const { rerender } = render(<IssueQueue issues={[]} currentIssueId={null} completedIssues={[]} />);
    expect(screen.getByText('No issues in queue.')).toBeTruthy();

    rerender(
      <IssueQueue
        issues={issues}
        currentIssueId="current"
        completedIssues={[
          { id: 'done', success: true },
          { id: 'high', success: false },
        ]}
      />,
    );

    expect(screen.getByText('Completed:')).toBeTruthy();
    expect(screen.getByText('Failed:')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Audit current patch')).toBeTruthy();
    expect(screen.getByText('IN PROGRESS')).toBeTruthy();
    expect(screen.getByText('Queue (1)')).toBeTruthy();
    expect(screen.getByText('Polish logs')).toBeTruthy();
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(screen.getByText('FAIL')).toBeTruthy();
    expect(screen.getByText('Unknown issue')).toBeTruthy();
  });

  it('shows server online state and only connects selectable devices', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00Z'));
    const onSelectServer = vi.fn();

    const { rerender } = render(<ServerList servers={[]} onSelectServer={onSelectServer} />);
    expect(screen.getByText(/No devices yet/)).toBeTruthy();

    rerender(
      <ServerList
        onSelectServer={onSelectServer}
        servers={[
          {
            id: 'srv-online',
            name: 'Online Box',
            status: 'online',
            lastHeartbeatAt: Date.now() - 1_000,
            createdAt: Date.UTC(2026, 4, 1),
          },
          {
            id: 'srv-stale',
            name: 'Stale Box',
            status: 'online',
            lastHeartbeatAt: Date.now() - 10 * 60_000,
            createdAt: Date.UTC(2026, 4, 2),
          },
        ]}
      />,
    );

    expect(screen.getByText(/Online$/)).toBeTruthy();
    expect(screen.getByText(/Offline$/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onSelectServer).toHaveBeenCalledWith('srv-online', 'Online Box');
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(1);
  });
});
