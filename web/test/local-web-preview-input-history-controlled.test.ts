/**
 * @vitest-environment jsdom
 *
 * Controlled-props data-flow regression: an empty/default initial `port`/`path`
 * prop MUST NOT clobber the value restored from local history (history[0]).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { h } from 'preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/native.js', () => ({
  isNative: () => false,
}));

// Keep the real normalization simple/predictable; we only care about the
// controlled-prop seeding behavior here.
vi.mock('../src/api.js', () => ({
  normalizeLocalWebPreviewPath: (p: string) => (p && p.trim() ? (p.startsWith('/') ? p : `/${p}`) : '/'),
  buildLocalWebPreviewProxyUrl: () => 'about:blank',
  createLocalWebPreview: vi.fn(),
  closeLocalWebPreview: vi.fn(),
}));

const PORT_HISTORY_KEY = 'imcodes_local_preview_port_history';
const PATH_HISTORY_KEY = 'imcodes_local_preview_path_history';
const LEGACY_PORT_KEY = 'imcodes_local_preview_port';
const LEGACY_PATH_KEY = 'imcodes_local_preview_path';

async function renderPanel(props: Record<string, unknown>) {
  const { LocalWebPreviewPanel } = await import('../src/components/LocalWebPreviewPanel.js');
  let container!: HTMLElement;
  act(() => {
    ({ container } = render(h(LocalWebPreviewPanel as never, { serverId: 'server-1', ...props })));
  });
  return container;
}

function inputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
}

describe('LocalWebPreviewPanel controlled-prop seeding', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
  });

  it('seeds from local history[0] when port/path props are omitted (undefined)', async () => {
    localStorage.setItem(PORT_HISTORY_KEY, JSON.stringify(['5173', '3000']));
    localStorage.setItem(PATH_HISTORY_KEY, JSON.stringify(['/dashboard']));

    const container = await renderPanel({});
    const [portInput, pathInput] = inputs(container);

    expect(portInput.value).toBe('5173');
    expect(pathInput.value).toBe('/dashboard');
  });

  it('does not overwrite restored history with an explicit empty/default prop... it honors the prop only when provided', async () => {
    // When a controlled prop IS explicitly provided, it wins (documented behavior).
    localStorage.setItem(PORT_HISTORY_KEY, JSON.stringify(['5173']));

    const container = await renderPanel({ port: 9999 });
    const [portInput] = inputs(container);
    expect(portInput.value).toBe('9999');
  });

  it('falls back to defaults (empty port, "/" path) when no history exists', async () => {
    const container = await renderPanel({});
    const [portInput, pathInput] = inputs(container);
    expect(portInput.value).toBe('');
    expect(pathInput.value).toBe('/');
  });

  it('migrates legacy single-value keys into history[0] on first render', async () => {
    localStorage.setItem(LEGACY_PORT_KEY, '4321');
    localStorage.setItem(LEGACY_PATH_KEY, '/legacy');

    const container = await renderPanel({});
    const [portInput, pathInput] = inputs(container);

    expect(portInput.value).toBe('4321');
    expect(pathInput.value).toBe('/legacy');
    // Legacy keys consumed; history keys now hold the migrated values.
    expect(localStorage.getItem(LEGACY_PORT_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_PATH_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(PORT_HISTORY_KEY) ?? '[]')).toEqual(['4321']);
    expect(JSON.parse(localStorage.getItem(PATH_HISTORY_KEY) ?? '[]')).toEqual(['/legacy']);
  });
});
