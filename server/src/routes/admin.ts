/**
 * Admin-only API routes: user management + server settings.
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getUserById, listAllUsers, updateUserStatus, deleteUser, countActiveAdmins, getAllSettings, setSetting } from '../db/queries.js';
import { logAudit } from '../security/audit.js';
import { verifyJwt } from '../security/crypto.js';

// Resolve user ID from session
function resolveUserIdFromCookie(c: { req: { header(name: string): string | undefined }; env: Env }): string | null {
  const cookieHeader = c.req.header('cookie') ?? '';
  const match = cookieHeader.match(/(?:^|;\s*)rcc_session=([^;]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const payload = verifyJwt(token, c.env.JWT_SIGNING_KEY);
  return (payload && typeof payload.sub === 'string' && payload.type !== 'ws-ticket') ? payload.sub : null;
}

export const adminRoutes = new Hono<{ Bindings: Env }>();

// ── Admin middleware ──────────────────────────────────────────────────────

adminRoutes.use('*', async (c, next) => {
  const userId = resolveUserIdFromCookie(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.is_admin) return c.json({ error: 'forbidden' }, 403);
  if (user.status !== 'active') return c.json({ error: 'account_disabled' }, 403);

  c.set('adminUserId' as never, userId);
  return next();
});

// ── Users ────────────────────────────────────────────────────────────────

adminRoutes.get('/users', async (c) => {
  const users = await listAllUsers(c.env.DB);
  return c.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      isAdmin: u.is_admin,
      status: u.status,
      createdAt: u.created_at,
    })),
  });
});

adminRoutes.post('/users/:id/approve', async (c) => {
  const targetId = c.req.param('id');
  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  await updateUserStatus(c.env.DB, targetId, 'active');
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.approve_user', ip, details: { targetId } }, c.env.DB);
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/disable', async (c) => {
  const targetId = c.req.param('id');
  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  // Cannot disable the last active admin
  if (target.is_admin && target.status === 'active') {
    const adminCount = await countActiveAdmins(c.env.DB);
    if (adminCount <= 1) return c.json({ error: 'last_admin' }, 403);
  }

  await updateUserStatus(c.env.DB, targetId, 'disabled');
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.disable_user', ip, details: { targetId } }, c.env.DB);
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  // admin user cannot be deleted
  if (target.username === 'admin') return c.json({ error: 'cannot_delete_admin' }, 403);

  // Cannot delete the last active admin
  if (target.is_admin && target.status === 'active') {
    const adminCount = await countActiveAdmins(c.env.DB);
    if (adminCount <= 1) return c.json({ error: 'last_admin' }, 403);
  }

  await deleteUser(c.env.DB, targetId);
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.delete_user', ip, details: { targetId } }, c.env.DB);
  return c.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────

adminRoutes.get('/settings', async (c) => {
  const settings = await getAllSettings(c.env.DB);
  return c.json({ settings });
});

adminRoutes.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const ALLOWED_KEYS = new Set(['registration_enabled', 'require_approval']);
  const updates = body as Record<string, string>;

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value !== 'string') continue;
    await setSetting(c.env.DB, key, value);
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.update_settings', ip }, c.env.DB);
  return c.json({ ok: true });
});
