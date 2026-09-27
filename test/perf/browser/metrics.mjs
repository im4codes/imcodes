const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};

export async function installObservers(page) {
  await page.addInitScript(() => {
    const state = { longTasks: [], inputDelays: [], scriptedInputDelays: [], scriptedInputTimes: [], frames: 0, droppedFrames: 0, lastFrame: performance.now(), timelineEvents: 0, eventCountByType: {}, timerDrift: [], ws: { sent: 0, received: 0, bytesSent: 0, byType: {}, byMode: {}, expectedHiddenFullBytes: 0, hiddenSummaryBytes: 0 } };
    window.__manyWindowsMetrics = state;
    try {
      new PerformanceObserver((list) => state.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
    } catch { /* Chromium without longtask support: the summary records zero. */ }
    try {
      new PerformanceObserver((list) => state.inputDelays.push(...list.getEntries().map((entry) => Math.max(0, entry.processingStart - entry.startTime)))).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch { /* Event Timing is optional. */ }
    const frame = (now) => {
      const gap = now - state.lastFrame;
      state.frames += 1;
      if (gap > 34) state.droppedFrames += Math.max(0, Math.round(gap / 16.67) - 1);
      state.lastFrame = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const timerStarted = performance.now();
    let timerTicks = 0;
    const timerTick = () => {
      timerTicks += 1;
      const expected = timerStarted + timerTicks * 1_000;
      state.timerDrift.push({ at: performance.now(), driftMs: performance.now() - expected });
      if (state.timerDrift.length > 120) state.timerDrift.shift();
      setTimeout(timerTick, 1_000);
    };
    setTimeout(timerTick, 1_000);
    const originalDispatchEvent = WebSocket.prototype.dispatchEvent;
    WebSocket.prototype.dispatchEvent = function(event) {
      if (event?.type === 'message') {
        try {
          const parsed = JSON.parse(event.data);
          const type = parsed?.event?.type ?? parsed?.type ?? 'unknown';
          state.eventCountByType[type] = (state.eventCountByType[type] ?? 0) + 1;
          if (type === 'timeline.event') state.timelineEvents += 1;
        } catch {}
      }
      return originalDispatchEvent.call(this, event);
    };
    window.__startPerfInput = () => {
      const target = document.querySelector('textarea, input, button') ?? document.body;
      const tick = () => {
        const started = performance.now();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        requestAnimationFrame(() => state.scriptedInputDelays.push(performance.now() - started));
      };
      state.inputTimer = setInterval(tick, 250);
      tick();
    };
  });
}

export async function collectMetrics(page) {
  const browser = await page.evaluate(() => ({ ...window.__manyWindowsMetrics, heap: (performance.memory?.usedJSHeapSize ?? 0), bufferedAmount: [...(window.__perfBufferedSamples ?? [])] }));
  let heap = browser.heap;
  try {
    const session = await page.context().newCDPSession(page);
    const usage = await session.send('Runtime.getHeapUsage');
    heap = usage.usedSize;
    await session.detach();
  } catch { /* Firefox/WebKit or restricted CDP. */ }
  return {
    longTask: { p50: percentile(browser.longTasks, 0.5), p95: percentile(browser.longTasks, 0.95), max: Math.max(0, ...browser.longTasks) },
    inputDelay: { p95: percentile([...browser.inputDelays, ...browser.scriptedInputDelays], 0.95) },
    bufferedAmount: { p95: percentile(browser.bufferedAmount, 0.95), max: Math.max(0, ...browser.bufferedAmount) },
    fps: { frames: browser.frames, dropped: browser.droppedFrames },
    probe: { timelineEvents: browser.timelineEvents ?? 0, eventCountByType: browser.eventCountByType ?? {}, timerDrift: browser.timerDrift ?? [] },
    ws: browser.ws,
    heapBytes: heap,
  };
}

export function aggregate(metrics) {
  const longTasks = metrics.map((item) => item.longTask).filter(Boolean);
  const input = metrics.map((item) => item.inputDelay?.p95 ?? 0);
  const heap = metrics.map((item) => item.heapBytes ?? 0);
  return {
    longTask: { p50: percentile(longTasks.map((x) => x.p50), 0.5), p95: percentile(longTasks.map((x) => x.p95), 0.95), max: Math.max(0, ...longTasks.map((x) => x.max)) },
    inputDelay: { p95: percentile(input, 0.95) },
    heapBytes: { first: heap[0] ?? 0, last: heap.at(-1) ?? 0, delta: (heap.at(-1) ?? 0) - (heap[0] ?? 0) },
    fps: { frames: metrics.reduce((sum, x) => sum + (x.fps?.frames ?? 0), 0), dropped: metrics.reduce((sum, x) => sum + (x.fps?.dropped ?? 0), 0) },
    probe: { timelineEvents: metrics.reduce((sum, x) => sum + (x.probe?.timelineEvents ?? 0), 0), eventCountByType: metrics.reduce((sum, x) => { for (const [type, count] of Object.entries(x.probe?.eventCountByType ?? {})) sum[type] = (sum[type] ?? 0) + count; return sum; }, {}), timerDrift: metrics.flatMap((x) => x.probe?.timerDrift ?? []) },
    ws: metrics.reduce((sum, x) => {
      for (const [type, bytes] of Object.entries(x.ws.byType ?? {})) sum.byType[type] = (sum.byType[type] ?? 0) + bytes;
      for (const [type, count] of Object.entries(x.ws.framesByType ?? {})) sum.framesByType[type] = (sum.framesByType[type] ?? 0) + count;
      if (sum.seqGaps.length < 20) sum.seqGaps.push(...(x.ws.seqGaps ?? []).slice(0, 20 - sum.seqGaps.length));
      sum.historyTimings.push(...(x.ws.historyTimings ?? []));
      for (const [requestId, socket] of Object.entries(x.ws.sockets ?? {})) {
        const out = sum.sockets[requestId] ??= { requestId, sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {} };
        out.sent += socket.sent; out.received += socket.received;
        out.bytesSent += socket.bytesSent; out.bytesReceived += socket.bytesReceived;
        for (const [type, bytes] of Object.entries(socket.byType ?? {})) out.byType[type] = (out.byType[type] ?? 0) + bytes;
      }
      for (const [mode, bytes] of Object.entries(x.ws.byMode ?? {})) sum.byMode[mode] = (sum.byMode[mode] ?? 0) + bytes;
      Object.assign(sum.finalSessions, x.ws.finalSessions ?? {});
      sum.sent += x.ws.sent; sum.received += x.ws.received; sum.bytesSent += x.ws.bytesSent; sum.bytesReceived += x.ws.bytesReceived;
      sum.bufferedAmount.p95 = Math.max(sum.bufferedAmount.p95, x.bufferedAmount?.p95 ?? 0);
      sum.bufferedAmount.max = Math.max(sum.bufferedAmount.max, x.bufferedAmount?.max ?? 0);
      sum.expectedHiddenFullBytes += x.ws.expectedHiddenFullBytes ?? 0; sum.hiddenSummaryBytes += x.ws.hiddenSummaryBytes ?? 0;
      return sum;
    }, { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, seqGaps: [], historyTimings: [], sockets: {}, byMode: {}, finalSessions: {}, bufferedAmount: { p95: 0, max: 0 }, expectedHiddenFullBytes: 0, hiddenSummaryBytes: 0 }),
  };
}
