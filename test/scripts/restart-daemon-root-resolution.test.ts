import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLinkedImcodesPackageRoot } from '../../scripts/resolve-linked-imcodes-root.mjs';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-restart-root-'));
  roots.push(root);
  const binDir = join(root, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  return { root, binDir };
}

function packageRoot(root: string, name = 'imcodes', suffix = 'imcodes') {
  const pkg = join(root, 'npm', 'lib', 'node_modules', suffix);
  const entry = join(pkg, 'dist', 'src', 'index.js');
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name }));
  writeFileSync(entry, '#!/usr/bin/env node\n');
  return { pkg, entry };
}

function nodeBinary(root: string) {
  const node = join(root, 'node', 'bin', 'node');
  mkdirSync(join(root, 'node', 'bin'), { recursive: true });
  writeFileSync(node, 'not executed\n');
  chmodSync(node, 0o755);
  return node;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('restart daemon linked package root resolution', () => {
  it('resolves the canonical target of an npm symlink', () => {
    const { root, binDir } = fixture();
    const linked = packageRoot(root);
    const cli = join(binDir, 'imcodes');
    symlinkSync(linked.entry, cli);

    expect(resolveLinkedImcodesPackageRoot(cli)).toBe(realpathSync(linked.pkg));
  });

  it('resolves one literal exec target from a regular wrapper without executing it', () => {
    const { root, binDir } = fixture();
    const linked = packageRoot(root);
    const node = nodeBinary(root);
    const cli = join(binDir, 'imcodes');
    writeFileSync(cli, `#!/bin/sh\nexec "${node}" "${linked.entry}" "$@"\n`);

    expect(resolveLinkedImcodesPackageRoot(cli)).toBe(realpathSync(linked.pkg));
  });

  it('fails closed for a relative wrapper target', () => {
    const { root, binDir } = fixture();
    nodeBinary(root);
    const cli = join(binDir, 'imcodes');
    writeFileSync(cli, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../../npm/lib/node_modules/imcodes/dist/src/index.js" "$@"\n');

    expect(() => resolveLinkedImcodesPackageRoot(cli)).toThrow(/could not locate linked imcodes package root/);
  });

  it('fails closed when a wrapper names two different imcodes package roots', () => {
    const { root, binDir } = fixture();
    const first = packageRoot(root, 'imcodes', 'imcodes-a');
    const second = packageRoot(root, 'imcodes', 'imcodes-b');
    const node = nodeBinary(root);
    const cli = join(binDir, 'imcodes');
    writeFileSync(cli, `#!/bin/sh\nexec "${node}" "${first.entry}" "$@"\nexec "${node}" "${second.entry}" "$@"\n`);

    expect(() => resolveLinkedImcodesPackageRoot(cli)).toThrow(/ambiguous linked imcodes package roots/);
  });

  it('fails closed for an opaque wrapper with no canonical package target', () => {
    const { binDir } = fixture();
    const cli = join(binDir, 'imcodes');
    writeFileSync(cli, '#!/bin/sh\nexec "$IMCODES_UNKNOWN" "$@"\n');

    expect(() => resolveLinkedImcodesPackageRoot(cli)).toThrow(/could not locate linked imcodes package root/);
  });

  it.each([
    ['a quoted path containing whitespace', 'space'],
    ['a non-node executable', 'non-node'],
    ['a missing dist entry', 'missing-entry'],
    ['a package with the wrong name', 'wrong-package'],
  ])('fails closed for %s', (_label, kind) => {
    const { root, binDir } = fixture();
    const node = nodeBinary(root);
    const linked = packageRoot(root, kind === 'wrong-package' ? 'other-package' : 'imcodes', kind === 'space' ? 'im codes' : 'imcodes');
    const cli = join(binDir, 'imcodes');
    const executable = kind === 'non-node' ? join(root, 'node', 'bin', 'nodejs') : node;
    if (kind === 'non-node') {
      writeFileSync(executable, 'not executed\n');
      chmodSync(executable, 0o755);
    }
    const entry = kind === 'missing-entry' ? join(root, 'missing', 'dist', 'src', 'index.js') : linked.entry;
    writeFileSync(cli, `#!/bin/sh\nexec "${executable}" "${entry}" "$@"\n`);

    expect(() => resolveLinkedImcodesPackageRoot(cli)).toThrow(/could not locate linked imcodes package root/);
  });
});
