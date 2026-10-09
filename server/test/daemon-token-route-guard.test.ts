import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/index.js';
import { DAEMON_TOKEN_ROUTES, matchDaemonTokenRoute } from '../../shared/daemon-token-routes.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { scanApiPaths, scanImportedApiPaths, sourceFiles, isNonDaemonApiUse } from '../../test/helpers/daemon-route-inventory.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const normalized = (path: string) => path.replace(/:[^/]+/g, ':param');
const isCovered = (path: string, method?: string, importedPrefix = false) => DAEMON_TOKEN_ROUTES.some(route =>
  (!method || route.method === method) && (normalized(route.path) === normalized(path)
    || (importedPrefix && normalized(route.path).startsWith(`${normalized(path)}/`))));

describe('daemon route inventory guards', () => {
  it('every daemon source API path and imported shared path has explicit admission', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(resolve(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const name = relative(root, file);
      const uses = [
        ...scanApiPaths(name, text).map(use => ({ use, importedPrefix: false })),
        ...scanImportedApiPaths(file, text).map(use => ({ use: { ...use, file: name }, importedPrefix: true })),
      ];
      for (const { use, importedPrefix } of uses) {
        if (isNonDaemonApiUse(use)) continue;
        if (!isCovered(use.path, use.method, importedPrefix)) {
          missing.push(`${name}: ${use.method ?? '(dynamic)'} ${use.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  }, 30_000);

  it('every allowlisted method+path exists in the actual mounted server route table', () => {
    const app = buildApp({ DB: {}, BOT_ENCRYPTION_KEY: 'a'.repeat(32), JWT_SIGNING_KEY: 'test', TRUSTED_PROXIES: '', SERVER_URL: 'http://localhost' } as never);
    const routes = new Set(app.routes.map(r => `${r.method} ${normalized(r.path)}`));
    expect(DAEMON_TOKEN_ROUTES.filter(r => !routes.has(`${r.method} ${normalized(r.path)}`))).toEqual([]);
    expect(new Set(DAEMON_TOKEN_ROUTES.map(r => `${r.method} ${r.path}`)).size).toBe(DAEMON_TOKEN_ROUTES.length);
  });

  it('catches a new literal call, a changed method, and ignores comments', () => {
    expect(scanApiPaths('src/daemon/new.ts', "// fetch('/api/account')\nfetch(`${base}/api/account`, {method: 'POST'})"))
      .toEqual([{ file: 'src/daemon/new.ts', path: '/api/account', method: 'POST' }]);
    expect(matchDaemonTokenRoute('POST', '/api/account', NODE_ROLE.FULL)).toBeUndefined();
    expect(matchDaemonTokenRoute('DELETE', '/api/machines', NODE_ROLE.FULL)).toBeUndefined();
    // An admitted child does not grant a newly introduced literal parent URL.
    expect(isCovered('/api/server/:id', 'GET')).toBe(false);
    expect(isCovered('/api/capabilities/operations', 'GET')).toBe(false);
    expect(isCovered('/api/capabilities/operations', 'GET', true)).toBe(true);
    expect(isCovered('/api/machines', 'DELETE')).toBe(false);
  });
});
