/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
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
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle', parentSession: null },
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
    expect(screen.getByText('quick_discussion_with_agent')).toBeDefined();
  });

  it('shows only same-domain agents in agents step', () => {
    renderPicker();

    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('brain')).toBeDefined();
    expect(screen.getByText('worker1')).toBeDefined();
    expect(screen.getByText('worker2')).toBeDefined();
    expect(screen.queryByText('other9')).toBeNull();
  });

  it('Escape from agents step returns to category chooser', () => {
    renderPicker();

    fireEvent.click(screen.getByText('agents'));
    expect(screen.getByText('brain')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByText('files')).toBeDefined();
    expect(screen.getByText('agents')).toBeDefined();
    expect(screen.queryByText('brain')).toBeNull();
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
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    expect(screen.getByText('no_agents_available')).toBeDefined();
    expect(screen.getByText(/← back/i)).toBeDefined();
  });

  it('passes the selected mode for a single agent', () => {
    const wsClient = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };
    const onSelectAgent = vi.fn();

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
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('worker1'));
    fireEvent.click(screen.getByText('Discuss'));

    expect(onSelectAgent).toHaveBeenCalledWith('deck_sub_worker1', 'discuss');
  });

  it('all + custom rounds applies the selected mode override to all configured participants', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onSelectAllConfig = vi.fn();

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
        onSelectAllConfig={onSelectAllConfig}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'audit' },
            'deck_sub_w2': { enabled: true, mode: 'review' },
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent?.includes('all_plus') ?? false)));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'BUTTON' && el?.textContent === 'mode_audit'));
    fireEvent.click(screen.getByText('3'));

    expect(onSelectAllConfig).toHaveBeenCalledTimes(1);
    const [cfg, rounds, modeOverride] = onSelectAllConfig.mock.calls[0];
    expect(rounds).toBe(3);
    expect(modeOverride).toBe('audit');
    expect(cfg.sessions['deck_sub_w1'].mode).toBe('audit');
    expect(cfg.sessions['deck_sub_w2'].mode).toBe('audit');
  });

  it('all + custom rounds preview shows the selected mode override for all participants', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };

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
        onSelectAllConfig={vi.fn()}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'review' },
            'deck_sub_w2': { enabled: true, mode: 'discuss' },
          },
          rounds: 2,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent?.includes('all_plus') ?? false)));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'BUTTON' && el?.textContent === 'mode_audit'));

    expect(screen.getByText((_, el) => el?.textContent === 'Cron')).toBeDefined();
    expect(screen.getByText((_, el) => el?.textContent === 'mm0')).toBeDefined();
    expect(screen.getAllByText((_, el) => el?.textContent?.includes('· audit') ?? false).length).toBeGreaterThanOrEqual(2);
  });

  it('all + custom rounds keyboard defaults focus to rounds, then up/down switches focus to mode', () => {
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onSelectAllConfig = vi.fn();

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
        onSelectAllConfig={onSelectAllConfig}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'review' },
            'deck_sub_w2': { enabled: true, mode: 'discuss' },
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent?.includes('all_plus') ?? false)));

    fireEvent.keyDown(document, { key: 'ArrowRight' }); // rounds: 1 -> 2
    fireEvent.keyDown(document, { key: 'ArrowUp' }); // focus: rounds -> mode
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // mode: config -> audit
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onSelectAllConfig).toHaveBeenCalledTimes(1);
    const [cfg, rounds, modeOverride] = onSelectAllConfig.mock.calls[0];
    expect(rounds).toBe(2);
    expect(modeOverride).toBe('audit');
    expect(cfg.sessions['deck_sub_w1'].mode).toBe('audit');
    expect(cfg.sessions['deck_sub_w2'].mode).toBe('audit');
  });

  it('reuses the shared combo manager to select saved custom combos', async () => {
    getUserPrefMock.mockResolvedValue(JSON.stringify(['audit>discuss']));
    const wsClient = { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) };
    const onSelectAllConfig = vi.fn();

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
        onSelectAllConfig={onSelectAllConfig}
        p2pConfig={{
          sessions: {
            'deck_sub_w1': { enabled: true, mode: 'review' },
            'deck_sub_w2': { enabled: true, mode: 'review' },
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    await flush();
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent?.includes('all_plus') ?? false)));
    fireEvent.click(screen.getByText('mode_audit→mode_discuss'));

    expect(onSelectAllConfig).toHaveBeenCalledTimes(1);
    const [cfg, rounds, modeOverride] = onSelectAllConfig.mock.calls[0];
    expect(rounds).toBe(2);
    expect(modeOverride).toBe('audit>discuss');
    expect(cfg.sessions['deck_sub_w1'].mode).toBe('audit');
    expect(cfg.sessions['deck_sub_w2'].mode).toBe('audit');
  });
});
