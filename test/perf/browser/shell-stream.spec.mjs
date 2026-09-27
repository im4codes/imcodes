import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const SESSION = process.env.IMC_PERF_SHELL_SESSION ?? 'deck_shell_perf_brain';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'imc_shell_perf_browser_key';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const CONTROL_URL = process.env.IMC_PERF_SHELL_CONTROL_URL ?? 'http://shell-daemon:19139';

function jwt() {
  const b64 = (v) => Buffer.from(v).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: 'imc_shell_perf_user', role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

async function terminalText(page) {
  return page.locator('.terminal-container').first().locator('.xterm-rows').innerText().catch(() => '');
}

async function waitForTerminalText(page, needle, timeout = 15_000) {
  try {
    await page.waitForFunction(({ needle }) => document.querySelector('.terminal-container .xterm-rows')?.innerText.includes(needle), { needle }, { timeout });
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    const rows = await terminalText(page);
    console.error(JSON.stringify({ needle, body: body.slice(-2000), rows: rows.slice(-2000) }));
    throw error;
  }
  return terminalText(page);
}

async function typeCommand(page, command, marker, timeout = 15_000) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  return waitForTerminalText(page, marker, timeout);
}

async function pasteCommand(page, command, marker, timeout = 15_000) {
  const usedClipboardApi = await page.evaluate(async (value) => {
    if (navigator.clipboard?.writeText && !window.__shellClipboardStub) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    // Headless Chromium may not expose Clipboard API on an HTTP origin.  A
    // real ClipboardEvent still exercises the browser paste path and xterm's
    // bracketed-paste handling without bypassing the UI.
    const target = document.querySelector('.xterm-helper-textarea');
    if (!target) throw new Error('xterm input target missing');
    const data = new DataTransfer();
    data.setData('text/plain', value);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return false;
  }, command);
  if (usedClipboardApi) await page.keyboard.press('Control+V');
  else await page.keyboard.press('Enter');
  // Commands below encode their output marker so it is absent from the local
  // echo; waiting for one occurrence therefore means the shell produced it.
  const result = await waitForTerminalText(page, marker, timeout);
  await page.waitForTimeout(100);
  return result;
}

