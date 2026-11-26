/**
 * @vitest-environment jsdom
 */
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true, configurable: true });
}
if (typeof document !== 'undefined' && typeof (document as { execCommand?: unknown }).execCommand !== 'function') {
  Object.defineProperty(document, 'execCommand', { value: () => false, writable: true, configurable: true });
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

const listCloudDocsApiMock = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...orig,
    listCloudDocsApi: (...args: unknown[]) => listCloudDocsApiMock(...args),
  };
});

const listAgentSkillsMock = vi.fn();
vi.mock('../src/api/agent-skills.js', () => ({
  listAgentSkills: (...args: unknown[]) => listAgentSkillsMock(...args),
}));

import { SessionControls } from '../src/components/SessionControls.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function makeWs() {
  return {
    connected: true,
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  } as any;
}

function renderControls(over: Record<string, unknown> = {}) {
  const ws = makeWs();
  const onSend = vi.fn();
  const { container, rerender } = render(
    <SessionControls
      ws={ws}
      activeSession={{ name: 'deck_app_brain', project: 'app', role: 'brain', agentType: 'claude-code', state: 'idle', projectDir: '/work/app' } as any}
      quickData={quickData}
      serverId="srv1"
      sessions={[]}
      subSessions={[]}
      onSend={onSend}
      {...over}
    />,
  );
  const editor = container.querySelector('[role="textbox"]') as HTMLElement;
  return { ws, onSend, container, editor, rerender };
}

function typeInto(editor: HTMLElement, text: string, init: Record<string, unknown> = {}) {
  editor.textContent = text;
  fireEvent.input(editor, init);
}

const sampleResponse = {
  folders: [
    { id: 'fld-1', userId: 'u1', parentId: null, name: 'Architecture', createdAt: 1, updatedAt: 10 },
  ],
  docs: [
    {
      id: 'doc-plan',
      userId: 'u1',
      folderId: 'fld-1',
      name: '技术方案.md',
      ext: '.md',
      mimeType: 'text/markdown',
      sizeBytes: 120,
      docVersion: 1,
      createdAt: 1,
      updatedAt: 500,
      lastOpenedAt: null,
    },
  ],
  sharedFolders: [],
  sharedDocs: [
    {
      id: 'doc-notes',
      userId: 'u2',
      folderId: null,
      name: 'Meeting Notes.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 240,
      docVersion: 1,
      createdAt: 1,
      updatedAt: 300,
      lastOpenedAt: null,
      role: 'viewer' as const,
      allowDownload: true,
      ownerName: 'Alice',
      ownerUsername: 'alice',
      sharedVia: 'doc' as const,
      sharedTeamName: null,
      folderName: null,
    },
  ],
};

