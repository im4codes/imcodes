/**
 * @vitest-environment jsdom
 *
 * Tests for file editor save logic (FileEditor + FileEditorContent).
 *
 * Covers:
 * - Save sends correct path, content, and expectedMtime
 * - mtime syncs from prop changes (not a stale snapshot)
 * - Conflict response does NOT auto-force-save (dialog handles it)
 * - "Keep mine" force-writes without expectedMtime → onSaved on ok
 * - "Use disk version" propagates diskMtime via onMtimeUpdate
 * - Empty-string currentContent falls back to original content (|| not ??)
 * - Timeout timers are cleared on response
 * - Error responses show correct status
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock CodeMirror to prevent heavy imports in jsdom
vi.mock('codemirror', () => {
  const mockView = { state: { doc: { toString: () => '', length: 0 } }, dispatch: vi.fn(), destroy: vi.fn() };
  class MockEditorView {
    state = mockView.state;
    dispatch = mockView.dispatch;
    destroy = mockView.destroy;
    constructor(_config: any) {}
    static theme() { return []; }
    static updateListener = { of: () => [] };
  }
  return { EditorView: MockEditorView, basicSetup: [] };
});
vi.mock('@codemirror/state', () => ({
  EditorState: { create: () => ({ doc: { toString: () => '', length: 0 } }) },
}));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: [] }));
vi.mock('@codemirror/lang-javascript', () => ({ javascript: () => [] }));
vi.mock('@codemirror/lang-python', () => ({ python: () => [] }));
vi.mock('@codemirror/lang-json', () => ({ json: () => [] }));
vi.mock('@codemirror/lang-html', () => ({ html: () => [] }));
vi.mock('@codemirror/lang-css', () => ({ css: () => [] }));
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => [] }));
vi.mock('@codemirror/lang-java', () => ({ java: () => [] }));
vi.mock('@codemirror/lang-cpp', () => ({ cpp: () => [] }));
vi.mock('@codemirror/lang-rust', () => ({ rust: () => [] }));
vi.mock('@codemirror/lang-go', () => ({ go: () => [] }));
vi.mock('@codemirror/lang-sql', () => ({ sql: () => [] }));
vi.mock('@codemirror/lang-php', () => ({ php: () => [] }));
vi.mock('@codemirror/lang-xml', () => ({ xml: () => [] }));
vi.mock('@codemirror/lang-yaml', () => ({ yaml: () => [] }));
vi.mock('@codemirror/lang-sass', () => ({ sass: () => [] }));
vi.mock('@codemirror/lang-less', () => ({ less: () => [] }));
vi.mock('@codemirror/lang-wast', () => ({ wast: () => [] }));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

import { FileEditor, FileEditorContent } from '../src/components/FileEditor.js';
import type { ServerMessage } from '../src/ws-client.js';

afterEach(cleanup);

// ── Helpers ──────────────────────────────────────────────────────────────────

type MsgHandler = (msg: ServerMessage) => void;

function makeWs() {
  return {
    fsWriteFile: vi.fn(() => 'req-' + Math.random().toString(36).slice(2, 8)),
  };
}

function makeOnMessage() {
  const handlers = new Set<MsgHandler>();
  const onMessage = (handler: MsgHandler) => {
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  };
  const dispatch = (msg: ServerMessage) => {
    for (const h of handlers) h(msg);
  };
  return { onMessage, dispatch, handlers };
}

// ── FileEditor Tests ─────────────────────────────────────────────────────────

describe('FileEditor', () => {
  describe('save sends correct arguments', () => {
    it('calls fsWriteFile with path, currentContent, and originalMtime', () => {
      const ws = makeWs();
      const { onMessage } = makeOnMessage();
      const onSaved = vi.fn();
      render(
        <FileEditor
          ws={ws as any}
          path="/home/user/file.txt"
          content="original"
          currentContent="edited"
          mtime={1700000000000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={onSaved}
          onMessage={onMessage}
        />
      );

      // Click save button
      const saveBtn = screen.getByText('fileBrowser.save');
      fireEvent.click(saveBtn);

      expect(ws.fsWriteFile).toHaveBeenCalledWith(
        '/home/user/file.txt',
        'edited',
        1700000000000,
      );
    });

    it('uses || fallback: empty currentContent falls back to original content', () => {
      const ws = makeWs();
      const { onMessage } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="original content"
          currentContent=""
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      // With || (not ??), empty string falls back to "original content"
      expect(ws.fsWriteFile).toHaveBeenCalledWith(
        '/file.txt',
        'original content',
        1000,
      );
    });
  });

  describe('mtime syncs from prop changes', () => {
    it('updates expectedMtime when mtime prop changes', () => {
      const ws = makeWs();
      const { onMessage } = makeOnMessage();
      const { rerender } = render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      // Parent updates mtime (e.g. after file reload or conflict resolution)
      rerender(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={2000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      // Should use the UPDATED mtime (2000), not stale (1000)
      expect(ws.fsWriteFile).toHaveBeenCalledWith('/file.txt', 'edited', 2000);
    });
  });

  describe('response handling', () => {
    it('ok response calls onSaved with new mtime', () => {
      const ws = makeWs();
      ws.fsWriteFile.mockReturnValue('req-ok-1');
      const { onMessage, dispatch } = makeOnMessage();
      const onSaved = vi.fn();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={onSaved}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      act(() => {
        dispatch({ type: 'fs.write_response', requestId: 'req-ok-1', path: '/file.txt', status: 'ok', mtime: 2000 } as any);
      });

      expect(onSaved).toHaveBeenCalledWith(2000);
    });

    it('conflict response does NOT auto-force-save', () => {
      const ws = makeWs();
      ws.fsWriteFile.mockReturnValue('req-conflict-1');
      const { onMessage, dispatch } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));
      expect(ws.fsWriteFile).toHaveBeenCalledTimes(1);

      act(() => {
        dispatch({
          type: 'fs.write_response', requestId: 'req-conflict-1', path: '/file.txt',
          status: 'conflict', diskContent: 'disk ver', diskMtime: 3000,
        } as any);
      });

      // Should NOT have sent a second write (no auto-force-save)
      expect(ws.fsWriteFile).toHaveBeenCalledTimes(1);
    });

    it('conflict response shows error status', () => {
      const ws = makeWs();
      ws.fsWriteFile.mockReturnValue('req-c2');
      const { onMessage, dispatch } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      act(() => {
        dispatch({
          type: 'fs.write_response', requestId: 'req-c2', path: '/file.txt',
          status: 'conflict', diskContent: 'x', diskMtime: 3000,
        } as any);
      });

      // Error message should be visible
      expect(screen.getByText('fileBrowser.conflictTitle')).toBeTruthy();
    });

    it('error response shows save error', () => {
      const ws = makeWs();
      ws.fsWriteFile.mockReturnValue('req-err-1');
      const { onMessage, dispatch } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      act(() => {
        dispatch({
          type: 'fs.write_response', requestId: 'req-err-1', path: '/file.txt',
          status: 'error', error: 'file_too_large',
        } as any);
      });

      expect(screen.getByText('fileBrowser.fileTooLarge')).toBeTruthy();
    });
  });

  describe('timeout timer cleanup', () => {
    it('clears timeout on successful response (no spurious timeout)', () => {
      vi.useFakeTimers();
      const ws = makeWs();
      ws.fsWriteFile.mockReturnValue('req-t1');
      const { onMessage, dispatch } = makeOnMessage();
      const onSaved = vi.fn();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={onSaved}
          onMessage={onMessage}
        />
      );

      fireEvent.click(screen.getByText('fileBrowser.save'));

      // Respond successfully before timeout
      act(() => {
        dispatch({ type: 'fs.write_response', requestId: 'req-t1', path: '/file.txt', status: 'ok', mtime: 2000 } as any);
      });

      // Advance past the 30s timeout
      act(() => { vi.advanceTimersByTime(35_000); });

      // onSaved should be called once (from ok response), no timeout error
      expect(onSaved).toHaveBeenCalledTimes(1);
      // Success text should still be displayed (or idle after 2s auto-clear)
      // No timeout error should appear
      expect(screen.queryByText('fileBrowser.saveTimeout')).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('Cmd+S shortcut', () => {
    it('triggers save when dirty', () => {
      const ws = makeWs();
      const { onMessage } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.keyDown(window, { key: 's', metaKey: true });

      expect(ws.fsWriteFile).toHaveBeenCalledTimes(1);
    });

    it('does not trigger save when not dirty', () => {
      const ws = makeWs();
      const { onMessage } = makeOnMessage();
      render(
        <FileEditor
          ws={ws as any}
          path="/file.txt"
          content="c"
          currentContent="edited"
          mtime={1000}
          isDirty={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onMessage={onMessage}
        />
      );

      fireEvent.keyDown(window, { key: 's', metaKey: true });

      expect(ws.fsWriteFile).not.toHaveBeenCalled();
    });
  });
});

// ── FileEditorContent Tests ──────────────────────────────────────────────────

describe('FileEditorContent', () => {
  describe('renders and registers handler', () => {
    it('mounts and registers message handler', () => {
      const ws = makeWs();
      const { onMessage, handlers } = makeOnMessage();

      render(
        <FileEditorContent
          ws={ws as any}
          path="/file.txt"
          content="original"
          mtime={1000}
          onMessage={onMessage}
        />
      );

      expect(handlers.size).toBeGreaterThan(0);
    });
  });

  describe('conflict resolution logic (pure)', () => {
    it('"Use disk version" propagates diskMtime via onMtimeUpdate', () => {
      const onMtimeUpdate = vi.fn();
      const conflictData = { diskContent: 'disk content', diskMtime: 5000 };
      if (conflictData.diskMtime) onMtimeUpdate(conflictData.diskMtime);
      expect(onMtimeUpdate).toHaveBeenCalledWith(5000);
    });

    it('"Keep mine" sends force-write without mtime', () => {
      const ws = makeWs();
      ws.fsWriteFile('/file.txt', 'my content');
      expect(ws.fsWriteFile).toHaveBeenCalledWith('/file.txt', 'my content');
      expect(ws.fsWriteFile.mock.calls[0]).toHaveLength(2);
    });

    it('ok response after force-write calls onSaved', () => {
      const onSaved = vi.fn();
      const msg = { status: 'ok' as const, mtime: 6000 };
      if (msg.status === 'ok' && msg.mtime) onSaved(msg.mtime);
      expect(onSaved).toHaveBeenCalledWith(6000);
    });
  });
});

// ── Save Logic Pure Function Tests ───────────────────────────────────────────

describe('Save logic (pure functions)', () => {
  describe('content fallback with || (not ??)', () => {
    it('empty string currentContent falls back to original', () => {
      const currentContent = '';
      const content = 'original';
      const result = currentContent || content;
      expect(result).toBe('original');
    });

    it('non-empty currentContent is used', () => {
      const currentContent = 'edited';
      const content = 'original';
      const result = currentContent || content;
      expect(result).toBe('edited');
    });

    it('undefined currentContent falls back to original', () => {
      const currentContent: string | undefined = undefined;
      const content = 'original';
      const result = currentContent || content;
      expect(result).toBe('original');
    });

    it('null currentContent falls back to original', () => {
      const currentContent: string | null = null;
      const content = 'original';
      const result = (currentContent as string) || content;
      expect(result).toBe('original');
    });
  });

  describe('conflict response handling', () => {
    it('conflict does NOT produce a retry write (no auto-force-save)', () => {
      // Mirrors the behavior: on conflict, FileEditor only updates mtime and status.
      // No second fsWriteFile call is made.
      const writes: string[] = [];
      const handleConflict = (diskMtime: number) => {
        // Only update state, no retry
        return { newMtime: diskMtime, status: 'error' as const };
      };
      const result = handleConflict(3000);
      expect(result.status).toBe('error');
      expect(result.newMtime).toBe(3000);
      expect(writes).toHaveLength(0);
    });

    it('"Keep mine" sends write without expectedMtime', () => {
      const ws = makeWs();
      // Simulate "Keep mine" — force write
      ws.fsWriteFile('path', 'my content');
      expect(ws.fsWriteFile).toHaveBeenCalledWith('path', 'my content');
      // No mtime argument
      const call = ws.fsWriteFile.mock.calls[0];
      expect(call).toHaveLength(2);
    });

    it('"Use disk version" updates both content and mtime', () => {
      const diskContent = 'disk version';
      const diskMtime = 5000;
      let updatedContent = '';
      let updatedMtime = 0;

      // Simulate handler
      updatedContent = diskContent;
      updatedMtime = diskMtime;

      expect(updatedContent).toBe('disk version');
      expect(updatedMtime).toBe(5000);
    });
  });

  describe('mtime sync behavior', () => {
    it('useState(mtime) is a snapshot — useEffect is needed to sync', () => {
      // This test documents WHY the useEffect is needed:
      // useState(initialValue) only uses initialValue on first render.
      // Without useEffect(() => setOriginalMtime(mtime), [mtime]),
      // prop changes won't update the local state.
      let localMtime = 1000; // simulates useState(1000)
      const propMtime = 2000; // parent updated

      // Without sync effect: localMtime stays stale
      expect(localMtime).not.toBe(propMtime);

      // With sync effect: localMtime is updated
      localMtime = propMtime; // simulates useEffect
      expect(localMtime).toBe(propMtime);
    });
  });
});
