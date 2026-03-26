/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

import { AtPicker } from '../../src/components/AtPicker.js';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

describe('AtPicker', () => {
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

  it('with p2pConfig, only shows enabled config sessions in agents list', () => {
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

    // w1 and w3 are enabled — should be visible
    expect(screen.getByText('w1')).toBeDefined();
    expect(screen.getByText('w3')).toBeDefined();
    // w2 is disabled — should NOT be visible
    expect(screen.queryByText('w2')).toBeNull();
  });

  it('sessions not in p2pConfig are excluded (strict mode)', () => {
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
            // w2 NOT in config at all — should be excluded
          },
          rounds: 1,
        }}
        onClose={vi.fn()}
        visible
      />,
    );

    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('w1')).toBeDefined();
    // w2 is not in config — strict mode excludes it
    expect(screen.queryByText('w2')).toBeNull();
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
});
