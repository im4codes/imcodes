/**
 * @vitest-environment jsdom
 *
 * Long-lived verification machines have a first-class Quick Input tab. The
 * tab is always visible, includes the active project scope, and inserts the
 * stable registry identity rather than relying on a mutable alias.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerificationMachineProfile } from '../../shared/verification-machine.js';

const mocks = vi.hoisted(() => ({
  listVerificationMachines: vi.fn(),
  setVerificationMachine: vi.fn(),
  aliases: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/hooks/useAliases.js', () => ({
  useAliases: () => ({
    aliases: mocks.aliases, filtered: mocks.aliases, loaded: true, loading: false, error: null,
    refetch: vi.fn(), create: vi.fn(), remove: vi.fn(),
  }),
}));
vi.mock('../src/api/verification-machines.js', () => ({
  listVerificationMachines: mocks.listVerificationMachines,
  setVerificationMachine: mocks.setVerificationMachine,
}));

import { QuickInputPanel } from '../src/components/QuickInputPanel.js';

const profile: VerificationMachineProfile = {
  id: '0123456789abcdef0123456789abcdef',
  scope: 'project',
  scopeKey: 'repo-1',
  alias: 'Windows Lab',
  kind: 'controlled_node',
  target: '1000000001',
  enabled: true,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  lastVerifiedAt: 2,
  lastVerificationStatus: 'verified',
  source: 'web',
};

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onSend: vi.fn(),
    agentType: 'codex-sdk',
    sessionName: 'deck_app_brain',
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    onAddCommand: vi.fn(), onAddPhrase: vi.fn(), onRemoveCommand: vi.fn(), onRemovePhrase: vi.fn(),
    onRemoveHistory: vi.fn(), onRemoveSessionHistory: vi.fn(), onClearHistory: vi.fn(), onClearSessionHistory: vi.fn(),
    machines: [],
    ...over,
  } as any;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.aliases = [];
});

describe('QuickInputPanel verification-machine tab', () => {
  it('is always visible, loads both user and active-project machines, and inserts the stable profile', async () => {
    mocks.listVerificationMachines.mockResolvedValue([profile]);
    const onInsertVerificationMachine = vi.fn();
    const onClose = vi.fn();
    render(<QuickInputPanel {...props({
      projectKey: 'repo-1',
      onInsertVerificationMachine,
      onClose,
    })} />);

    const tab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.tab_verification'))!;
    expect(tab).toBeDefined();
    fireEvent.click(tab);

    await waitFor(() => expect(mocks.listVerificationMachines).toHaveBeenCalledWith('repo-1'));
    await waitFor(() => expect(document.body.textContent).toContain('Windows Lab'));
    expect(document.body.textContent).toContain('1000000001');
    expect(document.body.textContent).toContain('controlled_nodes.verification.status_verified');

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('.qp-machine-item')!);
    expect(onInsertVerificationMachine).toHaveBeenCalledWith(profile);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not list disabled authorizations', async () => {
    mocks.listVerificationMachines.mockResolvedValue([{ ...profile, enabled: false }]);
    render(<QuickInputPanel {...props({ projectKey: 'repo-1', onInsertVerificationMachine: vi.fn() })} />);

    const tab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.tab_verification'))!;
    fireEvent.click(tab);

    await waitFor(() => expect(mocks.listVerificationMachines).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.body.textContent).toContain('quick_input.verification_empty'));
    expect(document.body.textContent).not.toContain('Windows Lab');
  });

  it('authorizes a clicked SSH alias or controlled node without retyping its target', async () => {
    mocks.aliases = [{
      name: '211-gitlab',
      value: 'ssh k@172.16.253.211',
      tags: [],
      createdAt: '',
      updatedAt: '',
      source: 'web',
    }];
    mocks.listVerificationMachines.mockResolvedValue([]);
    mocks.setVerificationMachine.mockResolvedValue(profile);
    render(<QuickInputPanel {...props({
      projectKey: 'repo-1',
      onInsertVerificationMachine: vi.fn(),
      machines: [{
        serverId: 'node-server',
        nodeId: '1000000001',
        displayName: 'Windows Lab',
        online: true,
        execEnabled: true,
      }],
    })} />);

    const tab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.tab_verification'))!;
    fireEvent.click(tab);
    await waitFor(() => expect(mocks.listVerificationMachines).toHaveBeenCalledOnce());

    const aliasButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.verification_authorize_alias'))!;
    fireEvent.click(aliasButton);
    await waitFor(() => expect(mocks.setVerificationMachine).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      scopeKey: 'repo-1',
      alias: '211-gitlab',
      kind: 'ssh',
      target: 'k@172.16.253.211',
    })));

    const nodeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.verification_authorize_node'))!;
    await waitFor(() => expect(nodeButton.disabled).toBe(false));
    fireEvent.click(nodeButton);
    await waitFor(() => expect(mocks.setVerificationMachine).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      scopeKey: 'repo-1',
      alias: 'Windows Lab',
      kind: 'controlled_node',
      target: '1000000001',
    })));
  });
});
