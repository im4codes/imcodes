import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isCapabilityCredentialFreeHttpsUrl } from '../../shared/capability-management.js';
import { getCapabilityQuarantineRoot } from './managed-skill-paths.js';
import { MANAGED_SKILL_PACKAGE_LIMITS, inventoryAgentSkillPackage, type AgentSkillPackageInventory } from './agent-skill-package.js';

export const SKILL_SOURCE_KINDS = ['inline', 'local_directory', 'https_archive', 'repository'] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export type SkillAcquisitionSource =
  | { kind: 'inline'; files: Record<string, string> }
  | { kind: 'local_directory'; path: string }
  | { kind: 'https_archive'; url: string }
  | { kind: 'repository'; url: string; ref?: string; subdirectory?: string };

export type SkillAcquisitionErrorCode =
  | 'unsupported_source'
  | 'invalid_source_path'
  | 'source_link_not_allowed'
  | 'source_special_file_not_allowed'
  | 'source_mutated'
  | 'source_too_large'
  | 'source_timeout'
  | 'source_redirect_invalid'
  | 'source_archive_invalid';

export class SkillAcquisitionError extends Error {
  constructor(readonly code: SkillAcquisitionErrorCode, message: string = code) {
    super(message);
    this.name = 'SkillAcquisitionError';
  }
}

export interface AcquiredSkillPackage {
  quarantinePath: string;
  sourceLabel: string;
  sourceKind: SkillSourceKind;
  inventory: AgentSkillPackageInventory;
  cleanup(): void;
}

/** Process-start recovery: no in-memory operation can own an old quarantine. */
export function cleanupAbandonedCapabilityQuarantine(homeDir = homedir()): void {
  const root = getCapabilityQuarantineRoot(homeDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

export interface SkillAcquisitionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_FORGE_METADATA_BYTES = 1024 * 1024;
const SUPPORTED_PUBLIC_FORGE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

function assertRelativePackagePath(value: string): string {
  if (!value || value.includes('\0') || value.includes(':') || isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value)) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  const normalized = normalize(value).split('\\').join('/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  return normalized.replace(/^\.\//, '');
}

function copyLocalDirectory(source: string, destination: string): string {
  const root = resolve(source);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SkillAcquisitionError('invalid_source_path');
  let fileCount = 0;
  let totalBytes = 0;
  const verify = (directory: string, depth: number): void => {
    if (depth > MANAGED_SKILL_PACKAGE_LIMITS.maxDepth) throw new SkillAcquisitionError('source_too_large');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new SkillAcquisitionError('source_link_not_allowed');
      if (stat.isDirectory()) {
        verify(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new SkillAcquisitionError('source_special_file_not_allowed');
      if (stat.nlink > 1) throw new SkillAcquisitionError('source_link_not_allowed');
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MANAGED_SKILL_PACKAGE_LIMITS.maxFiles || totalBytes > MANAGED_SKILL_PACKAGE_LIMITS.maxPackageBytes) {
        throw new SkillAcquisitionError('source_too_large');
      }
    }
  };
  verify(root, 0);
  const sourceDigest = inventoryAgentSkillPackage(root).treeDigest;
  cpSync(root, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    filter: (path) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new SkillAcquisitionError('source_link_not_allowed');
      if (!stat.isDirectory() && !stat.isFile()) throw new SkillAcquisitionError('source_special_file_not_allowed');
      return true;
    },
  });
  return sourceDigest;
}

