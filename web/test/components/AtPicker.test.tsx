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
          { name: 'deck_proj_brain', agentType: 'claude-code', state: 'idle' },
          { name: 'deck_proj_worker1', agentType: 'codex', state: 'idle' },
          { name: 'deck_other_worker9', agentType: 'codex', state: 'idle' },
          { name: 'deck_other_brain', agentType: 'claude-code', state: 'idle' },
        ]}
        mainSession="deck_proj"
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
    expect(screen.queryByText('worker9')).toBeNull();
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
          { name: 'deck_other_worker9', agentType: 'codex', state: 'idle' },
        ]}
        mainSession="deck_proj"
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
