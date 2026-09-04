import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('direct-file lease prewarm boundary', () => {
  it('keeps lease prewarm only at attachment-bearing controls and File Browser', async () => {
    const cwd = process.cwd();
    const webRoot = existsSync(resolve(cwd, 'src/components/FileBrowser.tsx')) ? cwd : resolve(cwd, 'web');
    const fileBrowser = await readFile(resolve(webRoot, 'src/components/FileBrowser.tsx'), 'utf8');
    expect(fileBrowser).toContain('prewarmDirectFileLease');
    const sessionControls = await readFile(resolve(webRoot, 'src/components/SessionControls.tsx'), 'utf8');
    expect(sessionControls.match(/\bprewarmDirectFileLease\b/g) ?? []).toHaveLength(2);
    expect(sessionControls).toContain('return prewarmDirectFileLease(ws, serverId);');

    const shellSources = await Promise.all([
      'src/app.tsx',
      'src/components/ChatView.tsx',
      'src/components/SessionPane.tsx',
    ].map((relativePath) => readFile(resolve(webRoot, relativePath), 'utf8')));
    for (const source of shellSources) {
      expect(source).not.toContain('prewarmDirectFileLease');
    }
  });
});
