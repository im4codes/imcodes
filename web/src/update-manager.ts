/**
 * OTA update manager — checks for web bundle updates from the self-hosted server,
 * downloads in the background, and applies on next cold start.
 *
 * Uses @capgo/capacitor-updater in manual mode so we can point at the
 * user's configured server URL (not a hardcoded Capgo endpoint).
 */

import { isNative, getServerUrl } from './native';

interface UpdateManifest {
  version: number;
  sha256: string;
  url: string;       // relative path, e.g. "/api/updates/bundle.zip"
  buildTime: string;  // ISO 8601
}

const PREFS_OTA_VERSION_KEY = 'deck_ota_version';

let initialized = false;

/** Call once on app startup (native only). Sets up resume listener. */
export async function initUpdateManager(): Promise<void> {
  if (!isNative() || initialized) return;
  initialized = true;

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

  // Notify the plugin the app loaded successfully — prevents rollback
  await CapacitorUpdater.notifyAppReady();

  // Check now + on every foreground resume
  checkForUpdate().catch(() => {});

  const { App } = await import('@capacitor/app');
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) checkForUpdate().catch(() => {});
  });
}

async function checkForUpdate(): Promise<void> {
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

  // Build absolute download URL
  const bundleUrl = manifest.url.startsWith('http')
    ? manifest.url
    : `${serverUrl}${manifest.url}`;

  // Download in background
  try {
    const bundle = await CapacitorUpdater.download({
      url: bundleUrl,
      version: String(manifest.version),
    });

    // Set as next bundle — will activate on next cold start
    await CapacitorUpdater.set({ id: bundle.id });

    // Record the version so we don't re-download
    await Preferences.set({
      key: PREFS_OTA_VERSION_KEY,
      value: String(manifest.version),
    });

    console.log(`[OTA] Downloaded v${manifest.version}, will apply on next restart`);
  } catch (err) {
    console.warn('[OTA] Download failed:', err);
  }
}
