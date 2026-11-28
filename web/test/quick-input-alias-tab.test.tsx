/**
 * @vitest-environment jsdom
 *
 * QuickInputPanel「别名 / alias」tab (task 9.3 + panel-CRUD part of 12.9).
 * Uses the REAL shared alias hook/resource with a mocked `api/aliases` client
 * so create/delete round-trips invalidate the resource and reflect in the UI
 * without a reload. Inline validation errors surface via the shared reason
 * codes (localized under `alias.error.*`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

// In-memory alias store backing the mocked client. Reset per test.
let store: AliasEntry[] = [];
const listAliases = vi.fn(async (q?: string): Promise<AliasEntry[]> => {
  const needle = (q ?? '').trim();
  return needle ? store.filter((a) => `${a.name}\n${a.description ?? ''}`.includes(needle)) : [...store];
});
const upsertAlias = vi.fn(async (input: { name: string; value: string; description?: string }) => {
  const entry: AliasEntry = { name: input.name, value: input.value, description: input.description, tags: [], createdAt: '', updatedAt: '', source: 'web' };
  store = [...store.filter((a) => a.name !== input.name), entry];
  return entry;
});
const deleteAlias = vi.fn(async (name: string) => { store = store.filter((a) => a.name !== name); });

// Keep the real AliasApiError + error module; swap only the network calls.
vi.mock('../src/api/aliases.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/api/aliases.js')>();
  return { ...orig, listAliases: (q?: string) => listAliases(q), upsertAlias: (i: any) => upsertAlias(i), deleteAlias: (n: string) => deleteAlias(n) };
});

// FileBrowser is lazy + ws-driven; the alias tab never touches it, but the
// import must resolve — stub to a no-op.
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));

import { QuickInputPanel } from '../src/components/QuickInputPanel.js';
import { __resetAliasesForTests } from '../src/hooks/useAliases.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function baseProps(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onSend: vi.fn(),
    agentType: 'claude-code',
    sessionName: 'deck_app_brain',
    data: quickData.data,
    loaded: true,
    onAddCommand: vi.fn(), onAddPhrase: vi.fn(), onRemoveCommand: vi.fn(), onRemovePhrase: vi.fn(),
    onRemoveHistory: vi.fn(), onRemoveSessionHistory: vi.fn(), onClearHistory: vi.fn(), onClearSessionHistory: vi.fn(),
    onInsertAlias: vi.fn(),
    ...over,
  } as any;
}

// The panel renders through createPortal into document.body, so query the
// whole document rather than the render container.
const root = () => document.body;

function aliasTabButton(): HTMLButtonElement {
  const btn = Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.includes('alias.tab'));
  if (!btn) throw new Error('alias tab not found');
  return btn as HTMLButtonElement;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); __resetAliasesForTests(); store = []; });

describe('QuickInputPanel — 别名 tab', () => {
  it('renders an alias tab and lists aliases in compact button mode (no inline meta clutter)', async () => {
    store = [{ name: 'deploy', value: 'ssh root@host', description: 'ship', tags: ['ops', 'prod'], createdAt: '', updatedAt: '', source: 'web' }];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('deploy'));
    // Compact pill button mode: only name is displayed in the pill, no inline meta/tag clutter.
    expect(root().querySelector('.qp-alias-item-meta')).toBeNull();
    expect(root().querySelector('.qp-alias-tag')).toBeNull();
    expect(root().textContent).not.toContain('ssh root@host');
    expect(root().textContent).not.toContain('ship');
    // Detailed value/description/tags are accessible on the pill's hover title
    const pill = root().querySelector('.qp-alias-item') as HTMLElement;
    expect(pill.getAttribute('title')).toContain('ssh root@host');
    expect(pill.getAttribute('title')).toContain('ship');
    expect(pill.getAttribute('title')).toContain('#ops');
    expect(pill.getAttribute('title')).toContain('#prod');
  });

  it('searching by name or description filters compact alias pills accurately', async () => {
    store = [
      { name: 'web-prod', value: '10.0.0.1', description: 'frontend cluster', tags: ['k8s', 'prod'], createdAt: '', updatedAt: '', source: 'web' },
      { name: 'db-stage', value: '10.0.0.2', description: 'postgres staging', tags: ['db', 'staging'], createdAt: '', updatedAt: '', source: 'web' },
    ];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('2'));

    const searchInput = root().querySelector('.qp-alias-search-row input') as HTMLInputElement;

    // Search by name
    fireEvent.input(searchInput, { target: { value: 'web' } });
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('1'));
    expect(root().textContent).toContain('web-prod');
    expect(root().textContent).not.toContain('db-stage');

    // Search by description (matches even though description is not rendered inline in the list)
    fireEvent.input(searchInput, { target: { value: 'staging' } });
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('1'));
    expect(root().textContent).toContain('db-stage');
    expect(root().textContent).not.toContain('web-prod');

    // Search by another description keyword
    fireEvent.input(searchInput, { target: { value: 'frontend' } });
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('1'));
    expect(root().textContent).toContain('web-prod');

    // Non-matching search
    fireEvent.input(searchInput, { target: { value: 'nonexistent' } });
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('0'));
    expect(root().textContent).toContain('alias.no_results');
  });

  it('creates an alias with space-separated tags (whitespace collapsed)', async () => {
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('alias.empty'));
    const addBtn = Array.from(root().querySelectorAll('button')).find((b) => b.getAttribute('title') === 'alias.add');
    fireEvent.click(addBtn!);
    fireEvent.input(root().querySelector('input[placeholder="alias.name_placeholder"]') as HTMLInputElement, { target: { value: 'box' } });
    fireEvent.input(root().querySelector('textarea[placeholder="alias.value_placeholder"]') as HTMLTextAreaElement, { target: { value: 'v' } });
    fireEvent.input(root().querySelector('input[placeholder="alias.tags_placeholder"]') as HTMLInputElement, { target: { value: '  server   ssh  ' } });
    fireEvent.click(Array.from(root().querySelectorAll('button')).find((b) => b.textContent === 'alias.save')!);
    await waitFor(() => expect(upsertAlias).toHaveBeenCalledWith(expect.objectContaining({ name: 'box', tags: ['server', 'ssh'] })));
  });

  it('refetches the server each time the alias tab is opened (picks up externally-created aliases)', async () => {
    store = [{ name: 'deploy', value: 'x', description: '', tags: [], createdAt: '', updatedAt: '', source: 'web' }];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('deploy'));

    // An alias created ELSEWHERE (e.g. an agent via the save_alias MCP tool):
    // the web has no realtime alias push, so it only appears on a refetch.
    store = [...store, { name: 'from_mcp', value: 'ssh y', description: '', tags: [], createdAt: '', updatedAt: '', source: 'mcp' }];
    expect(root().textContent).not.toContain('from_mcp');

    // Re-open the alias tab (switch away and back) → refetch shows it.
    const quickTab = Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.includes('quick_input.tab_quick'));
    fireEvent.click(quickTab!);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('from_mcp'));
  });

  it('selecting an alias inserts its marker (name), not the value, then closes', async () => {
    store = [{ name: 'deploy', value: 'ssh root@host', description: '', tags: [], createdAt: '', updatedAt: '', source: 'web' }];
    const onInsertAlias = vi.fn();
    const onClose = vi.fn();
    render(<QuickInputPanel {...baseProps({ onInsertAlias, onClose })} />);
    fireEvent.click(aliasTabButton());
    const nameSpan = await waitFor(() => {
      const span = Array.from(root().querySelectorAll('span.qp-pill-text')).find((s) => s.textContent === 'deploy');
      if (!span) throw new Error('deploy pill not found');
      return span as HTMLElement;
    });
    fireEvent.click(nameSpan);
    expect(onInsertAlias).toHaveBeenCalledWith('deploy');
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a new alias and reflects it without reload', async () => {
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('alias.empty'));

    // Open the create form via the ＋ button in the alias search row.
    const addBtn = Array.from(root().querySelectorAll('button')).find((b) => b.getAttribute('title') === 'alias.add');
    fireEvent.click(addBtn!);

    const nameInput = root().querySelector('input[placeholder="alias.name_placeholder"]') as HTMLInputElement;
    const valueInput = root().querySelector('textarea[placeholder="alias.value_placeholder"]') as HTMLTextAreaElement;
    fireEvent.input(nameInput, { target: { value: 'winbox' } });
    fireEvent.input(valueInput, { target: { value: '10.0.0.9' } });

    const saveBtn = Array.from(root().querySelectorAll('button')).find((b) => b.textContent === 'alias.save');
    fireEvent.click(saveBtn!);

    await waitFor(() => {
      expect(upsertAlias).toHaveBeenCalledWith(expect.objectContaining({ name: 'winbox', value: '10.0.0.9' }));
      expect(root().textContent).toContain('winbox');
    });
  });

  it('shows a localized validation error for an invalid name and does not call the API', async () => {
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('alias.empty'));
    const addBtn = Array.from(root().querySelectorAll('button')).find((b) => b.getAttribute('title') === 'alias.add');
    fireEvent.click(addBtn!);

    const nameInput = root().querySelector('input[placeholder="alias.name_placeholder"]') as HTMLInputElement;
    const valueInput = root().querySelector('textarea[placeholder="alias.value_placeholder"]') as HTMLTextAreaElement;
    // A colon is disallowed by ALIAS_NAME_PATTERN → invalid_alias_name.
    fireEvent.input(nameInput, { target: { value: 'bad:name' } });
    fireEvent.input(valueInput, { target: { value: 'v' } });
    const saveBtn = Array.from(root().querySelectorAll('button')).find((b) => b.textContent === 'alias.save');
    fireEvent.click(saveBtn!);

    await waitFor(() => expect(root().textContent).toContain('alias.error.invalid_alias_name'));
    expect(upsertAlias).not.toHaveBeenCalled();
  });

  it('deletes an alias and removes it without reload', async () => {
    store = [{ name: 'deploy', value: 'x', description: '', tags: [], createdAt: '', updatedAt: '', source: 'web' }];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('deploy'));

    const delBtn = Array.from(root().querySelectorAll('button')).find((b) => b.textContent === '✕' && b.getAttribute('title') === 'alias.delete');
    fireEvent.click(delBtn!);

    await waitFor(() => {
      expect(deleteAlias).toHaveBeenCalledWith('deploy');
      expect(root().textContent).not.toContain('deploy');
    });
  });

  it('editing keeps focus in the field being typed (does not jump back to name)', async () => {
    store = [{ name: 'deploy', value: 'x', description: '', tags: [], createdAt: '', updatedAt: '', source: 'web' }];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('deploy'));
    const editBtn = Array.from(root().querySelectorAll('button')).find((b) => b.getAttribute('title') === 'alias.edit');
    fireEvent.click(editBtn!);
    // Let the initial "focus name on open" timer fire.
    await new Promise((r) => setTimeout(r, 80));
    const valueInput = root().querySelector('textarea[placeholder="alias.value_placeholder"]') as HTMLTextAreaElement;
    valueInput.focus();
    fireEvent.input(valueInput, { target: { value: 'edited value' } });
    // Wait past the (previously buggy) 50ms re-focus timer.
    await new Promise((r) => setTimeout(r, 80));
    // Focus must remain on the value field — not stolen back to the name input.
    expect(document.activeElement).toBe(valueInput);
  });

  it('renders upgraded alias search counter, clear control, and compact item actions container', async () => {
    store = [
      { name: 'alpha', value: 'ssh 1.2.3.4', description: 'box 1', tags: ['ops'], createdAt: '', updatedAt: '', source: 'web' },
      { name: 'beta', value: 'ssh 5.6.7.8', description: 'box 2', tags: [], createdAt: '', updatedAt: '', source: 'web' },
    ];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('2'));
    expect(root().querySelectorAll('.qp-alias-item')).toHaveLength(2);
    expect(root().querySelectorAll('.qp-alias-item-actions')).toHaveLength(2);

    const search = root().querySelector('.qp-alias-search-row input') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'alpha' } });
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('1'));
    const clearBtn = root().querySelector('.qp-alias-search-row .qp-search-clear') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn);
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('2'));
  });

  it('uses dedicated scrollable fields container + pinned Save/Cancel actions when editing and keeps compact pills for 30+ items', async () => {
    store = Array.from({ length: 32 }, (_, i) => ({
      name: `box-${i}`,
      value: `ssh root@host-${i}`,
      description: `host note ${i}`,
      tags: ['very-long-production-tag-01', 'very-long-production-tag-02', 'very-long-production-tag-03'],
      createdAt: '',
      updatedAt: '',
      source: 'web' as const,
    }));
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().querySelector('.qp-alias-count')?.textContent).toBe('32'));
    // Compact pill buttons: no inline tags or cards rendered in the list!
    expect(root().querySelectorAll('.qp-alias-tag').length).toBe(0);
    expect(root().querySelectorAll('.qp-alias-item').length).toBe(32);

    const panel = root().querySelector('.qp-alias-panel')!;
    expect(panel.classList.contains('is-editing')).toBe(false);

    const editBtn = Array.from(root().querySelectorAll('button')).find((b) => b.getAttribute('title') === 'alias.edit')!;
    fireEvent.click(editBtn);

    expect(panel.classList.contains('is-editing')).toBe(true);
    const fields = root().querySelector('.qp-alias-form .qp-alias-form-fields');
    const actions = root().querySelector('.qp-alias-form .qp-alias-form-actions');
    expect(fields).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(fields!.querySelector('input[placeholder="alias.name_placeholder"]')).not.toBeNull();
    expect(fields!.querySelector('textarea[placeholder="alias.value_placeholder"]')).not.toBeNull();
    expect(Array.from(actions!.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'alias.save',
      'alias.cancel',
    ]);
  });

  it('satisfies CSS contract: .qp-alias-items uses flex-wrap: wrap row flow, .qp-pill.qp-alias-item overrides .qp-pill-custom, and mobile uses min(180px, calc(100vw - 110px))', () => {
    const cssPath = resolve(__dirname, '../src/styles.css');
    const cssContent = readFileSync(cssPath, 'utf-8');

    // .qp-alias-items must use horizontal wrapping flex flow
    expect(cssContent).toMatch(/\.qp-alias-items\s*\{[^}]*display:\s*flex/);
    expect(cssContent).toMatch(/\.qp-alias-items\s*\{[^}]*flex-direction:\s*row/);
    expect(cssContent).toMatch(/\.qp-alias-items\s*\{[^}]*flex-wrap:\s*wrap/);

    // .qp-pill.qp-alias-item compound selector (0,2,0) must override .qp-pill-custom (0,1,0)
    // with 8px radius, cyan border, and translucent background
    expect(cssContent).toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*width:\s*auto/);
    expect(cssContent).toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*display:\s*inline-flex/);
    expect(cssContent).toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*border-radius:\s*8px/);
    expect(cssContent).toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*border:\s*1px solid rgba\(125,211,252,0\.18\)/);
    expect(cssContent).toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*background:\s*rgba\(15,23,42,0\.72\)/);
    expect(cssContent).not.toMatch(/\.qp-pill\.qp-alias-item\s*\{[^}]*(?<![a-z-])width:\s*100%/);

    // Mobile media query must cap text width at min(180px, calc(100vw - 110px)) to prevent 390px expansion
    expect(cssContent).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.qp-pill\.qp-alias-item\s+\.qp-pill-text\s*\{[^}]*max-width:\s*min\(180px,\s*calc\(100vw\s*-\s*110px\)\)/);

    // Quick tab .qp-pill-custom preserves default 999px pill border-radius
    expect(cssContent).toMatch(/\.qp-pill-custom\s*\{[^}]*border-radius:\s*999px/);

    // Obsolete full-width card meta/tag selectors must be removed
    expect(cssContent).not.toContain('.qp-alias-item-meta');
    expect(cssContent).not.toContain('.qp-alias-tag');
  });

  it('renders a 20-character maximum-length alias name with compact structure and actions intact', async () => {
    const longName = 'abcdefghijklmnopqrst'; // exactly 20 chars (max length allowed by ALIAS_NAME_PATTERN)
    store = [{ name: longName, value: 'val', description: 'desc', tags: [], createdAt: '', updatedAt: '', source: 'web' }];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain(longName));

    const pill = root().querySelector('.qp-pill.qp-alias-item') as HTMLElement;
    expect(pill).not.toBeNull();
    const textSpan = pill.querySelector('.qp-pill-text') as HTMLElement;
    expect(textSpan.textContent).toBe(longName);

    const actions = pill.querySelector('.qp-alias-item-actions') as HTMLElement;
    expect(actions).not.toBeNull();
    expect(actions.querySelector('.qp-pill-edit')).not.toBeNull();
    expect(actions.querySelector('.qp-pill-del')).not.toBeNull();
  });
});
