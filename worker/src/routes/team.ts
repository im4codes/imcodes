import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';

export const teamRoutes = new Hono<{ Bindings: Env }>();

// POST /api/team — create a new team
teamRoutes.post('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ name: string }>().catch(() => null);
  if (!body?.name) return c.json({ error: 'name required' }, 400);

  const teamId = randomHex(16);
  const now = Date.now();

  await c.env.DB.prepare(
    "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES (?, ?, ?, 'free', ?)",
  ).bind(teamId, body.name, userId, now).run();

  await c.env.DB.prepare(
    "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
  ).bind(teamId, userId, now).run();

  await logAudit({ userId, action: 'team.create', details: { teamId, name: body.name } }, c.env.DB);

  return c.json({ id: teamId, name: body.name, role: 'owner' }, 201);
});

// GET /api/team/:id — get team details
teamRoutes.get('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');

  const member = await c.env.DB
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>();
  if (!member) return c.json({ error: 'not_found' }, 404);

  const team = await c.env.DB
    .prepare('SELECT * FROM teams WHERE id = ?')
    .bind(teamId)
    .first();
  if (!team) return c.json({ error: 'not_found' }, 404);

  const members = await c.env.DB
    .prepare('SELECT user_id, role, joined_at FROM team_members WHERE team_id = ?')
    .bind(teamId)
    .all();

  return c.json({ ...team, members: members.results, myRole: member.role });
});

// POST /api/team/:id/invite — create invite link (owner/admin only)
teamRoutes.post('/:id/invite', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');

  const member = await c.env.DB
    .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin')")
    .bind(teamId, userId).first<{ role: string }>();
  if (!member) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json<{ role?: string; email?: string }>().catch(() => ({} as { role?: string; email?: string }));
  const role = ['admin', 'member'].includes(body.role ?? '') ? body.role : 'member';

  const inviteId = randomHex(16);
  const token = randomHex(24); // 48-char invite token
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const now = Date.now();

  await c.env.DB.prepare(
    'INSERT INTO team_invites (id, team_id, email, token, role, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(inviteId, teamId, body.email ?? null, token, role, userId, expiresAt, now).run();

  await logAudit({ userId, action: 'team.invite_created', details: { teamId, role } }, c.env.DB);

  return c.json({ token, expiresAt });
});

// POST /api/team/join/:token — accept invite by token (no team ID needed — token identifies team)
teamRoutes.post('/join/:token', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const token = c.req.param('token');
  const now = Date.now();

  const invite = await c.env.DB
    .prepare('SELECT * FROM team_invites WHERE token = ? AND used_at IS NULL AND expires_at > ?')
    .bind(token, now)
    .first<{ id: string; team_id: string; role: string }>();
  if (!invite) return c.json({ error: 'invalid_or_expired_invite' }, 400);

  // Add to team
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
  ).bind(invite.team_id, userId, invite.role, now).run();

  // Mark invite used
  await c.env.DB.prepare('UPDATE team_invites SET used_at = ? WHERE id = ?').bind(now, invite.id).run();

  await logAudit({ userId, action: 'team.joined', details: { teamId: invite.team_id, via: 'invite' } }, c.env.DB);

  return c.json({ ok: true, teamId: invite.team_id, role: invite.role });
});

// POST /api/team/:id/join — join with invite token in body (legacy route)
teamRoutes.post('/:id/join', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const now = Date.now();

  if (body.token) {
    const invite = await c.env.DB
      .prepare('SELECT * FROM team_invites WHERE token = ? AND team_id = ? AND used_at IS NULL AND expires_at > ?')
      .bind(body.token, teamId, now)
      .first<{ id: string; role: string }>();
    if (!invite) return c.json({ error: 'invalid_or_expired_invite' }, 400);

    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    ).bind(teamId, userId, invite.role, now).run();

    await c.env.DB.prepare('UPDATE team_invites SET used_at = ? WHERE id = ?').bind(now, invite.id).run();
    await logAudit({ userId, action: 'team.joined', details: { teamId, via: 'invite' } }, c.env.DB);
    return c.json({ ok: true, role: invite.role });
  }

  return c.json({ error: 'token required' }, 400);
});

// PUT /api/team/:id/member/:memberId/role — change member role
teamRoutes.put('/:id/member/:memberId/role', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');
  const memberId = c.req.param('memberId');
  const body = await c.req.json<{ role: string }>().catch(() => null);

  const me = await c.env.DB
    .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin')")
    .bind(teamId, userId).first<{ role: string }>();
  if (!me) return c.json({ error: 'forbidden' }, 403);

  if (!['admin', 'member'].includes(body?.role ?? '')) return c.json({ error: 'invalid_role' }, 400);

  await c.env.DB
    .prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?')
    .bind(body!.role, teamId, memberId)
    .run();

  await logAudit({ userId, action: 'team.role_change', details: { teamId, memberId, role: body!.role } }, c.env.DB);
  return c.json({ ok: true });
});

// DELETE /api/team/:id/member/:memberId — remove member
teamRoutes.delete('/:id/member/:memberId', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');
  const memberId = c.req.param('memberId');

  const me = await c.env.DB
    .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin')")
    .bind(teamId, userId).first<{ role: string }>();
  if (!me) return c.json({ error: 'forbidden' }, 403);

  await c.env.DB
    .prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, memberId)
    .run();

  await logAudit({ userId, action: 'team.member_removed', details: { teamId, memberId } }, c.env.DB);
  return c.json({ ok: true });
});
