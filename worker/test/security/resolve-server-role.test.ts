import { describe, it, expect, vi } from 'vitest';
import { resolveServerRole } from '../../src/security/authorization.js';

// 10.4: Test resolveServerRole

function mockDb(serverRow: unknown, teamMemberRow: unknown = null) {
  const firstFn = vi.fn()
    .mockResolvedValueOnce(serverRow)      // first call: server lookup
    .mockResolvedValueOnce(teamMemberRow); // second call: team_members lookup
  const bindFn = vi.fn().mockReturnValue({ first: firstFn });
  const prepareFn = vi.fn().mockReturnValue({ bind: bindFn });
  return { prepare: prepareFn } as unknown as D1Database;
}

describe('resolveServerRole', () => {
  it('returns "owner" when user owns the server', async () => {
    const db = mockDb({ team_id: null, user_id: 'u1' });
    const role = await resolveServerRole(db, 'srv1', 'u1');
    expect(role).toBe('owner');
  });

  it('returns "admin" when user is team admin', async () => {
    const db = mockDb({ team_id: 't1', user_id: 'other' }, { role: 'admin' });
    const role = await resolveServerRole(db, 'srv1', 'u1');
    expect(role).toBe('admin');
  });

  it('returns "admin" when user is team owner', async () => {
    const db = mockDb({ team_id: 't1', user_id: 'other' }, { role: 'owner' });
    const role = await resolveServerRole(db, 'srv1', 'u1');
    expect(role).toBe('admin');
  });

  it('returns "member" when user is team member', async () => {
    const db = mockDb({ team_id: 't1', user_id: 'other' }, { role: 'member' });
    const role = await resolveServerRole(db, 'srv1', 'u1');
    expect(role).toBe('member');
  });

  it('returns "none" when server does not exist', async () => {
    const db = mockDb(null);
    const role = await resolveServerRole(db, 'srv-nonexistent', 'u1');
    expect(role).toBe('none');
  });

  it('returns "none" when user is not owner and not in team', async () => {
    const db = mockDb({ team_id: 't1', user_id: 'other' }, null);
    const role = await resolveServerRole(db, 'srv1', 'stranger');
    expect(role).toBe('none');
  });

  it('returns "none" when server has no team and user is not owner', async () => {
    const db = mockDb({ team_id: null, user_id: 'other' });
    const role = await resolveServerRole(db, 'srv1', 'stranger');
    expect(role).toBe('none');
  });
});
