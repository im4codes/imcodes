import { contextBridge, ipcRenderer } from 'electron';

const MIC_TEST_CHANNELS = {
  action: 'imcodes:mic-test:action',
  state: 'imcodes:mic-test:state',
} as const;

const currentProtocol = (globalThis as { location?: { protocol?: string } }).location?.protocol ?? '';
if (currentProtocol === 'data:') {
  contextBridge.exposeInMainWorld(
    '__IMCODES_MIC_TEST__',
    Object.freeze({
      sendAction: (action: string, payload?: unknown) =>
        ipcRenderer.invoke(MIC_TEST_CHANNELS.action, { action, payload }),
      onState: (listener: (state: unknown) => void) => {
        if (typeof listener !== 'function') return () => {};
        const handler = (_ipcEvent: unknown, state: unknown) => {
          listener(state);
        };
        ipcRenderer.on(MIC_TEST_CHANNELS.state, handler);
        return () => {
          ipcRenderer.removeListener(MIC_TEST_CHANNELS.state, handler);
        };
      },
    }),
  );
}
