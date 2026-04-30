/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/preact';

const createLocalWebPreview = vi.fn();
const closeLocalWebPreview = vi.fn();
const buildLocalWebPreviewProxyUrl = vi.fn((serverId: string, previewId: string, path: string) => `/api/server/${serverId}/local-web/${previewId}${path}`);
const normalizeLocalWebPreviewPath = vi.fn((path: string) => (path.startsWith('/') ? path : `/${path}`));

vi.mock('../../src/api.js', () => ({
  createLocalWebPreview: (...args: unknown[]) => createLocalWebPreview(...args),
  closeLocalWebPreview: (...args: unknown[]) => closeLocalWebPreview(...args),
  buildLocalWebPreviewProxyUrl: (...args: unknown[]) => buildLocalWebPreviewProxyUrl(...args),
  normalizeLocalWebPreviewPath: (...args: unknown[]) => normalizeLocalWebPreviewPath(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'localWebPreview.title': 'Local Web Preview',
      'localWebPreview.port': 'Port',
      'localWebPreview.path': 'Path',
      'localWebPreview.open': 'Open',
      'localWebPreview.refresh': 'Refresh',
      'localWebPreview.openInNewTab': 'Open in new tab',
      'localWebPreview.closePreview': 'Close preview',
      'localWebPreview.sandboxNote': 'Sandbox note',
      'localWebPreview.initialPathNote': 'Path note',
      'localWebPreview.opening': 'Opening preview…',
      'localWebPreview.empty': 'Empty',
      'localWebPreview.previewing': 'Previewing:',
      'localWebPreview.noServer': 'No server',
      'localWebPreview.invalidPort': 'Invalid port',
      'localWebPreview.openFailed': 'Open failed',
      'common.loading': 'Loading',
    }[key] ?? key),
  }),
}));

import { LocalWebPreviewPanel } from '../../src/components/LocalWebPreviewPanel.js';

afterEach(async () => {
  cleanup();
  // Preact schedules passive hook cleanup through a requestAnimationFrame +
  // timeout pair.  If the jsdom environment tears down before that scheduler
  // drains, the timer can fire after globals such as cancelAnimationFrame have
  // been removed and Vitest reports an unhandled error even though assertions
  // passed.  Drain the pending scheduler while the environment is still alive.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  vi.clearAllMocks();
});

describe('LocalWebPreviewPanel', () => {
  beforeEach(() => {
    createLocalWebPreview.mockResolvedValue({
      previewId: 'preview1',
      previewUrl: '/api/server/server1/local-web/preview1/',
    });
    closeLocalWebPreview.mockResolvedValue({ ok: true });
  });

  it('renders sandboxed iframe with allow-same-origin after open', async () => {
    render(<LocalWebPreviewPanel serverId="server1" port="3000" path="/" />);

    await act(async () => {
      await Promise.resolve();
    });

    const iframe = await screen.findByTitle('Local Web Preview');
    expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe?.getAttribute('sandbox')).toContain('allow-same-origin');
  });

  it('opens the active preview url in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<LocalWebPreviewPanel serverId="server1" port="3000" path="/docs" />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('Open in new tab'));
    expect(openSpy).toHaveBeenCalledWith('/api/server/server1/local-web/preview1/docs', '_blank', 'noopener,noreferrer');
  });

  it('recreates preview when refresh is clicked after path edit', async () => {
    render(<LocalWebPreviewPanel serverId="server1" port="3000" path="/" />);

    await act(async () => {
      await Promise.resolve();
    });

    const inputs = document.querySelectorAll('input');
    fireEvent.input(inputs[1] as HTMLInputElement, { currentTarget: { value: '/storybook' }, target: { value: '/storybook' } });
    fireEvent.click(screen.getByText('Refresh'));

    expect(createLocalWebPreview).toHaveBeenLastCalledWith('server1', 3000, '/storybook');
  });
});
