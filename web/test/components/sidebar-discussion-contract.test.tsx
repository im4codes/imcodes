/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

const saveUserPrefMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('../../src/components/LanguageSwitcher.js', () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));

vi.mock('../../src/api.js', () => ({
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(globalThis, '__BUILD_TIME__', {
    configurable: true,
    value: '2026-05-11T02:34:00.000Z',
  });
});

afterEach(() => cleanup());

function pinPanelDataTransfer(payload: unknown) {
  return {
    types: ['application/x-pinpanel'],
    dropEffect: 'copy',
    getData: vi.fn(() => JSON.stringify(payload)),
  };
}

function changeSelect(select: HTMLElement, value: string): void {
  const element = select as HTMLSelectElement;
  element.value = value;
  for (const option of Array.from(element.options)) {
    option.selected = option.value === value;
  }
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

describe('Sidebar contract', () => {
  it('restores width, resizes with mouse and touch, handles panel drops, and persists collapsed state', async () => {
    const { Sidebar, loadSidebarCollapsed, saveSidebarCollapsed } = await import('../../src/components/Sidebar.js');
    const onDropPanel = vi.fn();
    localStorage.setItem('sidebar_width_srv-1', '320');

    const { container, rerender } = render(
      <Sidebar collapsed={false} serverId="srv-1" onDropPanel={onDropPanel}>
        <div>Servers</div>
      </Sidebar>,
    );

    const panel = container.querySelector('.sidebar-panel') as HTMLElement;
    expect(panel.style.width).toBe('320px');
    expect(screen.getByText('Servers')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();

    const dragData = pinPanelDataTransfer({ type: 'terminal', id: 'deck_alpha_brain' });
    fireEvent.dragOver(panel, { dataTransfer: dragData });
    expect(dragData.dropEffect).toBe('move');
    fireEvent.dragEnter(panel, { dataTransfer: dragData });
    expect(screen.getByText('sidebar.drop_to_pin')).toBeTruthy();
    fireEvent.drop(panel, { dataTransfer: dragData });
    expect(onDropPanel).toHaveBeenCalledWith('terminal', 'deck_alpha_brain');

    const mouseHandle = container.querySelector('.sidebar-resize-handle') as HTMLElement;
    fireEvent.mouseDown(mouseHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 220 });
    fireEvent.mouseUp(document, { clientX: 220 });
    expect(localStorage.getItem('sidebar_width_srv-1')).toBe('440');

    const touchHandle = container.querySelector('.sidebar-resize-grip') as HTMLElement;
    fireEvent.touchStart(touchHandle, { touches: [{ clientX: 220 }] });
    fireEvent.touchMove(document, { touches: [{ clientX: 20 }] });
    fireEvent.touchEnd(document, { changedTouches: [{ clientX: 20 }] });
    expect(localStorage.getItem('sidebar_width_srv-1')).toBe('240');

    saveSidebarCollapsed(true);
    expect(loadSidebarCollapsed()).toBe(true);
    saveSidebarCollapsed(false);
    expect(loadSidebarCollapsed()).toBe(false);

    rerender(
      <Sidebar collapsed={true} serverId="srv-1" onDropPanel={onDropPanel}>
        <div>Servers</div>
      </Sidebar>,
    );
    expect((container.querySelector('.sidebar-content') as HTMLElement).style.display).toBe('none');
  });
});

describe('StartDiscussionDialog contract', () => {
  it('saves preferences and submits a mixed new/reused-session discussion via onStartRequested', async () => {
    const { StartDiscussionDialog } = await import('../../src/components/StartDiscussionDialog.js');
    const onStartRequested = vi.fn();
    const onClose = vi.fn();

    render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        defaultCwd="/repo"
        existingSessions={[
          { sessionName: 'deck_sub_existing', label: 'Existing reviewer', type: 'gemini' },
        ]}
        savedPrefs={{
          participants: [
            { roleId: 'critic', agentType: 'gemini', model: 'opus[1M]', sessionName: 'deck_sub_existing' },
            { roleId: 'custom', customRoleLabel: 'QA', customRolePrompt: 'Find regressions', agentType: 'codex' },
          ],
          verdictIdx: 1,
          maxRounds: 5,
        }}
        onClose={onClose}
      />,
    );

    // Header title and footer button now use t() keys (mock returns the key).
    expect(screen.getByText('discussion.dialog_title')).toBeTruthy();
    expect(screen.getByDisplayValue('/repo')).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('discussion.topic_placeholder'), {
      target: { value: 'Ship the file preview worker safely' },
    });

    fireEvent.click(screen.getByText('discussion.add_participant'));
    expect(screen.getAllByText('discussion.arbiter')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'discussion.start_button' }));

    expect(saveUserPrefMock).toHaveBeenCalledWith('discussion_prefs', {
      participants: [
        { roleId: 'critic', customRoleLabel: undefined, customRolePrompt: undefined, agentType: 'gemini', model: 'opus[1M]' },
        { roleId: 'custom', customRoleLabel: 'QA', customRolePrompt: 'Find regressions', agentType: 'codex', model: undefined },
        { roleId: 'pragmatist', customRoleLabel: undefined, customRolePrompt: undefined, agentType: 'claude-code', model: 'sonnet' },
      ],
      verdictIdx: 1,
      maxRounds: 5,
    });
    expect(onStartRequested).toHaveBeenCalledWith({
      topic: 'Ship the file preview worker safely',
      cwd: '/repo',
      participants: [
        { agentType: 'gemini', model: 'opus[1M]', roleId: 'critic', roleLabel: undefined, rolePrompt: undefined, sessionName: 'deck_sub_existing' },
        { agentType: 'codex', model: undefined, roleId: 'custom', roleLabel: 'QA', rolePrompt: 'Find regressions', sessionName: undefined },
        { agentType: 'claude-code', model: 'sonnet', roleId: 'pragmatist', roleLabel: undefined, rolePrompt: undefined, sessionName: undefined },
      ],
      maxRounds: 5,
      verdictIdx: 1,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards double-submit so onStartRequested dispatches exactly once', async () => {
    const { StartDiscussionDialog } = await import('../../src/components/StartDiscussionDialog.js');
    const onStartRequested = vi.fn();
    const onClose = vi.fn();

    render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        existingSessions={[]}
        onClose={onClose}
      />,
    );

    const startButton = screen.getByRole('button', { name: 'discussion.start_button' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);

    fireEvent.input(screen.getByPlaceholderText('discussion.topic_placeholder'), {
      target: { value: 'Compare two approaches' },
    });
    expect(startButton.disabled).toBe(false);

    // Two rapid clicks must dispatch only once (synchronous in-flight guard).
    fireEvent.click(startButton);
    fireEvent.click(startButton);
    expect(onStartRequested).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports role removal, agent switches, and overlay close', async () => {
    const { StartDiscussionDialog } = await import('../../src/components/StartDiscussionDialog.js');
    const onStartRequested = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        existingSessions={[]}
        onClose={onClose}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('discussion.topic_placeholder'), {
      target: { value: 'Compare two approaches' },
    });

    fireEvent.click(screen.getByText('discussion.add_participant'));
    fireEvent.click(screen.getAllByText('✕')[1]);
    expect(screen.getAllByText('discussion.arbiter')).toHaveLength(1);

    const comboboxes = screen.getAllByRole('combobox');
    changeSelect(comboboxes[2], 'gemini');
    expect(screen.getAllByDisplayValue('Sonnet').length).toBeGreaterThan(0);

    const overlay = container.querySelector('.dialog-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
