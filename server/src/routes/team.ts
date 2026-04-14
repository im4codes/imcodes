import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';

export const teamRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// GET /api/team — list teams accessible to the authenticated user
teamRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teams = await c.env.DB.query<{ id: string; name: string; role: string }>(
    `SELECT t.id, t.name, tm.role
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = $1
     ORDER BY t.name ASC`,
    [userId],
  );
  return c.json({ teams });
});

// POST /api/team — create a new team
teamRoutes.post('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ name: string }>().catch(() => null);
  if (!body?.name) return c.json({ error: 'name required' }, 400);

  const teamId = randomHex(16);
  const now = Date.now();

  await c.env.DB.execute(
    "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, $2, $3, 'free', $4)",
    [teamId, body.name, userId, now],
  );

  await c.env.DB.execute(
    "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)",
    [teamId, userId, now],
  );

  await logAudit({ userId, action: 'team.create', details: { teamId, name: body.name } }, c.env.DB);

  return c.json({ id: teamId, name: body.name, role: 'owner' }, 201);
});

// GET /api/team/:id — get team details
teamRoutes.get('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');

  const member = await c.env.DB
    .queryOne<{ role: string }>('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  if (!member) return c.json({ error: 'not_found' }, 404);

  const team = await c.env.DB
    .queryOne('SELECT * FROM teams WHERE id = $1', [teamId]);
  if (!team) return c.json({ error: 'not_found' }, 404);

  const members = await c.env.DB
    .query('SELECT user_id, role, joined_at FROM team_members WHERE team_id = $1', [teamId]);

  return c.json({ ...team as object, members, myRole: member.role });
});

// POST /api/team/:id/invite — create invite link (owner/admin only)
teamRoutes.post('/:id/invite', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');

  const member = await c.env.DB
    .queryOne<{ role: string }>("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')", [teamId, userId]);
  if (!member) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json<{ role?: string; email?: string }>().catch(() => ({} as { role?: string; email?: string }));
  const requestedRole = ['admin', 'member'].includes(body.role ?? '') ? body.role : 'member';
  if (requestedRole === 'admin' && member.role !== 'owner') {
    return c.json({ error: 'forbidden', reason: 'owner_required_for_admin_invite' }, 403);
  }
  const role = requestedRole;

  const inviteId = randomHex(16);
  const token = randomHex(24); // 48-char invite token
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const now = Date.now();

  await c.env.DB.execute(
    'INSERT INTO team_invites (id, team_id, email, token, role, invited_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [inviteId, teamId, body.email ?? null, token, role, userId, expiresAt, now],
  );

  await logAudit({ userId, action: 'team.invite_created', details: { teamId, role } }, c.env.DB);

  return c.json({ token, expiresAt });
});

// POST /api/team/join/:token — accept invite by token (no team ID needed — token identifies team)
teamRoutes.post('/join/:token', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const token = c.req.param('token');
  const now = Date.now();

  const invite = await c.env.DB
    .queryOne<{ id: string; team_id: string; role: string }>('SELECT * FROM team_invites WHERE token = $1 AND used_at IS NULL AND expires_at > $2', [token, now]);
  if (!invite) return c.json({ error: 'invalid_or_expired_invite' }, 400);

  // Add to team
  await c.env.DB.execute(
    'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [invite.team_id, userId, invite.role, now],
  );

  // Mark invite used
  await c.env.DB.execute('UPDATE team_invites SET used_at = $1 WHERE id = $2', [now, invite.id]);

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
      .queryOne<{ id: string; role: string }>('SELECT * FROM team_invites WHERE token = $1 AND team_id = $2 AND used_at IS NULL AND expires_at > $3', [body.token, teamId, now]);
    if (!invite) return c.json({ error: 'invalid_or_expired_invite' }, 400);

    await c.env.DB.execute(
      'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [teamId, userId, invite.role, now],
    );

    await c.env.DB.execute('UPDATE team_invites SET used_at = $1 WHERE id = $2', [now, invite.id]);
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
    .queryOne<{ role: string }>("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')", [teamId, userId]);
  if (!me) return c.json({ error: 'forbidden' }, 403);

  if (!['admin', 'member'].includes(body?.role ?? '')) return c.json({ error: 'invalid_role' }, 400);
  if (body?.role === 'admin' && me.role !== 'owner') {
    return c.json({ error: 'forbidden', reason: 'owner_required_for_admin_role' }, 403);
  }

  const target = await c.env.DB
    .queryOne<{ role: string }>('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, memberId]);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner' && me.role !== 'owner') {
    return c.json({ error: 'forbidden', reason: 'owner_target_protected' }, 403);
  }
  if (target.role === 'admin' && me.role !== 'owner') {
    return c.json({ error: 'forbidden', reason: 'owner_required_to_manage_admin' }, 403);
  }

  await c.env.DB.execute(
    'UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3',
    [body!.role, teamId, memberId],
  );

  await logAudit({ userId, action: 'team.role_change', details: { teamId, memberId, role: body!.role } }, c.env.DB);
  return c.json({ ok: true });
});

// DELETE /api/team/:id/member/:memberId — remove member
teamRoutes.delete('/:id/member/:memberId', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const teamId = c.req.param('id');
  const memberId = c.req.param('memberId');

  const me = await c.env.DB
    .queryOne<{ role: string }>("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')", [teamId, userId]);
  if (!me) return c.json({ error: 'forbidden' }, 403);

  const target = await c.env.DB
    .queryOne<{ role: string }>('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, memberId]);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'forbidden', reason: 'owner_target_protected' }, 403);
  if (target.role === 'admin' && me.role !== 'owner') {
    return c.json({ error: 'forbidden', reason: 'owner_required_to_manage_admin' }, 403);
  }

  await c.env.DB.execute(
    'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
    [teamId, memberId],
  );

  await logAudit({ userId, action: 'team.member_removed', details: { teamId, memberId } }, c.env.DB);
  return c.json({ ok: true });
});
