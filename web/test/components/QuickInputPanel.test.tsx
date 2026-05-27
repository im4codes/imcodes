/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { useState } from 'preact/hooks';

const apiFetchMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'quick_input.tab_quick': 'Quick',
        'quick_input.add_command': 'Add command',
        'quick_input.add_phrase': 'Add phrase',
        'quick_input.clear_history': 'Clear history',
        'quick_input.loading': 'Loading',
        'quick_input.commands': 'Commands',
        'quick_input.phrases': 'Phrases',
        'quick_input.tab_files': 'Files',
        'quick_input.history': 'History',
        'quick_input.this_session': 'This session',
        'quick_input.all': 'All',
        'quick_input.no_history_session': 'No session history',
        'quick_input.no_history': 'No history',
        'quick_input.newer': 'Newer',
        'quick_input.older': 'Older',
        'quick_input.confirm_delete': 'Delete?',
        'quick_input.label_command': 'Command',
        'quick_input.label_phrase': 'Phrase',
        'quick_input.placeholder_phrase': 'phrase',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../src/components/file-browser-lazy.js', async () => {
  const { h } = await import('preact');
  return {
    FileBrowser: (props: { onConfirm: (paths: string[]) => void }) =>
      h('button', { type: 'button', onClick: () => props.onConfirm(['/repo/src/a.ts']) }, 'mock-file-confirm'),
  };
});
vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { QuickInputPanel, useQuickData, __resetQuickDataForTests, type QuickData } from '../../src/components/QuickInputPanel.js';

