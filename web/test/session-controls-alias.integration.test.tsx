/**
 * @vitest-environment jsdom
 *
 * SessionControls alias send-path INTEGRATION coverage (audit findings
 * Cx1-2 / Cx1-3 / Cx1-4, per Cx1-5's "use the real hook" mandate).
 *
 * Unlike session-controls-alias.test.tsx (which mocks `useAliases`), this test
 * drives the REAL `useAliases` hook with the network mocked at the `apiFetch`
 * layer, so the cross-layer send contract is exercised end-to-end:
 *
 *  - a send whose OWN composed body carries `;;(name)` puts the resolved
 *    name→value map in `resolvedAliases` (Cx1-2);
 *  - a `;;(name)` that appears ONLY inside a quoted segment does NOT resolve
 *    (Cx1-3) — the quote is concatenated AFTER body resolution;
 *  - when the alias list failed to load, a marker-bearing send is BLOCKED
 *    (no send, no empty/stale map) and surfaces a recoverable warning (Cx1-4).
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

// Mock ONLY the network primitive; the real alias API client + real useAliases
// hook + real shared resource all run.
const apiFetchMock = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/api.js')>();
  return { ...orig, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

import { SessionControls } from '../src/components/SessionControls.js';
import { __resetAliasesForTests } from '../src/hooks/useAliases.js';
import { ApiError } from '../src/api.js';

function entry(name: string, value: string, description = ''): AliasEntry {
  return { name, value, description, tags: [], createdAt: '', updatedAt: '', source: 'web' };
}

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

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); __resetAliasesForTests(); });

describe('SessionControls alias send (real useAliases, apiFetch mocked)', () => {
  it('Cx1-2: a body marker rides resolvedAliases once the list has loaded', async () => {
    apiFetchMock.mockResolvedValue({ aliases: [entry('deploy', 'ssh root@host && restart')] });
    const { ws, editor } = renderControls();
    // Let the shared resource resolve the list before composing.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    typeInto(editor, 'run ;;(deploy) now');
    await waitFor(() => expect(editor.textContent).toContain(';;(deploy)'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect(payload.text).toBe('run ;;(deploy) now'); // markers kept, not expanded
    expect(payload.resolvedAliases).toEqual({ deploy: 'ssh root@host && restart' });
  });

  it('Cx1-3: a marker that appears ONLY inside a quote does NOT resolve', async () => {
    apiFetchMock.mockResolvedValue({ aliases: [entry('secret', 'TOP-SECRET-VALUE')] });
    // The quote references ;;(secret); the user's own body does NOT.
    const { ws, editor } = renderControls({ quotes: ['please run ;;(secret) here'] });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    typeInto(editor, 'thoughts?');
    await waitFor(() => expect(editor.textContent).toContain('thoughts?'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    // The quoted marker is transported literally in the text...
    expect(payload.text).toContain(';;(secret)');
    // ...but its value must NOT be pulled into resolvedAliases (no leak).
    expect('resolvedAliases' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('TOP-SECRET-VALUE');
  });

  it('Cx1-3: same body marker DOES resolve even when a quote is present', async () => {
    apiFetchMock.mockResolvedValue({ aliases: [entry('deploy', 'ssh root@host')] });
    const { ws, editor } = renderControls({ quotes: ['unrelated quoted context'] });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    typeInto(editor, 'do ;;(deploy)');
    await waitFor(() => expect(editor.textContent).toContain(';;(deploy)'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect(payload.resolvedAliases).toEqual({ deploy: 'ssh root@host' });
    // The quote is present in the transported text (concatenated after resolution).
    expect(payload.text).toContain('unrelated quoted context');
  });

  it('Cx1-4: a marker-bearing send is BLOCKED when the alias list failed to load', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(500, '{"error":"boom"}'));
    const { ws, editor } = renderControls();
    // Wait for the failed fetch to settle so the hook reports an error.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    typeInto(editor, 'run ;;(deploy) now');
    await waitFor(() => expect(editor.textContent).toContain(';;(deploy)'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    // The send is blocked (no literal-marker send with an empty map)...
    await new Promise((r) => setTimeout(r, 30));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    // ...and a recoverable warning is shown via the shared send-warning path.
    await waitFor(() => {
      const html = (editor.ownerDocument.body.textContent ?? '');
      expect(html).toContain('alias.error.list_unavailable');
    });
  });

  it('a plain (marker-free) send is never blocked even if the list failed to load', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(500, '{"error":"boom"}'));
    const { ws, editor } = renderControls();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    typeInto(editor, 'just a plain message');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ws.sendSessionCommand).toHaveBeenCalled());
    const [, payload] = ws.sendSessionCommand.mock.calls[0];
    expect('resolvedAliases' in payload).toBe(false);
  });
});