function writeInlineFiles(files: Record<string, string>, destination: string): void {
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MANAGED_SKILL_PACKAGE_LIMITS.maxFiles) {
    throw new SkillAcquisitionError('source_too_large');
  }
  let totalBytes = 0;
  const folded = new Set<string>();
  for (const [rawPath, content] of entries) {
    const path = assertRelativePackagePath(rawPath);
    const foldedPath = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (folded.has(foldedPath)) throw new SkillAcquisitionError('invalid_source_path');
    folded.add(foldedPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    totalBytes += bytes;
    if (bytes > MANAGED_SKILL_PACKAGE_LIMITS.maxFileBytes || totalBytes > MANAGED_SKILL_PACKAGE_LIMITS.maxPackageBytes) {
      throw new SkillAcquisitionError('source_too_large');
    }
    const target = join(destination, path);
    const rel = relative(destination, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new SkillAcquisitionError('invalid_source_path');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
}

function credentialFreeHttpsUrl(value: string): URL {
  if (!isCapabilityCredentialFreeHttpsUrl(value)) throw new SkillAcquisitionError('invalid_source_path');
  return new URL(value);
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLocaleLowerCase('en-US');
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1'
      && !normalized.startsWith('fc') && !normalized.startsWith('fd')
      && !/^fe[89ab]/.test(normalized) && !normalized.startsWith('ff')
      && !normalized.startsWith('2001:db8:');
  }
  return false;
}

interface PinnedHttpsTarget {
  url: URL;
  addresses: readonly string[];
}

async function assertPublicHttpsUrl(value: string, options: SkillAcquisitionOptions): Promise<PinnedHttpsTarget> {
  const url = credentialFreeHttpsUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await (options.resolveHost
      ? options.resolveHost(hostname)
      : lookup(hostname, { all: true, verbatim: true }).then((items) => items.map((item) => item.address)));
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  return { url, addresses };
}

/**
 * Production HTTPS transport whose connect-time lookup is pinned to the exact
 * public addresses validated above. TLS still verifies the original hostname.
 * A caller-supplied fetchImpl is an explicit test seam and is never used by the
 * production adapter.
 */
async function fetchPinnedHttps(
  target: PinnedHttpsTarget,
  init: RequestInit,
): Promise<Response> {
  const address = target.addresses[0];
  const family = isIP(address);
  if (!address || (family !== 4 && family !== 6)) throw new SkillAcquisitionError('invalid_source_path');
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    let settled = false;
    const request = httpsRequest(target.url, {
      method: 'GET',
      headers: init.headers as Record<string, string> | undefined,
      servername: target.url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    }, (incoming) => {
      settled = true;
      const headers = new Headers();
      for (const [name, rawValue] of Object.entries(incoming.headers)) {
        if (Array.isArray(rawValue)) rawValue.forEach((entry) => headers.append(name, entry));
        else if (rawValue !== undefined) headers.set(name, rawValue);
      }
      resolveResponse(new Response(
        Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        { status: incoming.statusCode ?? 500, statusText: incoming.statusMessage, headers },
      ));
    });
    const abort = (): void => {
      request.destroy(init.signal?.reason instanceof Error
        ? init.signal.reason
        : new Error('skill source aborted'));
    };
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    request.once('error', (error) => {
      if (!settled) rejectResponse(error);
    });
    request.end();
  });
}

function isSupportedRepositoryHost(hostname: string): boolean {
  return SUPPORTED_PUBLIC_FORGE_HOSTS.has(hostname.toLocaleLowerCase('en-US'));
}

async function fetchBounded(
  urlValue: string,
  options: SkillAcquisitionOptions,
  maxBytes: number,
  headers?: Readonly<Record<string, string>>,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('skill source timeout')), options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
  let target = await assertPublicHttpsUrl(urlValue, options);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const requestInit: RequestInit = { redirect: 'manual', signal: controller.signal, headers };
      const response = options.fetchImpl
        ? await options.fetchImpl(target.url, requestInit)
        : await fetchPinnedHttps(target, requestInit);
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)) throw new SkillAcquisitionError('source_redirect_invalid');
        const location = response.headers.get('location');
        if (!location) throw new SkillAcquisitionError('source_redirect_invalid');
        target = await assertPublicHttpsUrl(new URL(location, target.url).toString(), options);
        continue;
      }
      if (!response.ok) throw new SkillAcquisitionError('invalid_source_path');
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new SkillAcquisitionError('source_too_large');
      }
      if (!response.body) throw new SkillAcquisitionError('invalid_source_path');
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new SkillAcquisitionError('source_too_large');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    }
  } catch (error) {
    if (controller.signal.aborted) throw new SkillAcquisitionError('source_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoundedArchive(urlValue: string, options: SkillAcquisitionOptions): Promise<Buffer> {
  return fetchBounded(urlValue, options, MANAGED_SKILL_PACKAGE_LIMITS.maxPackageBytes);
}

async function fetchForgeCommit(
  url: string,
  field: 'sha' | 'id' | 'hash',
  options: SkillAcquisitionOptions,
): Promise<string> {
  const bytes = await fetchBounded(url, options, MAX_FORGE_METADATA_BYTES, {
    Accept: 'application/json',
    'User-Agent': 'imcodes-capability-admission',
  });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new SkillAcquisitionError('invalid_source_path'); }
  const commit = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field]
    : undefined;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  return commit.toLocaleLowerCase('en-US');
}

function normalizedRepositoryRef(value = 'HEAD'): string {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value)
    || value.includes('..') || value.includes('@{') || value.startsWith('/') || value.endsWith('/')
    || value.endsWith('.') || value.endsWith('.lock')) throw new SkillAcquisitionError('invalid_source_path');
  return value;
}

interface ForgeArchive {
  canonicalUrl: string;
  metadataUrl: string;
  metadataField: 'sha' | 'id' | 'hash';
  archiveUrl(commit: string): string;
}

