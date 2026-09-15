/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_ERROR,
  CAPABILITY_FINDING_SEVERITY,
  CAPABILITY_KIND,
  CAPABILITY_SCOPE,
  type CapabilityOperation,
} from '@shared/capability-management.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const capabilityApi = vi.hoisted(() => ({
  list: vi.fn(),
  getOperation: vi.fn(),
  decide: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../src/api/capabilities.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/api/capabilities.js')>();
  return {
    ...original,
    listCapabilities: (...args: unknown[]) => capabilityApi.list(...args),
    getCapabilityOperation: (...args: unknown[]) => capabilityApi.getOperation(...args),
    decideCapabilityOperation: (...args: unknown[]) => capabilityApi.decide(...args),
    cancelCapabilityOperation: (...args: unknown[]) => capabilityApi.cancel(...args),
  };
});

import {
  getCapabilityOperationSnapshot,
  resetCapabilityOperationStoreForTests,
  setCapabilityOperationSnapshot,
} from '../../src/capability-operation-store.js';
import { CapabilityRequestError } from '../../src/api/capabilities.js';
import { CapabilityOperationNotice } from '../../src/components/CapabilityOperationNotice.js';

const queued: CapabilityOperation = {
  id: 'op-ai-1',
  kind: CAPABILITY_KIND.SKILL,
  state: 'queued',
  revision: 1,
  displayName: 'AI installed helper',
  scope: CAPABILITY_SCOPE.ACCOUNT,
  findings: [],
  providers: ['codex'],
  machines: ['server-1'],
  hasScripts: false,
  hasExecutables: false,
  createdAt: 1,
  updatedAt: 1,
};

const awaitingConfirmation: CapabilityOperation = {
  ...queued,
  state: 'awaiting_confirmation',
  revision: 2,
  artifactDigest: 'artifact',
  auditDigest: 'audit',
  findings: [{
    code: 'review',
    severity: CAPABILITY_FINDING_SEVERITY.LOW,
    message: 'Reviewed',
    source: 'auditor',
    blocking: false,
  }],
};

describe('CapabilityOperationNotice', () => {
  beforeEach(() => {
    resetCapabilityOperationStoreForTests();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    for (const mock of Object.values(capabilityApi)) mock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('discovers an AI-created operation globally, polls it, and installs from the card', async () => {
    vi.useFakeTimers();
    capabilityApi.list.mockResolvedValue({ items: [], operations: [queued] });
    capabilityApi.getOperation.mockResolvedValue(awaitingConfirmation);
    let resolveDecision!: (value: CapabilityOperation) => void;
    capabilityApi.decide.mockReturnValue(new Promise((resolve) => { resolveDecision = resolve; }));

    render(<CapabilityOperationNotice serverId="server-1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(capabilityApi.list).toHaveBeenCalledWith('server-1');
    expect(screen.getByText('AI installed helper')).toBeDefined();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(capabilityApi.getOperation).toHaveBeenCalledWith('op-ai-1', 'server-1');
    expect(screen.getByRole('button', { name: 'capabilities.installConfirm' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.installConfirm' }));
    await act(async () => { await Promise.resolve(); });
    expect(capabilityApi.decide).toHaveBeenCalledWith(awaitingConfirmation, 'install', 'server-1');
    expect(screen.getByText('capabilities.state.installing')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'common.cancel' })).toBeNull();
    resolveDecision({ ...awaitingConfirmation, state: 'installing', revision: 3 });
    await act(async () => { await Promise.resolve(); });
  });

  it('cancels a discovered AI-created operation through the authoritative endpoint', async () => {
    capabilityApi.list.mockResolvedValue({ items: [], operations: [queued] });
    capabilityApi.cancel.mockResolvedValue({ ...queued, state: 'cancelled', revision: 2, terminal: true });
    render(<CapabilityOperationNotice serverId="server-1" />);
    await waitFor(() => expect(screen.getByText('AI installed helper')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(capabilityApi.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'op-ai-1', revision: 1, state: 'queued' }),
      'server-1',
    ));
  });

  it('reconciles a cancellation conflict to the server-installed state without showing cancelled', async () => {
    capabilityApi.list.mockResolvedValue({ items: [], operations: [queued] });
    capabilityApi.cancel.mockRejectedValue(new CapabilityRequestError({ status: 409, reason: CAPABILITY_ERROR.CONFLICT }));
    capabilityApi.getOperation.mockResolvedValue({ ...queued, state: 'installed', revision: 3 });
    render(<CapabilityOperationNotice serverId="server-1" />);
    await waitFor(() => expect(screen.getByText('AI installed helper')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(await screen.findByText('capabilities.state.installed')).toBeDefined();
    expect(screen.queryByText('capabilities.state.cancelled')).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.cancel' })).toBeNull();
  });

  it('keeps the highest authoritative revision when an older operation response is replayed', () => {
    setCapabilityOperationSnapshot('server-1', { ...queued, state: 'installed', revision: 5, updatedAt: 5 });
    setCapabilityOperationSnapshot('server-1', { ...queued, state: 'cancelled', revision: 4, updatedAt: 6 });
    expect(getCapabilityOperationSnapshot('server-1')).toMatchObject({ state: 'installed', revision: 5 });
  });
});
