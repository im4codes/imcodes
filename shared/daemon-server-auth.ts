import { AUTHORIZATION_HEADER, SERVER_ID_HEADER } from './http-header-names.js';

/**
 * The credential a daemon presents to the server's REST API: `Authorization: Bearer <server token>` plus `X-Server-Id`.
 * The server checks the bearer against that server's stored token hash (revoked tokens and controlled nodes are refused),
 * so the pair is the only way for a daemon to be authenticated. One builder for every daemon -> server HTTP call: a call
 * that sends a serverId alone authenticates nothing.
 */
export function daemonServerAuthHeaders(credentials: { serverId: string; token: string }): Record<string, string> {
  return {
    [AUTHORIZATION_HEADER]: `Bearer ${credentials.token}`,
    [SERVER_ID_HEADER]: credentials.serverId,
  };
}
