import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error ESM script module
import {
  collectPcAppShellFiles,
  comparePcAppShellHash,
  computePcAppShellHash,
  REPO_ROOT,
} from '../../scripts/pc-app-shell-hash.mjs';

const tempDirs: string[] = [];

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-shell-hash-'));
  tempDirs.push(root);
  const files: Record<string, string> = {
    'apps/pc-app/src/main.ts': 'export const main = 1;\n',
    'apps/pc-app/native/imcodes-speech.swift': '// swift\n',
    'apps/pc-app/build/entitlements.mac.plist': '<plist/>\n',
    'apps/pc-app/scripts/after-sign.mjs': 'export default async function() {}\n',
    'apps/pc-app/package.json': '{"name":"imcodes-pc-app","version":"0.1.0"}\n',
    'apps/pc-app/package-lock.json': '{"lockfileVersion":3}\n',
    'apps/pc-app/electron-builder.config.mjs': 'export default {};\n',
    'scripts/build-pc-app.mjs': 'export function runBuildPcApp() {}\n',
    'scripts/build-macos-bundled-tmux.mjs': 'export function buildMacosBundledTmux() {}\n',
    // Non-shell files that MUST NOT affect shellSha256:
    'apps/pc-app/test/main.test.ts': 'test()\n',
    'apps/pc-app/native/qwen3-asr/.build/cache.o': 'build-cache\n',
    'web/src/App.tsx': 'export const App = () => null;\n',
    'server/src/index.ts': 'export const srv = 1;\n',
    'src/cli.ts': 'export const cli = 1;\n',
    'README.md': '# IM.codes\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('pc-app-shell-hash', () => {
  it('hashes only runtime PC App shell inputs and excludes tests, web, server, daemon, docs, and .build', () => {
    const root = createFixtureRepo();
    const collected = collectPcAppShellFiles(root);
    expect(collected).toEqual([
      'apps/pc-app/build/entitlements.mac.plist',
      'apps/pc-app/electron-builder.config.mjs',
      'apps/pc-app/native/imcodes-speech.swift',
      'apps/pc-app/package-lock.json',
      'apps/pc-app/package.json',
      'apps/pc-app/scripts/after-sign.mjs',
      'apps/pc-app/src/main.ts',
      'scripts/build-macos-bundled-tmux.mjs',
      'scripts/build-pc-app.mjs',
    ]);

    const baseline = computePcAppShellHash({ repoRoot: root });
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(computePcAppShellHash({ repoRoot: root })).toBe(baseline);

    // Non-shell mutations leave hash identical
    writeFileSync(join(root, 'apps/pc-app/test/main.test.ts'), 'test("updated")\n', 'utf8');
    writeFileSync(join(root, 'web/src/App.tsx'), 'export const App = () => "changed";\n', 'utf8');
    writeFileSync(join(root, 'server/src/index.ts'), 'export const srv = 2;\n', 'utf8');
    writeFileSync(join(root, 'src/cli.ts'), 'export const cli = 2;\n', 'utf8');
    writeFileSync(join(root, 'README.md'), '# Changed README\n', 'utf8');
    writeFileSync(join(root, 'apps/pc-app/native/qwen3-asr/.build/cache.o'), 'mutated-cache\n', 'utf8');
    expect(computePcAppShellHash({ repoRoot: root })).toBe(baseline);

    // Any runtime shell mutation changes shellSha256
    writeFileSync(join(root, 'apps/pc-app/src/main.ts'), 'export const main = 2;\n', 'utf8');
    const afterShellChange = computePcAppShellHash({ repoRoot: root });
    expect(afterShellChange).not.toBe(baseline);

    writeFileSync(join(root, 'scripts/build-pc-app.mjs'), 'export function runBuildPcApp() { return 1; }\n', 'utf8');
    expect(computePcAppShellHash({ repoRoot: root })).not.toBe(afterShellChange);
  });

  it('compares local hash against remote shell-meta.json and fails open when unreachable or malformed', async () => {
    const root = createFixtureRepo();
    const localHash = computePcAppShellHash({ repoRoot: root });

    const match = await comparePcAppShellHash({
      repoRoot: root,
      compareUrl: 'https://dl.im.codes/pc-app/shell-meta.json',
      fetchFn: vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: '0.1.5', shellSha256: localHash.toUpperCase() }),
      })) as unknown as typeof fetch,
    });
    expect(match).toEqual({ changed: false, localHash, remoteHash: localHash });

    const diff = await comparePcAppShellHash({
      repoRoot: root,
      compareUrl: 'https://dl.im.codes/pc-app/shell-meta.json',
      fetchFn: vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: '0.1.4', shellSha256: 'a'.repeat(64) }),
      })) as unknown as typeof fetch,
    });
    expect(diff).toEqual({ changed: true, localHash, remoteHash: 'a'.repeat(64) });

    const notFound = await comparePcAppShellHash({
      repoRoot: root,
      compareUrl: 'https://dl.im.codes/pc-app/shell-meta.json',
      fetchFn: vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });
    expect(notFound).toEqual({ changed: true, localHash, remoteHash: null });

    const networkErr = await comparePcAppShellHash({
      repoRoot: root,
      compareUrl: 'https://dl.im.codes/pc-app/shell-meta.json',
      fetchFn: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(networkErr).toEqual({ changed: true, localHash, remoteHash: null });
  });

  it('runs cleanly as CLI against real repository root', () => {
    const scriptPath = resolve(REPO_ROOT, 'scripts/pc-app-shell-hash.mjs');
    const stdoutHash = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' }).trim();
    expect(stdoutHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stdoutHash).toBe(computePcAppShellHash({ repoRoot: REPO_ROOT }));
  });
});
