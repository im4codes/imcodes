import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MachineDirectoryWsAdapter } from '../src/machine-directory-ws-adapter.js';

/**
 * `asWsClient()` casts through `unknown`, so TypeScript checks nothing about
 * whether this adapter can actually stand in for a `WsClient`. A consumer that
 * reaches a missing method does not degrade -- it throws a `TypeError` during
 * render, which unmounts the surrounding tree. That was observed in production
 * as repeated remote-desktop toolbars stacking up after
 * `onDaemonCapabilitySnapshot is not a function`.
 *
 * So the contract is checked here instead, and against the REAL call sites: a
 * hand-maintained list of method names would drift out of date exactly when it
 * mattered.
 */

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
);

/** Every `ws.<name>(` called in a source file. */
function wsMethodsCalledIn(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/\bws\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]),
  )].sort();
}

// FileBrowser is what the adapter is handed to; FileEditor is what FileBrowser
// forwards the same `ws` down to.
const CONSUMERS = {
  'FileBrowser.tsx': read('../src/components/FileBrowser.tsx'),
  'FileEditor.tsx': read('../src/components/FileEditor.tsx'),
};

describe('the directory adapter satisfies everything its consumers call', () => {
  const adapter = new MachineDirectoryWsAdapter('srv-test') as unknown as Record<string, unknown>;

  for (const [name, source] of Object.entries(CONSUMERS)) {
    const called = wsMethodsCalledIn(source);

    it(`implements every ws method ${name} calls`, () => {
      expect(called.length, `no ws.* calls found in ${name} -- the scan broke`)
        .toBeGreaterThan(0);
      const missing = called.filter((method) => typeof adapter[method] !== 'function');
      expect(missing, `${name} would crash the render tree on these`).toEqual([]);
    });
  }

  it('answers the daemon capability probe instead of throwing', () => {
    // The specific method that took the tree down. A directory-only adapter
    // genuinely has no daemon socket, so "no snapshot" is the honest answer --
    // and it is the same one a real client gives before daemon.hello arrives.
    const client = new MachineDirectoryWsAdapter('srv-test').asWsClient();
    expect(client.getDaemonCapabilitySnapshot()).toBeNull();

    const seen: unknown[] = [];
    const unsubscribe = client.onDaemonCapabilitySnapshot((snapshot) => seen.push(snapshot));
    expect(seen, 'consumers expect a synchronous first report').toEqual([null]);
    expect(typeof unsubscribe, 'must return an unsubscribe, not undefined').toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('still refuses to silently pretend for methods it truly lacks', () => {
    // The point is not "stub everything". Only calls with an honest answer are
    // implemented; this asserts the adapter has not quietly grown into a fake
    // WsClient that swallows real transport calls.
    const client = new MachineDirectoryWsAdapter('srv-test') as unknown as Record<string, unknown>;
    expect(typeof client.send, 'sending is not something this adapter can do').not.toBe('function');
  });
});
