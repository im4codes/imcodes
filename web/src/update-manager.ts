/**
 * OTA update manager — checks for web bundle updates from the self-hosted server.
 *
 * Strategy:
 * - On cold start: check + download + apply immediately (user sees splash briefly)
 * - On resume from background: download only, apply on next cold start
 *   (avoids jarring reload mid-use)
 *
 * Uses @capgo/capacitor-updater in manual mode so we can point at the
 * user's configured server URL (not a hardcoded Capgo endpoint).
 */

import { STREAMING_SPEECH_PLUGIN_NAME } from '@shared/voice-recognition.js';
import { isNative, getServerUrl } from './native';

interface UpdateManifest {
  version: number;
  sha256: string;
  url: string;       // relative path, e.g. "/api/updates/bundle.zip"
  buildTime?: string; // ISO 8601
}

interface LocalAppBuildInfo {
  buildId?: string;
  buildTime?: string;
  builtAt?: string;
}

const PREFS_OTA_VERSION_KEY = 'deck_ota_version';
const BUILTIN_BUILD_STORAGE_KEY = 'deck_builtin_build_info';
const OTA_RESET_GUARD_PREFIX = 'deck_ota_reset_guard:';

const memoryResetGuards = new Set<string>();
let initialized = false;
let isBuiltinActive = false;

function extractBuildTime(info: LocalAppBuildInfo | null | undefined): string {
  if (typeof info?.buildTime === 'string' && info.buildTime.trim()) {
    return info.buildTime.trim();
  }
  if (typeof info?.builtAt === 'string' && info.builtAt.trim()) {
    return info.builtAt.trim();
  }
  return '';
}

function parseBuildTimeMs(info: LocalAppBuildInfo | null | undefined): number {
  const raw = extractBuildTime(info);
  return raw ? Date.parse(raw) : Number.NaN;
}

