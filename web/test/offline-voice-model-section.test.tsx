/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { OfflineSpeechModelDownloadResult, OfflineSpeechModelStatus } from '@shared/voice-recognition.js';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';

const mockManagerState = vi.hoisted(() => ({
  manager: null as {
    getOfflineModelStatus: ReturnType<typeof vi.fn<() => Promise<OfflineSpeechModelStatus>>>;
    downloadOfflineModel: ReturnType<typeof vi.fn<(opts?: { allowCellular?: boolean }) => Promise<OfflineSpeechModelDownloadResult>>>;
    cancelOfflineModelDownload: ReturnType<typeof vi.fn<() => Promise<{ cancelled: boolean; status: OfflineSpeechModelStatus }>>>;
    deleteOfflineModel: ReturnType<typeof vi.fn<() => Promise<{ deleted: boolean; status: OfflineSpeechModelStatus }>>>;
    addListener: ReturnType<typeof vi.fn>;
  } | null,
  shellOutdated: false,
  listener: null as ((status: OfflineSpeechModelStatus) => void) | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (
      opts?.sizeMb !== undefined ? `${key}(${opts.sizeMb})` : key
    ),
  }),
}));

vi.mock('../src/voice-recognition-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/voice-recognition-backend.js')>();
  return {
    ...actual,
    getNativeOfflineSpeechModelManager: () => mockManagerState.manager,
    isNativeOfflineModelShellOutdated: () => mockManagerState.shellOutdated,
  };
});

import { OfflineVoiceModelSection } from '../src/components/OfflineVoiceModelSection.js';

function makeStatus(overrides: Partial<OfflineSpeechModelStatus> = {}): OfflineSpeechModelStatus {
  return {
    status: 'idle',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 712_777_119,
    allowCellular: false,
    networkType: 'wifi',
    requiresCellularConfirmation: false,
    error: null,
    supported: true,
    bundled: false,
    ...overrides,
  };
}

