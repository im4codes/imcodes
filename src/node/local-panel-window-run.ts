/**
 * Wires the local-panel window decision to this machine: the platform adapter for this OS, the single-instance record in the state
 * directory, a probe of the panel server, and the log. One runner serves both entry points -- the service (a native click arrives
 * as a POST to the panel's open-window endpoint) and the `imcodes-node --open-local-panel` CLI (desktop entries) -- so there is
 * exactly one behavior.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  LOCAL_PANEL_WINDOW_REASON,
  LOCAL_PANEL_WINDOW_STATE_FILE,
  localPanelUrl,
} from '../../shared/local-panel-window.js';
import { appendLocalPanelTiming, formatLocalPanelTiming, readLocalPanelTiming } from './local-panel-timing.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT, type RemoteDesktopLocalWebAction } from '../../shared/remote-desktop-local-management.js';
import logger from '../util/logger.js';
import { startupDiagnosticsDir } from './startup-diagnostics.js';
import { openAideskLocalPanelLegacy } from './aidesk-desktop-entry.js';
import { remoteDesktopManagementUrl } from './remote-desktop-local-panel.js';
import { createLinuxLocalPanelWindowPlatform } from './local-panel-window-linux.js';
import { createMacosLocalPanelWindowPlatform } from './local-panel-window-macos.js';
import { createWindowsLocalPanelWindowPlatform } from './local-panel-window-windows.js';
import {
  openLocalPanelWindow,
  type LocalPanelWindowOutcome,
  type LocalPanelWindowPlatform,
  type LocalPanelWindowRecordStore,
} from './local-panel-window.js';

export function createLocalPanelWindowPlatform(platform: NodeJS.Platform = process.platform): LocalPanelWindowPlatform | undefined {
  if (platform === 'win32') return createWindowsLocalPanelWindowPlatform();
  if (platform === 'darwin') return createMacosLocalPanelWindowPlatform();
  if (platform === 'linux') return createLinuxLocalPanelWindowPlatform();
  return undefined;
}

/** The record lives in this process's state directory (root's for the service, the user's own for a desktop entry); a write failure only loses the cache. */
export function createLocalPanelWindowRecordStore(directory: string = startupDiagnosticsDir()): LocalPanelWindowRecordStore {
  const path = join(directory, LOCAL_PANEL_WINDOW_STATE_FILE);
  return {
    read: () => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
    write: (value) => { try { mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(path, value, { mode: 0o600 }); } catch { /* cache only */ } },
    clear: () => { try { rmSync(path, { force: true }); } catch { /* cache only */ } },
  };
}

/** Does the panel server answer on its loopback port? (A node without a public id never starts it.) */
export function probeLocalPanel(timeoutMs = 1_500, port: number = REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({
      host: REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST, port, path: REMOTE_DESKTOP_LOCAL_MANAGEMENT.ROOT_PATH,
      method: 'HEAD', timeout: timeoutMs,
    }, (response) => { response.resume(); resolve((response.statusCode ?? 0) > 0); });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
    req.end();
  });
}

export async function runLocalPanelWindow(options: { platform?: LocalPanelWindowPlatform; store?: LocalPanelWindowRecordStore; stateDir?: string; panelRunning?: () => Promise<boolean> } = {}): Promise<LocalPanelWindowOutcome> {
  const platform = options.platform ?? createLocalPanelWindowPlatform();
  if (!platform) return { reason: LOCAL_PANEL_WINDOW_REASON.UNSUPPORTED_PLATFORM, trail: [] };
  const stateDir = options.stateDir ?? startupDiagnosticsDir();
  return openLocalPanelWindow({
    platform,
    store: options.store ?? createLocalPanelWindowRecordStore(stateDir),
    onTiming: (entry) => appendLocalPanelTiming(stateDir, entry),
    panelRunning: options.panelRunning ?? (() => probeLocalPanel()),
    log: (level, fields, message) => {
      try { logger[level](fields, message); } catch { /* an unwritable log file must not stop the window */ }
      if (level === 'warn') process.stderr.write(`imcodes-node: ${message}: ${String(fields.reason)}${fields.error ? ` [${String(fields.error)}]` : ''} (${localPanelUrl()})\n`);
    },
  });
}

/** `imcodes-node --local-panel-timing`: the recent open requests of this node's state directory, one line each (phases in click order). */
export function describeLocalPanelTiming(stateDir: string = startupDiagnosticsDir()): string {
  const entries = readLocalPanelTiming(stateDir);
  return entries.length === 0 ? `no local panel opens recorded in ${stateDir}` : formatLocalPanelTiming(entries);
}

/**
 * `imcodes-node --open-local-panel` (desktop entries): the shared decision, and only when even the default browser could not be
 * started the old direct open, so an entry is never lost.
 */
export async function openAideskLocalPanel(): Promise<LocalPanelWindowOutcome> {
  const outcome = await runLocalPanelWindow();
  if (outcome.reason === LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED) {
    try { openAideskLocalPanelLegacy(); } catch { /* the failure is already logged with its reason code */ }
  }
  return outcome;
}

/** What the running service hands to the panel server: native clicks open/focus the window, and the page's two external links open in the default browser. */
export function localPanelWindowHandlers(serverUrl: string, publicNodeId: string): {
  openWindow: () => Promise<{ ok: boolean; reason: string }>;
  openExternal: (target: RemoteDesktopLocalWebAction) => Promise<boolean>;
} {
  const platform = createLocalPanelWindowPlatform();
  const store = createLocalPanelWindowRecordStore();
  return {
    // The panel server is the caller, so it is running by definition.
    openWindow: async () => {
      const outcome = await runLocalPanelWindow({ ...(platform ? { platform } : {}), store, panelRunning: async () => true });
      return { ok: outcome.reason !== LOCAL_PANEL_WINDOW_REASON.LAUNCH_FAILED, reason: outcome.reason };
    },
    openExternal: async (target) => platform !== undefined && platform.openDefaultBrowser(remoteDesktopManagementUrl(serverUrl, publicNodeId, target)),
  };
}
