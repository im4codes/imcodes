import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeServerOrigin, ServerStore } from '../src/servers.js';

describe('normalizeServerOrigin and ServerStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-servers-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes valid https and loopback http URLs to exact origins', () => {
    expect(normalizeServerOrigin('  https://app.im.codes/sessions/123?foo=bar#hash  ')).toBe('https://app.im.codes');
    expect(normalizeServerOrigin('https://team.im.codes:8443/workspace')).toBe('https://team.im.codes:8443');
    expect(normalizeServerOrigin('http://localhost:3000/login')).toBe('http://localhost:3000');
    expect(normalizeServerOrigin('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(normalizeServerOrigin('http://[::1]:5173/app')).toBe('http://[::1]:5173');
  });

  it('rejects non-loopback http, dangerous schemes, credentials, and malformed URLs', () => {
    for (const bad of [
      '',
      '   ',
      'not a url',
      'http://app.im.codes',
      'http://192.168.1.50:3000',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'ftp://files.im.codes',
      'https://user:pass@app.im.codes',
      'https://token@app.im.codes',
    ]) {
      expect(() => normalizeServerOrigin(bad)).toThrow();
    }
  });

  it('persists normalized servers, manages lastOrigin, and sanitizes corrupt or untrusted disk state', () => {
    const store = new ServerStore(tempDir);
    expect(store.list()).toEqual([]);
    expect(store.getLastOrigin()).toBeNull();
    expect(store.trustedOrigins().size).toBe(0);

    const added1 = store.addServer('https://one.im.codes/chat?x=1', 'Primary');
    expect(added1.origin).toBe('https://one.im.codes');
    expect(added1.label).toBe('Primary');
    expect(store.getLastOrigin()).toBe('https://one.im.codes');

    const added2 = store.addServer('http://localhost:5173/', 'Local Dev');
    expect(added2.origin).toBe('http://localhost:5173');
    store.setLastOrigin('http://localhost:5173');
    expect(() => store.setLastOrigin('https://evil.example')).toThrow(/Untrusted origin/);

    // Reload from disk verifies persistence
    const reloaded = new ServerStore(tempDir);
    expect(reloaded.list().map((s) => s.origin)).toEqual(['https://one.im.codes', 'http://localhost:5173']);
    expect(reloaded.getLastOrigin()).toBe('http://localhost:5173');
    expect(reloaded.trustedOrigins()).toEqual(new Set(['https://one.im.codes', 'http://localhost:5173']));

    // Removing lastOrigin falls back to remaining server
    expect(reloaded.removeServer('http://localhost:5173/subpath')).toBe(true);
    expect(reloaded.getLastOrigin()).toBe('https://one.im.codes');
    expect(reloaded.removeServer('https://missing.example')).toBe(false);

    // Corrupt / tampered entries in servers.json are dropped safely on load
    const filePath = path.join(tempDir, 'servers.json');
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        lastOrigin: 'http://evil.example',
        servers: [
          { origin: 'http://evil.example', label: 'Bad HTTP' },
          { origin: 'https://valid.im.codes/extra', label: 'Good HTTPS' },
        ],
      }),
    );
    const sanitized = new ServerStore(tempDir);
    expect(sanitized.list().map((s) => s.origin)).toEqual(['https://valid.im.codes']);
    expect(sanitized.getLastOrigin()).toBe('https://valid.im.codes');

    writeFileSync(filePath, '{not json');
    const recovered = new ServerStore(tempDir);
    expect(recovered.list()).toEqual([]);
    expect(recovered.getLastOrigin()).toBeNull();
  });
});