describe('OfflineVoiceModelSection', () => {
  beforeEach(() => {
    mockManagerState.listener = null;
    mockManagerState.shellOutdated = false;
    mockManagerState.manager = {
      getOfflineModelStatus: vi.fn<() => Promise<OfflineSpeechModelStatus>>().mockResolvedValue(makeStatus()),
      downloadOfflineModel: vi.fn<(opts?: { allowCellular?: boolean }) => Promise<OfflineSpeechModelDownloadResult>>(),
      cancelOfflineModelDownload: vi.fn<() => Promise<{ cancelled: boolean; status: OfflineSpeechModelStatus }>>(),
      deleteOfflineModel: vi.fn<() => Promise<{ deleted: boolean; status: OfflineSpeechModelStatus }>>(),
      addListener: vi.fn().mockImplementation(async (_event: string, cb: (status: OfflineSpeechModelStatus) => void) => {
        mockManagerState.listener = cb;
        return { remove: vi.fn().mockResolvedValue(undefined) };
      }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing when native offline model manager is unavailable', () => {
    mockManagerState.manager = null;
    const { container } = render(<OfflineVoiceModelSection />);
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('settings-offline-voice-card')).toBeNull();
  });

  it('starts Wi-Fi-only download on click (allowCellular=false) and prompts before cellular download', async () => {
    const cellularPromptStatus = makeStatus({
      networkType: 'cellular',
      requiresCellularConfirmation: true,
    });
    mockManagerState.manager!.getOfflineModelStatus.mockResolvedValue(cellularPromptStatus);
    mockManagerState.manager!.downloadOfflineModel
      .mockResolvedValueOnce({
        started: false,
        requiresCellularConfirmation: true,
        status: cellularPromptStatus,
      })
      .mockResolvedValueOnce({
        started: false,
        requiresCellularConfirmation: true,
        status: cellularPromptStatus,
      })
      .mockResolvedValueOnce({
        started: true,
        requiresCellularConfirmation: false,
        status: makeStatus({ status: 'downloading', allowCellular: true, networkType: 'cellular', progress: 0.1 }),
      });

    render(<OfflineVoiceModelSection />);
    const downloadBtn = await screen.findByTestId('settings-offline-voice-download');
    expect(downloadBtn.textContent).toContain('712');

    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(mockManagerState.manager!.downloadOfflineModel).toHaveBeenCalledWith({ allowCellular: false });
    });

    const confirmBox = await screen.findByTestId('settings-offline-voice-cellular-confirm');
    expect(confirmBox).toBeTruthy();

    // Cancelling the cellular confirmation returns cleanly without calling allowCellular: true.
    fireEvent.click(screen.getByTestId('settings-offline-voice-cellular-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('settings-offline-voice-cellular-confirm')).toBeNull();
    });
    expect(mockManagerState.manager!.downloadOfflineModel).toHaveBeenCalledTimes(1);

    // Re-open cellular prompt and confirm mobile data download.
    fireEvent.click(await screen.findByTestId('settings-offline-voice-download'));
    await screen.findByTestId('settings-offline-voice-cellular-confirm');
    fireEvent.click(screen.getByTestId('settings-offline-voice-cellular-proceed'));

    await waitFor(() => {
      expect(mockManagerState.manager!.downloadOfflineModel).toHaveBeenLastCalledWith({ allowCellular: true });
    });
    await screen.findByTestId('settings-offline-voice-cancel');
  });

  it('tracks live download progress, cancels active downloads, and deletes ready models', async () => {
    mockManagerState.manager!.getOfflineModelStatus.mockResolvedValue(
      makeStatus({ status: 'downloading', progress: 0.42, downloadedBytes: 300_000_000 }),
    );
    mockManagerState.manager!.cancelOfflineModelDownload.mockResolvedValue({
      cancelled: true,
      status: makeStatus({ status: 'idle', progress: 0, downloadedBytes: 0 }),
    });
    mockManagerState.manager!.deleteOfflineModel.mockResolvedValue({
      deleted: true,
      status: makeStatus({ status: 'idle', progress: 0, downloadedBytes: 0 }),
    });

    render(<OfflineVoiceModelSection />);
    const cancelBtn = await screen.findByTestId('settings-offline-voice-cancel');
    expect(screen.getByTestId('settings-offline-voice-progress-text').textContent).toContain('settings.offline_voice_model_downloading');

    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(mockManagerState.manager!.cancelOfflineModelDownload).toHaveBeenCalledTimes(1);
    });
    await screen.findByTestId('settings-offline-voice-download');

    // Simulate listener transition to ready, then delete weights.
    mockManagerState.listener?.(makeStatus({ status: 'ready', progress: 1, downloadedBytes: 712_777_119 }));
    await screen.findByTestId('settings-offline-voice-ready-badge');
    const deleteBtn = await screen.findByTestId('settings-offline-voice-delete');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(mockManagerState.manager!.deleteOfflineModel).toHaveBeenCalledTimes(1);
    });
    await screen.findByTestId('settings-offline-voice-download');
  });

  it('keeps offline_voice_model locale keys synchronized across all 7 locales', () => {
    const expectedKeys = Object.keys((en as { settings: Record<string, string> }).settings)
      .filter((key) => key.startsWith('offline_voice_model_'))
      .sort();
    expect(expectedKeys.length).toBeGreaterThanOrEqual(16);
    for (const locale of [zhCN, zhTW, ja, ko, es, ru]) {
      const settings = (locale as { settings: Record<string, unknown> }).settings;
      for (const key of expectedKeys) {
        expect(typeof settings[key], `missing/invalid ${key}`).toBe('string');
        expect((settings[key] as string).trim().length, `empty ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('shows localized update hint without download button when older iOS shell is pre-detected', () => {
    mockManagerState.manager = null;
    mockManagerState.shellOutdated = true;
    render(<OfflineVoiceModelSection />);
    const notice = screen.getByTestId('settings-offline-voice-update-required');
    expect(notice.textContent).toBe('settings.offline_voice_model_app_update_required');
    expect(screen.queryByTestId('settings-offline-voice-download')).toBeNull();
    expect(screen.queryByTestId('settings-offline-voice-error')).toBeNull();
  });

  it('transitions to update hint without exposing raw error when getOfflineModelStatus or downloadOfflineModel rejects with UNIMPLEMENTED', async () => {
    const unimplementedStatusErr = Object.assign(
      new Error('"StreamingSpeech.getOfflineModelStatus()" is not implemented on ios'),
      { code: 'UNIMPLEMENTED' },
    );
    mockManagerState.manager!.getOfflineModelStatus.mockRejectedValueOnce(unimplementedStatusErr);
    const { unmount } = render(<OfflineVoiceModelSection />);
    const notice = await screen.findByTestId('settings-offline-voice-update-required');
    expect(notice.textContent).toBe('settings.offline_voice_model_app_update_required');
    expect(screen.queryByTestId('settings-offline-voice-download')).toBeNull();
    expect(document.body.textContent).not.toContain('is not implemented');
    unmount();

    mockManagerState.manager!.getOfflineModelStatus.mockResolvedValue(makeStatus());
    mockManagerState.manager!.downloadOfflineModel.mockRejectedValueOnce(
      new Error('"StreamingSpeech.downloadOfflineModel()" is not implemented on ios'),
    );
    render(<OfflineVoiceModelSection />);
    const downloadBtn = await screen.findByTestId('settings-offline-voice-download');
    fireEvent.click(downloadBtn);
    const noticeAfterTap = await screen.findByTestId('settings-offline-voice-update-required');
    expect(noticeAfterTap.textContent).toBe('settings.offline_voice_model_app_update_required');
    expect(screen.queryByTestId('settings-offline-voice-download')).toBeNull();
    expect(screen.queryByTestId('settings-offline-voice-error')).toBeNull();
    expect(document.body.textContent).not.toContain('is not implemented');
  });

  it('still surfaces normal non-UNIMPLEMENTED download errors cleanly', async () => {
    mockManagerState.manager!.downloadOfflineModel.mockRejectedValueOnce(new Error('Network offline'));
    render(<OfflineVoiceModelSection />);
    const downloadBtn = await screen.findByTestId('settings-offline-voice-download');
    fireEvent.click(downloadBtn);
    const errBox = await screen.findByTestId('settings-offline-voice-error');
    expect(errBox.textContent).toBe('Network offline');
    expect(screen.getByTestId('settings-offline-voice-download')).toBeTruthy();
    expect(screen.queryByTestId('settings-offline-voice-update-required')).toBeNull();
  });
});