beforeEach(() => {
  listAgentSkillsMock.mockResolvedValue([]);
  listCloudDocsApiMock.mockResolvedValue(sampleResponse);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('SessionControls — inline & Cloud Docs search & citation picker', () => {
  it('opens on &, queries listCloudDocsApi, filters results, and inserts canonical citation on Enter without sending', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '帮我看下&');

    await waitFor(() => {
      const picker = container.querySelector('.controls-cloud-doc-picker');
      expect(picker).toBeTruthy();
      expect(picker!.textContent).toContain('技术方案.md');
      expect(picker!.textContent).toContain('Meeting Notes.docx');
    });
    expect(listCloudDocsApiMock).toHaveBeenCalledWith(expect.objectContaining({ allFolders: true }));

    typeInto(editor, '帮我看下&方案');
    await waitFor(() => {
      const options = container.querySelectorAll('.controls-cloud-doc-picker [role="option"]');
      expect(options).toHaveLength(1);
      expect(options[0]!.getAttribute('data-cloud-doc-id')).toBe('doc-plan');
    });

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
    expect(editor.textContent).toBe('帮我看下[CloudDoc: 技术方案.md | id=doc-plan] ');
  });

  it('inserts citation on Tab and mousedown click, preserving prefix text', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '看看 &Meeting');
    await waitFor(() => expect(container.querySelector('[data-cloud-doc-id="doc-notes"]')).toBeTruthy());

    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('看看 [CloudDoc: Meeting Notes.docx | id=doc-notes] ');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    typeInto(editor, '&方案');
    await waitFor(() => expect(container.querySelector('[data-cloud-doc-id="doc-plan"]')).toBeTruthy());
    fireEvent.mouseDown(container.querySelector('[data-cloud-doc-id="doc-plan"]')!);
    expect(editor.textContent).toBe('[CloudDoc: 技术方案.md | id=doc-plan] ');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
  });

  it('keeps & dropdown open during Chinese IME composition, ignores IME Space/Enter, and searches after compositionend', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());

    // Start Chinese IME composition after `&`: preedit input + IME Space/Enter must not close or choose.
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    typeInto(editor, '&fang\'an', { isComposing: true });
    fireEvent.keyDown(editor, { key: ' ', isComposing: true, keyCode: 229 });
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true, keyCode: 229 });

    expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy();
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('&fang\'an');

    // Commit Chinese text -> compositionend triggers input and filters to 技术方案.md.
    editor.textContent = '&方案';
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));

    await waitFor(() => {
      const options = container.querySelectorAll('.controls-cloud-doc-picker [role="option"]');
      expect(options).toHaveLength(1);
      expect(options[0]!.getAttribute('data-cloud-doc-id')).toBe('doc-plan');
    });
  });

  it('dismisses dropdown on non-IME Space without preventDefault and on Enter with 0 matches without sending', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '&方案');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());

    const spaceNotPrevented = fireEvent.keyDown(editor, { key: ' ' });
    expect(spaceNotPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    // Enter when empty / no match dismisses dropdown without sending.
    typeInto(editor, '&不存在的文档');
    await waitFor(() => {
      const picker = container.querySelector('.controls-cloud-doc-picker');
      expect(picker).toBeTruthy();
      expect(picker!.textContent).toContain('cloud_docs.quote.reference_no_results');
    });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    // Escape also closes dropdown cleanly.
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
  });

  it('does not trigger on &&, R&D, URL query strings, or pasted text containing &', async () => {
    const { container, editor } = renderControls();

    for (const text of ['cmd1 && cmd2', 'R&D', 'https://a.com?x=1&y=2']) {
      typeInto(editor, text);
      await new Promise((r) => setTimeout(r, 20));
      expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
    }

    const clipboardData = { getData: () => 'check &方案', files: [] };
    editor.textContent = 'check &方案';
    fireEvent.paste(editor, { clipboardData });
    fireEvent.input(editor);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
  });

  it('aborts stale in-flight requests when closed and degrades gracefully on API error', async () => {
    let abortSignal: AbortSignal | undefined;
    let resolveDelayed: ((v: unknown) => void) | undefined;
    listCloudDocsApiMock.mockImplementationOnce((opts: { signal?: AbortSignal }) => {
      abortSignal = opts?.signal;
      return new Promise((resolve) => { resolveDelayed = resolve; });
    });

    const { ws, container, editor } = renderControls();
    typeInto(editor, '&');
    await waitFor(() => expect(listCloudDocsApiMock).toHaveBeenCalledTimes(1));

    // Close picker via Escape -> aborts in-flight request; stale resolve must not reopen picker.
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(abortSignal?.aborted).toBe(true);
    await act(async () => {
      resolveDelayed?.(sampleResponse);
      await Promise.resolve();
    });
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();

    // API failure degrades gracefully and Enter closes without throwing/sending.
    listCloudDocsApiMock.mockRejectedValueOnce(new Error('network down'));
    typeInto(editor, '&');
    await waitFor(() => {
      const picker = container.querySelector('.controls-cloud-doc-picker');
      expect(picker).toBeTruthy();
      expect(picker!.textContent).toContain('cloud_docs.quote.reference_error');
    });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
  });

  it('supports ArrowUp/ArrowDown navigation, closes on blur, enforces mutual exclusivity, and keeps normal Enter send', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelectorAll('.controls-cloud-doc-picker [role="option"]')).toHaveLength(2));

    // Move highlight down to second option (Meeting Notes.docx) and press Enter
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(container.querySelector('[data-cloud-doc-id="doc-notes"]')?.getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('[CloudDoc: Meeting Notes.docx | id=doc-notes] ');

    // Immediate second Enter within 150ms guard must not accidentally send
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();

    // After guard window expires (or after normal edit without &), Enter sends normally
    await new Promise((r) => setTimeout(r, 170));
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(ws.sendSessionCommandUrgent).toHaveBeenCalledTimes(1));

    // Blur closes open & picker
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    fireEvent.blur(editor);
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    // Switching from & to ; closes Cloud Docs picker (mutual exclusivity)
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    typeInto(editor, ';');
    await waitFor(() => {
      expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
      expect(container.querySelector('.controls-alias-picker')).toBeTruthy();
    });
  });

  it('debounces server search and ignores aborted stale search responses on rapid typing', async () => {
    let resolveFirstSearch: ((v: unknown) => void) | undefined;
    let firstSearchSignal: AbortSignal | undefined;
    listCloudDocsApiMock.mockImplementation((opts: { search?: string; signal?: AbortSignal }) => {
      if (!opts?.search) return Promise.resolve(sampleResponse);
      if (opts.search === '方') {
        firstSearchSignal = opts.signal;
        return new Promise((resolve) => { resolveFirstSearch = resolve; });
      }
      return Promise.resolve({
        folders: [],
        docs: [{
          id: 'doc-new',
          userId: 'u1',
          folderId: null,
          name: '方案终稿.md',
          ext: '.md',
          mimeType: 'text/markdown',
          sizeBytes: 100,
          docVersion: 1,
          createdAt: 1,
          updatedAt: 900,
          lastOpenedAt: null,
        }],
        sharedFolders: [],
        sharedDocs: [],
      });
    });

    const { container, editor } = renderControls();
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('[data-cloud-doc-id="doc-plan"]')).toBeTruthy());

    // Type '方' and wait for its 150ms debounced search to start
    typeInto(editor, '&方');
    await waitFor(() => expect(firstSearchSignal).toBeDefined());

    // Rapidly type '案' before first search finishes -> aborts first search, resolves '方案'
    typeInto(editor, '&方案');
    expect(firstSearchSignal?.aborted).toBe(true);
    await waitFor(() => expect(container.querySelector('[data-cloud-doc-id="doc-new"]')).toBeTruthy());

    // Late resolution from aborted '方' response must not clobber newer state
    await act(async () => {
      resolveFirstSearch?.({
        folders: [],
        docs: [{
          id: 'doc-stale',
          userId: 'u1',
          folderId: null,
          name: '方案旧版.md',
          ext: '.md',
          mimeType: 'text/markdown',
          sizeBytes: 10,
          docVersion: 1,
          createdAt: 1,
          updatedAt: 1000,
          lastOpenedAt: null,
        }],
        sharedFolders: [],
        sharedDocs: [],
      });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-cloud-doc-id="doc-stale"]')).toBeNull();
    expect(container.querySelector('[data-cloud-doc-id="doc-new"]')).toBeTruthy();
  });

  it('absorbs WebKit post-compositionend IME commit Enter/Space before allowing explicit follow-up selection or dismissal', async () => {
    const { ws, container, editor } = renderControls();
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());

    // Preedit during composition
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    typeInto(editor, '&fang', { isComposing: true });
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy();

    // Commit Chinese text: compositionend runs first, followed immediately by WebKit commit Enter (isComposing=false, keyCode=13)
    editor.textContent = '&方案';
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    const commitEnterAllowed = fireEvent.keyDown(editor, { key: 'Enter', isComposing: false, keyCode: 13 });
    expect(commitEnterAllowed).toBe(false);
    expect(editor.textContent).toBe('&方案');
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy();
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();

    // Filtered result remains visible and a subsequent explicit Enter selects the doc
    await waitFor(() => {
      const options = container.querySelectorAll('.controls-cloud-doc-picker [role="option"]');
      expect(options).toHaveLength(1);
      expect(options[0]!.getAttribute('data-cloud-doc-id')).toBe('doc-plan');
    });
    await new Promise((r) => setTimeout(r, 95));
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: false, keyCode: 13 });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('[CloudDoc: 技术方案.md | id=doc-plan] ');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    // Same WebKit post-compositionend commit guard for Space (isComposing=false, keyCode=32)
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    typeInto(editor, '&fang', { isComposing: true });
    editor.textContent = '&方案';
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    const commitSpaceAllowed = fireEvent.keyDown(editor, { key: ' ', isComposing: false, keyCode: 32 });
    expect(commitSpaceAllowed).toBe(false);
    expect(editor.textContent).toBe('&方案');
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy();

    // Explicit Space after grace window closes the picker without preventDefault
    await new Promise((r) => setTimeout(r, 95));
    const explicitSpaceAllowed = fireEvent.keyDown(editor, { key: ' ', isComposing: false, keyCode: 32 });
    expect(explicitSpaceAllowed).toBe(true);
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());

    // Non-composition normal Enter sends as expected once selection just-closed guard expires
    await new Promise((r) => setTimeout(r, 170));
    typeInto(editor, '普通发送');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(ws.sendSessionCommandUrgent).toHaveBeenCalledTimes(1));
  });

  it('enforces single-owner trigger precedence across &@, composition @, @, ;, /, and @@ transitions', async () => {
    const { ws, container, editor } = renderControls();

    // 1. `&@` in a single onInput must open ONLY Cloud Docs picker (never AtPicker),
    // and Enter with 0 matches dismisses cleanly without sending or opening AtPicker
    typeInto(editor, '&@');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
    expect(editor.textContent).toBe('&@');
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');

    // Escape on `&@` also closes Cloud Docs cleanly with no lingering AtPicker
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    typeInto(editor, '&@');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');

    // 2. When a Cloud Doc name contains `@`, `&@` filters and Enter inserts the doc citation
    listCloudDocsApiMock.mockResolvedValue({
      folders: [],
      docs: [{ ...sampleResponse.docs[0]!, name: 'spec@v2.md' }],
      sharedFolders: [],
      sharedDocs: [],
    });
    typeInto(editor, '&@');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker [role="option"]')).toBeTruthy());
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('[CloudDoc: spec@v2.md | id=doc-plan] ');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
    listCloudDocsApiMock.mockResolvedValue(sampleResponse);
    await new Promise((r) => setTimeout(r, 170));

    // 3. IME composition `&@` while `&` is open must NOT spawn AtPicker
    typeInto(editor, '&');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    typeInto(editor, '&@', { isComposing: true });
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy();
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');
    editor.textContent = '&';
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 95));

    // 4. Bidirectional switch `&` <-> `@`
    typeInto(editor, '@');
    await waitFor(() => expect(container.textContent).toContain('p2p.picker.search_project_files'));
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
    typeInto(editor, '@ &');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    expect(container.textContent).not.toContain('p2p.picker.search_project_files');

    // 5. Bidirectional switch `;` <-> `&` and `/model` -> `&`
    typeInto(editor, ';');
    await waitFor(() => expect(container.querySelector('.controls-alias-picker')).toBeTruthy());
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
    typeInto(editor, ';dep &');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    expect(container.querySelector('.controls-alias-picker')).toBeNull();

    typeInto(editor, '/m');
    await waitFor(() => expect(container.querySelector('.controls-slash-picker')).toBeTruthy());
    expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull();
    typeInto(editor, '/m &');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeTruthy());
    expect(container.querySelector('.controls-slash-picker')).toBeNull();

    // 6. `&` -> `@@` closes Cloud Docs cleanly
    typeInto(editor, '@@');
    await waitFor(() => expect(container.querySelector('.controls-cloud-doc-picker')).toBeNull());
  });
});
