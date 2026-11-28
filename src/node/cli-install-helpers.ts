import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { createGunzip } from 'node:zlib';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

export const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
export const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

const MAX_REDIRECT_HOPS = 5;
const MAX_TAR_METADATA_ENTRY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_TAR_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

export interface NpmDistMetadata {
  tarball?: string;
  integrity?: string;
  shasum?: string;
}

export interface CliInstallLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface InstallCliResult {
  status: 'installed' | 'existing' | 'skipped' | 'unsupported' | 'unverified' | 'failed';
  path?: string;
  version?: string;
  packageName?: string;
  registry?: string;
  reason?: string;
}

export function parseBooleanEnv(raw: unknown): boolean {
  return typeof raw === 'string' && /^(1|true|yes)$/i.test(raw.trim());
}

export function encodeNpmPackageName(packageName: string): string {
  return packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
}

export function getPathModule(platform: NodeJS.Platform, samplePath?: string) {
  if (platform === 'win32' && samplePath && samplePath.startsWith('/') && process.platform !== 'win32') {
    return path.posix;
  }
  return platform === 'win32' ? path.win32 : path.posix;
}

export function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (key in env) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function defaultIsLinuxMusl(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  return report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
}

export async function defaultCheckFileExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
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

export function isWithinRealRoot(targetReal: string, rootReal: string, platform: NodeJS.Platform): boolean {
  const p = getPathModule(platform, rootReal);
  const normTarget = platform === 'win32' ? targetReal.toLowerCase() : targetReal;
  const normRoot = platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const rel = p.relative(normRoot, normTarget);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

export function assertExistingDirSafeWithinHome(
  dirPath: string,
  canonicalHome: string,
  label: string,
  platform: NodeJS.Platform,
): boolean {
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

function mkdirIgnoreConcurrentExists(dirPath: string): void {
  try {
    mkdirSync(dirPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
      throw err;
    }
  }
}

export function ensureSafePathWithinHome(
  homeDir: string,
  relDirs: readonly string[],
  targetFileName: string | undefined,
  platform: NodeJS.Platform,
  createDirs: boolean,
): { dirPath: string; targetPath?: string } {
  const p = getPathModule(platform, homeDir);

  if (!existsSync(homeDir)) {
    if (!createDirs) {
      const dirPath = p.join(homeDir, ...relDirs);
      return { dirPath, ...(targetFileName ? { targetPath: p.join(dirPath, targetFileName) } : {}) };
    }
    mkdirSync(homeDir, { recursive: true });
  }
  if (lstatSync(homeDir).isSymbolicLink()) {
    throw new Error('unsafe_symlink_target:homeDir');
  }
  const canonicalHome = realpathSync(homeDir);

  let currentDir = homeDir;
  const walkedLabels: string[] = [];
  for (const segment of relDirs) {
    currentDir = p.join(currentDir, segment);
    walkedLabels.push(segment);
    const label = walkedLabels.join('/');
    if (!assertExistingDirSafeWithinHome(currentDir, canonicalHome, label, platform)) {
      if (!createDirs) {
        const dirPath = p.join(homeDir, ...relDirs);
        return { dirPath, ...(targetFileName ? { targetPath: p.join(dirPath, targetFileName) } : {}) };
      }
      mkdirIgnoreConcurrentExists(currentDir);
      assertExistingDirSafeWithinHome(currentDir, canonicalHome, label, platform);
    }
  }

  if (!targetFileName) {
    return { dirPath: currentDir };
  }

  const destPath = p.join(currentDir, targetFileName);
  try {
    const destStat = lstatSync(destPath);
    if (destStat.isSymbolicLink()) {
      throw new Error(`unsafe_symlink_target:${targetFileName}`);
    }
    const realParent = realpathSync(p.dirname(destPath));
    if (!isWithinRealRoot(realParent, canonicalHome, platform)) {
      throw new Error(`unsafe_target_escape:${targetFileName}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw err;
    }
  }

  return { dirPath: currentDir, targetPath: destPath };
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

export function isLoopbackHostname(hostname: string): boolean {
  const norm = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return norm === '127.0.0.1' || norm === '::1' || norm === 'localhost' || norm === '0:0:0:0:0:0:0:1';
}

export function filterCandidatesForIsolation(candidates: readonly string[], isolatedTest: boolean): string[] {
  if (!isolatedTest) return [...candidates];
  return candidates.filter((candidate) => {
    try {
      return isLoopbackHostname(new URL(candidate).hostname);
    } catch {
      return false;
    }
  });
}

export function collectConfiguredNonLoopbackUrls(urls: Array<string | undefined>): string[] {
  const rejected: string[] = [];
  for (const raw of urls) {
    const normalized = normalizeRegistryUrl(raw);
    if (!normalized) continue;
    try {
      const parsed = new URL(normalized);
      if (!isLoopbackHostname(parsed.hostname)) rejected.push(parsed.origin);
    } catch {
      // ignore unparseable
    }
  }
  return [...new Set(rejected)];
}

export function resolveCandidateNpmRegistries(opts: {
  registry?: string;
  registries?: string[];
  customEnvKey?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  noFallback?: boolean;
  isolatedTest?: boolean;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const isolatedTest = Boolean(opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST));
  const candidates: Array<string | null> = [];

  if (Array.isArray(opts.registries) && opts.registries.length > 0) {
    for (const r of opts.registries) candidates.push(normalizeRegistryUrl(r));
    return filterCandidatesForIsolation(
      [...new Set(candidates.filter((v): v is string => Boolean(v)))],
      isolatedTest,
    );
  }

  candidates.push(normalizeRegistryUrl(opts.registry));
  if (opts.customEnvKey) {
    candidates.push(normalizeRegistryUrl(env[opts.customEnvKey]));
  }
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

  const noFallback = opts.noFallback || parseBooleanEnv(env.IMCODES_OPENCODE_NO_FALLBACK);
  if (!isolatedTest && !noFallback) {
    candidates.push(NPM_OFFICIAL_REGISTRY);
    candidates.push(NPM_MIRROR_REGISTRY);
  }

  return filterCandidatesForIsolation(
    [...new Set(candidates.filter((v): v is string => Boolean(v)))],
    isolatedTest,
  );
}

export function findCommandInEnvPath(
  names: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const rawPath = (platform === 'win32' ? readEnvCaseInsensitive(env, 'PATH') : env.PATH) ?? '';
  const pathDirs = rawPath.split(delimiter).map((d) => d.trim()).filter(Boolean);
  const p = getPathModule(platform, pathDirs[0]);
  if (platform === 'win32') {
    const pathext = (readEnvCaseInsensitive(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
      .split(';')
      .map((ext) => ext.trim())
      .filter(Boolean);
    const expandedNames = [...new Set(names.flatMap((base) => {
      const stripped = base.replace(/\.(exe|cmd|bat|com)$/i, '');
      return [`${stripped}.exe`, ...pathext.map((ext) => `${stripped}${ext.toLowerCase()}`), stripped];
    }))];
    const out: string[] = [];
    for (const dir of pathDirs) {
      for (const name of expandedNames) {
        out.push(p.join(dir, name));
      }
    }
    return out;
  }
  const out: string[] = [];
  for (const dir of pathDirs) {
    for (const name of names) {
      out.push(p.join(dir, name));
    }
  }
  return out;
}

export function buildAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && timeoutMs > 0) {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

export function validateDownloadUrl(
  rawUrl: string,
  allowedProto: string,
  strictOrigin?: string,
  isolatedTest = false,
): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && !(allowedProto === 'http:' && parsed.protocol === 'http:')) {
    throw new Error(`unsafe_tarball_protocol:${parsed.protocol}`);
  }
  if (isolatedTest && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`disallowed_non_loopback_isolated_origin:${parsed.origin}`);
  }
  if (strictOrigin && parsed.origin !== strictOrigin) {
    throw new Error(`disallowed_external_origin:${parsed.origin}`);
  }
  return parsed.toString();
}

interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

function readProxyConfig(env: NodeJS.ProcessEnv): ProxyConfig | null {
  const httpsProxy = readEnvCaseInsensitive(env, 'HTTPS_PROXY')?.trim();
  const httpProxy = readEnvCaseInsensitive(env, 'HTTP_PROXY')?.trim();
  const allProxy = readEnvCaseInsensitive(env, 'ALL_PROXY')?.trim();
  const noProxy = readEnvCaseInsensitive(env, 'NO_PROXY')?.trim();
  const resolvedHttps = httpsProxy || httpProxy || allProxy;
  const resolvedHttp = httpProxy || allProxy;
  if (!resolvedHttps && !resolvedHttp) return null;
  return {
    ...(resolvedHttp ? { httpProxy: resolvedHttp } : {}),
    ...(resolvedHttps ? { httpsProxy: resolvedHttps } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

function shouldBypassProxy(targetUrl: URL, noProxy?: string): boolean {
  if (!noProxy) return false;
  const targetHost = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
  for (const rawEntry of noProxy.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let hostPattern = entry;
    let portPattern: string | null = null;
    if (entry.startsWith('[')) {
      const closeIdx = entry.indexOf(']');
      if (closeIdx !== -1) {
        hostPattern = entry.slice(1, closeIdx);
        if (entry[closeIdx + 1] === ':') {
          portPattern = entry.slice(closeIdx + 2);
        }
      }
    } else {
      const colonIdx = entry.lastIndexOf(':');
      if (colonIdx > 0 && entry.indexOf(':') === colonIdx) {
        hostPattern = entry.slice(0, colonIdx);
        portPattern = entry.slice(colonIdx + 1);
      }
    }
    if (portPattern && portPattern !== targetPort) continue;
    const stripped = hostPattern.replace(/^\./, '');
    if (!stripped) continue;
    if (targetHost === stripped || (hostPattern.startsWith('.') ? targetHost.endsWith(`.${stripped}`) : targetHost.endsWith(`.${stripped}`))) {
      return true;
    }
  }
  return false;
}

function buildHeadersObject(rawHeaders: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawHeaders) return out;
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) {
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function incomingMessageToWebResponse(res: http.IncomingMessage): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (typeof v === 'string') {
      headers.set(k, v);
    }
  }
  const isNullBody = status === 204 || status === 205 || status === 304;
  if (isNullBody) {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
    status,
    statusText: res.statusMessage,
    headers,
  });
}

async function sendManagedNodeRequest(
  issueRequest: (
    onResponse: (res: http.IncomingMessage) => void,
    onError: (err: unknown) => void,
    registerDestroy: (fn: () => void) => void,
  ) => void,
  signal: AbortSignal | undefined,
  wrapErr: (err: unknown) => Error,
): Promise<Response> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let activeRes: http.IncomingMessage | null = null;
    const destroyHooks: Array<() => void> = [];

    const destroyAll = () => {
      for (let i = destroyHooks.length - 1; i >= 0; i -= 1) {
        try { destroyHooks[i]!(); } catch { /* ignore */ }
      }
    };

    const detachAbort = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      const abortErr = signal?.reason instanceof Error ? signal.reason : new Error('aborted');
      if (activeRes && !activeRes.destroyed) {
        try {
          activeRes.destroy(abortErr);
        } catch {
          // ignore
        }
      }
      destroyAll();
      if (!settled) {
        settled = true;
        detachAbort();
        reject(abortErr);
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const onError = (err: unknown) => {
      destroyAll();
      if (!settled) {
        settled = true;
        detachAbort();
        reject(wrapErr(err));
      }
    };

    const onResponse = (res: http.IncomingMessage) => {
      if (settled) {
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      activeRes = res;
      // Keep abort listener active until response body stream completes or closes.
      const cleanupOnBodyFinish = () => {
        detachAbort();
        destroyAll();
      };
      res.once('end', detachAbort);
      res.once('close', cleanupOnBodyFinish);
      res.once('error', detachAbort);
      settled = true;
      resolve(incomingMessageToWebResponse(res));
    };

    issueRequest(onResponse, onError, (fn) => {
      destroyHooks.push(fn);
    });
  });
}

async function fetchDirectLoopbackWithoutEnvProxy(urlStr: string, init: RequestInit): Promise<Response> {
  const targetUrl = new URL(urlStr);
  if (!isLoopbackHostname(targetUrl.hostname)) {
    throw new Error(`disallowed_non_loopback_isolated_origin:${targetUrl.origin}`);
  }
  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const targetPort = Number.parseInt(targetUrl.port || (isHttps ? '443' : '80'), 10);
  const reqHeaders = buildHeadersObject(init.headers);
  const directAgent = isHttps
    ? new https.Agent({ keepAlive: false, proxyEnv: {} } as https.AgentOptions)
    : new http.Agent({ keepAlive: false, proxyEnv: {} } as http.AgentOptions);

  return await sendManagedNodeRequest(
    (onResponse, onError, registerDestroy) => {
      registerDestroy(() => directAgent.destroy());
      const req = transport.request(
        {
          hostname: targetHost,
          port: targetPort,
          method: init.method ?? 'GET',
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: { ...reqHeaders, host: targetUrl.host, connection: 'close' },
          agent: directAgent,
        },
        onResponse,
      );
      registerDestroy(() => req.destroy());
      req.on('error', onError);
      req.end();
    },
    init.signal ?? undefined,
    (err) => (err instanceof Error ? err : new Error(String(err))),
  );
}

async function fetchViaNodeHttpProxy(urlStr: string, proxyStr: string, init: RequestInit): Promise<Response> {
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxyStr);
  } catch {
    throw new Error(`proxy_invalid_url:${proxyStr}`);
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`proxy_unsupported_protocol:${proxyUrl.protocol}`);
  }
  const targetUrl = new URL(urlStr);
  const proxyIsHttps = proxyUrl.protocol === 'https:';
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number.parseInt(proxyUrl.port || (proxyIsHttps ? '443' : '80'), 10);
  const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const targetPort = Number.parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'), 10);
  const proxyAuth = (proxyUrl.username || proxyUrl.password)
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
    : undefined;
  const reqHeaders = buildHeadersObject(init.headers);
  const wrapProxyError = (err: unknown): Error => {
    if (err instanceof Error && err.message.startsWith('proxy_')) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`proxy_error:${msg}`);
  };

  const proxyTransport = proxyIsHttps ? https : http;

  return await sendManagedNodeRequest(
    (onResponse, onError, registerDestroy) => {
      if (targetUrl.protocol === 'http:') {
        const directProxyAgent = proxyIsHttps
          ? new https.Agent({ keepAlive: false })
          : new http.Agent({ keepAlive: false });
        registerDestroy(() => directProxyAgent.destroy());
        const req = proxyTransport.request(
          {
            hostname: proxyHost,
            port: proxyPort,
            method: init.method ?? 'GET',
            path: targetUrl.toString(),
            headers: {
              ...reqHeaders,
              host: targetUrl.host,
              connection: 'close',
              ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
            },
            agent: directProxyAgent,
          },
          onResponse,
        );
        registerDestroy(() => req.destroy());
        req.on('error', onError);
        req.end();
        return;
      }

      const authority = `${targetHost.includes(':') ? `[${targetHost}]` : targetHost}:${targetPort}`;
      const connectAgent = proxyIsHttps
        ? new https.Agent({ keepAlive: false })
        : new http.Agent({ keepAlive: false });
      registerDestroy(() => connectAgent.destroy());
      const connectReq = proxyTransport.request({
        hostname: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: authority,
        headers: {
          host: authority,
          ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
        },
        agent: connectAgent,
      });
      registerDestroy(() => connectReq.destroy());
      connectReq.on('error', onError);
      connectReq.once('connect', (connectRes, socket, head) => {
        registerDestroy(() => socket.destroy());
        socket.on('error', onError);
        if ((connectRes.statusCode ?? 0) < 200 || (connectRes.statusCode ?? 0) >= 300) {
          socket.destroy();
          onError(new Error(`proxy_connect_failed:${connectRes.statusCode ?? 0}`));
          return;
        }
        if (head && head.length > 0) {
          socket.unshift(head);
        }
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
        });
        registerDestroy(() => tlsSocket.destroy());
        tlsSocket.on('error', onError);
        tlsSocket.once('secureConnect', () => {
          const tunnelAgent = new http.Agent({ keepAlive: false });
          (tunnelAgent as http.Agent & { createConnection: () => tls.TLSSocket }).createConnection = () => tlsSocket;
          registerDestroy(() => tunnelAgent.destroy());
          const req = http.request(
            {
              hostname: targetHost,
              port: targetPort,
              method: init.method ?? 'GET',
              path: `${targetUrl.pathname}${targetUrl.search}`,
              headers: {
                ...reqHeaders,
                host: targetUrl.host,
                connection: 'close',
              },
              agent: tunnelAgent,
            },
            onResponse,
          );
          registerDestroy(() => req.destroy());
          req.on('error', onError);
          req.end();
        });
      });
      connectReq.end();
    },
    init.signal ?? undefined,
    wrapProxyError,
  );
}

export async function createProxyAwareFetch(
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
  opts: { isolatedTest?: boolean } = {},
): Promise<{ fetchFn: typeof fetch; close: () => Promise<void> }> {
  const isolatedTest = Boolean(opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST));
  if (fetchFn !== fetch) {
    return { fetchFn, close: async () => {} };
  }
  if (isolatedTest) {
    // Bypass Node's global fetch / NODE_USE_ENV_PROXY so isolated loopback runs never hit env proxies.
    const isolatedDirectFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      return await fetchDirectLoopbackWithoutEnvProxy(urlStr, init ?? {});
    };
    return { fetchFn: isolatedDirectFetch, close: async () => {} };
  }
  const proxyCfg = readProxyConfig(env);
  if (!proxyCfg) {
    return { fetchFn, close: async () => {} };
  }
  const wrappedFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const targetUrl = new URL(urlStr);
    if (shouldBypassProxy(targetUrl, proxyCfg.noProxy)) {
      return await fetchFn(input, init);
    }
    const proxyUrl = targetUrl.protocol === 'https:' ? proxyCfg.httpsProxy : proxyCfg.httpProxy;
    if (!proxyUrl) {
      return await fetchFn(input, init);
    }
    return await fetchViaNodeHttpProxy(urlStr, proxyUrl, init ?? {});
  };
  return { fetchFn: wrappedFetch, close: async () => {} };
}

export async function fetchWithSafeRedirects(
  fetchFn: typeof fetch,
  initialUrl: string,
  opts: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    allowedProto: string;
    strictOrigin?: string;
    isolatedTest?: boolean;
  },
): Promise<Response> {
  let currentUrl = validateDownloadUrl(initialUrl, opts.allowedProto, opts.strictOrigin, opts.isolatedTest);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const init: RequestInit = {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      redirect: 'manual',
    };
    const res = await fetchFn(currentUrl, init);
    if ((res as { type?: string }).type === 'opaqueredirect') {
      throw new Error('unexpected_opaque_redirect');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.('location');
      await res.body?.cancel?.().catch(() => {});
      if (!location) {
        throw new Error(`redirect_missing_location:${res.status}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error('too_many_redirects');
      }
      currentUrl = validateDownloadUrl(
        new URL(location, currentUrl).toString(),
        opts.allowedProto,
        opts.strictOrigin,
        opts.isolatedTest,
      );
      continue;
    }
    return res;
  }
  throw new Error('too_many_redirects');
}

type ExpectedDigestCheck =
  | { kind: 'sri'; alg: 'sha512' | 'sha384' | 'sha256'; expectedBuf: Buffer }
  | { kind: 'sha1'; expectedBuf: Buffer };

function selectExpectedDigestCheck(dist: NpmDistMetadata): ExpectedDigestCheck {
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
      const expectedLen = alg === 'sha512' ? 64 : alg === 'sha384' ? 48 : 32;
      let expectedBuf: Buffer;
      try {
        expectedBuf = Buffer.from(expectedB64, 'base64');
      } catch {
        throw new Error(`invalid_integrity_encoding:${alg}`);
      }
      if (expectedBuf.length !== expectedLen) {
        throw new Error(`integrity_mismatch:${alg}`);
      }
      supportedChecked = true;
      return { kind: 'sri', alg, expectedBuf };
    }
    if (supportedChecked) {
      throw new Error('integrity_mismatch:digest');
    }
    throw new Error('unsupported_integrity_format');
  }

  const shasum = typeof dist.shasum === 'string' ? dist.shasum.trim().toLowerCase() : '';
  if (/^[a-f0-9]{40}$/.test(shasum)) {
    return { kind: 'sha1', expectedBuf: Buffer.from(shasum, 'hex') };
  }

  throw new Error('missing_integrity_metadata');
}

