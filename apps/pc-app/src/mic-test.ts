import { normalizePcAppLocale, tPcApp, type PcAppLocale } from './i18n.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from './security.js';
import type { PromptWindowFactory, PromptWindowLike } from './server-prompt.js';
import type { PcAppInputDevice, PcAppIpcMainLike, PcAppVoiceEvent } from './voice-ipc.js';

export const PC_APP_MIC_TEST_CHANNELS = Object.freeze({
  action: 'imcodes:mic-test:action',
  state: 'imcodes:mic-test:state',
} as const);

export interface MicTestStateSnapshot {
  devices: PcAppInputDevice[];
  selectedUid: string;
  listening: boolean;
  level: number;
  transcript: string;
  error: string;
}

export interface OpenMicTestOptions {
  createPromptWindow: PromptWindowFactory;
  preloadPath?: string;
  ipcMain?: PcAppIpcMainLike;
  getLocale: () => string;
  getInputDevices: () => Promise<PcAppInputDevice[]>;
  getInputDevicesSync: () => PcAppInputDevice[];
  getSelectedInputDevice: () => string;
  setSelectedInputDevice: (uid: string) => string;
  startTestListening: (
    onEvent: (event: PcAppVoiceEvent) => void,
    locale?: string,
  ) => Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }>;
  stopTestListening: (options?: { abort?: boolean }) => Promise<void>;
  onDeviceChanged?: () => void;
}

