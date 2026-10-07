#!/usr/bin/env node
/**
 * Fetches the pinned FLTK and jsoncpp sources the native aiDesk window is built from (native/aidesk-ui/dependencies.lock.json).
 * Build time only: nothing here ever runs on a user's machine. A tarball whose sha256 differs from its pin is refused and nothing is
 * extracted; the extracted tree must be exactly the one top-level directory the pin names.
 *
 *   node scripts/fetch-aidesk-ui-deps.mjs --out DIR [--cache DIR]
 *
 * Prints one JSON line: {"fltkRoot": "...", "jsoncppRoot": "..."}.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AIDESK_UI_DEPENDENCIES_LOCK = join(root, 'native', 'aidesk-ui', 'dependencies.lock.json');
const SHA256_RE = /^[a-f0-9]{64}$/u;
const NAMES = Object.freeze(['fltk', 'jsoncpp']);

export function parseDependenciesLock(text) {
  const lock = JSON.parse(text);
  if (lock?.schemaVersion !== 1 || typeof lock.dependencies !== 'object' || lock.dependencies === null) throw new Error('invalid aidesk ui dependency lock');
  for (const name of NAMES) {
    const entry = lock.dependencies[name];
    if (!entry || typeof entry.version !== 'string' || typeof entry.url !== 'string' || !entry.url.startsWith('https://')
      || typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)
      || typeof entry.topDirectory !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(entry.topDirectory)) {
      throw new Error(`invalid aidesk ui dependency pin: ${name}`);
    }
  }
  return lock.dependencies;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Throws unless `bytes` is exactly the pinned file. */
export function assertPinnedBytes(name, bytes, pin) {
  const actual = sha256Hex(bytes);
  if (actual !== pin.sha256) throw new Error(`${name} sha256 mismatch: pinned ${pin.sha256}, got ${actual}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Extract with the system tar (present on every CI runner) and require the one pinned top-level directory. */
export function extractPinnedTarball(name, tarballPath, destination, pin) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', destination], { stdio: 'inherit' });
  const entries = readdirSync(destination);
  if (entries.length !== 1 || entries[0] !== pin.topDirectory) throw new Error(`${name} archive does not contain exactly ${pin.topDirectory}/ (found ${entries.join(', ') || 'nothing'})`);
  return join(destination, pin.topDirectory);
}

export async function fetchAideskUiDependencies({ out, cache = join(out, '.cache'), lockPath = AIDESK_UI_DEPENDENCIES_LOCK, fetchBytes = download } = {}) {
  const pins = parseDependenciesLock(readFileSync(lockPath, 'utf8'));
  mkdirSync(cache, { recursive: true });
  const roots = {};
  for (const name of NAMES) {
    const pin = pins[name];
    const tarball = join(cache, `${name}-${pin.version}.tar.gz`);
    let bytes = existsSync(tarball) ? readFileSync(tarball) : undefined;
    if (bytes && sha256Hex(bytes) !== pin.sha256) bytes = undefined; // a stale or damaged cache entry is simply fetched again
    if (!bytes) {
      bytes = await fetchBytes(pin.url);
      assertPinnedBytes(name, bytes, pin);
      writeFileSync(tarball, bytes);
    }
    roots[`${name}Root`] = extractPinnedTarball(name, tarball, join(out, name), pin);
  }
  return roots;
}

if (process.argv[1] && process.argv[1].endsWith('fetch-aidesk-ui-deps.mjs')) {
  const args = process.argv.slice(2);
  const option = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const out = option('--out');
  if (!out) { process.stderr.write('usage: fetch-aidesk-ui-deps.mjs --out DIR [--cache DIR]\n'); process.exit(2); }
  const roots = await fetchAideskUiDependencies({ out: resolve(out), ...(option('--cache') ? { cache: resolve(option('--cache')) } : {}) });
  process.stdout.write(`${JSON.stringify(roots)}\n`);
}
