/**
 * Admin-only API routes: user management + server settings.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { getUserById, listAllUsers, updateUserStatus, disableUserEndingSessions, deleteUser, countActiveAdmins, getAllSettings, setSetting } from '../db/queries.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import { USER_STATUS, isUserStatusActive, userStatusDenialCode } from '../../../shared/user-status.js';
import { closeConnectionsOfInactiveUsers } from '../ws/account-watch.js';
import { EmailServiceError, getEmailConfigStatus, sendEmail } from '../services/email.js';

export const adminRoutes = new Hono<{ Bindings: Env }>();

// ── Admin middleware — reuses global requireAuth + checks is_admin ────────

adminRoutes.use('*', requireAuth({ refuseDaemonCredential: true }));
adminRoutes.use('*', async (c, next) => {
  const userId = c.get('userId' as never) as string;
  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.is_admin) return c.json({ error: 'forbidden' }, 403);
  if (!isUserStatusActive(user.status)) return c.json({ error: userStatusDenialCode(user.status) }, 403);

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

  // Approving / enabling restores the STATUS and nothing else: the API keys and sessions a disable ended stay ended
  // (users.sessions_valid_after, revoked keys), so the user signs in again.
  await updateUserStatus(c.env.DB, targetId, USER_STATUS.ACTIVE);
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.approve_user', ip, details: { targetId, previousStatus: target.status } }, c.env.DB);
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/disable', async (c) => {
  const targetId = c.req.param('id');
  const adminUserId = c.get('adminUserId' as never) as string;
  if (targetId === adminUserId) return c.json({ error: 'cannot_modify_self' }, 403);

  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  // Default admin cannot be disabled
  if (target.username === 'admin') return c.json({ error: 'cannot_disable_admin' }, 403);

  // Cannot disable the last active admin
  if (target.is_admin && target.status === 'active') {
    const adminCount = await countActiveAdmins(c.env.DB);
    if (adminCount <= 1) return c.json({ error: 'last_admin' }, 403);
  }

  const ended = await disableUserEndingSessions(c.env.DB, targetId, Date.now());
  // This replica's live sockets (browser terminals, share participants, the user's daemons) close now; every other replica closes its own
  // within ACCOUNT_CONNECTION_WATCH_INTERVAL_MS (ws/account-watch.ts).
  const closed = await closeConnectionsOfInactiveUsers(c.env.DB).catch(() => ({ inactiveUsers: 0, browserSockets: 0, daemons: 0 }));
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({
    userId: c.get('adminUserId' as never) as string,
    action: 'admin.disable_user',
    ip,
    details: { targetId, previousStatus: target.status, ...ended, browserSocketsClosed: closed.browserSockets, daemonsClosed: closed.daemons },
  }, c.env.DB);
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const adminUserId = c.get('adminUserId' as never) as string;
  if (targetId === adminUserId) return c.json({ error: 'cannot_modify_self' }, 403);

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
  await closeConnectionsOfInactiveUsers(c.env.DB).catch(() => undefined);
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

  const BOOLEAN_SETTINGS = new Set(['registration_enabled', 'require_approval']);
  const VALID_BOOLEANS = new Set(['true', 'false']);
  const updates = body as Record<string, string>;
  const changed: Record<string, string> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!BOOLEAN_SETTINGS.has(key)) continue;
    if (typeof value !== 'string' || !VALID_BOOLEANS.has(value)) continue;
    await setSetting(c.env.DB, key, value);
    changed[key] = value;
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: c.get('adminUserId' as never) as string, action: 'admin.update_settings', ip, details: changed }, c.env.DB);
  return c.json({ ok: true });
});

// ── Email status & test send ──────────────────────────────────────────────

const emailTestSchema = z.object({
  // Preserve raw string (no .trim()) so sendEmail detects leading/trailing CR/LF/NUL injection before normalizing.
  to: z.string().min(1),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  provider: z.enum(['auto', 'aws_ses', 'aliyun_dm']).optional(),
});

adminRoutes.get('/email/status', (c) => {
  return c.json(getEmailConfigStatus(c.env));
});

adminRoutes.post('/email/test', async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  const parsed = emailTestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const { to, subject, text, html, provider } = parsed.data;
  const effectiveSubject = subject ?? 'IM.codes Email Delivery Test';
  const effectiveText =
    text === undefined && html === undefined
      ? 'This is a test email from IM.codes server email service.'
      : text;

  try {
    const result = await sendEmail(
      c.env,
      {
        to,
        subject: effectiveSubject,
        ...(effectiveText !== undefined ? { text: effectiveText } : {}),
        ...(html !== undefined ? { html } : {}),
      },
      provider && provider !== 'auto' ? { provider } : undefined,
    );
    const trimmedTo = to.trim();
    const at = trimmedTo.lastIndexOf('@');
    const recipientDomain = at === -1 ? 'unknown' : trimmedTo.slice(at + 1).toLowerCase();
    const ip = c.get('clientIp' as never) as string ?? 'unknown';
    await logAudit(
      {
        userId: c.get('adminUserId' as never) as string,
        action: 'admin.email_test',
        ip,
        details: {
          provider: result.provider,
          fallbackUsed: result.fallbackUsed,
          recipientDomain,
          messageId: result.messageId,
        },
      },
      c.env.DB,
    );
    return c.json({
      ok: true,
      provider: result.provider,
      messageId: result.messageId,
      fallbackUsed: result.fallbackUsed,
    });
  } catch (err) {
    if (err instanceof EmailServiceError) {
      if (err.code === 'email_invalid_input') {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      if (err.code === 'email_not_configured' || err.code === 'email_provider_not_configured') {
        return c.json({ error: err.code, message: err.message }, 503);
      }
      return c.json({ error: err.code, message: err.message }, 502);
    }
    return c.json({ error: 'email_send_failed', message: 'Failed to send test email' }, 502);
  }
});
