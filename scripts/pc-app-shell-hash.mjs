#!/usr/bin/env node
/**
 * Compute deterministic SHA-256 hash over runtime PC App shell inputs only
 * (`apps/pc-app/src/**`, `native/**`, `build/**`, `scripts/**`, manifests, and
 * desktop packaging scripts), excluding tests, web, server, daemon, and docs.
 *
 * Usage:
 *   node scripts/pc-app-shell-hash.mjs
 *   node scripts/pc-app-shell-hash.mjs --compare-url https://dl.im.codes/pc-app/shell-meta.json
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_SHELL_META_URL = 'https://dl.im.codes/pc-app/shell-meta.json';

export const PC_APP_SHELL_DIRS = Object.freeze([
  'apps/pc-app/src',
  'apps/pc-app/native',
  'apps/pc-app/build',
  'apps/pc-app/scripts',
]);

export const PC_APP_SHELL_FILES = Object.freeze([
  'apps/pc-app/package.json',
  'apps/pc-app/package-lock.json',
  'apps/pc-app/electron-builder.config.mjs',
  'scripts/build-pc-app.mjs',
  'scripts/build-macos-bundled-tmux.mjs',
]);

const IGNORED_DIR_NAMES = new Set(['node_modules', '.build', 'dist', 'release', 'test', '.git']);
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walkDirFiles(absRoot, relDir, out) {
  const absDir = join(absRoot, relDir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    return;
  }
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      walkDirFiles(absRoot, `${relDir}/${entry.name}`, out);
    } else if (entry.isFile()) {
      if (IGNORED_FILE_NAMES.has(entry.name)) continue;
      out.push(`${relDir}/${entry.name}`);
    }
  }
}

/**
 * Collect and lexicographically sort all runtime PC App shell file paths (POSIX relative).
 */
export function collectPcAppShellFiles(repoRoot = REPO_ROOT) {
  const absRoot = resolve(repoRoot);
  const files = [];
  for (const relDir of PC_APP_SHELL_DIRS) {
    walkDirFiles(absRoot, relDir, files);
  }
  for (const relFile of PC_APP_SHELL_FILES) {
    const absFile = join(absRoot, relFile);
    if (existsSync(absFile) && statSync(absFile).isFile()) {
      files.push(relFile);
    }
  }
  return [...new Set(files)].sort(compareAscii);
}

/**
 * Compute deterministic 64-hex SHA-256 over all runtime PC App shell paths and contents.
 */
export function computePcAppShellHash({ repoRoot = REPO_ROOT } = {}) {
  const absRoot = resolve(repoRoot);
  const files = collectPcAppShellFiles(absRoot);
  if (files.length === 0) {
    throw new Error(`No PC App shell inputs found under ${absRoot}`);
  }
  const hash = createHash('sha256');
  for (const relPath of files) {
    const content = readFileSync(join(absRoot, relPath));
    hash.update(relPath, 'utf8');
    hash.update('\0');
    hash.update(String(content.length), 'utf8');
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Compare the local shell SHA-256 against a remote `shell-meta.json` endpoint.
 * Fails open (`changed: true, remoteHash: null`) when the remote metadata is missing,
 * unreachable, or invalid so initial publishes and transient errors never block releases.
 */
export async function comparePcAppShellHash({
  repoRoot = REPO_ROOT,
  compareUrl = DEFAULT_SHELL_META_URL,
  fetchFn = fetch,
  timeoutMs = 10_000,
} = {}) {
  const localHash = computePcAppShellHash({ repoRoot });
  const trimmedUrl = typeof compareUrl === 'string' ? compareUrl.trim() : '';
  if (!trimmedUrl) {
    return { changed: true, localHash, remoteHash: null };
  }
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const response = await fetchFn(trimmedUrl, signal ? { signal } : undefined);
    if (!response || !response.ok) {
      return { changed: true, localHash, remoteHash: null };
    }
    const body = await response.json();
    const rawRemote = typeof body?.shellSha256 === 'string' ? body.shellSha256.trim() : '';
    if (!/^[0-9a-f]{64}$/i.test(rawRemote)) {
      return { changed: true, localHash, remoteHash: null };
    }
    const remoteHash = rawRemote.toLowerCase();
    return {
      changed: remoteHash !== localHash,
      localHash,
      remoteHash,
    };
  } catch {
    return { changed: true, localHash, remoteHash: null };
  }
}

export function parsePcAppShellHashArgs(argv = process.argv.slice(2)) {
  const opts = {
    repoRoot: REPO_ROOT,
    compareUrl: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--compare-url' && argv[i + 1]) {
      opts.compareUrl = String(argv[++i]).trim();
    } else if (arg === '--repo-root' && argv[i + 1]) {
      opts.repoRoot = resolve(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parsePcAppShellHashArgs();
  if (opts.compareUrl) {
    const result = await comparePcAppShellHash({
      repoRoot: opts.repoRoot,
      compareUrl: opts.compareUrl,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const hash = computePcAppShellHash({ repoRoot: opts.repoRoot });
  process.stdout.write(`${hash}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