describe('QuickInputPanel history scope', () => {
  const defaultWidth = window.innerWidth;
  const defaultHeight = window.innerHeight;

  beforeEach(() => {
    apiFetchMock.mockReset();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: defaultWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: defaultHeight });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: defaultWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: defaultHeight });
  });

  it('shows the built-in workflow fixed phrases', () => {
    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="codex-sdk"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'commit&push' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'pull' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CI failed, fix' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'LGTM, commit' })).toBeNull();
  });

  it('opens below the trigger when the quick-input trigger is high in the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({
      x: 248, y: 0, top: 92, left: 248, right: 328, bottom: 120, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchor }}
      />,
    );

    const panel = document.querySelector('.qp') as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('126px');
    expect(panel.style.bottom).toBe('auto'); // must clear CSS default to prevent squeeze
    expect(panel.style.left).toBe('248px');
    expect(panel.style.width).toBe('960px');
    expect(panel.style.maxHeight).toBe('712px');
  });

  it('can toggle from closed to open without dropping the panel render', () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen((prev) => !prev)}>toggle-quick-panel</button>
          <QuickInputPanel
            open={open}
            onClose={() => setOpen(false)}
            onSelect={vi.fn()}
            onSend={vi.fn()}
            agentType="claude-code"
            sessionName="session-a"
            data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
            loaded
            onAddCommand={vi.fn()}
            onAddPhrase={vi.fn()}
            onRemoveCommand={vi.fn()}
            onRemovePhrase={vi.fn()}
            onRemoveHistory={vi.fn()}
            onRemoveSessionHistory={vi.fn()}
            onClearHistory={vi.fn()}
            onClearSessionHistory={vi.fn()}
          />
        </div>
      );
    }

    render(<Wrapper />);
    expect(document.querySelector('.qp')).toBeNull();

    fireEvent.click(screen.getByText('toggle-quick-panel'));

    expect(document.querySelector('.qp')).toBeTruthy();
  });

  it('opens above the trigger when the quick-input trigger is low in the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({
      x: 248, y: 0, top: 700, left: 248, right: 328, bottom: 728, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchor }}
      />,
    );

    const panel = document.querySelector('.qp') as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('auto'); // must clear to prevent squeeze
    expect(panel.style.bottom).toBe('150px');
    expect(panel.style.left).toBe('248px');
    expect(panel.style.width).toBe('960px');
    expect(panel.style.maxHeight).toBe('688px');
  });

  it('never sets both top and bottom to pixel values (would squeeze panel to a thin line)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    // Test with trigger at bottom (open above)
    const anchorBottom = document.createElement('div');
    anchorBottom.getBoundingClientRect = () => ({
      x: 10, y: 0, top: 800, left: 10, right: 90, bottom: 828, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    const { unmount: u1 } = render(
      <QuickInputPanel
        open onClose={vi.fn()} onSelect={vi.fn()} onSend={vi.fn()}
        agentType="claude-code" sessionName="s" loaded
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        onAddCommand={vi.fn()} onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()} onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()} onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()} onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchorBottom }}
      />,
    );
    let panel = document.querySelector('.qp') as HTMLElement;
    // When opening above: bottom is a pixel value, top must be 'auto'
    expect(panel.style.bottom).not.toBe('');
    expect(panel.style.top).toBe('auto');
    // maxHeight must allow real content, not a thin line
    expect(parseInt(panel.style.maxHeight)).toBeGreaterThan(100);
    u1();

    // Test with trigger at top (open below)
    const anchorTop = document.createElement('div');
    anchorTop.getBoundingClientRect = () => ({
      x: 10, y: 0, top: 40, left: 10, right: 90, bottom: 68, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    render(
      <QuickInputPanel
        open onClose={vi.fn()} onSelect={vi.fn()} onSend={vi.fn()}
        agentType="claude-code" sessionName="s" loaded
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        onAddCommand={vi.fn()} onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()} onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()} onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()} onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchorTop }}
      />,
    );
    panel = document.querySelector('.qp') as HTMLElement;
    // When opening below: top is a pixel value, bottom must be 'auto'
    expect(panel.style.top).not.toBe('');
    expect(panel.style.top).not.toBe('auto');
    expect(panel.style.bottom).toBe('auto');
    expect(parseInt(panel.style.maxHeight)).toBeGreaterThan(100);
  });

  it('shows account-wide history when All is selected, including entries from other sessions', () => {
    const data: QuickData = {
      history: ['global shared'],
      sessionHistory: {
        'session-a': ['session a newest'],
        'session-b': ['session b newest', 'session b older'],
      },
      commands: [],
      phrases: [],
    };

    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={data}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('session a newest')).toBeDefined();
    expect(screen.queryByText('session b newest')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.getByText('global shared')).toBeDefined();
    expect(screen.getByText('session a newest')).toBeDefined();
    expect(screen.getByText('session b newest')).toBeDefined();
    expect(screen.getByText('session b older')).toBeDefined();
  });

  it('closes after inserting paths from the Files tab', () => {
    const onClose = vi.fn();
    const onAppendPaths = vi.fn();

    render(
      <QuickInputPanel
        open
        onClose={onClose}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
        ws={{} as never}
        sessionCwd="/repo"
        onAppendPaths={onAppendPaths}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    fireEvent.click(screen.getByText('mock-file-confirm'));

    expect(onAppendPaths).toHaveBeenCalledWith(['@src/a.ts ']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows ten history rows on the first page before paginating', () => {
    const sessionItems = Array.from({ length: 11 }, (_, index) => `session history ${index + 1}`);
    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: { 'session-a': sessionItems }, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('session history 10')).toBeDefined();
    expect(screen.queryByText('session history 11')).toBeNull();
    expect(screen.getByRole('button', { name: 'Older' })).toBeDefined();
  });

  it('removes a custom phrase when its delete action is confirmed', () => {
    const removePhrase = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: ['custom phrase'] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={removePhrase}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const deleteButton = document.querySelector('.qp-pill-custom .qp-pill-del') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(removePhrase).toHaveBeenCalledWith('custom phrase');
    confirmSpy.mockRestore();
  });

  it('removes a custom command when its delete action is confirmed', () => {
    const removeCommand = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: ['/custom'], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={removeCommand}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const deleteButton = document.querySelector('.qp-pill-custom .qp-pill-del') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(removeCommand).toHaveBeenCalledWith('/custom');
    confirmSpy.mockRestore();
  });

  it('replaces a custom phrase when edited and committed', () => {
    const addPhrase = vi.fn();
    const removePhrase = vi.fn();
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: ['custom phrase'] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={addPhrase}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={removePhrase}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const editButton = document.querySelector('.qp-pill-custom .qp-pill-edit') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);

    const input = document.querySelector('.qp-edit-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: 'updated phrase' } });
    fireEvent.keyDown(input!, { key: 'Enter' });

    expect(removePhrase).toHaveBeenCalledWith('custom phrase');
    expect(addPhrase).toHaveBeenCalledWith('updated phrase');
  });

  it('replaces a custom command when edited and committed', () => {
    const addCommand = vi.fn();
    const removeCommand = vi.fn();
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: ['/custom'], phrases: [] }}
        loaded
        onAddCommand={addCommand}
        onAddPhrase={vi.fn()}
        onRemoveCommand={removeCommand}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const editButton = document.querySelector('.qp-pill-custom .qp-pill-edit') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);

    const input = document.querySelector('.qp-edit-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: '/updated' } });
    fireEvent.keyDown(input!, { key: 'Enter' });

    expect(removeCommand).toHaveBeenCalledWith('/custom');
    expect(addCommand).toHaveBeenCalledWith('/updated');
  });

  it('uses explicit default commands for copilot-sdk instead of the claude fallback', () => {
    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="copilot-sdk"
        sessionName="session-copilot"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const commandPills = Array.from(document.querySelectorAll('.qp-section-header + .qp-pills .qp-pill-default')).map((el) => el.textContent?.trim());
    expect(commandPills).toContain('/clear');
    expect(commandPills).toContain('/model');
    expect(commandPills).toContain('/thinking');
    expect(commandPills).toContain('/compact');
  });

  it('uses explicit default commands for cursor-headless instead of the claude fallback', () => {
    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="cursor-headless"
        sessionName="session-cursor"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const commandPills = Array.from(document.querySelectorAll('.qp-section-header + .qp-pills .qp-pill-default')).map((el) => el.textContent?.trim());
    expect(commandPills).toContain('/clear');
    expect(commandPills).toContain('/model');
    expect(commandPills).toContain('/compact');
    expect(commandPills).not.toContain('/thinking');
  });
});

