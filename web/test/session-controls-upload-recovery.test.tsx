/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import {
  listPendingUploadsForKey,
  persistPendingUploadFile,
  resetPendingUploadStoreForTests,
} from '../src/pending-upload-store.js';
import type { SessionInfo } from '../src/types.js';

const { directMocks, stableT, stableI18n } = vi.hoisted(() => ({
  directMocks: {
    uploadFileWithDirectFallback: vi.fn(),
    prewarmDirectFileLease: vi.fn(() => undefined),
  },
  stableI18n: { language: 'en', resolvedLanguage: 'en' },
  stableT: (key: string, opts?: Record<string, unknown>) => {
    if (key === 'upload.cancel') return 'Cancel';
    if (key === 'upload.cancel_named') return `Cancel ${String(opts?.name ?? '')}`;
    if (key === 'upload.retry') return 'Retry';
    if (key === 'common.dismiss') return 'Dismiss';
    return key;
  },
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: stableI18n,
    t: stableT,
  }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
  registerPlugin: () => ({ start: async () => ({ started: true }), stop: async () => {} }),
}));

vi.mock('../src/direct-file-transfer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/direct-file-transfer.js')>();
  return {
    ...actual,
    prewarmDirectFileLease: directMocks.prewarmDirectFileLease,
    uploadFileWithDirectFallback: (...args: Parameters<typeof actual.uploadFileWithDirectFallback>) => (
      directMocks.uploadFileWithDirectFallback(...args)
    ),
  };
});

vi.mock('../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: () => null,
  EMPTY_QUICK_DATA: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  getNavigableHistory: () => [],
}));

vi.mock('../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

vi.mock('../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
}));

vi.mock('../src/components/AtPicker.js', () => ({
  AtPicker: () => {
    const [_unused] = useState(false);
    void _unused;
    return null;
  },
}));

vi.mock('../src/components/file-browser-lazy.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../src/api.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string) {
      super(code);
    }
  },
  uploadFile: vi.fn(),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  fetchSupervisorDefaults: vi.fn().mockResolvedValue(null),
  fetchSessionSupervisorDefaults: vi.fn().mockResolvedValue(null),
  saveSessionSupervisorDefaults: async (_s: string, _n: string, v: unknown) => v,
  patchSession: vi.fn().mockResolvedValue(undefined),
  patchSessionSupervision: vi.fn().mockResolvedValue(null),
  patchSubSession: vi.fn().mockResolvedValue(undefined),
  sendSessionViaHttp: vi.fn().mockResolvedValue(undefined),
  onUserPrefChanged: vi.fn(() => () => {}),
}));

import { SessionControls, resetPendingUploadRecoveryForTests } from '../src/components/SessionControls.js';
import { DirectFileTransferFailure } from '../src/direct-file-transfer.js';
import { DIRECT_FILE_TRANSFER_ERROR } from '@shared/direct-file-transfer.js';
import { resetUploadLifecycleForTests } from '../src/upload-suspend-wait.js';

const makeQuickData = () => ({
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
});

const makeSession = (name = 'my-session'): SessionInfo => ({
  name,
  project: 'my-project',
  role: 'w1',
  agentType: 'worker',
  state: 'idle',
  projectDir: '/tmp/project',
});

