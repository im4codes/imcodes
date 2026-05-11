import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const apiSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/api.ts'), 'utf8');

const daemonRouteTerms = [
  'local-web',
  'local-web-preview',
  'p2p/runs',
  'session/cancel',
  'session/send',
  'sessions/',
  'shared-context/runtime-config',
  'sub-sessions',
  'timeline/history',
  'timeline/text-tail',
  'upload',
  'uploads/',
];

function isRouteConstructionLine(line: string): boolean {
  return line.includes('apiFetch')
    || line.includes('rawFetch')
    || line.includes('xhr.open')
    || line.includes('downloadUrl')
    || line.includes('new URL');
}

describe('daemon-dependent API routing contract', () => {
  it('keeps daemon-dependent frontend paths server-scoped', () => {
    const violations = apiSource
      .split('\n')
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => isRouteConstructionLine(line))
      .filter(({ line }) => daemonRouteTerms.some((term) => line.includes(term)))
      .filter(({ line }) => !line.includes('/api/server/'))
      .map(({ line, lineNumber }) => `${lineNumber}: ${line.trim()}`);

    expect(violations).toEqual([]);
  });

  it('documents the explicit server-scoped daemon route surfaces in api.ts', () => {
    for (const term of daemonRouteTerms) {
      expect(apiSource).toContain(term);
    }
  });
});
