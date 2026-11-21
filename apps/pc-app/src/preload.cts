import { contextBridge, ipcRenderer } from 'electron';

const VOICE_CHANNELS = {
  getPermissions: 'imcodes:pc-voice:get-permissions',
  requestPermissions: 'imcodes:pc-voice:request-permissions',
  openPrivacySettings: 'imcodes:pc-voice:open-privacy-settings',
  startListening: 'imcodes:pc-voice:start',
  stopListening: 'imcodes:pc-voice:stop',
  getSpeechModel: 'imcodes:pc-voice:get-speech-model',
  setSpeechModel: 'imcodes:pc-voice:set-speech-model',
  getSpeechModelStatus: 'imcodes:pc-voice:get-speech-model-status',
  event: 'imcodes:pc-voice:event',
} as const;

const currentProtocol = (globalThis as { location?: { protocol?: string } }).location?.protocol ?? '';
const isHttpContext = currentProtocol === 'https:' || currentProtocol === 'http:';

if (isHttpContext) {
  const voiceBridge = Object.freeze({
    isNativeSpeechSupported: () => process.platform === 'darwin',
    getPermissions: () => ipcRenderer.invoke(VOICE_CHANNELS.getPermissions),
    requestPermissions: () => ipcRenderer.invoke(VOICE_CHANNELS.requestPermissions),
    openPrivacySettings: (target: 'microphone' | 'speech') =>
      ipcRenderer.invoke(VOICE_CHANNELS.openPrivacySettings, target),
    startListening: (options?: { locale?: string }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.startListening, options ?? {}),
    stopListening: (options?: { abort?: boolean }) =>
      ipcRenderer.invoke(VOICE_CHANNELS.stopListening, options ?? {}),
    getSpeechModel: () => ipcRenderer.invoke(VOICE_CHANNELS.getSpeechModel),
    setSpeechModel: (model: 'system' | 'qwen3-0.6b' | 'qwen3-1.7b') =>
      ipcRenderer.invoke(VOICE_CHANNELS.setSpeechModel, model),
    getSpeechModelStatus: () => ipcRenderer.invoke(VOICE_CHANNELS.getSpeechModelStatus),
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
  });

  contextBridge.exposeInMainWorld('__IMCODES_PC_APP__', Object.freeze({
    platform: process.platform,
    isElectron: true,
    voice: voiceBridge,
  }));
}
