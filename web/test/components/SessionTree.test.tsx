/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { h } from 'preact';
import { act } from 'preact/test-utils';

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
import { revealExecutionCloneGroup } from '../../src/execution-clone-ui.js';

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

  it('collapses sub-sessions by default on initial render and shows Expand all', () => {
    renderTree('srv-1');

    expect(screen.queryByText('Child session')).toBeNull();
    const toggleBtn = screen.getByTitle('Expand');
    expect(toggleBtn.textContent).toBe('▸');
    expect(screen.getByTitle('Expand all')).toBeDefined();
  });

  it('keeps newly added main sessions collapsed by default even when an existing session is expanded', () => {
    const { rerender } = renderTree('srv-1');
    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByText('Child session')).toBeDefined();

    const nextSessions = [
      ...sessions,
      {
        name: 'deck_w1_agent',
        project: 'w1',
        role: 'worker',
        agentType: 'claude-code',
        state: 'idle',
      },
    ] as any;
    const nextSubs = [
      ...subSessions,
      {
        id: 'sub-2',
        sessionName: 'deck_sub_2',
        label: 'Worker child',
        type: 'claude-code',
        state: 'idle',
        parentSession: 'deck_w1_agent',
      },
    ] as any;

    rerender(
      <SessionTree
        serverId="srv-1"
        sessions={nextSessions}
        subSessions={nextSubs}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(screen.getByText('Child session')).toBeDefined();
    expect(screen.queryByText('Worker child')).toBeNull();
  });

  it('restores expanded state after remount for the same server', () => {
    const first = renderTree('srv-1');
    expect(screen.queryByText('Child session')).toBeNull();

    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByText('Child session')).toBeDefined();

    first.unmount();
    renderTree('srv-1');

    expect(screen.getByText('Child session')).toBeDefined();
    expect(screen.getByTitle('Collapse')).toBeDefined();
  });

  it('keeps expanded state scoped per server across remount and server switches', () => {
    const first = renderTree('srv-1');
    fireEvent.click(screen.getByTitle('Expand'));
    expect(localStorage.getItem('rcc_tree_expanded:srv-1')).toContain('deck_main_brain');
    first.unmount();

    const second = renderTree('srv-2');
    expect(screen.queryByText('Child session')).toBeNull();
    expect(localStorage.getItem('rcc_tree_expanded:srv-2')).toBeNull();

    // Direct serverId prop switch back to srv-1 restores srv-1 expanded state
    second.rerender(
      <SessionTree
        serverId="srv-1"
        sessions={sessions}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );
    expect(screen.getByText('Child session')).toBeDefined();

    // Switching back to srv-2 remains collapsed by default
    second.rerender(
      <SessionTree
        serverId="srv-2"
        sessions={sessions}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );
    expect(screen.queryByText('Child session')).toBeNull();
  });

  it('toggles all sessions with Expand all and Collapse all and persists per server', () => {
    const multiSessions = [
      ...sessions,
      {
        name: 'deck_w1_agent',
        project: 'w1',
        role: 'worker',
        agentType: 'claude-code',
        state: 'idle',
      },
    ] as any;
    const multiSubs = [
      ...subSessions,
      {
        id: 'sub-2',
        sessionName: 'deck_sub_2',
        label: 'Worker child',
        type: 'claude-code',
        state: 'idle',
        parentSession: 'deck_w1_agent',
      },
    ] as any;

    render(
      <SessionTree
        serverId="srv-1"
        sessions={multiSessions}
        subSessions={multiSubs}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(screen.queryByText('Child session')).toBeNull();
    expect(screen.queryByText('Worker child')).toBeNull();

    fireEvent.click(screen.getByTitle('Expand all'));
    expect(screen.getByText('Child session')).toBeDefined();
    expect(screen.getByText('Worker child')).toBeDefined();
    expect(screen.getByTitle('Collapse all')).toBeDefined();
    expect(localStorage.getItem('rcc_tree_expanded:srv-1')).toContain('deck_main_brain');
    expect(localStorage.getItem('rcc_tree_expanded:srv-1')).toContain('deck_w1_agent');

    fireEvent.click(screen.getByTitle('Collapse all'));
    expect(screen.queryByText('Child session')).toBeNull();
    expect(screen.queryByText('Worker child')).toBeNull();
    expect(screen.getByTitle('Expand all')).toBeDefined();
    expect(localStorage.getItem('rcc_tree_expanded:srv-1')).toBe('[]');
  });

  it('does not wipe persisted expanded state when sessions are temporarily empty during loading', () => {
    localStorage.setItem('rcc_tree_expanded:srv-1', JSON.stringify(['deck_main_brain']));

    const { rerender } = render(
      <SessionTree
        serverId="srv-1"
        sessions={[]}
        subSessions={[]}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(localStorage.getItem('rcc_tree_expanded:srv-1')).toBe(JSON.stringify(['deck_main_brain']));

    rerender(
      <SessionTree
        serverId="srv-1"
        sessions={sessions}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(screen.getByText('Child session')).toBeDefined();
  });

  it('preserves persisted expanded state when switching to a server that initially renders a non-empty partial cached subset before full sessions arrive', () => {
    localStorage.setItem('rcc_tree_expanded:srv-2', JSON.stringify(['deck_main_brain']));

    const { rerender } = renderTree('srv-1');
    expect(screen.queryByText('Child session')).toBeNull();

    const cachedIncogSubset = [
      {
        name: 'deck_incog_brain',
        project: 'incog',
        role: 'brain',
        agentType: 'codex-sdk',
        state: 'idle',
      },
    ] as any;

    // Step 1: Switch to srv-2 while only cached incognito sessions have arrived (non-empty partial subset).
    rerender(
      <SessionTree
        serverId="srv-2"
        sessions={cachedIncogSubset}
        subSessions={[]}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(localStorage.getItem('rcc_tree_expanded:srv-2')).toBe(JSON.stringify(['deck_main_brain']));

    // Step 2: Full server session list arrives including deck_main_brain.
    rerender(
      <SessionTree
        serverId="srv-2"
        sessions={[...cachedIncogSubset, ...sessions]}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    expect(localStorage.getItem('rcc_tree_expanded:srv-2')).toBe(JSON.stringify(['deck_main_brain']));
    expect(screen.getByText('Child session')).toBeDefined();
  });

  it('gracefully defaults to collapsed without crashing when localStorage throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      renderTree('srv-restricted');
      expect(screen.queryByText('Child session')).toBeNull();
      fireEvent.click(screen.getByTitle('Expand'));
      expect(screen.getByText('Child session')).toBeDefined();
      fireEvent.click(screen.getByTitle('Collapse'));
      expect(screen.queryByText('Child session')).toBeNull();
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('groups execution clones under a collapsed per-run section instead of flat rows', () => {
    const withClones = [
      ...subSessions,
      {
        id: 'clone-1',
        sessionName: 'deck_sub_clone1',
        label: 'Worker clone A',
        type: 'codex-sdk',
        state: 'running',
        parentSession: 'deck_main_brain',
        executionCloneKind: 'execution_clone',
        parentRunId: 'run-abcdef123456',
      },
    ] as any;
    render(
      <SessionTree
        serverId="srv-clone"
        sessions={sessions}
        subSessions={withClones}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );

    // Parent is collapsed by default.
    expect(screen.queryByText('Child session')).toBeNull();
    expect(screen.queryByText('Worker clone A')).toBeNull();

    // Expand parent to reveal ordinary sub-session and collapsed clone group.
    fireEvent.click(screen.getByTitle('Expand'));

    // The ordinary sub-session renders flat.
    expect(screen.getByText('Child session')).toBeDefined();
    // The clone is hidden by default (group collapsed) — NOT a flat peer.
    expect(screen.queryByText('Worker clone A')).toBeNull();
    // The group header is shown. The test translator does not interpolate, so
    // the label renders the raw fallback string; query by that.
    const groupHeader = screen.getByText('Execution workers (run {{run}})');
    expect(groupHeader).toBeDefined();

    // Expanding the group (click its toggle) reveals the clone node.
    fireEvent.click(groupHeader.closest('button')!);
    expect(screen.getByText('Worker clone A')).toBeDefined();
  });

  it('reveals the exact clone group after its launch ack even when the parent is collapsed by default', () => {
    const parentRunId = 'generic-execution-command-123';
    const withClones = [
      ...subSessions,
      {
        id: 'clone-acked',
        sessionName: 'deck_sub_clone_acked',
        label: 'Acked worker clone',
        type: 'codex-sdk',
        state: 'running',
        parentSession: 'deck_main_brain',
        executionCloneKind: 'execution_clone',
        parentRunId,
      },
    ] as any;
    render(
      <SessionTree
        serverId="srv-clone"
        sessions={sessions}
        subSessions={withClones}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
      />,
    );
    expect(screen.queryByText('Child session')).toBeNull();
    expect(screen.queryByText('Acked worker clone')).toBeNull();

    act(() => revealExecutionCloneGroup({
      ownerSessionName: 'deck_main_brain',
      parentRunId,
    }));

    expect(screen.getByText('Acked worker clone')).toBeDefined();
    expect(screen.getByText('Execution workers (run {{run}})').closest('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('selects main session and sub-session immediately on a single click without requiring double tap', () => {
    const onSelectSession = vi.fn();
    const onSelectSubSession = vi.fn();
    render(
      <SessionTree
        serverId="srv-1"
        sessions={sessions}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={onSelectSession}
        onSelectSubSession={onSelectSubSession}
      />,
    );

    // 1. Single click on main session button dispatches immediately on tap 1
    const mainNode = screen.getByText('main').closest('button')!;
    expect(mainNode).toBeDefined();
    expect(mainNode.getAttribute('type')).toBe('button');
    fireEvent.click(mainNode);
    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith('deck_main_brain');

    // Expand sub-sessions
    fireEvent.click(screen.getByTitle('Expand'));
    const subNode = screen.getByText('Child session').closest('button')!;
    expect(subNode).toBeDefined();
    expect(subNode.getAttribute('type')).toBe('button');

    // 2. Single click on sub-session button dispatches immediately on tap 1
    fireEvent.click(subNode);
    expect(onSelectSubSession).toHaveBeenCalledTimes(1);
    expect(onSelectSubSession).toHaveBeenCalledWith(subSessions[0]);
  });

  it('renders all session tree action buttons with type="button" to prevent form submit side effects', () => {
    const onNewSession = vi.fn();
    const onNewSubSession = vi.fn();
    render(
      <SessionTree
        serverId="srv-1"
        sessions={sessions}
        subSessions={subSessions}
        activeSession={null}
        unreadCounts={new Map()}
        onSelectSession={vi.fn()}
        onSelectSubSession={vi.fn()}
        onNewSession={onNewSession}
        onNewSubSession={onNewSubSession}
      />,
    );

    const buttons = document.querySelectorAll('.session-tree button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});
