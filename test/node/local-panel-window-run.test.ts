import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_PANEL_WINDOW_STATE_FILE } from '../../shared/local-panel-window.js';
import { createLocalPanelWindowPlatform, createLocalPanelWindowRecordStore, probeLocalPanel } from '../../src/node/local-panel-window-run.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'imcodes-localpanel-tsk_7263ca54b1-')); roots.push(dir); return dir; };

describe('the single-instance record store', () => {
  it('round-trips in the given directory and clears; a missing or unwritable directory is only a lost cache', () => {
    const dir = tempDir();
    const store = createLocalPanelWindowRecordStore(dir);
    expect(store.read()).toBeUndefined();
    store.write('{"pid":1}');
    expect(readFileSync(join(dir, LOCAL_PANEL_WINDOW_STATE_FILE), 'utf8')).toBe('{"pid":1}');
    expect(store.read()).toBe('{"pid":1}');
    store.clear();
    expect(store.read()).toBeUndefined();
    store.clear(); // clearing twice is fine
    const blocker = join(dir, 'file-not-dir');
    writeFileSync(blocker, 'x');
    const unwritable = createLocalPanelWindowRecordStore(join(blocker, 'nested'));
    expect(() => unwritable.write('x')).not.toThrow();
    expect(unwritable.read()).toBeUndefined();
  });
});

describe('platform selection', () => {
  it('has an adapter for Windows, macOS and Linux and none for anything else', () => {
    expect(createLocalPanelWindowPlatform('win32')?.platform).toBe('win32');
    expect(createLocalPanelWindowPlatform('darwin')?.platform).toBe('darwin');
    expect(createLocalPanelWindowPlatform('linux')?.platform).toBe('linux');
    expect(createLocalPanelWindowPlatform('freebsd')).toBeUndefined();
  });
});

describe('probeLocalPanel', () => {
  it('is true while something answers on the port, false once it is closed, and false when it never answers', async () => {
    const server = createServer((_request, response) => { response.statusCode = 200; response.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    expect(await probeLocalPanel(500, port)).toBe(true);
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    expect(await probeLocalPanel(500, port)).toBe(false);
    const silent = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as { port: number }).port;
    expect(await probeLocalPanel(150, silentPort)).toBe(false);
    await new Promise<void>((resolve) => { silent.closeAllConnections?.(); silent.close(() => resolve()); });
  });
});
