/**
 * PROJECT/SESSION-scope identity content lives on the owning daemon's local
 * disk, never on the server (owner rule, tsk_cd_identity_daemon_storage: the
 * server keeps only {scope, scopeKey, sha256, revision, updatedAt,
 * sourceDaemonServerId}). This protocol is how the server reaches that
 * content over the daemon's existing WebSocket connection -- no HTTP in
 * either direction, so a flaky daemon<->server HTTP link (502s through a
 * proxy) can never make a save or apply time out.
 *
 * - LOCAL_REQUEST / LOCAL_RESPONSE: server -> daemon RPC (get/set/delete a
 *   PROJECT/SESSION profile on disk), correlated by requestId via
 *   DaemonRequestTracker, mirroring the memory.get_sources_request pattern.
 * - PUSH: server -> daemon, fire-and-forget delivery of USER-scope content
 *   (which still lives on the server) whenever it changes or a daemon
 *   (re)connects with a stale hash -- replaces the daemon's old 60s HTTP
 *   poll entirely.
 * - MIGRATE_REQUEST / MIGRATE_RESPONSE / MIGRATE_CONFIRM: one-time,
 *   daemon-initiated pull of a daemon's own PROJECT/SESSION rows that still
 *   have content sitting on the server from before this change shipped.
 *   Daemon-initiated (not server-initiated) because only the daemon knows
 *   which scope keys are actually its own; the server cannot infer that from
 *   a bare project id/name. Zero data loss: the server clears a row's
 *   content only after the daemon confirms it persisted and hash-verified it.
 */

export const SESSION_IDENTITY_WS = {
  LOCAL_REQUEST: 'session_identity.local_request',
  LOCAL_RESPONSE: 'session_identity.local_response',
  PUSH: 'session_identity.push',
  MIGRATE_REQUEST: 'session_identity.migrate_request',
  MIGRATE_RESPONSE: 'session_identity.migrate_response',
  MIGRATE_CONFIRM: 'session_identity.migrate_confirm',
  /**
   * Daemon -> server, fire-and-forget: an MCP tool (an agent running on the
   * daemon) wrote/cleared a PROJECT/SESSION profile straight to local disk
   * (the daemon is the source of truth, no round trip needed to complete the
   * write); this just keeps the server's metadata row and any browser
   * watching the scope in sync.
   */
  LOCAL_REPORT: 'session_identity.local_report',
  /**
   * Daemon -> server, fire-and-forget: an MCP tool wrote/cleared the
   * USER-scope profile. Content still lives on the server for this scope, so
   * this carries the full content (capped at 100k chars); the server
   * persists it and re-pushes to the user's other online daemons.
   */
  USER_REPORT: 'session_identity.user_report',
  /**
   * Browser -> server -> browser, phase 2 (identity-over-lease): a tiny,
   * server-only control call, never touching the daemon. Resolves the
   * canonical PROJECT/SESSION scope key (server-side
   * resolveSessionIdentityProjectKey, mirroring the HTTP route's
   * canonicalScopeKey callback) and the CURRENT hash/revision from the
   * server's own session_identity_metadata row -- kept in sync on every
   * SET regardless of source (web or MCP), so this needs no daemon round
   * trip. The browser skips a content fetch entirely when its cache
   * already has this hash (owner rule: "server 的 hash 与缓存一致时不传输").
   *
   * Owner-only: the identity-over-lease P2P path is not attempted by a
   * share participant. `ok: false` (not the daemon owner, or nothing
   * resolved) tells the caller to fall back to the existing HTTP relay
   * path, which already has full share-coverage access control.
   */
  RESOLVE_QUERY: 'session_identity.resolve_query',
  RESOLVE_RESPONSE: 'session_identity.resolve_response',
} as const;

export type SessionIdentityWsType = typeof SESSION_IDENTITY_WS[keyof typeof SESSION_IDENTITY_WS];

/** Each attempt must settle well inside the browser's HTTP request lifetime. */
export const SESSION_IDENTITY_LOCAL_RPC_TIMEOUT_MS = 8_000;

export const SESSION_IDENTITY_LOCAL_OPS = {
  GET: 'get',
  SET: 'set',
  DELETE: 'delete',
} as const;

export type SessionIdentityLocalOp = typeof SESSION_IDENTITY_LOCAL_OPS[keyof typeof SESSION_IDENTITY_LOCAL_OPS];

export interface SessionIdentityLocalRequest {
  type: typeof SESSION_IDENTITY_WS.LOCAL_REQUEST;
  requestId: string;
  op: SessionIdentityLocalOp;
  scope: 'project' | 'session';
  scopeKey: string;
  /** SET only. */
  content?: string;
  source?: 'web' | 'mcp';
  sourceFile?: string;
}

export interface SessionIdentityLocalResponse {
  type: typeof SESSION_IDENTITY_WS.LOCAL_RESPONSE;
  requestId: string;
  status: 'ok' | 'error';
  op: SessionIdentityLocalOp;
  scope: 'project' | 'session';
  scopeKey: string;
  /** GET only, when found. */
  content?: string;
  /** GET (found)/SET: absent means "no profile" (GET miss, or DELETE result). */
  contentHash?: string;
  revision?: number;
  updatedAt?: number;
  error?: string;
}

export interface SessionIdentityPushMessage {
  type: typeof SESSION_IDENTITY_WS.PUSH;
  scope: 'user';
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
}

/** Daemon -> server: "here are the scope keys I might own; send me any content you still have for them." */
export interface SessionIdentityMigrateRequest {
  type: typeof SESSION_IDENTITY_WS.MIGRATE_REQUEST;
  requestId: string;
  candidates: Array<{ scope: 'project' | 'session'; scopeKey: string }>;
}

export interface SessionIdentityMigrateRow {
  scope: 'project' | 'session';
  scopeKey: string;
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
}

export interface SessionIdentityMigrateResponse {
  type: typeof SESSION_IDENTITY_WS.MIGRATE_RESPONSE;
  requestId: string;
  rows: SessionIdentityMigrateRow[];
}

/** Daemon -> server, fire-and-forget: persisted + hash-verified, safe to clear the server row now. */
export interface SessionIdentityMigrateConfirm {
  type: typeof SESSION_IDENTITY_WS.MIGRATE_CONFIRM;
  confirmed: Array<{ scope: 'project' | 'session'; scopeKey: string; contentHash: string }>;
}

export interface SessionIdentityLocalReport {
  type: typeof SESSION_IDENTITY_WS.LOCAL_REPORT;
  scope: 'project' | 'session';
  scopeKey: string;
  deleted?: boolean;
  contentHash?: string;
  contentLength?: number;
  revision?: number;
  updatedAt?: number;
  source?: 'web' | 'mcp';
  sourceFile?: string;
}

export interface SessionIdentityUserReport {
  type: typeof SESSION_IDENTITY_WS.USER_REPORT;
  deleted?: boolean;
  content?: string;
  source?: 'web' | 'mcp';
  sourceFile?: string;
}

export interface SessionIdentityResolveQuery {
  type: typeof SESSION_IDENTITY_WS.RESOLVE_QUERY;
  requestId: string;
  scope: 'project' | 'session';
  sessionName: string;
}

export interface SessionIdentityResolveResponse {
  type: typeof SESSION_IDENTITY_WS.RESOLVE_RESPONSE;
  requestId: string;
  ok: boolean;
  scopeKey?: string;
  contentHash?: string;
  revision?: number;
  updatedAt?: number;
}
