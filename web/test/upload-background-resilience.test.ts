// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capacitorState = vi.hoisted(() => ({
  native: true,
  platform: 'android' as 'android' | 'ios' | 'web',
  startMock: vi.fn(async () => ({ started: true })),
  stopMock: vi.fn(async () => {}),
  registerPluginMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
  registerPlugin: (name: string) => {
    capacitorState.registerPluginMock(name);
    const impl = {
      start: (opts?: { title?: string; text?: string }) => capacitorState.startMock(opts),
      stop: () => capacitorState.stopMock(),
    };
    return new Proxy(impl, {
      get(target, prop, receiver) {
        if (prop === 'then') {
          throw new Error('Capacitor plugin Proxy .then() must not be probed');
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  },
}));

vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() } }));

class FakeXhr {
  static instances: FakeXhr[] = [];
  static handlers: Array<(xhr: FakeXhr) => void> = [];
  status = 200;
  responseText = '';
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  aborted = false;
  headers: Record<string, string> = {};
  constructor() {
    FakeXhr.instances.push(this);
  }
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send() {
    const idx = FakeXhr.instances.length - 1;
    const handler = FakeXhr.handlers[idx];
    if (handler) queueMicrotask(() => handler(this));
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  streamDone(attachmentId = 'a'.repeat(32)) {
    this.responseText = `${JSON.stringify({
      type: 'file.upload_done',
      uploadId: 'u1',
      ok: true,
      attachment: {
        id: attachmentId,
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/uploaded.bin',
        originalName: 'test.bin',
        size: 16,
        createdAt: '2026-11-15T00:00:00.000Z',
        downloadable: true,
      },
    })}\n`;
    this.status = 200;
    this.onprogress?.();
    this.onload?.();
  }
  streamChunkAck(committedBytes: number) {
    this.status = 202;
    this.responseText = JSON.stringify({ ok: true, complete: false, committedBytes });
    this.onload?.();
  }
}

function setDocumentVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('background transfer keepalive and cross-lifecycle HTTP resume', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    capacitorState.native = true;
    capacitorState.platform = 'android';
    capacitorState.startMock.mockClear();
    capacitorState.stopMock.mockClear();
    capacitorState.registerPluginMock.mockClear();
    FakeXhr.instances = [];
    FakeXhr.handlers = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => capacitorState.native,
      getPlatform: () => capacitorState.platform,
    });
    setDocumentVisibility('visible');
    const keepalive = await import('../src/background-transfer-keepalive.js');
    keepalive.resetBackgroundTransferKeepAliveForTests();
    const lifecycle = await import('../src/upload-suspend-wait.js');
    lifecycle.resetUploadLifecycleForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setDocumentVisibility('visible');
  });

  it('reference-counts native keepalive start/stop across concurrent Android & iOS transfers', async () => {
    const {
      acquireBackgroundTransferKeepAlive,
      flushBackgroundTransferKeepAliveForTests,
      getBackgroundTransferKeepAliveCount,
      setBackgroundTransferKeepAliveLabels,
    } = await import('../src/background-transfer-keepalive.js');

    setBackgroundTransferKeepAliveLabels({ title: 'Uploading', text: 'Active' });

    const r1 = acquireBackgroundTransferKeepAlive();
    const r2 = acquireBackgroundTransferKeepAlive();
    expect(getBackgroundTransferKeepAliveCount()).toBe(2);
    await flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.startMock).toHaveBeenCalledTimes(1);
    expect(capacitorState.startMock).toHaveBeenCalledWith({ title: 'Uploading', text: 'Active' });

    // Releasing r1 while r2 is active must not stop native service
    r1();
    r1(); // idempotent second release must not decrement again
    expect(getBackgroundTransferKeepAliveCount()).toBe(1);
    await flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.stopMock).not.toHaveBeenCalled();

    r2();
    expect(getBackgroundTransferKeepAliveCount()).toBe(0);
    await flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.stopMock).toHaveBeenCalledTimes(1);

    // Works on iOS as well
    capacitorState.platform = 'ios';
    const r3 = acquireBackgroundTransferKeepAlive();
    await flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.startMock).toHaveBeenCalledTimes(2);
    r3();
    await flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.stopMock).toHaveBeenCalledTimes(2);
  });

  it('survives 6 consecutive iOS background pauses where XHR error fires AFTER returning to foreground', async () => {
    const { uploadFile } = await import('../src/api.js');
    const { flushBackgroundTransferKeepAliveForTests } = await import('../src/background-transfer-keepalive.js');
    const { notifyUploadAppStateChange } = await import('../src/upload-suspend-wait.js');
    const file = new File([new Uint8Array(64)], 'ios-large.bin', { type: 'application/octet-stream' });
    const clientUploadId = '11111111-2222-4333-8444-666666666666';

    let attemptIndex = 0;
    FakeXhr.handlers = Array.from({ length: 7 }, (_, i) => (xhr: FakeXhr) => {
      attemptIndex = i + 1;
      if (i < 6) {
        // Simulate iOS WKWebView: user backgrounds app during active XHR, OS freezes JS,
        // user resumes foreground, and ONLY THEN does the dead socket fire onerror!
        setDocumentVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        notifyUploadAppStateChange(false);

        setDocumentVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        notifyUploadAppStateChange(true);

        xhr.status = 0;
        xhr.onerror?.();
      } else {
        xhr.streamDone();
      }
    });

    const promise = uploadFile('srv-1', file, undefined, clientUploadId);
    // Tick-0 contract: XHR #1 must be created synchronously before any microtask!
    expect(FakeXhr.instances).toHaveLength(1);

    // Drive timers for the 6 settle pauses (250ms each) without exhausting MAX_ATTEMPTS_WITHOUT_PROGRESS=4
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    const res = await promise;
    await flushBackgroundTransferKeepAliveForTests();
    expect(res.ok).toBe(true);
    expect(attemptIndex).toBe(7);
    expect(FakeXhr.instances).toHaveLength(7);
    // Keepalive acquired & cleanly released after success
    expect(capacitorState.startMock).toHaveBeenCalledTimes(1);
    expect(capacitorState.stopMock).toHaveBeenCalledTimes(1);
  });

  it('pauses retry loop while backgrounded and wakes immediately on foreground resume or AbortSignal', async () => {
    const { uploadFile } = await import('../src/api.js');
    const file = new File([new Uint8Array(32)], 'bg-pause.bin');
    const clientUploadId = '11111111-2222-4333-8444-777777777777';

    // Attempt 1 fails while app is already hidden
    FakeXhr.handlers = [
      (xhr) => {
        setDocumentVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        xhr.status = 0;
        xhr.onerror?.();
      },
      (xhr) => {
        xhr.streamDone();
      },
    ];

    const uploadPromise = uploadFile('srv-1', file, undefined, clientUploadId);
    // Wait while hidden: must NOT spawn attempt 2 while suspended
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeXhr.instances).toHaveLength(1);

    // Return to foreground -> wakes immediately and finishes attempt 2
    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);

    const res = await uploadPromise;
    expect(res.ok).toBe(true);
    expect(FakeXhr.instances).toHaveLength(2);

    // AbortSignal must cancel suspend wait immediately
    const ac = new AbortController();
    FakeXhr.handlers = [
      (xhr) => {
        setDocumentVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        xhr.status = 0;
        xhr.onerror?.();
      },
    ];
    FakeXhr.instances = [];
    const canceledPromise = uploadFile('srv-1', file, undefined, clientUploadId, ac.signal);
    await vi.advanceTimersByTimeAsync(50);
    ac.abort();
    await expect(canceledPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves concurrent resume waiters once on notifyUploadAppStateChange without Set re-add infinite loop and cleans up waiters on resume/abort/timeout', async () => {
    const {
      notifyUploadAppStateChange,
      waitForUploadResumeIfSuspended,
      getUploadResumeWaiterCountForTests,
    } = await import('../src/upload-suspend-wait.js');

    // Counterexample for Set delete+re-add infinite iteration during markResumed():
    // Wait while backgrounded via native appStateChange, then resume via notifyUploadAppStateChange(true).
    notifyUploadAppStateChange(false);
    let settled1 = 0;
    let settled2 = 0;
    const w1 = waitForUploadResumeIfSuspended(undefined, 60_000).then((res) => {
      settled1 += 1;
      return res;
    });
    const w2 = waitForUploadResumeIfSuspended(undefined, 60_000).then((res) => {
      settled2 += 1;
      return res;
    });
    expect(getUploadResumeWaiterCountForTests()).toBe(2);

    notifyUploadAppStateChange(true);
    await expect(w1).resolves.toBe(true);
    await expect(w2).resolves.toBe(true);
    expect(settled1).toBe(1);
    expect(settled2).toBe(1);
    expect(getUploadResumeWaiterCountForTests()).toBe(0);

    // Subsequent lifecycle transitions must not leave or re-invoke cleared waiters
    notifyUploadAppStateChange(false);
    notifyUploadAppStateChange(true);
    await Promise.resolve();
    expect(settled1).toBe(1);
    expect(settled2).toBe(1);
    expect(getUploadResumeWaiterCountForTests()).toBe(0);

    // Visibility-triggered foreground resume also removes waiter completely
    setDocumentVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const wVis = waitForUploadResumeIfSuspended(undefined, 60_000);
    expect(getUploadResumeWaiterCountForTests()).toBe(1);
    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(wVis).resolves.toBe(true);
    expect(getUploadResumeWaiterCountForTests()).toBe(0);

    // AbortSignal removes waiter cleanly
    const ac = new AbortController();
    notifyUploadAppStateChange(false);
    const wAbort = waitForUploadResumeIfSuspended(ac.signal, 60_000);
    expect(getUploadResumeWaiterCountForTests()).toBe(1);
    ac.abort();
    await expect(wAbort).rejects.toMatchObject({ name: 'AbortError' });
    expect(getUploadResumeWaiterCountForTests()).toBe(0);

    // Timeout removes waiter cleanly
    const wTimeout = waitForUploadResumeIfSuspended(undefined, 250);
    expect(getUploadResumeWaiterCountForTests()).toBe(1);
    await vi.advanceTimersByTimeAsync(260);
    await expect(wTimeout).resolves.toBe(true);
    expect(getUploadResumeWaiterCountForTests()).toBe(0);
  });

  it('skips FileTransferKeepAlive plugin registration on web and reconciles sync/in-flight/async release races on native without leaking start', async () => {
    const keepalive = await import('../src/background-transfer-keepalive.js');
    keepalive.resetBackgroundTransferKeepAliveForTests();
    capacitorState.registerPluginMock.mockClear();

    capacitorState.native = false;
    capacitorState.platform = 'web';
    keepalive.setBackgroundTransferKeepAliveLabels({ title: 'Uploading', text: 'Web' });
    const webRelease = keepalive.acquireBackgroundTransferKeepAlive();
    webRelease();
    await keepalive.withBackgroundTransferKeepAlive(async () => 'web-ok');
    await keepalive.flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.registerPluginMock).not.toHaveBeenCalled();
    expect(capacitorState.startMock).not.toHaveBeenCalled();
    expect(capacitorState.stopMock).not.toHaveBeenCalled();

    // 1) Immediate same-tick release or synchronous throw must never leave native service started
    capacitorState.native = true;
    capacitorState.platform = 'android';
    const syncRelease = keepalive.acquireBackgroundTransferKeepAlive();
    syncRelease();
    expect(() => keepalive.withBackgroundTransferKeepAlive(() => {
      throw new Error('sync-boom');
    })).toThrow('sync-boom');
    await keepalive.flushBackgroundTransferKeepAliveForTests();
    expect(keepalive.getBackgroundTransferKeepAliveCount()).toBe(0);
    expect(capacitorState.startMock).not.toHaveBeenCalled();
    expect(capacitorState.stopMock).not.toHaveBeenCalled();

    // 2) Async error after keepalive starts cleanly stops native service once
    await expect(keepalive.withBackgroundTransferKeepAlive(async () => {
      await keepalive.flushBackgroundTransferKeepAliveForTests();
      throw new Error('async-boom');
    })).rejects.toThrow('async-boom');
    await keepalive.flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.registerPluginMock).toHaveBeenCalledTimes(1);
    expect(capacitorState.startMock).toHaveBeenCalledTimes(1);
    expect(capacitorState.stopMock).toHaveBeenCalledTimes(1);
    expect(keepalive.getBackgroundTransferKeepAliveCount()).toBe(0);

    // 3) Release while plugin.start() is still in-flight must immediately stop once start() settles
    let resolveStart: ((v: { started: boolean }) => void) | null = null;
    let markStartEntered: (() => void) | null = null;
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve; });
    capacitorState.startMock.mockImplementationOnce(() => {
      markStartEntered?.();
      return new Promise<{ started: boolean }>((resolve) => { resolveStart = resolve; });
    });
    const inFlightRelease = keepalive.acquireBackgroundTransferKeepAlive();
    await startEntered;
    expect(capacitorState.startMock).toHaveBeenCalledTimes(2);
    inFlightRelease();
    expect(keepalive.getBackgroundTransferKeepAliveCount()).toBe(0);
    resolveStart?.({ started: true });
    await keepalive.flushBackgroundTransferKeepAliveForTests();
    expect(capacitorState.stopMock).toHaveBeenCalledTimes(2);
  });
});
