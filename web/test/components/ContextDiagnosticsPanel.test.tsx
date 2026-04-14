/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const listTeamsMock = vi.fn();
const getSharedContextDiagnosticsMock = vi.fn();
const getRuntimeAuthoredContextMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  listTeams: (...args: unknown[]) => listTeamsMock(...args),
  getSharedContextDiagnostics: (...args: unknown[]) => getSharedContextDiagnosticsMock(...args),
  getRuntimeAuthoredContext: (...args: unknown[]) => getRuntimeAuthoredContextMock(...args),
}));

import { ContextDiagnosticsPanel } from '../../src/components/ContextDiagnosticsPanel.js';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ContextDiagnosticsPanel', () => {
  beforeEach(() => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', name: 'Acme', role: 'owner' }]);
    getSharedContextDiagnosticsMock.mockResolvedValue({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      enrollmentId: 'enr-1',
      remoteProcessedFreshness: 'fresh',
      visibilityState: 'active',
      retrievalMode: 'shared_active',
      policy: {
        allowDegradedProviderSupport: true,
        allowLocalFallback: false,
        requireFullProviderSupport: false,
      },
      diagnostics: {
        derivedOnDemand: true,
        persistedSnapshotAvailable: false,
        activeBindingCount: 1,
        appliedDocumentVersionIds: ['ver-1'],
      },
    });
    getRuntimeAuthoredContextMock.mockResolvedValue([
      {
        bindingId: 'bind-1',
        documentVersionId: 'ver-1',
        mode: 'required',
        scope: 'project_shared',
        content: 'Use strict types.',
        active: true,
        superseded: false,
      },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads live diagnostics and runtime authored bindings', async () => {
    render(<ContextDiagnosticsPanel enterpriseId="team-1" canonicalRepoId="github.com/acme/repo" />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('sharedContext.diagnostics.load'));
    });

    await waitFor(() => expect(getSharedContextDiagnosticsMock).toHaveBeenCalledWith('team-1', 'github.com/acme/repo', {
      workspaceId: undefined,
      enrollmentId: undefined,
      language: undefined,
      filePath: undefined,
    }));
    expect(screen.getByText(/shared_active/)).toBeDefined();
    expect((await screen.findAllByText(/fresh/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Use strict types\./)).toBeDefined();
  });

  it('renders optional persisted snapshot details', async () => {
    render(
      <ContextDiagnosticsPanel
        enterpriseId="team-1"
        canonicalRepoId="github.com/acme/repo"
        persistedSnapshot={{
          label: 'shadow-1',
          diagnostics: {
            enterpriseId: 'team-1',
            canonicalRepoId: 'github.com/acme/repo',
            enrollmentId: 'enr-1',
            remoteProcessedFreshness: 'stale',
            visibilityState: 'active',
            retrievalMode: 'cleanup_only',
            policy: {
              allowDegradedProviderSupport: false,
              allowLocalFallback: false,
              requireFullProviderSupport: true,
            },
            diagnostics: {
              derivedOnDemand: false,
              persistedSnapshotAvailable: true,
              activeBindingCount: 1,
              appliedDocumentVersionIds: ['ver-9'],
            },
          },
          bindings: [],
        }}
      />,
    );
    await flush();
    expect(screen.getByText(/shadow-1/)).toBeDefined();
    expect(screen.getByText(/cleanup_only/)).toBeDefined();
  });
});
