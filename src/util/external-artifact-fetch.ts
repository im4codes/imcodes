import {
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_EXTERNAL_MAX_REDIRECTS,
  CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
} from '../../shared/controlled-node-artifacts.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
}): Promise<{ response: Response; metadataHeaders: Headers }> {
  const initialHeaders: Record<string, string> = {
    ...input.headers,
    [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
  };
  let currentUrl = input.url;
  let response = await input.fetchImpl(currentUrl, {
    headers: initialHeaders,
    redirect: 'manual',
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const metadataHeaders = response.headers;
  if (!REDIRECT_STATUSES.has(response.status)) {
    return { response, metadataHeaders };
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
    response = await input.fetchImpl(currentUrl, {
      redirect: 'manual',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, metadataHeaders };
    }
  }
}
