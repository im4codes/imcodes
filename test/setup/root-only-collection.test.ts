import { describe, expect, it } from 'vitest';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../../vitest.config.js';
import serverConfig from '../../server/vitest.config.js';
import { execFileSync } from 'node:child_process';
import { runtimeImports } from '../helpers/root-only-runtime-imports.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const daemon = config.test!.projects![0] as { test: { include: string[]; exclude: string[] } };
const rootServer = config.test!.projects![2] as { test: { include: string[]; exclude: string[] } };
const files = (test: { include?: string[]; exclude?: string[] }) => globSync(test.include!, {
  cwd: root, exclude: test.exclude,
}).map(file => file.replaceAll('\\', '/'));

// Keep the whole-graph AST allocation outside a reused test worker (and its V8
// coverage instrumentation). This is one pure analysis child, NOT a nested suite.
const rootOnlyRuntimeDependencies = (root: string, entries: string[]) => JSON.parse(execFileSync(
  process.execPath,
  ['--max-old-space-size=512', '--import', 'tsx',
    fileURLToPath(new URL('../helpers/root-only-runtime-import-worker.ts', import.meta.url))],
  { cwd: root, input: JSON.stringify({ root, entries }), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 },
)) as { missing: { specifier: string; file: string }[]; files: number; serverFiles: number };

describe('root-only daemon collection boundary', () => {
  it('all actual daemon entries resolve their static server dependencies from root alone', () => {
    const start = performance.now();
    const entries = files(daemon.test);
    const graph = rootOnlyRuntimeDependencies(root, entries);
    expect(entries.length).toBeGreaterThan(1000);
    expect(graph.missing).toEqual([]);
    // Diagnostic only: no wall-clock threshold or repeated suite execution.
    console.log(JSON.stringify({ entries: entries.length, ...graph, elapsedMs: performance.now() - start }));
  });

  it('the full server app is a causal counterexample even with server deps installed', () => {
    const graph = rootOnlyRuntimeDependencies(root, ['server/src/index.ts']);
    expect(graph.missing.map(entry => entry.specifier)).toContain('node-cron');
  });

  it('collects the HTTP/skew case exactly in the server-native suite, not daemon/root-server', () => {
    const target = 'server/test/daemon-token-version-skew.test.ts';
    expect(files(daemon.test)).not.toContain(target);
    expect(files(rootServer.test)).not.toContain(target);
    const native = globSync(serverConfig.test!.include!, {
      cwd: `${root}/server`, exclude: serverConfig.test!.exclude,
    });
    expect(native).toContain('test/daemon-token-version-skew.test.ts');
  });

  it('ignores comments, literal text, and erased imports but follows side effects and mixed imports', () => {
    expect(runtimeImports(`
      // import 'comment-only';
      const description = "import 'literal-only'";
      import type { Env } from 'erased';
      import { type Env } from 'erased-named';
      export type { Env } from 'erased-export';
      import 'side-effect';
      import {} from 'empty-runtime';
      import { type Env, buildApp } from 'mixed-runtime';
      export { type Env, buildApp } from 'runtime-export';
      import cron = require('runtime-require');
    `)).toEqual(['side-effect', 'empty-runtime', 'mixed-runtime', 'runtime-export', 'runtime-require']);
  });
});
