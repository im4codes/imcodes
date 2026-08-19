/**
 * @vitest-environment jsdom
 *
 * The cron form / history / execution-detail panels are FloatingPanels nested
 * inside the cron window. They used to pass no zIndex, so they fell back to
 * FloatingPanel's default 2000 while the managed window stack runs at 7000+,
 * leaving them trapped in the cron window's stacking context: raising any
 * other window buried the dialog you were editing, and clicking the dialog
 * could not lift its owner back to the front.
 */
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/api.js', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const panelProps: Array<Record<string, any>> = [];
vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: (props: any) => {
    panelProps.push(props);
    return <div data-testid={`panel-${props.id}`} data-zindex={String(props.zIndex)}>{props.children}</div>;
  },
}));

const { CronManager } = await import('../src/pages/CronManager.js');

const sessions: any[] = [
  { name: 'deck_cd_brain', project: 'cd', role: 'brain', agentType: 'claude-code', state: 'idle' },
];

describe('cron nested panels join the owning window band', () => {
  beforeEach(() => {
    panelProps.length = 0;
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ jobs: [], executions: [] });
  });
  afterEach(cleanup);

  it('gives the create form the owner z-index + 1 and raises the owner on focus', async () => {
    const onWindowFocus = vi.fn();
    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        activeSession="deck_cd_brain"
        onBack={vi.fn()}
        windowZIndex={7070}
        onWindowFocus={onWindowFocus}
      />,
    );

    fireEvent.click(await screen.findByTitle('cron.create'));

    const form = await waitFor(() => {
      const found = panelProps.find((p) => p.id === 'cron-form');
      if (!found) throw new Error('cron form panel not rendered');
      return found;
    });

    expect(form.zIndex).toBe(7071);
    form.onFocus?.();
    expect(onWindowFocus).toHaveBeenCalled();
  });
});
