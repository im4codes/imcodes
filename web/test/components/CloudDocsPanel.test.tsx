/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type {
  CloudDocFolder,
  CloudDocItem,
  CloudDocShareRecord,
  CloudDocTeamOption,
  RecentDocumentItem,
  SharedCloudDocItem,
  SharedCloudFolderItem,
} from '@shared/cloud-docs.js';

const mockTranslate = (key: string, fallbackOrVars?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
  if (typeof fallbackOrVars === 'string') {
    if (!vars) return fallbackOrVars;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v)),
      fallbackOrVars,
    );
  }
  return fallbackOrVars ? `${key}:${JSON.stringify(fallbackOrVars)}` : key;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockTranslate,
  }),
}));

const officePreviewPropsSpy = vi.fn();
vi.mock('../../src/components/OfficePreview.js', () => ({
  default: (props: Record<string, unknown>) => {
    officePreviewPropsSpy(props);
    return (
      <div
        data-testid="mock-office-preview"
        data-cloud-doc-id={String(props.cloudDocId ?? '')}
        data-read-only={String(Boolean(props.readOnly))}
        data-has-src-url={String(Boolean(props.srcUrl))}
        data-initial-mode={String(props.initialMode ?? '')}
      />
    );
  },
}));

const listCloudDocsApiMock = vi.fn();
const listCloudDocTeamsApiMock = vi.fn();
const listCloudDocSharesApiMock = vi.fn();
const upsertCloudDocShareApiMock = vi.fn();
const revokeCloudDocShareApiMock = vi.fn();
const createCloudDocFolderApiMock = vi.fn();
const updateCloudDocFolderApiMock = vi.fn();
const deleteCloudDocFolderApiMock = vi.fn();
const createBlankCloudDocApiMock = vi.fn();
const uploadCloudDocApiMock = vi.fn();
const updateCloudDocApiMock = vi.fn();
const deleteCloudDocApiMock = vi.fn();
const downloadCloudDocApiMock = vi.fn();
const listRecentDocumentsApiMock = vi.fn();
const deleteRecentDocumentApiMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, body?: { error?: string; code?: string }) {
      super(body?.error || `HTTP ${status}`);
      this.status = status;
      this.code = body?.code;
    }
  },
  listCloudDocsApi: (...args: unknown[]) => listCloudDocsApiMock(...args),
  listCloudDocTeamsApi: (...args: unknown[]) => listCloudDocTeamsApiMock(...args),
  listCloudDocSharesApi: (...args: unknown[]) => listCloudDocSharesApiMock(...args),
  upsertCloudDocShareApi: (...args: unknown[]) => upsertCloudDocShareApiMock(...args),
  revokeCloudDocShareApi: (...args: unknown[]) => revokeCloudDocShareApiMock(...args),
  createCloudDocFolderApi: (...args: unknown[]) => createCloudDocFolderApiMock(...args),
  updateCloudDocFolderApi: (...args: unknown[]) => updateCloudDocFolderApiMock(...args),
  deleteCloudDocFolderApi: (...args: unknown[]) => deleteCloudDocFolderApiMock(...args),
  createBlankCloudDocApi: (...args: unknown[]) => createBlankCloudDocApiMock(...args),
  uploadCloudDocApi: (...args: unknown[]) => uploadCloudDocApiMock(...args),
  updateCloudDocApi: (...args: unknown[]) => updateCloudDocApiMock(...args),
  deleteCloudDocApi: (...args: unknown[]) => deleteCloudDocApiMock(...args),
  downloadCloudDocApi: (...args: unknown[]) => downloadCloudDocApiMock(...args),
  getCloudDocDownloadUrl: (docId: string, inline?: boolean) =>
    `/api/cloud-docs/docs/${encodeURIComponent(docId)}/download${inline ? '?inline=1' : ''}`,
  listRecentDocumentsApi: (...args: unknown[]) => listRecentDocumentsApiMock(...args),
  deleteRecentDocumentApi: (...args: unknown[]) => deleteRecentDocumentApiMock(...args),
}));

import { CloudDocsPanel, buildUniqueAutoDocName, clampCloudDocsContextMenuPosition } from '../../src/components/CloudDocsPanel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stylesPath = resolve(__dirname, '../../src/styles.css');

