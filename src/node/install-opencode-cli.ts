import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';

export const OPENCODE_OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
export const OPENCODE_MIRROR_REGISTRY = 'https://registry.npmmirror.com';

const DEFAULT_METADATA_TIMEOUT_MS = 10_000;
const DEFAULT_TARBALL_TIMEOUT_MS = 45_000;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const MAX_TAR_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

export interface OpenCodeDistMetadata {
  tarball?: string;
  integrity?: string;
  shasum?: string;
}

export interface InstallOpenCodeOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
  env?: NodeJS.ProcessEnv;
  skip?: boolean;
  registry?: string;
  registries?: string[];
  noFallback?: boolean;
  isolatedTest?: boolean;
  metadataTimeoutMs?: number;
  tarballTimeoutMs?: number;
  versionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
  verifyVersion?: (binPath: string, timeoutMs: number) => string | undefined;
  linkFile?: (existingPath: string, newPath: string) => void;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export interface InstallOpenCodeResult {
  status: 'installed' | 'existing' | 'skipped' | 'unsupported' | 'unverified' | 'failed';
  path?: string;
  version?: string;
  packageName?: string;
  registry?: string;
  reason?: string;
}

export function isOpenCodeOptedOut(opts: { skip?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (opts.skip) return true;
  const raw = opts.env?.IMCODES_SKIP_OPENCODE ?? process.env.IMCODES_SKIP_OPENCODE ?? '';
  return /^(1|true|yes)$/i.test(raw.trim());
}

export function defaultIsLinuxMusl(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  return report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
}

export function resolveOpenCodePlatformPackage(opts: {
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
} = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'opencode-darwin-arm64';
    if (arch === 'x64') return 'opencode-darwin-x64';
    return null;
  }
  if (platform === 'linux') {
    const musl = opts.isMusl ?? defaultIsLinuxMusl(platform);
    if (arch === 'x64') return musl ? 'opencode-linux-x64-musl' : 'opencode-linux-x64';
    if (arch === 'arm64') return musl ? 'opencode-linux-arm64-musl' : 'opencode-linux-arm64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'opencode-windows-x64';
    if (arch === 'arm64') return 'opencode-windows-arm64';
    return null;
  }
  return null;
}

