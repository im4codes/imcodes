import { contextBridge, ipcRenderer } from 'electron';

const VOICE_CHANNELS = {
  getPermissions: 'imcodes:pc-voice:get-permissions',
  requestPermissions: 'imcodes:pc-voice:request-permissions',
  openPrivacySettings: 'imcodes:pc-voice:open-privacy-settings',
  startListening: 'imcodes:pc-voice:start',
  stopListening: 'imcodes:pc-voice:stop',
  finalizePcmListening: 'imcodes:pc-voice:finalize-pcm',
  getSpeechModel: 'imcodes:pc-voice:get-speech-model',
  setSpeechModel: 'imcodes:pc-voice:set-speech-model',
  getSpeechModelStatus: 'imcodes:pc-voice:get-speech-model-status',
  getInputDevices: 'imcodes:pc-voice:get-input-devices',
  getInputDevice: 'imcodes:pc-voice:get-input-device',
  setInputDevice: 'imcodes:pc-voice:set-input-device',
  event: 'imcodes:pc-voice:event',
  getRemoteProviderInfo: 'imcodes:pc-voice:get-remote-provider-info',
  startRemoteSession: 'imcodes:pc-voice:start-remote-session',
  pushRemotePcm: 'imcodes:pc-voice:push-remote-pcm',
  stopRemoteSession: 'imcodes:pc-voice:stop-remote-session',
  remoteEvent: 'imcodes:pc-voice:remote-event',
} as const;

const DOWNLOAD_CHANNELS = {
  pickSaveFile: 'imcodes:pc-download:pick-save-file',
  openWriter: 'imcodes:pc-download:open-writer',
  writeChunk: 'imcodes:pc-download:write-chunk',
  seekWriter: 'imcodes:pc-download:seek-writer',
  truncateWriter: 'imcodes:pc-download:truncate-writer',
  closeWriter: 'imcodes:pc-download:close-writer',
  abortWriter: 'imcodes:pc-download:abort-writer',
  getFileSize: 'imcodes:pc-download:get-file-size',
  revealFile: 'imcodes:pc-download:reveal-file',
} as const;

const UPDATER_CHANNELS = {
  getStatus: 'imcodes:pc-updater:get-status',
  check: 'imcodes:pc-updater:check',
  download: 'imcodes:pc-updater:download',
  quitAndInstall: 'imcodes:pc-updater:quit-and-install',
  event: 'imcodes:pc-updater:event',
} as const;

const currentProtocol = (globalThis as { location?: { protocol?: string } }).location?.protocol ?? '';
const isHttpContext = currentProtocol === 'https:' || currentProtocol === 'http:';

if (isHttpContext) {
  const voiceBridge = Object.freeze({
    isNativeSpeechSupported: () => process.platform === 'darwin' || process.platform === 'win32',
    getPermissions: () => ipcRenderer.invoke(VOICE_CHANNELS.getPermissions),
    requestPermissions: () => ipcRenderer.invoke(VOICE_CHANNELS.requestPermissions),
    openPrivacySettings: (target: 'microphone' | 'speech') =>
      ipcRenderer.invoke(VOICE_CHANNELS.openPrivacySettings, target),
    startListening: (options?: { locale?: string; initialPcmBase64?: string; finalizeOnly?: boolean; hotwords?: string[] }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.startListening, options ?? {}),
    supportsPcmFinalize: true,
    finalizePcmListening: (options: { locale?: string; pcmBase64: string; hotwords?: string[] }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.finalizePcmListening, options),
    stopListening: (options?: { abort?: boolean }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.stopListening, options ?? {}),
    getSpeechModel: () => ipcRenderer.invoke(VOICE_CHANNELS.getSpeechModel),
    setSpeechModel: (model: 'system' | 'qwen3-0.6b' | 'qwen3-1.7b') =>
      ipcRenderer.invoke(VOICE_CHANNELS.setSpeechModel, model),
    getSpeechModelStatus: () => ipcRenderer.invoke(VOICE_CHANNELS.getSpeechModelStatus),
    getInputDevices: () => ipcRenderer.invoke(VOICE_CHANNELS.getInputDevices),
    getInputDevice: () => ipcRenderer.invoke(VOICE_CHANNELS.getInputDevice),
    setInputDevice: (uid: string) =>
      ipcRenderer.invoke(VOICE_CHANNELS.setInputDevice, uid),
    subscribe: (listener: (event: unknown) => void) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_ipcEvent: unknown, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on(VOICE_CHANNELS.event, handler);
      return () => {
        ipcRenderer.removeListener(VOICE_CHANNELS.event, handler);
      };
    },
    getRemoteProviderInfo: () => ipcRenderer.invoke(VOICE_CHANNELS.getRemoteProviderInfo),
    startRemoteSession: (options: { sessionId: string; locale?: string; hotwords?: string[] }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.startRemoteSession, options ?? {}),
    pushRemotePcm: (options: { sessionId: string; pcmBase64: string }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.pushRemotePcm, options ?? {}),
    stopRemoteSession: (options: { sessionId: string; abort?: boolean }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.stopRemoteSession, options ?? {}),
    subscribeRemoteEvents: (listener: (event: unknown) => void) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_ipcEvent: unknown, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on(VOICE_CHANNELS.remoteEvent, handler);
      return () => {
        ipcRenderer.removeListener(VOICE_CHANNELS.remoteEvent, handler);
      };
    },
  });

  const downloadsBridge = Object.freeze({
    pickSaveFile: (options?: { suggestedName?: string }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.pickSaveFile, options ?? {}),
    openWriter: (options: { handleId: string; keepExistingData?: boolean }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.openWriter, options ?? {}),
    writeChunk: (options: { writerId: string; chunk: Uint8Array | ArrayBuffer }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.writeChunk, options ?? {}),
    seekWriter: (options: { writerId: string; position: number }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.seekWriter, options ?? {}),
    truncateWriter: (options: { writerId: string; size: number }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.truncateWriter, options ?? {}),
    closeWriter: (options: { writerId: string }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.closeWriter, options ?? {}),
    abortWriter: (options: { writerId: string }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.abortWriter, options ?? {}),
    getFileSize: (options: { handleId: string }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.getFileSize, options ?? {}),
    revealFile: (options: { handleId: string }) =>
      ipcRenderer.invoke(DOWNLOAD_CHANNELS.revealFile, options ?? {}),
  });

  const updaterBridge = Object.freeze({
    getStatus: () => ipcRenderer.invoke(UPDATER_CHANNELS.getStatus),
    checkForUpdates: () => ipcRenderer.invoke(UPDATER_CHANNELS.check),
    downloadUpdate: () => ipcRenderer.invoke(UPDATER_CHANNELS.download),
    quitAndInstall: () => ipcRenderer.invoke(UPDATER_CHANNELS.quitAndInstall),
    subscribe: (listener: (status: unknown) => void) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_ipcEvent: unknown, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on(UPDATER_CHANNELS.event, handler);
      return () => {
        ipcRenderer.removeListener(UPDATER_CHANNELS.event, handler);
      };
    },
  });

  const rawAppVersion = typeof process !== 'undefined' && typeof process.env?.IMCODES_PC_APP_VERSION === 'string'
    ? process.env.IMCODES_PC_APP_VERSION.trim()
    : '';

  contextBridge.exposeInMainWorld('__IMCODES_PC_APP__', Object.freeze({
    platform: process.platform,
    isElectron: true,
    ...(rawAppVersion ? { appVersion: rawAppVersion } : {}),
    voice: voiceBridge,
    downloads: downloadsBridge,
    updater: updaterBridge,
  }));
}
