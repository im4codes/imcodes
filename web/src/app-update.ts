export const APP_UPDATE_REQUIRED_EVENT = 'imcodes:app-update-required';

export type AppUpdateReason =
  | 'build_mismatch'
  | 'chunk_load_failed'
  | 'version_sensitive_feature';

export interface AppBuildInfo {
  buildId: string;
  builtAt?: string;
  packageVersion?: string;
}

export interface AppUpdateRequiredDetail {
  reason: AppUpdateReason;
  currentBuildId?: string;
  loadedBuildId?: string;
  featureLabel?: string;
  blocking?: boolean;
}

export function getLoadedWebBuildId(): string {
  try {
    if (typeof __WEB_BUILD_ID__ === 'string' && __WEB_BUILD_ID__.trim()) {
      return __WEB_BUILD_ID__.trim();
    }
  } catch {
    // Test/SSR environments may not have Vite's define replacement.
  }
  return 'dev';
}

export function normalizeBuildId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isAppBuildMismatch(loadedBuildId: unknown, currentBuildId: unknown): boolean {
  const loaded = normalizeBuildId(loadedBuildId);
  const current = normalizeBuildId(currentBuildId);
  return !!loaded && !!current && loaded !== current;
}

export function isChunkLoadFailure(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : null;
  const name = typeof record?.name === 'string' ? record.name : '';
  const message = typeof record?.message === 'string'
    ? record.message
    : typeof error === 'string'
      ? error
      : '';
  return name === 'ChunkLoadError'
    || /Failed to fetch dynamically imported module/i.test(message)
    || /Loading (?:CSS )?chunk \d+ failed/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || (name === 'TypeError' && /Failed to fetch/i.test(message));
}

export async function fetchCurrentAppBuildInfo(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<AppBuildInfo | null> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchImpl('/api/app-build', {
      cache: 'no-store',
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json() as Partial<AppBuildInfo>;
    const buildId = normalizeBuildId(body.buildId);
    if (!buildId) return null;
    return {
      buildId,
      ...(typeof body.builtAt === 'string' ? { builtAt: body.builtAt } : {}),
      ...(typeof body.packageVersion === 'string' ? { packageVersion: body.packageVersion } : {}),
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function dispatchAppUpdateRequired(detail: AppUpdateRequiredDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppUpdateRequiredDetail>(APP_UPDATE_REQUIRED_EVENT, { detail }));
}

export function notifyAppUpdateIfChunkLoadFailure(error: unknown): void {
  if (!isChunkLoadFailure(error)) return;
  dispatchAppUpdateRequired({
    reason: 'chunk_load_failed',
    loadedBuildId: getLoadedWebBuildId(),
    blocking: true,
  });
}

export function lazyImportWithAppUpdateNotice<T>(loader: () => Promise<T>): Promise<T> {
  return loader().catch((error) => {
    notifyAppUpdateIfChunkLoadFailure(error);
    throw error;
  });
}
