#!/usr/bin/env node
/**
 * Fetches the fixed WebView2 SDK package the Windows panel window host is built with (native/aidesk-panel-host-windows/webview2.lock.json).
 * Build time only: nothing here ever runs on a user's machine. A package whose sha256 differs from its pin is refused and nothing is
 * extracted; every file the lock lists must exist after extraction.
 *
 *   node scripts/fetch-webview2-sdk.mjs --out DIR [--cache DIR]
 *
 * Prints one JSON line: {"root": "<extracted package root>"}.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WEBVIEW2_SDK_LOCK = join(root, 'native', 'aidesk-panel-host-windows', 'webview2.lock.json');
const SHA256_RE = /^[a-f0-9]{64}$/u;

export function parseWebview2Lock(text) {
  const lock = JSON.parse(text);
  const pin = lock?.package;
  if (lock?.schemaVersion !== 1 || !pin || typeof pin.name !== 'string' || typeof pin.version !== 'string'
    || typeof pin.url !== 'string' || !pin.url.startsWith('https://') || typeof pin.sha256 !== 'string' || !SHA256_RE.test(pin.sha256)
    || !Array.isArray(pin.files) || pin.files.length === 0
    || pin.files.some((file) => typeof file !== 'string' || file.startsWith('/') || file.includes('..') || file.includes('\\'))) {
    throw new Error('invalid WebView2 SDK lock');
  }
  return pin;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Throws unless `bytes` is exactly the pinned file. */
export function assertPinnedBytes(bytes, pin) {
  const actual = sha256Hex(bytes);
  if (actual !== pin.sha256) throw new Error(`${pin.name} ${pin.version} sha256 mismatch: pinned ${pin.sha256}, got ${actual}`);
}

/** Throws unless every file the pin lists is present under `packageRoot`. */
export function assertRequiredFiles(packageRoot, pin) {
  const missing = pin.files.filter((file) => !existsSync(join(packageRoot, ...file.split('/'))));
  if (missing.length > 0) throw new Error(`${pin.name} ${pin.version} is missing ${missing.join(', ')}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** A .nupkg is a zip: bsdtar (Windows, macOS) reads it with `tar`, Linux runners have `unzip`. */
export function extractNupkg(archive, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  try {
    execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-q', '-o', archive, '-d', destination], { stdio: 'inherit' });
  }
  return destination;
}

export async function fetchWebview2Sdk({ out, cache = join(out, '.cache'), lockPath = WEBVIEW2_SDK_LOCK, fetchBytes = download } = {}) {
  const pin = parseWebview2Lock(readFileSync(lockPath, 'utf8'));
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `${pin.name}.${pin.version}.nupkg`);
  let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
  if (bytes && sha256Hex(bytes) !== pin.sha256) bytes = undefined; // a stale or damaged cache entry is simply fetched again
  if (!bytes) {
    bytes = await fetchBytes(pin.url);
    assertPinnedBytes(bytes, pin);
    writeFileSync(archive, bytes);
  }
  const packageRoot = extractNupkg(archive, join(out, `${pin.name}.${pin.version}`));
  assertRequiredFiles(packageRoot, pin);
  return packageRoot;
}

if (process.argv[1] && process.argv[1].endsWith('fetch-webview2-sdk.mjs')) {
  const args = process.argv.slice(2);
  const option = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const out = option('--out');
  if (!out) { process.stderr.write('usage: fetch-webview2-sdk.mjs --out DIR [--cache DIR]\n'); process.exit(2); }
  const packageRoot = await fetchWebview2Sdk({ out: resolve(out), ...(option('--cache') ? { cache: resolve(option('--cache')) } : {}) });
  process.stdout.write(`${JSON.stringify({ root: packageRoot })}\n`);
}
