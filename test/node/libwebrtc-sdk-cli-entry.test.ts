import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { isModuleEntry } from '../../scripts/module-entry.mjs';

const repositoryRoot = resolve(__dirname, '..', '..');

/**
 * These scripts are only ever reached as command lines -- by CI steps and by
 * each other, through `execFileSync`. A script that silently declines to run
 * is therefore indistinguishable from one that ran and produced nothing, and
 * the caller blames whatever it was measuring.
 */
describe('libwebrtc SDK command-line entry points', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('runs when invoked through a symlinked path', () => {
    // This is the real case, not a contrived one. SDK promotion computes the
    // fingerprint inside a temporary git worktree, and `os.tmpdir()` on macOS
    // is `/var/folders/...` where `/var` is a symlink to `/private/var`. Node
    // resolves `import.meta.url` through that symlink and leaves
    // `process.argv[1]` as typed, so a guard comparing the two verbatim never
    // matches: the process prints nothing and exits 0.
    //
    // Promotion then read an empty string where a digest belonged and refused
    // with "SDK inputs changed while the SDK was building" -- pointing at the
    // build, while the fingerprint had simply never been computed.
    const root = mkdtempSync(join(tmpdir(), 'imcodes-sdk-entry-'));
    roots.push(root);
    const link = join(root, 'repo');
    symlinkSync(repositoryRoot, link);

    const stdout = execFileSync(
      process.execPath,
      [join(link, 'scripts/libwebrtc-sdk-artifacts.mjs'), 'fingerprint'],
      { encoding: 'utf8', cwd: link },
    ).trim();

    expect(stdout).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('produces the same digest however the script is addressed', () => {
    // A fingerprint that depended on how its own script was spelled would make
    // the SDK's identity a property of the caller's command line.
    const direct = execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts/libwebrtc-sdk-artifacts.mjs'), 'fingerprint'],
      { encoding: 'utf8', cwd: repositoryRoot },
    ).trim();
    const relative = execFileSync(
      process.execPath,
      ['scripts/libwebrtc-sdk-artifacts.mjs', 'fingerprint'],
      { encoding: 'utf8', cwd: repositoryRoot },
    ).trim();
    expect(direct).toBe(relative);
    expect(direct).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not claim to be the entry point when another script is', () => {
    // The inverse matters just as much: a module that runs its CLI on import
    // would execute a side effect every time it is required as a library.
    expect(isModuleEntry(new URL('../../scripts/libwebrtc-sdk-targets.mjs', import.meta.url).href))
      .toBe(false);
  });
});
