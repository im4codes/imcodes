import { normalizeServerOrigin, type ServerStore } from './servers.js';

export class UntrustedOriginError extends Error {
  constructor(origin: string) {
    super(`untrusted origin: ${origin}`);
    this.name = 'UntrustedOriginError';
  }
}

export interface TrustedWebContentsLike {
  getURL(): string;
  session?: {
    clearStorageData?(options?: { origin?: string }): Promise<void>;
  };
}

export interface TrustedWindowLike {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void> | void;
  webContents: TrustedWebContentsLike;
}

/**
 * Resolve the current page origin strictly in fail-closed mode.
 * Returns `null` when the window is missing/destroyed, URL is empty or opaque
 * (`about:blank`, `data:`, etc.), URL does not match `activeOrigin`, or
 * `activeOrigin` is not in `trustedOrigins`.
 */
export function currentTrustedOrigin(
  win: TrustedWindowLike | null | undefined,
  activeOrigin: string | null,
  trustedOrigins: ReadonlySet<string>,
): string | null {
  if (!win || win.isDestroyed()) return null;
  if (!activeOrigin || !trustedOrigins.has(activeOrigin)) return null;

  const raw = win.webContents.getURL();
  if (!raw) return null;

  let origin: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    origin = parsed.origin;
  } catch {
    return null;
  }

  if (!origin || origin === 'null') return null;
  if (origin !== activeOrigin) return null;
  if (!trustedOrigins.has(origin)) return null;
  return origin;
}

/**
 * Single-writer controller for `activeOrigin` and trusted navigation/session hooks.
 * Phase B will subscribe via `onDidNavigateTrustedOrigin` without altering trust boundaries.
 */
export class TrustedOriginController {
  private activeOrigin: string | null = null;
  private readonly didNavigateListeners = new Set<(origin: string) => void>();

  constructor(
    private readonly store: ServerStore,
    private readonly getWindow: () => TrustedWindowLike | null,
  ) {}

  getActiveOrigin(): string | null {
    return this.activeOrigin;
  }

  trustedOrigins(): Set<string> {
    return this.store.trustedOrigins();
  }

  currentTrustedOrigin(): string | null {
    return currentTrustedOrigin(this.getWindow(), this.activeOrigin, this.store.trustedOrigins());
  }

  clearActiveOrigin(): void {
    this.activeOrigin = null;
    this.store.setLastOrigin(null);
  }

  /**
   * Explicit single writer for `activeOrigin`: validates exact membership in
   * `trustedOrigins()`, updates `activeOrigin` and persisted `lastOrigin` BEFORE
   * loading the URL so initial navigation is recognized by `currentTrustedOrigin()`.
   */
  async selectServer(rawOrigin: string): Promise<string> {
    let origin: string;
    try {
      origin = normalizeServerOrigin(rawOrigin);
    } catch {
      throw new UntrustedOriginError(rawOrigin);
    }
    if (!this.store.trustedOrigins().has(origin)) {
      throw new UntrustedOriginError(origin);
    }
    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      throw new Error('Main window is not available');
    }
    this.activeOrigin = origin;
    this.store.setLastOrigin(origin);
    await win.loadURL(origin);
    return origin;
  }

  /**
   * Extension seam for Phase B (`did-navigate` session cookie reconciliation).
   * Invoked only when `currentTrustedOrigin()` resolves cleanly.
   */
  onDidNavigateTrustedOrigin(listener: (origin: string) => void): () => void {
    this.didNavigateListeners.add(listener);
    return () => {
      this.didNavigateListeners.delete(listener);
    };
  }

  notifyDidNavigate(): string | null {
    const origin = this.currentTrustedOrigin();
    if (!origin) return null;
    for (const listener of this.didNavigateListeners) {
      listener(origin);
    }
    return origin;
  }

  /**
   * Logout / session reset seam for the active or specified origin.
   */
  async clearSession(origin?: string): Promise<void> {
    const win = this.getWindow();
    const session = win?.webContents.session;
    if (!session?.clearStorageData) return;
    const target = origin ?? this.activeOrigin ?? undefined;
    await session.clearStorageData(target ? { origin: target } : undefined);
  }
}
