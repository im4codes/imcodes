// @vitest-environment jsdom
/**
 * The relay upload reaches 100% only when the server streams `file.upload_done`,
 * which it writes after the daemon committed the file. The tail of that stream
 * can still be lost (a gateway cutting the response, a stall while closing), and
 * the committed upload must then still resolve as a success. The reverse cases
 * (no done line) must keep failing so an incomplete upload is never reported
 * as finished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() } }));

const ATTACHMENT = {
  id: 'a'.repeat(32),
  source: 'upload',
  serverId: 'srv-1',
  daemonPath: '/home/u/.imcodes/uploads/aaaa/file.png',
  originalName: 'file.png',
  size: 5,
  createdAt: '2026-10-06T00:00:00.000Z',
  downloadable: true,
};
const DONE_LINE = `${JSON.stringify({ type: 'file.upload_done', uploadId: 'u1', ok: true, attachment: ATTACHMENT })}\n`;
const PROGRESS_LINE = `${JSON.stringify({ type: 'file.upload_progress', uploadId: 'u1', loaded: 3, total: 5 })}\n`;
const ERROR_LINE = `${JSON.stringify({ type: 'file.upload_error', uploadId: 'u1', error: 'upload_failed' })}\n`;

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 200;
  responseText = '';
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  aborted = false;
  constructor() { FakeXhr.instances.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() { this.aborted = true; this.onabort?.(); }
  /** Server wrote `text` onto the streaming response. */
  stream(text: string) {
    this.responseText += text;
    this.onprogress?.();
  }
}

function makeFile(): File {
  return new File(['hello'], 'file.png', { type: 'image/png', lastModified: 1 });
}

describe('relay upload settles from a committed payload', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startUpload(options: { withClientUploadId: boolean; signal?: AbortSignal }) {
    const { uploadFile } = await import('../src/api.js');
    const progress: number[] = [];
    const promise = uploadFile(
      'srv-1',
      makeFile(),
      (pct) => progress.push(pct),
      options.withClientUploadId ? '11111111-2222-4333-8444-555555555555' : undefined,
      options.signal,
    );
    // Let uploadFile reach xhr.send().
    await Promise.resolve();
    const xhr = FakeXhr.instances.at(-1)!;
    return { promise, xhr, progress };
  }

  it('resolves when the connection errors right after file.upload_done (100% already shown)', async () => {
    const { promise, xhr, progress } = await startUpload({ withClientUploadId: false });
    xhr.stream(PROGRESS_LINE);
    xhr.stream(DONE_LINE);
    expect(progress.at(-1)).toBe(100);
    xhr.onerror?.();
    await expect(promise).resolves.toMatchObject({ ok: true, attachment: { id: ATTACHMENT.id } });
  });

  it('does not re-upload the final chunk (no retry loop) when committed evidence exists', async () => {
    const { promise, xhr } = await startUpload({ withClientUploadId: true });
    xhr.stream(DONE_LINE);
    xhr.onerror?.();
    await expect(promise).resolves.toMatchObject({ attachment: { id: ATTACHMENT.id } });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it('resolves when the stream stalls while closing after file.upload_done', async () => {
    vi.useFakeTimers();
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.stream(DONE_LINE);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toMatchObject({ attachment: { id: ATTACHMENT.id } });
    expect(xhr.aborted).toBe(true);
  });

  it('counts a final done line that arrived without a trailing newline', async () => {
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.responseText += DONE_LINE.trimEnd();
    xhr.onerror?.();
    await expect(promise).resolves.toMatchObject({ attachment: { id: ATTACHMENT.id } });
  });

  it('prefers the committed payload over a stray error line on a completed response', async () => {
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.stream(DONE_LINE);
    xhr.stream(ERROR_LINE);
    xhr.onload?.();
    await expect(promise).resolves.toMatchObject({ attachment: { id: ATTACHMENT.id } });
  });

  it('keeps a user cancel a cancel even after the done line', async () => {
    const controller = new AbortController();
    const { promise, xhr } = await startUpload({ withClientUploadId: false, signal: controller.signal });
    xhr.stream(DONE_LINE);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('holds progress below 100 until the daemon commits (pull complete is not committed)', async () => {
    const { promise, xhr, progress } = await startUpload({ withClientUploadId: false });
    xhr.stream(`${JSON.stringify({ type: 'file.upload_progress', uploadId: 'u1', loaded: 5, total: 5 })}\n`);
    expect(progress.at(-1)).toBe(99);
    expect(progress).not.toContain(100);
    xhr.stream(DONE_LINE);
    expect(progress.at(-1)).toBe(100);
    xhr.onload?.();
    await promise;
  });

  it('recovers a lost file.upload_done by re-sending the final chunk, then succeeds', async () => {
    // The daemon pulled and committed the file but `file.upload_done` never
    // reached the browser (link flap). The stall retries the last chunk; the
    // server/daemon answer from the committed upload.
    vi.useFakeTimers();
    const { promise, xhr, progress } = await startUpload({ withClientUploadId: true });
    xhr.stream(`${JSON.stringify({ type: 'file.upload_progress', uploadId: 'u1', loaded: 5, total: 5 })}\n`);
    expect(progress.at(-1)).toBe(99);
    await vi.advanceTimersByTimeAsync(25_000); // stall timer -> upload_stalled -> backoff -> retry
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeXhr.instances.length).toBe(2);
    const retry = FakeXhr.instances[1]!;
    retry.stream(DONE_LINE);
    retry.onload?.();
    await expect(promise).resolves.toMatchObject({ attachment: { id: ATTACHMENT.id } });
    expect(progress.at(-1)).toBe(100);
  });

  // Reverse cases: without committed evidence the upload must still fail.
  it('still rejects a connection error with no done line', async () => {
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.stream(PROGRESS_LINE);
    xhr.onerror?.();
    await expect(promise).rejects.toMatchObject({ status: 0 });
  });

  it('still rejects a stall with no done line', async () => {
    vi.useFakeTimers();
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.stream(PROGRESS_LINE);
    const settled = expect(promise).rejects.toMatchObject({ status: 0, message: expect.stringContaining('upload_stalled') });
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('still rejects an error line with no done line on a completed response', async () => {
    const { promise, xhr } = await startUpload({ withClientUploadId: false });
    xhr.stream(PROGRESS_LINE);
    xhr.stream(ERROR_LINE);
    xhr.onload?.();
    await expect(promise).rejects.toMatchObject({ status: 500, body: 'upload_failed' });
  });
});