describe('useQuickData persistence guard', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetQuickDataForTests();
    vi.useRealTimers();
    cleanup();
  });

  function Harness() {
    const quick = useQuickData();
    return (
      <div>
        <div data-testid="loaded">{String(quick.loaded)}</div>
        <div data-testid="history">{quick.data.history.join(',')}</div>
        <div data-testid="session-history">{(quick.data.sessionHistory.deck_proj_brain ?? []).join(',')}</div>
        <div data-testid="commands">{quick.data.commands.join(',')}</div>
        <div data-testid="phrases">{quick.data.phrases.join(',')}</div>
        <button onClick={() => quick.addCommand('/custom')}>add-command</button>
        <button onClick={() => quick.addPhrase('continue')}>add-phrase</button>
        <button onClick={() => quick.recordHistory('local history', 'deck_proj_brain')}>record-history</button>
        <button onClick={() => quick.removeCommand('/missing')}>remove-missing-command</button>
        <button onClick={() => quick.removePhrase('missing')}>remove-missing-phrase</button>
      </div>
    );
  }

  it('shares one GET across multiple hook consumers', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: ['/server'], phrases: [] } });
    render(<><Harness /><Harness /></>);
    await waitFor(() => expect(screen.getAllByTestId('loaded').every((el) => el.textContent === 'true')).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('commands')[0].textContent).toBe('/server');
  });

  it('merges pre-hydration local mutations with server hydration', async () => {
    let resolveGet!: (value: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveGet = resolve; }));
    render(<Harness />);
    fireEvent.click(screen.getByText('add-command'));
    fireEvent.click(screen.getByText('record-history'));
    await act(async () => {
      resolveGet({
        data: {
          history: ['server history'],
          sessionHistory: { deck_proj_brain: ['server session history'] },
          commands: ['/server'],
          phrases: [],
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('commands').textContent).toContain('/server'));
    expect(screen.getByTestId('commands').textContent).toContain('/custom');
    expect(screen.getByTestId('history').textContent).toContain('local history');
    expect(screen.getByTestId('history').textContent).toContain('server history');
    expect(screen.getByTestId('session-history').textContent).toContain('local history');
    expect(screen.getByTestId('session-history').textContent).toContain('server session history');
  });

  it('normalizes partial quick-data responses to empty defaults', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { commands: ['/server'] } });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    expect(screen.getByTestId('commands').textContent).toBe('/server');
    expect(screen.getByTestId('history').textContent).toBe('');
    expect(screen.getByTestId('session-history').textContent).toBe('');
    expect(screen.getByTestId('phrases').textContent).toBe('');
  });

  it('installs one visibility listener and performs one warm refresh for multiple consumers', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    let resolveRefresh!: (value: unknown) => void;
    apiFetchMock
      .mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: ['/old'], phrases: [] } })
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));

    render(<><Harness /><Harness /></>);
    await waitFor(() => expect(screen.getAllByTestId('commands')[0].textContent).toBe('/old'));
    expect(addSpy.mock.calls.filter((call) => call[0] === 'visibilitychange')).toHaveLength(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(screen.getAllByTestId('commands')[0].textContent).toBe('/old');
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRefresh({ data: { history: [], sessionHistory: {}, commands: ['/new'], phrases: [] } });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByTestId('commands')[0].textContent).toBe('/new'));
    addSpy.mockRestore();
  });

  it('does not fetch on visibility restore when no quick-data consumers are subscribed', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: ['/old'], phrases: [] } });
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('commands').textContent).toBe('/old'));
    view.unmount();
    apiFetchMock.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('shares mutations across hook consumers', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
    render(<><Harness /><Harness /></>);
    await waitFor(() => expect(screen.getAllByTestId('loaded').every((el) => el.textContent === 'true')).toBe(true));

    fireEvent.click(screen.getAllByText('add-command')[0]);
    fireEvent.click(screen.getAllByText('add-phrase')[0]);

    await waitFor(() => expect(screen.getAllByTestId('commands').every((el) => el.textContent === '/custom')).toBe(true));
    expect(screen.getAllByTestId('phrases').every((el) => el.textContent === 'continue')).toBe(true);
  });

  it('persists an added phrase after hydration through one debounced PUT', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
    apiFetchMock.mockResolvedValueOnce({ ok: true });

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    fireEvent.click(screen.getByText('add-phrase'));
    await waitFor(() => expect(screen.getByTestId('phrases').textContent).toBe('continue'));
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/quick-data', {
      method: 'PUT',
      body: JSON.stringify({
        data: {
          history: [],
          sessionHistory: {},
          commands: [],
          phrases: ['continue'],
        },
      }),
    });
  });

  it('does not schedule a PUT for no-op mutations', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: ['/custom'], phrases: [] } });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('commands').textContent).toBe('/custom'));

    fireEvent.click(screen.getByText('add-command'));
    fireEvent.click(screen.getByText('remove-missing-command'));
    fireEvent.click(screen.getByText('remove-missing-phrase'));
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears debounced saves and singleton cache in the quick-data reset helper', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } })
      .mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: ['/after-reset'], phrases: [] } });
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    fireEvent.click(screen.getByText('add-command'));
    __resetQuickDataForTests();
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('commands').textContent).toBe('/after-reset'));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not PUT quick-data after the initial GET fails', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    fireEvent.click(screen.getByText('add-command'));
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(screen.getByTestId('commands').textContent).toBe('/custom');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/quick-data');
  });

  it('still PUTs quick-data after a successful initial hydration', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
    apiFetchMock.mockResolvedValueOnce({ ok: true });

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    fireEvent.click(screen.getByText('add-command'));
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/quick-data');
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/quick-data', {
      method: 'PUT',
      body: JSON.stringify({
        data: {
          history: [],
          sessionHistory: {},
          commands: ['/custom'],
          phrases: [],
        },
      }),
    });
  });

  // Regression: a visibility-driven invalidate() that resolved before the
  // 2-second debounce fired used to overwrite the optimistic resource value
  // with stale server data, erasing the user's just-added phrase from the
  // UI. The pending-adds tracker re-layers unsaved additions onto every
  // server response so the phrase survives the refresh.
  it('preserves an optimistic phrase across a visibility-triggered refresh before the debounce fires', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
    let resolveRefresh!: (value: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    apiFetchMock.mockResolvedValueOnce({ ok: true });

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));

    // User adds a phrase — optimistic resource update + 2s debounced PUT scheduled.
    fireEvent.click(screen.getByText('add-phrase'));
    await waitFor(() => expect(screen.getByTestId('phrases').textContent).toBe('continue'));

    // Visibility refresh fires before the 2s debounce elapses.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(apiFetchMock).toHaveBeenCalledTimes(2); // GET + invalidate-GET

    // Server returns its older snapshot (without the new phrase).
    await act(async () => {
      resolveRefresh({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
      await Promise.resolve();
    });

    // Bug repro point: phrase must still be visible after the refresh.
    expect(screen.getByTestId('phrases').textContent).toBe('continue');

    // The debounced PUT eventually persists the phrase to the server.
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock).toHaveBeenNthCalledWith(3, '/api/quick-data', {
      method: 'PUT',
      body: JSON.stringify({
        data: {
          history: [],
          sessionHistory: {},
          commands: [],
          phrases: ['continue'],
        },
      }),
    });
  });

  // Regression: closing the tab (or pagehide) inside the debounce window
  // used to drop the pending PUT entirely. The flush handler now fires the
  // save synchronously with fetch keepalive so the addition reaches the
  // server even if the user reloads or closes the tab immediately.
  it('flushes a pending save with keepalive on pagehide', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } });
    apiFetchMock.mockResolvedValueOnce({ ok: true });

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));

    fireEvent.click(screen.getByText('add-phrase'));
    await waitFor(() => expect(screen.getByTestId('phrases').textContent).toBe('continue'));

    // Tab is hidden / closing — flush before the 2s debounce fires.
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/quick-data', {
      method: 'PUT',
      body: JSON.stringify({
        data: {
          history: [],
          sessionHistory: {},
          commands: [],
          phrases: ['continue'],
        },
      }),
      keepalive: true,
    });

    // The flush already cleared the debounce timer, so no second PUT.
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
