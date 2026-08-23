import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_KIND, CAPABILITY_SCOPE, CAPABILITY_STATE } from '@shared/capability-management.js';

const apiMock = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  manageCapability: vi.fn(),
}));

vi.mock('../../src/api/capabilities.js', () => ({
  listCapabilities: (...args: unknown[]) => apiMock.listCapabilities(...args),
  manageCapability: (...args: unknown[]) => apiMock.manageCapability(...args),
  CapabilityRequestError: class CapabilityRequestError extends Error {},
}));

const translationMock = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => options
    ? `${key}:${Object.values(options).join(':')}`
    : key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translationMock.t }),
}));

import { CapabilityInventoryPanel } from '../../src/components/CapabilityInventoryPanel.js';

function capability(kind: 'mcp' | 'skill', name: string) {
  return {
    id: `${kind}-1`,
    revision: 7,
    kind,
    name,
    state: CAPABILITY_STATE.ACTIVE,
    scope: CAPABILITY_SCOPE.ACCOUNT,
    version: 2,
    versionId: `${kind}-version-2`,
    sourceLabel: 'example.test',
    readiness: kind === CAPABILITY_KIND.MCP ? 'runtime_pending' : 'ready',
    findings: [],
    tools: kind === CAPABILITY_KIND.MCP ? ['search_docs'] : undefined,
    bindings: [{
      id: `${kind}-binding-1`,
      versionId: `${kind}-version-2`,
      scope: CAPABILITY_SCOPE.PROJECT,
      scopeId: 'github.com/acme/project',
      providers: [],
      machines: [],
      active: true,
    }],
    updatedAt: 1,
  };
}

describe('CapabilityInventoryPanel', () => {
  beforeEach(() => {
    apiMock.listCapabilities.mockResolvedValue({
      items: [capability(CAPABILITY_KIND.MCP, 'Docs MCP'), capability(CAPABILITY_KIND.SKILL, 'Release Skill')],
    });
    apiMock.manageCapability.mockResolvedValue(capability(CAPABILITY_KIND.MCP, 'Docs MCP'));
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists only installed MCP services for the selected server', async () => {
    render(<CapabilityInventoryPanel kind={CAPABILITY_KIND.MCP} serverId="server-1" />);

    expect(await screen.findByText('Docs MCP')).toBeDefined();
    expect(screen.queryByText('Release Skill')).toBeNull();
    expect(screen.getByText('search_docs')).toBeDefined();
    expect(apiMock.listCapabilities).toHaveBeenCalledWith('server-1');
    expect(screen.queryByText('capabilities.askAiAction')).toBeNull();
  });

  it('uses the exact binding for deletion and reloads authoritative inventory', async () => {
    apiMock.listCapabilities
      .mockResolvedValueOnce({ items: [capability(CAPABILITY_KIND.MCP, 'Docs MCP')] })
      .mockResolvedValueOnce({ items: [] });
    render(<CapabilityInventoryPanel kind={CAPABILITY_KIND.MCP} serverId="server-1" />);

    await screen.findByText('Docs MCP');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'sharedContext.management.capabilityInventory.delete' }));
    });

    await waitFor(() => expect(apiMock.manageCapability).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({
        action: 'uninstall',
        bindingId: 'mcp-binding-1',
        scope: CAPABILITY_SCOPE.PROJECT,
        expectedRevision: 7,
      }),
      'server-1',
    ));
    await waitFor(() => expect(screen.queryByText('Docs MCP')).toBeNull());
  });

  it('shows managed Skills in the dedicated inventory and never offers installation controls', async () => {
    render(<CapabilityInventoryPanel kind={CAPABILITY_KIND.SKILL} serverId="server-1" />);

    expect(await screen.findByText('Release Skill')).toBeDefined();
    expect(screen.queryByText('Docs MCP')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'capabilities.askAiLabel' })).toBeNull();
    expect(screen.queryByText('capabilities.showManual')).toBeNull();
  });
});
