/**
 * The local panel's client script, as plain ES2019-level JavaScript in one string (no imports: the page is one document).
 *
 * It is concatenated, in the page, after: `var B = <bootstrap>;`, the shared system-language resolver (shared/ui-locale.ts) and the
 * shared strings table plus `localPanelText` (shared/local-panel-strings.ts). It assumes those names exist and nothing else.
 *
 * Data from the node (host name, ids, labels) is only ever put on the page with `textContent`/attributes, never as markup.
 */
export const LOCAL_PANEL_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var state = null;
  var offline = false;
  var pref = 'system';
  var locale = 'en';
  var currentPage = 'home';
  var pendingAction = null;
  var lastFocus = null;
  var listSignature = '';
  var permSignature = '';
  var toastTimer = null;
  var remoteBusyCount = 0;
  var daemonBusyCount = 0;
  var loadSeq = 0;
  var appliedLoadSeq = 0;
  function isRemoteBusy() { return remoteBusyCount > 0; }
  function isDaemonBusy() { return daemonBusyCount > 0; }

  function $(id) { return document.getElementById(id); }
  function T(key, params) { return localPanelText(locale, key, params); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- language ---------------------------------------------------------
  function readPref() {
    try { return localStorage.getItem(B.langKey) || UI_LOCALE_FOLLOW_SYSTEM; } catch (e) { return UI_LOCALE_FOLLOW_SYSTEM; }
  }
  function writePref(value) {
    try {
      if (value === UI_LOCALE_FOLLOW_SYSTEM) localStorage.removeItem(B.langKey);
      else localStorage.setItem(B.langKey, value);
    } catch (e) { /* storage unavailable: the choice just is not remembered */ }
  }
  function resolveLocale() { return uiLocaleFromPreference(pref, systemLanguagesOf(navigator)); }

  function applyLocale() {
    document.documentElement.lang = locale;
    var nodes = document.querySelectorAll('[data-t]');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].textContent = T(nodes[i].getAttribute('data-t'));
    var labelled = document.querySelectorAll('[data-t-label]');
    for (var j = 0; j < labelled.length; j += 1) labelled[j].setAttribute('aria-label', T(labelled[j].getAttribute('data-t-label')));
    var titled = document.querySelectorAll('[data-t-title]');
    for (var k = 0; k < titled.length; k += 1) titled[k].setAttribute('title', T(titled[k].getAttribute('data-t-title')));
    var placeholdered = document.querySelectorAll('[data-t-placeholder]');
    for (var p = 0; p < placeholdered.length; p += 1) placeholdered[p].setAttribute('placeholder', T(placeholdered[p].getAttribute('data-t-placeholder')));
    buildLanguageOptions();
  }

  function buildLanguageOptions() {
    var select = $('langSelect');
    select.textContent = '';
    var follow = el('option', '', T('languageSystem'));
    follow.value = UI_LOCALE_FOLLOW_SYSTEM;
    select.appendChild(follow);
    for (var i = 0; i < UI_LOCALES.length; i += 1) {
      var option = el('option', '', UI_LOCALE_AUTONYMS[UI_LOCALES[i]]);
      option.value = UI_LOCALES[i];
      select.appendChild(option);
    }
    select.value = pref;
  }

  // ---- helpers ----------------------------------------------------------
  function fmtId(id) {
    var digits = String(id);
    return /^\d{10}$/.test(digits) ? digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6) : digits;
  }
  function fmtDuration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return h ? pad(h) + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60);
  }
  function fmtClock(ms) {
    try { return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(ms).toLocaleTimeString(); }
  }
  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2200);
  }

  // ---- rendering --------------------------------------------------------
  function renderStatus() {
    var paused = !!(state && state.paused);
    // Until the node has answered once there is nothing true to say about the state.
    $('statusPill').hidden = !state && !offline;
    var live = state ? state.connections.length : 0;
    var controlling = false;
    if (state) for (var i = 0; i < state.connections.length; i += 1) if (state.connections[i].mode === B.modes.CONTROL) controlling = true;
    var pill = $('statusPill');
    var cls = offline ? 'pill' : paused ? 'pill paused' : live ? 'pill busy' : 'pill online';
    pill.className = cls;
    $('statusText').textContent = offline ? T('statusOffline') : paused ? T('statusPaused') : live ? T('statusBusy') : T('statusOnline');
    $('pausedBanner').hidden = !paused || offline;
    $('offlineBanner').hidden = !offline;
    // The node is fine but cannot reach its server: say which address and why (host and reason only; the node sends nothing else).
    var serverConnection = state && state.serverConnection ? state.serverConnection : null;
    $('serverBanner').hidden = !serverConnection || offline;
    if (serverConnection) {
      var reasonKeys = { tcp_timeout: 'reasonTimeout', refused: 'reasonRefused', dns: 'reasonDns', tls: 'reasonTls', reset: 'reasonReset', rejected: 'reasonRejected' };
      $('serverText').textContent = T('serverText', { host: serverConnection.target, reason: T(reasonKeys[serverConnection.reason] || 'reasonOther') });
    }
    var sw = $('allowSwitch');
    sw.setAttribute('aria-checked', String(!paused));
    // Never disabled while an action runs: a disabled button loses keyboard focus. The click handler ignores clicks meanwhile.
    sw.disabled = !state;
    sw.setAttribute('aria-busy', String(isRemoteBusy()));
    $('swOn').textContent = T('switchOn');
    $('swOff').textContent = T('switchOff');
    $('allowHelp').textContent = paused ? T('allowOff') : T('allowOn');
    var badge = $('navBadge');
    badge.hidden = !live;
    badge.textContent = String(live);
    badge.className = controlling ? 'badge ctl' : 'badge';
    var count = $('count');
    count.textContent = String(live);
    count.className = live ? 'count live' : 'count';
    count.setAttribute('aria-label', T('connectionsActive', { n: live }));
    $('stopAll').disabled = !live;
    var name = state && state.deviceName ? state.deviceName : T('thisComputer');
    $('deviceName').textContent = name;
    $('deviceName').title = name;
    $('aboutVersion').textContent = state && state.version ? state.version : '-';
    $('aboutDevice').textContent = name;
  }

  function renderPermissions() {
    var card = $('permsCard');
    var permissions = state && state.permissions ? state.permissions : null;
    var signature = JSON.stringify([permissions, locale]);
    card.hidden = !permissions;
    $('topGrid').className = permissions ? 'top has-perms' : 'top';
    if (!permissions || signature === permSignature) return;
    permSignature = signature;
    var rows = $('permRows');
    rows.textContent = '';
    var defs = [
      ['screenRecording', 'permScreen', 'permHelpScreen'],
      ['accessibility', 'permAccessibility', 'permHelpAccessibility'],
      ['fullDiskAccess', 'permDisk', 'permHelpDisk']
    ];
    for (var i = 0; i < defs.length; i += 1) {
      var key = defs[i][0];
      var value = permissions[key];
      if (!value) continue;
      var ok = value === 'granted';
      var row = el('div', ok ? 'perm ok' : 'perm bad');
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = ok
        ? '<path d="M20 6L9 17l-5-5"/>'
        : '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>';
      row.appendChild(svg);
      row.appendChild(el('div', 't', T(defs[i][1])));
      row.appendChild(el('div', 's', ok ? T('permGranted') : value === 'denied' ? T('permDenied') : T('permUnknown')));
      if (!ok) {
        var button = el('button', 'btn small', T('openSettings'));
        button.type = 'button';
        button.setAttribute('data-target', key);
        button.onclick = openSettings.bind(null, key);
        row.appendChild(button);
        if (value === 'denied') row.appendChild(el('div', 'help', T(defs[i][2])));
      }
      rows.appendChild(row);
    }
  }

  function renderConnections() {
    var list = $('list');
    var connections = state ? state.connections : [];
    var signature = JSON.stringify([connections.map(function (c) { return [c.id, c.label, c.mode, c.connectedAt]; }), locale]);
    if (signature === listSignature) return;
    listSignature = signature;
    list.textContent = '';
    if (!connections.length) {
      var empty = el('div', 'empty');
      var inner = el('div');
      inner.innerHTML = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="10" width="48" height="32" rx="4"/><path d="M22 54h20M32 42v12"/></svg>';
      inner.appendChild(el('b', '', T('emptyTitle')));
      inner.appendChild(el('span', '', T('emptySub')));
      empty.appendChild(inner);
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < connections.length; i += 1) {
      var c = connections[i];
      var control = c.mode === B.modes.CONTROL;
      var row = el('div', control ? 'conn ctl' : 'conn');
      row.appendChild(el('div', 'avatar', String(c.label)));
      var main = el('div', 'main');
      var name = el('div', 'name', T('user') + ' #' + c.label + ' ');
      name.appendChild(el('span', control ? 'chip ctl' : 'chip', control ? T('control') : T('view')));
      var meta = el('div', 'meta', T('since') + ' ' + fmtClock(c.connectedAt) + ' · ');
      var duration = el('span');
      duration.setAttribute('data-since', String(c.connectedAt));
      meta.appendChild(duration);
      main.appendChild(name);
      main.appendChild(meta);
      var traffic = el('div', 'meta');
      traffic.setAttribute('data-traffic-id', c.id);
      main.appendChild(traffic);
      var button = el('button', 'btn danger', T('disconnect'));
      button.type = 'button';
      button.onclick = (function (connId) {
        return function () { if (!isRemoteBusy()) ask(B.actions.DISCONNECT, connId); };
      })(c.id);
      row.appendChild(main);
      row.appendChild(button);
      list.appendChild(row);
    }
    tick();
  }

  function trafficText(value) {
    return T('trafficUsage', { sent: formatRemoteDesktopBytes(value.bytesSent), received: formatRemoteDesktopBytes(value.bytesReceived), total: formatRemoteDesktopBytes(Math.min(Number.MAX_SAFE_INTEGER, value.bytesSent + value.bytesReceived)) });
  }
  function renderTraffic() {
    var traffic = state && state.traffic;
    $('trafficTotal').textContent = traffic ? T('trafficTotal') + ' · ' + trafficText(traffic.total) : T('trafficPending');
    $('trafficHomeTotal').textContent = $('trafficTotal').textContent;
    $('trafficError').hidden = !traffic || !traffic.persistenceError;
    var active = state ? state.connections : [];
    var labels = document.querySelectorAll('[data-traffic-id]');
    for (var i = 0; i < labels.length; i += 1) {
      var id = labels[i].getAttribute('data-traffic-id');
      var connection = active.find(function (c) { return c.id === id; });
      labels[i].textContent = connection && connection.traffic ? trafficText(connection.traffic) : T('trafficPending');
    }
    var history = $('trafficHistory');
    history.textContent = '';
    if (!traffic) return;
    for (var j = 0; j < traffic.connections.length; j += 1) {
      var record = traffic.connections[j];
      var row = el('div', 'conn');
      var main = el('div', 'main');
      main.appendChild(el('div', 'name', record.label + ' · ' + new Date(record.connectedAt).toLocaleString(locale)));
      main.appendChild(el('div', 'meta', record.measured ? trafficText(record) : T('trafficPending')));
      main.appendChild(el('div', 'meta', record.endedAt ? T('trafficEnded') + ' ' + new Date(record.endedAt).toLocaleString(locale) : T('trafficActive')));
      row.appendChild(main);
      history.appendChild(row);
    }
  }

  function renderDaemon() {
    var card = $('daemonCard');
    var d = state && state.daemon ? state.daemon : null;
    if (!d) { card.hidden = true; return; }
    card.hidden = false;

    var pill = $('daemonPill');
    var statusText = $('daemonStatusText');
    if (d.reason === B.daemonReason.NO_ACTIVE_USER) {
      pill.className = 'pill';
      statusText.textContent = T('daemonNoActiveUser');
    } else if (!d.installed) {
      pill.className = 'pill';
      statusText.textContent = T('daemonNotInstalled');
    } else if (d.running) {
      pill.className = 'pill online';
      statusText.textContent = T('daemonRunning');
    } else if (!d.bound) {
      pill.className = 'pill paused';
      statusText.textContent = T('daemonUnbound');
    } else {
      pill.className = 'pill paused';
      statusText.textContent = T('daemonStopped');
    }

    var srcBadge = $('daemonSourceBadge');
    if (d.runtimeSource === B.daemonSource.BUNDLE) {
      srcBadge.hidden = false;
      srcBadge.textContent = T('daemonSourceBundle');
    } else if (d.runtimeSource === B.daemonSource.CLI) {
      srcBadge.hidden = false;
      srcBadge.textContent = T('daemonSourceCli');
    } else {
      srcBadge.hidden = true;
    }

    var connBadge = $('daemonConnBadge');
    if (d.bound && d.running && d.connectionState !== B.daemonConn.UNKNOWN) {
      connBadge.hidden = false;
      if (d.connectionState === B.daemonConn.CONNECTED) {
        connBadge.className = 'chip';
        connBadge.textContent = T('daemonConnected');
      } else if (d.connectionState === B.daemonConn.CONNECTING) {
        connBadge.className = 'chip';
        connBadge.textContent = T('daemonConnecting');
      } else {
        connBadge.className = 'chip ctl';
        connBadge.textContent = T('daemonDisconnected');
      }
    } else {
      connBadge.hidden = true;
    }

    var dBusy = isDaemonBusy();
    $('daemonStart').disabled = dBusy || !d.canControl || d.running;
    $('daemonStop').disabled = dBusy || !d.running;
    $('daemonRestart').disabled = dBusy || !d.canControl || !d.bound;
    $('daemonLogsBtn').disabled = dBusy || !d.canViewLogs;
    var bindBtn = $('daemonBindBtn');
    bindBtn.textContent = T(d.bound ? 'daemonRebind' : 'daemonBind');
    bindBtn.disabled = dBusy || !d.canBind;
    var openWebBtn = $('daemonOpenWeb');
    openWebBtn.hidden = !(d.bound && d.serverOrigin);
    openWebBtn.disabled = dBusy;

    var autoKnown = d.autostart !== B.daemonAutostart.UNAVAILABLE && d.installed && d.canBind;
    $('daemonAutostartWrap').hidden = !autoKnown;
    var autoSw = $('daemonAutostartSwitch');
    autoSw.setAttribute('aria-checked', String(d.autostart === B.daemonAutostart.ENABLED));
    autoSw.disabled = !autoKnown;
    autoSw.setAttribute('aria-busy', String(dBusy));
    $('daemonSwOn').textContent = T('switchOn');
    $('daemonSwOff').textContent = T('switchOff');

    var parts = [];
    if (d.userName) parts.push(T('daemonUser') + ': ' + d.userName);
    if (d.serverHost) parts.push(T('daemonServer') + ': ' + d.serverHost);
    if (d.version) parts.push('v' + d.version);
    if (d.pid) parts.push('PID ' + String(d.pid));
    $('daemonMeta').textContent = parts.join(' · ');

    var hint = $('daemonHint');
    if (d.lastError) {
      hint.hidden = false;
      hint.textContent = d.lastError;
    } else if (d.reason === B.daemonReason.NO_ACTIVE_USER) {
      hint.hidden = false;
      hint.textContent = T('daemonNoActiveUserHint');
    } else if (d.reason === B.daemonReason.NOT_INSTALLED) {
      hint.hidden = false;
      hint.textContent = T('daemonNotInstalledHint');
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }

  function renderAll() {
    renderStatus();
    renderPermissions();
    renderDaemon();
    renderConnections();
    renderTraffic();
  }
  function hasActiveDom() {
    return typeof document !== 'undefined' && Boolean(document) && Boolean(document.body);
  }
  function tick() {
    if (!hasActiveDom()) return;
    var nodes = document.querySelectorAll('[data-since]');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].textContent = fmtDuration(Date.now() - Number(nodes[i].getAttribute('data-since')));
  }

  // ---- talking to the node ----------------------------------------------
  function load() {
    if (!hasActiveDom()) return Promise.resolve();
    var seq = ++loadSeq;
    return fetch(B.statePath, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('state');
      return response.json();
    }).then(function (next) {
      if (!hasActiveDom() || seq < appliedLoadSeq) return;
      appliedLoadSeq = seq;
      state = next;
      offline = false;
      renderAll();
    }).catch(function () {
      if (!hasActiveDom() || seq < appliedLoadSeq) return;
      appliedLoadSeq = seq;
      offline = true;
      renderStatus();
    });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [B.csrfHeader]: B.csrf },
      body: JSON.stringify(body)
    });
  }
  function runDomainAct(domain, action, id, extra) {
    if (domain === 'daemon') {
      daemonBusyCount += 1;
      if (hasActiveDom()) renderDaemon();
    } else {
      remoteBusyCount += 1;
      if (hasActiveDom()) renderStatus();
    }
    var body = { action: action };
    if (id !== undefined) body.id = id;
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    }
    return post(B.actionPath, body).then(function (response) {
      if (!response.ok && hasActiveDom()) toast(T('actionFailed'));
      return response.ok;
    }).catch(function () {
      if (hasActiveDom()) toast(T('actionFailed'));
      return false;
    }).then(function (ok) {
      if (domain === 'daemon') {
        daemonBusyCount = Math.max(0, daemonBusyCount - 1);
        if (hasActiveDom()) renderDaemon();
      } else {
        remoteBusyCount = Math.max(0, remoteBusyCount - 1);
        if (hasActiveDom()) renderStatus();
      }
      return load().then(function () { return ok; });
    });
  }
  function remoteAct(action, id, extra) { return runDomainAct('remote', action, id, extra); }
  function daemonAct(action, extra) { return runDomainAct('daemon', action, undefined, extra); }
  function isValidBindInput(raw) {
    var trimmed = String(raw || '').trim();
    if (!trimmed) return false;
    var parsed;
    try { parsed = new URL(trimmed); } catch (e) { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    var segs = parsed.pathname.split('/').filter(Boolean);
    return segs.length === 2 && segs[0] === 'bind' && segs[1].length >= 4;
  }
  function loadDaemonLogs() {
    var pre = $('daemonLogsPre');
    var meta = $('daemonLogsMeta');
    pre.textContent = '...';
    meta.textContent = '';
    return fetch(B.daemonLogsPath, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('logs');
      return response.json();
    }).then(function (data) {
      pre.textContent = data && data.text ? data.text : T('daemonLogsEmpty');
      meta.textContent = data && data.truncated ? T('daemonLogsTruncated') : (data && data.source ? data.source : '');
    }).catch(function () {
      pre.textContent = T('actionFailed');
    });
  }
  function openExternal(target, fallbackUrl) {
    post(B.externalPath, { target: target }).then(function (response) {
      if (!response.ok) window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
    }).catch(function () { window.open(fallbackUrl, '_blank', 'noopener,noreferrer'); });
  }
  function openSettings(target) {
    post(B.settingsPath, { target: target }).then(function (response) {
      if (!response.ok) toast(T('actionFailed'));
    }).catch(function () { toast(T('actionFailed')); });
  }

  // ---- confirm & daemon modals -----------------------------------------
  function activeModal() {
    if (!$('modal').hidden) return { modal: $('modal'), box: $('dialog'), close: closeModal };
    if (!$('daemonBindModal').hidden) return { modal: $('daemonBindModal'), box: $('daemonBindForm'), close: closeBindModal };
    if (!$('daemonLogsModal').hidden) return { modal: $('daemonLogsModal'), box: $('daemonLogsDialog'), close: closeLogsModal };
    return null;
  }
  function focusables(box) {
    return (box || $('dialog')).querySelectorAll('button,input');
  }
  function ask(action, id) {
    pendingAction = { action: action, id: id };
    var single = action === B.actions.DISCONNECT;
    $('confirmTitle').textContent = T(single ? 'disconnectTitle' : 'stopTitle');
    $('confirmText').textContent = T(single ? 'disconnectText' : 'stopText');
    lastFocus = document.activeElement;
    $('modal').hidden = false;
    $('cancel').focus();
  }
  function closeModal() {
    pendingAction = null;
    $('modal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function openBindModal() {
    lastFocus = document.activeElement;
    $('daemonBindInput').value = '';
    $('daemonBindErr').hidden = true;
    $('daemonBindErr').textContent = '';
    $('daemonBindModal').hidden = false;
    $('daemonBindInput').focus();
  }
  function closeBindModal() {
    $('daemonBindInput').value = '';
    $('daemonBindErr').hidden = true;
    $('daemonBindErr').textContent = '';
    $('daemonBindModal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function openLogsModal() {
    lastFocus = document.activeElement;
    $('daemonLogsModal').hidden = false;
    loadDaemonLogs();
    $('daemonLogsClose').focus();
  }
  function closeLogsModal() {
    $('daemonLogsModal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---- copy -------------------------------------------------------------
  function copyId() {
    var text = B.publicNodeId;
    var done = function () {
      var button = $('copy');
      button.className = 'icon-btn done';
      toast(T('copied'));
      setTimeout(function () { button.className = 'icon-btn'; }, 1200);
    };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) done(); else toast(T('actionFailed'));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ---- navigation -------------------------------------------------------
  function showPage(name) {
    currentPage = name;
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i += 1) pages[i].hidden = pages[i].getAttribute('data-page') !== name;
    var navs = document.querySelectorAll('.nav');
    for (var j = 0; j < navs.length; j += 1) {
      if (navs[j].getAttribute('data-page') === name) navs[j].setAttribute('aria-current', 'page');
      else navs[j].removeAttribute('aria-current');
    }
  }

  // ---- wiring -----------------------------------------------------------
  function init() {
    pref = readPref();
    if (pref !== UI_LOCALE_FOLLOW_SYSTEM && !isUiLocale(pref)) pref = UI_LOCALE_FOLLOW_SYSTEM;
    locale = resolveLocale();
    $('nodeId').textContent = fmtId(B.publicNodeId);
    $('aboutId').textContent = fmtId(B.publicNodeId);
    applyLocale();
    var navs = document.querySelectorAll('.nav');
    for (var i = 0; i < navs.length; i += 1) navs[i].onclick = showPage.bind(null, navs[i].getAttribute('data-page'));
    $('copy').onclick = copyId;
    $('allowSwitch').onclick = function () {
      if (!state || isRemoteBusy()) return;
      remoteAct(state.paused ? B.actions.RESUME : B.actions.PAUSE);
    };
    $('resume').onclick = function () { if (!isRemoteBusy()) remoteAct(B.actions.RESUME); };
    $('stopAll').onclick = function () { if (!isRemoteBusy()) ask(B.actions.STOP_ALL); };
    $('share').onclick = function () { openExternal('share', B.shareUrl); };
    $('manage').onclick = function () { openExternal('manage', B.manageUrl); };
    $('cancel').onclick = closeModal;
    $('confirmAction').onclick = function () {
      var chosen = pendingAction;
      closeModal();
      if (chosen && !isRemoteBusy()) remoteAct(chosen.action, chosen.id);
    };
    $('modal').addEventListener('mousedown', function (event) { if (event.target === $('modal')) closeModal(); });
    $('daemonStart').onclick = function () { if (!isDaemonBusy()) daemonAct(B.daemonActions.START); };
    $('daemonStop').onclick = function () { if (!isDaemonBusy()) daemonAct(B.daemonActions.STOP); };
    $('daemonRestart').onclick = function () { if (!isDaemonBusy()) daemonAct(B.daemonActions.RESTART); };
    $('daemonAutostartSwitch').onclick = function () {
      if (!state || !state.daemon || isDaemonBusy()) return;
      var enabled = state.daemon.autostart === B.daemonAutostart.ENABLED;
      daemonAct(enabled ? B.daemonActions.DISABLE_AUTOSTART : B.daemonActions.ENABLE_AUTOSTART);
    };
    $('daemonBindBtn').onclick = function () { if (!isDaemonBusy()) openBindModal(); };
    $('daemonBindCancel').onclick = closeBindModal;
    $('daemonBindModal').addEventListener('mousedown', function (event) { if (event.target === $('daemonBindModal')) closeBindModal(); });
    $('daemonBindForm').onsubmit = function (event) {
      event.preventDefault();
      if (isDaemonBusy()) return;
      var input = $('daemonBindInput');
      var raw = input.value;
      input.value = '';
      if (!isValidBindInput(raw)) {
        $('daemonBindErr').textContent = T('daemonBindInvalid');
        $('daemonBindErr').hidden = false;
        input.focus();
        return;
      }
      closeBindModal();
      daemonAct(B.daemonActions.BIND, { bindUrl: raw.trim() });
    };
    $('daemonLogsBtn').onclick = openLogsModal;
    $('daemonLogsRefresh').onclick = loadDaemonLogs;
    $('daemonLogsClose').onclick = closeLogsModal;
    $('daemonLogsModal').addEventListener('mousedown', function (event) { if (event.target === $('daemonLogsModal')) closeLogsModal(); });
    $('daemonOpenWeb').onclick = function () {
      var d = state && state.daemon ? state.daemon : null;
      if (!d || !d.serverOrigin) return;
      try {
        if (new URL(B.manageUrl).origin === d.serverOrigin) {
          openExternal('manage', B.manageUrl);
          return;
        }
      } catch (e) { /* fall through to direct window.open */ }
      window.open(d.serverOrigin, '_blank', 'noopener,noreferrer');
    };
    document.addEventListener('keydown', function (event) {
      var cur = activeModal();
      if (!cur) return;
      if (event.key === 'Escape') { event.preventDefault(); cur.close(); return; }
      if (event.key !== 'Tab') return;
      var items = focusables(cur.box);
      var first = items[0];
      var last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    $('langSelect').onchange = function (event) {
      pref = event.target.value;
      writePref(pref);
      locale = resolveLocale();
      listSignature = '';
      permSignature = '';
      applyLocale();
      renderAll();
    };
    showPage('home');
    renderAll();
    setInterval(tick, 1000);
    setInterval(load, 2000);
    load();
  }
  init();
})();
`;
