export type GitRemoteUrlValidationCode = 'invalid_git_remote';

export const GIT_REMOTE_CLONE_CAPABILITY_V1 = 'git-remote-clone:v1' as const;

const URL_REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:']);

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function isScpStyleRemote(value: string): boolean {
  return /^[A-Za-z0-9._-]+@[^:\s]+:.+\/[^/\s]+(?:\.git)?$/.test(value);
}

export function isSupportedGitRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || hasWhitespace(trimmed)) return false;
  if (isScpStyleRemote(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return URL_REMOTE_SCHEMES.has(parsed.protocol)
      && !!parsed.hostname
      && parsed.pathname.replace(/^\/+|\/+$/g, '').length > 0;
  } catch {
    return false;
  }
}

export function normalizeOptionalGitRemoteUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function assertSupportedGitRemoteUrl(value: string): string {
  const trimmed = value.trim();
  if (!isSupportedGitRemoteUrl(trimmed)) {
    throw new Error('invalid_git_remote');
  }
  return trimmed;
}

export function redactGitRemoteUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username) parsed.username = 'redacted';
    if (parsed.password) parsed.password = 'redacted';
    return parsed.toString();
  } catch {
    return trimmed.replace(/^([^@\s]+)@/, 'redacted@');
  }
}
