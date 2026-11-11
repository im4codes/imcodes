/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { SessionInfo } from '../../src/types.js';
import type { SharedPayload } from '../../src/services/share-receiver.js';

const { uploadFileWithDirectFallbackMock } = vi.hoisted(() => ({
  uploadFileWithDirectFallbackMock: vi.fn(),
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'shareTarget.files_summary') return `Shared files (${opts?.count ?? 0})`;
      if (key === 'shareTarget.error.file_too_large') return `Exceeds ${opts?.max ?? 50} MB`;
      if (key === 'shareTarget.error.read_failed') return 'Read failed';
      return key;
    },
  }),
}));

vi.mock('../../src/direct-file-transfer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/direct-file-transfer.js')>();
  return {
    ...actual,
    prewarmDirectFileLease: vi.fn(() => undefined),
    uploadFileWithDirectFallback: (...args: unknown[]) => uploadFileWithDirectFallbackMock(...args),
  };
});

import { ShareTargetModal } from '../../src/components/ShareTargetModal.js';
import { SessionControls } from '../../src/components/SessionControls.js';

const makeSession = (overrides: Partial<SessionInfo> & { name: string }): SessionInfo => ({
  name: overrides.name,
  project: overrides.project ?? overrides.name,
  role: overrides.role ?? 'brain',
  agentType: overrides.agentType ?? 'claude-code-sdk',
  state: overrides.state ?? 'idle',
  label: overrides.label ?? null,
});