class ManagedWriteStream {
  readonly stream: import('node:fs').WriteStream;
  private streamErr: Error | null = null;
  private waiterReject: ((err: Error) => void) | null = null;

  constructor(filePath: string, opts: Parameters<typeof createWriteStream>[1]) {
    this.stream = createWriteStream(filePath, opts);
    this.stream.on('error', (err: Error) => {
      if (!this.streamErr) this.streamErr = err;
      if (this.waiterReject) {
        const reject = this.waiterReject;
        this.waiterReject = null;
        reject(err);
      }
    });
  }

  async write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    if (this.streamErr) throw this.streamErr;
    const ok = this.stream.write(chunk);
    if (this.streamErr) throw this.streamErr;
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        if (this.streamErr) {
          reject(this.streamErr);
          return;
        }
        const cleanup = () => {
          this.stream.off('drain', onDrain);
          this.stream.off('close', onClose);
          if (this.waiterReject === reject) this.waiterReject = null;
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(this.streamErr ?? new Error('write_stream_closed_unexpectedly'));
        };
        this.waiterReject = (err: Error) => {
          cleanup();
          reject(err);
        };
        this.stream.once('drain', onDrain);
        this.stream.once('close', onClose);
      });
    }
  }

  async end(): Promise<void> {
    if (this.streamErr) throw this.streamErr;
    await new Promise<void>((resolve, reject) => {
      if (this.streamErr) {
        reject(this.streamErr);
        return;
      }
      const cleanup = () => {
        this.stream.off('close', onClose);
        if (this.waiterReject === reject) this.waiterReject = null;
      };
      // Wait for 'close' (not just 'finish') so the underlying OS write file descriptor is
      // guaranteed closed before execFileSync / linkSync / chmodSync runs (prevents ETXTBSY).
      const onClose = () => {
        cleanup();
        if (this.streamErr) reject(this.streamErr);
        else resolve();
      };
      this.waiterReject = (err: Error) => {
        cleanup();
        reject(err);
      };
      this.stream.once('close', onClose);
      this.stream.end();
    });
  }

  destroy(): void {
    try {
      this.stream.destroy();
    } catch {
      // ignore destroy errors
    }
  }
}