function forgeArchive(sourceUrl: URL, ref: string): ForgeArchive {
  let segments: string[];
  try { segments = sourceUrl.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)); } catch {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SkillAcquisitionError('invalid_source_path');
  }
  const last = segments[segments.length - 1].replace(/\.git$/i, '');
  if (!last) throw new SkillAcquisitionError('invalid_source_path');
  segments[segments.length - 1] = last;
  const encodedRef = encodeURIComponent(ref);
  if (sourceUrl.hostname === 'github.com') {
    if (segments.length !== 2) throw new SkillAcquisitionError('invalid_source_path');
    const [owner, repository] = segments.map(encodeURIComponent);
    return {
      canonicalUrl: `https://github.com/${owner}/${repository}`,
      metadataUrl: `https://api.github.com/repos/${owner}/${repository}/commits/${encodedRef}`,
      metadataField: 'sha',
      archiveUrl: (commit) => `https://codeload.github.com/${owner}/${repository}/tar.gz/${commit}`,
    };
  }
  if (sourceUrl.hostname === 'gitlab.com') {
    const project = segments.map(encodeURIComponent).join('/');
    const projectId = encodeURIComponent(segments.join('/'));
    const repository = encodeURIComponent(last);
    return {
      canonicalUrl: `https://gitlab.com/${project}`,
      metadataUrl: `https://gitlab.com/api/v4/projects/${projectId}/repository/commits/${encodedRef}`,
      metadataField: 'id',
      archiveUrl: (commit) => `https://gitlab.com/${project}/-/archive/${commit}/${repository}-${commit}.tar.gz`,
    };
  }
  if (segments.length !== 2) throw new SkillAcquisitionError('invalid_source_path');
  const [owner, repository] = segments.map(encodeURIComponent);
  return {
    canonicalUrl: `https://bitbucket.org/${owner}/${repository}`,
    metadataUrl: `https://api.bitbucket.org/2.0/repositories/${owner}/${repository}/commit/${encodedRef}`,
    metadataField: 'hash',
    archiveUrl: (commit) => `https://bitbucket.org/${owner}/${repository}/get/${commit}.tar.gz`,
  };
}

