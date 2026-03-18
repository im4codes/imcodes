import { describe, it, expect, vi } from 'vitest';
import { requireAuth, requireRole, requireTeamRole } from '../../src/security/authorization.js';
import { signJwt } from '../../src/security/crypto.js';

const TEST_SIGNING_KEY = 'test-signing-key-32bytes-minimum!!';

type JsonFn = (body: unknown, status?: number) => Response;

/**
 * Build a minimal Hono-like context for testing middleware.
 * authHeader: the value of the Authorization header (or undefined for none).
 */
function mockContext(authHeader?: string, dbOverrides?: { first?: unknown; all?: unknown }) {
  const mockFirst = vi.fn().mockResolvedValue(dbOverrides?.first ?? null);
  const mockAll = vi.fn().mockResolvedValue(dbOverrides?.all ?? { results: [] });
  const mockRun = vi.fn().mockResolvedValue({ success: true, meta: {} });
  const mockBind = vi.fn().mockReturnValue({ first: mockFirst, all: mockAll, run: mockRun });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });

  const vars: Record<string, unknown> = {};

  return {
    req: {
      header: (name: string) => (name === 'Authorization' ? authHeader : undefined),
      param: (_name: string) => 'team-1',
    },
    env: {
      DB: { prepare: mockPrepare },
      JWT_SIGNING_KEY: TEST_SIGNING_KEY,
    },
    json: vi.fn((body: unknown, status = 200) => ({ body, status })) as unknown as JsonFn,
    set: (key: string, value: unknown) => { vars[key] = value; },
    get: (key: string) => vars[key],
    _vars: vars,
    _mockPrepare: mockPrepare,
    _mockFirst: mockFirst,
  };
}

describe('requireAuth', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const c = mockContext(undefined);
    const next = vi.fn();
    const middleware = requireAuth();

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const c = mockContext('Basic abc123');
    const next = vi.fn();
    const middleware = requireAuth();

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Bearer token is not found in DB', async () => {
    const c = mockContext('Bearer deck_invalidkey', { first: null });
    const next = vi.fn();
    const middleware = requireAuth();

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when valid API key is found', async () => {
    const c = mockContext('Bearer deck_validkey123', { first: { user_id: 'u1' } });
    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = requireAuth();

    await middleware(c as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(c._vars['userId']).toBe('u1');
  });
});

describe('requireRole', () => {
  it('returns 401 when no Authorization header', async () => {
    const c = mockContext(undefined);
    const next = vi.fn();
    const middleware = requireRole('admin');

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 401 });
  });

  it('returns 403 when member tries to access admin route', async () => {
    const token = await signJwt({ sub: 'u1', role: 'member' }, TEST_SIGNING_KEY, 9999);
    const c = mockContext(`Bearer ${token}`);
    const next = vi.fn();
    const middleware = requireRole('admin');

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when role is sufficient (owner accessing admin route)', async () => {
    const token = await signJwt({ sub: 'u1', role: 'owner' }, TEST_SIGNING_KEY, 9999);
    const c = mockContext(`Bearer ${token}`);
    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = requireRole('admin');

    await middleware(c as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireTeamRole', () => {
  it('returns 401 when unauthenticated', async () => {
    const c = mockContext(undefined);
    const next = vi.fn();
    const middleware = requireTeamRole('member');

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 401 });
  });

  it('returns 403 when user is not a team member', async () => {
    const token = await signJwt({ sub: 'u1', role: 'member' }, TEST_SIGNING_KEY, 9999);
    // DB returns null — user not in team_members
    const c = mockContext(`Bearer ${token}`, { first: null });
    const next = vi.fn();
    const middleware = requireTeamRole('member');

    const result = await middleware(c as never, next);

    expect(result).toMatchObject({ status: 403 });
  });
});