function readStoredBuiltinBuildInfo(): LocalAppBuildInfo | null {
  const injected = (globalThis as any).__IMCODES_NATIVE_BUILD_INFO__ as LocalAppBuildInfo | undefined;
  if (injected && !Number.isNaN(parseBuildTimeMs(injected))) {
    return injected;
  }
  try {
    const raw = globalThis.localStorage?.getItem(BUILTIN_BUILD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalAppBuildInfo;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredBuiltinBuildInfo(info: LocalAppBuildInfo): void {
  try {
    globalThis.localStorage?.setItem(BUILTIN_BUILD_STORAGE_KEY, JSON.stringify({
      buildId: info.buildId,
      buildTime: extractBuildTime(info),
    }));
  } catch {
    // Best-effort persistence
  }
}

function hasResetGuard(bundleId: string): boolean {
  const key = `${OTA_RESET_GUARD_PREFIX}${bundleId}`;
  if (memoryResetGuards.has(key)) return true;
  try {
    return globalThis.sessionStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function markResetGuard(bundleId: string): void {
  const key = `${OTA_RESET_GUARD_PREFIX}${bundleId}`;
  memoryResetGuards.add(key);
  try {
    globalThis.sessionStorage?.setItem(key, '1');
  } catch {
    // Best-effort loop guard
  }
}

async function fetchLocalBuildInfo(): Promise<LocalAppBuildInfo | null> {
  try {
    const res = await fetch('/app-build.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json() as LocalAppBuildInfo;
  } catch {
    return null;
  }
}

async function reconcileActiveOtaBundle(CapacitorUpdater: any): Promise<boolean> {
  if (typeof CapacitorUpdater?.current !== 'function') return true;
  let current: { bundle?: { id?: string; version?: string }; native?: string } | null = null;
  try {
    current = await CapacitorUpdater.current();
  } catch {
    return true;
  }
  const activeId = typeof current?.bundle?.id === 'string' ? current.bundle.id.trim() : '';
  if (!activeId || activeId === 'builtin') {
    isBuiltinActive = activeId === 'builtin';
    return true;
  }
  isBuiltinActive = false;

  const activeBuild = await fetchLocalBuildInfo();
  const activeMs = parseBuildTimeMs(activeBuild);
  const builtinMs = parseBuildTimeMs(readStoredBuiltinBuildInfo());
  const cap = (globalThis as any).Capacitor;
  const missingSpeechBridge = typeof cap?.isPluginAvailable === 'function'
    && !cap.isPluginAvailable(STREAMING_SPEECH_PLUGIN_NAME)
    && !cap.isPluginAvailable('SpeechRecognition');

  const isIncompatible = Number.isNaN(activeMs)
    || (!Number.isNaN(builtinMs) && activeMs <= builtinMs)
    || missingSpeechBridge;

  if (!isIncompatible) return true;
  if (hasResetGuard(activeId)) return true;
  markResetGuard(activeId);

  const rawVersion = typeof current?.bundle?.version === 'string' ? current.bundle.version.trim() : '';
  const parsedVersion = rawVersion ? parseInt(rawVersion, 10) : 0;
  if (parsedVersion > 0) {
    try {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.set({
        key: PREFS_OTA_VERSION_KEY,
        value: String(parsedVersion),
      });
    } catch {
      // Best-effort version poison so the rejected bundle is not re-downloaded
    }
  }

  try {
    await CapacitorUpdater.reset?.({ toLastSuccessful: false });
  } catch (err) {
    console.warn('[OTA] Failed to reset incompatible bundle:', err);
  }
  try {
    await CapacitorUpdater.delete?.({ id: activeId });
  } catch {
    // Active bundle may only be deletable after reload onto builtin
  }
  return false;
}

/** Call once on app startup (native only). Sets up resume listener. */
export async function initUpdateManager(): Promise<void> {
  if (!isNative() || initialized) return;
  initialized = true;

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  const compatible = await reconcileActiveOtaBundle(CapacitorUpdater);
  if (!compatible) return;

  await CapacitorUpdater.notifyAppReady();

  // Cold start: check + apply immediately
  checkForUpdate(true).catch(() => {});

  // Resume: download only, apply on next cold start
  const { App } = await import('@capacitor/app');
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) checkForUpdate(false).catch(() => {});
  });
}

async function checkForUpdate(applyNow: boolean): Promise<void> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) return;

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  const { Preferences } = await import('@capacitor/preferences');

  // Fetch manifest
  let manifest: UpdateManifest;
  try {
    const res = await fetch(`${serverUrl}/api/updates/manifest.json`, {
      cache: 'no-cache',
    });
    if (!res.ok) return;
    manifest = await res.json() as UpdateManifest;
  } catch {
    return; // offline or server unreachable — silent
  }

  // Compare against stored version
  const { value: storedStr } = await Preferences.get({ key: PREFS_OTA_VERSION_KEY });
  const storedVersion = storedStr ? parseInt(storedStr, 10) : 0;
  if (manifest.version <= storedVersion) return;

  // Compare against local bundled /app-build.json buildTime so an older server OTA
  // snapshot never overwrites a newer native build.
  const localBuild = await fetchLocalBuildInfo();
  const localMs = parseBuildTimeMs(localBuild);
  if (isBuiltinActive && localBuild && !Number.isNaN(localMs)) {
    const storedBuiltinMs = parseBuildTimeMs(readStoredBuiltinBuildInfo());
    if (Number.isNaN(storedBuiltinMs) || localMs > storedBuiltinMs) {
      writeStoredBuiltinBuildInfo(localBuild);
    }
  }
  const builtinMs = parseBuildTimeMs(readStoredBuiltinBuildInfo());
  const baselineMs = !Number.isNaN(localMs) && !Number.isNaN(builtinMs)
    ? Math.max(localMs, builtinMs)
    : (!Number.isNaN(localMs) ? localMs : builtinMs);

  if (!Number.isNaN(baselineMs)) {
    const remoteMs = typeof manifest.buildTime === 'string' && manifest.buildTime.trim()
      ? Date.parse(manifest.buildTime.trim())
      : Number.NaN;
    if (Number.isNaN(remoteMs) || remoteMs <= baselineMs) {
      return;
    }
  }

  // Build absolute download URL
  const bundleUrl = manifest.url.startsWith('http')
    ? manifest.url
    : `${serverUrl}${manifest.url}`;

  // Download
  try {
    const bundle = await CapacitorUpdater.download({
      url: bundleUrl,
      version: String(manifest.version),
    });

    // Record version so we don't re-download
    await Preferences.set({
      key: PREFS_OTA_VERSION_KEY,
      value: String(manifest.version),
    });

    if (applyNow) {
      // Cold start: apply immediately (triggers WebView reload)
      await CapacitorUpdater.set({ id: bundle.id });
      console.log(`[OTA] v${manifest.version} applied`);
    } else {
      // Resume: just set as next — applies on next cold start
      await CapacitorUpdater.set({ id: bundle.id });
      console.log(`[OTA] v${manifest.version} downloaded, will apply on next launch`);
    }
  } catch (err) {
    console.warn('[OTA] Download failed:', err);
  }
}
