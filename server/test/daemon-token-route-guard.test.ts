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

describe('daemon route inventory guards', () => {
  it('every daemon source API path and imported shared path has explicit admission', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(resolve(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const name = relative(root, file);
      for (const use of [...scanApiPaths(name, text), ...scanImportedApiPaths(file, text).map(u => ({ ...u, file: name }))]) {
        if (isNonDaemonApiUse(use)) continue;
        const path = normalized(use.path);
        if (!DAEMON_TOKEN_ROUTES.some(route => (!use.method || route.method === use.method)
          && (normalized(route.path) === path || normalized(route.path).startsWith(`${path}/`)))) {
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
  });
});
