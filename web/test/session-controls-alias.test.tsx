/**
 * @vitest-environment jsdom
 *
 * SessionControls alias send-path + inline `;` autocomplete
 * (tasks 7.1/7.2 + 9.1; web-side 12.7 + inline part of 12.9).
 *
 *  - A send whose composer text carries `;;(name)` markers puts the resolved
 *    name→value map in the `session.send` payload's `resolvedAliases`, while the
 *    text keeps its markers and the optimistic user bubble shows the marker text
 *    (never the value).
 *  - The inline `;` autocomplete opens only at a word boundary + valid name char,
 *    is suppressed on paste and during IME composition, and filters by
 *    name+description.
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

const aliasList: AliasEntry[] = [
  { name: 'deploy', value: 'ssh root@host && restart', description: 'ship prod', tags: [], createdAt: '', updatedAt: '', source: 'web' },
  { name: 'winbox', value: '10.0.0.9', description: 'windows server', tags: [], createdAt: '', updatedAt: '', source: 'web' },
];

// Control the alias list; use the REAL shared `filterAliases` (imported from the
// production module, not re-implemented) for name+description matching (Cx1-5).
vi.mock('../src/hooks/useAliases.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hooks/useAliases.js')>();
  return {
    ...orig,
    useAliases: (query?: string) => ({
      aliases: aliasList,
      filtered: orig.filterAliases(aliasList, query),
      loaded: true, loading: false, error: null, stale: false,
      refetch: vi.fn(), create: vi.fn(), remove: vi.fn(),
    }),
  };
});

import { SessionControls, matchInlineAliasTrigger } from '../src/components/SessionControls.js';

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
  const { container } = render(
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
  return { ws, onSend, container, editor };
}

/** Type `text` into the contenteditable composer and fire an input event. */
function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SessionControls — alias send path (A′)', () => {
  it('includes resolvedAliases in the session.send payload; text keeps markers; bubble shows marker not value', async () => {
    const { ws, onSend, editor } = renderControls();
    typeInto(editor, 'run ;;(deploy) now');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect(payload.text).toBe('run ;;(deploy) now');          // markers kept, not expanded
    expect(payload.resolvedAliases).toEqual({ deploy: 'ssh root@host && restart' });

    // Optimistic user bubble shows the marker text, never the resolved value.
    expect(onSend).toHaveBeenCalled();
    const [, bubbleText] = onSend.mock.calls[0];
    expect(bubbleText).toBe('run ;;(deploy) now');
    expect(bubbleText).not.toContain('ssh root@host');
  });

  it('omits resolvedAliases entirely when the message has no markers', async () => {
    const { ws, editor } = renderControls();
    typeInto(editor, 'just a plain message');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect('resolvedAliases' in payload).toBe(false);
  });

  it('does not resolve unknown markers (left literal, no value leak)', async () => {
    const { ws, editor } = renderControls();
    typeInto(editor, 'x ;;(missing) y');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect('resolvedAliases' in payload).toBe(false);
    expect(payload.text).toContain(';;(missing)');
  });
});

describe('SessionControls — inline ; autocomplete', () => {
  it('opens on a word-boundary ; followed by a name char and filters by name+description', async () => {
    const { container, editor } = renderControls();
    typeInto(editor, ';dep');
    await waitFor(() => {
      const picker = container.querySelector('.controls-alias-picker');
      expect(picker).toBeTruthy();
      expect(picker!.textContent).toContain('deploy');
    });
    // "windows" matches winbox's description only.
    typeInto(editor, ';windows');
    await waitFor(() => {
      const picker = container.querySelector('.controls-alias-picker')!;
      expect(picker.textContent).toContain('winbox');
      expect(picker.textContent).not.toContain('deploy');
    });
  });

  it('does not open when ; is not at a word boundary', async () => {
    const { container, editor } = renderControls();
    typeInto(editor, 'abc;dep'); // ; glued to a word → no trigger
    // Give effects a tick, then assert still closed.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.controls-alias-picker')).toBeNull();
  });

  it('is suppressed during IME composition (compositionstart active)', async () => {
    const { container, editor } = renderControls();
    // The composer attaches composition listeners via addEventListener, so
    // dispatch native composition events (testing-library's fireEvent does not
    // reach raw addEventListener listeners for these in jsdom).
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    typeInto(editor, ';dep');
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.controls-alias-picker')).toBeNull();

    // After composition ends, a fresh input opens it.
    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    typeInto(editor, ';dep');
    await waitFor(() => expect(container.querySelector('.controls-alias-picker')).toBeTruthy());
  });

  it('is suppressed on paste (paste ending in ;name does not open the picker)', async () => {
    const { container, editor } = renderControls();
    // Simulate a paste of text ending in ";dep": the paste handler sets the
    // suppress flag before the resulting input event fires.
    const clipboardData = { getData: () => 'hello ;dep', files: [] };
    editor.textContent = 'hello ;dep';
    fireEvent.paste(editor, { clipboardData });
    fireEvent.input(editor);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.controls-alias-picker')).toBeNull();
  });

  it('falls through to send on Enter when the open picker has no matches', async () => {
    const { ws, editor, container } = renderControls();
    // `;zzz` opens the trigger but matches no alias name/description.
    typeInto(editor, ';zzz');
    await waitFor(() => {
      const picker = container.querySelector('.controls-alias-picker');
      expect(picker).toBeTruthy();
      expect(picker!.textContent).toContain('alias.no_results');
    });
    fireEvent.keyDown(editor, { key: 'Enter' });
    // No results → the picker does not claim Enter → normal send proceeds.
    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect(payload.text).toBe(';zzz');
  });

  it('does not send on Enter while the picker is open; instead inserts the marker', async () => {
    const { ws, editor, container } = renderControls();
    typeInto(editor, ';dep');
    await waitFor(() => expect(container.querySelector('.controls-alias-picker')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    // Enter is claimed by the picker → no send fired.
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.controls-alias-picker')).toBeNull());
  });
});

describe('matchInlineAliasTrigger (unit)', () => {
  it('matches a word-boundary ; + name chars', () => {
    expect(matchInlineAliasTrigger(';dep')).toBe('dep');
    expect(matchInlineAliasTrigger('hi ;deploy')).toBe('deploy');
    expect(matchInlineAliasTrigger('win服务器'.replace(/.*/, ';win服务器'))).toBe('win服务器');
  });
  it('does not match without a boundary, a bare ;, or a marker prefix', () => {
    expect(matchInlineAliasTrigger('abc;dep')).toBeNull(); // glued to a word
    expect(matchInlineAliasTrigger('hello ;')).toBeNull(); // no name char yet
    expect(matchInlineAliasTrigger('a ;;x')).toBeNull();   // ;; marker prefix
    expect(matchInlineAliasTrigger(';bad:name')).toBeNull(); // ':' not a name char at tail
  });
});
