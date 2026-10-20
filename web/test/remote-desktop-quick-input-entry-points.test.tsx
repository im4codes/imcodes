/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';

const fixtures = vi.hoisted(() => {
  const quickData = {
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    recordHistory: vi.fn(),
    addCommand: vi.fn(),
    addPhrase: vi.fn(),
    removeCommand: vi.fn(),
    removePhrase: vi.fn(),
    removeHistory: vi.fn(),
    removeSessionHistory: vi.fn(),
    clearHistory: vi.fn(),
    clearSessionHistory: vi.fn(),
  };
  return {
    quickData,
    panelProps: [] as Array<Record<string, unknown>>,
  };
});

const machine = {
  serverId: 'entry-host',
  refName: 'entry-host',
  displayName: 'Entry host',
  os: 'win',
  online: true,
  execEnabled: true,
  accessRole: 'owner' as const,
  capabilities: [REMOTE_DESKTOP_CAPABILITY],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/api/machines.js', () => ({
  listControllableMachines: vi.fn(async () => [machine]),
}));

vi.mock('../src/components/QuickInputPanel.js', () => ({
  useQuickData: () => fixtures.quickData,
}));

vi.mock('../src/components/RemoteDesktopPanel.js', async () => {
  const { h } = await import('preact');
  return {
    RemoteDesktopPanel: (props: Record<string, unknown>) => {
      fixtures.panelProps.push(props);
      return h('div', {
        'data-testid': 'quick-input-enabled-panel',
        'data-quick-data': props.quickData === fixtures.quickData ? 'shared' : 'missing',
        'data-standalone': String(Boolean(props.standalone)),
        'data-embedded': String(Boolean(props.embedded)),
      });
    },
  };
});

vi.mock('../src/components/FloatingPanel.js', async () => {
  const { h } = await import('preact');
  return { FloatingPanel: ({ children }: { children: unknown }) => h('div', {}, children) };
});

vi.mock('../src/components/RemoteDesktopWall.js', async () => {
  const { h } = await import('preact');
  return {
    RemoteDesktopWall: ({ onOpenHost }: { onOpenHost(value: typeof machine): void }) => h(
      'button',
      { type: 'button', onClick: () => onOpenHost(machine) },
      'open-wall-host',
    ),
  };
});

import { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import { RemoteDesktopStandalone } from '../src/components/RemoteDesktopStandalone.js';
import { RemoteDesktopWallStandalone } from '../src/components/RemoteDesktopWallStandalone.js';
import { RemoteDesktopWorkspace } from '../src/components/RemoteDesktopWorkspace.js';
import {
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
} from '../src/remote-desktop-workspace-state.js';

beforeEach(() => {
  fixtures.panelProps.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('remote desktop quick input entry points', () => {
  it('provides the account QuickInput data to the single standalone window', async () => {
    const rendered = render(<RemoteDesktopStandalone serverId="entry-host" />);
    await waitFor(() => expect(rendered.getByTestId('quick-input-enabled-panel')).toBeDefined());

    const panel = rendered.getByTestId('quick-input-enabled-panel');
    expect(panel.dataset.quickData).toBe('shared');
    // The single popped-out window now hosts the same RemoteDesktopWorkspace
    // the other two entry points below already use (so it can add a second
    // machine via the same "+"), so its panel is `embedded` like theirs --
    // not `standalone`, which was only ever true for the old bare-panel
    // layout this window no longer renders.
    expect(panel.dataset.embedded).toBe('true');
  });

  it('provides the same QuickInput data to every embedded workspace panel', () => {
    const state = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), machine);
    const rendered = render(<RemoteDesktopWorkspace
      state={state}
      manager={new RemoteDesktopConnectionManager()}
      quickData={fixtures.quickData}
      onOpenHost={vi.fn()}
      onActivateTab={vi.fn()}
      onCloseHost={vi.fn()}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
    />);

    const panel = rendered.getByTestId('quick-input-enabled-panel');
    expect(panel.dataset.quickData).toBe('shared');
    expect(panel.dataset.embedded).toBe('true');
  });

  it('keeps the account QuickInput data when a wall standalone opens its workspace', async () => {
    const rendered = render(<RemoteDesktopWallStandalone />);
    act(() => (rendered.getByRole('button', { name: 'open-wall-host' }) as HTMLButtonElement).click());
    await waitFor(() => expect(rendered.getByTestId('quick-input-enabled-panel')).toBeDefined());

    const panel = rendered.getByTestId('quick-input-enabled-panel');
    expect(panel.dataset.quickData).toBe('shared');
    expect(panel.dataset.embedded).toBe('true');
  });
});
