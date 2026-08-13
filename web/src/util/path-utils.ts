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

/**
 * Resolve a local Markdown link relative to the Markdown file that contains it.
 *
 * Markdown hrefs use URL-style escaping even when they ultimately name a file,
 * while daemon paths may use either Unix or Windows separators. This helper
 * deliberately returns a display/daemon path rather than a browser URL: callers
 * must still read it through the existing scoped fs.read channel.
 */
export function resolveMarkdownLocalPath(markdownPath: string, href: string): string | null {
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
  if (!referencePath || /[\0\r\n]/.test(referencePath)) return null;

  const separator = detectSeparator(markdownPath);
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
    const parent = /[/\\]/.test(markdownPath) ? pathDirname(markdownPath) : '.';
    candidate = `${parent}${parent.endsWith('/') || parent.endsWith('\\') ? '' : separator}${referencePath}`;
  }

  const slashPath = candidate.replace(/\\/g, '/');
  const unc = slashPath.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  const drive = slashPath.match(/^([A-Za-z]:)(?:\/(.*))?$/);
  const tilde = slashPath.match(/^~(?:\/(.*))?$/);
  const unixAbsolute = slashPath.startsWith('/') && !slashPath.startsWith('//');
  const remainder = unc?.[3]
    ?? drive?.[2]
    ?? tilde?.[1]
    ?? (unixAbsolute ? slashPath.slice(1) : slashPath);
  const segments = unc ? [unc[1], unc[2]] : [];
  const protectedSegments = segments.length;
  const rooted = !!unc || !!drive || !!tilde || unixAbsolute;

  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > protectedSegments) segments.pop();
      else if (!rooted) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  if (unc) return `${separator}${separator}${segments.join(separator)}`;
  if (drive) return `${drive[1]}${separator}${segments.join(separator)}`;
  if (tilde) return `~${segments.length ? separator : ''}${segments.join(separator)}`;
  if (unixAbsolute) return `/${segments.join('/')}`;
  return segments.join(separator);
}
