import {
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_EXTERNAL_MAX_REDIRECTS,
  CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
} from '../../shared/controlled-node-artifacts.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NON_FALLBACK_REDIRECT_ERRORS = new Set([
  'artifact_redirect_non_https',
  'artifact_redirect_credentials_forbidden',
  'artifact_redirect_limit_exceeded',
  'artifact_redirect_missing_location',
  'artifact_redirect_invalid_location',
  'unexpected_redirect_when_disabled',
]);

const EXTERNAL_FALLBACK_RETRYABLE_CODES = new Set([
  'download_timeout',
  'artifact_size_mismatch',
  'artifact_sha256_mismatch',
  'artifact_version_mismatch',
  'artifact_filename_mismatch',
  'release_manifest_size_mismatch',
  'release_manifest_sha256_mismatch',
  'release_manifest_pinned_sha256_mismatch',
  'release_manifest_unexpected_filename',
  'daemon_runtime_manifest_header_sha256_mismatch',
  'daemon_runtime_archive_header_sha256_mismatch',
  'daemon_runtime_header_version_mismatch',
  'daemon_runtime_archive_digest_mismatch',
  'desktop_release_manifest_header_sha256_mismatch',
]);

export class ExternalArtifactRedirectHopError extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = 'ExternalArtifactRedirectHopError';
  }
}

export function isRetryableExternalArtifactFailure(error: unknown): boolean {
  if (error instanceof ExternalArtifactRedirectHopError) {
    return !NON_FALLBACK_REDIRECT_ERRORS.has(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NON_FALLBACK_REDIRECT_ERRORS.has(message)) return false;
  if (EXTERNAL_FALLBACK_RETRYABLE_CODES.has(message)) return true;
  if (/^(?:download_failed_\d+|release_manifest_unavailable_\d+|daemon_runtime_(?:manifest|archive)_http_error:\d+|desktop_release_manifest_http_error:\d+|release_manifest_version_mismatch)/.test(message)) {
    return true;
  }
  return error instanceof TypeError;
}

export function readArtifactHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
}

/**
 * Fetch a controlled-node artifact from origin with opt-in external redirect support.
 *
 * When origin responds with a 3xx redirect to an external CDN/GitHub URL:
 * - Captures authoritative `x-imcodes-node-artifact-*` metadata headers from the initial origin response
 * - Strips origin auth headers (`Authorization`, `X-Server-Id`, etc.) on every external redirect hop
 * - Enforces HTTPS-only redirect targets without embedded credentials
 * - Caps redirects at `CONTROLLED_NODE_EXTERNAL_MAX_REDIRECTS` (5)
 */
export async function fetchControlledNodeArtifactWithRedirect(input: {
  fetchImpl: typeof fetch;
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  allowExternalRedirect?: boolean;
}): Promise<{ response: Response; metadataHeaders: Headers; redirectedExternal: boolean }> {
  const allowRedirect = input.allowExternalRedirect !== false;
  const initialHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    if (!allowRedirect && k.toLowerCase() === CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT) {
      continue;
    }
    initialHeaders[k] = v;
  }
  if (allowRedirect) {
    initialHeaders[CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT] = CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN;
  }
  let currentUrl = input.url;
  let response = await input.fetchImpl(currentUrl, {
    headers: initialHeaders,
    redirect: 'manual',
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const metadataHeaders = response.headers;
  if (!REDIRECT_STATUSES.has(response.status)) {
    return { response, metadataHeaders, redirectedExternal: false };
  }
  if (!allowRedirect) {
    await response.body?.cancel().catch(() => {});
    throw new Error('unexpected_redirect_when_disabled');
  }

  for (let hop = 1; ; hop++) {
    const location = readArtifactHeader(response.headers, 'location');
    await response.body?.cancel().catch(() => {});
    if (hop > CONTROLLED_NODE_EXTERNAL_MAX_REDIRECTS) {
      throw new Error('artifact_redirect_limit_exceeded');
    }
    if (!location) {
      throw new Error('artifact_redirect_missing_location');
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error('artifact_redirect_invalid_location');
    }
    if (nextUrl.protocol !== 'https:') {
      throw new Error('artifact_redirect_non_https');
    }
    if (nextUrl.username || nextUrl.password) {
      throw new Error('artifact_redirect_credentials_forbidden');
    }
    currentUrl = nextUrl.toString();
    try {
      response = await input.fetchImpl(currentUrl, {
        redirect: 'manual',
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      throw new ExternalArtifactRedirectHopError(error);
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, metadataHeaders, redirectedExternal: true };
    }
  }
}

/**
 * Try downloading & verifying with external redirect enabled; if the external
 * redirect failed (network error, non-2xx HTTP status, or integrity/version
 * mismatch due to R2 drift), fall back ONCE to direct origin streaming without
 * `x-imcodes-external-artifact-redirect: 1`. Security rejections on redirect
 * headers still fail closed immediately, and all integrity checks remain enforced
 * on the origin fallback response.
 */
export async function fetchAndVerifyControlledNodeArtifactWithOriginFallback<T>(input: {
  fetchImpl: typeof fetch;
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  onExternalFallback?: (reason: unknown) => void;
  consumeResponse: (result: {
    response: Response;
    metadataHeaders: Headers;
    redirectedExternal: boolean;
  }) => Promise<T>;
}): Promise<T> {
  let redirectedExternal = false;
  try {
    const fetched = await fetchControlledNodeArtifactWithRedirect({
      fetchImpl: input.fetchImpl,
      url: input.url,
      headers: input.headers,
      ...(input.signal ? { signal: input.signal } : {}),
      allowExternalRedirect: true,
    });
    redirectedExternal = fetched.redirectedExternal;
    return await input.consumeResponse(fetched);
  } catch (firstError) {
    const canFallback =
      (redirectedExternal || firstError instanceof ExternalArtifactRedirectHopError)
      && isRetryableExternalArtifactFailure(firstError);
    if (!canFallback) {
      throw firstError instanceof ExternalArtifactRedirectHopError && firstError.cause instanceof Error
        ? firstError.cause
        : firstError;
    }
    input.onExternalFallback?.(
      firstError instanceof ExternalArtifactRedirectHopError && firstError.cause instanceof Error
        ? firstError.cause
        : firstError,
    );
    try {
      const originFetched = await fetchControlledNodeArtifactWithRedirect({
        fetchImpl: input.fetchImpl,
        url: input.url,
        headers: input.headers,
        ...(input.signal ? { signal: input.signal } : {}),
        allowExternalRedirect: false,
      });
      return await input.consumeResponse(originFetched);
    } catch (fallbackError) {
      if (fallbackError instanceof Error && fallbackError.message === 'unexpected_redirect_when_disabled') {
        throw firstError instanceof ExternalArtifactRedirectHopError && firstError.cause instanceof Error
          ? firstError.cause
          : firstError;
      }
      throw fallbackError;
    }
  }
}
