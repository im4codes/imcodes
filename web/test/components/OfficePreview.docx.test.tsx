/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

import OfficePreview from '../../src/components/OfficePreview.js';
import { MINIMAL_DOCX_MIME as DOCX_MIME, MINIMAL_DOCX_TEXT as DOC_TEXT, buildMinimalDocx } from '../fixtures/minimal-docx.js';

// tsk_5rf. 6a169ad3c switched Office previews from an inlined base64 string to
// an ArrayBuffer fetched from the chunked download URL, and users reported a
// blank Word preview. The existing OfficePreview suite stubs fetch and covers
// only PDF and XLSX, so the wordprocessingml path had NO coverage at all.
// This drives a REAL minimal .docx through the REAL docx-preview renderer and
// asserts the document text actually reaches the DOM - not merely that a fetch
// happened or that previewMode was 'stream'.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OfficePreview docx over the chunked download URL (tsk_5rf)', () => {
  it('renders real Word document text fetched as an ArrayBuffer', async () => {
    const bytes = await buildMinimalDocx();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <OfficePreview srcUrl="https://host/api/server/s1/uploads/dl-1/download" mimeType={DOCX_MIME} path="/repo/doc.docx" />,
    );

    // The document text must actually reach the DOM.
    await waitFor(() => expect(container.textContent).toContain(DOC_TEXT), { timeout: 5000 });

    // And it must have come from the authenticated chunked URL, never inline.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://host/api/server/s1/uploads/dl-1/download');
    expect(init?.credentials).toBe('include');
  });

  it('surfaces a fetch failure instead of hanging on the blank placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })));
    const { container } = render(
      <OfficePreview srcUrl="https://host/missing" mimeType={DOCX_MIME} path="/repo/doc.docx" />,
    );
    await waitFor(() => expect(container.textContent).toContain('404'));
  });
});

describe('OfficePreview unavailable ONLYOFFICE uses real local DOCX rendering', () => {
  it.each(['404', 'network', 'disabled'] as const)('renders DOCX text when config is %s, without exposing the config error', async (scenario) => {
    const bytes = await buildMinimalDocx();
    const source = 'https://host/api/server/s1/uploads/docx-fallback/download';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/onlyoffice/config')) {
        if (scenario === 'network') throw new TypeError('Failed to fetch');
        if (scenario === '404') return { ok: false, status: 404, text: async () => '{"error":"not_found"}' };
        return { ok: true, status: 200, json: async () => ({ enabled: false, role: 'viewer', allowDownload: true }) };
      }
      expect(String(input)).toBe(source);
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, queryByTestId } = render(
      <OfficePreview serverId="s1" srcUrl={source} mimeType={DOCX_MIME} path="/repo/contract.docx" />,
    );
    await waitFor(() => expect(container.textContent).toContain(DOC_TEXT), { timeout: 5000 });
    expect(queryByTestId('office-preview-auth-error')).toBeNull();
    expect(container.textContent).not.toMatch(/API 404|not_found|Failed to fetch/);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/onlyoffice/config'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(source, expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
  });
});
