import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');

/**
 * These assertions are about the PUBLISHED shape, not the source tree.
 *
 * The shared Apple-trust implementation briefly lived under `scripts/`, which
 * looked fine from every source-tree test: tsx resolves it, vitest resolves it,
 * `tsc --noEmit` type-checks it. It was still a hard deployment break --
 * `postbuild` copies only `src/**` + '/*.mjs' into `dist/src/`, and the npm
 * `files` list publishes `dist/`, `config/` and `bin/` only. A published daemon
 * would therefore have thrown ERR_MODULE_NOT_FOUND on first import of the
 * artifact verifier, and nothing in the source tree could see it.
 */
describe('macOS Apple-trust shared implementation ships with the daemon', () => {
  it('is published: npm files covers dist/, and the module lives under src/', async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'package.json'), 'utf8'),
    ) as { files: string[]; scripts: Record<string, string> };
    // `scripts/` is deliberately NOT published; anything the daemon imports at
    // runtime must therefore live under a published root.
    expect(manifest.files).toContain('dist/');
    expect(manifest.files).not.toContain('scripts/');
    // postbuild is what carries .mjs into dist; without it the module would be
    // missing even from src/.
    expect(manifest.scripts.postbuild).toContain('copy-worker-bootstraps.mjs');

    await expect(access(join(ROOT, 'src/node/macos-apple-trust.mjs'))).resolves.toBeUndefined();
    // Exactly one implementation. A second copy under scripts/ would drift, and
    // the weaker copy is the one an attacker uses.
    await expect(access(join(ROOT, 'scripts/macos-apple-trust.mjs'))).rejects.toThrow();

    // The daemon must not reach outside a published root for it.
    const verifier = await readFile(join(ROOT, 'src/node/macos-remote-desktop-artifact.ts'), 'utf8');
    expect(verifier).toContain("from './macos-apple-trust.mjs'");
    expect(verifier).not.toMatch(/from '\.\.\/\.\.\/scripts\//u);
  });

  it('survives a real build: dist carries the module and the verifier imports', async () => {
    if (process.platform !== 'darwin') return;
    // A REAL build, then a REAL dynamic import of the emitted JavaScript. tsx
    // and vitest both resolve the source tree, so only this can see the break.
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    await expect(access(join(ROOT, 'dist/src/node/macos-apple-trust.mjs')))
      .resolves.toBeUndefined();
    const compiled = await import(
      /* @vite-ignore */ join(ROOT, 'dist/src/node/macos-remote-desktop-artifact.js')
    );
    // Importing is the assertion: an unresolvable specifier throws here.
    expect(typeof compiled.verifyMacosRemoteDesktopArtifact).toBe('function');
    expect(compiled.MACOS_REMOTE_DESKTOP_APPLE_TOOLS.codesign).toBe('/usr/bin/codesign');
  }, 600_000);

  it('bundles into the single-file controlled node executable', async () => {
    // The node-exe path bundles the thin entry with esbuild rather than copying
    // dist/, so it has its own way to miss the module.
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [join(ROOT, 'src/node/index.ts')],
      bundle: true, platform: 'node', format: 'esm', metafile: true,
      write: false, logLevel: 'silent', external: ['bufferutil', 'utf8-validate'],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((path) => path.endsWith('src/node/macos-apple-trust.mjs')),
      'the shared trust module is not reachable from the controlled-node entry').toBe(true);
  }, 180_000);
});
