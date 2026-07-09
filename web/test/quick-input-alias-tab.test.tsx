/**
 * @vitest-environment jsdom
 *
 * QuickInputPanel「别名 / alias」tab (task 9.3 + panel-CRUD part of 12.9).
 * Uses the REAL shared alias hook/resource with a mocked `api/aliases` client
 * so create/delete round-trips invalidate the resource and reflect in the UI
 * without a reload. Inline validation errors surface via the shared reason
 * codes (localized under `alias.error.*`).
 */
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
  it('renders an alias tab and lists aliases with value + desc + tags (desktop list)', async () => {
    store = [{ name: 'deploy', value: 'ssh root@host', description: 'ship', tags: ['ops', 'prod'], createdAt: '', updatedAt: '', source: 'web' }];
    render(<QuickInputPanel {...baseProps()} />);
    fireEvent.click(aliasTabButton());
    await waitFor(() => expect(root().textContent).toContain('deploy'));
    // The user's OWN management list shows the (truncated) value + description +
    // tags. This is the user's own surface — the MCP list_aliases tool stays
    // metadata-only for agents, but the web owner can see their own value.
    expect(root().textContent).toContain('ssh root@host');
    expect(root().textContent).toContain('ship');
    expect(root().textContent).toContain('ops');
    expect(root().textContent).toContain('prod');
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
});
