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

  it('prewarms preconnect link, api.js script, and hidden aria-hidden preload iframe idempotently', async () => {
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({
      enabled: true,
      publicUrl: 'https://docs.example.com/onlyoffice',
      scriptUrl: 'https://docs.example.com/onlyoffice/web-apps/apps/api/documents/api.js',
    });

    const p1 = prewarmOnlyOfficeComponents();
    const p2 = prewarmOnlyOfficeComponents();

    await Promise.resolve();
    await Promise.resolve();

    const script = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(script).not.toBeNull();
    expect(script?.src).toBe('https://docs.example.com/onlyoffice/web-apps/apps/api/documents/api.js');

    // Simulate api.js finishing load
    script?.onload?.(new Event('load'));
    await Promise.all([p1, p2]);

    // Triggering again after settlement must not duplicate DOM nodes or re-fetch status
    await prewarmOnlyOfficeComponents();

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

  it('fails silently on status error or script load error without poisoning later OfficePreview retries', async () => {
    // 1. Status network error stays silent and allows later retry
    apiMockState.fetchOnlyOfficeStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(prewarmOnlyOfficeComponents()).resolves.toBeUndefined();
    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);

    // 2. Status recovers, api.js fails to load -> silent failure, no preload iframe, script cache cleared for real retry
    const scriptUrl = 'https://docs.example.com/onlyoffice/web-apps/apps/api/documents/api.js';
    apiMockState.fetchOnlyOfficeStatus.mockResolvedValue({
      enabled: true,
      publicUrl: 'https://docs.example.com/onlyoffice',
      scriptUrl,
    });

    const p = prewarmOnlyOfficeComponents();
    await Promise.resolve();
    await Promise.resolve();
    const failedScript = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(failedScript).not.toBeNull();
    failedScript?.onerror?.(new Event('error'));
    await expect(p).resolves.toBeUndefined();

    expect(document.querySelectorAll('script[data-onlyoffice-src]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe[data-onlyoffice-preload]')).toHaveLength(0);

    // 3. Subsequent direct loadOnlyOfficeScript() retry (as used by OfficePreview) starts fresh and succeeds
    const retryPromise = loadOnlyOfficeScript(scriptUrl);
    const retryScript = document.querySelector('script[data-onlyoffice-src]') as HTMLScriptElement | null;
    expect(retryScript).not.toBeNull();
    retryScript?.onload?.(new Event('load'));
    await expect(retryPromise).resolves.toBeUndefined();
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