function makeDoc(overrides: Partial<CloudDocItem> = {}): CloudDocItem {
  return {
    id: 'doc-1',
    folderId: null,
    name: 'quarterly.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 2048,
    docVersion: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<CloudDocFolder> = {}): CloudDocFolder {
  return {
    id: 'fld-1',
    parentId: null,
    name: 'Finance',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<CloudDocTeamOption> = {}): CloudDocTeamOption {
  return {
    id: 'team-1',
    name: 'Production Nodes',
    memberRole: 'owner',
    ...overrides,
  };
}

describe('CloudDocsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCloudDocsApiMock.mockResolvedValue({
      folders: [makeFolder()],
      docs: [makeDoc()],
      sharedFolders: [],
      sharedDocs: [],
    });
    listRecentDocumentsApiMock.mockResolvedValue({ items: [] });
    listCloudDocTeamsApiMock.mockResolvedValue({ teams: [makeTeam()] });
    listCloudDocSharesApiMock.mockResolvedValue({ shares: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('switches tabs and creates folder and blank docx document', async () => {
    const createdFolder = makeFolder({ id: 'fld-2', name: 'HR Specs' });
    const createdDoc = makeDoc({ id: 'doc-2', name: 'Onboarding.docx' });
    const currentFolders = [makeFolder()];
    const currentDocs = [makeDoc()];
    listCloudDocsApiMock.mockImplementation(async () => ({
      folders: [...currentFolders],
      docs: [...currentDocs],
      sharedFolders: [],
      sharedDocs: [],
    }));
    createCloudDocFolderApiMock.mockImplementationOnce(async () => {
      currentFolders.push(createdFolder);
      return { folder: createdFolder };
    });
    createBlankCloudDocApiMock.mockImplementationOnce(async () => {
      currentDocs.push(createdDoc);
      return { doc: createdDoc };
    });

    render(<CloudDocsPanel initialTab="recent" />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-recent-empty')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('cloud-docs-tab-my-docs'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-folder-row-fld-1')).toBeTruthy();
      expect(screen.getByTestId('cloud-doc-row-doc-1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('cloud-docs-new-folder-btn'));
    const folderInput = screen.getByTestId('cloud-docs-new-folder-input');
    fireEvent.input(folderInput, {
      target: { value: 'HR Specs' },
    });
    fireEvent.submit(folderInput.closest('form')!);

    await waitFor(() => {
      expect(createCloudDocFolderApiMock).toHaveBeenCalledWith({
        name: 'HR Specs',
        parentId: null,
      });
      expect(screen.getByTestId('cloud-folder-row-fld-2')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));

    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'docx',
        name: 'Untitled document.docx',
        folderId: null,
      });
      const preview = screen.getByTestId('mock-office-preview');
      expect(preview.getAttribute('data-cloud-doc-id')).toBe('doc-2');
      expect(preview.getAttribute('data-read-only')).toBe('false');
      expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Onboarding.docx');
    });

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-doc-row-doc-2')).toBeTruthy();
    });
  });

  it('manages global controlled-node team and user shares inline and revokes them', async () => {
    const shareTeamRecord: CloudDocShareRecord = {
      id: 'share-1',
      targetKind: 'doc',
      targetId: 'doc-1',
      shareMode: 'team',
      targetTeamId: 'team-1',
      targetTeamName: 'Production Nodes',
      targetUserId: null,
      targetUserUsername: null,
      targetUserName: null,
      role: 'editor',
      allowDownload: true,
      createdAt: 1_700_000_200_000,
    };
    const shareUserRecord: CloudDocShareRecord = {
      id: 'share-2',
      targetKind: 'doc',
      targetId: 'doc-1',
      shareMode: 'user',
      targetTeamId: null,
      targetTeamName: null,
      targetUserId: 'usr-bob',
      targetUserUsername: 'bob',
      targetUserName: 'Bob',
      role: 'viewer',
      allowDownload: false,
      createdAt: 1_700_000_250_000,
    };

    const currentShares: CloudDocShareRecord[] = [];
    listCloudDocSharesApiMock.mockImplementation(async () => ({ shares: [...currentShares] }));
    upsertCloudDocShareApiMock
      .mockImplementationOnce(async () => {
        currentShares.push(shareTeamRecord);
        return { share: shareTeamRecord };
      })
      .mockImplementationOnce(async () => {
        currentShares.push(shareUserRecord);
        return { share: shareUserRecord };
      });
    revokeCloudDocShareApiMock.mockImplementationOnce(async (shareId: string) => {
      const idx = currentShares.findIndex((s) => s.id === shareId);
      if (idx >= 0) currentShares.splice(idx, 1);
      return { ok: true };
    });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => {
      expect(screen.getByTestId('share-cloud-doc-doc-1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('share-cloud-doc-doc-1'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-share-panel')).toBeTruthy();
      expect(screen.getByTestId('cloud-docs-share-team-select')).toBeTruthy();
    });

    const roleSelect = screen.getByTestId('cloud-docs-share-role-select') as HTMLSelectElement;
    fireEvent.change(roleSelect, { target: { value: 'editor' } });
    await waitFor(() => {
      expect((screen.getByTestId('cloud-docs-share-role-select') as HTMLSelectElement).value).toBe('editor');
    });
    fireEvent.submit(roleSelect.closest('form')!);

    await waitFor(() => {
      expect(upsertCloudDocShareApiMock).toHaveBeenCalledWith(
        {
          targetKind: 'doc',
          targetId: 'doc-1',
          shareMode: 'team',
          targetTeamId: 'team-1',
          targetUsername: undefined,
          role: 'editor',
          allowDownload: true,
        },
        expect.any(AbortSignal),
      );
      expect(screen.getByTestId('cloud-doc-share-item-share-1')).toBeTruthy();
    });

    const modeSelect = screen.getByTestId('cloud-docs-share-mode-select') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'user' } });
    const userInput = await screen.findByTestId('cloud-docs-share-user-input');
    fireEvent.input(userInput, {
      target: { value: 'bob' },
    });
    const roleSelect2 = screen.getByTestId('cloud-docs-share-role-select') as HTMLSelectElement;
    fireEvent.change(roleSelect2, { target: { value: 'viewer' } });
    const dlCheckbox = screen.getByTestId('cloud-docs-share-download-checkbox') as HTMLInputElement;
    fireEvent.change(dlCheckbox, { target: { checked: false } });
    await waitFor(() => {
      expect((screen.getByTestId('cloud-docs-share-user-input') as HTMLInputElement).value).toBe('bob');
      expect((screen.getByTestId('cloud-docs-share-download-checkbox') as HTMLInputElement).checked).toBe(false);
    });
    fireEvent.submit(userInput.closest('form')!);

    await waitFor(() => {
      expect(upsertCloudDocShareApiMock).toHaveBeenLastCalledWith(
        {
          targetKind: 'doc',
          targetId: 'doc-1',
          shareMode: 'user',
          targetTeamId: undefined,
          targetUsername: 'bob',
          role: 'viewer',
          allowDownload: false,
        },
        expect.any(AbortSignal),
      );
      expect(screen.getByTestId('cloud-doc-share-item-share-2')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('revoke-cloud-share-share-1'));
    await waitFor(() => {
      expect(revokeCloudDocShareApiMock).toHaveBeenCalledWith('share-1', expect.any(AbortSignal));
      expect(screen.queryByTestId('cloud-doc-share-item-share-1')).toBeNull();
    });
  });

  it('enforces viewer readOnly and allowDownload=false in Shared tab and OfficePreview stage', async () => {
    const sharedFolder: SharedCloudFolderItem = {
      id: 'sfld-1',
      parentId: null,
      name: 'Shared Specs',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      ownerName: 'Alice',
      role: 'viewer',
      allowDownload: true,
    };
    const restrictedSharedDoc: SharedCloudDocItem = {
      id: 'sdoc-1',
      folderId: null,
      name: 'locked-budget.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 4096,
      docVersion: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      ownerName: 'Alice',
      role: 'viewer',
      allowDownload: false,
    };

    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [],
      sharedFolders: [sharedFolder],
      sharedDocs: [restrictedSharedDoc],
    });

    render(<CloudDocsPanel initialTab="shared" />);
    await waitFor(() => {
      expect(screen.getByTestId('shared-cloud-folder-row-sfld-1')).toBeTruthy();
      expect(screen.getByTestId('shared-cloud-doc-row-sdoc-1')).toBeTruthy();
    });

    // Download link must NOT render when allowDownload=false
    expect(screen.queryByTestId('download-shared-doc-sdoc-1')).toBeNull();

    // Open preview and verify readOnly=true and srcUrl=undefined (no download button)
    const rowMain = screen.getByTestId('shared-cloud-doc-row-sdoc-1').querySelector('button.cloud-docs-row-main');
    expect(rowMain).toBeTruthy();
    fireEvent.click(rowMain!);

    await waitFor(() => {
      const preview = screen.getByTestId('mock-office-preview');
      expect(preview.getAttribute('data-cloud-doc-id')).toBe('sdoc-1');
      expect(preview.getAttribute('data-read-only')).toBe('true');
      expect(preview.getAttribute('data-has-src-url')).toBe('false');
      expect(preview.getAttribute('data-initial-mode')).toBe('view');
    });
    expect(screen.queryByTestId('cloud-docs-preview-download')).toBeNull();
  });

  it('shows blocked notice for inaccessible recent item and allows removing it', async () => {
    const blockedRecent: RecentDocumentItem = {
      id: 'rec-1',
      sourceType: 'server_file',
      sourceKey: 'server_file:srv-1:/secret.docx',
      title: 'secret.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      serverId: 'srv-1',
      serverName: 'Node A',
      sessionName: null,
      filePath: '/secret.docx',
      cloudDocId: null,
      lastOpenedAt: 1_700_000_500_000,
      accessible: false,
      accessReason: 'access_denied',
    };
    listRecentDocumentsApiMock.mockResolvedValueOnce({ items: [blockedRecent] });
    deleteRecentDocumentApiMock.mockResolvedValueOnce({ ok: true });

    render(<CloudDocsPanel initialTab="recent" />);
    await waitFor(() => {
      expect(screen.getByTestId('recent-doc-row-rec-1')).toBeTruthy();
    });

    const rowMain = screen.getByTestId('recent-doc-row-rec-1').querySelector('button.cloud-docs-row-main');
    fireEvent.click(rowMain!);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-recent-blocked')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('cloud-docs-remove-blocked-recent'));
    await waitFor(() => {
      expect(deleteRecentDocumentApiMock).toHaveBeenCalledWith('rec-1');
      expect(screen.queryByTestId('recent-doc-row-rec-1')).toBeNull();
    });
  });

  it('handles late async response after unmount without throwing or leaking state', async () => {
    let resolveDocs!: (v: unknown) => void;
    let resolveRecent!: (v: unknown) => void;
    listCloudDocsApiMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDocs = resolve; }),
    );
    listRecentDocumentsApiMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRecent = resolve; }),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<CloudDocsPanel initialTab="recent" />);
    unmount();

    resolveDocs({ folders: [], docs: [makeDoc()], sharedFolders: [], sharedDocs: [] });
    resolveRecent({ items: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('keeps narrow-screen mobile remote desktop group and cloud docs responsive styles defined', () => {
    const css = readFileSync(stylesPath, 'utf8');
    expect(css).toContain('.mobile-remote-desktop-group');
    expect(css).toContain('@media (max-width: 420px)');
    expect(css).toContain('.cloud-docs-panel');
    expect(css).toContain('.cloud-docs-share-form');
  });

  it('uses ticket-based downloadCloudDocApi across My Docs, Shared Docs, and Preview header without raw cookie anchors', async () => {
    downloadCloudDocApiMock.mockResolvedValue(undefined);
    const sharedDoc: SharedCloudDocItem = {
      id: 'sdoc-dl',
      folderId: null,
      name: 'shared-report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 2048,
      docVersion: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      ownerName: 'Alice',
      role: 'viewer',
      allowDownload: true,
    };
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [makeDoc()],
      sharedFolders: [],
      sharedDocs: [sharedDoc],
    });

    const view = render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('download-cloud-doc-doc-1')).toBeTruthy());
    expect(view.container.querySelector('a[href*="/download"]')).toBeNull();

    fireEvent.click(screen.getByTestId('download-cloud-doc-doc-1'));
    await waitFor(() => expect(downloadCloudDocApiMock).toHaveBeenCalledWith('doc-1', 'quarterly.docx'));

    fireEvent.click(screen.getByTestId('cloud-docs-tab-shared'));
    await waitFor(() => expect(screen.getByTestId('download-shared-doc-sdoc-dl')).toBeTruthy());
    fireEvent.click(screen.getByTestId('download-shared-doc-sdoc-dl'));
    await waitFor(() => expect(downloadCloudDocApiMock).toHaveBeenCalledWith('sdoc-dl', 'shared-report.docx'));

    // Open preview -> OfficePreview receives NO raw /api/cloud-docs/:id/download srcUrl, header uses ticket button
    fireEvent.click(screen.getByTestId('shared-cloud-doc-row-sdoc-dl').querySelector('button.cloud-docs-row-main')!);
    await waitFor(() => {
      const preview = screen.getByTestId('mock-office-preview');
      expect(preview.getAttribute('data-has-src-url')).toBe('false');
      expect(screen.getByTestId('cloud-docs-preview-download')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('cloud-docs-preview-download'));
    await waitFor(() => expect(downloadCloudDocApiMock).toHaveBeenCalledWith('sdoc-dl', 'shared-report.docx'));
  });

  it('drops stale share dialog responses & in-flight revokes when switching targets or closing dialog', async () => {
    const docA = makeDoc({ id: 'doc-a', name: 'DocA.docx' });
    const docB = makeDoc({ id: 'doc-b', name: 'DocB.docx' });
    const shareA: CloudDocShareRecord = {
      id: 'share-a',
      targetKind: 'doc',
      targetId: 'doc-a',
      shareMode: 'user',
      targetTeamId: null,
      targetTeamName: null,
      targetUserId: 'usr-a',
      targetUserUsername: 'alice',
      targetUserName: 'Alice',
      role: 'viewer',
      allowDownload: true,
      createdAt: 1_700_000_000_000,
    };
    const shareB: CloudDocShareRecord = {
      id: 'share-b',
      targetKind: 'doc',
      targetId: 'doc-b',
      shareMode: 'user',
      targetTeamId: null,
      targetTeamName: null,
      targetUserId: 'usr-b',
      targetUserUsername: 'bob',
      targetUserName: 'Bob',
      role: 'editor',
      allowDownload: true,
      createdAt: 1_700_000_100_000,
    };

    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [docA, docB],
      sharedFolders: [],
      sharedDocs: [],
    });

    let rejectSlowA!: (err: Error) => void;
    let signalA: AbortSignal | undefined;
    let resolveRevokeA!: (v: { ok: boolean }) => void;

    listCloudDocSharesApiMock.mockImplementation(async (_kind: string, id: string, signal?: AbortSignal) => {
      if (id === 'doc-a') {
        signalA = signal;
        return new Promise((_resolve, reject) => { rejectSlowA = reject; });
      }
      return { shares: [shareB] };
    });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('share-cloud-doc-doc-a')).toBeTruthy());

    // 1. Open share for A (slow), immediately switch to B (fast)
    fireEvent.click(screen.getByTestId('share-cloud-doc-doc-a'));
    fireEvent.click(screen.getByTestId('share-cloud-doc-doc-b'));

    await waitFor(() => expect(screen.getByTestId('cloud-doc-share-item-share-b')).toBeTruthy());
    expect(signalA?.aborted).toBe(true);

    // Late rejection from A must NOT clobber B's panel with an error or list
    rejectSlowA(new Error('late failure from doc-a'));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('cloud-docs-error')).toBeNull();
    expect(screen.getByTestId('cloud-doc-share-item-share-b')).toBeTruthy();

    // 2. Slow revoke on B -> close dialog -> reopen A -> late revoke settles without mutating new dialog state
    revokeCloudDocShareApiMock.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveRevokeA = resolve; }),
    );
    fireEvent.click(screen.getByTestId('revoke-cloud-share-share-b'));
    fireEvent.click(screen.getByTestId('cloud-docs-share-close'));
    listCloudDocSharesApiMock.mockImplementationOnce(async () => ({ shares: [shareA] }));
    fireEvent.click(screen.getByTestId('share-cloud-doc-doc-a'));
    await waitFor(() => expect(screen.getByTestId('cloud-doc-share-item-share-a')).toBeTruthy());

    resolveRevokeA({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId('cloud-doc-share-item-share-a')).toBeTruthy();
    expect((screen.getByTestId('revoke-cloud-share-share-a') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks opening offline server_file recent items into OfficePreview and shows refresh/remove notice', async () => {
    const offlineRecent: RecentDocumentItem = {
      id: 'rec-offline',
      sourceKind: 'server_file',
      sourceType: 'server_file',
      sourceKey: 'server_file:srv-off:/docs/plan.docx',
      title: 'plan.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      serverId: 'srv-off',
      serverName: 'Edge Node',
      serverOnline: false,
      sessionName: null,
      filePath: '/docs/plan.docx',
      cloudDocId: null,
      lastOpenedAt: 1_700_000_600_000,
      openCount: 1,
      accessible: true,
      accessReason: 'server_offline',
    };
    listRecentDocumentsApiMock.mockResolvedValue({ items: [offlineRecent] });

    render(<CloudDocsPanel initialTab="recent" />);
    await waitFor(() => expect(screen.getByTestId('recent-doc-row-rec-offline')).toBeTruthy());

    fireEvent.click(screen.getByTestId('recent-doc-row-rec-offline').querySelector('button.cloud-docs-row-main')!);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-recent-blocked')).toBeTruthy();
      expect(screen.getByTestId('cloud-docs-refresh-blocked-recent')).toBeTruthy();
      expect(screen.getByTestId('cloud-docs-remove-blocked-recent')).toBeTruthy();
    });
    expect(screen.queryByTestId('mock-office-preview')).toBeNull();
  });

  it('auto-numbers 1-click blank docs and supports Google Docs style inline preview rename with Enter/Escape', async () => {
    const existingUntitled = makeDoc({
      id: 'doc-untitled-1',
      name: 'Untitled document.docx',
    });
    const createdDoc = makeDoc({
      id: 'doc-untitled-2',
      name: 'Untitled document 2.docx',
      updatedAt: 1_700_000_900_000,
    });
    const docs = [existingUntitled];
    listCloudDocsApiMock.mockImplementation(async () => ({
      folders: [],
      docs: [...docs],
      sharedFolders: [],
      sharedDocs: [],
    }));
    createBlankCloudDocApiMock.mockImplementationOnce(async () => {
      docs.push(createdDoc);
      return { doc: createdDoc };
    });
    updateCloudDocApiMock.mockImplementationOnce(async (_id: string, body: { name?: string }) => ({
      doc: { ...createdDoc, name: body.name ?? createdDoc.name },
    }));

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('cloud-doc-row-doc-untitled-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'docx',
        name: 'Untitled document 2.docx',
        folderId: null,
      });
      expect(screen.getByTestId('mock-office-preview').getAttribute('data-cloud-doc-id')).toBe('doc-untitled-2');
    });

    const titleInput = screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement;
    expect(titleInput.value).toBe('Untitled document 2.docx');

    // Escape reverts unsaved edit without calling API
    fireEvent.input(titleInput, { target: { value: 'Temp Draft' } });
    fireEvent.keyDown(titleInput, { key: 'Escape' });
    expect(titleInput.value).toBe('Untitled document 2.docx');
    expect(updateCloudDocApiMock).not.toHaveBeenCalled();

    // Enter commits with extension preserved
    fireEvent.input(titleInput, { target: { value: 'Q4 Plan' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    await waitFor(() => {
      expect(updateCloudDocApiMock).toHaveBeenCalledWith('doc-untitled-2', { name: 'Q4 Plan.docx' });
      expect(screen.getByTestId('cloud-docs-preview-saved')).toBeTruthy();
      expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Q4 Plan.docx');
    });
  });

  it('supports grid/list view toggle, type filter, overflow menu actions, and Share modal Escape dismissal', async () => {
    const docWord = makeDoc({ id: 'doc-word', name: 'Alpha.docx', ext: 'docx', updatedAt: 1_700_000_100_000 });
    const docCell = makeDoc({
      id: 'doc-cell',
      name: 'Budget.xlsx',
      ext: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      updatedAt: 1_700_000_500_000,
    });
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [docWord, docCell],
      sharedFolders: [],
      sharedDocs: [],
    });
    deleteCloudDocApiMock.mockResolvedValue({ ok: true });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-doc-row-doc-word')).toBeTruthy();
      expect(screen.getByTestId('cloud-doc-row-doc-cell')).toBeTruthy();
    });

    // Switch to grid view and back to list
    fireEvent.click(screen.getByTestId('cloud-docs-view-grid'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-my-docs-list').className).toContain('cloud-docs-grid'));
    fireEvent.click(screen.getByTestId('cloud-docs-view-list'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-my-docs-list').className).toContain('cloud-docs-list'));

    // Type filter narrows visible docs
    fireEvent.change(screen.getByTestId('cloud-docs-type-filter'), { target: { value: 'cell' } });
    await waitFor(() => {
      expect(screen.queryByTestId('cloud-doc-row-doc-word')).toBeNull();
      expect(screen.getByTestId('cloud-doc-row-doc-cell')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('cloud-docs-type-filter'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByTestId('cloud-doc-row-doc-word')).toBeTruthy());

    // Overflow menu reveals delete button cleanly
    fireEvent.click(screen.getByTestId('cloud-doc-more-doc-word'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-row-menu')).toBeTruthy());
    expect(screen.getByTestId('rename-cloud-doc-doc-word')).toBeTruthy();
    expect(screen.getByTestId('move-cloud-doc-doc-word')).toBeTruthy();
    fireEvent.click(screen.getByTestId('delete-cloud-doc-doc-word'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-confirm-delete-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cloud-docs-confirm-delete-btn'));
    await waitFor(() => expect(deleteCloudDocApiMock).toHaveBeenCalledWith('doc-word'));

    // Open preview and trigger elevated Share dialog, then close via Escape
    const cellRow = await screen.findByTestId('cloud-doc-row-doc-cell');
    fireEvent.click(cellRow.querySelector('button.cloud-docs-row-main')!);
    await waitFor(() => expect(screen.getByTestId('cloud-docs-preview-share')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cloud-docs-preview-share'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-share-panel')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('cloud-docs-share-panel')).toBeNull());
  });

  it('handles drag-and-drop file upload with extension validation', async () => {
    uploadCloudDocApiMock.mockResolvedValue({ doc: makeDoc({ id: 'doc-pdf', name: 'Spec.pdf', ext: 'pdf', mimeType: 'application/pdf' }) });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('cloud-docs-my-docs-list')).toBeTruthy());

    const body = screen.getByTestId('cloud-docs-panel').querySelector('.cloud-docs-body')!;
    const badFile = new File(['abc'], 'malware.exe', { type: 'application/octet-stream' });
    fireEvent.drop(body, { dataTransfer: { files: [badFile] } });
    await waitFor(() => expect(screen.getByTestId('cloud-docs-error')).toBeTruthy());
    expect(uploadCloudDocApiMock).not.toHaveBeenCalled();

    const pdfFile = new File(['%PDF'], 'Spec.pdf', { type: 'application/pdf' });
    fireEvent.drop(body, { dataTransfer: { files: [pdfFile] } });
    await waitFor(() => expect(uploadCloudDocApiMock).toHaveBeenCalledWith(pdfFile, { folderId: null }));
  });

  it('serializes concurrent preview title renames without losing newer edits and isolates background ACKs across doc switches', async () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const docA = makeDoc({ id: 'doc-a', name: 'A.docx' });
    const docB = makeDoc({ id: 'doc-b', name: 'B.docx' });
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [docA, docB],
      sharedFolders: [],
      sharedDocs: [],
    });

    const first = deferred<{ doc: CloudDocItem }>();
    const second = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<CloudDocsPanel initialTab="my_docs" />);
    const rowA = await screen.findByTestId('cloud-doc-row-doc-a');
    fireEvent.click(rowA.querySelector('button.cloud-docs-row-main')!);
    const input = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;

    // 1. Edit & Enter while first ACK is delayed, then immediately edit Latest & Enter
    fireEvent.input(input, { target: { value: 'First' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(1));

    fireEvent.input(input, { target: { value: 'Latest' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    first.resolve({ doc: { ...docA, name: 'First.docx' } });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(2));
    expect(updateCloudDocApiMock).toHaveBeenLastCalledWith('doc-a', { name: 'Latest.docx' });
    expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Latest');

    second.resolve({ doc: { ...docA, name: 'Latest.docx' } });
    await waitFor(() => {
      expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Latest.docx');
      expect(screen.getByTestId('cloud-docs-preview-saved')).toBeTruthy();
    });

    // 2. Rename docA on blur, switch Back -> open docB before docA resolves: docB must not be corrupted
    const third = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock.mockImplementationOnce(() => third.promise);
    const activeInputA = screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement;
    fireEvent.input(activeInputA, { target: { value: 'Renamed A' } });
    fireEvent(activeInputA, new FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    const rowB = await screen.findByTestId('cloud-doc-row-doc-b');
    fireEvent.click(rowB.querySelector('button.cloud-docs-row-main')!);
    await waitFor(() => {
      expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('B.docx');
    });

    third.resolve({ doc: { ...docA, name: 'Renamed A.docx' } });
    await new Promise((r) => setTimeout(r, 25));
    expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('B.docx');
    expect(screen.queryByTestId('cloud-docs-preview-saved')).toBeNull();

    // 3. Rejection preserves user's retryable input on active doc and surfaces error
    const inputB = screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement;
    updateCloudDocApiMock.mockRejectedValueOnce(new Error('Rename conflict'));
    fireEvent.input(inputB, { target: { value: 'Conflict Name' } });
    fireEvent(inputB, new FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-error')).toBeTruthy());
    expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Conflict Name');
  });

  it('awaits initial hydration before auto-naming instead of creating duplicate defaults on Recent', async () => {
    let resolveLoad!: (v: unknown) => void;
    const pendingLoad = new Promise((res) => {
      resolveLoad = res;
    });
    listCloudDocsApiMock.mockImplementationOnce(() => pendingLoad as Promise<never>);
    createBlankCloudDocApiMock.mockResolvedValue({
      doc: makeDoc({ id: 'new-1', name: 'Untitled document 2.docx' }),
    });

    render(<CloudDocsPanel initialTab="recent" />);
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    expect(createBlankCloudDocApiMock).not.toHaveBeenCalled();

    resolveLoad({
      folders: [],
      docs: [makeDoc({ id: 'existing-1', folderId: null, name: 'Untitled document.docx' })],
      sharedFolders: [],
      sharedDocs: [],
    });
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'docx',
        name: 'Untitled document 2.docx',
        folderId: null,
      });
    });
  });

  it('aborts auto-creation cleanly if authoritative document list hydration fails', async () => {
    listCloudDocsApiMock.mockRejectedValueOnce(new Error('Network down'));
    listRecentDocumentsApiMock.mockResolvedValue({ items: [] });
    listCloudDocTeamsApiMock.mockResolvedValue({ teams: [] });

    render(<CloudDocsPanel initialTab="recent" />);
    await waitFor(() => expect(screen.getByTestId('cloud-docs-error')).toBeTruthy());

    listCloudDocsApiMock.mockRejectedValueOnce(new Error('Network down'));
    fireEvent.click(screen.getByTestId('cloud-docs-new-xlsx-btn'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-error')).toBeTruthy());
    expect(createBlankCloudDocApiMock).not.toHaveBeenCalled();
  });

  it('isolates folders during blank doc creation and scales past 999 conflicts across all types', async () => {
    const busyDocs: CloudDocItem[] = [
      makeDoc({ id: 'other-folder', folderId: 'fld-other', name: 'Untitled presentation.pptx' }),
      makeDoc({ id: 'u-1', folderId: null, name: 'Untitled spreadsheet.xlsx' }),
    ];
    for (let i = 2; i <= 1005; i += 1) {
      busyDocs.push(makeDoc({ id: `u-${i}`, folderId: null, name: `Untitled spreadsheet ${i}.xlsx` }));
    }
    expect(buildUniqueAutoDocName('pptx', busyDocs, null, 'Untitled presentation')).toBe('Untitled presentation.pptx');
    expect(buildUniqueAutoDocName('xlsx', busyDocs, null, 'Untitled spreadsheet')).toBe('Untitled spreadsheet 1006.xlsx');

    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [
        makeDoc({ id: 'other-folder', folderId: 'fld-other', name: 'Untitled presentation.pptx' }),
        makeDoc({ id: 'u-1', folderId: null, name: 'Untitled spreadsheet.xlsx' }),
        makeDoc({ id: 'u-2', folderId: null, name: 'Untitled spreadsheet 2.xlsx' }),
      ],
      sharedFolders: [],
      sharedDocs: [],
    });
    createBlankCloudDocApiMock
      .mockResolvedValueOnce({ doc: makeDoc({ id: 'pptx-1', name: 'Untitled presentation.pptx' }) })
      .mockResolvedValueOnce({ doc: makeDoc({ id: 'xlsx-3', name: 'Untitled spreadsheet 3.xlsx' }) });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('cloud-docs-my-docs-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('cloud-docs-new-pptx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'pptx',
        name: 'Untitled presentation.pptx',
        folderId: null,
      });
    });

    fireEvent.click(await screen.findByTestId('cloud-docs-preview-back'));
    await screen.findByTestId('cloud-docs-my-docs-list');

    fireEvent.click(screen.getByTestId('cloud-docs-new-xlsx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenLastCalledWith({
        type: 'xlsx',
        name: 'Untitled spreadsheet 3.xlsx',
        folderId: null,
      });
    });
  });

  it('reconciles reopened same document rename across A -> Back -> A (success, newer local edit, and failure)', async () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const docA = makeDoc({ id: 'doc-a', name: 'A.docx' });
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [docA],
      sharedFolders: [],
      sharedDocs: [],
    });

    // 1. A -> delayed rename -> Back -> reopen A -> ACK settles title & clears Saving...
    const req1 = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock.mockImplementationOnce(() => req1.promise);

    render(<CloudDocsPanel initialTab="my_docs" />);
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-a')).querySelector('button.cloud-docs-row-main')!);
    let input = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Renamed A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-a')).querySelector('button.cloud-docs-row-main')!);
    input = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;
    expect(input.value).toBe('Renamed A.docx');
    expect(screen.queryByText('Saving...')).toBeTruthy();

    req1.resolve({ doc: { ...docA, name: 'Renamed A.docx' } });
    await waitFor(() => {
      expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Renamed A.docx');
      expect(screen.queryByText('Saving...')).toBeNull();
      expect(screen.getByTestId('cloud-docs-preview-saved')).toBeTruthy();
    });

    // 2. A -> delayed rename -> Back -> reopen A -> newer local edit before ACK -> ACK settles Saving without clobbering new draft
    const req2 = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock.mockImplementationOnce(() => req2.promise);
    input = screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Server Ack Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-a')).querySelector('button.cloud-docs-row-main')!);
    input = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Local After Reopen' } });

    req2.resolve({ doc: { ...docA, name: 'Server Ack Name.docx' } });
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
    expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Local After Reopen');
    expect(screen.queryByTestId('cloud-docs-preview-saved')).toBeNull();

    // 3. A -> delayed rename -> Back -> reopen A -> rejection clears Saving, preserves retryable input, and surfaces error
    const req3 = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock.mockImplementationOnce(() => req3.promise);
    fireEvent.input(screen.getByTestId('cloud-docs-preview-title-input'), { target: { value: 'Failed Reopen' } });
    fireEvent.keyDown(screen.getByTestId('cloud-docs-preview-title-input'), { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-a')).querySelector('button.cloud-docs-row-main')!);
    req3.reject(new Error('Reopen save failed'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-error')).toBeTruthy();
      expect(screen.queryByText('Saving...')).toBeNull();
    });
    expect((screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement).value).toBe('Failed Reopen.docx');
  });

  it('projects mutations into list/naming cache across refresh failures, blocks stale create while offline, and recovers cleanly', async () => {
    const fld1 = makeFolder({ id: 'fld-1', name: 'Archive' });
    const docA = makeDoc({ id: 'doc-a', name: 'A.docx' });
    const created1 = makeDoc({ id: 'created-1', name: 'Untitled document.docx', updatedAt: 1_700_000_200_000 });
    const uploadedDoc = makeDoc({ id: 'uploaded-1', name: 'Spec.pdf', mimeType: 'application/pdf', updatedAt: 1_700_000_300_000 });
    const renamedUpload = { ...uploadedDoc, name: 'FinalSpec.pdf' };
    const movedUpload = { ...renamedUpload, folderId: 'fld-1' };

    listCloudDocsApiMock
      .mockResolvedValueOnce({ folders: [fld1], docs: [docA], sharedFolders: [], sharedDocs: [] })
      .mockRejectedValueOnce(new Error('Refresh down 1'))
      .mockRejectedValueOnce(new Error('Refresh down 2'))
      .mockRejectedValueOnce(new Error('Refresh down 3'))
      .mockRejectedValueOnce(new Error('Refresh down 4'))
      .mockRejectedValueOnce(new Error('Refresh down 5'))
      .mockRejectedValueOnce(new Error('Refresh down 6'))
      .mockRejectedValueOnce(new Error('Refresh down 7'))
      .mockResolvedValue({
        folders: [fld1],
        docs: [created1, movedUpload],
        sharedFolders: [],
        sharedDocs: [],
      });

    createBlankCloudDocApiMock
      .mockResolvedValueOnce({ doc: created1 })
      .mockResolvedValueOnce({ doc: makeDoc({ id: 'created-2', name: 'Untitled document 2.docx' }) });
    uploadCloudDocApiMock.mockResolvedValueOnce({ doc: uploadedDoc });
    updateCloudDocApiMock
      .mockResolvedValueOnce({ doc: renamedUpload })
      .mockResolvedValueOnce({ doc: movedUpload });
    deleteCloudDocApiMock.mockResolvedValueOnce({ ok: true });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await screen.findByTestId('cloud-doc-row-doc-a');

    // 1. Create succeeds while follow-up refresh fails -> projects created1 & Back refresh fails
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await screen.findByTestId('mock-office-preview');
    expect(createBlankCloudDocApiMock).toHaveBeenNthCalledWith(1, {
      type: 'docx',
      name: 'Untitled document.docx',
      folderId: null,
    });

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    // Projected doc stays rendered even when Back refresh fails!
    await screen.findByTestId('cloud-doc-row-created-1');

    // 2. Retry create while refresh still fails -> aborts with error instead of sending duplicate Untitled document.docx
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-error')).toBeTruthy());
    expect(createBlankCloudDocApiMock).toHaveBeenCalledTimes(1);

    // 3. Upload, rename, move, and delete each project into visible list even while refresh rejects
    const pdf = new File(['%PDF'], 'Spec.pdf', { type: 'application/pdf' });
    fireEvent.drop(screen.getByTestId('cloud-docs-my-docs-list'), { dataTransfer: { files: [pdf] } });
    await screen.findByTestId('cloud-doc-row-uploaded-1');

    fireEvent.click(screen.getByTestId('cloud-doc-more-uploaded-1'));
    fireEvent.click(screen.getByTestId('rename-cloud-doc-uploaded-1'));
    fireEvent.input(screen.getByTestId('cloud-docs-rename-input'), { target: { value: 'FinalSpec.pdf' } });
    fireEvent.click(screen.getByTestId('cloud-docs-rename-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-doc-row-uploaded-1').textContent).toContain('FinalSpec.pdf');
    });

    fireEvent.click(screen.getByTestId('cloud-doc-more-uploaded-1'));
    fireEvent.click(screen.getByTestId('move-cloud-doc-uploaded-1'));
    fireEvent.change(screen.getByTestId('cloud-docs-move-select'), { target: { value: 'fld-1' } });
    fireEvent.click(screen.getByTestId('cloud-docs-move-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('cloud-doc-row-uploaded-1')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('cloud-doc-more-doc-a'));
    fireEvent.click(screen.getByTestId('delete-cloud-doc-doc-a'));
    fireEvent.click(screen.getByTestId('cloud-docs-confirm-delete-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('cloud-doc-row-doc-a')).toBeNull();
      expect((screen.getByTestId('cloud-docs-new-docx-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    // 4. Network recovers -> create refreshes authoritative server docs and allocates Untitled document 2.docx
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenNthCalledWith(2, {
        type: 'docx',
        name: 'Untitled document 2.docx',
        folderId: null,
      });
    });
  });

  it('prevents older Back-list success or error responses from rolling back newer mutation projections, while accepting fresh post-mutation refreshes', async () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    const docA = makeDoc({ id: 'doc-a', name: 'A.docx' });
    const renamed = { ...docA, name: 'Untitled document.docx' };
    const created2 = makeDoc({ id: 'doc-2', name: 'Untitled document 2.docx' });
    const serverExtra = makeDoc({ id: 'doc-3', name: 'Untitled document 3.docx' });
    const initialList = { folders: [], docs: [docA], sharedFolders: [], sharedDocs: [] };

    const oldListSuccess = deferred<{ folders: CloudDocFolder[]; docs: CloudDocItem[]; sharedFolders: []; sharedDocs: [] }>();
    const oldListFailure = deferred<{ folders: CloudDocFolder[]; docs: CloudDocItem[]; sharedFolders: []; sharedDocs: [] }>();
    const freshRefresh = deferred<{ folders: CloudDocFolder[]; docs: CloudDocItem[]; sharedFolders: []; sharedDocs: [] }>();

    listCloudDocsApiMock
      .mockResolvedValueOnce(initialList)
      .mockImplementationOnce(() => oldListSuccess.promise)
      .mockImplementationOnce(() => freshRefresh.promise)
      .mockImplementationOnce(() => oldListFailure.promise)
      .mockResolvedValue({
        folders: [],
        docs: [renamed, created2, serverExtra],
        sharedFolders: [],
        sharedDocs: [],
      });

    const save1 = deferred<{ doc: CloudDocItem }>();
    const save2 = deferred<{ doc: CloudDocItem }>();
    updateCloudDocApiMock
      .mockImplementationOnce(() => save1.promise)
      .mockImplementationOnce(() => save2.promise);

    createBlankCloudDocApiMock.mockImplementation(async (body) => ({
      doc: makeDoc({
        id: createBlankCloudDocApiMock.mock.calls.length === 1 ? 'doc-2' : `new-${createBlankCloudDocApiMock.mock.calls.length}`,
        name: String(body.name),
      }),
    }));

    render(<CloudDocsPanel initialTab="my_docs" />);
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-a')).querySelector('button.cloud-docs-row-main')!);
    const input = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Untitled document' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(1));

    // Back starts list #2 capturing stale [A.docx] before rename ACK arrives
    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    await waitFor(() => expect(listCloudDocsApiMock).toHaveBeenCalledTimes(2));

    // Rename ACK settles first; older list #2 resolves later and must not roll back projection or loading
    save1.resolve({ doc: renamed });
    await waitFor(() => {
      expect(screen.getByTestId('cloud-doc-row-doc-a').textContent).toContain('Untitled document.docx');
    });
    oldListSuccess.resolve(initialList);
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.getByTestId('cloud-doc-row-doc-a').textContent).toContain('Untitled document.docx');

    // Blank create uses preserved projection -> allocates Untitled document 2.docx, then triggers fresh post-mutation GET #3
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenNthCalledWith(1, {
        type: 'docx',
        name: 'Untitled document 2.docx',
        folderId: null,
      });
      expect(listCloudDocsApiMock).toHaveBeenCalledTimes(3);
    });

    // Fresh post-mutation GET #3 arrives with additional server doc Untitled document 3.docx
    freshRefresh.resolve({
      folders: [],
      docs: [renamed, created2, serverExtra],
      sharedFolders: [],
      sharedDocs: [],
    });
    await screen.findByTestId('mock-office-preview');

    // Rename doc-2 -> Untitled document 4.docx while Back GET #4 fails lazily after ACK #2
    const input2 = (await screen.findByTestId('cloud-docs-preview-title-input')) as HTMLInputElement;
    fireEvent.input(input2, { target: { value: 'Untitled document 4' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    await waitFor(() => expect(updateCloudDocApiMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('cloud-docs-preview-back'));
    await waitFor(() => expect(listCloudDocsApiMock).toHaveBeenCalledTimes(4));

    save2.resolve({ doc: { ...created2, name: 'Untitled document 4.docx' } });
    await waitFor(() => {
      expect(screen.getByTestId('cloud-doc-row-doc-2').textContent).toContain('Untitled document 4.docx');
    });
    oldListFailure.reject(new Error('Stale Back list failed'));
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByTestId('cloud-docs-error')).toBeNull();
    expect(screen.getByTestId('cloud-doc-row-doc-3').textContent).toContain('Untitled document 3.docx');

    // Hydrated list retains Untitled document.docx, serverExtra (Untitled document 3.docx), and projected Untitled document 4.docx -> allocates Untitled document 2.docx cleanly
    fireEvent.click(screen.getByTestId('cloud-docs-new-docx-btn'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenNthCalledWith(2, {
        type: 'docx',
        name: 'Untitled document 2.docx',
        folderId: null,
      });
    });
  });

  it('uses shared 4-column list layout and min-width: 0 shrink rules across grid and list styles', () => {
    const css = readFileSync(stylesPath, 'utf8');
    expect(css).toContain('--cloud-docs-list-cols:');
    expect(css).toContain('grid-template-columns: var(--cloud-docs-list-cols)');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('min-width: 0;');
  });

  it('applies is-standalone class, syncs document.title, and auto-opens initialDocId when mounted standalone', async () => {
    listCloudDocsApiMock.mockResolvedValue({
      folders: [{ id: 'fld-1', name: 'Specs', parentId: null, createdAt: 1, updatedAt: 1 }],
      docs: [{
        id: 'doc-deep',
        name: 'Architecture.docx',
        folderId: 'fld-1',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 1200,
        createdAt: 1,
        updatedAt: 2,
      }],
      sharedFolders: [],
      sharedDocs: [],
    });

    const view = render(
      <CloudDocsPanel standalone initialTab="my_docs" initialFolderId="fld-1" initialDocId="doc-deep" />,
    );

    const panel = await screen.findByTestId('cloud-docs-panel');
    expect(panel.className).toContain('is-standalone');
    expect(document.title).toBe('Cloud Docs');

    const preview = await screen.findByTestId('mock-office-preview');
    expect(preview.getAttribute('data-cloud-doc-id')).toBe('doc-deep');
    expect(screen.getByTestId('cloud-docs-panel').className).toContain('is-standalone');

    view.unmount();
  });

  it('renders 3 compact horizontal icon + plus buttons for docx/xlsx/pptx across desktop and mobile styles', async () => {
    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-new-docx-btn')).toBeTruthy();
      expect(screen.getByTestId('cloud-docs-new-xlsx-btn')).toBeTruthy();
      expect(screen.getByTestId('cloud-docs-new-pptx-btn')).toBeTruthy();
    });

    const strip = screen.getByTestId('cloud-docs-gallery-strip');
    expect(strip.querySelectorAll('.cloud-docs-template-thumb')).toHaveLength(0);
    for (const type of ['docx', 'xlsx', 'pptx'] as const) {
      const btn = screen.getByTestId(`cloud-docs-new-${type}-btn`);
      expect(btn.querySelector('.cloud-docs-template-plus')?.textContent).toBe('+');
      expect(btn.querySelector('svg')).toBeTruthy();
      expect(btn.getAttribute('aria-label')).toBeTruthy();
    }

    const css = readFileSync(stylesPath, 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 480px)'));
    const galleryStart = css.indexOf('.cloud-docs-gallery-strip {');
    const gallerySnippet = css.slice(galleryStart, galleryStart + 500);
    expect(gallerySnippet).toContain('display: flex');
    expect(gallerySnippet).toContain('height: 30px');
    expect(mobileBlock).toContain('.cloud-docs-gallery-strip');
    expect(mobileBlock).toContain('flex-wrap: nowrap');
  });

  it('supports right-click context menus across owned docs and folders in both list and grid views', async () => {
    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-folder-row-fld-1')).toBeTruthy();
      expect(screen.getByTestId('cloud-doc-row-doc-1')).toBeTruthy();
    });

    // Owned doc right-click in list view prevents native menu & triggers Move / Rename / Share / Delete / Download / Edit
    const docRow = screen.getByTestId('cloud-doc-row-doc-1');
    const evDoc = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 });
    docRow.dispatchEvent(evDoc);
    expect(evDoc.defaultPrevented).toBe(true);

    const menu = await screen.findByTestId('cloud-docs-context-menu');
    expect(menu.getAttribute('data-target-kind')).toBe('doc');
    expect(screen.getByTestId('cloud-docs-ctx-open').textContent).toContain('Edit');
    expect(screen.getByTestId('cloud-docs-ctx-download')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-ctx-share')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-ctx-rename')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-ctx-move')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-ctx-delete')).toBeTruthy();

    fireEvent.click(screen.getByTestId('cloud-docs-ctx-move'));
    expect(screen.queryByTestId('cloud-docs-context-menu')).toBeNull();
    expect(screen.getByTestId('cloud-docs-move-select')).toBeTruthy();

    // Switch to Grid view and verify owned folder & doc right-click actions work
    fireEvent.click(screen.getByTestId('cloud-docs-view-grid'));
    const folderRowGrid = screen.getByTestId('cloud-folder-row-fld-1');
    fireEvent.contextMenu(folderRowGrid, { clientX: 80, clientY: 90 });
    const folderMenu = await screen.findByTestId('cloud-docs-context-menu');
    expect(folderMenu.getAttribute('data-target-kind')).toBe('folder');
    expect(screen.queryByTestId('cloud-docs-ctx-move')).toBeNull();

    fireEvent.click(screen.getByTestId('cloud-docs-ctx-rename'));
    expect(screen.getByTestId('cloud-docs-rename-input')).toBeTruthy();

    // Re-open folder menu for Share & Delete
    fireEvent.contextMenu(folderRowGrid, { clientX: 80, clientY: 90 });
    fireEvent.click(await screen.findByTestId('cloud-docs-ctx-share'));
    expect(listCloudDocSharesApiMock).toHaveBeenCalledWith('folder', 'fld-1', expect.any(AbortSignal));

    fireEvent.contextMenu(folderRowGrid, { clientX: 80, clientY: 90 });
    fireEvent.click(await screen.findByTestId('cloud-docs-ctx-delete'));
    expect(screen.getByTestId('cloud-docs-delete-confirm')).toBeTruthy();

    // Doc download & open in grid view
    fireEvent.contextMenu(screen.getByTestId('cloud-doc-row-doc-1'), { clientX: 110, clientY: 140 });
    fireEvent.click(await screen.findByTestId('cloud-docs-ctx-download'));
    expect(downloadCloudDocApiMock).toHaveBeenCalledWith('doc-1', 'quarterly.docx');

    fireEvent.contextMenu(screen.getByTestId('cloud-doc-row-doc-1'), { clientX: 110, clientY: 140 });
    fireEvent.click(await screen.findByTestId('cloud-docs-ctx-open'));
    const preview = await screen.findByTestId('mock-office-preview');
    expect(preview.getAttribute('data-cloud-doc-id')).toBe('doc-1');
    expect(preview.getAttribute('data-read-only')).toBe('false');
  });

  it('enforces ACL parity on shared docs and supports shared folder right-click navigation', async () => {
    const sharedFolder: SharedCloudFolderItem = {
      id: 'sfld-1',
      userId: 'owner-2',
      parentId: null,
      name: 'Team Specs',
      createdAt: 1,
      updatedAt: 2,
      role: 'viewer',
      allowDownload: false,
      ownerName: 'Alice',
      ownerUsername: 'alice',
      sharedTeamName: 'Core',
    };
    const sharedEditorDoc: SharedCloudDocItem = {
      id: 'sdoc-edit',
      userId: 'owner-2',
      folderId: null,
      name: 'Roadmap.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 1024,
      docVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: null,
      role: 'editor',
      allowDownload: true,
      ownerName: 'Alice',
      ownerUsername: 'alice',
      sharedVia: 'doc',
      sharedTeamName: null,
      folderName: null,
    };
    const sharedViewerDoc: SharedCloudDocItem = {
      ...sharedEditorDoc,
      id: 'sdoc-view',
      name: 'Salary.xlsx',
      ext: '.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      role: 'viewer',
      allowDownload: false,
    };
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [],
      sharedFolders: [sharedFolder],
      sharedDocs: [sharedEditorDoc, sharedViewerDoc],
    });

    render(<CloudDocsPanel initialTab="shared" />);
    await waitFor(() => {
      expect(screen.getByTestId('shared-cloud-folder-row-sfld-1')).toBeTruthy();
      expect(screen.getByTestId('shared-cloud-doc-row-sdoc-edit')).toBeTruthy();
      expect(screen.getByTestId('shared-cloud-doc-row-sdoc-view')).toBeTruthy();
    });

    // Viewer with allowDownload: false -> View label, NO Download, opens read-only
    fireEvent.contextMenu(screen.getByTestId('shared-cloud-doc-row-sdoc-view'), { clientX: 90, clientY: 120 });
    const viewerMenu = await screen.findByTestId('cloud-docs-context-menu');
    expect(viewerMenu.getAttribute('data-target-kind')).toBe('shared-doc');
    expect(screen.getByTestId('cloud-docs-ctx-open').textContent).toContain('View');
    expect(screen.queryByTestId('cloud-docs-ctx-download')).toBeNull();
    expect(screen.queryByTestId('cloud-docs-ctx-share')).toBeNull();
    expect(screen.queryByTestId('cloud-docs-ctx-delete')).toBeNull();

    // Editor with allowDownload: true -> Edit label + Download
    fireEvent.contextMenu(screen.getByTestId('shared-cloud-doc-row-sdoc-edit'), { clientX: 90, clientY: 120 });
    expect(screen.getByTestId('cloud-docs-ctx-open').textContent).toContain('Edit');
    expect(screen.getByTestId('cloud-docs-ctx-download')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cloud-docs-ctx-download'));
    expect(downloadCloudDocApiMock).toHaveBeenCalledWith('sdoc-edit', 'Roadmap.docx');

    // Shared folder Open navigates into folder
    fireEvent.contextMenu(screen.getByTestId('shared-cloud-folder-row-sfld-1'), { clientX: 60, clientY: 80 });
    expect(screen.getByTestId('cloud-docs-context-menu').getAttribute('data-target-kind')).toBe('shared-folder');
    fireEvent.click(screen.getByTestId('cloud-docs-ctx-open'));
    await waitFor(() => {
      expect(screen.getByTestId('cloud-docs-shared-empty')).toBeTruthy();
    });

    // Shared tab blank canvas does not expose creation/upload actions
    fireEvent.contextMenu(screen.getByTestId('cloud-docs-canvas'), { clientX: 50, clientY: 50 });
    expect(screen.getByTestId('cloud-docs-context-menu').getAttribute('data-target-kind')).toBe('canvas');
    expect(screen.queryByTestId('cloud-docs-ctx-new-docx')).toBeNull();
    expect(screen.getByTestId('cloud-docs-ctx-toggle-view')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-ctx-refresh')).toBeTruthy();
  });

  it('supports recent doc and blank canvas context menus, viewport clamping, and clean dismissal', async () => {
    const recentOwned: RecentDocumentItem = {
      id: 'rec-own',
      userId: 'u1',
      sourceKind: 'cloud_doc',
      sourceKey: 'cloud:doc-1',
      serverId: null,
      serverName: null,
      sessionName: null,
      filePath: null,
      cloudDocId: 'doc-1',
      title: 'quarterly.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      openMode: 'edit',
      openCount: 3,
      lastOpenedAt: 1_700_000_200_000,
      createdAt: 1_700_000_000_000,
      accessible: true,
      serverOnline: true,
      accessReason: null,
      allowDownload: true,
    };
    const recentServerNoDl: RecentDocumentItem = {
      ...recentOwned,
      id: 'rec-srv',
      sourceKind: 'server_file',
      sourceKey: 'srv:s1:/tmp/spec.docx',
      serverId: 's1',
      serverName: 'devbox',
      filePath: '/tmp/spec.docx',
      cloudDocId: null,
      title: 'spec.docx',
      openMode: 'view',
      role: 'viewer',
      allowDownload: false,
    };
    listRecentDocumentsApiMock.mockResolvedValue({ items: [recentOwned, recentServerNoDl] });
    deleteRecentDocumentApiMock.mockResolvedValue({ ok: true });
    createBlankCloudDocApiMock.mockResolvedValue({ doc: makeDoc({ id: 'doc-new', name: 'Untitled spreadsheet.xlsx' }) });

    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });

    render(<CloudDocsPanel initialTab="recent" />);
    await waitFor(() => {
      expect(screen.getByTestId('recent-doc-row-rec-own')).toBeTruthy();
      expect(screen.getByTestId('recent-doc-row-rec-srv')).toBeTruthy();
    });

    // Recent server file -> View + Remove only (no Share, no Download)
    fireEvent.contextMenu(screen.getByTestId('recent-doc-row-rec-srv'), { clientX: 150, clientY: 160 });
    expect(screen.getByTestId('cloud-docs-context-menu').getAttribute('data-target-kind')).toBe('recent-doc');
    expect(screen.queryByTestId('cloud-docs-ctx-share')).toBeNull();
    expect(screen.queryByTestId('cloud-docs-ctx-download')).toBeNull();
    fireEvent.click(screen.getByTestId('cloud-docs-ctx-remove-recent'));
    await waitFor(() => {
      expect(deleteRecentDocumentApiMock).toHaveBeenCalledWith('rec-srv');
    });

    // Clamp near bottom-right corner on mobile/floating viewport dimensions
    expect(clampCloudDocsContextMenuPosition(1200, 900, 390, 640, 210, 240)).toEqual({ x: 172, y: 392 });
    expect(clampCloudDocsContextMenuPosition(-20, -10, 390, 640, 210, 240)).toEqual({ x: 8, y: 8 });

    fireEvent.contextMenu(screen.getByTestId('recent-doc-row-rec-own'), { clientX: 2000, clientY: 2000 });
    const clampedMenu = await screen.findByTestId('cloud-docs-context-menu');
    expect(Number.parseInt(clampedMenu.style.left, 10)).toBeLessThanOrEqual(1024 - 216 - 8);
    expect(Number.parseInt(clampedMenu.style.top, 10)).toBeLessThanOrEqual(768 - 260 - 8);

    // Dismiss on Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('cloud-docs-context-menu')).toBeNull();

    // Blank canvas on My Docs -> triggers New Folder, Refresh, New Sheet
    fireEvent.click(screen.getByTestId('cloud-docs-tab-my-docs'));
    await waitFor(() => expect(screen.getByTestId('cloud-docs-canvas')).toBeTruthy());

    fireEvent.contextMenu(screen.getByTestId('cloud-docs-canvas'), { clientX: 40, clientY: 60 });
    expect(screen.getByTestId('cloud-docs-context-menu').getAttribute('data-target-kind')).toBe('canvas');
    expect(screen.getByTestId('cloud-docs-ctx-new-folder')).toBeTruthy();

    // Outside click dismisses menu
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('cloud-docs-context-menu')).toBeNull();

    // Reopen canvas menu and create spreadsheet
    fireEvent.contextMenu(screen.getByTestId('cloud-docs-canvas'), { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByTestId('cloud-docs-ctx-new-xlsx'));
    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'xlsx',
        name: 'Untitled spreadsheet.xlsx',
        folderId: null,
      });
    });

    // Window blur dismisses menu
    fireEvent.contextMenu(screen.getByTestId('cloud-docs-canvas'), { clientX: 40, clientY: 60 });
    expect(screen.getByTestId('cloud-docs-context-menu')).toBeTruthy();
    fireEvent(window, new Event('blur'));
    expect(screen.queryByTestId('cloud-docs-context-menu')).toBeNull();
  });

  it('keeps desktop preview header unchanged and scopes compact single-row header + inline rename cues strictly to <= 600px', async () => {
    const doc = makeDoc({ id: 'doc-compact', name: 'Quarterly_Budget_Plan.docx', allowDownload: true });
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [doc],
      sharedFolders: [],
      sharedDocs: [],
    });

    render(<CloudDocsPanel initialTab="my_docs" />);
    fireEvent.click((await screen.findByTestId('cloud-doc-row-doc-compact')).querySelector('button.cloud-docs-row-main')!);

    const header = await screen.findByTestId('cloud-docs-preview-header');
    const titleWrap = screen.getByTestId('cloud-docs-preview-title-wrap');
    const titleInput = screen.getByTestId('cloud-docs-preview-title-input') as HTMLInputElement;
    const editHint = titleWrap.querySelector('.cloud-docs-preview-edit-hint') as HTMLElement | null;
    const backBtn = screen.getByTestId('cloud-docs-preview-back');
    const shareBtn = screen.getByTestId('cloud-docs-preview-share');
    const downloadBtn = screen.getByTestId('cloud-docs-preview-download');

    expect(header).toBeTruthy();
    expect(backBtn.getAttribute('aria-label')).toBe('Back');
    expect(shareBtn.getAttribute('aria-label')).toBe('Share');
    expect(downloadBtn.getAttribute('aria-label')).toBe('Download');
    expect(backBtn.querySelector('.cloud-docs-preview-btn-label')?.textContent).toBe('Back');
    expect(shareBtn.querySelector('.cloud-docs-preview-btn-label')?.textContent).toBe('Share');
    expect(downloadBtn.querySelector('.cloud-docs-preview-btn-label')?.textContent).toBe('Download');
    expect(editHint).toBeTruthy();

    fireEvent.click(editHint!);
    expect(document.activeElement).toBe(titleInput);

    // Check CSS boundaries: desktop rule untouched above media queries, mobile rules strictly inside @media (max-width: 600px)
    const testDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(testDir, '../../src/styles.css'), 'utf8');
    const media600Idx = css.indexOf('@media (max-width: 600px)');
    expect(media600Idx).toBeGreaterThan(-1);
    const baseCss = css.slice(0, media600Idx);
    const mobileCss = css.slice(media600Idx);

    expect(baseCss).toContain('.cloud-docs-preview-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  padding: 10px 14px;');
    expect(baseCss).not.toContain('.cloud-docs-preview-title-wrap {\n    flex: 1 1 100%;');
    expect(baseCss).not.toContain('.cloud-docs-preview-actions {\n    width: 100%;');

    expect(mobileCss).toContain('.cloud-docs-preview-header {\n    padding: 4px 8px;\n    gap: 4px;\n    min-height: 36px;\n    flex-wrap: nowrap;');
    expect(mobileCss).toContain('.cloud-docs-preview-btn-label {\n    display: none;\n  }');
    expect(mobileCss).toContain('.cloud-docs-preview-title-input {');
    expect(mobileCss).toContain('border-bottom: 1px dashed rgba(148, 163, 184, 0.85);');
  });

  it('merges main list header into a single compact row on <= 600px with collapsible mobile search while keeping desktop unchanged', async () => {
    const budgetDoc = makeDoc({ id: 'doc-budget', name: 'Budget_2026.docx', updatedAt: 1_700_000_200_000 });
    const notesDoc = makeDoc({ id: 'doc-notes', name: 'Notes.docx', updatedAt: 1_700_000_100_000 });
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [budgetDoc, notesDoc],
      sharedFolders: [],
      sharedDocs: [],
    });

    render(<CloudDocsPanel initialTab="my_docs" />);
    await waitFor(() => expect(screen.getByTestId('cloud-doc-row-doc-budget')).toBeTruthy());

    const header = screen.getByTestId('cloud-docs-header');
    const recentTab = screen.getByTestId('cloud-docs-tab-recent');
    const myDocsTab = screen.getByTestId('cloud-docs-tab-my-docs');
    const sharedTab = screen.getByTestId('cloud-docs-tab-shared');
    const searchPill = screen.getByTestId('cloud-docs-search-pill');
    const searchToggle = screen.getByTestId('cloud-docs-search-toggle');
    const searchInput = screen.getByTestId('cloud-docs-search') as HTMLInputElement;
    const typeFilter = screen.getByTestId('cloud-docs-type-filter') as HTMLSelectElement;
    const sortSelect = screen.getByTestId('cloud-docs-sort-select') as HTMLSelectElement;

    expect(recentTab.querySelector('.cloud-docs-tab-label-desktop')?.textContent).toBe('Recent');
    expect(myDocsTab.querySelector('.cloud-docs-tab-label-desktop')?.textContent).toBe('Cloud Docs');
    expect(myDocsTab.querySelector('.cloud-docs-tab-label-compact')?.textContent).toBe('Docs');
    expect(sharedTab.querySelector('.cloud-docs-tab-desktop')).toBeNull();
    expect(sharedTab.querySelector('.cloud-docs-tab-label-desktop')?.textContent).toBe('Shared');
    expect(screen.getByTestId('cloud-docs-view-list')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-view-grid')).toBeTruthy();
    expect(screen.getByTestId('cloud-docs-refresh')).toBeTruthy();
    expect(typeFilter).toBeTruthy();
    expect(sortSelect).toBeTruthy();

    expect(header.classList.contains('is-mobile-search-open')).toBe(false);
    expect(searchToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('cloud-docs-search-collapse')).toBeNull();

    // Tap mobile search trigger: expands inline search overlay and focuses input
    fireEvent.click(searchToggle);
    expect(header.classList.contains('is-mobile-search-open')).toBe(true);
    expect(searchPill.classList.contains('is-mobile-open')).toBe(true);
    expect(searchToggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(searchInput);

    // Search filters docs live; clear button clears text while keeping search open & focused
    fireEvent.input(searchInput, { target: { value: 'Budget' } });
    expect(screen.getByTestId('cloud-doc-row-doc-budget')).toBeTruthy();
    expect(screen.queryByTestId('cloud-doc-row-doc-notes')).toBeNull();

    const clearBtn = screen.getByTestId('cloud-docs-search-clear');
    fireEvent.click(clearBtn);
    expect(searchInput.value).toBe('');
    expect(document.activeElement).toBe(searchInput);
    expect(screen.getByTestId('cloud-doc-row-doc-notes')).toBeTruthy();

    // Typing then collapsing preserves active search filter and marks toggle active
    fireEvent.input(searchInput, { target: { value: 'Budget' } });
    fireEvent.click(screen.getByTestId('cloud-docs-search-collapse'));
    expect(header.classList.contains('is-mobile-search-open')).toBe(false);
    expect(searchPill.classList.contains('has-search-value')).toBe(true);
    expect(searchToggle.classList.contains('has-value')).toBe(true);
    expect(screen.getByTestId('cloud-doc-row-doc-budget')).toBeTruthy();
    expect(screen.queryByTestId('cloud-doc-row-doc-notes')).toBeNull();

    // Reopen and verify Escape collapses cleanly without bubbling out
    fireEvent.click(searchToggle);
    expect(header.classList.contains('is-mobile-search-open')).toBe(true);
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(header.classList.contains('is-mobile-search-open')).toBe(false);
    expect(searchInput.value).toBe('Budget');

    // Verify CSS boundaries: desktop base untouched, @media (max-width: 480px) no longer stacks header-right,
    // and single-row compact header rules live strictly inside @media (max-width: 600px).
    const testDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(testDir, '../../src/styles.css'), 'utf8');
    const media480Idx = css.indexOf('@media (max-width: 480px)');
    const media600Idx = css.indexOf('@media (max-width: 600px)');
    expect(media480Idx).toBeGreaterThan(-1);
    expect(media600Idx).toBeGreaterThan(media480Idx);

    const desktopCss = css.slice(0, media480Idx);
    const media480Block = css.slice(media480Idx, media600Idx);
    const mobile600Css = css.slice(media600Idx);

    expect(desktopCss).toContain('.cloud-docs-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  flex-wrap: wrap;');
    expect(desktopCss).toContain('.cloud-docs-tab-label-compact,\n.cloud-docs-search-toggle,\n.cloud-docs-search-collapse {\n  display: none;\n}');
    expect(media480Block).not.toContain('.cloud-docs-header-right');
    expect(media480Block).not.toContain('.cloud-docs-search-pill');

    expect(mobile600Css).toContain('.cloud-docs-header {\n    padding: 4px 8px;\n    gap: 4px;\n    min-height: 36px;\n    flex-wrap: nowrap;');
    expect(mobile600Css).toContain('overflow-x: auto;\n    scrollbar-width: none;');
    expect(mobile600Css).toContain('.cloud-docs-panel:not(.is-standalone) .cloud-docs-brand-mark {\n    display: none;\n  }');
    expect(mobile600Css).toContain('.cloud-docs-panel.is-standalone .cloud-docs-brand-title {\n    display: none;\n  }');
    expect(mobile600Css).toContain('.cloud-docs-header.is-mobile-search-open .cloud-docs-header-brand');
    expect(mobile600Css).toContain('.cloud-docs-header .cloud-docs-select {\n    height: 26px;');
  });
});