export async function downloadResponseToFileWithIntegrity(
  res: Response,
  destFilePath: string,
  opts: { maxBytes: number; dist?: NpmDistMetadata; expectedSha512Hex?: string },
): Promise<{ byteLength: number }> {
  let check: { alg: 'sha512' | 'sha384' | 'sha256' | 'sha1'; expectedBuf: Buffer; mismatchErr: string };
  if (opts.expectedSha512Hex !== undefined) {
    const normalized = opts.expectedSha512Hex.trim().toLowerCase();
    if (!/^[a-f0-9]{128}$/.test(normalized)) {
      throw new Error('invalid_sha512_checksum');
    }
    check = { alg: 'sha512', expectedBuf: Buffer.from(normalized, 'hex'), mismatchErr: 'checksum_mismatch:sha512' };
  } else if (opts.dist) {
    const selected = selectExpectedDigestCheck(opts.dist);
    check = selected.kind === 'sri'
      ? { alg: selected.alg, expectedBuf: selected.expectedBuf, mismatchErr: 'integrity_mismatch:digest' }
      : { alg: 'sha1', expectedBuf: selected.expectedBuf, mismatchErr: 'integrity_mismatch:sha1' };
  } else {
    throw new Error('missing_integrity_metadata');
  }

  const hash = createHash(check.alg);
  let byteLength = 0;

  const outStream = new ManagedWriteStream(destFilePath, { flags: 'wx' });
  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    byteLength += chunk.length;
    if (byteLength > opts.maxBytes) {
      throw new Error(`invalid_download_size:${byteLength}`);
    }
    hash.update(chunk);
    await outStream.write(chunk);
  };

  try {
    if (res.body && typeof (res.body as { getReader?: unknown }).getReader === 'function') {
      const nodeReadable = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
      for await (const rawChunk of nodeReadable) {
        const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        await writeChunk(buf);
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeChunk(buf);
    }

    if (byteLength === 0) {
      throw new Error(`invalid_download_size:0`);
    }

    await outStream.end();

    const actualBuf = hash.digest();
    if (actualBuf.length !== check.expectedBuf.length || !timingSafeEqual(actualBuf, check.expectedBuf)) {
      throw new Error(check.mismatchErr);
    }

    return { byteLength };
  } catch (err) {
    outStream.destroy();
    rmSync(destFilePath, { force: true });
    throw err;
  }
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

function readTarMode(buf: Buffer): number {
  try {
    const raw = readTarString(buf, 100, 8).trim();
    if (!raw || !/^[0-7]+$/.test(raw)) return 0o755;
    const mode = Number.parseInt(raw, 8) & 0o777;
    return mode > 0 ? mode : 0o755;
  } catch {
    return 0o755;
  }
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

export function validateTarEntryPath(rawPath: string, typeflag: string): string | null {
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

class TarByteCursor {
  private readonly chunks: Buffer[] = [];
  private avail = 0;
  private ended = false;
  private totalUncompressed = 0;
  private readonly iter: AsyncIterator<Buffer>;

  constructor(
    stream: AsyncIterable<Buffer>,
    private readonly maxUncompressedBytes: number,
  ) {
    this.iter = stream[Symbol.asyncIterator]();
  }

  private async pullNextChunk(): Promise<boolean> {
    if (this.ended) return false;
    const step = await this.iter.next();
    if (step.done) {
      this.ended = true;
      return false;
    }
    const buf = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
    if (buf.length > 0) {
      this.totalUncompressed += buf.length;
      if (this.totalUncompressed > this.maxUncompressedBytes) {
        throw new Error(`tar_uncompressed_limit_exceeded:${this.totalUncompressed}`);
      }
      this.chunks.push(buf);
      this.avail += buf.length;
    }
    return true;
  }

  async ensureAtLeast(n: number): Promise<boolean> {
    while (this.avail < n) {
      if (!(await this.pullNextChunk())) {
        return false;
      }
    }
    return true;
  }

  async readExact(n: number): Promise<Buffer> {
    const ok = await this.ensureAtLeast(n);
    if (!ok) {
      throw new Error('truncated_tar_entry');
    }
    if (this.chunks[0]!.length >= n) {
      const head = this.chunks[0]!;
      const out = head.subarray(0, n);
      if (head.length === n) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(n);
      }
      this.avail -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, n - offset);
      head.copy(out, offset, 0, take);
      offset += take;
      this.avail -= take;
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
    }
    return out;
  }

  async streamExact(n: number, onChunk: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      if (this.avail === 0) {
        if (!(await this.pullNextChunk())) {
          throw new Error('truncated_tar_entry');
        }
        continue;
      }
      const head = this.chunks[0]!;
      const take = Math.min(head.length, remaining);
      const slice = head.subarray(0, take);
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
      this.avail -= take;
      remaining -= take;
      await onChunk(slice);
    }
  }

  async skipExact(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      if (this.avail === 0) {
        if (!(await this.pullNextChunk())) {
          throw new Error('truncated_tar_entry');
        }
        continue;
      }
      const head = this.chunks[0]!;
      const take = Math.min(head.length, remaining);
      this.avail -= take;
      remaining -= take;
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
    }
  }
}

