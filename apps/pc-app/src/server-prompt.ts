import { normalizePcAppLocale, tPcApp } from './i18n.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from './security.js';
import { normalizeServerOrigin, type SavedServer } from './servers.js';
import {
  loadPcAppBuildConfig,
  resolveLocaleDefaultServersForPcApp,
  type LocaleDefaultServerRule,
} from './build-config.js';

export interface ServerPromptInput {
  origin: string;
  label?: string;
}

export const DEFAULT_SERVER_ORIGIN = 'https://app.im.codes';
export const WELCOME_SUBMIT_ORIGIN = 'https://imcodes-welcome.local';
const PROMPT_SUBMIT_ORIGIN = 'https://imcodes-prompt.local';

export interface WelcomeDataUrlOptions {
  servers?: readonly SavedServer[];
  detectedServer?: { origin: string; label?: string } | null;
  locale?: string;
  localeDefaultServers?: readonly LocaleDefaultServerRule[];
  initialUrl?: string;
  initialLabel?: string;
  errorMessage?: string;
}

export function getDefaultServerOrigins(
  locale?: string,
  rules?: readonly LocaleDefaultServerRule[],
): string[] {
  const effectiveLocale = locale?.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  const resolvedRules = resolveLocaleDefaultServersForPcApp(
    rules ?? loadPcAppBuildConfig().localeDefaultServers,
    effectiveLocale,
  );
  const seen = new Set<string>([DEFAULT_SERVER_ORIGIN]);
  const origins = [DEFAULT_SERVER_ORIGIN];
  for (const rule of resolvedRules) {
    if (seen.has(rule.url)) continue;
    seen.add(rule.url);
    origins.push(rule.url);
  }
  return origins;
}

export function isDefaultServerOrigin(
  origin: string,
  locale?: string,
  rules?: readonly LocaleDefaultServerRule[],
): boolean {
  try {
    const normalized = normalizeServerOrigin(origin);
    return getDefaultServerOrigins(locale, rules).includes(normalized);
  } catch {
    return false;
  }
}