async function extractTarGzip(buffer: Buffer, destination: string): Promise<void> {
  if (buffer.length < 3 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) throw new SkillAcquisitionError('source_archive_invalid');
  const archivePath = join(dirname(destination), `${basename(destination)}.tgz`);
  writeFileSync(archivePath, buffer, { mode: 0o600, flag: 'wx' });
  let extractedBytes = 0;
  let extractedFiles = 0;
  const foldedPaths = new Set<string>();
  try {
    const tar = await import('tar');
    await tar.x({
      file: archivePath,
      cwd: destination,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const normalizedPath = assertRelativePackagePath(path);
        if (path.includes('\\') || normalizedPath.split('/').length - 1 > MANAGED_SKILL_PACKAGE_LIMITS.maxDepth) {
          throw new SkillAcquisitionError('invalid_source_path');
        }
        const entryRecord = entry as { type?: unknown; isDirectory?: () => boolean; isFile?: () => boolean };
        const entryType = entryRecord.type;
        const type = entryType !== undefined
          ? String(entryType)
          : (entryRecord.isDirectory?.() ? 'Directory' : entryRecord.isFile?.() ? 'File' : 'Other');
        if (type === 'SymbolicLink' || type === 'Link') throw new SkillAcquisitionError('source_link_not_allowed');
        if (type !== 'File' && type !== 'Directory' && type !== 'OldFile' && type !== 'ContiguousFile') {
          throw new SkillAcquisitionError('source_special_file_not_allowed');
        }
        if (type !== 'Directory') {
          const size = Number((entry as { size?: unknown }).size ?? 0);
          if (!Number.isSafeInteger(size) || size < 0 || size > MANAGED_SKILL_PACKAGE_LIMITS.maxFileBytes) {
            throw new SkillAcquisitionError('source_too_large');
          }
          extractedFiles += 1;
          extractedBytes += size;
          if (extractedFiles > MANAGED_SKILL_PACKAGE_LIMITS.maxFiles
            || extractedBytes > MANAGED_SKILL_PACKAGE_LIMITS.maxPackageBytes) {
            throw new SkillAcquisitionError('source_too_large');
          }
          const folded = normalizedPath.normalize('NFKC').toLocaleLowerCase('en-US');
          if (foldedPaths.has(folded)) throw new SkillAcquisitionError('invalid_source_path');
          foldedPaths.add(folded);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SkillAcquisitionError) throw error;
    throw new SkillAcquisitionError('source_archive_invalid');
  } finally {
    rmSync(archivePath, { force: true });
  }
}

async function acquireRepository(source: Extract<SkillAcquisitionSource, { kind: 'repository' }>, destination: string, options: SkillAcquisitionOptions): Promise<string> {
  const { url: sourceUrl } = await assertPublicHttpsUrl(source.url, options);
  if (!isSupportedRepositoryHost(sourceUrl.hostname)) {
    // Generic and content-safe: do not echo a caller-controlled hostname/path.
    // Custom/self-hosted repositories can be exported as a bounded HTTPS tgz.
    throw new SkillAcquisitionError('unsupported_source', 'Repository host is not supported; use a bounded HTTPS tar archive');
  }
  if (sourceUrl.search || sourceUrl.hash) throw new SkillAcquisitionError('invalid_source_path');
  const forge = forgeArchive(sourceUrl, normalizedRepositoryRef(source.ref));
  const repositoryPath = `${destination}.repository`;
  try {
    const commit = await fetchForgeCommit(forge.metadataUrl, forge.metadataField, options);
    const archive = await fetchBoundedArchive(forge.archiveUrl(commit), options);
    mkdirSync(repositoryPath, { mode: 0o700 });
    await extractTarGzip(archive, repositoryPath);
    const archiveEntries = readdirSync(repositoryPath);
    if (archiveEntries.length !== 1 || !lstatSync(join(repositoryPath, archiveEntries[0])).isDirectory()) {
      throw new SkillAcquisitionError('source_archive_invalid');
    }
    const extractedRoot = join(repositoryPath, archiveEntries[0]);
    const subdirectory = source.subdirectory ? assertRelativePackagePath(source.subdirectory) : '';
    const packageRoot = resolve(extractedRoot, subdirectory);
    const rel = relative(extractedRoot, packageRoot);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new SkillAcquisitionError('invalid_source_path');
    copyLocalDirectory(packageRoot, destination);
    return `${forge.canonicalUrl}@${commit}`;
  } catch (error) {
    if (error instanceof SkillAcquisitionError) throw error;
    throw new SkillAcquisitionError('invalid_source_path');
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
}

export function acquireSkillPackage(source: Extract<SkillAcquisitionSource, { kind: 'inline' | 'local_directory' }>, homeDir?: string, options?: SkillAcquisitionOptions): AcquiredSkillPackage;
export function acquireSkillPackage(source: Extract<SkillAcquisitionSource, { kind: 'https_archive' | 'repository' }>, homeDir?: string, options?: SkillAcquisitionOptions): Promise<AcquiredSkillPackage>;
export function acquireSkillPackage(source: SkillAcquisitionSource, homeDir?: string, options?: SkillAcquisitionOptions): AcquiredSkillPackage | Promise<AcquiredSkillPackage>;
export function acquireSkillPackage(source: SkillAcquisitionSource, homeDir = homedir(), options: SkillAcquisitionOptions = {}): AcquiredSkillPackage | Promise<AcquiredSkillPackage> {
  const quarantineRoot = getCapabilityQuarantineRoot(homeDir);
  mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const quarantinePath = join(quarantineRoot, randomUUID());
  mkdirSync(quarantinePath, { mode: 0o700 });
  const cleanup = (): void => rmSync(quarantinePath, { recursive: true, force: true });
  const finish = (sourceLabel: string, expectedDigest?: string): AcquiredSkillPackage => {
    const inventory = inventoryAgentSkillPackage(quarantinePath);
    if (expectedDigest && inventory.treeDigest !== expectedDigest) throw new SkillAcquisitionError('source_mutated');
    if (source.kind === 'local_directory' && basename(resolve(source.path)).normalize('NFKC') !== inventory.frontMatter.name) {
      throw new SkillAcquisitionError('invalid_source_path', 'Skill name must match its source directory name');
    }
    return { quarantinePath, sourceLabel, sourceKind: source.kind, inventory, cleanup };
  };
  try {
    let sourceLabel: string;
    let expectedDigest: string | undefined;
    if (source.kind === 'inline') {
      writeInlineFiles(source.files, quarantinePath);
      sourceLabel = 'inline-package';
    } else if (source.kind === 'local_directory') {
      expectedDigest = copyLocalDirectory(source.path, quarantinePath);
      sourceLabel = basename(resolve(source.path));
    } else if (source.kind === 'https_archive') {
      return fetchBoundedArchive(source.url, options)
        .then(async (buffer) => { await extractTarGzip(buffer, quarantinePath); return finish(source.url); })
        .catch((error) => { cleanup(); throw error; });
    } else {
      return acquireRepository(source, quarantinePath, options)
        .then((label) => finish(label))
        .catch((error) => { cleanup(); throw error; });
    }
    return finish(sourceLabel, expectedDigest);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export const SKILL_ACQUISITION_TESTING = {
  assertRelativePackagePath,
  isPublicAddress,
  isSupportedRepositoryHost,
};
