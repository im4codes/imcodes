import { Capacitor, registerPlugin } from '@capacitor/core';

export interface FileTransferKeepAlivePlugin {
  start(options?: { title?: string; text?: string }): Promise<{ started: boolean }>;
  stop(): Promise<void>;
}

let keepAlivePlugin: FileTransferKeepAlivePlugin | null = null;
let activeTransferCount = 0;
let currentLabels: { title?: string; text?: string } = {};

function isKeepAliveSupportedNative(): boolean {
  try {
    if (!Capacitor.isNativePlatform?.()) return false;
    const platform = Capacitor.getPlatform?.();
    return platform === 'android' || platform === 'ios';
  } catch {
    return false;
  }
}

function getKeepAlivePlugin(): FileTransferKeepAlivePlugin | null {
  if (!isKeepAliveSupportedNative()) return null;
  if (!keepAlivePlugin) {
    keepAlivePlugin = registerPlugin<FileTransferKeepAlivePlugin>('FileTransferKeepAlive');
  }
  return keepAlivePlugin;
}

export function setBackgroundTransferKeepAliveLabels(labels: { title?: string; text?: string }): void {
  currentLabels = {
    ...(labels.title ? { title: labels.title } : {}),
    ...(labels.text ? { text: labels.text } : {}),
  };
}

export function getBackgroundTransferKeepAliveCount(): number {
  return activeTransferCount;
}

export function resetBackgroundTransferKeepAliveForTests(): void {
  activeTransferCount = 0;
  currentLabels = {};
  keepAlivePlugin = null;
}

/**
 * Ref-counted Android/iOS native keepalive acquisition for active uploads.
 * Returns an idempotent release function.
 */
export function acquireBackgroundTransferKeepAlive(): () => void {
  let released = false;
  activeTransferCount += 1;
  if (activeTransferCount === 1) {
    const plugin = getKeepAlivePlugin();
    if (plugin) {
      void plugin.start(currentLabels).catch(() => {});
    }
  }
  return () => {
    if (released) return;
    released = true;
    activeTransferCount = Math.max(0, activeTransferCount - 1);
    if (activeTransferCount === 0) {
      const plugin = getKeepAlivePlugin();
      if (plugin) {
        void plugin.stop().catch(() => {});
      }
    }
  };
}

export function withBackgroundTransferKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  if (!isKeepAliveSupportedNative()) return fn();
  const release = acquireBackgroundTransferKeepAlive();
  try {
    return fn().finally(release);
  } catch (error) {
    release();
    throw error;
  }
}
