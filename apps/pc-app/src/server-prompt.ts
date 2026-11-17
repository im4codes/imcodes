import { MAIN_WINDOW_WEB_PREFERENCES } from './security.js';
import { normalizeServerOrigin } from './servers.js';

export interface ServerPromptInput {
  origin: string;
  label?: string;
}

const PROMPT_SUBMIT_ORIGIN = 'https://imcodes-prompt.local';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildWelcomeDataUrl(savedCount = 0): string {
  const hint = savedCount === 0
    ? 'Open <strong>Server &rarr; Add Server…</strong> from the application menu to connect your IM.codes server.'
    : 'Select a saved server from <strong>Server</strong> in the application menu.';
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>IM.codes PC App</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1120; color: #e2e8f0;
      display: grid; place-items: center; min-height: 100vh;
    }
    .card {
      max-width: 460px; padding: 28px 32px; border-radius: 12px;
      background: #111a2e; border: 1px solid #1e293b; box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 10px; font-size: 20px; color: #f8fafc; }
    p { margin: 0; line-height: 1.55; color: #94a3b8; font-size: 14px; }
    strong { color: #38bdf8; }
  </style>
</head>
<body>
  <main class="card">
    <h1>IM.codes</h1>
    <p>${hint}</p>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function buildServerPromptDataUrl(opts?: {
  initialUrl?: string;
  initialLabel?: string;
  errorMessage?: string;
}): string {
  const initialUrl = escapeHtml(opts?.initialUrl ?? '');
  const initialLabel = escapeHtml(opts?.initialLabel ?? '');
  const errorBlock = opts?.errorMessage
    ? `<div class="err" role="alert">${escapeHtml(opts.errorMessage)}</div>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>Add Server</title>
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
  <h2>Add IM.codes Server</h2>
  <form action="${PROMPT_SUBMIT_ORIGIN}/submit" method="GET">
    <label for="url">Server URL (https:// or http://localhost)</label>
    <input id="url" name="url" type="text" placeholder="https://app.im.codes" value="${initialUrl}" autofocus required />
    <label for="label">Display Name (optional)</label>
    <input id="label" name="label" type="text" placeholder="Production" value="${initialLabel}" />
    ${errorBlock}
    <div class="actions">
      <a class="btn" href="${PROMPT_SUBMIT_ORIGIN}/cancel">Cancel</a>
      <button type="submit">Add Server</button>
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
export function openAddServerPrompt(createPromptWindow: PromptWindowFactory): Promise<ServerPromptInput | null> {
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
      title: 'Add IM.codes Server',
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

    void modal.loadURL(buildServerPromptDataUrl());
  });
}
