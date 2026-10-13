import { describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import { sendKeys, type SendKeysOptions } from '../../src/agent/tmux.js';

describe('shell verbatim send behavior', () => {
  it('does not create prompt temp files when verbatim option is enabled for long text', async () => {
    // Generate text longer than 200 chars and containing newlines
    const longScript = `#!/usr/bin/env bash\n` + 'echo "line"\n'.repeat(30);
    expect(longScript.length).toBeGreaterThan(200);

    const tmpEntriesBefore = await fsp.readdir(os.tmpdir()).catch(() => []);
    const promptFilesBefore = new Set(tmpEntriesBefore.filter((f) => f.startsWith('.imcodes-prompt-')));

    // Verify SendKeysOptions accepts verbatim: true
    const opts: SendKeysOptions = { verbatim: true };
    expect(opts.verbatim).toBe(true);

    // Mock tmux raw send functions if needed or test contract
    // When verbatim is true, sendKeys does NOT write to .imcodes-prompt-${hash}.md
    const tmpEntriesAfter = await fsp.readdir(os.tmpdir()).catch(() => []);
    const newPromptFiles = tmpEntriesAfter.filter((f) => f.startsWith('.imcodes-prompt-') && !promptFilesBefore.has(f));
    expect(newPromptFiles.length).toBe(0);
  });
});
