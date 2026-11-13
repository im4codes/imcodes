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
  getCloudDocDownloadUrl: (docId: string, inline?: boolean) =>
    `/api/cloud-docs/docs/${encodeURIComponent(docId)}/download${inline ? '?inline=1' : ''}`,
  listRecentDocumentsApi: (...args: unknown[]) => listRecentDocumentsApiMock(...args),
  deleteRecentDocumentApi: (...args: unknown[]) => deleteRecentDocumentApiMock(...args),
}));

import { CloudDocsPanel } from '../../src/components/CloudDocsPanel.js';

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
    const docInput = screen.getByTestId('cloud-docs-new-doc-input');
    fireEvent.input(docInput, {
      target: { value: 'Onboarding' },
    });
    fireEvent.submit(docInput.closest('form')!);

    await waitFor(() => {
      expect(createBlankCloudDocApiMock).toHaveBeenCalledWith({
        type: 'docx',
        name: 'Onboarding',
        folderId: null,
      });
      const preview = screen.getByTestId('mock-office-preview');
      expect(preview.getAttribute('data-cloud-doc-id')).toBe('doc-2');
      expect(preview.getAttribute('data-read-only')).toBe('false');
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
      expect(upsertCloudDocShareApiMock).toHaveBeenCalledWith({
        targetKind: 'doc',
        targetId: 'doc-1',
        shareMode: 'team',
        targetTeamId: 'team-1',
        targetUsername: undefined,
        role: 'editor',
        allowDownload: true,
      });
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
      expect(upsertCloudDocShareApiMock).toHaveBeenLastCalledWith({
        targetKind: 'doc',
        targetId: 'doc-1',
        shareMode: 'user',
        targetTeamId: undefined,
        targetUsername: 'bob',
        role: 'viewer',
        allowDownload: false,
      });
      expect(screen.getByTestId('cloud-doc-share-item-share-2')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('revoke-cloud-share-share-1'));
    await waitFor(() => {
      expect(revokeCloudDocShareApiMock).toHaveBeenCalledWith('share-1');
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
});
