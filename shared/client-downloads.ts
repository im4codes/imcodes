/**
 * Shared protocol constants and response contract for resolving
 * `/api/downloads/latest/:target` metadata across server and web.
 */

export const CLIENT_DOWNLOAD_API_PREFIX = '/api/downloads/' as const;

export const CLIENT_DOWNLOAD_RESOLVE_QUERY_PARAM = 'resolve' as const;
export const CLIENT_DOWNLOAD_RESOLVE_QUERY_VALUE = 'json' as const;

export const CLIENT_DOWNLOAD_RESOLVE_MODES = {
  REDIRECT: 'redirect',
  STREAM: 'stream',
} as const;

export type ClientDownloadResolveMode =
  (typeof CLIENT_DOWNLOAD_RESOLVE_MODES)[keyof typeof CLIENT_DOWNLOAD_RESOLVE_MODES];

export type ClientDownloadResolveResponse =
  | {
      ok: true;
      mode: typeof CLIENT_DOWNLOAD_RESOLVE_MODES.REDIRECT;
      url: string;
    }
  | {
      ok: true;
      mode: typeof CLIENT_DOWNLOAD_RESOLVE_MODES.STREAM;
      url: null;
    };
