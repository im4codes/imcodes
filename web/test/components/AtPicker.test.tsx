/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

import { AtPicker } from '../../src/components/AtPicker.js';

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function PressKeyDuringOpeningLayout({ keyName }: { keyName: string }) {
  useLayoutEffect(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: keyName,
      bubbles: true,
      cancelable: true,
    }));
  }, [keyName]);
  return null;
}

describe('AtPicker', () => {
  beforeEach(() => {
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderPicker() {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };

    return render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_worker1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_worker2', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_other9', agentType: 'codex', state: 'idle', parentSession: 'deck_other_brain' },
          { name: 'deck_other_brain', agentType: 'claude-code', state: 'idle', parentSession: null },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        onClose={vi.fn()}
        visible
      />,
    );
  }

  it('defaults to files in category chooser', () => {
    renderPicker();

    const filesLabel = screen.getByText('files');
    const agentsLabel = screen.getByText('agents');
    expect(filesLabel).toBeDefined();
    expect(agentsLabel).toBeDefined();
    expect(filesLabel.closest('div')?.getAttribute('data-hl')).toBe('true');
    expect(agentsLabel.closest('div')?.getAttribute('data-hl')).toBeNull();
    expect(screen.getByText('search_project_files')).toBeDefined();
    expect(screen.getByText('delegate_to_agent')).toBeDefined();
  });

  it('does not handle picker keyboard shortcuts while IME composition is active', () => {
    renderPicker();

    const filesLabel = screen.getByText('files');
    const agentsLabel = screen.getByText('agents');

    fireEvent.keyDown(document, { key: 'ArrowDown', isComposing: true, keyCode: 229 });

    expect(filesLabel.closest('div')?.getAttribute('data-hl')).toBe('true');
    expect(agentsLabel.closest('div')?.getAttribute('data-hl')).toBeNull();
  });

  it('keeps one synchronous keyboard listener while rapid navigation updates the highlight', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    try {
      renderPicker();

      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'Enter' });

      expect(screen.getByText('brain')).toBeDefined();
      expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

      cleanup();
      expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it.each([
    ['ArrowDown', 'team'],
    ['ArrowUp', '🖥️'],
  ])('applies the first %s pressed immediately after the picker mounts', (keyName, highlightedText) => {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };

    const { container } = render(
      <>
        <AtPicker
          query=""
          sessions={[]}
          rootSession="deck_proj_brain"
          wsClient={wsClient as any}
          projectDir="/tmp/proj"
          onSelectFile={vi.fn()}
          onSelectAgent={vi.fn()}
          onSelectDelegateAgent={vi.fn()}
          onClose={vi.fn()}
          visible
        />
        <PressKeyDuringOpeningLayout keyName={keyName} />
      </>,
    );

    expect(container.querySelector('[data-hl="true"]')?.textContent).toContain(highlightedText);
  });

  it('applies Enter when it is the first key pressed after mount', () => {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };

    render(
      <>
        <AtPicker
          query=""
          sessions={[]}
          rootSession="deck_proj_brain"
          wsClient={wsClient as any}
          projectDir="/tmp/proj"
          onSelectFile={vi.fn()}
          onSelectAgent={vi.fn()}
          onSelectDelegateAgent={vi.fn()}
          onClose={vi.fn()}
          visible
        />
        <PressKeyDuringOpeningLayout keyName="Enter" />
      </>,
    );

    expect(screen.queryByText('team')).toBeNull();
    expect(screen.getByText(/type_to_search/)).toBeDefined();
  });

  it('shows the current session but greys it out (cannot delegate to self)', () => {
    renderPicker();

    fireEvent.click(screen.getByText('agents'));

    // The active session ("brain", isSelf) stays visible but disabled — a greyed
    // row is clearer than silently dropping it, and it must be non-selectable.
    expect(screen.getByText('brain')).toBeDefined();
    expect(screen.getByText('brain').closest('div')?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('worker1')).toBeDefined();
    expect(screen.getByText('worker2')).toBeDefined();
    expect(screen.queryByText('other9')).toBeNull();
  });

  it('agents step includes SDK transport agents and keeps shell/script out', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onSelectDelegateAgent = vi.fn();

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_worker1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_shell', agentType: 'shell', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_transport', agentType: 'codex-sdk', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_stopped', agentType: 'gemini', state: 'stopped', parentSession: 'deck_proj_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={onSelectDelegateAgent}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('worker1')).toBeDefined();
    expect(screen.getByText('brain').closest('div')?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('shell')).toBeNull();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectDelegateAgent).toHaveBeenCalledWith('deck_sub_worker1');
    onSelectDelegateAgent.mockClear();
    fireEvent.click(screen.getByText('transport'));
    expect(onSelectDelegateAgent).toHaveBeenCalledWith('deck_sub_transport');
    expect(screen.getByText('stopped')).toBeDefined();
    expect(screen.queryByText('All Agents')).toBeNull();
  });

  it('team step shows only combo rows and launches the selected combo', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onSelectAgent = vi.fn();
    const onSelectAllConfig = vi.fn();
    const onLaunchTeam = vi.fn();
    const config = {
      sessions: {
        'deck_sub_w1': { enabled: true, mode: 'audit' },
        'deck_sub_w2': { enabled: true, mode: 'review' },
      },
      rounds: 2,
    };

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_w1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_w2', agentType: 'gemini', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={onSelectAgent}
        onSelectDelegateAgent={vi.fn()}
        onSelectAllConfig={onSelectAllConfig}
        onLaunchTeam={onLaunchTeam}
        p2pConfig={config}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('team'));

    expect(screen.queryByText((_, el) => el?.textContent?.includes('all_label') ?? false)).toBeNull();
    expect(screen.queryByText((_, el) => el?.textContent?.includes('all_plus') ?? false)).toBeNull();
    expect(screen.queryByText((_, el) => el?.textContent?.includes('All Agents') ?? false)).toBeNull();

    fireEvent.click(screen.getByText('audit › review › plan', { selector: 'span' }));
    expect(onLaunchTeam).toHaveBeenCalled();
    expect(onSelectAllConfig).not.toHaveBeenCalled();
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it('Escape from agents step returns to category chooser', () => {
    renderPicker();

    fireEvent.click(screen.getByText('agents'));
    expect(screen.getByText('brain')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByText('files')).toBeDefined();
    expect(screen.getByText('agents')).toBeDefined();
  });

  it('consumes Escape before the chat input can handle it', () => {
    const targetKeyDown = vi.fn();
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };

    render(
      <div>
        <input aria-label="chat input" onKeyDown={targetKeyDown} />
        <AtPicker
          query=""
          sessions={[
            { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null },
            { name: 'deck_sub_worker1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          ]}
          rootSession="deck_proj_brain"
          wsClient={wsClient as any}
          projectDir="/tmp/proj"
          onSelectFile={vi.fn()}
          onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
          onClose={vi.fn()}
          visible
        />
      </div>,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.keyDown(screen.getByLabelText('chat input'), { key: 'Escape' });

    expect(targetKeyDown).not.toHaveBeenCalled();
    expect(screen.getByText('files')).toBeDefined();
    expect(screen.getByText('agents')).toBeDefined();
  });

  it('with p2pConfig, individual agents list shows ALL agents (config only affects @@all)', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_w1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_w2', agentType: 'gemini', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_w3', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'audit' },
            'deck_sub_w2': { enabled: false, mode: 'review' },
            'deck_sub_w3': { enabled: true, mode: 'discuss' },
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));

    // All agents visible regardless of config enabled state
    expect(screen.getByText('w1')).toBeDefined();
    expect(screen.getByText('w2')).toBeDefined();
    expect(screen.getByText('w3')).toBeDefined();
  });

  it('with p2pConfig, agents not in config are still shown individually', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_w1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
          { name: 'deck_sub_w2', agentType: 'gemini', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'audit' },
            // w2 NOT in config — still shown individually
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('w1')).toBeDefined();
    expect(screen.getByText('w2')).toBeDefined();
  });

  it('shows localized empty-state labels in agents step', () => {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_sub_other9', agentType: 'codex', state: 'idle', parentSession: 'deck_other_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    expect(screen.getByText('no_agents_available')).toBeDefined();
    expect(screen.getByText(/← back/i)).toBeDefined();
  });

  it('delegates immediately for a single agent without showing the P2P mode chooser', () => {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };
    const onSelectAgent = vi.fn();
    const onSelectDelegateAgent = vi.fn();

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null },
          { name: 'deck_sub_worker1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={onSelectAgent}
        onSelectDelegateAgent={onSelectDelegateAgent}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('worker1'));

    expect(onSelectDelegateAgent).toHaveBeenCalledWith('deck_sub_worker1');
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(screen.queryByText('Discuss')).toBeNull();
  });

  it('team keyboard launches the highlighted combo with selected rounds', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onLaunchTeam = vi.fn();

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_w1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain', label: 'Cron' },
          { name: 'deck_sub_w2', agentType: 'claude-code', state: 'idle', parentSession: 'deck_proj_brain', label: 'mm0' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        onLaunchTeam={onLaunchTeam}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('team'));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onLaunchTeam).toHaveBeenCalledWith('audit>review>plan', 2);
  });

  it('lists saved custom combos directly in Team', async () => {
    getUserPrefMock.mockResolvedValue(JSON.stringify(['audit>discuss']));
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onLaunchTeam = vi.fn();

    render(
      <AtPicker
        query=""
        sessions={[
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null, isSelf: true },
          { name: 'deck_sub_w1', agentType: 'codex', state: 'idle', parentSession: 'deck_proj_brain', label: 'Cron' },
          { name: 'deck_sub_w2', agentType: 'claude-code', state: 'idle', parentSession: 'deck_proj_brain', label: 'mm0' },
        ]}
        rootSession="deck_proj_brain"
        wsClient={wsClient as any}
        projectDir="/tmp/proj"
        onSelectFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectDelegateAgent={vi.fn()}
        onLaunchTeam={onLaunchTeam}
        onClose={vi.fn()}
        visible
      />,
    );

    await flush();
    fireEvent.click(screen.getByText('team'));
    fireEvent.click(screen.getByText('audit › discuss'));

    expect(onLaunchTeam).toHaveBeenCalledWith('audit>discuss', 1);
  });
});
