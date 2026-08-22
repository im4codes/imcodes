// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlobViaDownloadAnchor } from '../src/browser-download.js';

describe('browser download', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('clicks a named blob download and revokes its URL after the handoff', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:mobile-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const blob = new Blob(['payload']);
    saveBlobViaDownloadAnchor(blob, 'report.pdf');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:mobile-download');
    expect(anchor.download).toBe('report.pdf');
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mobile-download');
  });
});
