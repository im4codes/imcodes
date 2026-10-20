/** The filename budget is a filesystem component budget, not a JS string budget. */
export const UPLOAD_FILENAME_MAX_BYTES = 255;
export const UPLOAD_FILENAME_FALLBACK = 'file';

// Union of the characters rejected by Windows, macOS and POSIX shells/filesystems.
const INVALID_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\ufeff]/g;
const RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)(?:\..*)?$/i;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function basename(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function extension(value: string): string {
  const index = value.lastIndexOf('.');
  return index > 0 ? value.slice(index) : '';
}

function trimToUtf8Bytes(value: string, maxBytes: number): string {
  let result = value;
  while (utf8ByteLength(result) > maxBytes) {
    const chars = Array.from(result);
    chars.pop();
    result = chars.join('');
    if (!result) break;
  }
  return result;
}

/**
 * Produce one safe basename accepted by Linux, macOS and Windows.
 * The extension is retained whenever it fits the 255-byte component limit.
 */
export function sanitizeUploadFilename(input: string | undefined | null): string {
  const normalized = String(input ?? '').normalize('NFC');
  const base = basename(normalized.replace(/\\/g, '/'));
  let cleaned = base
    .replace(INVALID_CHARS, '_')
    .replace(/_+/gu, '_')
    .replace(/\s+/gu, (match) => match.includes('\n') ? ' ' : match)
    .replace(/^[.-]+/u, '_')
    .replace(/[. ]+$/u, '')
    .trim();
  if (!cleaned || /^[_.-]+$/u.test(cleaned) || cleaned === '.' || cleaned === '..' || RESERVED_BASENAME.test(cleaned)) {
    cleaned = UPLOAD_FILENAME_FALLBACK;
  }

  const ext = extension(cleaned);
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const safeExt = ext && !RESERVED_BASENAME.test(stem + ext)
    ? trimToUtf8Bytes(ext, UPLOAD_FILENAME_MAX_BYTES - 1)
    : '';
  const maxStemBytes = Math.max(1, UPLOAD_FILENAME_MAX_BYTES - utf8ByteLength(safeExt));
  let result = `${trimToUtf8Bytes(stem, maxStemBytes)}${safeExt}`;
  result = result.replace(/[. ]+$/u, '');
  if (!result || RESERVED_BASENAME.test(result)) result = UPLOAD_FILENAME_FALLBACK;
  return result;
}

export function uploadFilenameIsSafe(input: string): boolean {
  return sanitizeUploadFilename(input) === input
    && input.length > 0
    && utf8ByteLength(input) <= UPLOAD_FILENAME_MAX_BYTES;
}
