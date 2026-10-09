import { NODE_ROLE, type NodeRole } from './remote-exec.js';
import { ALIAS_API_PATH } from './alias-types.js';
import { VERIFICATION_MACHINE_API_PATH } from './verification-machine.js';
import { MESSAGE_PINS_API_PATH } from './message-pins.js';
import { CAPABILITY_HTTP_PATH } from './capability-management.js';
import { WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT } from './worker-session-snapshot.js';
import { CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH } from './controlled-node-artifacts.js';
import { USAGE_INGEST_ROUTE_SUFFIX } from './usage-analytics.js';

export const DAEMON_TOKEN_ROUTE_NOT_ALLOWED = 'daemon_token_route_not_allowed';
export type DaemonHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface DaemonTokenRoute {
  method: DaemonHttpMethod;
  path: string;
  roles: readonly NodeRole[];
}

const full = (method: DaemonHttpMethod, path: string): DaemonTokenRoute => ({ method, path, roles: [NODE_ROLE.FULL] });
const server = '/api/server/:serverId';

/**
 * Daemon credentials are NOT account credentials. This is the complete REST
 * admission surface, not a prefix grant. Adding a route here does not bypass
 * its ownership, scope, revocation or controlled-node checks.
 *
 * Sources: daemon/context/capability HTTP clients and released daemon history.
 * Binding uses an account API key; enrollment bootstrap/download uses a ticket;
 * WS authenticates its own handshake. None of those is a REST account grant.
 */
export const DAEMON_TOKEN_ROUTES: readonly DaemonTokenRoute[] = [
  full('GET', VERIFICATION_MACHINE_API_PATH),
  full('PUT', VERIFICATION_MACHINE_API_PATH),
  full('DELETE', `${VERIFICATION_MACHINE_API_PATH}/:id`),
  full('POST', `${VERIFICATION_MACHINE_API_PATH}/:id/verification`),
  full('GET', ALIAS_API_PATH),
  full('POST', ALIAS_API_PATH),
  full('DELETE', `${ALIAS_API_PATH}/:name`),
  full('GET', MESSAGE_PINS_API_PATH),
  full('GET', `${MESSAGE_PINS_API_PATH}/:id`),
  full('POST', MESSAGE_PINS_API_PATH),
  full('DELETE', `${MESSAGE_PINS_API_PATH}/:id`),
  full('GET', CAPABILITY_HTTP_PATH.LIST),
  full('POST', CAPABILITY_HTTP_PATH.INSTALL),
  full('GET', `${CAPABILITY_HTTP_PATH.MANAGE_PREFIX}/:capabilityId`),
  full('GET', `${CAPABILITY_HTTP_PATH.OPERATION_PREFIX}/:operationId`),
  full('POST', `${CAPABILITY_HTTP_PATH.OPERATION_PREFIX}/:operationId/cancel`),
  full('POST', `${CAPABILITY_HTTP_PATH.MANAGE_PREFIX}/:capabilityId/manage`),
  full('PUT', `${CAPABILITY_HTTP_PATH.BLOB_PREFIX}/:versionId`),
  full('GET', `${CAPABILITY_HTTP_PATH.BLOB_PREFIX}/:versionId`),
  full('POST', `${CAPABILITY_HTTP_PATH.BLOB_PREFIX}/:versionId/access`),
  full('GET', '/api/memory/projection-owner'),
  full('GET', '/api/memory/sources'),
  full('POST', '/api/shared-context/memory/search'),
  full('POST', '/api/shared-context/:serverId/shared-context/memory/recall'),
  full('GET', '/api/shared-context/personal-memory'),
  full('POST', '/api/embedding'),
  full('GET', '/api/machines'),
  full('GET', CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH),
  full('POST', '/api/machine/exec'),
  full('POST', '/api/machine/computer-use'),
  full('POST', `${server}/machine-direct-upload`),
  full('POST', `${server}/machine-direct-fetch`),
  full('POST', `${server}/machine-file-handle`),
  full('POST', `${server}/upload`),
  full('GET', `${server}/uploads/:attachmentId/download`),
  full('GET', `${server}/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`),
  full('GET', `${server}/sessions`),
  full('GET', `${server}/sub-sessions`),
  full('PUT', `${server}/sessions/:name`),
  full('DELETE', `${server}/sessions/:name`),
  full('DELETE', `${server}/sub-sessions/:subId`),
  full('POST', `${server}/bindings`),
  full('DELETE', `${server}/bindings`),
  full('GET', `${server}/shared-context/runtime-config/daemon`),
  full('POST', `${server}/shared-context/processed`),
  full('POST', `${server}/shared-context/authored-bindings`),
  full('POST', `${server}/shared-context/resolve-namespace`),
  full('GET', `${server}/supervision/user-defaults/daemon`),
  full('PUT', `${server}/supervision/user-defaults/daemon`),
  full('POST', `${server}/${USAGE_INGEST_ROUTE_SUFFIX}`),
  full('POST', '/api/outbound'),
  // Current and released clients use the serverId mount for pod affinity.
  ...[`${server}/cron`].flatMap((cron) => [
    full('GET', cron), full('POST', cron),
    full('PUT', `${cron}/:id`), full('DELETE', `${cron}/:id`),
  ]),
];

const compiled = DAEMON_TOKEN_ROUTES.map((route) => ({
  route,
  segments: route.path.split('/'),
}));

/** Match the raw URL path, as Hono does: encoded identifiers stay one segment. */
export function matchDaemonTokenRoute(method: string, path: string, role: NodeRole): DaemonTokenRoute | undefined {
  const segments = path.split('?')[0]!.split('/');
  return compiled.find(({ route, segments: pattern }) => route.method === method
    && route.roles.includes(role)
    && pattern.length === segments.length
    && pattern.every((segment, i) => segment.startsWith(':') ? Boolean(segments[i]) : segment === segments[i]))?.route;
}

/** Shared client-side admission check. Preserve the path AND pod-sticky query. */
export function daemonApiUrl(base: string, method: DaemonHttpMethod, path: string): string {
  if (!matchDaemonTokenRoute(method, path, NODE_ROLE.FULL)) throw new Error(DAEMON_TOKEN_ROUTE_NOT_ALLOWED);
  return `${base.replace(/\/+$/, '')}${path}`;
}
