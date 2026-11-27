/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
const bridges = vi.hoisted(() => ({ legacy: {}, streaming: {}, register: vi.fn() }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.legacy }));
vi.mock('@capacitor/core', () => ({ registerPlugin: bridges.register.mockReturnValue(bridges.streaming) }));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('shared native voice bridge', () => {
  it.each(['android', 'ios'])('uses offline streaming on a new %s shell', async platform => {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform, isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const { getNativeSpeechRecognition, getVoiceRecognitionEngine } = await import('../src/voice-recognition-backend.js');
    expect(getVoiceRecognitionEngine()).toBe('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
    expect(bridges.register).toHaveBeenCalledWith('StreamingSpeech');
  });
  it.each(['android', 'ios'])('switches between builtin and system/Apple recognizer on %s when persisted', async platform => {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform, isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const {
      VOICE_ENGINE_STORAGE_KEY,
      getNativeSpeechRecognition,
      getVoiceRecognitionEngine,
      isIosNativePlatform,
      setVoiceRecognitionEngine,
    } = await import('../src/voice-recognition-backend.js');
    expect(isIosNativePlatform()).toBe(platform === 'ios');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);

    setVoiceRecognitionEngine('system');
    expect(localStorage.getItem(VOICE_ENGINE_STORAGE_KEY)).toBe('system');
    expect(getVoiceRecognitionEngine()).toBe('system');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);

    setVoiceRecognitionEngine('builtin');
    expect(localStorage.getItem(VOICE_ENGINE_STORAGE_KEY)).toBe('builtin');
    expect(getVoiceRecognitionEngine()).toBe('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
  });
  it.each(['en-US', 'ja-JP', 'zh-TW', 'fr-FR', 'ru-RU'])('uses multilingual offline recognition for %s', async language => {
    vi.stubGlobal('navigator', { language });
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => true });
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
  });
  it('keeps an old native binary functional after a web-only update', async () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => false });
    const { getNativeSpeechRecognition, setVoiceRecognitionEngine } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
    setVoiceRecognitionEngine('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
  });
  it('does not assume native registration in browsers or older bridge versions', async () => {
    vi.stubGlobal('Capacitor', undefined);
    const { getNativeSpeechRecognition, getNativeSystemTts } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
    expect(getNativeSystemTts()).toBeNull();
  });
  it('exposes getNativeSystemTts only when StreamingSpeech provides native TTS methods', async () => {
    vi.stubGlobal('Capacitor', { getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const modEmpty = await import('../src/voice-recognition-backend.js');
    expect(modEmpty.getNativeSystemTts()).toBeNull();

    vi.resetModules();
    Object.assign(bridges.streaming, { speak: vi.fn(), stopSpeaking: vi.fn() });
    const modReady = await import('../src/voice-recognition-backend.js');
    expect(modReady.getNativeSystemTts()).toBe(bridges.streaming);
    delete (bridges.streaming as Record<string, unknown>).speak;
    delete (bridges.streaming as Record<string, unknown>).stopSpeaking;
  });

  it('exposes getNativeRawPcmCapture only when StreamingSpeech provides raw PCM capture methods', async () => {
    vi.stubGlobal('Capacitor', { getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const modEmpty = await import('../src/voice-recognition-backend.js');
    expect(modEmpty.getNativeRawPcmCapture()).toBeNull();

    vi.resetModules();
    Object.assign(bridges.streaming, {
      startRawPcmCapture: vi.fn(),
      stopRawPcmCapture: vi.fn(),
      addListener: vi.fn(),
    });
    const modReady = await import('../src/voice-recognition-backend.js');
    expect(modReady.getNativeRawPcmCapture()).toBe(bridges.streaming);
    delete (bridges.streaming as Record<string, unknown>).startRawPcmCapture;
    delete (bridges.streaming as Record<string, unknown>).stopRawPcmCapture;
    delete (bridges.streaming as Record<string, unknown>).addListener;

    vi.resetModules();
    vi.stubGlobal('Capacitor', { getPlatform: () => 'web', isPluginAvailable: () => true });
    Object.assign(bridges.streaming, {
      startRawPcmCapture: vi.fn(),
      stopRawPcmCapture: vi.fn(),
      addListener: vi.fn(),
    });
    const modWeb = await import('../src/voice-recognition-backend.js');
    expect(modWeb.getNativeRawPcmCapture()).toBeNull();
    delete (bridges.streaming as Record<string, unknown>).startRawPcmCapture;
    delete (bridges.streaming as Record<string, unknown>).stopRawPcmCapture;
    delete (bridges.streaming as Record<string, unknown>).addListener;
  });

  it('exposes getNativeOfflineSpeechModelManager only on iOS native shells with offline model methods', async () => {
    vi.stubGlobal('Capacitor', { getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const modMissing = await import('../src/voice-recognition-backend.js');
    expect(modMissing.getNativeOfflineSpeechModelManager()).toBeNull();

    Object.assign(bridges.streaming, {
      getOfflineModelStatus: vi.fn(),
      downloadOfflineModel: vi.fn(),
      cancelOfflineModelDownload: vi.fn(),
      deleteOfflineModel: vi.fn(),
    });
    vi.resetModules();
    const modIos = await import('../src/voice-recognition-backend.js');
    expect(modIos.getNativeOfflineSpeechModelManager()).toBe(bridges.streaming);

    vi.resetModules();
    vi.stubGlobal('Capacitor', { getPlatform: () => 'android', isPluginAvailable: () => true });
    const modAndroid = await import('../src/voice-recognition-backend.js');
    expect(modAndroid.getNativeOfflineSpeechModelManager()).toBeNull();

    vi.resetModules();
    vi.stubGlobal('Capacitor', { getPlatform: () => 'web', isPluginAvailable: () => true });
    const modWeb = await import('../src/voice-recognition-backend.js');
    expect(modWeb.getNativeOfflineSpeechModelManager()).toBeNull();

    for (const key of ['getOfflineModelStatus', 'downloadOfflineModel', 'cancelOfflineModelDownload', 'deleteOfflineModel']) {
      delete (bridges.streaming as Record<string, unknown>)[key];
    }
  });

  it('rejects Capacitor Proxy methods on older iOS shells using Capacitor.PluginHeaders and reports shell outdated', async () => {
    const proxyPlugin = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return () => Promise.reject(new Error(`"StreamingSpeech.${String(prop)}()" is not implemented on ios`));
      },
    });
    bridges.register.mockReturnValue(proxyPlugin);
    try {
      // Old native iOS binary: StreamingSpeech exists, PluginHeaders only has available/start/stop
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          { name: 'StreamingSpeech', methods: [{ name: 'available' }, { name: 'start' }, { name: 'stop' }] },
        ],
      });
      const oldIos = await import('../src/voice-recognition-backend.js');
      expect(oldIos.getNativeOfflineSpeechModelManager()).toBeNull();
      expect(oldIos.isNativeOfflineModelShellOutdated()).toBe(true);

      // New native iOS binary: PluginHeaders includes all 4 offline model management methods
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          {
            name: 'StreamingSpeech',
            methods: [
              { name: 'available' },
              { name: 'getOfflineModelStatus' },
              { name: 'downloadOfflineModel' },
              { name: 'cancelOfflineModelDownload' },
              { name: 'deleteOfflineModel' },
            ],
          },
        ],
      });
      const newIos = await import('../src/voice-recognition-backend.js');
      expect(newIos.getNativeOfflineSpeechModelManager()).toBe(proxyPlugin);
      expect(newIos.isNativeOfflineModelShellOutdated()).toBe(false);

      // Android or web shells are never flagged as outdated iOS shells
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'android',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [{ name: 'StreamingSpeech', methods: [{ name: 'available' }] }],
      });
      const androidMod = await import('../src/voice-recognition-backend.js');
      expect(androidMod.getNativeOfflineSpeechModelManager()).toBeNull();
      expect(androidMod.isNativeOfflineModelShellOutdated()).toBe(false);
    } finally {
      bridges.register.mockReturnValue(bridges.streaming);
    }
  });

  it('exposes openNativeAppSettings when StreamingSpeech provides openAppSettings and declares MODIFY_AUDIO_SETTINGS in AndroidManifest', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const manifest = readFileSync(resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
    expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS');

    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
      PluginHeaders: [{ name: 'StreamingSpeech', methods: [{ name: 'available' }] }],
    });
    const oldShell = await import('../src/voice-recognition-backend.js');
    expect(oldShell.isOpenNativeAppSettingsAvailable()).toBe(false);
    expect(await oldShell.openNativeAppSettings()).toBe(false);

    vi.resetModules();
    const openAppSettings = vi.fn(async () => ({ opened: true }));
    Object.assign(bridges.streaming, { openAppSettings });
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
      PluginHeaders: [{ name: 'StreamingSpeech', methods: [{ name: 'available' }, { name: 'openAppSettings' }] }],
    });
    try {
      const newShell = await import('../src/voice-recognition-backend.js');
      expect(newShell.isOpenNativeAppSettingsAvailable()).toBe(true);
      expect(await newShell.openNativeAppSettings()).toBe(true);
      expect(openAppSettings).toHaveBeenCalledOnce();
    } finally {
      delete (bridges.streaming as Record<string, unknown>).openAppSettings;
    }
  });

  it('rejects Capacitor Proxy false positives for getNativeRawPcmCapture on older shells via PluginHeaders and supports runtime UNIMPLEMENTED latching', async () => {
    const proxyPlugin = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return () => Promise.reject(new Error(`"StreamingSpeech.${String(prop)}()" is not implemented on ios`));
      },
    });
    bridges.register.mockReturnValue(proxyPlugin);
    try {
      // 1. Old iOS/Android shell: StreamingSpeech in PluginHeaders WITHOUT startRawPcmCapture/stopRawPcmCapture
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          { name: 'StreamingSpeech', methods: [{ name: 'available' }, { name: 'start' }, { name: 'stop' }] },
        ],
      });
      const oldShell = await import('../src/voice-recognition-backend.js');
      expect(oldShell.getNativeRawPcmCapture()).toBeNull();

      // 2. PluginHeaders present but StreamingSpeech entry missing
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'android',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [{ name: 'OtherPlugin', methods: [{ name: 'startRawPcmCapture' }] }],
      });
      const missingHeaderShell = await import('../src/voice-recognition-backend.js');
      expect(missingHeaderShell.getNativeRawPcmCapture()).toBeNull();

      // 3. New shell: PluginHeaders includes both startRawPcmCapture and stopRawPcmCapture
      vi.resetModules();
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          {
            name: 'StreamingSpeech',
            methods: [{ name: 'startRawPcmCapture' }, { name: 'stopRawPcmCapture' }],
          },
        ],
      });
      const newShell = await import('../src/voice-recognition-backend.js');
      expect(newShell.getNativeRawPcmCapture()).toBe(proxyPlugin);

      // 4. Runtime UNIMPLEMENTED latch permanently disables getNativeRawPcmCapture until reset
      newShell.markNativeRawPcmCaptureUnsupported();
      expect(newShell.getNativeRawPcmCapture()).toBeNull();
      newShell.resetNativeRawPcmCaptureSupportForTesting();
      expect(newShell.getNativeRawPcmCapture()).toBe(proxyPlugin);
    } finally {
      bridges.register.mockReturnValue(bridges.streaming);
    }
  });

  it('allowlists ws_open_timeout alongside ready_timeout in formatRemoteVoiceFallbackReason', async () => {
    const { formatRemoteVoiceFallbackReason } = await import('../src/voice-recognition-backend.js');
    expect(formatRemoteVoiceFallbackReason('ws_open_timeout')).toBe('ws_open_timeout');
    expect(formatRemoteVoiceFallbackReason('ready_timeout')).toBe('ready_timeout');
  });

  it.each(['ios', 'android'] as const)(
    'exposes getNativeHapticFeedback from StreamingSpeech on %s even when system speech engine is selected',
    async (platform) => {
      const performHaptic = vi.fn().mockResolvedValue(undefined);
      Object.assign(bridges.streaming, { performHaptic });
      try {
        // When system engine is selected, speech recognizer points to @capgo/legacy while haptics stay on StreamingSpeech.
        vi.stubGlobal('Capacitor', {
          getPlatform: () => platform,
          isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        });
        const mod = await import('../src/voice-recognition-backend.js');
        mod.setVoiceRecognitionEngine('system');
        expect(mod.getNativeSpeechRecognition()).toBe(bridges.legacy);
        expect(mod.getNativeHapticFeedback()).toBe(bridges.streaming);

        // Web platform or missing StreamingSpeech plugin disables the bridge.
        vi.resetModules();
        vi.stubGlobal('Capacitor', {
          getPlatform: () => 'web',
          isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        });
        const webMod = await import('../src/voice-recognition-backend.js');
        expect(webMod.getNativeHapticFeedback()).toBeNull();

        vi.resetModules();
        vi.stubGlobal('Capacitor', {
          getPlatform: () => platform,
          isPluginAvailable: () => false,
        });
        const noPluginMod = await import('../src/voice-recognition-backend.js');
        expect(noPluginMod.getNativeHapticFeedback()).toBeNull();

        // Older shell PluginHeaders omitting performHaptic must return null cleanly.
        vi.resetModules();
        vi.stubGlobal('Capacitor', {
          getPlatform: () => platform,
          isPluginAvailable: (name: string) => name === 'StreamingSpeech',
          PluginHeaders: [{ name: 'StreamingSpeech', methods: [{ name: 'start' }, { name: 'stop' }] }],
        });
        const oldHeaderMod = await import('../src/voice-recognition-backend.js');
        expect(oldHeaderMod.getNativeHapticFeedback()).toBeNull();
      } finally {
        delete (bridges.streaming as Record<string, unknown>).performHaptic;
      }
    },
  );
});