describe('ShareTargetModal & shared session attachment upload', () => {
  beforeEach(() => {
    uploadFileWithDirectFallbackMock.mockReset();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to current selectedServerId, lists navigable main sessions with activeSession highlighted first, and supports server switching', () => {
    const file1 = new File(['hello'], 'doc.pdf', { type: 'application/pdf' });
    const file2 = new File(['world!'], 'photo.png', { type: 'image/png' });
    const payload: SharedPayload = {
      id: 'share-modal-1',
      files: [file1, file2],
      text: 'Shared caption text',
    };

    const servers = [
      { id: 'srv-1', name: 'Prod Server' },
      { id: 'srv-2', name: 'Dev Box' },
    ];

    const srv1Sessions: SessionInfo[] = [
      makeSession({ name: 'deck_alpha_brain', project: 'alpha', label: 'Alpha Main' }),
      makeSession({ name: 'deck_beta_brain', project: 'beta', label: 'Beta Main' }),
      makeSession({ name: 'deck_alpha_w1', project: 'alpha', role: 'w1' as SessionInfo['role'] }),
    ];

    const onSelectServer = vi.fn();
    const onSelectSession = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <ShareTargetModal
        payload={payload}
        servers={servers}
        selectedServerId="srv-1"
        sessions={srv1Sessions}
        activeSession="deck_beta_brain"
        onSelectServer={onSelectServer}
        onSelectSession={onSelectSession}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('share-target-files-section').textContent).toContain('Shared files (2)');
    expect(screen.getByTestId('share-target-file-list').textContent).toContain('doc.pdf');
    expect(screen.getByTestId('share-target-file-list').textContent).toContain('photo.png');
    expect(screen.getByTestId('share-target-text-preview').textContent).toContain('Shared caption text');

    const serverSelect = screen.getByTestId('share-target-server-select') as HTMLSelectElement;
    expect(serverSelect.value).toBe('srv-1');

    // Only navigable brain main sessions are listed, with activeSession placed first
    const sessionList = screen.getByTestId('share-target-session-list');
    const sessionButtons = sessionList.querySelectorAll('button');
    expect(sessionButtons).toHaveLength(2);
    expect(sessionButtons[0]?.getAttribute('data-testid')).toBe('share-target-session-deck_beta_brain');
    expect(sessionButtons[1]?.getAttribute('data-testid')).toBe('share-target-session-deck_alpha_brain');
    expect(screen.getByTestId('share-target-current-badge')).toBeDefined();

    // Switch server to srv-2
    fireEvent.change(serverSelect, { target: { value: 'srv-2' } });
    expect(onSelectServer).toHaveBeenCalledWith('srv-2');

    const srv2Sessions: SessionInfo[] = [
      makeSession({ name: 'deck_gamma_brain', project: 'gamma', label: 'Gamma Main' }),
    ];
    rerender(
      <ShareTargetModal
        payload={payload}
        servers={servers}
        selectedServerId="srv-2"
        sessions={srv2Sessions}
        activeSession={null}
        onSelectServer={onSelectServer}
        onSelectSession={onSelectSession}
        onClose={onClose}
      />,
    );

    const gammaBtn = screen.getByTestId('share-target-session-deck_gamma_brain');
    fireEvent.click(gammaBtn);
    expect(onSelectSession).toHaveBeenCalledWith('srv-2', 'deck_gamma_brain');
  });

  it('displays error banner and disables session selection when share has only an error', () => {
    const payload: SharedPayload = {
      id: 'share-err-1',
      files: [],
      error: 'file_too_large',
    };
    const onSelectSession = vi.fn();

    render(
      <ShareTargetModal
        payload={payload}
        servers={[{ id: 'srv-1', name: 'Prod Server' }]}
        selectedServerId="srv-1"
        sessions={[makeSession({ name: 'deck_alpha_brain', project: 'alpha' })]}
        activeSession="deck_alpha_brain"
        onSelectServer={vi.fn()}
        onSelectSession={onSelectSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('share-target-error').textContent).toContain('Exceeds 50 MB');
    const sessionBtn = screen.getByTestId('share-target-session-deck_alpha_brain') as HTMLButtonElement;
    expect(sessionBtn.disabled).toBe(true);
    fireEvent.click(sessionBtn);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('shows warning banner for partial_files_skipped while still allowing valid files to be shared', () => {
    const validFile = new File(['ok'], 'small.txt', { type: 'text/plain' });
    const payload: SharedPayload = {
      id: 'share-partial-1',
      files: [validFile],
      error: 'partial_files_skipped',
    };
    const onSelectSession = vi.fn();

    render(
      <ShareTargetModal
        payload={payload}
        servers={[{ id: 'srv-1', name: 'Prod Server' }]}
        selectedServerId="srv-1"
        sessions={[makeSession({ name: 'deck_alpha_brain', project: 'alpha' })]}
        activeSession="deck_alpha_brain"
        onSelectServer={vi.fn()}
        onSelectSession={onSelectSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('share-target-error').textContent).toContain('shareTarget.error.partial_files_skipped');
    const sessionBtn = screen.getByTestId('share-target-session-deck_alpha_brain') as HTMLButtonElement;
    expect(sessionBtn.disabled).toBe(false);
    fireEvent.click(sessionBtn);
    expect(onSelectSession).toHaveBeenCalledWith('srv-1', 'deck_alpha_brain');
  });

  it('uploads shared files into the target session composer and appends shared text while keeping input editable', async () => {
    uploadFileWithDirectFallbackMock.mockImplementation(async ({ file }: { file: File }) => ({
      attachment: {
        id: `att-${file.name}`,
        daemonPath: `/tmp/uploads/${file.name}`,
        serverId: 'srv-2',
      },
      mode: 'relay',
    }));

    const sharedFile = new File(['shared-content'], 'shared-spec.md', { type: 'text/markdown' });
    const onConsumed = vi.fn();
    const onComposerTextChange = vi.fn();

    const quickDataStub = {
      data: { history: {}, sessionHistory: {}, commands: [], phrases: [] },
      loading: false,
      recordHistory: vi.fn(),
      addCommand: vi.fn(),
      removeCommand: vi.fn(),
      addPhrase: vi.fn(),
      removePhrase: vi.fn(),
      clearHistory: vi.fn(),
      removeHistoryEntry: vi.fn(),
    };

    // Pre-populate existing draft for the target session to verify shared text appends without clobbering
    sessionStorage.setItem('rcc_draft_session:deck_gamma_brain', 'Existing draft');

    const { rerender, container } = render(
      <SessionControls
        ws={null}
        connected
        serverId="srv-1"
        activeSession={makeSession({ name: 'deck_alpha_brain', project: 'alpha' })}
        quickData={quickDataStub}
        pendingSharedUpload={{
          id: 'upload-1',
          serverId: 'srv-2',
          sessionName: 'deck_gamma_brain',
          files: [sharedFile],
          text: 'Shared note from external app',
        }}
        onPendingSharedUploadConsumed={onConsumed}
        onComposerTextChange={onComposerTextChange}
      />,
    );

    // Mismatched server/session must NOT consume or upload
    expect(onConsumed).not.toHaveBeenCalled();
    expect(uploadFileWithDirectFallbackMock).not.toHaveBeenCalled();

    // Switch to target server + target main session
    rerender(
      <SessionControls
        ws={null}
        connected
        serverId="srv-2"
        activeSession={makeSession({ name: 'deck_gamma_brain', project: 'gamma' })}
        quickData={quickDataStub}
        pendingSharedUpload={{
          id: 'upload-1',
          serverId: 'srv-2',
          sessionName: 'deck_gamma_brain',
          files: [sharedFile],
          text: 'Shared note from external app',
        }}
        onPendingSharedUploadConsumed={onConsumed}
        onComposerTextChange={onComposerTextChange}
      />,
    );

    await waitFor(() => {
      expect(onConsumed).toHaveBeenCalledWith('upload-1');
      expect(uploadFileWithDirectFallbackMock).toHaveBeenCalledTimes(1);
    });

    expect(uploadFileWithDirectFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      serverId: 'srv-2',
      file: sharedFile,
    });

    // Attachment badge (#1 shared-spec.md) is mounted above the composer
    await waitFor(() => {
      expect(container.textContent).toContain('#1');
      expect(container.textContent).toContain('shared-spec.md');
    });

    // Existing draft was preserved and shared text was appended, and user can continue typing
    const inputEl = container.querySelector('[data-onboarding="chat-input"]') as HTMLDivElement;
    expect(inputEl).not.toBeNull();
    expect(inputEl.textContent).toContain('Existing draft');
    expect(inputEl.textContent).toContain('Shared note from external app');
  });
});