export async function extractSingleBinaryFromTarGzFile(
  tgzPath: string,
  targetEntryPaths: readonly string[],
  destFilePath: string,
  opts: { maxUncompressedBytes?: number; platform?: NodeJS.Platform } = {},
): Promise<{ matchedEntry: string }> {
  const wanted = new Set(targetEntryPaths.map((p) => normalizeTarEntryPath(p)).filter((v): v is string => Boolean(v)));
  if (wanted.size === 0) throw new Error('invalid_target_entry_paths');

  const maxUncompressed = opts.maxUncompressedBytes ?? DEFAULT_MAX_TAR_UNCOMPRESSED_BYTES;
  const gzipRead = createReadStream(tgzPath);
  const gunzip = createGunzip();
  gzipRead.on('error', (err) => gunzip.destroy(err));
  gunzip.on('error', () => { /* captured by consumer or shutdown */ });
  gzipRead.pipe(gunzip);

  const cursor = new TarByteCursor(gunzip as unknown as AsyncIterable<Buffer>, maxUncompressed);
  let nextPax: Record<string, string> = {};
  let nextGnuLongName: string | null = null;
  let globalPax: Record<string, string> = {};
  let matchedEntry: string | null = null;
  let activeOutStream: ManagedWriteStream | null = null;

  try {
    while (await cursor.ensureAtLeast(512)) {
      const header = await cursor.readExact(512);
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

      const padLen = (512 - (size % 512)) % 512;

      if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
        if (size > MAX_TAR_METADATA_ENTRY_BYTES) {
          throw new Error(`tar_metadata_entry_too_large:${size}`);
        }
        const dataBuf = await cursor.readExact(size);
        if (padLen > 0) await cursor.skipExact(padLen);
        if (typeflag === 'x') {
          nextPax = { ...nextPax, ...parsePaxRecords(dataBuf) };
        } else if (typeflag === 'g') {
          globalPax = { ...globalPax, ...parsePaxRecords(dataBuf) };
        } else {
          nextGnuLongName = dataBuf.toString('utf8').replace(/\0.*$/, '');
        }
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

      if (typeflag === '0' && normalized && wanted.has(normalized) && !matchedEntry) {
        if (size === 0) throw new Error('empty_binary_in_tarball');
        const mode = readTarMode(header);
        activeOutStream = new ManagedWriteStream(destFilePath, {
          flags: 'wx',
          ...((opts.platform ?? process.platform) !== 'win32' ? { mode: mode | 0o755 } : {}),
        });
        await cursor.streamExact(size, (chunk) => activeOutStream!.write(chunk));
        await activeOutStream.end();
        activeOutStream = null;
        matchedEntry = normalized;
        if (padLen > 0) await cursor.skipExact(padLen);
        break;
      }

      if (size + padLen > 0) {
        await cursor.skipExact(size + padLen);
      }
    }
  } catch (err) {
    if (activeOutStream) {
      activeOutStream.destroy();
    }
    rmSync(destFilePath, { force: true });
    if (err instanceof Error && (err.message.includes('tar') || err.message.includes('unsafe') || err.message.includes('invalid') || err.message.includes('truncated') || err.message.includes('empty'))) {
      throw err;
    }
    throw new Error(`tarball_gunzip_failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    gzipRead.destroy();
    gunzip.destroy();
  }

  if (!matchedEntry) {
    throw new Error('binary_not_found_in_tarball');
  }
  return { matchedEntry };
}

export async function extractVendorSubtreeFromTarGzFile(
  tgzPath: string,
  destRootDir: string,
  opts: {
    prefixRegex: RegExp;
    requiredRelPaths?: readonly string[];
    maxUncompressedBytes?: number;
    platform?: NodeJS.Platform;
  },
): Promise<{ extractedFiles: string[]; capturedGroup?: string }> {
  const maxUncompressed = opts.maxUncompressedBytes ?? DEFAULT_MAX_TAR_UNCOMPRESSED_BYTES;
  const platform = opts.platform ?? process.platform;
  const pathMod = getPathModule(platform, destRootDir);
  const gzipRead = createReadStream(tgzPath);
  const gunzip = createGunzip();
  gzipRead.on('error', (err) => gunzip.destroy(err));
  gunzip.on('error', () => { /* captured by consumer or shutdown */ });
  gzipRead.pipe(gunzip);

  const cursor = new TarByteCursor(gunzip as unknown as AsyncIterable<Buffer>, maxUncompressed);
  let nextPax: Record<string, string> = {};
  let nextGnuLongName: string | null = null;
  let globalPax: Record<string, string> = {};
  let capturedGroup: string | undefined;
  const extractedFiles: string[] = [];
  let activeOutStream: ManagedWriteStream | null = null;

  mkdirSync(destRootDir, { recursive: true });
  const canonicalDestRoot = realpathSync(destRootDir);

  try {
    while (await cursor.ensureAtLeast(512)) {
      const header = await cursor.readExact(512);
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

      const padLen = (512 - (size % 512)) % 512;

      if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
        if (size > MAX_TAR_METADATA_ENTRY_BYTES) {
          throw new Error(`tar_metadata_entry_too_large:${size}`);
        }
        const dataBuf = await cursor.readExact(size);
        if (padLen > 0) await cursor.skipExact(padLen);
        if (typeflag === 'x') {
          nextPax = { ...nextPax, ...parsePaxRecords(dataBuf) };
        } else if (typeflag === 'g') {
          globalPax = { ...globalPax, ...parsePaxRecords(dataBuf) };
        } else {
          nextGnuLongName = dataBuf.toString('utf8').replace(/\0.*$/, '');
        }
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
      const match = normalized ? opts.prefixRegex.exec(normalized) : null;

      if (match && match[2]) {
        const group = match[1];
        const relPath = match[2];
        if (capturedGroup === undefined) {
          capturedGroup = group;
        }
        if (group === capturedGroup) {
          const relValidated = validateTarEntryPath(relPath, typeflag);
          if (relValidated) {
            const segments = relValidated.split('/');
            const targetPath = pathMod.join(destRootDir, ...segments);
            if (typeflag === '5') {
              mkdirSync(targetPath, { recursive: true });
              const realDir = realpathSync(targetPath);
              if (!isWithinRealRoot(realDir, canonicalDestRoot, platform)) {
                throw new Error(`unsafe_target_escape:${relValidated}`);
              }
            } else {
              const parentDir = pathMod.dirname(targetPath);
              mkdirSync(parentDir, { recursive: true });
              const realParent = realpathSync(parentDir);
              if (!isWithinRealRoot(realParent, canonicalDestRoot, platform)) {
                throw new Error(`unsafe_target_escape:${relValidated}`);
              }
              const mode = readTarMode(header);
              activeOutStream = new ManagedWriteStream(targetPath, {
                flags: 'wx',
                ...(platform !== 'win32' ? { mode } : {}),
              });
              await cursor.streamExact(size, (chunk) => activeOutStream!.write(chunk));
              await activeOutStream.end();
              activeOutStream = null;
              if (platform !== 'win32') {
                chmodSync(targetPath, mode);
              }
              extractedFiles.push(relValidated);
              if (padLen > 0) await cursor.skipExact(padLen);
              continue;
            }
          }
        }
      }

      if (size + padLen > 0) {
        await cursor.skipExact(size + padLen);
      }
    }
  } catch (err) {
    if (activeOutStream) {
      activeOutStream.destroy();
    }
    if (err instanceof Error && (err.message.includes('tar') || err.message.includes('unsafe') || err.message.includes('invalid') || err.message.includes('truncated'))) {
      throw err;
    }
    throw new Error(`tarball_gunzip_failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    gzipRead.destroy();
    gunzip.destroy();
  }

  for (const reqRel of opts.requiredRelPaths ?? []) {
    const reqPath = pathMod.join(destRootDir, ...reqRel.split('/'));
    let ok = false;
    try {
      const st = lstatSync(reqPath);
      ok = st.isFile() && st.size > 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(`binary_not_found_in_tarball:${reqRel}`);
    }
  }

  return { extractedFiles, ...(capturedGroup ? { capturedGroup } : {}) };
}

export function clearMacosQuarantineBestEffort(filePath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' || process.platform !== 'darwin') return;
  try {
    execFileSync('xattr', ['-d', 'com.apple.quarantine', filePath], {
      stdio: 'ignore',
      timeout: 2_000,
    });
  } catch {
    // Ignore missing xattr tool or absent quarantine attribute
  }
}

export function defaultVerifyVersion(binPath: string, timeoutMs: number): string | undefined {
  const out = execFileSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstLine = String(out).split(/\r?\n/)[0]?.trim();
  return firstLine || undefined;
}

export function ensureExecutablePermission(filePath: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  try {
    accessSync(filePath, fsConstants.X_OK);
  } catch {
    chmodSync(filePath, 0o755);
  }
}

function assertLockFileSafeSync(lockPath: string): void {
  try {
    const st = lstatSync(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`unsafe_symlink_target:${path.basename(lockPath)}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw err;
  }
}

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return (code === 'ERR_SQLITE_ERROR' && /database is locked|SQLITE_BUSY/i.test(msg))
    || /database is locked|SQLITE_BUSY/i.test(msg);
}

/** Checks whether the built-in `node:sqlite` kernel lock backend can be loaded in this runtime. */
export async function isProcessExclusiveLockAvailable(): Promise<boolean> {
  try {
    suppressSqliteExperimentalWarning();
    const mod = await import('node:sqlite');
    return typeof mod?.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

/** Serializes critical sections across OS processes using a single unified SQLite transaction lock. */
export async function withProcessExclusiveLock<T>(
  lockDbPath: string,
  opts: { timeoutMs?: number; timeoutMessage?: string } = {},
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 10_000));
  const timeoutMessage = opts.timeoutMessage ?? 'codex_publish_lock_timeout';
  const deadline = Date.now() + timeoutMs;

  assertLockFileSafeSync(lockDbPath);
  assertLockFileSafeSync(`${lockDbPath}-wal`);
  assertLockFileSafeSync(`${lockDbPath}-shm`);
  assertLockFileSafeSync(`${lockDbPath}-journal`);

  let DatabaseSyncCtor: typeof import('node:sqlite')['DatabaseSync'];
  try {
    suppressSqliteExperimentalWarning();
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
    if (typeof DatabaseSyncCtor !== 'function') {
      throw new Error('codex_publish_lock_unavailable');
    }
  } catch {
    throw new Error('codex_publish_lock_unavailable');
  }

  const db = new DatabaseSyncCtor(lockDbPath);
  let inTx = false;
  try {
    db.exec('PRAGMA busy_timeout = 0;');
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(timeoutMessage);
      }
      try {
        db.exec('BEGIN IMMEDIATE;');
        inTx = true;
        break;
      } catch (err) {
        if (!isSqliteBusyError(err)) throw err;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(timeoutMessage);
        }
        const jitter = 5 + Math.floor(Math.random() * 11);
        await new Promise((resolve) => setTimeout(resolve, Math.min(jitter, remaining)));
      }
    }
    return await fn();
  } finally {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    }
    try { db.close(); } catch { /* ignore */ }
  }
}
