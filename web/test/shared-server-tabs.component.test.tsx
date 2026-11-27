/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedEntrySummary } from '../src/api.js';
import { SessionTabs } from '../src/components/SessionTabs.js';
import { SessionTree } from '../src/components/SessionTree.js';
import type { SubSession } from '../src/hooks/useSubSessions.js';
import {
  buildSharedServerSubSessionStates,
  findSharedEntryForServerTab,
  mergeSharedServerSessions,
  mergeSharedServerSubSessions,
  resolveRestrictedSubSessionClick,
} from '../src/shared-server-tabs.js';
import type { SessionInfo } from '../src/types.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (key === 'share.indicator.viewer') return 'Read-only shared viewer';
      if (key === 'share.indicator.participant') return 'Shared participant';
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function SharedServerHarness({ onOpen }: { onOpen: (entry: SharedEntrySummary) => void }) {
  const entries: SharedEntrySummary[] = [
    {
      id: 'share-a',
      serverId: 'srv-shared',
      serverName: 'Remote Host',
      role: 'participant',
      status: 'active',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_alpha_brain' },
      targetLabel: 'Alpha App',
      sessionState: 'running',
      agentType: 'claude-code',
    },
    {
      id: 'share-b',
      serverId: 'srv-shared',
      serverName: 'Remote Host',
      role: 'viewer',
      status: 'active',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
      targetLabel: 'Beta Service',
      sessionState: 'idle',
      agentType: 'codex-sdk',
    },
    {
      id: 'share-sub',
      serverId: 'srv-shared',
      serverName: 'Remote Host',
      role: 'participant',
      status: 'active',
      target: { kind: 'subsession', serverId: 'srv-shared', subSessionId: 'sub99' },
      targetLabel: 'Beta Worker Sub',
      agentType: 'shell',
      parentSessionName: 'deck_beta_brain',
    },
  ];

  const [activeEntry, setActiveEntry] = useState<SharedEntrySummary>(entries[0]!);
  const [liveSessions, setLiveSessions] = useState<SessionInfo[]>([
    {
      name: 'deck_alpha_brain',
      project: 'alpha',
      role: 'brain',
      agentType: 'claude-code',
      state: 'running',
      label: 'Alpha App',
    },
  ]);

  const mergedSessions = mergeSharedServerSessions({
    serverId: 'srv-shared',
    isOwnedServer: false,
    activeTarget: activeEntry.target,
    sharedEntries: entries,
    liveSessions,
  });
  const mergedSubSessions = mergeSharedServerSubSessions({
    serverId: 'srv-shared',
    isOwnedServer: false,
    activeTarget: activeEntry.target,
    sharedEntries: entries,
    liveSubSessions: [],
  });
  const subStates = buildSharedServerSubSessionStates({
    serverId: 'srv-shared',
    isOwnedServer: false,
    activeTarget: activeEntry.target,
    sharedEntries: entries,
    subSessions: mergedSubSessions,
    baseStates: new Map(),
    activeDispatchIds: new Map(),
  });

  const activeSession = activeEntry.target.kind === 'main'
    ? activeEntry.target.sessionName
    : 'deck_beta_brain';

  const switchToEntry = (entry: SharedEntrySummary) => {
    onOpen(entry);
    setActiveEntry(entry);
    // Simulate narrow WS session_list that returns only the active target session
    if (entry.target.kind === 'main') {
      const targetName = entry.target.sessionName;
      setLiveSessions([
        {
          name: targetName,
          project: targetName.includes('beta') ? 'beta' : 'alpha',
          role: 'brain',
          agentType: entry.agentType || 'unknown',
          state: (entry.sessionState as SessionInfo['state']) || 'idle',
          label: entry.targetLabel,
        },
      ]);
    }
  };

  return (
    <div>
      <SessionTabs
        sessions={mergedSessions}
        activeSession={activeSession}
        sessionsLoaded
        pinned={new Set()}
        setPinnedArr={() => {}}
        onSelect={(name) => {
          const entry = findSharedEntryForServerTab(entries, 'srv-shared', name, mergedSubSessions);
          if (entry) switchToEntry(entry);
        }}
        onStopProject={() => {}}
        onRestartProject={() => {}}
      />
      <SessionTree
        serverId="srv-shared"
        sessions={mergedSessions}
        subSessions={mergedSubSessions}
        sharedSubSessionStates={subStates}
        activeSession={activeSession}
        unreadCounts={new Map()}
        onSelectSession={(name) => {
          const entry = findSharedEntryForServerTab(entries, 'srv-shared', name, mergedSubSessions);
          if (entry) switchToEntry(entry);
        }}
        onSelectSubSession={(sub: SubSession) => {
          const plan = resolveRestrictedSubSessionClick({
            entries,
            serverId: 'srv-shared',
            isOwnedServer: false,
            activeTarget: activeEntry.target,
            activeEntryId: activeEntry.id,
            subSessionId: sub.id,
            subSessions: mergedSubSessions,
          });
          if (plan.action === 'open') switchToEntry(plan.entry);
        }}
      />
    </div>
  );
}

describe('shared server merged tabs and sub-session tree navigation', () => {
  it('renders all shared main and subsession targets together and preserves sibling tabs on switch', () => {
    const opened: SharedEntrySummary[] = [];
    render(<SharedServerHarness onOpen={(entry) => opened.push(entry)} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Alpha App'),
      expect.stringContaining('Beta Service'),
    ]);

    // Click sibling tab Beta Service despite narrow live session update returning only Beta
    fireEvent.click(tabs[1]!);
    expect(opened.map((e) => e.id)).toEqual(['share-b']);

    // Both sibling tabs remain visible in SessionTabs after narrow switch
    const tabsAfterSwitch = screen.getAllByRole('tab');
    expect(tabsAfterSwitch).toHaveLength(2);
    expect(tabsAfterSwitch[1]?.getAttribute('aria-selected')).toBe('true');

    // Expand tree node and click sibling sub-session inside SessionTree
    fireEvent.click(screen.getByTitle('Expand'));
    const subButton = screen.getByText('Beta Worker Sub');
    fireEvent.click(subButton);
    expect(opened.map((e) => e.id)).toEqual(['share-b', 'share-sub']);

    // Verify per-tab role indicators show participant on Alpha and viewer on Beta
    expect(tabsAfterSwitch[0]?.textContent).toContain('Alpha App');
    expect(tabsAfterSwitch[1]?.textContent).toContain('Beta Service');
  });
});
