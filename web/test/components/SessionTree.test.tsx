/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { h } from 'preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('../../src/format-label.js', () => ({
  formatLabel: (value: string) => value,
}));

vi.mock('../../src/agent-display.js', () => ({
  getAgentBadgeConfig: () => null,
}));

vi.mock('../../src/hooks/useIdleFlashPlayback.js', () => ({
  useIdleFlashPlayback: () => 0,
}));

vi.mock('../../src/components/IdleFlashLayer.js', () => ({
  IdleFlashLayer: () => null,
}));

import { SessionTree } from '../../src/components/SessionTree.js';

const sessions = [
  {
    name: 'deck_main_brain',
    project: 'main',
    role: 'brain',
    agentType: 'codex-sdk',
    state: 'idle',
  },
] as any;

const subSessions = [
  {
    id: 'sub-1',
    sessionName: 'deck_sub_1',
    label: 'Child session',
    type: 'codex-sdk',
    state: 'idle',
    parentSession: 'deck_main_brain',
  },
] as any;

function renderTree(serverId: string | null = 'srv-1') {
  return render(
    <SessionTree
      serverId={serverId}
      sessions={sessions}
      subSessions={subSessions}
      activeSession={null}
      unreadCounts={new Map()}
      onSelectSession={vi.fn()}
      onSelectSubSession={vi.fn()}
    />,
  );
}

describe('SessionTree', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('restores collapsed state after remount for the same server', () => {
    const first = renderTree('srv-1');
    fireEvent.click(screen.getByTitle('Collapse'));
    expect(screen.queryByText('Child session')).toBeNull();

    first.unmount();
    renderTree('srv-1');

    expect(screen.queryByText('Child session')).toBeNull();
  });

  it('keeps collapsed state scoped per server', () => {
    const first = renderTree('srv-1');
    fireEvent.click(screen.getByTitle('Collapse'));
    expect(localStorage.getItem('rcc_tree_collapsed:srv-1')).toContain('deck_main_brain');
    first.unmount();

    renderTree('srv-2');
    expect(screen.getByText('Child session')).toBeDefined();
    expect(localStorage.getItem('rcc_tree_collapsed:srv-2')).toBeNull();
  });
});
