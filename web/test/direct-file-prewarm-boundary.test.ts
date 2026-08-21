import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('direct-file lease prewarm boundary', () => {
  it('keeps lease prewarm in File Browser and out of chat/session shell surfaces', async () => {
    const cwd = process.cwd();
    const webRoot = existsSync(resolve(cwd, 'src/components/FileBrowser.tsx')) ? cwd : resolve(cwd, 'web');
    const fileBrowser = await readFile(resolve(webRoot, 'src/components/FileBrowser.tsx'), 'utf8');
    expect(fileBrowser).toContain('prewarmDirectFileLease');

    const chatAndShellSources = await Promise.all([
      'src/app.tsx',
      'src/components/ChatView.tsx',
      'src/components/SessionPane.tsx',
      'src/components/SessionControls.tsx',
    ].map((relativePath) => readFile(resolve(webRoot, relativePath), 'utf8')));
    for (const source of chatAndShellSources) {
      expect(source).not.toContain('prewarmDirectFileLease');
    }
  });
});
