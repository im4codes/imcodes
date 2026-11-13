/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/preact';

const apiMocks = vi.hoisted(() => ({
  listDocumentShares: vi.fn(),
  createDocumentShareApi: vi.fn(),
  updateDocumentShareApi: vi.fn(),
  revokeDocumentShareApi: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key;
      const suffix = Object.entries(vars)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `${key}(${suffix})`;
    },
  }),
}));

vi.mock('../../src/api.js', () => ({
  listDocumentShares: apiMocks.listDocumentShares,
  createDocumentShareApi: apiMocks.createDocumentShareApi,
  updateDocumentShareApi: apiMocks.updateDocumentShareApi,
  revokeDocumentShareApi: apiMocks.revokeDocumentShareApi,
}));

import { DocShareDialog } from '../../src/components/DocShareDialog.js';
import type { DocumentShareItem, ServerDocGroup } from '../../src/api.js';

function makeShare(overrides: Partial<DocumentShareItem> = {}): DocumentShareItem {
  return {
    id: 'share-1',
    serverId: 'srv-1',
    targetKind: 'file',
    targetPath: '/docs/spec.docx',
    label: 'spec.docx',
    shareMode: 'team',
    targetUserId: 'team:team-bound',
    targetTeamId: 'team-bound',
    targetTeamName: 'Ops Group',
    participantLabel: null,
    deviceLockEnabled: false,
    boundDeviceHash: null,
    role: 'viewer',
    allowDownload: true,
    expiresAt: null,
    revokedAt: null,
    createdBy: 'owner-1',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DocShareDialog Controlled Node Group sharing & async guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createDocumentShareApi.mockResolvedValue({ share: makeShare({ id: 'created-1' }) });
    apiMocks.updateDocumentShareApi.mockResolvedValue({ share: makeShare({ role: 'editor' }) });
    apiMocks.revokeDocumentShareApi.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('displays bound group badges, supports selecting an unbound global group with targetTeamId, edits/revokes group & legacy * rules', async () => {
    const groups: ServerDocGroup[] = [
      { id: 'team-bound', name: 'Ops Group', memberCount: 3, boundToServer: true },
      { id: 'team-global', name: 'Design Global', memberCount: 5, boundToServer: false },
    ];
    const groupShare = makeShare({
      id: 'share-group-a',
      targetUserId: 'team:team-bound',
      targetTeamId: 'team-bound',
      targetTeamName: 'Ops Group',
      role: 'viewer',
      allowDownload: true,
    });
    const legacyShare = makeShare({
      id: 'share-legacy',
      targetUserId: '*',
      targetTeamId: undefined,
      targetTeamName: undefined,
      role: 'editor',
      allowDownload: false,
    });

    apiMocks.listDocumentShares.mockResolvedValue({
      shares: [groupShare, legacyShare],
      groups,
    });

    render(
      <DocShareDialog
        serverId="srv-1"
        targetPath="/docs/spec.docx"
        targetKind="file"
        onClose={vi.fn()}
        onOpenNodeGroups={vi.fn()}
      />,
    );

    const badge = await screen.findByTestId('doc-share-bound-group-badge');
    expect(badge.textContent).toContain('Ops Group');
    expect(badge.textContent).toContain('count=3');

    const groupSelect = screen.getByTestId('doc-share-group-select') as HTMLSelectElement;
    expect(groupSelect.value).toBe('team-bound');
    expect(screen.queryByTestId('doc-share-unbound-group-hint')).toBeNull();

    // Switch to unbound global group -> shows unbound hint & submits targetTeamId
    fireEvent.change(groupSelect, { target: { value: 'team-global' } });
    expect(screen.getByTestId('doc-share-unbound-group-hint')).toBeTruthy();

    fireEvent.change(screen.getByTestId('doc-share-group-role'), { target: { value: 'editor' } });
    fireEvent.click(screen.getByTestId('doc-share-group-download')); // toggle false
    fireEvent.click(screen.getByTestId('doc-share-add-group-btn'));

    await waitFor(() => {
      expect(apiMocks.createDocumentShareApi).toHaveBeenCalledWith('srv-1', {
        targetKind: 'file',
        targetPath: '/docs/spec.docx',
        shareMode: 'team',
        targetTeamId: 'team-global',
        role: 'editor',
        allowDownload: false,
      });
    });

    // Existing group rule + legacy * rule are both rendered independently
    const ruleItems = screen.getAllByTestId('doc-share-group-rule-item');
    expect(ruleItems).toHaveLength(2);
    expect(ruleItems[0].textContent).toContain('Ops Group');
    expect(ruleItems[1].textContent).toContain('doc_share.legacy_all_members');

    // Update role on group rule & revoke legacy wildcard rule
    const firstRuleSelect = ruleItems[0].querySelector('select')!;
    fireEvent.change(firstRuleSelect, { target: { value: 'editor' } });
    await waitFor(() => {
      expect(apiMocks.updateDocumentShareApi).toHaveBeenCalledWith('srv-1', 'share-group-a', { role: 'editor' });
    });

    const revokeBtn = within(ruleItems[1]).getByText('doc_share.revoke');
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      expect(apiMocks.revokeDocumentShareApi).toHaveBeenCalledWith('srv-1', 'share-legacy');
    });
  });

  it('handles legacy API responses missing groups safely and wires empty-group manage button to onClose + onOpenNodeGroups', async () => {
    apiMocks.listDocumentShares.mockResolvedValue({
      shares: [
        makeShare({
          id: 'legacy-only',
          targetUserId: '*',
          targetTeamId: undefined,
          targetTeamName: undefined,
        }),
      ],
    });

    const onClose = vi.fn();
    const onOpenNodeGroups = vi.fn();

    render(
      <DocShareDialog
        serverId="srv-1"
        targetPath="/docs"
        targetKind="folder"
        onClose={onClose}
        onOpenNodeGroups={onOpenNodeGroups}
      />,
    );

    expect(await screen.findByTestId('doc-share-no-bound-groups')).toBeTruthy();
    expect(screen.getByTestId('doc-share-no-groups-empty')).toBeTruthy();
    expect(screen.queryByTestId('doc-share-group-select')).toBeNull();
    expect(screen.getByTestId('doc-share-group-rule-item').textContent).toContain('doc_share.legacy_all_members');

    fireEvent.click(screen.getByTestId('doc-share-open-node-groups-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenNodeGroups).toHaveBeenCalledTimes(1);
  });

  it('ignores stale/rejected responses from a previous server or path after switching target or closing', async () => {
    const slowReq1 = deferred<{ shares: DocumentShareItem[]; groups?: ServerDocGroup[] }>();
    const fastReq2 = deferred<{ shares: DocumentShareItem[]; groups?: ServerDocGroup[] }>();

    apiMocks.listDocumentShares
      .mockImplementationOnce(() => slowReq1.promise)
      .mockImplementationOnce(() => fastReq2.promise);

    const view = render(
      <DocShareDialog
        serverId="srv-1"
        targetPath="/a.docx"
        targetKind="file"
        onClose={vi.fn()}
      />,
    );

    // Switch target before srv-1 request completes
    view.rerender(
      <DocShareDialog
        serverId="srv-2"
        targetPath="/b.docx"
        targetKind="file"
        onClose={vi.fn()}
      />,
    );

    fastReq2.resolve({
      shares: [
        makeShare({
          id: 'srv2-share',
          serverId: 'srv-2',
          targetPath: '/b.docx',
          targetUserId: 'team:team-2',
          targetTeamId: 'team-2',
          targetTeamName: 'Server2 Team',
        }),
      ],
      groups: [{ id: 'team-2', name: 'Server2 Team', memberCount: 2, boundToServer: true }],
    });

    const badge = await screen.findByTestId('doc-share-bound-group-badge');
    expect(badge.textContent).toContain('Server2 Team');

    // Now the stale srv-1 response resolves with completely different data
    slowReq1.resolve({
      shares: [
        makeShare({
          id: 'stale-share',
          serverId: 'srv-1',
          targetPath: '/a.docx',
          targetUserId: 'team:team-1',
          targetTeamId: 'team-1',
          targetTeamName: 'Stale Team',
        }),
      ],
      groups: [{ id: 'team-1', name: 'Stale Team', memberCount: 9, boundToServer: true }],
    });
    await Promise.resolve();
    await Promise.resolve();

    // Must still display Server2 Team, never Stale Team
    expect(screen.getByTestId('doc-share-bound-group-badge').textContent).toContain('Server2 Team');
    expect(screen.queryByText(/Stale Team/)).toBeNull();
    expect((screen.getByTestId('doc-share-group-select') as HTMLSelectElement).value).toBe('team-2');

    // Switching again and letting a previous rejection land after unmount must not throw or corrupt
    const slowReq3 = deferred<{ shares: DocumentShareItem[]; groups?: ServerDocGroup[] }>();
    apiMocks.listDocumentShares.mockImplementationOnce(() => slowReq3.promise);
    view.rerender(
      <DocShareDialog
        serverId="srv-3"
        targetPath="/c.docx"
        targetKind="file"
        onClose={vi.fn()}
      />,
    );
    view.unmount();
    slowReq3.reject(new Error('late_network_failure'));
    await Promise.resolve();
  });
});
