/**
 * Regression: an unexpected web command must NEVER crash the daemon.
 *
 * Real-world report (2026-05-07): operators saw "imcodes received
 * unexpected commands will crash" — the dispatcher in handleWebCommand
 * had no try/catch around the switch, so a synchronous throw inside a
 * handler (TypeError from accessing a property of undefined, validation
 * throw before the first `await` of an async function, etc.) would
 * propagate out of the WebSocket onMessage callback, hit the global
 * `uncaughtException` handler in src/index.ts, and broadcast a noisy
 * `daemon.error` event to every connected browser.  Daemon stayed
 * technically alive but UI-visibly looked crashed.
 *
 * The fix wraps dispatchWebCommand in try/catch so each bad single
 * command becomes a quiet warn-level log line scoped to its type.
 *
 * This test exercises the dispatch with a variety of malformed inputs
 * a real WebSocket client (or a fuzzer / corrupted client) might send,
 * and asserts:
 *   1. handleWebCommand returns normally for every input — no throw
 *      escapes the dispatcher.
 *   2. The process does not raise an `uncaughtException`.
 *   3. The serverLink passed in does not receive any spurious sends
 *      for inputs that are obviously not valid commands.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the heavyweight modules the dispatcher transitively imports so we
// can load the file under test without booting the entire daemon.
vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(() => null),
  setSession: vi.fn(),
  removeSession: vi.fn(),
  getAllSessions: vi.fn(() => []),
  saveSessions: vi.fn(),
}));

describe('handleWebCommand: malformed inputs do not crash', () => {
  let uncaughtExceptions: unknown[];
  let originalListener: ((err: Error) => void)[] | undefined;

  beforeEach(() => {
    uncaughtExceptions = [];
    // Remove any pre-existing listeners so we get a clean slate.
    originalListener = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (err) => {
      uncaughtExceptions.push(err);
    });
  });

  afterEach(() => {
    process.removeAllListeners('uncaughtException');
    if (originalListener) {
      for (const listener of originalListener) {
        process.on('uncaughtException', listener);
      }
    }
  });

  function makeFakeServerLink() {
    return {
      send: vi.fn(),
      sendBinary: vi.fn(),
      isConnected: vi.fn(() => true),
      close: vi.fn(),
    };
  }

  it('non-object inputs are silently ignored', async () => {
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();

    // None of these should throw.
    expect(() => handleWebCommand(null, link as never)).not.toThrow();
    expect(() => handleWebCommand(undefined, link as never)).not.toThrow();
    expect(() => handleWebCommand('a string', link as never)).not.toThrow();
    expect(() => handleWebCommand(42, link as never)).not.toThrow();
    expect(() => handleWebCommand(true, link as never)).not.toThrow();
    expect(() => handleWebCommand([1, 2, 3], link as never)).not.toThrow();

    expect(uncaughtExceptions).toEqual([]);
    expect(link.send).not.toHaveBeenCalled();
  });

  it('object with no .type field does not throw', async () => {
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();
    expect(() => handleWebCommand({}, link as never)).not.toThrow();
    expect(() => handleWebCommand({ foo: 'bar' }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: undefined }, link as never)).not.toThrow();
    expect(uncaughtExceptions).toEqual([]);
  });

  it('object with non-string .type does not throw', async () => {
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();
    expect(() => handleWebCommand({ type: 42 }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: { nested: 'object' } }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: ['array', 'as', 'type'] }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: null }, link as never)).not.toThrow();
    expect(uncaughtExceptions).toEqual([]);
  });

  it('unknown .type strings are silently ignored', async () => {
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();
    expect(() => handleWebCommand({ type: 'not.a.real.command' }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: 'session.this_does_not_exist' }, link as never)).not.toThrow();
    expect(() => handleWebCommand({ type: '' }, link as never)).not.toThrow();
    expect(uncaughtExceptions).toEqual([]);
    expect(link.send).not.toHaveBeenCalled();
  });

  it('known .type with completely missing payload fields does not crash', async () => {
    // These are the real command types that the most common synchronous
    // crashes used to come from.  A malformed client can send the type
    // with no other fields; the handler must treat missing fields as
    // a no-op or a validation warning, NOT crash the dispatcher.
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();

    const types = [
      'session.start',
      'session.stop',
      'session.send',
      'session.input',
      'session.resize',
      'terminal.subscribe',
      'terminal.unsubscribe',
      'terminal.snapshot_request',
      'timeline.replay_request',
      'timeline.history_request',
      'chat.subscribe',
      'file.upload',
      'file.download',
    ];
    for (const type of types) {
      expect(() => handleWebCommand({ type }, link as never), type).not.toThrow();
    }
    expect(uncaughtExceptions).toEqual([]);
  });

  it('known .type with fields of wrong types does not crash', async () => {
    // Common shape: handler does `cmd.session as string` and then
    // `session.split(...)`.  If session is a number/object, that's
    // a TypeError synchronously — must be swallowed by the dispatcher.
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const link = makeFakeServerLink();

    expect(() => handleWebCommand({
      type: 'terminal.subscribe',
      session: 12345,  // wrong type
    }, link as never)).not.toThrow();

    expect(() => handleWebCommand({
      type: 'session.input',
      sessionName: { not: 'a string' },
      data: null,
    }, link as never)).not.toThrow();

    expect(() => handleWebCommand({
      type: 'session.resize',
      sessionName: 42,
      cols: 'eighty',  // wrong type
      rows: -1,
    }, link as never)).not.toThrow();

    expect(uncaughtExceptions).toEqual([]);
  });

  it('source code retains the dispatch try/catch wrapper', async () => {
    // Source-level invariant: even if the per-handler tests above all
    // pass for a future fork, the structural protection against sync
    // throws must remain in place.  A future maintainer who removes
    // the try/catch wrapper from handleWebCommand sees this test fail
    // before they ship the regression.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/daemon/command-handler.ts', 'utf8');
    const start = src.indexOf('export function handleWebCommand');
    const end = src.indexOf('function dispatchWebCommand', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toContain('try {');
    expect(fn).toContain('dispatchWebCommand(cmd, serverLink)');
    expect(fn).toMatch(/} catch \(err\)/);
    expect(fn).toContain('daemon stays alive');
  });
});