function getPathModule(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (key in env) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

async function defaultCheckFileExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithinRealRoot(targetReal: string, rootReal: string, platform: NodeJS.Platform): boolean {
  const p = getPathModule(platform);
  const normTarget = platform === 'win32' ? targetReal.toLowerCase() : targetReal;
  const normRoot = platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const rel = p.relative(normRoot, normTarget);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

function assertExistingDirSafeWithinHome(dirPath: string, canonicalHome: string, label: string, platform: NodeJS.Platform): boolean {
  let st;
  try {
    st = lstatSync(dirPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`unsafe_symlink_target:${label}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`unsafe_non_directory_target:${label}`);
  }
  const realDir = realpathSync(dirPath);
  if (!isWithinRealRoot(realDir, canonicalHome, platform)) {
    throw new Error(`unsafe_target_escape:${label}`);
  }
  return true;
}

function ensureSafeOpenCodePaths(homeDir: string, binDir: string, destPath: string, platform: NodeJS.Platform, createDirs: boolean): void {
  const p = getPathModule(platform);
  const opencodeDir = p.join(homeDir, '.opencode');

  if (!existsSync(homeDir)) {
    if (!createDirs) return;
    mkdirSync(homeDir, { recursive: true });
  }
  if (lstatSync(homeDir).isSymbolicLink()) {
    throw new Error('unsafe_symlink_target:homeDir');
  }
  const canonicalHome = realpathSync(homeDir);

  if (!assertExistingDirSafeWithinHome(opencodeDir, canonicalHome, '.opencode', platform)) {
    if (!createDirs) return;
    mkdirSync(opencodeDir);
    assertExistingDirSafeWithinHome(opencodeDir, canonicalHome, '.opencode', platform);
  }

  if (!assertExistingDirSafeWithinHome(binDir, canonicalHome, '.opencode/bin', platform)) {
    if (!createDirs) return;
    mkdirSync(binDir);
    assertExistingDirSafeWithinHome(binDir, canonicalHome, '.opencode/bin', platform);
  }

  try {
    const destStat = lstatSync(destPath);
    if (destStat.isSymbolicLink()) {
      throw new Error('unsafe_symlink_target:opencode');
    }
    const realParent = realpathSync(p.dirname(destPath));
    if (!isWithinRealRoot(realParent, canonicalHome, platform)) {
      throw new Error('unsafe_target_escape:opencode');
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw err;
    }
  }
}

export async function isOpenCodeAlreadyInstalled(opts: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
} = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const p = getPathModule(platform);
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const isExec = opts.checkFileExecutable ?? ((filePath: string) => defaultCheckFileExecutable(filePath, platform));
  const delimiter = platform === 'win32' ? ';' : ':';
  const rawPath = (platform === 'win32' ? readEnvCaseInsensitive(env, 'PATH') : env.PATH) ?? '';
  const pathDirs = rawPath.split(delimiter).map((d) => d.trim()).filter(Boolean);

  if (platform === 'win32') {
    const pathext = (readEnvCaseInsensitive(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
      .split(';')
      .map((ext) => ext.trim())
      .filter(Boolean);
    const candidates = ['opencode.exe', ...pathext.map((ext) => `opencode${ext.toLowerCase()}`), 'opencode'];
    const uniqueNames = [...new Set(candidates)];
    for (const dir of pathDirs) {
      for (const name of uniqueNames) {
        const candidate = p.join(dir, name);
        if (await isExec(candidate)) return candidate;
      }
    }
    if (homeDir) {
      const binDir = p.join(homeDir, '.opencode', 'bin');
      const homeBin = p.join(binDir, 'opencode.exe');
      if (process.platform === 'win32') {
        ensureSafeOpenCodePaths(homeDir, binDir, homeBin, platform, false);
      }
      if (await isExec(homeBin)) return homeBin;
    }
    return null;
  }

  for (const dir of pathDirs) {
    const candidate = p.join(dir, 'opencode');
    if (await isExec(candidate)) return candidate;
  }
  if (homeDir) {
    const binDir = p.join(homeDir, '.opencode', 'bin');
    const homeBin = p.join(binDir, 'opencode');
    if (process.platform !== 'win32') {
      ensureSafeOpenCodePaths(homeDir, binDir, homeBin, platform, false);
    }
    if (await isExec(homeBin)) return homeBin;
  }
  return null;
}

export function normalizeRegistryUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function resolveCandidateRegistries(opts: {
  registry?: string;
  registries?: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  noFallback?: boolean;
  isolatedTest?: boolean;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const isolatedTest = opts.isolatedTest || /^(1|true|yes)$/i.test((env.IMCODES_OPENCODE_ISOLATED_TEST ?? '').trim());
  const candidates: Array<string | null> = [];

  if (Array.isArray(opts.registries) && opts.registries.length > 0) {
    for (const r of opts.registries) candidates.push(normalizeRegistryUrl(r));
    return [...new Set(candidates.filter((v): v is string => Boolean(v)))];
  }

  candidates.push(normalizeRegistryUrl(opts.registry));
  candidates.push(normalizeRegistryUrl(env.IMCODES_OPENCODE_REGISTRY));
  if (!isolatedTest) {
    candidates.push(normalizeRegistryUrl(env.IMCODES_NPM_REGISTRY));
  }

  if (homeDir && !isolatedTest) {
    const installJsonPath = path.join(imcodesStateDirForHome(homeDir, env), 'install.json');
    try {
      if (existsSync(installJsonPath)) {
        const parsed = JSON.parse(readFileSync(installJsonPath, 'utf8')) as { registry?: unknown };
        candidates.push(normalizeRegistryUrl(parsed?.registry));
      }
    } catch {
      // ignore malformed install.json
    }
  }

  const noFallback = opts.noFallback || /^(1|true|yes)$/i.test((env.IMCODES_OPENCODE_NO_FALLBACK ?? '').trim());
  if (!isolatedTest && !noFallback) {
    candidates.push(OPENCODE_OFFICIAL_REGISTRY);
    candidates.push(OPENCODE_MIRROR_REGISTRY);
  }

  return [...new Set(candidates.filter((v): v is string => Boolean(v)))];
}

export function verifyBufferIntegrity(buffer: Buffer, dist: OpenCodeDistMetadata): void {
  const integrity = typeof dist.integrity === 'string' ? dist.integrity.trim() : '';
  if (integrity) {
    const tokens = integrity.split(/\s+/).filter(Boolean);
    let supportedChecked = false;
    for (const token of tokens) {
      const dashIdx = token.indexOf('-');
      if (dashIdx <= 0) continue;
      const alg = token.slice(0, dashIdx).toLowerCase();
      const expectedB64 = token.slice(dashIdx + 1);
      if (alg !== 'sha512' && alg !== 'sha384' && alg !== 'sha256') continue;
      const actualBuf = createHash(alg).update(buffer).digest();
      let expectedBuf: Buffer;
      try {
        expectedBuf = Buffer.from(expectedB64, 'base64');
      } catch {
        throw new Error(`invalid_integrity_encoding:${alg}`);
      }
      if (expectedBuf.length !== actualBuf.length) {
        throw new Error(`integrity_mismatch:${alg}`);
      }
      supportedChecked = true;
      if (timingSafeEqual(actualBuf, expectedBuf)) {
        return;
      }
    }
    if (supportedChecked) {
      throw new Error('integrity_mismatch:digest');
    }
    throw new Error('unsupported_integrity_format');
  }

  const shasum = typeof dist.shasum === 'string' ? dist.shasum.trim().toLowerCase() : '';
  if (/^[a-f0-9]{40}$/.test(shasum)) {
    const actual = createHash('sha1').update(buffer).digest();
    const expected = Buffer.from(shasum, 'hex');
    if (!timingSafeEqual(actual, expected)) {
      throw new Error('integrity_mismatch:sha1');
    }
    return;
  }

  throw new Error('missing_integrity_metadata');
}

function readTarString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nulIdx = slice.indexOf(0);
  const end = nulIdx === -1 ? slice.length : nulIdx;
  return slice.subarray(0, end).toString('utf8');
}

function readTarSize(buf: Buffer, start: number, length: number): number {
  const slice = buf.subarray(start, start + length);
  if ((slice[0] & 0x80) !== 0) {
    // GNU/base-256 positive integer
    let val = 0n;
    for (let i = 1; i < slice.length; i += 1) {
      val = (val << 8n) + BigInt(slice[i]);
    }
    const num = Number(val);
    if (!Number.isSafeInteger(num) || num < 0) throw new Error('invalid_tar_size');
    return num;
  }
  const raw = readTarString(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error('invalid_tar_octal_size');
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid_tar_size');
  return parsed;
}

function parsePaxRecords(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const text = buf.toString('utf8');
  let pos = 0;
  while (pos < text.length) {
    const spaceIdx = text.indexOf(' ', pos);
    if (spaceIdx === -1) break;
    const len = Number.parseInt(text.slice(pos, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recordEnd = pos + len;
    const record = text.slice(spaceIdx + 1, recordEnd).replace(/\n$/, '');
    const eqIdx = record.indexOf('=');
    if (eqIdx > 0) {
      out[record.slice(0, eqIdx)] = record.slice(eqIdx + 1);
    }
    pos = recordEnd;
  }
  return out;
}

function validateTarEntryPath(rawPath: string, typeflag: string): string | null {
  if (!rawPath || rawPath.includes('\0')) {
    throw new Error(`unsafe_tar_entry_path:${rawPath}`);
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`unsafe_tar_entry_path:${rawPath}`);
  }
  let cleaned = rawPath.replace(/\\/g, '/');
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  const rawSegments = cleaned.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (rawSegments.some((seg) => seg === '..')) {
    throw new Error(`unsafe_tar_entry_path:${rawPath}`);
  }
  if (rawSegments.length === 0) {
    if (typeflag === '5') return null;
    throw new Error(`unsafe_tar_entry_path:${rawPath}`);
  }
  return rawSegments.join('/');
}

function normalizeTarEntryPath(rawPath: string): string | null {
  try {
    return validateTarEntryPath(rawPath, '0');
  } catch {
    return null;
  }
}

export function extractBinaryFromTarGz(tgzBuffer: Buffer, targetEntryPaths: string[]): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgzBuffer, { maxOutputLength: MAX_TAR_UNCOMPRESSED_BYTES });
  } catch (err) {
    throw new Error(`tarball_gunzip_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const wanted = new Set(targetEntryPaths.map((p) => normalizeTarEntryPath(p)).filter((v): v is string => Boolean(v)));
  if (wanted.size === 0) throw new Error('invalid_target_entry_paths');

  let offset = 0;
  let nextPax: Record<string, string> = {};
  let nextGnuLongName: string | null = null;
  let globalPax: Record<string, string> = {};
  let matchedBinary: Buffer | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((b) => b === 0)) {
      break;
    }

    const rawName = readTarString(header, 0, 100);
    const rawPrefix = readTarString(header, 345, 155);
    const typeByte = header[156];
    const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    let size = readTarSize(header, 124, 12);

    const paxSizeRaw = nextPax.size ?? globalPax.size;
    if (paxSizeRaw !== undefined) {
      const paxSize = Number.parseInt(paxSizeRaw, 10);
      if (!Number.isSafeInteger(paxSize) || paxSize < 0) throw new Error('invalid_pax_size');
      size = paxSize;
    }

    if (offset + size > tar.length) {
      throw new Error('truncated_tar_entry');
    }

    const dataStart = offset;
    const dataEnd = offset + size;
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (typeflag === 'x') {
      nextPax = { ...nextPax, ...parsePaxRecords(tar.subarray(dataStart, dataEnd)) };
      continue;
    }
    if (typeflag === 'g') {
      globalPax = { ...globalPax, ...parsePaxRecords(tar.subarray(dataStart, dataEnd)) };
      continue;
    }
    if (typeflag === 'L') {
      nextGnuLongName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    const headerCombinedName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const effectiveRawName = nextPax.path ?? nextGnuLongName ?? globalPax.path ?? headerCombinedName;
    const effectiveLinkName = nextPax.linkpath ?? readTarString(header, 157, 100);
    nextPax = {};
    nextGnuLongName = null;

    if (typeflag !== '0' && typeflag !== '5') {
      throw new Error(`unsafe_tar_entry_type:${typeflag}:${effectiveRawName || effectiveLinkName}`);
    }

    const normalized = validateTarEntryPath(effectiveRawName, typeflag);

    if (typeflag === '0' && normalized && wanted.has(normalized)) {
      if (size === 0) throw new Error('empty_binary_in_tarball');
      if (!matchedBinary) {
        matchedBinary = Buffer.from(tar.subarray(dataStart, dataEnd));
      }
    }
  }

  if (!matchedBinary) {
    throw new Error('binary_not_found_in_tarball');
  }
  return matchedBinary;
}

function defaultVerifyVersion(binPath: string, timeoutMs: number): string | undefined {
  const out = execFileSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstLine = String(out).split(/\r?\n/)[0]?.trim();
  return firstLine || undefined;
}

function buildAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

const MAX_REDIRECT_HOPS = 5;

function validateDownloadUrl(rawUrl: string, allowedProto: string, strictOrigin?: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && !(allowedProto === 'http:' && parsed.protocol === 'http:')) {
    throw new Error(`unsafe_tarball_protocol:${parsed.protocol}`);
  }
  if (strictOrigin && parsed.origin !== strictOrigin) {
    throw new Error(`disallowed_external_origin:${parsed.origin}`);
  }
  return parsed.toString();
}

async function fetchWithSafeRedirects(
  fetchFn: typeof fetch,
  initialUrl: string,
  opts: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    allowedProto: string;
    strictOrigin?: string;
  },
): Promise<Response> {
  let currentUrl = validateDownloadUrl(initialUrl, opts.allowedProto, opts.strictOrigin);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const res = await fetchFn(currentUrl, {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      redirect: 'manual',
    });
    if ((res as { type?: string }).type === 'opaqueredirect') {
      throw new Error('unexpected_opaque_redirect');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.('location');
      if (!location) {
        throw new Error(`redirect_missing_location:${res.status}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error('too_many_redirects');
      }
      currentUrl = validateDownloadUrl(new URL(location, currentUrl).toString(), opts.allowedProto, opts.strictOrigin);
      continue;
    }
    return res;
  }
  throw new Error('too_many_redirects');
}

export async function installOpenCodeCli(opts: InstallOpenCodeOptions = {}): Promise<InstallOpenCodeResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform);
  const fetchFn = opts.fetchImpl ?? fetch;
  const verifyVer = opts.verifyVersion ?? defaultVerifyVersion;
  const linkFn = opts.linkFile ?? linkSync;
  const metadataTimeoutMs = opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const tarballTimeoutMs = opts.tarballTimeoutMs ?? DEFAULT_TARBALL_TIMEOUT_MS;
  const versionTimeoutMs = opts.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const isolatedTest = Boolean(opts.isolatedTest || /^(1|true|yes)$/i.test((env.IMCODES_OPENCODE_ISOLATED_TEST ?? '').trim()));

  if (isOpenCodeOptedOut({ skip: opts.skip, env })) {
    opts.logger?.info?.('skipping OpenCode CLI install (IMCODES_SKIP_OPENCODE / --skip)');
    return { status: 'skipped' };
  }

  let existing: string | null;
  try {
    existing = await isOpenCodeAlreadyInstalled({
      homeDir,
      platform,
      env,
      checkFileExecutable: opts.checkFileExecutable,
    });
  } catch (pathErr) {
    const reason = pathErr instanceof Error ? pathErr.message : String(pathErr);
    opts.logger?.warn?.(`unsafe OpenCode target path: ${reason}`);
    return { status: 'failed', reason };
  }
  if (existing) {
    opts.logger?.info?.(`found existing opencode CLI at ${existing} — keeping existing install`);
    return { status: 'existing', path: existing };
  }

  const packageName = resolveOpenCodePlatformPackage({ platform, arch, isMusl: opts.isMusl });
  if (!packageName) {
    opts.logger?.info?.(`OpenCode CLI binary unavailable for ${platform}/${arch}; skipping`);
    return { status: 'unsupported', reason: `unsupported_platform:${platform}/${arch}` };
  }

  const registries = resolveCandidateRegistries({
    registry: opts.registry,
    registries: opts.registries,
    env,
    homeDir,
    noFallback: opts.noFallback,
    isolatedTest,
  });

  if (registries.length === 0) {
    return { status: 'failed', packageName, reason: 'no_valid_registry' };
  }

  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const entryCandidates = [`package/bin/${binaryName}`];
  const binDir = pathMod.join(homeDir, '.opencode', 'bin');
  const destPath = pathMod.join(binDir, binaryName);

  let lastReason = 'unknown_error';

  for (const registry of registries) {
    try {
      const regUrl = new URL(registry);
      const regProto = regUrl.protocol;
      const strictOrigin = isolatedTest ? regUrl.origin : undefined;

      const metaUrl = `${registry}/${encodeURIComponent(packageName)}/latest`;
      const metaRes = await fetchWithSafeRedirects(fetchFn, metaUrl, {
        headers: { accept: 'application/json' },
        signal: buildAbortSignal(metadataTimeoutMs),
        allowedProto: regProto,
        strictOrigin,
      });
      if (!metaRes.ok) {
        throw new Error(`metadata_http_${metaRes.status}`);
      }
      const meta = await metaRes.json() as { version?: unknown; dist?: OpenCodeDistMetadata };
      const dist = meta?.dist;
      const tarballUrl = typeof dist?.tarball === 'string' ? dist.tarball.trim() : '';
      if (!tarballUrl) throw new Error('missing_tarball_url');
      validateDownloadUrl(tarballUrl, regProto, strictOrigin);

      const tarRes = await fetchWithSafeRedirects(fetchFn, tarballUrl, {
        signal: buildAbortSignal(tarballTimeoutMs),
        allowedProto: regProto,
        strictOrigin,
      });
      if (!tarRes.ok) {
        throw new Error(`tarball_http_${tarRes.status}`);
      }
      const tgzBuffer = Buffer.from(await tarRes.arrayBuffer());
      if (tgzBuffer.length === 0 || tgzBuffer.length > MAX_TARBALL_BYTES) {
        throw new Error(`invalid_tarball_size:${tgzBuffer.length}`);
      }

      verifyBufferIntegrity(tgzBuffer, dist!);
      const binaryBuf = extractBinaryFromTarGz(tgzBuffer, entryCandidates);

      if ((platform === 'win32') === (process.platform === 'win32')) {
        ensureSafeOpenCodePaths(homeDir, binDir, destPath, platform, true);
      } else {
        mkdirSync(binDir, { recursive: true });
      }

      const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmpPath = pathMod.join(binDir, `.tmp-${uniqueSuffix}-${binaryName}`);
      const metaVersion = typeof meta.version === 'string' ? meta.version.trim() : undefined;
      let detectedVersion: string | undefined;

      try {
        writeFileSync(tmpPath, binaryBuf, {
          flag: 'wx',
          ...(platform !== 'win32' ? { mode: 0o755 } : {}),
        });
        if (platform !== 'win32') {
          chmodSync(tmpPath, 0o755);
        }

        try {
          detectedVersion = verifyVer(tmpPath, versionTimeoutMs);
        } catch (verErr) {
          const msg = verErr instanceof Error ? verErr.message : String(verErr);
          opts.logger?.warn?.(`staged OpenCode CLI version probe failed: ${msg}`);
          return {
            status: 'unverified',
            version: metaVersion,
            packageName,
            registry,
            reason: msg,
          };
        }

        let publishedAsExisting = false;
        try {
          linkFn(tmpPath, destPath);
        } catch (linkErr: unknown) {
          const code = (linkErr as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EEXIST') {
            publishedAsExisting = true;
          } else {
            throw linkErr;
          }
        }

        if (publishedAsExisting) {
          opts.logger?.info?.(`found concurrent opencode CLI at ${destPath} — keeping existing install`);
          return {
            status: 'existing',
            path: destPath,
            version: detectedVersion || metaVersion,
            packageName,
            registry,
          };
        }
      } finally {
        try {
          rmSync(tmpPath, { force: true });
        } catch { /* ignore cleanup error */ }
      }

      if (platform !== 'win32') {
        try {
          accessSync(destPath, fsConstants.X_OK);
        } catch {
          chmodSync(destPath, 0o755);
        }
      }

      const finalVersion = detectedVersion || metaVersion;
      opts.logger?.info?.(`installed opencode CLI${finalVersion ? ` (${finalVersion})` : ''} at ${destPath}`);
      return {
        status: 'installed',
        path: destPath,
        version: finalVersion,
        packageName,
        registry,
      };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`attempt from ${registry} failed (${lastReason})`);
    }
  }

  return {
    status: 'failed',
    packageName,
    reason: lastReason,
  };
}

function parseCliArgs(argv: string[]): {
  homeDir?: string;
  skip: boolean;
  registry?: string;
  noFallback: boolean;
  isolatedTest: boolean;
  strict: boolean;
  quiet: boolean;
  timeoutMs?: number;
} {
  const out: ReturnType<typeof parseCliArgs> = {
    skip: false,
    noFallback: false,
    isolatedTest: false,
    strict: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' && i + 1 < argv.length) {
      out.homeDir = argv[++i];
    } else if (arg === '--registry' && i + 1 < argv.length) {
      out.registry = argv[++i];
    } else if (arg === '--timeout-ms' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) out.timeoutMs = parsed;
    } else if (arg === '--skip') {
      out.skip = true;
    } else if (arg === '--no-fallback') {
      out.noFallback = true;
    } else if (arg === '--isolated-test') {
      out.isolatedTest = true;
      out.noFallback = true;
    } else if (arg === '--strict') {
      out.strict = true;
    } else if (arg === '--quiet') {
      out.quiet = true;
    }
  }
  return out;
}

export async function runInstallOpenCodeCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const logger = args.quiet
    ? {}
    : {
        info: (msg: string) => console.log(`[opencode-install] ${msg}`),
        warn: (msg: string) => console.error(`[opencode-install] WARNING: ${msg}`),
      };
  try {
    const res = await installOpenCodeCli({
      ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      ...(args.registry ? { registry: args.registry } : {}),
      ...(args.skip ? { skip: true } : {}),
      ...(args.noFallback ? { noFallback: true } : {}),
      ...(args.isolatedTest ? { isolatedTest: true } : {}),
      ...(args.timeoutMs ? { metadataTimeoutMs: args.timeoutMs, tarballTimeoutMs: args.timeoutMs } : {}),
      logger,
    });
    if ((res.status === 'failed' || res.status === 'unverified') && args.strict) {
      return 1;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!args.quiet) console.error(`[opencode-install] WARNING: ${msg}`);
    return args.strict ? 1 : 0;
  }
}

function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runInstallOpenCodeCli(process.argv.slice(2));
  process.exitCode = code;
}