interface WelcomeServerItem {
  origin: string;
  label?: string;
  isDefault: boolean;
  isDetected: boolean;
  removable: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildWelcomeServerItems(opts?: WelcomeDataUrlOptions): WelcomeServerItem[] {
  const rawLocale = opts?.locale?.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  const matchingLocaleDefaults = resolveLocaleDefaultServersForPcApp(
    opts?.localeDefaultServers ?? loadPcAppBuildConfig().localeDefaultServers,
    rawLocale,
  );
  const localeDefaultByOrigin = new Map<string, LocaleDefaultServerRule>(
    matchingLocaleDefaults.map((rule) => [rule.url, rule]),
  );
  const byOrigin = new Map<string, WelcomeServerItem>();

  byOrigin.set(DEFAULT_SERVER_ORIGIN, {
    origin: DEFAULT_SERVER_ORIGIN,
    isDefault: true,
    isDetected: false,
    removable: false,
  });

  for (const rule of matchingLocaleDefaults) {
    if (byOrigin.has(rule.url)) continue;
    byOrigin.set(rule.url, {
      origin: rule.url,
      ...(rule.label ? { label: rule.label } : {}),
      isDefault: true,
      isDetected: false,
      removable: false,
    });
  }

  for (const srv of opts?.servers ?? []) {
    let normalized: string;
    try {
      normalized = normalizeServerOrigin(srv.origin);
    } catch {
      continue;
    }
    const existing = byOrigin.get(normalized);
    if (existing) {
      if (!existing.label && srv.label) {
        existing.label = srv.label;
      }
      continue;
    }
    const defaultRule = localeDefaultByOrigin.get(normalized);
    const isDefault = normalized === DEFAULT_SERVER_ORIGIN || Boolean(defaultRule);
    byOrigin.set(normalized, {
      origin: normalized,
      ...(srv.label ? { label: srv.label } : defaultRule?.label ? { label: defaultRule.label } : {}),
      isDefault,
      isDetected: false,
      removable: !isDefault,
    });
  }

  if (opts?.detectedServer?.origin) {
    try {
      const detectedOrigin = normalizeServerOrigin(opts.detectedServer.origin);
      const existing = byOrigin.get(detectedOrigin);
      if (existing) {
        existing.isDetected = true;
        if (!existing.label && opts.detectedServer.label) {
          existing.label = opts.detectedServer.label;
        }
      } else {
        const defaultRule = localeDefaultByOrigin.get(detectedOrigin);
        const isDefault = detectedOrigin === DEFAULT_SERVER_ORIGIN || Boolean(defaultRule);
        byOrigin.set(detectedOrigin, {
          origin: detectedOrigin,
          ...(opts.detectedServer.label
            ? { label: opts.detectedServer.label }
            : defaultRule?.label
              ? { label: defaultRule.label }
              : {}),
          isDefault,
          isDetected: true,
          removable: false,
        });
      }
    } catch {
      // Ignore invalid detected origin silently.
    }
  }

  return [...byOrigin.values()];
}

export function buildWelcomeDataUrl(optsOrSavedCount: number | WelcomeDataUrlOptions = 0): string {
  const opts: WelcomeDataUrlOptions = typeof optsOrSavedCount === 'number' ? {} : optsOrSavedCount;
  const locale = normalizePcAppLocale(opts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale);
  const items = buildWelcomeServerItems(opts);

  const subtitle = tPcApp(locale, 'welcome.subtitle');
  const defaultBadge = tPcApp(locale, 'welcome.defaultBadge');
  const detectedBadge = tPcApp(locale, 'welcome.detectedBadge');
  const addHeading = tPcApp(locale, 'welcome.addHeading');
  const urlPlaceholder = DEFAULT_SERVER_ORIGIN;
  const labelPlaceholder = tPcApp(locale, 'welcome.labelPlaceholder');
  const connectText = tPcApp(locale, 'welcome.connect');
  const removeLabel = tPcApp(locale, 'welcome.remove');

  const errorBanner = opts.errorMessage
    ? `<div class="server-setup-banner is-error" role="alert">${escapeHtml(opts.errorMessage)}</div>`
    : '';

  const listMarkup = items
    .map((item) => {
      const tags: string[] = [];
      if (item.label) tags.push(escapeHtml(item.label));
      if (item.isDefault) tags.push(escapeHtml(defaultBadge));
      if (item.isDetected) tags.push(escapeHtml(detectedBadge));
      const statusHtml = tags.length > 0
        ? `<div class="server-setup-status">${tags.join(' · ')}</div>`
        : '';
      const removeHtml = item.removable
        ? `<a class="server-setup-remove" href="${WELCOME_SUBMIT_ORIGIN}/remove?url=${encodeURIComponent(item.origin)}" aria-label="${escapeHtml(removeLabel)}" title="${escapeHtml(removeLabel)}">&times;</a>`
        : '';
      return `<div class="server-setup-item">
        <a class="server-setup-item-link" href="${WELCOME_SUBMIT_ORIGIN}/connect?url=${encodeURIComponent(item.origin)}">
          <span class="server-setup-node-dot" aria-hidden="true"></span>
          <span class="server-setup-item-body">
            <span class="server-setup-url">${escapeHtml(item.origin)}</span>
            ${statusHtml}
          </span>
        </a>
        ${removeHtml}
      </div>`;
    })
    .join('\n');

  const initialUrl = escapeHtml(opts.initialUrl ?? '');
  const initialLabel = escapeHtml(opts.initialLabel ?? '');

  const html = `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>IM.codes</title>
  <style>
    :root {
      color-scheme: dark;
      --chrome-accent: #22d3ee;
      --chrome-accent-2: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 20% 15%, rgba(34, 211, 238, 0.08), transparent 42%),
        radial-gradient(circle at 80% 85%, rgba(52, 211, 153, 0.07), transparent 45%),
        #070b14;
      color: #e2e8f0;
      display: grid;
      place-items: center;
      padding: 24px 16px;
    }
    .login-card {
      width: 100%;
      max-width: 420px;
      padding: 26px 22px 22px;
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(9, 14, 26, 0.98));
      border: 1px solid rgba(125, 211, 252, 0.2);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(186, 230, 253, 0.08);
    }
    .server-setup-header { text-align: center; margin-bottom: 20px; }
    .server-setup-header h1 {
      margin: 0 0 6px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.04em;
      background: linear-gradient(90deg, #f8fafc 10%, #67e8f9 65%, #34d399 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .server-setup-subtitle { margin: 0; font-size: 13px; color: #94a3b8; }
    .server-setup-banner {
      margin-bottom: 12px;
      padding: 9px 12px;
      border-radius: 9px;
      font-size: 13px;
      line-height: 1.4;
      text-align: center;
    }
    .server-setup-banner.is-error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(248, 113, 113, 0.42);
      color: #fca5a5;
    }
    .server-setup-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      margin-bottom: 14px;
    }
    .server-setup-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px 4px 4px;
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(17, 27, 45, 0.9), rgba(10, 17, 30, 0.96));
      border: 1px solid rgba(125, 211, 252, 0.22);
      box-shadow: inset 0 1px 0 rgba(186, 230, 253, 0.06);
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .server-setup-item:hover {
      border-color: rgba(34, 211, 238, 0.52);
      box-shadow: 0 0 16px rgba(34, 211, 238, 0.12);
    }
    .server-setup-item-link {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      text-decoration: none;
      color: inherit;
    }
    .server-setup-node-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex-shrink: 0;
      background: var(--chrome-accent);
      box-shadow: 0 0 8px rgba(34, 211, 238, 0.72);
    }
    .server-setup-item-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .server-setup-url {
      font-family: 'SF Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      color: #e2e8f0;
      word-break: break-all;
    }
    .server-setup-status { font-size: 11px; color: var(--chrome-accent-2); margin-top: 2px; }
    .server-setup-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 7px;
      background: transparent;
      border: 1px solid transparent;
      color: #64748b;
      font-size: 16px;
      line-height: 1;
      text-decoration: none;
      cursor: pointer;
    }
    .server-setup-remove:hover {
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(248, 113, 113, 0.28);
    }
    .server-setup-add-panel {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      background: rgba(8, 13, 22, 0.78);
      border: 1px solid rgba(34, 211, 238, 0.28);
      box-shadow: inset 0 1px 0 rgba(125, 211, 252, 0.08), 0 0 20px rgba(34, 211, 238, 0.05);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .server-setup-add-title {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
    }
    .server-setup-input {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.26);
      background: #020617;
      color: #f8fafc;
      font-size: 14px;
      outline: none;
    }
    .server-setup-input:focus {
      border-color: rgba(34, 211, 238, 0.65);
      box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.16);
    }
    .server-setup-submit {
      width: 100%;
      min-height: 38px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid rgba(45, 212, 191, 0.55);
      background: linear-gradient(180deg, rgba(20, 184, 166, 0.9), rgba(13, 148, 136, 0.95));
      color: #042f2e;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .server-setup-submit:hover {
      filter: brightness(1.06);
    }
  </style>
</head>
<body>
  <main class="login-card server-setup-card">
    <div class="server-setup-header">
      <h1>IM.codes</h1>
      <p class="server-setup-subtitle">${escapeHtml(subtitle)}</p>
    </div>
    ${errorBanner}
    <div class="server-setup-list">
      ${listMarkup}
    </div>
    <form class="server-setup-add-panel" action="${WELCOME_SUBMIT_ORIGIN}/add" method="GET">
      <div class="server-setup-add-title">${escapeHtml(addHeading)}</div>
      <input
        class="server-setup-input"
        id="welcome-url"
        name="url"
        type="text"
        placeholder="${escapeHtml(urlPlaceholder)}"
        value="${initialUrl}"
        required
      />
      <input
        class="server-setup-input"
        id="welcome-label"
        name="label"
        type="text"
        placeholder="${escapeHtml(labelPlaceholder)}"
        value="${initialLabel}"
      />
      <button type="submit" class="server-setup-submit">${escapeHtml(connectText)}</button>
    </form>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function buildServerPromptDataUrl(opts?: {
  locale?: string;
  initialUrl?: string;
  initialLabel?: string;
  errorMessage?: string;
}): string {
  const locale = normalizePcAppLocale(opts?.locale ?? Intl.DateTimeFormat().resolvedOptions().locale);
  const initialUrl = escapeHtml(opts?.initialUrl ?? '');
  const initialLabel = escapeHtml(opts?.initialLabel ?? '');
  const windowTitle = escapeHtml(tPcApp(locale, 'prompt.windowTitle'));
  const heading = escapeHtml(tPcApp(locale, 'prompt.heading'));
  const urlLabel = escapeHtml(tPcApp(locale, 'prompt.urlLabel'));
  const labelLabel = escapeHtml(tPcApp(locale, 'prompt.labelLabel'));
  const labelPlaceholder = escapeHtml(tPcApp(locale, 'prompt.labelPlaceholder'));
  const cancelLabel = escapeHtml(tPcApp(locale, 'common.cancel'));
  const submitLabel = escapeHtml(tPcApp(locale, 'prompt.submit'));
  const errorBlock = opts?.errorMessage
    ? `<div class="err" role="alert">${escapeHtml(opts.errorMessage)}</div>`
    : '';
  const html = `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>${windowTitle}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a; color: #e2e8f0;
    }
    h2 { margin: 0 0 12px; font-size: 16px; color: #f8fafc; }
    label { display: block; margin: 10px 0 4px; font-size: 12px; color: #94a3b8; }
    input {
      width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #334155;
      background: #020617; color: #f8fafc; font-size: 13px; outline: none;
    }
    input:focus { border-color: #38bdf8; }
    .err {
      margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px;
      background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.45); color: #fca5a5;
    }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    button, a.btn {
      padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none;
      border: 1px solid #334155; background: #1e293b; color: #e2e8f0;
    }
    button[type="submit"] { background: #0284c7; border-color: #0ea5e9; color: #ffffff; font-weight: 600; }
  </style>
</head>
<body>
  <h2>${heading}</h2>
  <form action="${PROMPT_SUBMIT_ORIGIN}/submit" method="GET">
    <label for="url">${urlLabel}</label>
    <input id="url" name="url" type="text" placeholder="https://app.im.codes" value="${initialUrl}" autofocus required />
    <label for="label">${labelLabel}</label>
    <input id="label" name="label" type="text" placeholder="${labelPlaceholder}" value="${initialLabel}" />
    ${errorBlock}
    <div class="actions">
      <a class="btn" href="${PROMPT_SUBMIT_ORIGIN}/cancel">${cancelLabel}</a>
      <button type="submit">${submitLabel}</button>
    </div>
  </form>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export interface PromptWindowLike {
  loadURL(url: string): Promise<void> | void;
  close(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): unknown;
  webContents: {
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  };
}

export type PromptWindowFactory = (options: {
  width: number;
  height: number;
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  modal: boolean;
  title: string;
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES & { partition: string };
}) => PromptWindowLike;

/**
 * Open a sandboxed, preload-free, IPC-free modal window to capture a server URL
 * and optional label. Validated via `normalizeServerOrigin()` in main process.
 */
export function openAddServerPrompt(
  createPromptWindow: PromptWindowFactory,
  opts?: { locale?: string },
): Promise<ServerPromptInput | null> {
  const locale = normalizePcAppLocale(opts?.locale ?? Intl.DateTimeFormat().resolvedOptions().locale);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServerPromptInput | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const modal = createPromptWindow({
      width: 440,
      height: 270,
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: true,
      title: tPcApp(locale, 'prompt.heading'),
      webPreferences: {
        ...MAIN_WINDOW_WEB_PREFERENCES,
        partition: 'pc-app-prompt-ephemeral',
      },
    });

    modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    modal.webContents.on('will-navigate', (event, rawTarget) => {
      event.preventDefault();
      let parsed: URL;
      try {
        parsed = new URL(rawTarget);
      } catch {
        return;
      }
      if (parsed.origin !== PROMPT_SUBMIT_ORIGIN) {
        return;
      }
      if (parsed.pathname === '/cancel') {
        finish(null);
        if (!modal.isDestroyed()) modal.close();
        return;
      }
      if (parsed.pathname !== '/submit') {
        return;
      }
      const rawUrl = parsed.searchParams.get('url') ?? '';
      const rawLabel = parsed.searchParams.get('label') ?? '';
      const cleanLabel = rawLabel.trim() || undefined;
      try {
        const origin = normalizeServerOrigin(rawUrl);
        finish({ origin, ...(cleanLabel ? { label: cleanLabel } : {}) });
        if (!modal.isDestroyed()) modal.close();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        void modal.loadURL(
          buildServerPromptDataUrl({
            locale,
            initialUrl: rawUrl,
            initialLabel: rawLabel,
            errorMessage,
          }),
        );
      }
    });

    modal.on('closed', () => {
      finish(null);
    });

    void modal.loadURL(buildServerPromptDataUrl({ locale }));
  });
}
