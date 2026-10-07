import { LOCAL_PANEL_EXTERNAL_PATH, LOCAL_PANEL_WINDOW_TITLE } from '../../shared/local-panel-window.js';
import { localPanelStringsEmbedSource } from '../../shared/local-panel-strings.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_LOCAL_ACTION, REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';
import { uiLocaleEmbedSource } from '../../shared/ui-locale.js';
import { LOCAL_PANEL_PAGE_CSS } from './local-panel-page-style.js';
import { LOCAL_PANEL_PAGE_SCRIPT } from './local-panel-page-script.js';

/** Where the person's language choice is remembered (browser storage of this machine only). */
export const LOCAL_PANEL_LANGUAGE_STORAGE_KEY = 'aidesk-local-lang';

export interface LocalPanelPageInput {
  publicNodeId: string;
  manageUrl: string;
  shareUrl: string;
  csrf: string;
}

// The favicon is inline so the page never asks the node for /favicon.ico. (The panel's CSP is unchanged, so a browser may decline
// the data: URL; the app window's icon is set by the window host, not by the page.)
const FAVICON = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%231d5fd6%27/%3E%3Ctext x=%2716%27 y=%2722%27 font-size=%2716%27 font-family=%27sans-serif%27 font-weight=%27700%27 text-anchor=%27middle%27 fill=%27white%27%3Eai%3C/text%3E%3C/svg%3E';

const ICON = {
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
} as const;

function pageBody(): string {
  return `<div class="app"><nav class="rail" data-t-label="navLabel">
<div class="logo" aria-hidden="true">ai</div>
<button class="nav" type="button" data-page="home" aria-current="page">${ICON.monitor}<span data-t="navHome"></span><span class="badge" id="navBadge" hidden></span></button>
<button class="nav" type="button" data-page="settings">${ICON.gear}<span data-t="navSettings"></span></button>
<button class="nav" type="button" data-page="about">${ICON.info}<span data-t="navAbout"></span></button>
</nav><main>
<section class="page" data-page="home" aria-live="off">
<div class="banner" id="pausedBanner" role="status" hidden>${ICON.pause}<div class="grow"><b data-t="pausedTitle"></b><p data-t="pausedText"></p></div><button class="btn primary" id="resume" type="button" data-t="resume"></button></div>
<div class="banner offline" id="offlineBanner" role="alert" hidden>${ICON.alert}<div class="grow"><b data-t="offlineTitle"></b><p data-t="offlineText"></p></div></div>
<div class="banner offline" id="serverBanner" role="status" hidden>${ICON.alert}<div class="grow"><b data-t="serverTitle"></b><p id="serverText"></p></div></div>
<div class="top" id="topGrid">
<section class="card hero" aria-labelledby="idLabel">
<div><p class="eyebrow"><span class="devname" id="deviceName"></span><span class="pill" id="statusPill"><i class="dot"></i><span id="statusText"></span></span></p>
<p class="eyebrow" id="idLabel" data-t="myId"></p>
<div class="id-row"><h1 class="id" id="nodeId"></h1><button class="icon-btn" id="copy" type="button" data-t-label="copyId" data-t-title="copyId">${ICON.copy}</button></div></div>
<div class="controls">
<div class="switch-row"><div class="txt"><b id="allowLabel" data-t="allow"></b><span id="allowHelp"></span></div>
<button class="switch" id="allowSwitch" type="button" role="switch" aria-checked="true" aria-labelledby="allowLabel"><span class="sw-text sw-on">${ICON.check}<span id="swOn"></span></span><span class="sw-text sw-off"><span id="swOff"></span></span></button></div>
<div class="actions"><button class="btn primary" id="share" type="button">${ICON.share}<span data-t="share"></span></button><button class="btn" id="manage" type="button">${ICON.external}<span data-t="manage"></span></button></div>
</div></section>
<section class="card perms" id="permsCard" hidden aria-labelledby="permsTitle"><h2 id="permsTitle" data-t="permissions"></h2><div id="permRows"></div></section>
</div>
<section class="section" aria-labelledby="connectionsTitle"><div class="section-head"><h2 id="connectionsTitle" data-t="connections"></h2><span class="count" id="count">0</span><span class="grow"></span><button class="btn danger" id="stopAll" type="button" data-t="stopAll"></button></div>
<div class="list" id="list"></div></section>
</section>
<section class="page" data-page="settings" hidden><h1 class="about-brand" data-t="settingsTitle"></h1>
<div class="form"><div class="field"><label for="langSelect" data-t="language"></label><select id="langSelect"></select><span class="hint" data-t="languageHelp"></span></div>
<p class="hint" data-t="appearanceNote" style="margin:0;color:var(--muted)"></p></div></section>
<section class="page" data-page="about" hidden><h1 class="about-brand">${LOCAL_PANEL_WINDOW_TITLE}</h1>
<dl class="kv"><dt data-t="version"></dt><dd id="aboutVersion"></dd><dt data-t="myId"></dt><dd id="aboutId"></dd><dt data-t="thisComputer"></dt><dd id="aboutDevice"></dd></dl></section>
<div class="footer"><span>${LOCAL_PANEL_WINDOW_TITLE}</span></div>
</main></div>
<div class="modal" id="modal" hidden><div class="dialog" id="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmText"><h2 id="confirmTitle"></h2><p id="confirmText"></p><div class="actions"><button class="btn" id="cancel" type="button" data-t="cancel"></button><button class="btn danger" id="confirmAction" type="button" data-t="confirm"></button></div></div></div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;
}

/**
 * The whole local management page as one document: markup, stylesheet and script inline, nothing loaded from anywhere.
 * `<title>` is the product name, constant (the window host finds the window by it).
 */
export function renderLocalPanelPage(input: LocalPanelPageInput): string {
  const bootstrap = JSON.stringify({
    ...input,
    statePath: REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH,
    actionPath: REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH,
    externalPath: LOCAL_PANEL_EXTERNAL_PATH,
    settingsPath: REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_SETTINGS_PATH,
    csrfHeader: REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER,
    langKey: LOCAL_PANEL_LANGUAGE_STORAGE_KEY,
    actions: REMOTE_DESKTOP_LOCAL_ACTION,
    modes: REMOTE_DESKTOP_ACCESS_MODE,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${LOCAL_PANEL_WINDOW_TITLE}</title><link rel="icon" href="${FAVICON}"><style>${LOCAL_PANEL_PAGE_CSS}</style></head><body>${pageBody()}<script>
var B=${bootstrap};
${uiLocaleEmbedSource()}
${localPanelStringsEmbedSource()}
${LOCAL_PANEL_PAGE_SCRIPT}
</script></body></html>`;
}