const makeWs = () => ({
  send: vi.fn(),
  sendSessionCommand: vi.fn(),
  sendSessionMessage: vi.fn(),
  sendSessionCommandUrgent: vi.fn(),
  cloneSessionGroup: vi.fn(),
  cancelSessionGroupClone: vi.fn(),
  sendInput: vi.fn(),
  requestSessionList: vi.fn(),
  p2pStatus: vi.fn(),
  p2pListDiscussions: vi.fn(),
  subscribeTransportSession: vi.fn(),
  unsubscribeTransportSession: vi.fn(),
  respondTransportApproval: vi.fn(),
  connected: true,
  targetsServer: vi.fn(() => true),
  subSessionSetModel: vi.fn(),
  fsListDir: vi.fn(() => 'req'),
  onMessage: vi.fn(() => () => {}),
  getDaemonCapabilitySnapshot: vi.fn(() => ({
    daemonId: 'd-1',
    capabilities: [],
    helloEpoch: 1,
    sentAt: Date.now(),
    observedAt: Date.now(),
  })),
  onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
  isDaemonCapabilityStale: vi.fn(() => false),
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('SessionControls mobile upload IDB persistence, auto-retry & cleanup', () => {
  const prevCapacitor = (globalThis as { Capacitor?: unknown }).Capacitor;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetPendingUploadStoreForTests();
    resetPendingUploadRecoveryForTests();
    resetUploadLifecycleForTests();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    directMocks.uploadFileWithDirectFallback.mockReset();
    directMocks.prewarmDirectFileLease.mockReset();
    setVisibility('visible');
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  });

  afterEach(async () => {
    cleanup();
    resetPendingUploadStoreForTests();
    resetPendingUploadRecoveryForTests();
    resetUploadLifecycleForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    setVisibility('visible');
    (globalThis as { Capacitor?: unknown }).Capacitor = prevCapacitor;
  });

  it('persists native upload into IndexedDB and auto-retries with same clientUploadId on foreground resume', async () => {
    const seenClientIds: string[] = [];
    let failFirst = true;
    directMocks.uploadFileWithDirectFallback.mockImplementation(async (opts: {
      clientUploadId?: string;
      file: File;
    }) => {
      seenClientIds.push(opts.clientUploadId ?? '');
      if (failFirst) {
        failFirst = false;
        throw new Error('network error');
      }
      return {
        ok: true,
        attachment: {
          id: 'att-1',
          source: 'upload',
          serverId: 'srv-1',
          daemonPath: `/tmp/${opts.file.name}`,
          originalName: opts.file.name,
          size: opts.file.size,
          createdAt: '2026-11-15T00:00:00.000Z',
          downloadable: true,
        },
      };
    });

    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as never}
        activeSession={makeSession('my-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    const file = new File(['hello-ios-android'], 'mobile-photo.jpg', { type: 'image/jpeg' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [file],
        getData: () => '',
      },
    });

    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTestId('composer-upload-row')).toHaveLength(1));

    // Pending record must still be in IndexedDB while upload is in error state awaiting recovery
    const storedAfterFail = await listPendingUploadsForKey('composer:session:my-session', 'srv-1');
    expect(storedAfterFail).toHaveLength(1);
    expect(storedAfterFail[0].meta.clientUploadId).toBe(seenClientIds[0]);

    // Simulate returning to foreground / regaining network -> auto-retries with exact same clientUploadId
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2));
    expect(seenClientIds[0]).toBeTruthy();
    expect(seenClientIds[1]).toBe(seenClientIds[0]);

    // Upon success, IDB record is deleted cleanly
    await waitFor(async () => {
      const remaining = await listPendingUploadsForKey('composer:session:my-session', 'srv-1');
      expect(remaining).toHaveLength(0);
    });
  });

  it('automatically recovers persisted pending upload on cold-start mount and avoids duplicate recovery', async () => {
    const file = new File(['survives-wkcontent-kill'], 'recover-me.bin', { type: 'application/octet-stream' });
    await persistPendingUploadFile({
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:session:my-session',
      clientUploadId: 'cid-cold-start-1',
      file,
    });

    directMocks.uploadFileWithDirectFallback.mockImplementation(async (opts: {
      clientUploadId?: string;
      file: File;
    }) => ({
      ok: true,
      attachment: {
        id: 'att-cold',
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/recover-me.bin',
        originalName: opts.file.name,
        size: opts.file.size,
        createdAt: '2026-11-15T00:00:00.000Z',
        downloadable: true,
      },
    }));

    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as never}
        activeSession={makeSession('my-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
    expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv-1',
        clientUploadId: 'cid-cold-start-1',
      }),
    );

    await waitFor(async () => {
      const remaining = await listPendingUploadsForKey('composer:session:my-session', 'srv-1');
      expect(remaining).toHaveLength(0);
    });
  });

  it('deletes IndexedDB record on user Cancel or Dismiss and never auto-restarts on foreground', async () => {
    let rejectFirst!: (err: unknown) => void;
    directMocks.uploadFileWithDirectFallback
      .mockImplementationOnce((opts: { signal?: AbortSignal }) => (
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
          opts.signal?.addEventListener('abort', () => {
            const abortErr = new Error('canceled');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        })
      ))
      .mockRejectedValueOnce(new Error('network error'));

    const ws = makeWs();
    const { container } = render(
      <SessionControls
        ws={ws as never}
        activeSession={makeSession('my-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;

    // Case 1: Cancel an in-flight upload
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['cancel-me'], 'cancel.bin', { type: 'application/octet-stream' })],
        getData: () => '',
      },
    });
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await listPendingUploadsForKey('composer:session:my-session', 'srv-1')).toHaveLength(1));

    const cancelBtn = container.querySelector('.composer-upload-cancel') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn);
    void rejectFirst;

    await waitFor(async () => expect(await listPendingUploadsForKey('composer:session:my-session', 'srv-1')).toHaveLength(0));

    // Case 2: Fail then Dismiss -> deletes IDB record
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['dismiss-me'], 'dismiss.bin', { type: 'application/octet-stream' })],
        getData: () => '',
      },
    });
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('.composer-upload-dismiss')).toBeTruthy());
    expect(await listPendingUploadsForKey('composer:session:my-session', 'srv-1')).toHaveLength(1);

    fireEvent.click(container.querySelector('.composer-upload-dismiss') as HTMLButtonElement);
    await waitFor(async () => expect(await listPendingUploadsForKey('composer:session:my-session', 'srv-1')).toHaveLength(0));

    // Foreground/online events afterwards must NOT re-trigger either canceled or dismissed upload
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2);
  });

  it('persists web (!isNative) uploads in IndexedDB and preserves row + recovers across app-switch and WS reconnect while CONNECTING', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => 'web',
    };

    const seenClientIds: string[] = [];
    let rejectFirstAttempt!: (err: unknown) => void;
    directMocks.uploadFileWithDirectFallback
      .mockImplementationOnce((opts: { clientUploadId?: string }) => {
        seenClientIds.push(opts.clientUploadId ?? '');
        return new Promise((_resolve, reject) => {
          rejectFirstAttempt = reject;
        });
      })
      .mockImplementationOnce(async (opts: { clientUploadId?: string; file: File }) => {
        seenClientIds.push(opts.clientUploadId ?? '');
        return {
          ok: true,
          attachment: {
            id: 'att-web-1',
            source: 'upload',
            serverId: 'srv-1',
            daemonPath: `/tmp/${opts.file.name}`,
            originalName: opts.file.name,
            size: opts.file.size,
            createdAt: '2026-11-16T00:00:00.000Z',
            downloadable: true,
          },
        };
      });

    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('web-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    const file = new File(['web-connecting-persist'], 'web-photo.jpg', { type: 'image/jpeg' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [file],
        getData: () => '',
      },
    });

    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
    // Web must await IndexedDB persistence before starting transport so IDB already holds it during CONNECTING
    const storedOnConnecting = await listPendingUploadsForKey('composer:session:web-session', 'srv-1');
    expect(storedOnConnecting).toHaveLength(1);
    expect(storedOnConnecting[0].meta.clientUploadId).toBe(seenClientIds[0]);

    // User switches out while still CONNECTING and WS drops (connected=false)
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    rerender(
      <SessionControls
        ws={{ ...ws, connected: false } as never}
        connected={false}
        activeSession={makeSession('web-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    // Non-user AbortError while disconnected must NOT delete IndexedDB or drop the row
    await act(async () => {
      const nonUserAbort = new Error('ws closed');
      nonUserAbort.name = 'AbortError';
      rejectFirstAttempt(nonUserAbort);
    });
    await waitFor(() => expect(screen.getAllByTestId('composer-upload-row')).toHaveLength(1));
    expect(await listPendingUploadsForKey('composer:session:web-session', 'srv-1')).toHaveLength(1);

    // User returns to foreground and WS reconnects -> auto-retries with exact same clientUploadId and succeeds
    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    rerender(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('web-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2));
    expect(seenClientIds[1]).toBe(seenClientIds[0]);
    await waitFor(async () => {
      expect(await listPendingUploadsForKey('composer:session:web-session', 'srv-1')).toHaveLength(0);
    });
  });

  it('preserves non-user CANCELED error uploads, survives multiple reconnect/resume failures after cold mount, and keeps CONNECTING row visible before WS connects', async () => {
    const file = new File(['cold-reconnect'], 'reconnect.bin', { type: 'application/octet-stream' });
    await persistPendingUploadFile({
      serverId: 'srv-1',
      sessionName: '',
      composerKey: 'composer:session:cold-reconnect',
      clientUploadId: 'cid-cold-multi-retry',
      file,
    });

    directMocks.uploadFileWithDirectFallback
      .mockRejectedValueOnce(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false))
      .mockRejectedValueOnce(new Error('transient reconnect failure'))
      .mockResolvedValueOnce({
        ok: true,
        attachment: {
          id: 'att-recovered',
          source: 'upload',
          serverId: 'srv-1',
          daemonPath: '/tmp/reconnect.bin',
          originalName: 'reconnect.bin',
          size: file.size,
          createdAt: '2026-11-16T00:00:00.000Z',
          downloadable: true,
        },
      });

    const ws = makeWs();
    // Mount with connected=false (e.g. WebView reloaded right after returning from another app while WS reconnects)
    const { rerender } = render(
      <SessionControls
        ws={{ ...ws, connected: false } as never}
        connected={false}
        activeSession={makeSession('cold-reconnect')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    // CONNECTING row must appear immediately even before WS finishes reconnecting, without firing transport yet
    await waitFor(() => expect(screen.getAllByTestId('composer-upload-row')).toHaveLength(1));
    expect(directMocks.uploadFileWithDirectFallback).not.toHaveBeenCalled();

    // Connect -> attempt 1 throws non-user CANCELED -> row & IDB MUST NOT be deleted
    rerender(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('cold-reconnect')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTestId('composer-upload-row')).toHaveLength(1));
    expect(await listPendingUploadsForKey('composer:session:cold-reconnect', 'srv-1')).toHaveLength(1);

    // Background -> foreground wake triggers attempt 2, which also fails transiently
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2));
    expect(await listPendingUploadsForKey('composer:session:cold-reconnect', 'srv-1')).toHaveLength(1);

    // Subsequent WS disconnect -> reconnect still auto-retries (not blocked by autoRetried/recoveredPendingUploadIds) and succeeds!
    rerender(
      <SessionControls
        ws={{ ...ws, connected: false } as never}
        connected={false}
        activeSession={makeSession('cold-reconnect')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );
    rerender(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('cold-reconnect')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(3));
    await waitFor(async () => {
      expect(await listPendingUploadsForKey('composer:session:cold-reconnect', 'srv-1')).toHaveLength(0);
    });
  });

  it('auto-retries an upload whose pre-background attempt rejects shortly after returning to foreground', async () => {
    let rejectStale!: (err: unknown) => void;
    directMocks.uploadFileWithDirectFallback
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectStale = reject;
      }))
      .mockResolvedValueOnce({
        ok: true,
        attachment: {
          id: 'att-stale-retry',
          source: 'upload',
          serverId: 'srv-1',
          daemonPath: '/tmp/stale.bin',
          originalName: 'stale.bin',
          size: 5,
          createdAt: '2026-11-16T00:00:00.000Z',
          downloadable: true,
        },
      });

    render(
      <SessionControls
        ws={makeWs() as never}
        connected={true}
        activeSession={makeSession('stale-session')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['stale'], 'stale.bin', { type: 'application/octet-stream' })],
        getData: () => '',
      },
    });
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));

    // App goes background then returns BEFORE stale promise rejects
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Now stale attempt rejects after app is already visible again -> must auto-retry without waiting for another wake
    await act(async () => {
      rejectStale(new Error('stale socket dropped'));
    });
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(2));
    await waitFor(async () => {
      expect(await listPendingUploadsForKey('composer:session:stale-session', 'srv-1')).toHaveLength(0);
    });
  });

  it('resumes a waitingForConnection upload when switching back to its session while connected is already true', async () => {
    directMocks.uploadFileWithDirectFallback.mockResolvedValueOnce({
      ok: true,
      attachment: {
        id: 'att-switched-back',
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/switch.bin',
        originalName: 'switch.bin',
        size: 6,
        createdAt: '2026-11-16T00:00:00.000Z',
        downloadable: true,
      },
    });

    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={{ ...ws, connected: false } as never}
        connected={false}
        activeSession={makeSession('sess-a')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );

    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        files: [new File(['switch'], 'switch.bin', { type: 'application/octet-stream' })],
        getData: () => '',
      },
    });
    await waitFor(() => expect(screen.getAllByTestId('composer-upload-row')).toHaveLength(1));
    expect(directMocks.uploadFileWithDirectFallback).not.toHaveBeenCalled();

    // Switch to sess-b while connected transitions true, then switch back to sess-a while connected stays true
    rerender(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('sess-b')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );
    expect(directMocks.uploadFileWithDirectFallback).not.toHaveBeenCalled();

    rerender(
      <SessionControls
        ws={ws as never}
        connected={true}
        activeSession={makeSession('sess-a')}
        quickData={makeQuickData() as never}
        serverId="srv-1"
      />,
    );
    await waitFor(() => expect(directMocks.uploadFileWithDirectFallback).toHaveBeenCalledTimes(1));
  });
});
