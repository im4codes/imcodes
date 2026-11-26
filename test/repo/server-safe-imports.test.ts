import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// src/repo is compiled into the server image (server/Dockerfile COPYs only
// src/repo). An import of daemon code from here (e.g. src/util/exec-helper,
// which pulls in the Windows lock and watchdog .mjs) breaks the server build and
// its module-load check. Keep src/repo on node builtins and its own files.
describe('src/repo stays server-safe', () => {
  it('imports only node builtins and sibling files', () => {
    const dir = join(process.cwd(), 'src', 'repo');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1]!;
        if (spec.startsWith('node:') || spec.startsWith('./')) continue;
        offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
