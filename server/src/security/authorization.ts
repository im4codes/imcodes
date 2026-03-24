/**
 * Role-to-command authorization middleware.
 * Enforces owner/admin/member/unauthenticated permission matrix.
 */
import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import type { PgDatabase } from '../db/client.js';
import { sha256Hex, verifyJwt } from './crypto.js';
import { getServerById } from '../db/queries.js';
import { COOKIE_SESSION } from '../../../shared/cookie-names.js';

export type Role = 'owner' | 'admin' | 'member' | 'unauthenticated';

interface AuthContext {
  userId: string;
  role: Role;
  keyId?: string;
}

/**
 * Resolve auth context from request.
 * Priority: rcc_session cookie → Authorization: Bearer (API key / JWT).
 * Bearer is preserved for daemon server-token, API keys, and CLI clients.
 */
async function resolveAuth(c: Context<{ Bindings: Env }>): Promise<AuthContext | null> {
  // Task 1: Try HttpOnly session cookie first (browser sessions)
  const cookieToken = getCookie(c, COOKIE_SESSION);
  if (cookieToken && c.env.JWT_SIGNING_KEY) {
    const payload = verifyJwt(cookieToken, c.env.JWT_SIGNING_KEY);
    if (payload && typeof payload.sub === 'string' && payload.type !== 'ws-ticket') {
      return { userId: payload.sub, role: (payload.role as Role) ?? 'member' };
    }
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // Try daemon server-token auth: X-Server-Id header + Bearer <server-token>
  // Allows the daemon to call REST endpoints without a user JWT.
  const daemonServerId = c.req.header('X-Server-Id');
  if (daemonServerId) {
    const server = await getServerById(c.env.DB, daemonServerId);
    if (!server) return null;
    const tokenHash = sha256Hex(token);
    if (tokenHash !== server.token_hash) return null;
    return { userId: server.user_id, role: 'owner' as Role };
  }

  // Try API key lookup (deck_ prefix)
  if (token.startsWith('deck_')) {
    const keyHash = sha256Hex(token);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `SELECT id, user_id FROM api_keys
       WHERE key_hash = ?
         AND revoked_at IS NULL
         AND (grace_expires_at IS NULL OR grace_expires_at > ?)`,
    ).bind(keyHash, now).first<{ id: string; user_id: string }>();
    if (!row) return null;
    return { userId: row.user_id, role: 'member', keyId: row.id }; // API keys default to member
  }

  // Try JWT (access token) — verify HMAC-SHA256 signature
  // Reject special-purpose tokens (e.g. ws-ticket) from being used as session auth
  if (!c.env.JWT_SIGNING_KEY) return null;
  const payload = verifyJwt(token, c.env.JWT_SIGNING_KEY);
  if (!payload) return null;
  if (typeof payload.sub !== 'string') return null;
  if (payload.type === 'ws-ticket') return null; // reject single-use WebSocket tickets
  return { userId: payload.sub, role: (payload.role as Role) ?? 'member' };
}

// ── Permission matrix ─────────────────────────────────────────────────────────

type Operation = 'read' | 'write' | 'admin' | 'owner';

const ROLE_PERMISSIONS: Record<Role, Set<Operation>> = {
  owner: new Set(['read', 'write', 'admin', 'owner']),
  admin: new Set(['read', 'write', 'admin']),
  member: new Set(['read', 'write']),
  unauthenticated: new Set(),
};

function canPerform(role: Role, op: Operation): boolean {
  return ROLE_PERMISSIONS[role].has(op);
}

// ── Middleware factories ───────────────────────────────────────────────────────

/**
 * Require authenticated request (any role).
 * Sets c.var.userId and c.var.role.
 */
export function requireAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const auth = await resolveAuth(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);

    c.set('userId' as never, auth.userId);
    c.set('role' as never, auth.role);
    if (auth.keyId) c.set('keyId' as never, auth.keyId);
    await next();
  };
}

/**
 * Require at minimum the given role.
 */
export function requireRole(minRole: Role) {
  const minPerm: Operation = minRole === 'owner' ? 'owner'
    : minRole === 'admin' ? 'admin'
    : 'read';

  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const auth = await resolveAuth(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);

    if (!canPerform(auth.role, minPerm)) {
      return c.json({ error: 'forbidden', required: minRole, actual: auth.role }, 403);
    }

    c.set('userId' as never, auth.userId);
    c.set('role' as never, auth.role);
    await next();
  };
}

/**
 * Require write access (member or above).
 */
export const requireWrite = () => requireRole('member');

/**
 * Require admin access.
 */
export const requireAdmin = () => requireRole('admin');

/**
 * Require owner access.
 */
export const requireOwner = () => requireRole('owner');

/**
 * Require team membership at a minimum role level.
 * Reads teamId from c.req.param('id') by default, or from the provided paramName.
 * Sets c.var.teamRole to the user's team role.
 */
export function requireTeamRole(minRole: 'owner' | 'admin' | 'member' = 'member', paramName = 'id') {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const auth = await resolveAuth(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);

    const teamId = c.req.param(paramName);
    const row = await c.env.DB
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, auth.userId)
      .first<{ role: Role }>();

    if (!row) return c.json({ error: 'forbidden', reason: 'not_a_team_member' }, 403);

    // Check minimum role level
    const roleRank: Record<Role, number> = { owner: 3, admin: 2, member: 1, unauthenticated: 0 };
    if (roleRank[row.role] < roleRank[minRole]) {
      return c.json({ error: 'forbidden', required: minRole, actual: row.role }, 403);
    }

    c.set('userId' as never, auth.userId);
    c.set('role' as never, row.role);
    c.set('teamRole' as never, row.role);
    await next();
  };
}

export type ServerRole = 'owner' | 'admin' | 'member' | 'none';

/**
 * Resolve the user's role for a specific server.
 * Checks server ownership first, then team membership.
 */
export async function resolveServerRole(
  db: PgDatabase,
  serverId: string,
  userId: string,
): Promise<ServerRole> {
  const server = await db
    .prepare('SELECT team_id, user_id FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{ team_id: string | null; user_id: string }>();

  if (!server) return 'none';

  // Direct owner
  if (server.user_id === userId) return 'owner';

  // Team membership
  if (server.team_id) {
    const member = await db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(server.team_id, userId)
      .first<{ role: string }>();
    if (member) {
      if (member.role === 'owner') return 'admin'; // team owner → admin on server
      if (member.role === 'admin') return 'admin';
      return 'member';
    }
  }

  return 'none';
}

/**
 * Check if a server belongs to a team the user is a member of.
 * Used before server operations to enforce team-scoped access.
 */
export async function checkServerTeamAccess(
  c: Context<{ Bindings: Env }>,
  serverId: string,
  userId: string,
): Promise<boolean> {
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  return role !== 'none';
}
