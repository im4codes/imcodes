/**
 * @vitest-environment jsdom
 *
 * AtPicker「别名 / alias」category (task 9.2 + part of 12.9).
 * Verifies the alias category appears in the chooser, entering it lists the
 * user's aliases (filtered by name+description), and selecting one asks the
 * host to insert its `;;(name)` marker — never the value.
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';

// The CI web unit/components setup (test/setup-jsdom-storage.ts) does not shim
// jsdom's missing Element.scrollIntoView / document.execCommand (only the base
// vitest.config.ts setup does). The inline picker scrolls its highlighted row
// and the caret-preserving insert uses execCommand, so shim both as no-ops here
// (same as test/setup.ts) so those paths don't throw under the lean CI setup.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true, configurable: true });
}
if (typeof document !== 'undefined' && typeof (document as { execCommand?: unknown }).execCommand !== 'function') {
  Object.defineProperty(document, 'execCommand', { value: () => false, writable: true, configurable: true });
}

// t() returns the key so assertions stay language-agnostic.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

// Control the alias list the picker sees. `filterAliases` is the real shared
// filter so we exercise the name+description substring behavior for real.
const aliasList: AliasEntry[] = [
  { name: 'deploy', value: 'ssh root@host && restart', description: 'ship prod', tags: [], createdAt: '', updatedAt: '', source: 'web' },
  { name: 'winbox', value: '10.0.0.9', description: 'windows server', tags: [], createdAt: '', updatedAt: '', source: 'web' },
];

vi.mock('../src/hooks/useAliases.js', async (importOriginal) => {
  // Use the REAL shared `filterAliases` (not a re-implementation) so this test
  // exercises production name+description substring behavior — only `useAliases`
  // itself is stubbed to return a fixed list (Cx1-5).
  const orig = await importOriginal<typeof import('../src/hooks/useAliases.js')>();
  return {
    ...orig,
    useAliases: (query?: string) => ({
      aliases: aliasList,
      filtered: orig.filterAliases(aliasList, query),
      loaded: true,
      loading: false,
      error: null,
      stale: false,
      refetch: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    }),
  };
});

// p2p-combos hook is pulled in by AtPicker; stub it to an empty combo set.
vi.mock('../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { custom: [] } }),
}));

import { AtPicker } from '../src/components/AtPicker.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function baseProps(over: Record<string, unknown> = {}) {
  return {
    query: '',
    sessions: [],
    rootSession: 'deck_app_brain',
    wsClient: { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) },
    projectDir: '/work/app',
    onSelectFile: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectDelegateAgent: vi.fn(),
    onSelectAlias: vi.fn(),
    onClose: vi.fn(),
    visible: true,
    ...over,
  } as any;
}

/** Find the innermost (deepest) div whose subtree contains `text`. */
function findRow(container: HTMLElement, text: string): HTMLElement | undefined {
  const matches = Array.from(container.querySelectorAll('div')).filter((d) => d.textContent?.includes(text)) as HTMLElement[];
  // The deepest match is the row itself (its parents also match); pick the one
  // with no child div that also contains the text.
  return matches.find((d) => !matches.some((other) => other !== d && d.contains(other)));
}

/** Open the alias category from the chooser. */
function openAliasCategory(container: HTMLElement): void {
  const row = findRow(container, 'alias.category_desc');
  if (!row) throw new Error('alias category row not found');
  fireEvent.click(row);
}

describe('AtPicker — 别名 category', () => {
  it('shows an alias category in the chooser and lists aliases when entered', async () => {
    const { container } = render(<AtPicker {...baseProps()} />);
    expect(container.textContent).toContain('alias.category');
    openAliasCategory(container);
    await waitFor(() => {
      expect(container.textContent).toContain('deploy');
      expect(container.textContent).toContain('winbox');
    });
    // The resolved value must never be rendered in the picker.
    expect(container.textContent).not.toContain('ssh root@host');
    expect(container.textContent).not.toContain('10.0.0.9');
  });

  it('filters aliases by description text via the inline query', async () => {
    // query "windows" matches only winbox's description.
    const { container, rerender } = render(<AtPicker {...baseProps()} />);
    openAliasCategory(container);
    rerender(<AtPicker {...baseProps({ query: 'windows' })} />);
    await waitFor(() => expect(container.textContent).toContain('winbox'));
    expect(container.textContent).not.toContain('deploy');
  });

  it('inserts the marker (calls onSelectAlias with the name) on click, never the value', async () => {
    const onSelectAlias = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectAlias })} />);
    openAliasCategory(container);
    const nameSpan = await waitFor(() => {
      const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === 'deploy');
      if (!span) throw new Error('deploy name span not found');
      return span as HTMLElement;
    });
    // The row is the span's parent div (carries the onClick).
    fireEvent.click(nameSpan.parentElement as HTMLElement);
    expect(onSelectAlias).toHaveBeenCalledWith('deploy');
  });
});
