/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnlyOfficeStatusResponse } from '../src/api.js';
import {
  loadOnlyOfficeScript,
  prewarmOnlyOfficeComponents,
  resetOnlyOfficePrewarm,
  scheduleOnlyOfficePrewarm,
} from '../src/onlyoffice-preload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const apiMockState = vi.hoisted(() => ({
  fetchOnlyOfficeStatus: vi.fn<() => Promise<OnlyOfficeStatusResponse>>(),
}));

vi.mock('../src/api.js', () => ({
  fetchOnlyOfficeStatus: apiMockState.fetchOnlyOfficeStatus,
}));

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('onlyoffice-preload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOnlyOfficePrewarm({ clearScriptCache: true, removeDomNodes: true });
    delete (window as unknown as { DocsAPI?: unknown }).DocsAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetOnlyOfficePrewarm({ clearScriptCache: true, removeDomNodes: true });
    delete (window as unknown as { DocsAPI?: unknown }).DocsAPI;
  });

  it('prewarms preconnect link, api.js script, and hidden aria-hidden preload iframe idempotently once DocsAPI initializes', async () => {
    const scriptUrl = 'https://docs.example.com/onlyoffice/web-apps/apps/api/documents/api.js';
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({
      enabled: true,
      publicUrl: 'https://docs.example.com/onlyoffice',
      scriptUrl,
    });

    const p1 = prewarmOnlyOfficeComponents();
    const p2 = prewarmOnlyOfficeComponents();
    await tick();

    const script = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(script).not.toBeNull();
    expect(script?.src).toBe(scriptUrl);

    // Concurrent direct loadOnlyOfficeScript shares the same in-flight script tag
    const concurrentLoad = loadOnlyOfficeScript(scriptUrl);
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(1);

    // Simulate real api.js initialization before onload fires
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: class {} };
    script?.onload?.(new Event('load'));
    await Promise.all([p1, p2, concurrentLoad]);

    // Triggering again after valid settlement must not duplicate DOM nodes or re-fetch status
    await prewarmOnlyOfficeComponents();
    await loadOnlyOfficeScript(scriptUrl);

    expect(apiMockState.fetchOnlyOfficeStatus).toHaveBeenCalledTimes(1);

    const preconnectLinks = document.querySelectorAll('link[data-onlyoffice-preconnect]');
    expect(preconnectLinks).toHaveLength(1);
    expect((preconnectLinks[0] as HTMLLinkElement).rel).toBe('preconnect');
    expect((preconnectLinks[0] as HTMLLinkElement).href).toBe('https://docs.example.com/');

    const scripts = document.querySelectorAll('script[data-onlyoffice-src]');
    expect(scripts).toHaveLength(1);

    const iframes = document.querySelectorAll('iframe[data-onlyoffice-preload]');
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0] as HTMLIFrameElement;
    expect(iframe.src).toBe('https://docs.example.com/onlyoffice/web-apps/apps/api/documents/preload.html');
    expect(iframe.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.tabIndex).toBe(-1);
    expect(iframe.style.display).toBe('none');
  });

  it('skips DOM injection cleanly when ONLYOFFICE is disabled', async () => {
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({ enabled: false });

    await prewarmOnlyOfficeComponents();
    await prewarmOnlyOfficeComponents();

    expect(apiMockState.fetchOnlyOfficeStatus).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('link[data-onlyoffice-preconnect]')).toHaveLength(0);
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);
  });

  it('evicts onload-without-DocsAPI and network-onerror failures so later OfficePreview / loadOnlyOfficeScript retries recover cleanly', async () => {
    // 1. Status network error stays silent and allows later retry
    apiMockState.fetchOnlyOfficeStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(prewarmOnlyOfficeComponents()).resolves.toBeUndefined();
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);

    // 2. Status returns enabled, script fires onload WITHOUT initializing window.DocsAPI.DocEditor (e.g. blank 200 HTML/truncated bundle)
    const scriptUrl = 'https://docs.example.com/onlyoffice/web-apps/apps/api/documents/api.js';
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({
      enabled: true,
      publicUrl: 'https://docs.example.com/onlyoffice',
      scriptUrl,
    });

    const pBadOnload = prewarmOnlyOfficeComponents();
    await tick();
    const uninitializedScript = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(uninitializedScript).not.toBeNull();
    uninitializedScript?.onload?.(new Event('load'));
    await expect(pBadOnload).resolves.toBeUndefined();

    // Must not mount preload iframe or poison script cache
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);

    // 3. Direct retry sees a fresh <script> tag; simulate onerror first, then full recovery
    const errorRetry = loadOnlyOfficeScript(scriptUrl);
    const failedTag = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(failedTag).not.toBeNull();
    expect(failedTag).not.toBe(uninitializedScript);
    failedTag?.onerror?.(new Event('error'));
    await expect(errorRetry).rejects.toThrow('Failed to load ONLYOFFICE API script');
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);

    // 4. Subsequent retry initializes DocsAPI.DocEditor and succeeds
    const recoveredRetry = loadOnlyOfficeScript(scriptUrl);
    const recoveredTag = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(recoveredTag).not.toBeNull();
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: class {} };
    recoveredTag?.onload?.(new Event('load'));
    await expect(recoveredRetry).resolves.toBeUndefined();
  });

  it('isolates backend/URL switches across resetOnlyOfficePrewarm and direct URL changes, ignoring stale generations', async () => {
    const publicA = 'https://office-a.example/onlyoffice';
    const urlA = `${publicA}/web-apps/apps/api/documents/api.js`;
    const publicB = 'https://office-b.example/onlyoffice';
    const urlB = `${publicB}/web-apps/apps/api/documents/api.js`;
    const publicC = 'https://office-c.example/onlyoffice';
    const urlC = `${publicC}/web-apps/apps/api/documents/api.js`;

    // 1. Backend A prewarms and initializes DocEditorA
    const DocEditorA = class {};
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValueOnce({
      enabled: true,
      publicUrl: publicA,
      scriptUrl: urlA,
    });
    const warmA = prewarmOnlyOfficeComponents();
    await tick();
    const scriptA = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptA?.dataset.onlyofficeSrc).toBe(urlA);
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: DocEditorA };
    scriptA?.onload?.(new Event('load'));
    await warmA;

    // 2. Auth/backend switch resets prewarm -> Backend B MUST load script B even though window.DocsAPI existed from A
    resetOnlyOfficePrewarm();
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);

    const DocEditorB = class {};
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValueOnce({
      enabled: true,
      publicUrl: publicB,
      scriptUrl: urlB,
    });
    const warmB = prewarmOnlyOfficeComponents();
    await tick();
    const scriptB = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptB?.dataset.onlyofficeSrc).toBe(urlB);
    expect((window as unknown as { DocsAPI?: unknown }).DocsAPI).toBeUndefined();

    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: DocEditorB };
    scriptB?.onload?.(new Event('load'));
    await warmB;

    const iframeB = document.querySelector('iframe[data-onlyoffice-preload]') as HTMLIFrameElement | null;
    expect(iframeB?.src).toBe(`${publicB}/web-apps/apps/api/documents/preload.html`);

    // 3. Switching directly to URL C without reset also forces loading script C instead of reusing DocEditorB
    const DocEditorC = class {};
    const loadC = loadOnlyOfficeScript(urlC);
    const scriptC = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptC?.dataset.onlyofficeSrc).toBe(urlC);
    // If C fires onload without setting DocsAPI, it must reject instead of keeping DocEditorB
    scriptC?.onload?.(new Event('load'));
    await expect(loadC).rejects.toThrow('ONLYOFFICE API script loaded without DocsAPI.DocEditor');

    const retryC = loadOnlyOfficeScript(urlC);
    const scriptCRetry = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: DocEditorC };
    scriptCRetry?.onload?.(new Event('load'));
    await expect(retryC).resolves.toBeUndefined();

    // 4. Stale in-flight generation from A resolving late after reset cannot overwrite B's cache/DOM
    resetOnlyOfficePrewarm();
    delete (window as unknown as { DocsAPI?: unknown }).DocsAPI;
    let resolveLateStatus!: (v: OnlyOfficeStatusResponse) => void;
    apiMockState.fetchOnlyOfficeStatus.mockReturnValueOnce(
      new Promise<OnlyOfficeStatusResponse>((r) => {
        resolveLateStatus = r;
      }),
    );
    const lateWarm = prewarmOnlyOfficeComponents();
    resetOnlyOfficePrewarm();
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValueOnce({
      enabled: true,
      publicUrl: publicB,
      scriptUrl: urlB,
    });
    const currentWarm = prewarmOnlyOfficeComponents();
    await tick();

    // Resolve stale epoch AFTER newer epoch already started
    resolveLateStatus({ enabled: true, publicUrl: publicA, scriptUrl: urlA });
    await tick();

    const activeScript = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(activeScript?.dataset.onlyofficeSrc).toBe(urlB);
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: class {} };
    activeScript?.onload?.(new Event('load'));
    await Promise.all([lateWarm, currentWarm]);

    const finalFrames = document.querySelectorAll('iframe[data-onlyoffice-preload]');
    expect(finalFrames).toHaveLength(1);
    expect((finalFrames[0] as HTMLIFrameElement).src).toBe(`${publicB}/web-apps/apps/api/documents/preload.html`);
  });

  it('repairs and isolates late-executing stale script globals across success, blank-200 failure, and same-URL retry (F2 R2)', async () => {
    const urlA = 'https://office-a.example/onlyoffice/web-apps/apps/api/documents/api.js';
    const urlB = 'https://office-b.example/onlyoffice/web-apps/apps/api/documents/api.js';

    // Timing 1: A in-flight -> reset -> B succeeds -> A executes late overwriting window.DocsAPI -> B remains authoritative without extra request
    const EditorA1 = class EditorA1 {};
    const EditorB1 = class EditorB1 {};
    const loadA1 = loadOnlyOfficeScript(urlA);
    const scriptA1 = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptA1?.dataset.onlyofficeSrc).toBe(urlA);

    resetOnlyOfficePrewarm();
    const loadB1 = loadOnlyOfficeScript(urlB);
    const scriptB1 = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptB1?.dataset.onlyofficeSrc).toBe(urlB);

    const docsApiB1 = { DocEditor: EditorB1 };
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = docsApiB1;
    scriptB1?.onload?.(new Event('load'));
    await expect(loadB1).resolves.toBeUndefined();

    // Late A1 executes after B1 already resolved
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: EditorA1 };
    scriptA1?.onload?.(new Event('load'));
    await expect(loadA1).rejects.toThrow('Stale ONLYOFFICE API script load superseded');
    expect(window.DocsAPI?.DocEditor).toBe(EditorB1);

    // Even if window.DocsAPI is later corrupted before a same-generation loadOnlyOfficeScript(urlB), cached binding heals without adding another script tag
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: EditorA1 };
    await expect(loadOnlyOfficeScript(urlB)).resolves.toBeUndefined();
    expect(window.DocsAPI?.DocEditor).toBe(EditorB1);
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(1);

    // Timing 2: A in-flight -> reset -> B in-flight -> A executes late -> B finishes with blank 200 (no DocsAPI write) -> B must reject and allow retry
    resetOnlyOfficePrewarm();
    const EditorA2 = class EditorA2 {};
    const EditorB2 = class EditorB2 {};
    const loadA2 = loadOnlyOfficeScript(urlA);
    const scriptA2 = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;

    resetOnlyOfficePrewarm();
    const loadB2 = loadOnlyOfficeScript(urlB);
    const scriptB2 = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptB2?.dataset.onlyofficeSrc).toBe(urlB);

    // A2 executes while B2 is still pending
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: EditorA2 };
    scriptA2?.onload?.(new Event('load'));
    await expect(loadA2).rejects.toThrow('Stale ONLYOFFICE API script load superseded');
    expect((window as unknown as { DocsAPI?: unknown }).DocsAPI).toBeUndefined();

    // B2 responds blank without setting window.DocsAPI
    scriptB2?.onload?.(new Event('load'));
    await expect(loadB2).rejects.toThrow('ONLYOFFICE API script loaded without DocsAPI.DocEditor');

    // Retry for B loads a fresh script and succeeds with EditorB2
    const retryB2 = loadOnlyOfficeScript(urlB);
    const retryScriptB2 = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(retryScriptB2).not.toBe(scriptB2);
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: EditorB2 };
    retryScriptB2?.onload?.(new Event('load'));
    await expect(retryB2).resolves.toBeUndefined();
    expect(window.DocsAPI?.DocEditor).toBe(EditorB2);

    // Timing 3: Pre-existing unverified global DocsAPI must NOT bypass loadOnlyOfficeScript
    resetOnlyOfficePrewarm();
    const UntrustedEditor = class UntrustedEditor {};
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: UntrustedEditor };
    const loadUntrusted = loadOnlyOfficeScript(urlB);
    const scriptUntrusted = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(scriptUntrusted).not.toBeNull();
    expect((window as unknown as { DocsAPI?: unknown }).DocsAPI).toBeUndefined();
    scriptUntrusted?.onload?.(new Event('load'));
    await expect(loadUntrusted).rejects.toThrow('ONLYOFFICE API script loaded without DocsAPI.DocEditor');

    // Timing 4: Same-URL reset followed by stale onerror must not clear the active second-generation load record
    resetOnlyOfficePrewarm();
    const sameUrlFirst = loadOnlyOfficeScript(urlA);
    const firstTag = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    resetOnlyOfficePrewarm();
    const sameUrlSecond = loadOnlyOfficeScript(urlA);
    const secondTag = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(secondTag).not.toBe(firstTag);

    firstTag?.onerror?.(new Event('error'));
    await expect(sameUrlFirst).rejects.toThrow('Failed to load ONLYOFFICE API script');

    // Concurrent call during second generation still deduplicates onto secondTag instead of starting a third load
    const sameUrlSecondConcurrent = loadOnlyOfficeScript(urlA);
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(1);
    const EditorA3 = class EditorA3 {};
    (window as unknown as { DocsAPI: { DocEditor: unknown } }).DocsAPI = { DocEditor: EditorA3 };
    secondTag?.onload?.(new Event('load'));
    await Promise.all([sameUrlSecond, sameUrlSecondConcurrent]);
    expect(window.DocsAPI?.DocEditor).toBe(EditorA3);
  });

  it('supports deferred scheduling and cancellation on logout before idle trigger', async () => {
    vi.useFakeTimers();
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({ enabled: false });

    const cancel = scheduleOnlyOfficePrewarm();
    cancel();
    await vi.runAllTimersAsync();
    expect(apiMockState.fetchOnlyOfficeStatus).not.toHaveBeenCalled();

    scheduleOnlyOfficePrewarm();
    await vi.runAllTimersAsync();
    expect(apiMockState.fetchOnlyOfficeStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps lightweight bundle separation away from OfficePreview and local fallback parsers', () => {
    const preloadSource = readFileSync(resolve(__dirname, '../src/onlyoffice-preload.ts'), 'utf8');
    expect(preloadSource).not.toMatch(/from\s+['"][^'"]*(?:OfficePreview|pdfjs-dist|docx-preview|xlsx)/);
    expect(preloadSource).not.toMatch(/import\s*\([^)]*(?:OfficePreview|pdfjs-dist|docx-preview|xlsx)/);

    const cloudDocsSource = readFileSync(resolve(__dirname, '../src/components/CloudDocsPanel.tsx'), 'utf8');
    expect(cloudDocsSource).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\/OfficePreview\.js['"]\)\)/);
    expect(cloudDocsSource).toContain("from '../onlyoffice-preload.js'");

    const fileBrowserSource = readFileSync(resolve(__dirname, '../src/components/FileBrowser.tsx'), 'utf8');
    expect(fileBrowserSource).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\/OfficePreview\.js['"]\)\)/);
    expect(fileBrowserSource).toContain("from '../onlyoffice-preload.js'");

    const officePreviewSource = readFileSync(resolve(__dirname, '../src/components/OfficePreview.tsx'), 'utf8');
    expect(officePreviewSource).toContain("from '../onlyoffice-preload.js'");
    expect(officePreviewSource).toContain('export { loadOnlyOfficeScript }');
  });
});