export interface MicTestController {
  open(): Promise<void>;
  isOpen(): boolean;
  close(): void;
  dispose(): Promise<void>;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDeviceOptionLabel(dev: PcAppInputDevice, locale: PcAppLocale): string {
  const tags: string[] = [];
  if (dev.isDefault) tags.push(tPcApp(locale, 'micTest.tagDefault'));
  if (dev.transport === 'bluetooth') {
    tags.push(tPcApp(locale, 'micTest.tagBluetooth'));
  } else if (dev.isPhysical) {
    tags.push(tPcApp(locale, 'micTest.tagPhysical'));
  }
  return tags.length > 0 ? `${dev.name} [${tags.join(' · ')}]` : dev.name;
}

export function buildMicTestDataUrl(
  localeRaw: string,
  state: MicTestStateSnapshot,
): string {
  const locale = normalizePcAppLocale(localeRaw);
  const strings = {
    title: tPcApp(locale, 'micTest.title'),
    deviceLabel: tPcApp(locale, 'micTest.deviceLabel'),
    autoOption: tPcApp(locale, 'micTest.autoOption'),
    tagDefault: tPcApp(locale, 'micTest.tagDefault'),
    tagBluetooth: tPcApp(locale, 'micTest.tagBluetooth'),
    tagPhysical: tPcApp(locale, 'micTest.tagPhysical'),
    refresh: tPcApp(locale, 'micTest.refresh'),
    start: tPcApp(locale, 'micTest.start'),
    stop: tPcApp(locale, 'micTest.stop'),
    statusIdle: tPcApp(locale, 'micTest.statusIdle'),
    statusListening: tPcApp(locale, 'micTest.statusListening'),
    statusStopped: tPcApp(locale, 'micTest.statusStopped'),
    transcriptLabel: tPcApp(locale, 'micTest.transcriptLabel'),
    transcriptPlaceholder: tPcApp(locale, 'micTest.transcriptPlaceholder'),
    levelLabel: tPcApp(locale, 'micTest.levelLabel'),
  };

  const initialOptionsHtml = [
    `<option value="auto"${state.selectedUid === 'auto' ? ' selected' : ''}>${escapeHtml(strings.autoOption)}</option>`,
    ...state.devices.map(
      (dev) =>
        `<option value="${escapeHtml(dev.uid)}"${state.selectedUid === dev.uid ? ' selected' : ''}>${escapeHtml(formatDeviceOptionLabel(dev, locale))}</option>`,
    ),
  ].join('');

  const barsHtml = Array.from({ length: 16 }, () => '<div class="bar"></div>').join('');
  // Prevent closing script tag inside inline JSON payload
  const safeJson = (value: unknown) => JSON.stringify(value).replaceAll('</', '<\\/');

  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>${escapeHtml(strings.title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 18px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a; color: #e2e8f0; display: flex; flex-direction: column; gap: 14px;
    }
    h2 { margin: 0; font-size: 16px; font-weight: 600; color: #f8fafc; }
    .field-label { font-size: 12px; color: #94a3b8; margin-bottom: 5px; display: block; }
    .row { display: flex; gap: 8px; align-items: center; }
    select {
      flex: 1; min-width: 0; padding: 7px 10px; border-radius: 6px; border: 1px solid #334155;
      background: #020617; color: #f8fafc; font-size: 13px; outline: none;
    }
    select:focus { border-color: #38bdf8; }
    button {
      padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
      border: 1px solid #334155; background: #1e293b; color: #e2e8f0; white-space: nowrap;
    }
    button:hover { border-color: #475569; }
    button.primary { background: #0284c7; border-color: #0ea5e9; color: #ffffff; font-weight: 600; }
    button.danger { background: #b91c1c; border-color: #dc2626; color: #ffffff; font-weight: 600; }
    .card {
      padding: 12px 14px; border-radius: 8px; border: 1px solid #1e293b; background: #020617;
      display: flex; flex-direction: column; gap: 10px;
    }
    .level-head { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; }
    .waveform {
      height: 68px; display: flex; align-items: flex-end; gap: 5px; padding: 6px 4px;
    }
    .bar {
      flex: 1; height: 4px; min-height: 4px; max-height: 56px; border-radius: 3px;
      background: linear-gradient(180deg, #38bdf8 0%, #0284c7 100%);
      transition: height 75ms ease-out, opacity 90ms ease-out;
      opacity: 0.35;
    }
    .status { font-size: 12px; color: #94a3b8; min-height: 16px; }
    .status.active { color: #38bdf8; }
    .transcript {
      min-height: 84px; max-height: 120px; overflow-y: auto; padding: 10px 12px;
      border-radius: 8px; border: 1px solid #1e293b; background: #020617;
      font-size: 13px; line-height: 1.45; color: #f1f5f9; white-space: pre-wrap;
    }
    .transcript.placeholder { color: #64748b; }
    .err {
      display: none; padding: 8px 10px; border-radius: 6px; font-size: 12px;
      background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.45); color: #fca5a5;
    }
    .err.visible { display: block; }
  </style>
</head>
<body>
  <h2>${escapeHtml(strings.title)}</h2>
  <div>
    <label class="field-label" for="device-select">${escapeHtml(strings.deviceLabel)}</label>
    <div class="row">
      <select id="device-select">${initialOptionsHtml}</select>
      <button id="refresh-btn" type="button">${escapeHtml(strings.refresh)}</button>
    </div>
  </div>
  <div class="card">
    <div class="level-head">
      <span>${escapeHtml(strings.levelLabel)}</span>
      <span id="level-pct">0%</span>
    </div>
    <div id="waveform" class="waveform">${barsHtml}</div>
    <div class="row">
      <button id="toggle-btn" class="primary" type="button">${escapeHtml(strings.start)}</button>
      <span id="status-text" class="status">${escapeHtml(strings.statusIdle)}</span>
    </div>
  </div>
  <div>
    <span class="field-label">${escapeHtml(strings.transcriptLabel)}</span>
    <div id="transcript" class="transcript placeholder">${escapeHtml(strings.transcriptPlaceholder)}</div>
  </div>
  <div id="error-box" class="err"></div>

  <script>
    (function () {
      const STRINGS = ${safeJson(strings)};
      const bars = Array.from(document.querySelectorAll('#waveform .bar'));
      const history = new Array(bars.length).fill(0);
      const selectEl = document.getElementById('device-select');
      const refreshBtn = document.getElementById('refresh-btn');
      const toggleBtn = document.getElementById('toggle-btn');
      const statusEl = document.getElementById('status-text');
      const levelPctEl = document.getElementById('level-pct');
      const transcriptEl = document.getElementById('transcript');
      const errorBoxEl = document.getElementById('error-box');
      let currentListening = false;
      let hasStartedOnce = false;
      let tick = 0;
      let lastDevicesKey = '';
      let lastSelectedUid = '';

      function formatDev(dev) {
        const tags = [];
        if (dev.isDefault) tags.push(STRINGS.tagDefault);
        if (dev.transport === 'bluetooth') tags.push(STRINGS.tagBluetooth);
        else if (dev.isPhysical) tags.push(STRINGS.tagPhysical);
        return tags.length > 0 ? dev.name + ' [' + tags.join(' · ') + ']' : dev.name;
      }

      function computeDevicesKey(devices) {
        return JSON.stringify(
          devices.map(function (d) {
            return [d.uid, d.name, d.transport, Boolean(d.isDefault), Boolean(d.isPhysical)];
          }),
        );
      }

      function renderWaveform(level, listening) {
        if (!listening) {
          history.fill(0);
          for (let i = 0; i < bars.length; i += 1) {
            bars[i].style.height = '4px';
            bars[i].style.opacity = '0.35';
          }
          levelPctEl.textContent = '0%';
          return;
        }
        tick += 1;
        const clamped = Math.max(0, Math.min(1, Number(level) || 0));
        history.shift();
        history.push(clamped);
        levelPctEl.textContent = Math.round(clamped * 100) + '%';
        for (let i = 0; i < bars.length; i += 1) {
          const sample = history[i];
          const centerDist = Math.abs(i - (bars.length - 1) / 2) / ((bars.length - 1) / 2);
          const envelope = 1 - centerDist * 0.25;
          const jitter = sample > 0.01 ? (0.85 + 0.15 * Math.sin((tick + i) * 0.9)) : 1;
          const px = Math.round(4 + Math.min(1, sample * envelope * jitter) * 52);
          bars[i].style.height = px + 'px';
          bars[i].style.opacity = sample > 0.02 ? '1' : '0.45';
        }
      }

      function applyState(next) {
        if (!next || typeof next !== 'object') return;
        if (Array.isArray(next.devices)) {
          const wantedUid = typeof next.selectedUid === 'string' ? next.selectedUid : 'auto';
          const devicesKey = computeDevicesKey(next.devices);
          if (devicesKey !== lastDevicesKey) {
            lastDevicesKey = devicesKey;
            selectEl.innerHTML = '';
            const autoOpt = document.createElement('option');
            autoOpt.value = 'auto';
            autoOpt.textContent = STRINGS.autoOption;
            selectEl.appendChild(autoOpt);
            for (const dev of next.devices) {
              const opt = document.createElement('option');
              opt.value = dev.uid;
              opt.textContent = formatDev(dev);
              selectEl.appendChild(opt);
            }
            lastSelectedUid = '';
          }
          if (wantedUid !== lastSelectedUid) {
            lastSelectedUid = wantedUid;
            selectEl.value = Array.from(selectEl.options).some((o) => o.value === wantedUid) ? wantedUid : 'auto';
          }
        }

        currentListening = Boolean(next.listening);
        if (currentListening) hasStartedOnce = true;

        toggleBtn.textContent = currentListening ? STRINGS.stop : STRINGS.start;
        toggleBtn.className = currentListening ? 'danger' : 'primary';
        statusEl.textContent = currentListening
          ? STRINGS.statusListening
          : (hasStartedOnce ? STRINGS.statusStopped : STRINGS.statusIdle);
        statusEl.className = currentListening ? 'status active' : 'status';

        renderWaveform(next.level, currentListening);

        const text = typeof next.transcript === 'string' ? next.transcript : '';
        if (text) {
          transcriptEl.textContent = text;
          transcriptEl.classList.remove('placeholder');
          transcriptEl.scrollTop = transcriptEl.scrollHeight;
        } else {
          transcriptEl.textContent = STRINGS.transcriptPlaceholder;
          transcriptEl.classList.add('placeholder');
        }

        const err = typeof next.error === 'string' ? next.error : '';
        if (err) {
          errorBoxEl.textContent = err;
          errorBoxEl.classList.add('visible');
        } else {
          errorBoxEl.textContent = '';
          errorBoxEl.classList.remove('visible');
        }
      }

      const bridge = window.__IMCODES_MIC_TEST__;
      if (bridge && typeof bridge.onState === 'function') {
        bridge.onState(applyState);
      }

      selectEl.addEventListener('change', function () {
        void bridge?.sendAction('select-device', selectEl.value);
      });
      refreshBtn.addEventListener('click', function () {
        void bridge?.sendAction('refresh-devices');
      });
      toggleBtn.addEventListener('click', function () {
        void bridge?.sendAction(currentListening ? 'stop' : 'start');
      });

      applyState(${safeJson(state)});
    })();
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createPcAppMicTestController(opts: OpenMicTestOptions): MicTestController {
  let win: PromptWindowLike | null = null;
  let windowGen = 0;
  let listening = false;
  let owningTestSession = false;
  let level = 0;
  let transcript = '';
  let errorText = '';

  const snapshot = (): MicTestStateSnapshot => ({
    devices: opts.getInputDevicesSync(),
    selectedUid: opts.getSelectedInputDevice(),
    listening,
    level,
    transcript,
    error: errorText,
  });

  const pushState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send?.(PC_APP_MIC_TEST_CHANNELS.state, snapshot());
  };

  const handleVoiceEvent = (ev: PcAppVoiceEvent) => {
    switch (ev.type) {
      case 'start':
        listening = true;
        break;
      case 'level':
        level = Math.max(0, Math.min(1, Number.isFinite(ev.value) ? ev.value : 0));
        break;
      case 'result':
        transcript = ev.text;
        break;
      case 'error':
        errorText = ev.message ? `${ev.code}: ${ev.message}` : ev.code;
        break;
      case 'end':
        listening = false;
        owningTestSession = false;
        level = 0;
        break;
    }
    pushState();
  };

  const beginListening = async (gen: number) => {
    errorText = '';
    transcript = '';
    level = 0;
    listening = true;
    owningTestSession = true;
    pushState();

    const locale = opts.getLocale();
    const res = await opts.startTestListening((ev) => {
      if (gen !== windowGen) return;
      handleVoiceEvent(ev);
    }, locale);

    if (gen !== windowGen || !win || win.isDestroyed()) {
      if (res.ok) {
        void opts.stopTestListening({ abort: true });
      }
      return;
    }

    if (!res.ok) {
      listening = false;
      owningTestSession = false;
      level = 0;
      const errCode = res.error ?? 'start_failed';
      errorText = res.target ? `${errCode} (${res.target})` : errCode;
      pushState();
    }
  };

  if (opts.ipcMain) {
    opts.ipcMain.removeHandler?.(PC_APP_MIC_TEST_CHANNELS.action);
    opts.ipcMain.handle(PC_APP_MIC_TEST_CHANNELS.action, async (event, rawArg) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) {
        throw new Error('Blocked untrusted mic-test IPC invocation');
      }
      const action =
        rawArg && typeof rawArg === 'object' && 'action' in rawArg
          ? String((rawArg as { action?: unknown }).action ?? '')
          : '';
      const payload =
        rawArg && typeof rawArg === 'object' && 'payload' in rawArg
          ? (rawArg as { payload?: unknown }).payload
          : undefined;
      const currentGen = windowGen;

      if (action === 'start') {
        if (!listening) {
          void beginListening(currentGen);
        }
        return { ok: true };
      }

      if (action === 'stop') {
        listening = false;
        owningTestSession = false;
        level = 0;
        pushState();
        await opts.stopTestListening({ abort: false });
        return { ok: true };
      }

      if (action === 'refresh-devices') {
        await opts.getInputDevices();
        if (currentGen !== windowGen) return { ok: false };
        opts.onDeviceChanged?.();
        pushState();
        return { ok: true };
      }

      if (action === 'select-device') {
        const uid = typeof payload === 'string' ? payload : 'auto';
        const wasListening = listening;
        if (wasListening) {
          listening = false;
          owningTestSession = false;
          level = 0;
          pushState();
          await opts.stopTestListening({ abort: true });
        }
        if (currentGen !== windowGen) return { ok: false };
        opts.setSelectedInputDevice(uid);
        opts.onDeviceChanged?.();
        pushState();
        if (wasListening && win && !win.isDestroyed()) {
          await beginListening(currentGen);
        }
        return { ok: true };
      }

      return { ok: false, error: 'unknown_action' };
    });
  }

  const open = async (): Promise<void> => {
    if (win && !win.isDestroyed()) {
      win.focus?.();
      return;
    }

    const locale = normalizePcAppLocale(opts.getLocale());
    windowGen += 1;
    const currentGen = windowGen;
    listening = false;
    owningTestSession = false;
    level = 0;
    transcript = '';
    errorText = '';

    await opts.getInputDevices().catch(() => opts.getInputDevicesSync());

    if (currentGen !== windowGen) return;

    const modal = opts.createPromptWindow({
      width: 520,
      height: 460,
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: false,
      title: tPcApp(locale, 'micTest.title'),
      webPreferences: {
        ...MAIN_WINDOW_WEB_PREFERENCES,
        partition: 'pc-app-mic-test-ephemeral',
        ...(opts.preloadPath ? { preload: opts.preloadPath } : {}),
      },
    });
    win = modal;

    modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    modal.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    modal.on('closed', () => {
      if (win === modal) {
        win = null;
      }
      windowGen += 1;
      const shouldAbort = listening || owningTestSession;
      listening = false;
      owningTestSession = false;
      level = 0;
      if (shouldAbort) {
        void opts.stopTestListening({ abort: true });
      }
    });

    await modal.loadURL(buildMicTestDataUrl(locale, snapshot()));
    pushState();
    opts.onDeviceChanged?.();
  };

  return {
    open,
    isOpen: () => Boolean(win && !win.isDestroyed()),
    close: () => {
      if (win && !win.isDestroyed()) {
        win.close();
      }
    },
    dispose: async () => {
      windowGen += 1;
      const shouldAbort = listening || owningTestSession;
      listening = false;
      owningTestSession = false;
      level = 0;
      opts.ipcMain?.removeHandler?.(PC_APP_MIC_TEST_CHANNELS.action);
      if (win && !win.isDestroyed()) {
        const activeWin = win;
        win = null;
        activeWin.close();
      }
      if (shouldAbort) {
        await opts.stopTestListening({ abort: true });
      }
    },
  };
}