async function measureKeystrokeEcho(page, samples = 24) {
  await page.locator('.terminal-container').first().click();
  await page.locator('.xterm-helper-textarea').focus().catch(() => {});
  const latencies = [];
  for (let index = 0; index < samples; index += 1) {
    const marker = `LATENCY_ECHO_${index}_${Date.now()}`;
    const started = await page.evaluate(() => performance.now());
    await page.keyboard.type(`printf '%s\\n' '${marker}'`);
    await page.keyboard.press('Enter');
    await waitForTerminalText(page, marker, 5_000);
    latencies.push(await page.evaluate((startedAt) => performance.now() - startedAt, started));
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
  return { p95Ms: Number(p95.toFixed(2)), samples: latencies.length };
}

async function fitViewportToColumns(page, targetCols) {
  let low = 390;
  let high = Math.max(2400, targetCols * 14);
  let best = { width: high, cols: 0, distance: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const width = Math.round((low + high) / 2);
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(120);
    const cols = await page.evaluate((session) => window.__imcShellTerminals?.[session]?.cols ?? window.__imcShellTerminal?.cols ?? 0, SESSION);
    const distance = Math.abs(cols - targetCols);
    if (distance < best.distance) best = { width, cols, distance };
    if (cols < targetCols) low = width + 1;
    else high = width - 1;
  }
  await page.setViewportSize({ width: best.width, height: 800 });
  await page.waitForTimeout(150);
  return best;
}

async function copyUrlAtColumns(page, targetCols, url) {
  const fitted = await fitViewportToColumns(page, targetCols);
  await page.locator('.terminal-container').first().click();
  await page.locator('.xterm-helper-textarea').focus().catch(() => {});
  await page.keyboard.press('Control+C');
  const encoded = Buffer.from(url).toString('base64');
  await pasteCommand(page, `printf '%s' '${encoded}' | base64 -d > /tmp/url.txt; cat /tmp/url.txt; printf 'Z9\\n'`, 'Z9');
  const selection = await page.evaluate(({ value, session }) => {
    const candidates = Object.values(window.__imcShellTerminals ?? {});
    const fallback = window.__imcShellTerminals?.[session] ?? window.__imcShellTerminal;
    const term = candidates.find((candidate) => {
      for (let row = 0; row < candidate.buffer.active.length; row += 1) {
        if ((candidate.buffer.active.getLine(row)?.translateToString(true) ?? '').includes(value.slice(0, 16))) return true;
      }
      return false;
    }) ?? fallback;
    if (!term) throw new Error('xterm test handle missing');
    term.selectAll();
    const selected = term.getSelection();
    if (!selected.includes(value)) throw new Error('xterm selection did not contain the printed URL');
    return { selected, cols: term.cols };
  }, { value: url, session: SESSION });
  await page.keyboard.press('Control+C');
  const copied = await page.evaluate(() => navigator.clipboard?.readText?.() ?? '');
  const normalized = copied.replace(/\r?\n/g, '');
  const selectedNormalized = selection.selected.replace(/\r?\n/g, '');
  const selectedOccurrences = selectedNormalized.match(/https:\/\/example\.test\/remote-desktop\/x{260}/g) ?? [];
  const copiedOccurrences = normalized.match(/https:\/\/example\.test\/remote-desktop\/x{260}/g) ?? [];
  return { requestedCols: targetCols, actualCols: fitted.cols, viewportWidth: fitted.width, copiedLength: copied.length, exact: copiedOccurrences.length === 1 && copiedOccurrences[0] === url, selectedHasUrl: selectedOccurrences.length >= 1, clipboardExact: copiedOccurrences.length === 1 && copiedOccurrences[0] === url, selectedLength: selection.selected.length, rows: [] };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function killRemoteTmux() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${CONTROL_URL}/kill`, { mode: 'cors', signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('shell control endpoint did not respond');
}

export async function runShellBrowserScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-shell-perf-csrf-token', url: BASE_URL }]);
  await context.addInitScript(({ apiKey, serverId }) => {
    window.__IMC_SHELL_BROWSER_TEST__ = true;
    if (!navigator.clipboard) {
      window.__shellClipboardStub = true;
      window.__shellClipboardText = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value) => { window.__shellClipboardText = value; },
          readText: async () => window.__shellClipboardText,
        },
      });
    }
    if (typeof crypto.randomUUID !== 'function') {
      crypto.randomUUID = () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    }
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_server', serverId);
    window.__shellPerf = { firstPaintMs: 0, longTasks: 0, frames: 0, frameStart: performance.now() };
    try {
      new PerformanceObserver((list) => {
        window.__shellPerf.longTasks += list.getEntries().filter((entry) => entry.duration > 50).length;
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* LongTaskObserver is unavailable in some Chromium headless builds. */ }
    const tick = (time) => {
      window.__shellPerf.frames += 1;
      window.__shellPerf.lastFrame = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { apiKey: API_KEY, serverId: SERVER_ID });
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.terminal-container', { timeout: 90_000 });
  const firstPaintMs = Date.now() - started;
  await page.evaluate((value) => { window.__shellPerf.firstPaintMs = value; }, firstPaintMs);
  await page.locator('.terminal-container').first().click();
  await page.locator('.xterm-helper-textarea').focus().catch(() => {});
  // Do not race xterm's snapshot/stream handoff: wait until the shell has
  // rendered a prompt before injecting the first keystroke.
  await page.waitForFunction(() => {
    const text = document.querySelector('.terminal-container .xterm-rows')?.innerText ?? '';
    return /#\s*$/.test(text.trim());
  }, undefined, { timeout: 30_000 });

  const inputLatency = await measureKeystrokeEcho(page);

  // Input path: fast text, editing keys, history, interrupts and controls.
  const typed = 'typed-once-in-order';
  await typeCommand(page, `printf '%s\\n' '${typed}'`, typed);
  await page.keyboard.type("printf 'backspacX'");
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('e');
  await page.keyboard.press('Enter');
  await waitForTerminalText(page, 'backspace');
  await typeCommand(page, "rm -f /tmp/history.txt; printf 'history-marker\\n' >> /tmp/history.txt", '');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await typeCommand(page, "test \"$(wc -l < /tmp/history.txt)\" = 2 && printf 'HISTORY_OK\\n'", 'HISTORY_OK');
  await page.keyboard.type('sleep 3');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+C');
  await typeCommand(page, "printf 'interrupt-ok\\n'", 'interrupt-ok');
  await page.keyboard.type('cat');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+D');
  await typeCommand(page, "printf 'eof-ok\\n'", 'eof-ok');
  await page.keyboard.type('sleep 3');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Z');
  await typeCommand(page, "printf 'job-control-ok\\n'", 'job-control-ok');

  // Checksum a file created by the browser input path, including Unicode.
  const inputFile = 'typed-file-中文-✓';
  const inputHash = sha256(`${inputFile}\n`);
  // insertText mirrors an IME commit (one input event) instead of synthesizing
  // keycodes for characters that have no physical key on the test keyboard.
  await page.keyboard.insertText(`printf '%s\\n' '${inputFile}' > /tmp/in.txt && sha256sum /tmp/in.txt`);
  await page.keyboard.press('Enter');
  await waitForTerminalText(page, inputHash);

  // Clipboard path: single/multi-line and a large bracketed paste.
  await pasteCommand(page, "printf 'paste-\\x73ingle\\n'", 'paste-single');
  await pasteCommand(page, "printf 'paste-line-1\\n'\nprintf 'paste-line-\\x32\\n'", 'paste-line-2');
  const bracketed = 'large-bracketed-' + 'x'.repeat(8_192);
  const bracketedHash = sha256(`${bracketed}\n`);
  await pasteCommand(page, `printf '%s\\n' '${bracketed}' | tee /tmp/paste-large.txt | sha256sum`, bracketedHash);
  await pasteCommand(page, "printf '\\344\\270\\255\\346\\226\\207\\350\\276\\223\\345\\205\\245-\\344\\270\\200\\346\\254\\241\\n'", '中文输入-一次');

  // Fast output and snapshot→stream handoff. The marker follows 256 KiB of
  // output and the checksum proves that the stream was not truncated.
  const burstHash = sha256('0123456789abcdef'.repeat(16_384));
  await page.evaluate(() => {
    const perf = window.__shellPerf;
    if (perf) { perf.longTasks = 0; perf.frames = 0; perf.frameStart = performance.now(); }
  });
  const burstCommand = `python3 -c "import hashlib,sys;d='0123456789abcdef'*16384;sys.stdout.write(d);sys.stdout.write('\\n'+hashlib.sha256(d.encode()).hexdigest()+'\\n')"`;
  // Use one browser input event for this long command so the test isolates
  // output backpressure rather than making the shell parse hundreds of
  // independent tmux send-keys processes.
  await page.keyboard.insertText(burstCommand);
  await page.keyboard.press('Enter');
  // Queue input while the PTY is still producing the burst; it must arrive in
  // order after the command completes.
  await page.keyboard.type("printf 'during-output-\\x6f\\x6b\\n'");
  await page.keyboard.press('Enter');
  await waitForTerminalText(page, burstHash, 30_000);
  await waitForTerminalText(page, 'during-output-ok', 30_000);
  await killRemoteTmux();
  await page.waitForTimeout(2_000);
  assert.ok(await page.locator('.terminal-container').first().count(), 'terminal must remain mounted after tmux kill/recovery');
  await page.locator('.terminal-container').first().click();
  await page.locator('.xterm-helper-textarea').focus().catch(() => {});
  await page.waitForTimeout(500);
  await typeCommand(page, "printf 'after-reconnect\\n'", 'after-reconnect', 90_000);

  // Navigation/control keys are exercised at the end so their escape
  // sequences cannot contaminate the checksum commands above.
  await page.keyboard.press('Control+R');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+L');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');

  // Exercise the on-screen key bar where the responsive shell exposes it.
  const keyBarButtons = page.locator('button[title="Ctrl+C"],button[title="Ctrl+B ×2"],button[title="Enter"],button[title="Tab"]');
  const keyBarCount = await keyBarButtons.count();
  for (let index = 0; index < keyBarCount; index += 1) await keyBarButtons.nth(index).click().catch(() => {});

  const copyUrl = `https://example.test/remote-desktop/${'x'.repeat(260)}`;
  const urlCopies = [];
  for (const columns of [80, 120, 200]) urlCopies.push(await copyUrlAtColumns(page, columns, copyUrl));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  urlCopies.push(await copyUrlAtColumns(page, 0, copyUrl));
  for (const result of urlCopies) assert.equal(result.exact, true, `wrapped URL copy must be exact at ${result.requestedCols || 'mobile'} columns`);

  const desktopScreenshot = process.env.IMC_PERF_SHELL_SCREENSHOT ?? '/tmp/shell-desktop.png';
  await page.screenshot({ path: desktopScreenshot });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobileScreenshot = process.env.IMC_PERF_SHELL_MOBILE_SCREENSHOT ?? '/tmp/shell-mobile.png';
  await page.screenshot({ path: mobileScreenshot });
  const metrics = await page.evaluate(() => {
    const perf = window.__shellPerf ?? {};
    const elapsed = Math.max(1, (performance.now() - (perf.frameStart ?? 0)) / 1000);
    return { firstPaintMs: perf.firstPaintMs, longTasks: perf.longTasks ?? 0, fps: (perf.frames ?? 0) / elapsed, frames: perf.frames ?? 0 };
  });
  assert.equal(metrics.longTasks, 0, 'shell output must not create long tasks');
  assert.ok(metrics.fps >= 50, `shell render FPS ${metrics.fps.toFixed(1)} is below 50`);
  await browser.close();
  return { firstPaintMs, recovery: 1, metrics, inputLatency, urlCopies, keyBarCount, desktopScreenshot, mobileScreenshot, checksums: { inputHash, bracketedHash, burstHash } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runShellBrowserScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
