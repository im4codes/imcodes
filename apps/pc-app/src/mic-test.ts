import { normalizePcAppLocale, tPcApp, type PcAppLocale } from './i18n.js';
import type { ShellWindowLike } from './shell.js';

export const MIC_TEST_OVERLAY_ID = 'imcodes-pc-mic-test-overlay';

export interface OpenMicTestOptions {
  getMainWindow: () => ShellWindowLike | null;
  getCurrentTrustedOrigin: () => string | null;
  getLocale: () => string;
  stopListening: (options?: { abort?: boolean }) => Promise<void>;
}

export interface MicTestController {
  open(): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export function buildMicTestOverlayScript(localeRaw: string): string {
  const locale: PcAppLocale = normalizePcAppLocale(localeRaw);
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
    modelLabel: tPcApp(locale, 'micTest.modelLabel'),
    modelSystem: tPcApp(locale, 'micTest.modelSystem'),
    modelDownloading: tPcApp(locale, 'micTest.modelDownloading'),
  };

  return `(function () {
  var OVERLAY_ID = ${JSON.stringify(MIC_TEST_OVERLAY_ID)};
  var STRINGS = ${JSON.stringify(strings)};
  var existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.focus && existing.focus();
    return { mounted: true, reused: true };
  }
  var voice = window.__IMCODES_PC_APP__ && window.__IMCODES_PC_APP__.voice;
  if (!voice) {
    return { mounted: false, reason: 'voice_bridge_unavailable' };
  }

  var root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.tabIndex = -1;
  Object.assign(root.style, {
    position: 'fixed',
    right: '20px',
    bottom: '88px',
    width: '360px',
    maxWidth: 'calc(100vw - 32px)',
    zIndex: '2147483000',
    borderRadius: '12px',
    background: 'rgba(15, 23, 42, 0.94)',
    backdropFilter: 'blur(14px)',
    border: '1px solid rgba(148, 163, 184, 0.25)',
    boxShadow: '0 18px 48px rgba(2, 6, 23, 0.55)',
    color: '#e2e8f0',
    padding: '14px 16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    outline: 'none',
  });

  var header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    cursor: 'grab',
    userSelect: 'none',
  });
  var titleEl = document.createElement('div');
  titleEl.textContent = STRINGS.title;
  Object.assign(titleEl.style, {
    fontSize: '14px',
    fontWeight: '600',
    color: '#f8fafc',
  });
  var closeBtn = document.createElement('button');
  closeBtn.id = 'imcodes-mic-test-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  Object.assign(closeBtn.style, {
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: '18px',
    lineHeight: '1',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: '6px',
  });
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  root.appendChild(header);

  var devLabel = document.createElement('label');
  devLabel.htmlFor = 'imcodes-mic-test-select';
  devLabel.textContent = STRINGS.deviceLabel;
  Object.assign(devLabel.style, { fontSize: '11px', color: '#94a3b8', marginBottom: '-6px' });
  root.appendChild(devLabel);

  var devRow = document.createElement('div');
  Object.assign(devRow.style, { display: 'flex', gap: '8px', alignItems: 'center' });
  var selectEl = document.createElement('select');
  selectEl.id = 'imcodes-mic-test-select';
  Object.assign(selectEl.style, {
    flex: '1',
    minWidth: '0',
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid #334155',
    background: '#020617',
    color: '#f8fafc',
    fontSize: '12px',
  });
  var refreshBtn = document.createElement('button');
  refreshBtn.id = 'imcodes-mic-test-refresh';
  refreshBtn.type = 'button';
  refreshBtn.textContent = STRINGS.refresh;
  Object.assign(refreshBtn.style, {
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  devRow.appendChild(selectEl);
  devRow.appendChild(refreshBtn);
  root.appendChild(devRow);

  var modelRow = document.createElement('div');
  modelRow.id = 'imcodes-mic-test-model-row';
  Object.assign(modelRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(51, 65, 85, 0.7)',
    background: 'rgba(2, 6, 23, 0.65)',
    fontSize: '11px',
    color: '#94a3b8',
  });
  var modelLabelEl = document.createElement('span');
  modelLabelEl.textContent = STRINGS.modelLabel;
  var modelBadgeEl = document.createElement('span');
  modelBadgeEl.id = 'imcodes-mic-test-model-badge';
  modelBadgeEl.textContent = STRINGS.modelSystem;
  Object.assign(modelBadgeEl.style, {
    color: '#cbd5e1',
    fontWeight: '500',
    textAlign: 'right',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  modelRow.appendChild(modelLabelEl);
  modelRow.appendChild(modelBadgeEl);
  root.appendChild(modelRow);

  var card = document.createElement('div');
  Object.assign(card.style, {
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid #1e293b',
    background: 'rgba(2, 6, 23, 0.85)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  });
  var levelHead = document.createElement('div');
  Object.assign(levelHead.style, {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: '#94a3b8',
  });
  var levelText = document.createElement('span');
  levelText.textContent = STRINGS.levelLabel;
  var levelPctEl = document.createElement('span');
  levelPctEl.id = 'imcodes-mic-test-level-pct';
  levelPctEl.textContent = '0%';
  levelHead.appendChild(levelText);
  levelHead.appendChild(levelPctEl);
  card.appendChild(levelHead);

  var waveformEl = document.createElement('div');
  waveformEl.id = 'imcodes-mic-test-waveform';
  Object.assign(waveformEl.style, {
    height: '52px',
    display: 'flex',
    alignItems: 'flex-end',
    gap: '4px',
    padding: '4px 2px',
  });
  var bars = [];
  for (var i = 0; i < 16; i += 1) {
    var bar = document.createElement('div');
    bar.className = 'bar';
    Object.assign(bar.style, {
      flex: '1',
      height: '4px',
      minHeight: '4px',
      maxHeight: '44px',
      borderRadius: '3px',
      background: 'linear-gradient(180deg, #38bdf8 0%, #0284c7 100%)',
      transition: 'height 75ms ease-out, opacity 90ms ease-out',
      opacity: '0.35',
    });
    waveformEl.appendChild(bar);
    bars.push(bar);
  }
  card.appendChild(waveformEl);

  var ctrlRow = document.createElement('div');
  Object.assign(ctrlRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  var toggleBtn = document.createElement('button');
  toggleBtn.id = 'imcodes-mic-test-toggle';
  toggleBtn.type = 'button';
  toggleBtn.textContent = STRINGS.start;
  Object.assign(toggleBtn.style, {
    padding: '6px 12px',
    borderRadius: '6px',
    border: '1px solid #0ea5e9',
    background: '#0284c7',
    color: '#ffffff',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  var statusEl = document.createElement('span');
  statusEl.id = 'imcodes-mic-test-status';
  statusEl.textContent = STRINGS.statusIdle;
  Object.assign(statusEl.style, { fontSize: '11px', color: '#94a3b8', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' });
  ctrlRow.appendChild(toggleBtn);
  ctrlRow.appendChild(statusEl);
  card.appendChild(ctrlRow);
  root.appendChild(card);

  var txLabel = document.createElement('div');
  txLabel.textContent = STRINGS.transcriptLabel;
  Object.assign(txLabel.style, { fontSize: '11px', color: '#94a3b8', marginBottom: '-6px' });
  root.appendChild(txLabel);

  var transcriptEl = document.createElement('div');
  transcriptEl.id = 'imcodes-mic-test-transcript';
  transcriptEl.textContent = STRINGS.transcriptPlaceholder;
  Object.assign(transcriptEl.style, {
    minHeight: '56px',
    maxHeight: '96px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid #1e293b',
    background: 'rgba(2, 6, 23, 0.85)',
    fontSize: '12px',
    lineHeight: '1.4',
    color: '#64748b',
    whiteSpace: 'pre-wrap',
  });
  root.appendChild(transcriptEl);

  var errorBoxEl = document.createElement('div');
  errorBoxEl.id = 'imcodes-mic-test-error';
  Object.assign(errorBoxEl.style, {
    display: 'none',
    padding: '6px 10px',
    borderRadius: '6px',
    fontSize: '11px',
    background: 'rgba(239, 68, 68, 0.14)',
    border: '1px solid rgba(239, 68, 68, 0.45)',
    color: '#fca5a5',
  });
  root.appendChild(errorBoxEl);

  var history = new Array(bars.length).fill(0);
  var listening = false;
  var hasStartedOnce = false;
  var disposed = false;
  var tick = 0;
  var lastDevicesKey = '';
  var lastSelectedUid = '';
  var unsubscribe = null;

  function formatDev(dev) {
    var tags = [];
    if (dev.isDefault) tags.push(STRINGS.tagDefault);
    if (dev.transport === 'bluetooth') tags.push(STRINGS.tagBluetooth);
    else if (dev.isPhysical) tags.push(STRINGS.tagPhysical);
    return tags.length > 0 ? dev.name + ' [' + tags.join(' · ') + ']' : dev.name;
  }

  function renderWaveform(level) {
    if (!listening) {
      for (var i = 0; i < bars.length; i += 1) {
        history[i] = 0;
        bars[i].style.height = '4px';
        bars[i].style.opacity = '0.35';
      }
      levelPctEl.textContent = '0%';
      return;
    }
    tick += 1;
    var clamped = Math.max(0, Math.min(1, Number(level) || 0));
    history.shift();
    history.push(clamped);
    levelPctEl.textContent = Math.round(clamped * 100) + '%';
    for (var j = 0; j < bars.length; j += 1) {
      var sample = history[j];
      var centerDist = Math.abs(j - (bars.length - 1) / 2) / ((bars.length - 1) / 2);
      var envelope = 1 - centerDist * 0.25;
      var jitter = sample > 0.01 ? (0.85 + 0.15 * Math.sin((tick + j) * 0.9)) : 1;
      var px = Math.round(4 + Math.min(1, sample * envelope * jitter) * 40);
      bars[j].style.height = px + 'px';
      bars[j].style.opacity = sample > 0.02 ? '1' : '0.45';
    }
  }

  function setListeningUi(nextListening) {
    listening = Boolean(nextListening);
    if (listening) hasStartedOnce = true;
    toggleBtn.textContent = listening ? STRINGS.stop : STRINGS.start;
    toggleBtn.style.background = listening ? '#b91c1c' : '#0284c7';
    toggleBtn.style.borderColor = listening ? '#dc2626' : '#0ea5e9';
    statusEl.textContent = listening
      ? STRINGS.statusListening
      : (hasStartedOnce ? STRINGS.statusStopped : STRINGS.statusIdle);
    statusEl.style.color = listening ? '#38bdf8' : '#94a3b8';
    if (!listening) {
      renderWaveform(0);
    }
  }

  function setError(msg) {
    if (msg) {
      errorBoxEl.textContent = msg;
      errorBoxEl.style.display = 'block';
    } else {
      errorBoxEl.textContent = '';
      errorBoxEl.style.display = 'none';
    }
  }

  function syncDevices(devices, selectedUid) {
    var list = Array.isArray(devices) ? devices : [];
    var key = JSON.stringify(list.map(function (d) { return [d.uid, d.name, d.transport, Boolean(d.isDefault), Boolean(d.isPhysical)]; }));
    if (key !== lastDevicesKey) {
      lastDevicesKey = key;
      selectEl.innerHTML = '';
      var autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = STRINGS.autoOption;
      selectEl.appendChild(autoOpt);
      for (var i = 0; i < list.length; i += 1) {
        var opt = document.createElement('option');
        opt.value = list[i].uid;
        opt.textContent = formatDev(list[i]);
        selectEl.appendChild(opt);
      }
      lastSelectedUid = '';
    }
    var wantedUid = typeof selectedUid === 'string' && selectedUid ? selectedUid : 'auto';
    if (wantedUid !== lastSelectedUid) {
      lastSelectedUid = wantedUid;
      var hasWanted = Array.from(selectEl.options || []).some(function (o) { return o.value === wantedUid; });
      selectEl.value = hasWanted ? wantedUid : 'auto';
    }
  }

  function formatModelChoice(choice) {
    if (choice === 'qwen3-0.6b') return 'Qwen3-ASR 0.6B';
    if (choice === 'qwen3-1.7b') return 'Qwen3-ASR 1.7B';
    return STRINGS.modelSystem;
  }

  function renderModelStatus(st) {
    if (!st || typeof st !== 'object') return;
    var activeName = formatModelChoice(st.activeBackend || st.selectedModel || 'system');
    var dlChoice = st.downloadingModel || (st.state === 'downloading' ? st.selectedModel : null);
    if (dlChoice && dlChoice !== 'system' && (st.state === 'downloading' || (st.models && st.models[dlChoice] && st.models[dlChoice].state === 'downloading'))) {
      var dlProgress = st.models && st.models[dlChoice] ? st.models[dlChoice].progress : st.progress;
      var pct = Math.max(0, Math.min(100, Math.round((Number(dlProgress) || 0) * 100)));
      var dlText = STRINGS.modelDownloading
        .replace('{{model}}', formatModelChoice(dlChoice))
        .replace('{{progress}}', String(pct));
      modelBadgeEl.textContent = activeName + ' · ' + dlText;
      modelBadgeEl.style.color = '#38bdf8';
      return;
    }
    modelBadgeEl.textContent = activeName;
    modelBadgeEl.style.color = activeName !== STRINGS.modelSystem ? '#34d399' : '#cbd5e1';
  }

  function refreshModelStatus() {
    if (!voice || typeof voice.getSpeechModelStatus !== 'function') return;
    Promise.resolve(voice.getSpeechModelStatus())
      .then(function (st) {
        if (!disposed) renderModelStatus(st);
      })
      .catch(function () {});
  }

  function refreshDevices() {
    Promise.all([voice.getInputDevices(), voice.getInputDevice()])
      .then(function (pair) {
        if (disposed) return;
        syncDevices(pair[0], pair[1]);
      })
      .catch(function (err) {
        if (!disposed) setError(err && err.message ? err.message : String(err));
      });
  }

  function startTest() {
    setError('');
    transcriptEl.textContent = STRINGS.transcriptPlaceholder;
    transcriptEl.style.color = '#64748b';
    setListeningUi(true);
    voice.startListening()
      .then(function (res) {
        if (disposed) {
          if (res && res.ok) voice.stopListening({ abort: true });
          return;
        }
        if (!res || !res.ok) {
          setListeningUi(false);
          var code = (res && res.error) ? res.error : 'start_failed';
          setError(res && res.target ? code + ' (' + res.target + ')' : code);
        }
      })
      .catch(function (err) {
        if (disposed) return;
        setListeningUi(false);
        setError(err && err.message ? err.message : String(err));
      });
  }

  unsubscribe = voice.subscribe(function (ev) {
    if (disposed || !ev || typeof ev !== 'object') return;
    if (ev.type === 'start') {
      setListeningUi(true);
    } else if (ev.type === 'level') {
      renderWaveform(ev.value);
    } else if (ev.type === 'result') {
      if (ev.text) {
        transcriptEl.textContent = ev.text;
        transcriptEl.style.color = '#f1f5f9';
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    } else if (ev.type === 'error') {
      setError(ev.message ? (ev.code + ': ' + ev.message) : ev.code);
    } else if (ev.type === 'end') {
      setListeningUi(false);
    }
  });

  selectEl.addEventListener('change', function () {
    var uid = selectEl.value || 'auto';
    var wasListening = listening;
    lastSelectedUid = uid;
    Promise.resolve(wasListening ? voice.stopListening({ abort: true }) : undefined)
      .then(function () { return voice.setInputDevice(uid); })
      .then(function () {
        if (!disposed && wasListening) {
          startTest();
        }
      })
      .catch(function (err) {
        if (!disposed) setError(err && err.message ? err.message : String(err));
      });
  });

  refreshBtn.addEventListener('click', refreshDevices);

  toggleBtn.addEventListener('click', function () {
    if (listening) {
      setListeningUi(false);
      voice.stopListening({ abort: false }).catch(function () {});
    } else {
      startTest();
    }
  });

  var dragging = false;
  var dragOffsetX = 0;
  var dragOffsetY = 0;
  function onMouseMove(e) {
    if (!dragging) return;
    root.style.left = Math.max(8, e.clientX - dragOffsetX) + 'px';
    root.style.top = Math.max(8, e.clientY - dragOffsetY) + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }
  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    header.style.cursor = 'grab';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
  header.addEventListener('mousedown', function (e) {
    if (e.target === closeBtn) return;
    var rect = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0 };
    dragging = true;
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    header.style.cursor = 'grabbing';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  var modelPollTimer = null;

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (modelPollTimer !== null) {
      clearInterval(modelPollTimer);
      modelPollTimer = null;
    }
    window.removeEventListener('beforeunload', cleanup);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    if (typeof unsubscribe === 'function') {
      unsubscribe();
      unsubscribe = null;
    }
    if (listening) {
      listening = false;
      voice.stopListening({ abort: true }).catch(function () {});
    }
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
    if (window.__imcodesPcMicTestCleanup === cleanup) {
      delete window.__imcodesPcMicTestCleanup;
    }
  }

  closeBtn.addEventListener('click', cleanup);
  window.addEventListener('beforeunload', cleanup);
  window.__imcodesPcMicTestCleanup = cleanup;

  (document.body || document.documentElement).appendChild(root);
  refreshDevices();
  refreshModelStatus();
  if (typeof voice.getSpeechModelStatus === 'function') {
    modelPollTimer = setInterval(refreshModelStatus, 400);
  }
  return { mounted: true };
})();`;
}

export function createPcAppMicTestController(opts: OpenMicTestOptions): MicTestController {
  const cleanupOverlay = async (): Promise<void> => {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed() || !opts.getCurrentTrustedOrigin()) return;
    await win.webContents
      .executeJavaScript?.('window.__imcodesPcMicTestCleanup?.()', false)
      ?.catch(() => {});
  };

  const open = async (): Promise<void> => {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (!opts.getCurrentTrustedOrigin()) return;
    const script = buildMicTestOverlayScript(opts.getLocale());
    await win.webContents.executeJavaScript?.(script, true)?.catch(() => {});
  };

  return {
    open,
    close: cleanupOverlay,
    dispose: async () => {
      await cleanupOverlay();
      await opts.stopListening({ abort: true });
    },
  };
}
