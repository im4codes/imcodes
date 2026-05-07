import { realpath as fsRealpath } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

export const FILE_PREVIEW_DENIED_HOME_DIRS = ['.ssh', '.gnupg', '.pki'] as const;

export type FilePreviewDeniedHomeDir = (typeof FILE_PREVIEW_DENIED_HOME_DIRS)[number];
export type CanonicalMode = 'strict' | 'lenient';

declare const validatedRealPathBrand: unique symbol;
export type ValidatedRealPath = string & { readonly [validatedRealPathBrand]: true };

type PlatformPath = typeof path.posix;

export interface FilePreviewPathPolicyOptions {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  cwd?: string;
  realpath?: (targetPath: string) => Promise<string>;
}

export interface CanonicalPathResult {
  rawPath: string;
  expandedPath: string;
  resolvedPath: string;
  realPath: string;
  usedFallback: boolean;
  validatedRealPath: ValidatedRealPath | null;
}

const WINDOWS_REALPATH_FALLBACK_ERROR_CODES = new Set(['EINVAL', 'ELOOP']);
const WINDOWS_REALPATH_FALLBACK_MESSAGE_PATTERNS = [
  'reparse',
  'junction',
  'symlink',
  'symbolic link',
  'too many levels',
] as const;

function getPlatform(options: FilePreviewPathPolicyOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function getHomeDir(options: FilePreviewPathPolicyOptions): string {
  return options.homedir?.() ?? osHomedir();
}

function getPlatformPath(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function isCaseInsensitiveFilePreviewPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function expandFilePreviewPath(rawPath: string, homeDir = osHomedir(), platform: NodeJS.Platform = process.platform): string {
  const platformPath = getPlatformPath(platform);
  if (rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return platformPath.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function resolvePlatformPath(targetPath: string, platformPath: PlatformPath, cwd?: string): string {
  if (platformPath.isAbsolute(targetPath)) {
    return platformPath.normalize(targetPath);
  }
  return platformPath.resolve(cwd ?? process.cwd(), targetPath);
}

function stripTrailingSeparators(value: string, platformPath: PlatformPath): string {
  const root = platformPath.parse(value).root;
  let current = value;
  while (current.length > root.length && (current.endsWith('/') || current.endsWith('\\'))) {
    current = current.slice(0, -1);
  }
  return current;
}

function normalizeForPolicy(value: string, platform: NodeJS.Platform): string {
  const platformPath = getPlatformPath(platform);
  const normalized = stripTrailingSeparators(platformPath.normalize(value), platformPath);
  return isCaseInsensitiveFilePreviewPlatform(platform) ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalizedRoot = normalizeForPolicy(root, platform);
  const normalizedCandidate = normalizeForPolicy(candidate, platform);
  const separator = platform === 'win32' ? '\\' : '/';
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${separator}`);
}

function isPathAllowedForHome(realPath: string, homeDir: string, platform: NodeJS.Platform): boolean {
  const platformPath = getPlatformPath(platform);
  for (const deniedDir of FILE_PREVIEW_DENIED_HOME_DIRS) {
    const deniedPath = platformPath.join(homeDir, deniedDir);
    if (isSameOrInside(deniedPath, realPath, platform)) return false;
  }
  return true;
}

export function getDeniedSensitivePathPrefixes(options: FilePreviewPathPolicyOptions = {}): readonly string[] {
  const platform = getPlatform(options);
  const platformPath = getPlatformPath(platform);
  const homeDir = getHomeDir(options);
  return FILE_PREVIEW_DENIED_HOME_DIRS.map((deniedDir) => platformPath.join(homeDir, deniedDir));
}

export function isFilePreviewPathAllowed(realPath: string, options: FilePreviewPathPolicyOptions = {}): boolean {
  return isPathAllowedForHome(realPath, getHomeDir(options), getPlatform(options));
}

export function validateCanonicalRealPath(realPath: string, options: FilePreviewPathPolicyOptions = {}): ValidatedRealPath | null {
  return isFilePreviewPathAllowed(realPath, options) ? realPath as ValidatedRealPath : null;
}

export function asValidatedRealPath(realPath: string, options: FilePreviewPathPolicyOptions = {}): ValidatedRealPath | null {
  return validateCanonicalRealPath(realPath, options);
}

export function getValidatedRealPath(result: CanonicalPathResult | null): ValidatedRealPath | null {
  if (!result || result.usedFallback) return null;
  return result.validatedRealPath;
}

export function isWindowsLenientRealpathFallbackError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const hasFallbackMessage = WINDOWS_REALPATH_FALLBACK_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
  if (!hasFallbackMessage) return false;
  return !code || WINDOWS_REALPATH_FALLBACK_ERROR_CODES.has(code) || code === 'UNKNOWN';
}

export async function resolveCanonical(
  rawPath: string,
  mode: CanonicalMode,
  options: FilePreviewPathPolicyOptions = {},
): Promise<CanonicalPathResult | null> {
  if (rawPath.length === 0) return null;

  const platform = getPlatform(options);
  const platformPath = getPlatformPath(platform);
  const homeDir = getHomeDir(options);
  const expandedPath = expandFilePreviewPath(rawPath, homeDir, platform);
  const resolvedPath = resolvePlatformPath(expandedPath, platformPath, options.cwd);
  const realpath = options.realpath ?? fsRealpath;

  try {
    const realPath = await realpath(resolvedPath);
    if (!isPathAllowedForHome(realPath, homeDir, platform)) return null;
    const validatedRealPath = realPath as ValidatedRealPath;
    return {
      rawPath,
      expandedPath,
      resolvedPath,
      realPath,
      usedFallback: false,
      validatedRealPath,
    };
  } catch (error) {
    if (mode !== 'lenient' || platform !== 'win32' || !isWindowsLenientRealpathFallbackError(error)) {
      return null;
    }

    if (!isPathAllowedForHome(resolvedPath, homeDir, platform)) return null;
    return {
      rawPath,
      expandedPath,
      resolvedPath,
      realPath: resolvedPath,
      usedFallback: true,
      validatedRealPath: null,
    };
  }
}

export const isPathAllowed = isFilePreviewPathAllowed;
export const isPreviewPathAllowed = isFilePreviewPathAllowed;
export const resolvePreviewCanonicalPath = resolveCanonical;
