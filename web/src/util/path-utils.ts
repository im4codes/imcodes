import { FS_SESSION_ROOT_PATH } from '../../../src/shared/transport/fs.js';

/**
 * Cross-platform path utilities for display paths.
 * Handles both Unix (/) and Windows (\) separators.
 *
 * NOTE: These are for DISPLAY paths received from the daemon as strings.
 * The daemon should use Node's `path` module (OS-aware). The web UI
 * doesn't have access to Node's `path`, so it needs its own helpers.
 */

/** Extract filename from a path (handles both / and \ separators). */
export function pathBasename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/** Check if a path is absolute (Unix /, Windows C:\, UNC \\, or tilde ~). */
export function isAbsolutePath(p: string): boolean {
  return /^[/\\]/.test(p) || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('~');
}

/** Detect the path separator used in a path string. */
export function detectSeparator(p: string): '/' | '\\' {
  return p.includes('\\') ? '\\' : '/';
}

/** Get parent directory (handles both separators). */
export function pathDirname(p: string): string {
  const stripped = p.replace(/[/\\]+$/, '');
  // Windows drive root (C: after stripping \) → return C:\
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + '\\';
  const segs = stripped.split(/[/\\]/);
  segs.pop();
  let result = segs.join('/') || '/';
  // Parent is a drive root: C: → C:\
  if (/^[A-Za-z]:$/.test(result)) result += '\\';
  return result;
}

interface NormalizedDisplayPath {
  root: string;
  segments: string[];
  escapedRoot: boolean;
  separator: '/' | '\\';
  render(): string;
}

function normalizeDisplayPath(input: string, separator: '/' | '\\'): NormalizedDisplayPath | null {
  const slashPath = input.replace(/\\/g, '/');
  const unc = slashPath.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  const drive = slashPath.match(/^([A-Za-z]:)(?:\/(.*))?$/);
  const tilde = slashPath.match(/^~(?:\/(.*))?$/);
  const unixAbsolute = slashPath.startsWith('/') && !slashPath.startsWith('//');
  if (slashPath.startsWith('//') && !unc) return null;

  const root = unc
    ? `unc:${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`
    : drive
      ? `drive:${drive[1].toLowerCase()}`
      : tilde
        ? 'tilde'
        : unixAbsolute
          ? 'unix'
          : 'relative';
  const remainder = unc?.[3]
    ?? drive?.[2]
    ?? tilde?.[1]
    ?? (unixAbsolute ? slashPath.slice(1) : slashPath);
  const segments: string[] = [];
  let escapedRoot = false;

  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else escapedRoot = true;
      continue;
    }
    segments.push(segment);
  }

  return {
    root,
    segments,
    escapedRoot,
    separator,
    render() {
      if (unc) {
        const prefix = `${separator}${separator}${unc[1]}${separator}${unc[2]}`;
        return segments.length ? `${prefix}${separator}${segments.join(separator)}` : prefix;
      }
      if (drive) {
        const prefix = `${drive[1]}${separator}`;
        return segments.length ? `${prefix}${segments.join(separator)}` : prefix;
      }
      if (tilde) return segments.length ? `~${separator}${segments.join(separator)}` : '~';
      if (unixAbsolute) return `/${segments.join('/')}`;
      return segments.join(separator);
    },
  };
}

/**
 * Resolve a local Markdown link relative to the Markdown file that contains it.
 *
 * Markdown hrefs use URL-style escaping even when they ultimately name a file,
 * while daemon paths may use either Unix or Windows separators. This helper
 * deliberately returns a display/daemon path rather than a browser URL: callers
 * must still read it through the existing scoped fs.read channel.
 */
export function resolveMarkdownLocalPath(
  markdownPath: string,
  href: string,
  allowedRootPath?: string,
): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('?')) return null;

  const suffixIndex = [trimmed.indexOf('?'), trimmed.indexOf('#')]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), trimmed.length);
  const encodedPath = trimmed.slice(0, suffixIndex);
  if (!encodedPath) return null;

  let referencePath: string;
  try {
    referencePath = decodeURIComponent(encodedPath);
  } catch {
    referencePath = encodedPath;
  }
  if (!referencePath || /[\u0000-\u001f\u007f-\u009f]/u.test(referencePath)) return null;
  if (/^(?:\/\/|\\\\|~(?:[/\\]|$))/u.test(referencePath)) return null;
  if (referencePath.split(/[/\\]/).some((segment) => segment === FS_SESSION_ROOT_PATH)) return null;

  const separator = detectSeparator(markdownPath);
  const parent = /[/\\]/.test(markdownPath) ? pathDirname(markdownPath) : '.';
  const normalizedParent = normalizeDisplayPath(parent, separator);
  if (!normalizedParent || normalizedParent.escapedRoot) return null;
  // Never auto-read from a UNC or home-expansion root. An explicitly opened
  // document on either root remains renderable, but its content cannot trigger
  // further filesystem/network reads.
  if (normalizedParent.root.startsWith('unc:') || normalizedParent.root === 'tilde') return null;
  if (normalizedParent.segments.some((segment) => segment === FS_SESSION_ROOT_PATH)) return null;

  const normalizedRoot = allowedRootPath
    ? normalizeDisplayPath(allowedRootPath, separator)
    : normalizedParent;
  if (!normalizedRoot || normalizedRoot.escapedRoot) return null;
  if (normalizedRoot.root.startsWith('unc:') || normalizedRoot.root === 'tilde') return null;
  if (normalizedRoot.segments.some((segment) => segment === FS_SESSION_ROOT_PATH)) return null;

  const sourceDrive = /^([A-Za-z]:)[/\\]/.exec(markdownPath)?.[1];
  let candidate: string;
  if (isAbsolutePath(referencePath)) {
    // On Windows, Markdown commonly uses `/assets/image.png` for a path rooted
    // on the current drive. Preserve that drive instead of turning it into a
    // Unix-looking path that the controlled node cannot open.
    candidate = sourceDrive && /^[/\\](?![/\\])/.test(referencePath)
      ? `${sourceDrive}${referencePath}`
      : referencePath;
  } else {
    candidate = `${parent}${parent.endsWith('/') || parent.endsWith('\\') ? '' : separator}${referencePath}`;
  }

  const resolved = normalizeDisplayPath(candidate, separator);
  if (
    !resolved
    || resolved.escapedRoot
    || resolved.root !== normalizedParent.root
    || resolved.root !== normalizedRoot.root
  ) return null;
  const windowsPath = resolved.root.startsWith('drive:');
  const sameSegment = (left: string, right: string) => (
    windowsPath ? left.toLowerCase() === right.toLowerCase() : left === right
  );
  if (
    normalizedParent.segments.length < normalizedRoot.segments.length
    || normalizedRoot.segments.some((segment, index) => !sameSegment(segment, normalizedParent.segments[index]))
    || resolved.segments.length < normalizedRoot.segments.length
    || normalizedRoot.segments.some((segment, index) => !sameSegment(segment, resolved.segments[index]))
  ) return null;

  return resolved.render();
}
