export interface FileTransferKeepAlivePlugin {
  start(options?: { title?: string; text?: string }): Promise<{ started: boolean }>;
  stop(): Promise<void>;
}

type GlobalCapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

let keepAlivePlugin: FileTransferKeepAlivePlugin | null = null;
let activeTransferCount = 0;
let currentLabels: { title?: string; text?: string } = {};
let nativeStarted = false;
let syncChain: Promise<void> = Promise.resolve();
let stateGeneration = 0;

function isKeepAliveSupportedNative(): boolean {
  try {
    const cap = (globalThis as { Capacitor?: GlobalCapacitorBridge }).Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
      return false;
    }
    const platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : undefined;
    return platform === 'android' || platform === 'ios';
  } catch {
    return false;
  }
}

async function getKeepAlivePlugin(gen: number): Promise<FileTransferKeepAlivePlugin | null> {
  if (!isKeepAliveSupportedNative()) return null;
  if (keepAlivePlugin) return keepAlivePlugin;
  try {
    const { registerPlugin } = await import('@capacitor/core');
    if (gen !== stateGeneration) return null;
    const raw = registerPlugin<FileTransferKeepAlivePlugin>('FileTransferKeepAlive');
    // Wrap Capacitor's Proxy so async return does not probe `.then()` as a native method.
    keepAlivePlugin = {
      start: (options) => raw.start(options),
      stop: () => raw.stop(),
    };
    return keepAlivePlugin;
  } catch {
    return null;
  }
}

async function reconcileNativeKeepAlive(gen: number): Promise<void> {
  while (gen === stateGeneration) {
    const shouldRun = activeTransferCount > 0 && isKeepAliveSupportedNative();
    if (shouldRun && !nativeStarted) {
      const plugin = await getKeepAlivePlugin(gen);
      if (gen !== stateGeneration || !plugin) return;
      if (activeTransferCount === 0 || !isKeepAliveSupportedNative()) {
        return;
      }
      nativeStarted = true;
      try {
        await plugin.start({ ...currentLabels });
      } catch {
        // Ignore native plugin start errors; loop re-checks activeTransferCount next.
      }
      continue;
    }
    if (!shouldRun && nativeStarted) {
      nativeStarted = false;
      const plugin = keepAlivePlugin ?? await getKeepAlivePlugin(gen);
      if (gen !== stateGeneration || !plugin) return;
      try {
        await plugin.stop();
      } catch {
        // Ignore native plugin stop errors.
      }
      continue;
    }
    return;
  }
}

function scheduleKeepAliveSync(): void {
  const gen = stateGeneration;
  syncChain = syncChain
    .then(() => reconcileNativeKeepAlive(gen))
    .catch(() => {});
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

export function flushBackgroundTransferKeepAliveForTests(): Promise<void> {
  return syncChain;
}

export function resetBackgroundTransferKeepAliveForTests(): void {
  stateGeneration += 1;
  activeTransferCount = 0;
  currentLabels = {};
  keepAlivePlugin = null;
  nativeStarted = false;
  syncChain = Promise.resolve();
}

/**
 * Ref-counted Android/iOS native keepalive acquisition for active uploads.
 * Returns an idempotent release function.
 */
export function acquireBackgroundTransferKeepAlive(): () => void {
  let released = false;
  activeTransferCount += 1;
  if (activeTransferCount === 1 && isKeepAliveSupportedNative()) {
    scheduleKeepAliveSync();
  }
  return () => {
    if (released) return;
    released = true;
    activeTransferCount = Math.max(0, activeTransferCount - 1);
    if (activeTransferCount === 0 && (nativeStarted || isKeepAliveSupportedNative())) {
      scheduleKeepAliveSync();
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
