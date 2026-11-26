/**
 * Regression & counterexample tests for security hardening (tsk_3b375f8d07):
 * - Passkey native XSS / CSP / atomic challenge / counter CAS / require_approval
 * - Bogus Authorization: Bearer CSRF bypass closure
 * - requireTeamRole NODE_ROLE.CONTROLLED & refuseDaemonCredential
 * - Primary OAuth registration_enabled / require_approval / single-use + origin-bound relay_token / no plaintext token logs
 * - Register no 'anon' idempotency key leak, rate limit, require_approval
 * - Password change lockout + refresh/JWT revocation + browser cookie rotation
 * - Atomic refresh_tokens, bind/confirm (with active user + rate limit), team/join, doc-relay DB replay guard
 * - Team admin privilege escalation block on POST /api/team/:id/member
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';

const { verifyRegistrationResponseMock, verifyAuthenticationResponseMock } = vi.hoisted(() => ({
  verifyRegistrationResponseMock: vi.fn(),
  verifyAuthenticationResponseMock: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'reg-challenge', rp: { id: 'localhost', name: 'IM.codes' }, user: { id: 'u', name: 'u', displayName: 'u' }, pubKeyCredParams: [] })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'auth-challenge', rpId: 'localhost' })),
  verifyRegistrationResponse: verifyRegistrationResponseMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock,
}));

import { buildApp, setupWebSocketUpgrade } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { signJwt, sha256Hex, randomHex, hashPassword } from '../src/security/crypto.js';
import { requireTeamRole } from '../src/security/authorization.js';
import { rateLimiter } from '../src/security/lockout.js';
import logger from '../src/util/logger.js';
import { COOKIE_SESSION, COOKIE_CSRF, HEADER_CSRF } from '../../shared/cookie-names.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED } from '../../shared/daemon-token-routes.js';
import { NODE_ROLE, NODE_ROLE_REFUSAL } from '../../shared/remote-exec.js';
import { GLOBAL_TASK_TICKET_PATH, GLOBAL_TASK_WS_PATH } from '../../shared/global-task-mode.js';

interface MemUser {
  id: string;
  username: string | null;
  display_name: string | null;
  password_hash: string | null;
  password_must_change: boolean | null;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
  sessions_valid_after: number;
  created_at: number;
}

function createHardeningDb() {
  const users = new Map<string, MemUser>();
  const settings = new Map<string, string>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; label: string | null; revoked_at: number | null; grace_expires_at: number | null; created_at: number }>();
  const refreshTokens = new Map<string, { id: string; user_id: string; token_hash: string; family_id: string; used_at: number | null; expires_at: number; created_at: number }>();
  const authNonces = new Map<string, { nonce: string; api_key: string; user_id: string; key_id: string; expires_at: number; created_at: number }>();
  const passkeyChallenges = new Map<string, { id: string; challenge: string; user_id: string | null; display_name: string; expires_at: number; created_at: number }>();
  const passkeyCreds = new Map<string, { id: string; user_id: string; public_key: string; counter: number; device_name: string | null; transports: string | null; created_at: number; last_used_at: number | null }>();
  const platformIdentities = new Map<string, { id: string; user_id: string; platform: string; platform_user_id: string }>();
  const pendingBinds = new Map<string, { code: string; user_id: string; server_name: string; expires_at: number; created_at: number }>();
  const servers = new Map<string, { id: string; user_id: string; name: string; token_hash: string; node_role: string; revoked_at: number | null }>();
  const teams = new Map<string, { id: string; name: string; owner_id: string }>();
  const teamMembers = new Map<string, Map<string, { role: 'owner' | 'admin' | 'member'; joined_at: number }>>();
  const teamInvites = new Map<string, { id: string; team_id: string; token: string; role: string; expires_at: number; used_at: number | null }>();
  const idempotencyRecords = new Map<string, unknown>();
  const lockouts = new Map<string, { fail_count: number; first_fail_at: Date; locked_until: Date | null }>();

  let failNextSqlSubstring: string | null = null;
  let beforeTxSqlHook: ((sql: string) => Promise<void> | void) | null = null;
  const txLocks = new Map<string, Promise<void>>();

  async function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = txLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    txLocks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (txLocks.get(key) === chained) txLocks.delete(key);
    }
  }

  function snapshotMaps() {
    return {
      users: new Map([...users.entries()].map(([k, v]) => [k, { ...v }])),
      refreshTokens: new Map([...refreshTokens.entries()].map(([k, v]) => [k, { ...v }])),
      authNonces: new Map([...authNonces.entries()].map(([k, v]) => [k, { ...v }])),
      pendingBinds: new Map([...pendingBinds.entries()].map(([k, v]) => [k, { ...v }])),
      servers: new Map([...servers.entries()].map(([k, v]) => [k, { ...v }])),
      teamInvites: new Map([...teamInvites.entries()].map(([k, v]) => [k, { ...v }])),
      teamMembers: new Map([...teamMembers.entries()].map(([k, m]) => [k, new Map([...m.entries()].map(([mk, mv]) => [mk, { ...mv }]))])),
    };
  }

  function restoreMaps(snap: ReturnType<typeof snapshotMaps>) {
    users.clear();
    for (const [k, v] of snap.users) users.set(k, v);
    refreshTokens.clear();
    for (const [k, v] of snap.refreshTokens) refreshTokens.set(k, v);
    authNonces.clear();
    for (const [k, v] of snap.authNonces) authNonces.set(k, v);
    pendingBinds.clear();
    for (const [k, v] of snap.pendingBinds) pendingBinds.set(k, v);
    servers.clear();
    for (const [k, v] of snap.servers) servers.set(k, v);
    teamInvites.clear();
    for (const [k, v] of snap.teamInvites) teamInvites.set(k, v);
    teamMembers.clear();
    for (const [k, v] of snap.teamMembers) teamMembers.set(k, v);
  }

  function checkInjectedFailure(s: string) {
    if (failNextSqlSubstring && s.includes(failNextSqlSubstring)) {
      failNextSqlSubstring = null;
      throw new Error(`injected db failure on: ${s}`);
    }
  }

  const norm = (sql: string) => sql.toLowerCase().replace(/\s+/g, ' ').trim();
  const sqlLog: Array<{ sql: string; inTx: boolean }> = [];

  function makeRunner(inTx: boolean): Database {
    const runner = {
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const s = norm(sql);
        sqlLog.push({ sql: s, inTx });
        if (beforeTxSqlHook) await beforeTxSqlHook(s);
        checkInjectedFailure(s);
        if (s.includes('select status, sessions_valid_after from users where id = $1')) {
          const u = users.get(String(params[0]));
          return u ? ({ status: u.status, sessions_valid_after: u.sessions_valid_after } as T) : null;
        }
        if (s.includes('select sessions_valid_after from users where id = $1')) {
          const u = users.get(String(params[0]));
          return u ? ({ sessions_valid_after: u.sessions_valid_after } as T) : null;
        }
        if (s.includes('from users where id = $1')) {
          const u = users.get(String(params[0]));
          return (u ? { ...u } : null) as T | null;
        }
        if (s.includes('from users where username = $1')) {
          for (const u of users.values()) if (u.username === params[0]) return { ...u } as T;
          return null;
        }
        if (s.includes('where id = $1 or lower(username) = lower($1)')) {
          const key = String(params[0]);
          const byId = users.get(key);
          if (byId) return { ...byId } as T;
          for (const u of users.values()) if (u.username?.toLowerCase() === key.toLowerCase()) return { ...u } as T;
          return null;
        }
        if (s.includes('from settings where key = $1')) {
          const val = settings.get(String(params[0]));
          return val !== undefined ? ({ value: val } as T) : null;
        }
        if (s.includes('from platform_identities pi join users u')) {
          const key = `${String(params[0])}:${String(params[1])}`;
          const pi = platformIdentities.get(key);
          const u = pi ? users.get(pi.user_id) : undefined;
          return u ? ({ ...u } as T) : null;
        }
      if (s.includes('from api_keys') && s.includes('where key_hash = $1')) {
        for (const k of apiKeys.values()) {
          if (k.key_hash === params[0] && !k.revoked_at) {
            const u = users.get(k.user_id);
            return { id: k.id, user_id: k.user_id, user_status: u?.status ?? null } as T;
          }
        }
        return null;
      }
      if (s.includes('from servers where id = $1')) {
        const sv = servers.get(String(params[0]));
        if (!sv) return null;
        const owner = users.get(sv.user_id);
        return {
          token_hash: sv.token_hash,
          user_id: sv.user_id,
          node_role: sv.node_role,
          revoked_at: sv.revoked_at,
          owner_status: owner?.status ?? null,
        } as T;
      }
      if (s.includes('delete from passkey_challenges where id = $1 and expires_at > $2') && s.includes('returning')) {
        const id = String(params[0]);
        const row = passkeyChallenges.get(id);
        if (!row || row.expires_at <= Number(params[1])) return null;
        if (s.includes('id not like $3') && id.startsWith(String(params[2]).replace(/%$/, ''))) return null;
        passkeyChallenges.delete(id);
        return { challenge: row.challenge, user_id: row.user_id, display_name: row.display_name } as T;
      }
      if (s.includes('from passkey_challenges where id = $1 and expires_at > $2')) {
        const id = String(params[0]);
        const row = passkeyChallenges.get(id);
        if (!row || row.expires_at <= Number(params[1])) return null;
        if (s.includes('id not like $3') && id.startsWith(String(params[2]).replace(/%$/, ''))) return null;
        return { challenge: row.challenge, user_id: row.user_id, display_name: row.display_name } as T;
      }
      if (s.includes('insert into passkey_challenges') && s.includes('on conflict (id) do nothing returning id')) {
        const id = String(params[0]);
        if (passkeyChallenges.has(id)) return null;
        passkeyChallenges.set(id, {
          id,
          challenge: String(params[1]),
          user_id: null,
          display_name: String(params[2]),
          expires_at: Number(params[3]),
          created_at: Number(params[4]),
        });
        return { id } as T;
      }
      if (s.includes('select id from passkey_challenges where id = $1')) {
        const row = passkeyChallenges.get(String(params[0]));
        return row ? ({ id: row.id } as T) : null;
      }
      if (s.includes('from passkey_credentials where id = $1')) {
        const row = passkeyCreds.get(String(params[0]));
        return (row ? { ...row } : null) as T | null;
      }
      if (s.includes('delete from auth_nonces where nonce = $1 and user_id = $2 and expires_at > $3 and key_id = $4') && s.includes('returning')) {
        const key = String(params[0]);
        const row = authNonces.get(key);
        if (!row || row.user_id !== String(params[1]) || row.expires_at <= Number(params[2]) || row.key_id !== String(params[3])) return null;
        authNonces.delete(key);
        return { user_id: row.user_id } as T;
      }
      if (s.includes('delete from auth_nonces where nonce = $1 and expires_at > $2') && s.includes('returning')) {
        const key = String(params[0]);
        const row = authNonces.get(key);
        if (!row || row.expires_at <= Number(params[1])) return null;
        if (s.includes('key_id = $3') && row.key_id !== String(params[2])) return null;
        if (s.includes('key_id != $3') && row.key_id === String(params[2])) return null;
        authNonces.delete(key);
        return { api_key: row.api_key, user_id: row.user_id, key_id: row.key_id } as T;
      }
      if (s.includes('select user_id, expires_at from auth_nonces where nonce = $1')) {
        const row = authNonces.get(String(params[0]));
        if (!row) return null;
        if (s.includes('key_id != $2') && row.key_id === String(params[1])) return null;
        return { user_id: row.user_id, expires_at: row.expires_at } as T;
      }
      if (s.includes('select user_id from refresh_tokens where token_hash = $1 and used_at is null and expires_at > $2')) {
        const hash = String(params[0]);
        const now = Number(params[1]);
        for (const rt of refreshTokens.values()) {
          if (rt.token_hash === hash && rt.used_at === null && rt.expires_at > now) {
            return { user_id: rt.user_id } as T;
          }
        }
        return null;
      }
      if (s.includes('update refresh_tokens set used_at = $1 where token_hash = $2') && s.includes('returning')) {
        const now = Number(params[0]);
        const hash = String(params[1]);
        for (const rt of refreshTokens.values()) {
          if (rt.token_hash === hash && rt.used_at === null && rt.expires_at > now) {
            rt.used_at = now;
            return { id: rt.id, user_id: rt.user_id, family_id: rt.family_id } as T;
          }
        }
        return null;
      }
      if (s.includes('delete from pending_binds where code = $1') && s.includes('returning')) {
        const code = String(params[0]);
        const now = Number(params[1]);
        const row = pendingBinds.get(code);
        if (!row || row.expires_at <= now) return null;
        const u = users.get(row.user_id);
        if (!u || u.status !== 'active') return null;
        pendingBinds.delete(code);
        return { code: row.code, user_id: row.user_id, server_name: row.server_name } as T;
      }
      if (s.includes('select role from team_members where team_id = $1 and user_id = $2')) {
        const member = teamMembers.get(String(params[0]))?.get(String(params[1]));
        return member ? ({ role: member.role } as T) : null;
      }
      if (s.includes('update team_invites set used_at = $1 where token = $2 and used_at is null and expires_at > $1 returning')) {
        const now = Number(params[0]);
        const inv = [...teamInvites.values()].find((i) => i.token === params[1]);
        if (!inv || inv.used_at !== null || inv.expires_at <= now) return null;
        inv.used_at = now;
        return { id: inv.id, team_id: inv.team_id, role: inv.role } as T;
      }
      if (s.includes('update team_invites set used_at = $1 where token = $2 and team_id = $3 and used_at is null and expires_at > $1 returning')) {
        const now = Number(params[0]);
        const inv = [...teamInvites.values()].find((i) => i.token === params[1] && i.team_id === params[2]);
        if (!inv || inv.used_at !== null || inv.expires_at <= now) return null;
        inv.used_at = now;
        return { id: inv.id, role: inv.role } as T;
      }
      if (s.includes('from auth_lockout') && s.includes('locked_until > now')) {
        const entry = lockouts.get(String(params[0]));
        if (entry?.locked_until && entry.locked_until > new Date()) {
          return { locked_until: entry.locked_until } as T;
        }
        return null;
      }
      if (s.includes('insert into auth_lockout')) {
        const id = String(params[0]);
        const prev = lockouts.get(id);
        const failCount = (prev?.fail_count ?? 0) + 1;
        const lockedUntil = failCount >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
        lockouts.set(id, { fail_count: failCount, first_fail_at: prev?.first_fail_at ?? new Date(), locked_until: lockedUntil });
        return { fail_count: failCount, locked_until: lockedUntil } as T;
      }
      if (s.includes('select response_status, response_body from idempotency_records')) {
        return (idempotencyRecords.get(`${String(params[0])}:${String(params[1])}`) ?? null) as T | null;
      }
      return null;
    },
    query: async <T = unknown>() => [] as T[],
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = norm(sql);
      sqlLog.push({ sql: s, inTx });
      if (beforeTxSqlHook) await beforeTxSqlHook(s);
      checkInjectedFailure(s);
      if (s.startsWith('insert into users')) {
        users.set(String(params[0]), {
          id: String(params[0]),
          username: null,
          display_name: null,
          password_hash: null,
          password_must_change: null,
          is_admin: false,
          status: 'active',
          sessions_valid_after: 0,
          created_at: Number(params[1]),
        });
      } else if (s.startsWith('update users set status = $1, sessions_valid_after')) {
        const u = users.get(String(params[2]));
        if (u) {
          u.status = String(params[0]) as MemUser['status'];
          u.sessions_valid_after = Math.max(u.sessions_valid_after, Number(params[1]));
        }
      } else if (s.startsWith('update users set status = $1 where id = $2')) {
        const u = users.get(String(params[1]));
        if (u) u.status = String(params[0]) as MemUser['status'];
      } else if (s.startsWith('update users set username = $1, password_hash = $2')) {
        const u = users.get(String(params[2]));
        if (u) {
          u.username = String(params[0]);
          u.password_hash = String(params[1]);
          u.password_must_change = false;
        }
      } else if (s.startsWith('update users set password_hash = $1')) {
        const u = users.get(String(params[1]));
        if (u) {
          u.password_hash = String(params[0]);
          u.password_must_change = false;
          if (params.length >= 3) {
            u.sessions_valid_after = Math.max(u.sessions_valid_after, Number(params[2]));
          }
        }
      } else if (s.startsWith('insert into api_keys')) {
        apiKeys.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          key_hash: String(params[2]),
          label: params.length > 4 ? String(params[3]) : null,
          revoked_at: null,
          grace_expires_at: null,
          created_at: Number(params[params.length - 1]),
        });
      } else if (s.startsWith('update api_keys set revoked_at = $1 where user_id = $2')) {
        const now = Number(params[0]);
        for (const k of apiKeys.values()) {
          if (k.user_id === params[1] && k.revoked_at === null) k.revoked_at = now;
        }
      } else if (s.startsWith('insert into refresh_tokens')) {
        refreshTokens.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          token_hash: String(params[2]),
          family_id: String(params[3]),
          used_at: null,
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
      } else if (s.startsWith('update refresh_tokens set used_at = $1 where user_id = $2')) {
        const now = Number(params[0]);
        for (const rt of refreshTokens.values()) {
          if (rt.user_id === params[1] && rt.used_at === null) rt.used_at = now;
        }
      } else if (s.startsWith('insert into auth_nonces')) {
        authNonces.set(String(params[0]), {
          nonce: String(params[0]),
          api_key: String(params[1]),
          user_id: String(params[2]),
          key_id: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
      } else if (s.startsWith('delete from auth_nonces where expires_at <')) {
        const cutoff = Number(params[0]);
        const excludeKeyId = s.includes('key_id != $2') ? String(params[1]) : null;
        for (const [k, v] of authNonces) {
          if (v.expires_at < cutoff && (excludeKeyId === null || v.key_id !== excludeKeyId)) authNonces.delete(k);
        }
      } else if (s.startsWith('delete from auth_nonces where key_id =')) {
        for (const [k, v] of authNonces) if (v.key_id === params[0] && v.expires_at < Number(params[1])) authNonces.delete(k);
      } else if (s.startsWith('delete from auth_nonces where user_id = $1')) {
        for (const [k, v] of authNonces) if (v.user_id === params[0]) authNonces.delete(k);
      } else if (s.startsWith('insert into passkey_challenges')) {
        passkeyChallenges.set(String(params[0]), {
          id: String(params[0]),
          challenge: String(params[1]),
          user_id: (params[2] as string | null) ?? null,
          display_name: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
      } else if (s.startsWith('delete from passkey_challenges where id like $1 and expires_at < $2')) {
        const prefix = String(params[0]).replace(/%$/, '');
        const cutoff = Number(params[1]);
        for (const [k, v] of passkeyChallenges) if (k.startsWith(prefix) && v.expires_at < cutoff) passkeyChallenges.delete(k);
      } else if (s.startsWith('delete from passkey_challenges where expires_at < $1')) {
        const cutoff = Number(params[0]);
        const excludePrefix = s.includes('id not like $2') ? String(params[1]).replace(/%$/, '') : null;
        for (const [k, v] of passkeyChallenges) {
          if (v.expires_at < cutoff && (excludePrefix === null || !k.startsWith(excludePrefix))) passkeyChallenges.delete(k);
        }
      } else if (s.startsWith('delete from passkey_challenges where id = $1')) {
        const id = String(params[0]);
        const row = passkeyChallenges.get(id);
        if (!row) return { changes: 0 };
        if (s.includes('expires_at > $2') && row.expires_at <= Number(params[1])) return { changes: 0 };
        if (s.includes('user_id = $3') && row.user_id !== String(params[2])) return { changes: 0 };
        if (s.includes('id not like $4') && id.startsWith(String(params[3]).replace(/%$/, ''))) return { changes: 0 };
        passkeyChallenges.delete(id);
        return { changes: 1 };
      } else if (s.startsWith('insert into passkey_credentials')) {
        passkeyCreds.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          public_key: String(params[2]),
          counter: Number(params[3]),
          device_name: (params[4] as string | null) ?? null,
          transports: (params[5] as string | null) ?? null,
          created_at: Number(params[6]),
          last_used_at: null,
        });
      } else if (s.startsWith('update passkey_credentials set counter = $1')) {
        const cred = passkeyCreds.get(String(params[2]));
        if (!cred) return { changes: 0 };
        if (params.length >= 4 && cred.counter !== Number(params[3])) return { changes: 0 };
        cred.counter = Number(params[0]);
        cred.last_used_at = Number(params[1]);
        return { changes: 1 };
      } else if (s.startsWith('insert into platform_identities')) {
        platformIdentities.set(`${String(params[2])}:${String(params[3])}`, {
          id: String(params[0]),
          user_id: String(params[1]),
          platform: String(params[2]),
          platform_user_id: String(params[3]),
        });
      } else if (s.startsWith('insert into pending_binds')) {
        pendingBinds.set(String(params[0]), {
          code: String(params[0]),
          user_id: String(params[1]),
          server_name: String(params[2]),
          expires_at: Number(params[3]),
          created_at: Number(params[4]),
        });
      } else if (s.startsWith('insert into servers')) {
        servers.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          name: String(params[2]),
          token_hash: String(params[3]),
          node_role: 'full',
          revoked_at: null,
        });
      } else if (s.startsWith('insert into team_members')) {
        const teamId = String(params[0]);
        const userId = String(params[1]);
        if (!teamMembers.has(teamId)) teamMembers.set(teamId, new Map());
        const map = teamMembers.get(teamId)!;
        if (!map.has(userId)) {
          map.set(userId, { role: params[2] as 'owner' | 'admin' | 'member', joined_at: Number(params[3]) });
        }
      } else if (s.startsWith('insert into idempotency_records')) {
        idempotencyRecords.set(`${String(params[0])}:${String(params[1])}`, params);
      }
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => withUserLock('global-tx', async () => {
      const snap = snapshotMaps();
      try {
        return await fn(makeRunner(true));
      } catch (err) {
        restoreMaps(snap);
        throw err;
      }
    }),
  };
    return runner as unknown as Database;
  }

  const db = makeRunner(false);

  return {
    db,
    sqlLog,
    users,
    settings,
    apiKeys,
    refreshTokens,
    authNonces,
    passkeyChallenges,
    passkeyCreds,
    pendingBinds,
    servers,
    teams,
    teamMembers,
    teamInvites,
    idempotencyRecords,
    lockouts,
    setFailNextSql(substring: string | null) {
      failNextSqlSubstring = substring;
    },
    setBeforeSqlHook(hook: ((sql: string) => Promise<void> | void) | null) {
      beforeTxSqlHook = hook;
    },
  };
}

function makeEnv(db: Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: 'https://app.im.codes,https://hk.im.codes',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'production',
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  };
}

describe('security hardening (tsk_3b375f8d07)', () => {
  beforeEach(() => {
    rateLimiter.reset();
    verifyRegistrationResponseMock.mockReset();
    verifyAuthenticationResponseMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('AC1: blocks Reflected XSS in /api/auth/passkey/native & native_callback and sends nonce CSP headers', async () => {
    const store = createHardeningDb();
    const app = buildApp(makeEnv(store.db));

    const payload = 'imcodes://auth/</script><script>alert(1)</script>?a=1&b=2';
    const res = await app.request(`/api/auth/passkey/native?callback=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonceMatch = csp.match(/script-src 'nonce-([a-f0-9]+)'/);
    expect(nonceMatch).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonceMatch![1]}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).not.toContain('onclick="run()"');
    expect(html).toContain(`<script nonce="${nonceMatch![1]}">`);
    expect(html).toContain('%3C/script%3E');
    expect(html).toContain('\\u0026b=2');

    for (const bad of ['https://evil.example/cb', 'javascript:alert(1)', 'not-a-url']) {
      const badRes = await app.request(`/api/auth/passkey/native?callback=${encodeURIComponent(bad)}`);
      expect(badRes.status).toBe(400);
    }

    // Also reject invalid native_callback on passkey/login/complete
    const badComplete = await app.request('/api/auth/passkey/login/complete?native_callback=' + encodeURIComponent('javascript:alert(1)'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'c1', response: { id: 'cred-1' } }),
    });
    // challengeId check runs first or invalid_callback; verify with valid challenge
    store.users.set('u1', {
      id: 'u1', username: 'u1', display_name: null, password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });
    store.passkeyCreds.set('cred-1', {
      id: 'cred-1', user_id: 'u1', public_key: Buffer.from('pk').toString('base64'), counter: 1,
      device_name: null, transports: null, created_at: Date.now(), last_used_at: null,
    });
    store.passkeyChallenges.set('c-bad-cb', {
      id: 'c-bad-cb', challenge: 'ch', user_id: null, display_name: '', expires_at: Date.now() + 60_000, created_at: Date.now(),
    });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 2 } });
    const badComplete2 = await app.request('/api/auth/passkey/login/complete?native_callback=' + encodeURIComponent('javascript:alert(1)'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'c-bad-cb', response: { id: 'cred-1' } }),
    });
    expect(badComplete2.status).toBe(400);
    expect(badComplete.status).toBe(400);
  });

  it('AC1/AC4: makes passkey consumeChallenge atomic, guards counter CAS, and blocks API key/cookie minting under require_approval', async () => {
    const store = createHardeningDb();
    const app = buildApp(makeEnv(store.db));
    const now = Date.now();
    store.users.set('u1', {
      id: 'u1', username: 'u1', display_name: null, password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
    });
    store.passkeyCreds.set('cred-1', {
      id: 'cred-1', user_id: 'u1', public_key: Buffer.from('pk').toString('base64'), counter: 5,
      device_name: null, transports: null, created_at: now, last_used_at: null,
    });
    store.passkeyChallenges.set('ch-race', {
      id: 'ch-race', challenge: 'ch', user_id: null, display_name: '', expires_at: now + 60_000, created_at: now,
    });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 6 } });

    const [r1, r2] = await Promise.all([
      app.request('/api/auth/passkey/login/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: 'ch-race', response: { id: 'cred-1' } }),
      }),
      app.request('/api/auth/passkey/login/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: 'ch-race', response: { id: 'cred-1' } }),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);

    // Stale counter CAS conflict simulation
    store.passkeyChallenges.set('ch-cas', {
      id: 'ch-cas', challenge: 'ch', user_id: null, display_name: '', expires_at: now + 60_000, created_at: now,
    });
    verifyAuthenticationResponseMock.mockImplementationOnce(async () => {
      // Simulate another login incrementing counter while WebAuthn verification runs
      store.passkeyCreds.get('cred-1')!.counter = 99;
      return { verified: true, authenticationInfo: { newCounter: 7 } };
    });
    const casRes = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'ch-cas', response: { id: 'cred-1' } }),
    });
    expect(casRes.status).toBe(409);

    // require_approval=true on passkey register/complete must not mint apiKeys or session cookies
    store.settings.set('require_approval', 'true');
    store.passkeyChallenges.set('ch-reg', {
      id: 'ch-reg', challenge: 'reg-ch', user_id: null, display_name: 'Pending User', expires_at: now + 60_000, created_at: now,
    });
    verifyRegistrationResponseMock.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred-pending', publicKey: Buffer.from('pk2'), counter: 0 } },
    });
    const regRes = await app.request('/api/auth/passkey/register/complete?native_callback=' + encodeURIComponent('imcodes://auth'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'ch-reg', response: { id: 'new-cred-pending' } }),
    });
    expect(regRes.status).toBe(200);
    expect(await regRes.json()).toEqual({ ok: true, pending: true });
    expect(store.apiKeys.size).toBe(0);
    expect(store.authNonces.size).toBe(0);
    expect(regRes.headers.get('set-cookie') ?? '').not.toContain(COOKIE_SESSION);
  });

  it('AC2: closes bogus-Bearer CSRF bypass and blocks NODE_ROLE.CONTROLLED / daemon creds in requireTeamRole', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const now = Date.now();
    store.users.set('u1', {
      id: 'u1', username: 'alice', display_name: 'Alice', password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
    });
    const sessionJwt = signJwt({ sub: 'u1', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    // Bogus Authorization: Bearer header with valid session cookie MUST NOT bypass CSRF to reach cookie session
    const bypassAttempt = await app.request('/api/team', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}`,
        Authorization: 'Bearer totally-bogus-token',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Pwned Team' }),
    });
    expect(bypassAttempt.status).toBe(401);

    // Valid cookie + valid CSRF + valid Origin still succeeds
    const legitimateBrowser = await app.request('/api/team', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}; ${COOKIE_CSRF}=csrf123`,
        [HEADER_CSRF]: 'csrf123',
        Origin: 'https://app.im.codes',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Legit Team' }),
    });
    expect(legitimateBrowser.status).toBe(201);

    // requireTeamRole checks NODE_ROLE.CONTROLLED and refuseDaemonCredential
    store.teams.set('t1', { id: 't1', name: 'Team 1', owner_id: 'u1' });
    store.teamMembers.set('t1', new Map([['u1', { role: 'owner', joined_at: now }]]));
    store.servers.set('srv-ctrl', {
      id: 'srv-ctrl', user_id: 'u1', name: 'ctrl', token_hash: sha256Hex('ctrl-tok'), node_role: NODE_ROLE.CONTROLLED, revoked_at: null,
    });
    store.servers.set('srv-full', {
      id: 'srv-full', user_id: 'u1', name: 'full', token_hash: sha256Hex('full-tok'), node_role: NODE_ROLE.FULL, revoked_at: null,
    });

    const teamApp = new Hono<{ Bindings: Env }>();
    teamApp.get('/default/:id', requireTeamRole('member'), (c) => c.json({ ok: true }));
    teamApp.get('/user-only/:id', requireTeamRole('member', 'id', { refuseDaemonCredential: true }), (c) => c.json({ ok: true }));

    const ctrlRes = await teamApp.request('/default/t1', {
      headers: { Authorization: 'Bearer ctrl-tok', [SERVER_ID_HEADER]: 'srv-ctrl' },
    }, env);
    expect(ctrlRes.status).toBe(403);
    expect(await ctrlRes.json()).toMatchObject({ reason: NODE_ROLE_REFUSAL.CONTROLLED_NODE });

    const daemonRefused = await teamApp.request('/user-only/t1', {
      headers: { Authorization: 'Bearer full-tok', [SERVER_ID_HEADER]: 'srv-full' },
    }, env);
    expect(daemonRefused.status).toBe(403);
    expect(await daemonRefused.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });

    const memberAllowed = await teamApp.request('/user-only/t1', {
      headers: { Authorization: `Bearer ${sessionJwt}` },
    }, env);
    expect(memberAllowed.status).toBe(200);

    // Unsafe POST AND safe GET with genuine daemon token + session cookie MUST both fail closed on non-daemon routes (no cookie fallback)
    const daemonCookiePost = await app.request('/api/team', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}`,
        Authorization: 'Bearer full-tok',
        [SERVER_ID_HEADER]: 'srv-full',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Daemon CSRF Attempt' }),
    });
    expect(daemonCookiePost.status).toBe(403);

    const daemonCookieGet = await app.request('/api/auth/user/me', {
      method: 'GET',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}`,
        Authorization: 'Bearer full-tok',
        [SERVER_ID_HEADER]: 'srv-full',
      },
    });
    expect(daemonCookieGet.status).toBe(403);
    expect(await daemonCookieGet.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });

    // Restricted doc_collaborator Bearer JWT on non-doc route MUST fail closed with 403, never falling back to owner cookie
    const docCollabJwt = signJwt({ sub: 'u1', type: 'web', scope: 'doc_collaborator' }, env.JWT_SIGNING_KEY, 3600);
    const docCollabCookieGet = await app.request('/api/team', {
      method: 'GET',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}`,
        Authorization: `Bearer ${docCollabJwt}`,
      },
    });
    expect(docCollabCookieGet.status).toBe(403);

    // Cookie-only + incidental X-Server-Id without Authorization still succeeds cleanly
    const cookieIncidentalServer = await app.request('/api/auth/user/me', {
      method: 'GET',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(sessionJwt)}`,
        [SERVER_ID_HEADER]: 'srv-full',
      },
    });
    expect(cookieIncidentalServer.status).toBe(200);
  });

  it('AC3: enforces registration_enabled, require_approval, origin-bound single-use relay_token, and redacts relay_token logs', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'gh-tok' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 777001, login: 'newbie' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    // 1. registration_enabled = false blocks new OAuth user
    store.settings.set('registration_enabled', 'false');
    const state1 = signJwt({ nonce: 'n1', origin: 'https://app.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const disabledReg = await app.request(`https://app.im.codes/api/auth/github/callback?code=c1&state=${encodeURIComponent(state1)}`, {
      headers: { host: 'app.im.codes', cookie: 'oauth_state=n1' },
    });
    expect(disabledReg.status).toBe(403);
    expect(await disabledReg.json()).toEqual({ error: 'registration_disabled' });
    expect(store.users.size).toBe(0);

    // 2. require_approval = true creates pending user and returns 403 account_pending without session cookies
    store.settings.set('registration_enabled', 'true');
    store.settings.set('require_approval', 'true');
    const state2 = signJwt({ nonce: 'n2', origin: 'https://app.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const pendingRes = await app.request(`https://app.im.codes/api/auth/github/callback?code=c2&state=${encodeURIComponent(state2)}`, {
      headers: { host: 'app.im.codes', cookie: 'oauth_state=n2' },
    });
    expect(pendingRes.status).toBe(403);
    expect(await pendingRes.json()).toEqual({ error: 'account_pending' });
    expect(pendingRes.headers.get('set-cookie') ?? '').not.toContain(COOKIE_SESSION);
    const createdUser = [...store.users.values()][0]!;
    expect(createdUser.status).toBe('pending');

    // Activate user for cross-domain relay_token test
    createdUser.status = 'active';
    store.settings.set('require_approval', 'false');

    const logSpy = vi.spyOn(logger, 'info');
    const relayState = signJwt({ nonce: 'n3', origin: 'https://hk.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const relayIssueRes = await app.request(`https://app.im.codes/api/auth/github/callback?code=c3&state=${encodeURIComponent(relayState)}`, {
      headers: { host: 'app.im.codes' },
    });
    expect(relayIssueRes.status).toBe(302);
    const relayLoc = new URL(relayIssueRes.headers.get('location')!);
    expect(relayLoc.origin).toBe('https://hk.im.codes');
    const relayToken = relayLoc.searchParams.get('relay_token')!;
    expect(relayToken).toBeTruthy();

    // Ensure plaintext relay_token was never logged
    const loggedStrings = logSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(loggedStrings).not.toContain(relayToken);
    expect(loggedStrings).not.toContain('relay_token=');

    // Wrong origin cannot redeem relay_token (and does not burn it)
    const wrongOrigin = await app.request(`https://app.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'app.im.codes' },
    });
    expect(wrongOrigin.status).toBe(401);
    expect(await wrongOrigin.json()).toEqual({ error: 'invalid_relay_origin' });

    // Matching origin redeems once
    const goodRelay = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(goodRelay.status).toBe(302);
    expect(goodRelay.headers.get('set-cookie') ?? '').toContain(COOKIE_SESSION);

    // Same-pod replay fails
    const replay1 = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(replay1.status).toBe(401);

    // Cross-replica replay fails even when in-memory JTI cache is empty
    rateLimiter.reset();
    const replay2 = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(replay2.status).toBe(401);
  });

  it('AC4: secures /register, /password/change lockout & revocation, atomic /refresh, atomic /bind/confirm, and /relay/verify DB replay', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    // 1. /api/auth/register never caches raw keys under 'anon' across callers
    const regA = await app.request('/api/auth/register', { method: 'POST', headers: { 'Idempotency-Key': 'shared-k' } });
    const regB = await app.request('/api/auth/register', { method: 'POST', headers: { 'Idempotency-Key': 'shared-k' } });
    expect(regA.status).toBe(201);
    expect(regB.status).toBe(201);
    const bodyA = await regA.json() as { userId: string; apiKey: string };
    const bodyB = await regB.json() as { userId: string; apiKey: string };
    expect(bodyA.userId).not.toBe(bodyB.userId);
    expect(bodyA.apiKey).not.toBe(bodyB.apiKey);
    expect(store.idempotencyRecords.size).toBe(0);

    // require_approval=true on /api/auth/register issues no active apiKey
    store.settings.set('require_approval', 'true');
    const pendingReg = await app.request('/api/auth/register', { method: 'POST' });
    expect(pendingReg.status).toBe(201);
    const pendingJson = await pendingReg.json() as { pending?: boolean; apiKey?: string; userId: string };
    expect(pendingJson.pending).toBe(true);
    expect(pendingJson.apiKey).toBeUndefined();
    expect(store.users.get(pendingJson.userId)?.status).toBe('pending');
    store.settings.set('require_approval', 'false');

    // 2. /api/auth/password/change lockout & session/refresh revocation
    const pwHash = await hashPassword('OldPass123!');
    store.users.set('u-pw', {
      id: 'u-pw', username: 'pwuser', display_name: 'PW', password_hash: pwHash, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });
    const oldAccessJwt = signJwt({ sub: 'u-pw', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const oldRefreshRaw = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-pw-1', 'u-pw', sha256Hex(oldRefreshRaw), 'fam-pw', Date.now() + 60_000, Date.now()],
    );

    // 5 wrong oldPassword attempts lock out the user
    for (let i = 0; i < 5; i++) {
      const badPw = await app.request('/api/auth/password/change', {
        method: 'POST',
        headers: { Authorization: `Bearer ${oldAccessJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: 'WrongPassword1!', newPassword: 'NewPass123!' }),
      });
      expect(badPw.status).toBe(401);
    }
    const lockedPw = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldAccessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'OldPass123!', newPassword: 'NewPass123!' }),
    });
    expect(lockedPw.status).toBe(429);

    // Reset lockout via direct store clear for a fresh user to verify revocation + cookie rotation
    store.users.set('u-pw2', {
      id: 'u-pw2', username: 'pwuser2', display_name: 'PW2', password_hash: pwHash, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });
    const staleBearer = signJwt({ sub: 'u-pw2', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const cookieJwt = signJwt({ sub: 'u-pw2', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const rtToRevoke = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-pw-2', 'u-pw2', sha256Hex(rtToRevoke), 'fam-pw2', Date.now() + 60_000, Date.now()],
    );
    const changeOk = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(cookieJwt)}; ${COOKIE_CSRF}=csrfpw`,
        [HEADER_CSRF]: 'csrfpw',
        Origin: 'https://app.im.codes',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oldPassword: 'OldPass123!', newPassword: 'NewPass456!' }),
    });
    expect(changeOk.status).toBe(200);
    // Prior Bearer JWT is immediately rejected
    const staleCheck = await app.request('/api/auth/user/me', {
      headers: { Authorization: `Bearer ${staleBearer}` },
    });
    expect(staleCheck.status).toBe(401);
    // Prior refresh token is revoked
    const revokedRefreshRes = await app.request('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rtToRevoke }),
    });
    expect(revokedRefreshRes.status).toBe(401);
    // Rotated session cookie works immediately
    const rotatedCookies = changeOk.headers.getSetCookie?.() ?? [changeOk.headers.get('set-cookie') ?? ''];
    const newSessionCookie = rotatedCookies.join('; ').match(/rcc_session=([^;]+)/)?.[1];
    expect(newSessionCookie).toBeTruthy();
    const rotatedMe = await app.request('/api/auth/user/me', {
      headers: { Cookie: `${COOKIE_SESSION}=${newSessionCookie}` },
    });
    expect(rotatedMe.status).toBe(200);

    // 3. Atomic refresh race
    const raceRt = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-race', 'u-pw2', sha256Hex(raceRt), 'fam-race', Date.now() + 60_000, Date.now()],
    );
    const [rf1, rf2] = await Promise.all([
      app.request('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: raceRt }) }),
      app.request('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: raceRt }) }),
    ]);
    expect([rf1.status, rf2.status].sort()).toEqual([200, 401]);

    // 4. Atomic bind/confirm + active user check + rate limit
    await store.db.execute(
      'INSERT INTO pending_binds (code, user_id, server_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['CODE1234', 'u-pw2', 'srv-race', Date.now() + 60_000, Date.now()],
    );
    const [b1, b2] = await Promise.all([
      app.request('/api/bind/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'CODE1234' }) }),
      app.request('/api/bind/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'CODE1234' }) }),
    ]);
    expect([b1.status, b2.status].sort()).toEqual([200, 404]);

    await store.db.execute(
      'INSERT INTO pending_binds (code, user_id, server_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['PEND1234', pendingJson.userId, 'srv-pending', Date.now() + 60_000, Date.now()],
    );
    const pendingBindRes = await app.request('/api/bind/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'PEND1234' }),
    });
    expect(pendingBindRes.status).toBe(404);

    // Rate limit on /api/auth/register & /api/bind/confirm
    rateLimiter.reset();
    for (let i = 0; i < 20; i++) {
      const r = await app.request('/api/auth/register', { method: 'POST' });
      expect(r.status).toBe(201);
    }
    const regRateLimited = await app.request('/api/auth/register', { method: 'POST' });
    expect(regRateLimited.status).toBe(429);

    for (let i = 0; i < 20; i++) {
      await app.request('/api/bind/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'MISSING' }) });
    }
    const bindRateLimited = await app.request('/api/bind/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'MISSING' }),
    });
    expect(bindRateLimited.status).toBe(429);

    // 5. DB-backed doc-relay ticket replay protection (even across pods)
    const relayTicket = signJwt({
      type: 'doc-auth-relay-ticket',
      iss: 'https://app.im.codes',
      aud: 'https://self.example.com',
      jti: 'doc-jti-db-1',
      provider: 'github',
      externalId: 'ext-1',
      username: 'extuser',
      displayName: 'Ext',
    }, env.JWT_SIGNING_KEY, 120);
    const v1 = await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: relayTicket, expectedAudience: 'https://self.example.com' }),
    });
    expect(v1.status).toBe(200);
    const storedTicket = [...store.passkeyChallenges.values()].find((r) => r.display_name === 'doc-relay-ticket');
    expect(storedTicket).toBeTruthy();
    // Simulate a second pod (different Hono app instance sharing DB, no shared memory)
    const appPod2 = buildApp(env);
    const replayPod2 = await appPod2.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: relayTicket, expectedAudience: 'https://self.example.com' }),
    });
    expect(replayPod2.status).toBe(401);
  });

  it('AC5: blocks team admin from adding admin via POST /api/team/:id/member and consumes invites atomically', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const now = Date.now();

    for (const id of ['owner-1', 'admin-1', 'target-1', 'joiner-a', 'joiner-b']) {
      store.users.set(id, {
        id, username: id, display_name: id, password_hash: null, password_must_change: null,
        is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
      });
    }
    store.teams.set('team-sec', { id: 'team-sec', name: 'Sec', owner_id: 'owner-1' });
    store.teamMembers.set('team-sec', new Map([
      ['owner-1', { role: 'owner', joined_at: now }],
      ['admin-1', { role: 'admin', joined_at: now }],
    ]));

    const adminJwt = signJwt({ sub: 'admin-1', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const ownerJwt = signJwt({ sub: 'owner-1', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    // Admin cannot add role=admin
    const escalated = await app.request('/api/team/team-sec/member', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'target-1', role: 'admin' }),
    });
    expect(escalated.status).toBe(403);
    expect(await escalated.json()).toEqual({ error: 'forbidden', reason: 'owner_required_for_admin_role' });

    // Admin can still add role=member
    const memberOk = await app.request('/api/team/team-sec/member', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'target-1', role: 'member' }),
    });
    expect(memberOk.status).toBe(201);

    // Owner can add role=admin
    const ownerOk = await app.request('/api/team/team-sec/member', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'joiner-a', role: 'admin' }),
    });
    expect(ownerOk.status).toBe(201);

    // Atomic invite redemption
    store.teamInvites.set('inv-1', {
      id: 'inv-1', team_id: 'team-sec', token: 'tok-race-1', role: 'member', expires_at: now + 60_000, used_at: null,
    });
    const j1Jwt = signJwt({ sub: 'joiner-a', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const j2Jwt = signJwt({ sub: 'joiner-b', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const [join1, join2] = await Promise.all([
      app.request('/api/team/join/tok-race-1', { method: 'POST', headers: { Authorization: `Bearer ${j1Jwt}` } }),
      app.request('/api/team/join/tok-race-1', { method: 'POST', headers: { Authorization: `Bearer ${j2Jwt}` } }),
    ]);
    expect([join1.status, join2.status].sort()).toEqual([200, 400]);
  });

  it('P0-1a: rejects hostless/non-hierarchical imcodes: callbacks while preserving hierarchical mobile callbacks', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    for (const bad of ['imcodes:foo', 'imcodes:///foo', 'imcodes://', 'imcodes://user@auth', '']) {
      const nativeRes = await app.request(`/api/auth/passkey/native?callback=${encodeURIComponent(bad)}`);
      expect(nativeRes.status, `GET /native should reject ${bad}`).toBe(400);

      const regRes = await app.request(`/api/auth/passkey/register/complete?native_callback=${encodeURIComponent(bad)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: 'any', response: {} }),
      });
      expect(regRes.status, `POST /register/complete should reject ${bad}`).toBe(400);

      const loginRes = await app.request(`/api/auth/passkey/login/complete?native_callback=${encodeURIComponent(bad)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: 'any', response: {} }),
      });
      expect(loginRes.status, `POST /login/complete should reject ${bad}`).toBe(400);
    }

    const okNative = await app.request(`/api/auth/passkey/native?callback=${encodeURIComponent('imcodes://auth/callback?a=1')}`);
    expect(okNative.status).toBe(200);
  });

  it('P0-1b: validates native_callback before consuming challenges or writing users, credentials, counters, or passwords', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const now = Date.now();

    store.users.set('u-setup', {
      id: 'u-setup', username: null, display_name: 'SetupUser', password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
    });
    store.passkeyCreds.set('cred-setup', {
      id: 'cred-setup', user_id: 'u-setup', public_key: Buffer.from('pk').toString('base64'), counter: 7,
      device_name: null, transports: null, created_at: now, last_used_at: null,
    });
    store.passkeyChallenges.set('ch-reg-bad', {
      id: 'ch-reg-bad', challenge: 'reg-ch', user_id: null, display_name: 'NewUser', expires_at: now + 60_000, created_at: now,
    });
    store.passkeyChallenges.set('ch-login-bad', {
      id: 'ch-login-bad', challenge: 'login-ch', user_id: null, display_name: '', expires_at: now + 60_000, created_at: now,
    });
    store.passkeyChallenges.set('ch-setup-bad', {
      id: 'ch-setup-bad', challenge: 'setup-ch', user_id: 'u-setup', display_name: '', expires_at: now + 60_000, created_at: now,
    });
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'should-not-write', publicKey: Buffer.from('pk2'), counter: 0 } },
    });
    verifyAuthenticationResponseMock.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 8 },
    });

    const badCb = encodeURIComponent('imcodes:///evil');
    const regFail = await app.request(`/api/auth/passkey/register/complete?native_callback=${badCb}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'ch-reg-bad', response: { id: 'should-not-write' } }),
    });
    expect(regFail.status).toBe(400);
    expect(store.passkeyChallenges.has('ch-reg-bad')).toBe(true);
    expect(store.passkeyCreds.has('should-not-write')).toBe(false);
    expect(store.users.size).toBe(1);

    const loginFail = await app.request(`/api/auth/passkey/login/complete?native_callback=${badCb}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'ch-login-bad', response: { id: 'cred-setup' } }),
    });
    expect(loginFail.status).toBe(400);
    expect(store.passkeyChallenges.has('ch-login-bad')).toBe(true);
    expect(store.passkeyCreds.get('cred-setup')?.counter).toBe(7);

    const setupJwt = signJwt({ sub: 'u-setup', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const setupFail = await app.request(`/api/auth/passkey/password/setup?native_callback=${badCb}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${setupJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'validuser',
        newPassword: 'ValidPassword1!',
        challengeId: 'ch-setup-bad',
        response: { id: 'cred-setup' },
      }),
    });
    expect(setupFail.status).toBe(400);
    expect(store.passkeyChallenges.has('ch-setup-bad')).toBe(true);
    expect(store.passkeyCreds.get('cred-setup')?.counter).toBe(7);
    expect(store.users.get('u-setup')?.username).toBeNull();
    expect(store.users.get('u-setup')?.password_hash).toBeNull();
  });

  it('P0-2a: consecutive same-second password changes invalidate prior replacement session cookies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_100);

    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const hash1 = await hashPassword('PassOne123!');
    store.users.set('u-same-sec', {
      id: 'u-same-sec', username: 'samesec', display_name: 'SameSec', password_hash: hash1, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });

    const initialJwt = signJwt({ sub: 'u-same-sec', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const chg1 = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(initialJwt)}; ${COOKIE_CSRF}=csrf1`,
        [HEADER_CSRF]: 'csrf1',
        Origin: 'https://app.im.codes',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oldPassword: 'PassOne123!', newPassword: 'PassTwo123!' }),
    });
    expect(chg1.status).toBe(200);
    const cookie1 = (chg1.headers.getSetCookie?.() ?? [chg1.headers.get('set-cookie') ?? '']).join('; ').match(/rcc_session=([^;]+)/)?.[1];
    expect(cookie1).toBeTruthy();

    // Advance only 50ms within the exact same wall-clock second (still 1_700_000_000s)
    vi.setSystemTime(1_700_000_000_150);
    const chg2 = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${cookie1}; ${COOKIE_CSRF}=csrf2`,
        [HEADER_CSRF]: 'csrf2',
        Origin: 'https://app.im.codes',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oldPassword: 'PassTwo123!', newPassword: 'PassThree123!' }),
    });
    expect(chg2.status).toBe(200);
    const cookie2 = (chg2.headers.getSetCookie?.() ?? [chg2.headers.get('set-cookie') ?? '']).join('; ').match(/rcc_session=([^;]+)/)?.[1];
    expect(cookie2).toBeTruthy();

    // Cookie from password change #1 MUST be rejected after same-second password change #2
    const me1 = await app.request('/api/auth/user/me', { headers: { Cookie: `${COOKIE_SESSION}=${cookie1}` } });
    expect(me1.status).toBe(401);

    // Cookie from password change #2 MUST work immediately
    const me2 = await app.request('/api/auth/user/me', { headers: { Cookie: `${COOKIE_SESSION}=${cookie2}` } });
    expect(me2.status).toBe(200);
  });

  it('P0-2b: concurrent /refresh interleaved with /password/change cannot mint next-gen tokens after password change', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const hash1 = await hashPassword('InitialPass1!');
    store.users.set('u-interleave', {
      id: 'u-interleave', username: 'interleave', display_name: 'IL', password_hash: hash1, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });
    const rtRaw = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-il-1', 'u-interleave', sha256Hex(rtRaw), 'fam-il', Date.now() + 60_000, Date.now()],
    );
    const jwt = signJwt({ sub: 'u-interleave', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    let interleaved = false;
    store.setBeforeSqlHook(async (s) => {
      // Runs before /refresh acquires the transaction lock, simulating /password/change winning the race
      // right after /refresh's initial refresh_tokens lookup.
      if (!interleaved && s.includes('select user_id from refresh_tokens where token_hash')) {
        interleaved = true;
        store.setBeforeSqlHook(null);
        const pwRes = await app.request('/api/auth/password/change', {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword: 'InitialPass1!', newPassword: 'RotatedPass2!' }),
        });
        expect(pwRes.status).toBe(200);
      }
    });

    const refreshRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rtRaw }),
    });
    expect(refreshRes.status).toBe(401);
    expect(store.refreshTokens.size).toBe(1);
    expect(store.refreshTokens.get('rt-il-1')?.used_at).not.toBeNull();
  });

  it('P0-2c: in-flight /password/login verifying an old password aborts with 401 when password changes between verify and FOR UPDATE lock', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const oldHash = await hashPassword('OldLoginPass1!');
    const newHash = await hashPassword('BrandNewPass2!');
    store.users.set('u-login-race', {
      id: 'u-login-race', username: 'loginrace', display_name: 'LR', password_hash: oldHash, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });

    let sawUsernameRead = false;
    let verifyThenLockHookHit = false;
    store.setBeforeSqlHook(async (s) => {
      if (s.includes('from users where username = $1')) {
        sawUsernameRead = true;
        return;
      }
      // Fires AFTER getUserByUsername read oldHash and verifyPassword passed, right before FOR UPDATE returns lockedUser.
      if (sawUsernameRead && !verifyThenLockHookHit && s.includes('from users where id = $1 for update')) {
        verifyThenLockHookHit = true;
        store.setBeforeSqlHook(null);
        const committed = store.users.get('u-login-race')!;
        committed.password_hash = newHash;
        committed.password_must_change = false;
        committed.sessions_valid_after = Date.now() + 1;
      }
    });

    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'loginrace', password: 'OldLoginPass1!', native: true }),
    });
    expect(sawUsernameRead).toBe(true);
    expect(verifyThenLockHookHit).toBe(true);
    expect(loginRes.status).toBe(401);
    expect(store.refreshTokens.size).toBe(0);
    expect(store.apiKeys.size).toBe(0);
  });

  it('P0-2d: rotated cookie from password change does not survive immediate admin disable and re-enable, while new login succeeds', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-20T12:00:00.200Z').getTime();
    vi.setSystemTime(t0);

    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const pwHash = await hashPassword('StartPass1!');
    store.users.set('u-admin', {
      id: 'u-admin', username: 'admin', display_name: 'Admin', password_hash: null, password_must_change: false,
      is_admin: true, status: 'active', sessions_valid_after: 0, created_at: t0,
    });
    store.users.set('u-victim', {
      id: 'u-victim', username: 'victim', display_name: 'Victim', password_hash: pwHash, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: t0,
    });
    const adminJwt = signJwt({ sub: 'u-admin', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const initialJwt = signJwt({ sub: 'u-victim', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    // 1. User changes password and receives rotated rcc_session cookie (iat = sec + 1)
    const chRes = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(initialJwt)}; ${COOKIE_CSRF}=csrf1`,
        [HEADER_CSRF]: 'csrf1',
        Origin: 'https://app.im.codes',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oldPassword: 'StartPass1!', newPassword: 'RotatedPass2!' }),
    });
    expect(chRes.status).toBe(200);
    const rotatedMatch = (chRes.headers.get('set-cookie') ?? '').match(/rcc_session=([^;]+)/);
    expect(rotatedMatch).toBeTruthy();
    const rotatedCookie = decodeURIComponent(rotatedMatch![1]);
    expect((await app.request('/api/auth/user/me', { headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(rotatedCookie)}` } })).status).toBe(200);

    // 2. Same second (+200ms): admin disables user, then re-enables user (+300ms)
    vi.setSystemTime(t0 + 200);
    const disRes = await app.request('/api/admin/users/u-victim/disable', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(adminJwt)}; ${COOKIE_CSRF}=csrfA`,
        [HEADER_CSRF]: 'csrfA',
        Origin: 'https://app.im.codes',
      },
    });
    expect(disRes.status).toBe(200);

    vi.setSystemTime(t0 + 300);
    const appRes = await app.request('/api/admin/users/u-victim/approve', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(adminJwt)}; ${COOKIE_CSRF}=csrfA`,
        [HEADER_CSRF]: 'csrfA',
        Origin: 'https://app.im.codes',
      },
    });
    expect(appRes.status).toBe(200);

    // 3. Rotated cookie issued before disable MUST remain permanently revoked even after approve
    const staleAfterApprove = await app.request('/api/auth/user/me', {
      headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(rotatedCookie)}` },
    });
    expect(staleAfterApprove.status).toBe(401);

    // 4. Fresh login after approve succeeds immediately and issues a valid session
    vi.setSystemTime(t0 + 400);
    const freshLogin = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'victim', password: 'RotatedPass2!' }),
    });
    expect(freshLogin.status).toBe(200);
    const freshMatch = (freshLogin.headers.get('set-cookie') ?? '').match(/rcc_session=([^;]+)/);
    expect(freshMatch).toBeTruthy();
    const freshCookie = decodeURIComponent(freshMatch![1]);
    const freshMe = await app.request('/api/auth/user/me', {
      headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(freshCookie)}` },
    });
    expect(freshMe.status).toBe(200);
  });

  it('P0-2e: /api/global-tasks/ws-ticket aligns epoch with sessions_valid_after, preserves 15s TTL, rejects old tickets after password change or disable/approve, and immediately accepts new-session tickets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-11-20T12:00:00.200Z').getTime();
    vi.setSystemTime(t0);

    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const pwHash = await hashPassword('StartPass1!');
    store.users.set('u-admin-ws', {
      id: 'u-admin-ws', username: 'adminws', display_name: 'AdminWS', password_hash: null, password_must_change: false,
      is_admin: true, status: 'active', sessions_valid_after: 0, created_at: t0,
    });
    store.users.set('u-ws', {
      id: 'u-ws', username: 'wsuser', display_name: 'WSUser', password_hash: pwHash, password_must_change: false,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: t0,
    });
    const adminJwt = signJwt({ sub: 'u-admin-ws', type: 'web' }, env.JWT_SIGNING_KEY, 3600);
    const initialJwt = signJwt({ sub: 'u-ws', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    const app = buildApp(env);
    const httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as unknown as import('node:http').Server;
    setupWebSocketUpgrade(httpServer, env);
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    }

    const connectWsStatus = async (ticket: string): Promise<'open' | number> => {
      const addr = httpServer.address() as { port: number };
      return new Promise<'open' | number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticket)}`, {
          origin: 'https://app.im.codes',
        });
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('unexpected-response', (_req, res) => {
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
        ws.on('error', () => {});
      });
    };

    try {
      const addr = httpServer.address() as { port: number };
      const baseHttp = `http://127.0.0.1:${addr.port}`;

      // 1. Issue ticket before password change
      const oldTicketRes = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(initialJwt)}; ${COOKIE_CSRF}=csrf1`,
          [HEADER_CSRF]: 'csrf1',
          Origin: 'https://app.im.codes',
        },
      });
      expect(oldTicketRes.status).toBe(200);
      const { ticket: oldTicket } = await oldTicketRes.json() as { ticket: string };

      // 2. Password change in same second -> rotated session cookie
      vi.setSystemTime(t0 + 50);
      const chRes = await fetch(`${baseHttp}/api/auth/password/change`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(initialJwt)}; ${COOKIE_CSRF}=csrf1`,
          [HEADER_CSRF]: 'csrf1',
          Origin: 'https://app.im.codes',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ oldPassword: 'StartPass1!', newPassword: 'RotatedPass2!' }),
      });
      expect(chRes.status).toBe(200);
      const rotatedCookie = decodeURIComponent((chRes.headers.get('set-cookie') ?? '').match(/rcc_session=([^;]+)/)![1]);

      // Old pre-change WS ticket MUST fail with 401
      expect(await connectWsStatus(oldTicket)).toBe(401);

      // 3. Same second (+100ms): rotated cookie mints a fresh WS ticket whose TTL is 15s and WS upgrade succeeds immediately
      vi.setSystemTime(t0 + 100);
      const rotatedTicketRes = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(rotatedCookie)}; ${COOKIE_CSRF}=csrf1`,
          [HEADER_CSRF]: 'csrf1',
          Origin: 'https://app.im.codes',
        },
      });
      expect(rotatedTicketRes.status).toBe(200);
      const { ticket: rotatedTicket } = await rotatedTicketRes.json() as { ticket: string };
      const rotatedTicketPayload = JSON.parse(Buffer.from(rotatedTicket.split('.')[1], 'base64url').toString('utf8')) as { exp: number };
      expect(rotatedTicketPayload.exp - Math.floor((t0 + 100) / 1000)).toBe(15);
      expect(await connectWsStatus(rotatedTicket)).toBe('open');

      // 4. Issue another ticket, then admin disables & re-enables in the same second: pre-disable ticket MUST fail (401)
      vi.setSystemTime(t0 + 150);
      const preDisableTicketRes = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(rotatedCookie)}; ${COOKIE_CSRF}=csrf1`,
          [HEADER_CSRF]: 'csrf1',
          Origin: 'https://app.im.codes',
        },
      });
      expect(preDisableTicketRes.status).toBe(200);
      const { ticket: preDisableTicket } = await preDisableTicketRes.json() as { ticket: string };

      vi.setSystemTime(t0 + 200);
      expect((await fetch(`${baseHttp}/api/admin/users/u-ws/disable`, {
        method: 'POST',
        headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(adminJwt)}; ${COOKIE_CSRF}=csrfA`, [HEADER_CSRF]: 'csrfA', Origin: 'https://app.im.codes' },
      })).status).toBe(200);
      vi.setSystemTime(t0 + 250);
      expect((await fetch(`${baseHttp}/api/admin/users/u-ws/approve`, {
        method: 'POST',
        headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(adminJwt)}; ${COOKIE_CSRF}=csrfA`, [HEADER_CSRF]: 'csrfA', Origin: 'https://app.im.codes' },
      })).status).toBe(200);

      expect(await connectWsStatus(preDisableTicket)).toBe(401);

      // 5. Fresh login in the same second -> mints valid WS ticket + connects WS immediately; expires after 15s TTL
      vi.setSystemTime(t0 + 300);
      const freshLoginRes = await fetch(`${baseHttp}/api/auth/password/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'wsuser', password: 'RotatedPass2!' }),
      });
      expect(freshLoginRes.status).toBe(200);
      const freshCookie = decodeURIComponent((freshLoginRes.headers.get('set-cookie') ?? '').match(/rcc_session=([^;]+)/)![1]);

      const freshTicketRes = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(freshCookie)}; ${COOKIE_CSRF}=csrfF`,
          [HEADER_CSRF]: 'csrfF',
          Origin: 'https://app.im.codes',
        },
      });
      expect(freshTicketRes.status).toBe(200);
      const { ticket: freshTicket } = await freshTicketRes.json() as { ticket: string };
      expect(await connectWsStatus(freshTicket)).toBe('open');

      const expiredTicketRes = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_SESSION}=${encodeURIComponent(freshCookie)}; ${COOKIE_CSRF}=csrfF`,
          [HEADER_CSRF]: 'csrfF',
          Origin: 'https://app.im.codes',
        },
      });
      const { ticket: ttlTicket } = await expiredTicketRes.json() as { ticket: string };
      vi.setSystemTime(t0 + 300 + 16_000);
      expect(await connectWsStatus(ttlTicket)).toBe(401);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('P0-3a: /refresh returns 429 under user lockout without consuming the refresh token, then succeeds after lockout clears', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    store.users.set('u-lock-rf', {
      id: 'u-lock-rf', username: 'lockrf', display_name: 'LRF', password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: Date.now(),
    });
    const rtRaw = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-lock-1', 'u-lock-rf', sha256Hex(rtRaw), 'fam-lock', Date.now() + 60_000, Date.now()],
    );
    store.lockouts.set('user:u-lock-rf', {
      fail_count: 5,
      first_fail_at: new Date(),
      locked_until: new Date(Date.now() + 60_000),
    });

    const lockedRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rtRaw }),
    });
    expect(lockedRes.status).toBe(429);
    expect(store.refreshTokens.get('rt-lock-1')?.used_at).toBeNull();

    // Clear lockout and retry with the same refresh token
    store.lockouts.delete('user:u-lock-rf');
    const okRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rtRaw }),
    });
    expect(okRes.status).toBe(200);
    expect(store.refreshTokens.get('rt-lock-1')?.used_at).not.toBeNull();
  });

  it('P0-3b: downstream DB write failures roll back single-use consumption across /refresh, /bind/confirm, both team join routes, and OAuth relay', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const now = Date.now();

    store.users.set('u-rb', {
      id: 'u-rb', username: 'rbuser', display_name: 'RB', password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
    });
    store.teams.set('team-rb', { id: 'team-rb', name: 'RB Team', owner_id: 'u-rb' });
    const jwt = signJwt({ sub: 'u-rb', type: 'web' }, env.JWT_SIGNING_KEY, 3600);

    // 1. /refresh rollback on INSERT INTO refresh_tokens failure
    const rtRaw = randomHex(32);
    await store.db.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['rt-rb-1', 'u-rb', sha256Hex(rtRaw), 'fam-rb', now + 60_000, now],
    );
    store.setFailNextSql('insert into refresh_tokens');
    const rfFail = await app.request('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rtRaw }),
    });
    expect(rfFail.status).toBe(500);
    expect(store.refreshTokens.get('rt-rb-1')?.used_at).toBeNull();
    const rfRetry = await app.request('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rtRaw }),
    });
    expect(rfRetry.status).toBe(200);

    // 2. /bind/confirm rollback on createServer (INSERT INTO servers) failure
    await store.db.execute(
      'INSERT INTO pending_binds (code, user_id, server_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['RB-CODE1', 'u-rb', 'srv-rb', now + 60_000, now],
    );
    store.setFailNextSql('insert into servers');
    const bindFail = await app.request('/api/bind/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'RB-CODE1' }),
    });
    expect(bindFail.status).toBe(500);
    expect(store.pendingBinds.has('RB-CODE1')).toBe(true);
    const bindRetry = await app.request('/api/bind/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'RB-CODE1' }),
    });
    expect(bindRetry.status).toBe(200);

    // 3. POST /api/team/join/:token rollback on INSERT INTO team_members failure
    store.teamInvites.set('inv-rb-1', {
      id: 'inv-rb-1', team_id: 'team-rb', token: 'tok-rb-1', role: 'member', expires_at: now + 60_000, used_at: null,
    });
    store.setFailNextSql('insert into team_members');
    const joinFail1 = await app.request('/api/team/join/tok-rb-1', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(joinFail1.status).toBe(500);
    expect(store.teamInvites.get('inv-rb-1')?.used_at).toBeNull();
    const joinRetry1 = await app.request('/api/team/join/tok-rb-1', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(joinRetry1.status).toBe(200);

    // 4. POST /api/team/:id/join rollback on INSERT INTO team_members failure
    store.teamInvites.set('inv-rb-2', {
      id: 'inv-rb-2', team_id: 'team-rb', token: 'tok-rb-2', role: 'member', expires_at: now + 60_000, used_at: null,
    });
    store.setFailNextSql('insert into team_members');
    const joinFail2 = await app.request('/api/team/team-rb/join', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-rb-2' }),
    });
    expect(joinFail2.status).toBe(500);
    expect(store.teamInvites.get('inv-rb-2')?.used_at).toBeNull();
    const joinRetry2 = await app.request('/api/team/team-rb/join', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-rb-2' }),
    });
    expect(joinRetry2.status).toBe(200);

    // 5. OAuth relay callback rollback on INSERT INTO refresh_tokens failure + no JTI burn
    const relayJti = 'oauth-rb-jti-1';
    await store.db.execute(
      'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [`oauth-relay:${relayJti}`, '', 'u-rb', 'oauth-relay', now + 120_000, now],
    );
    const relayToken = signJwt(
      { sub: 'u-rb', type: 'auth-relay', origin: 'https://hk.im.codes', jti: relayJti },
      env.JWT_SIGNING_KEY,
      120,
    );
    store.setFailNextSql('insert into refresh_tokens');
    const oauthFail = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(oauthFail.status).toBe(500);
    expect(store.authNonces.has(`oauth-relay:${relayJti}`)).toBe(true);
    const oauthRetry = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(oauthRetry.status).toBe(302);
  });

  it('P0-4a: strictly isolates passkey_challenges and auth_nonces by purpose so cross-flow reads/cleanups never interfere', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const now = Date.now();

    // Verify a doc relay ticket first
    const docTicket = signJwt({
      type: 'doc-auth-relay-ticket',
      iss: 'https://app.im.codes',
      aud: 'https://self.example.com',
      jti: 'doc-purpose-jti',
      provider: 'github',
      externalId: 'ext-p',
      username: 'puser',
      displayName: 'P',
    }, env.JWT_SIGNING_KEY, 120);
    const vRes = await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: docTicket, expectedAudience: 'https://self.example.com' }),
    });
    expect(vRes.status).toBe(200);
    const docRow = [...store.passkeyChallenges.values()].find((r) => r.id.startsWith('doc-relay-ticket:'))!;
    expect(docRow).toBeTruthy();

    // Passkey registration with displayName === 'doc-relay-ticket' succeeds normally (type isolated by id prefix, not displayName)
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-doc-name',
          publicKey: Buffer.from('pk-doc-name'),
          counter: 0,
        },
      },
    });
    const beginSameName = await app.request('/api/auth/passkey/register/begin', {
      method: 'POST',
      headers: { host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'doc-relay-ticket' }),
    });
    expect(beginSameName.status).toBe(200);
    const { challengeId: sameNameChallengeId } = await beginSameName.json() as { challengeId: string };
    expect(sameNameChallengeId.startsWith('doc-relay-ticket:')).toBe(false);
    const completeSameName = await app.request('/api/auth/passkey/register/complete', {
      method: 'POST',
      headers: { host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: sameNameChallengeId, response: { response: {} }, displayName: 'doc-relay-ticket' }),
    });
    expect(completeSameName.status).toBe(200);

    // Passkey login/complete attempting to consume docRow.id must NOT consume it
    const crossConsume = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: docRow.id, response: { id: 'cred-missing' } }),
    });
    expect(crossConsume.status).toBe(400);
    expect(store.passkeyChallenges.has(docRow.id)).toBe(true);

    // Even if docRow were expired, passkey register/begin cleanup must NOT delete doc-relay-ticket rows,
    // and /relay/verify cleanup must NOT delete expired passkey challenges created by passkey flows.
    docRow.expires_at = now - 10;
    store.passkeyChallenges.set('pk-expired', {
      id: 'pk-expired', challenge: 'pk', user_id: null, display_name: '', expires_at: now - 10, created_at: now - 100,
    });
    const docTicket2 = signJwt({
      type: 'doc-auth-relay-ticket',
      iss: 'https://app.im.codes',
      aud: 'https://self.example.com',
      jti: 'doc-purpose-jti-2',
      provider: 'github',
      externalId: 'ext-p',
      username: 'puser',
      displayName: 'P',
    }, env.JWT_SIGNING_KEY, 120);
    await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: docTicket2, expectedAudience: 'https://self.example.com' }),
    });
    expect(store.passkeyChallenges.has('pk-expired')).toBe(true);

    // Re-insert expired doc-relay-ticket row and confirm passkey begin cleanup leaves it alone
    store.passkeyChallenges.set('doc-relay-ticket:exp-probe', {
      id: 'doc-relay-ticket:exp-probe', challenge: 'x', user_id: null, display_name: 'doc-relay-ticket', expires_at: now - 10, created_at: now - 100,
    });
    await app.request('/api/auth/passkey/login/begin', { method: 'POST', headers: { host: 'localhost' } });
    expect(store.passkeyChallenges.has('doc-relay-ticket:exp-probe')).toBe(true);
    expect(store.passkeyChallenges.has('pk-expired')).toBe(false);

    // auth_nonces purpose isolation: /token-exchange cannot consume or delete an oauth-relay nonce
    store.users.set('u-iso', {
      id: 'u-iso', username: 'iso', display_name: 'ISO', password_hash: null, password_must_change: null,
      is_admin: false, status: 'active', sessions_valid_after: 0, created_at: now,
    });
    await store.db.execute(
      'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['oauth-relay:cross-1', '', 'u-iso', 'oauth-relay', now + 60_000, now],
    );
    const exCross = await app.request('/api/auth/token-exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'oauth-relay:cross-1' }),
    });
    expect(exCross.status).toBe(400);
    expect(store.authNonces.has('oauth-relay:cross-1')).toBe(true);
  });

  it('P0-4b: /relay/verify keeps consumed ticket across the entire exp second until verifyJwt itself expires', async () => {
    vi.useFakeTimers();
    const baseMs = 1_700_000_000_400;
    vi.setSystemTime(baseMs);

    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    // Token signed with exp = nowSec + 10 = 1_700_000_010
    const expSec = Math.floor(baseMs / 1000) + 10;
    const ticket = signJwt({
      type: 'doc-auth-relay-ticket',
      iss: 'https://app.im.codes',
      aud: 'https://self.example.com',
      jti: 'doc-exp-boundary-jti',
      provider: 'github',
      externalId: 'ext-b',
      username: 'buser',
      displayName: 'B',
    }, env.JWT_SIGNING_KEY, 10);

    const first = await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: ticket, expectedAudience: 'https://self.example.com' }),
    });
    expect(first.status).toBe(200);

    // Move inside the exact exp second (exp * 1000 + 500ms) while verifyJwt still accepts the token!
    vi.setSystemTime(expSec * 1000 + 500);
    // Trigger cleanup with an unrelated valid ticket
    const otherTicket = signJwt({
      type: 'doc-auth-relay-ticket',
      iss: 'https://app.im.codes',
      aud: 'https://self.example.com',
      jti: 'doc-exp-boundary-other',
      provider: 'github',
      externalId: 'ext-b',
      username: 'buser',
      displayName: 'B',
    }, env.JWT_SIGNING_KEY, 60);
    const second = await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: otherTicket, expectedAudience: 'https://self.example.com' }),
    });
    expect(second.status).toBe(200);

    // Replaying the first ticket at exp * 1000 + 800ms (still inside exp second!) MUST still be rejected as replayed
    vi.setSystemTime(expSec * 1000 + 800);
    const replayAtBoundary = await app.request('/api/auth/relay/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayToken: ticket, expectedAudience: 'https://self.example.com' }),
    });
    expect(replayAtBoundary.status).toBe(401);
  });

  it('P0-4c: OAuth relay redemption ignores pod-local rateLimiter saturation and aligns DB nonce expiry with signed exp across second boundaries', async () => {
    vi.useFakeTimers();
    const startMs = new Date('2026-11-20T12:00:00.990Z').getTime();
    vi.setSystemTime(startMs);

    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'gh-tok' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 991002, login: 'crosssec' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    // Advance system clock across a second boundary during auth_nonces insert (before signJwt runs)
    let crossedSecond = false;
    store.setBeforeSqlHook(async (s) => {
      if (!crossedSecond && s.startsWith('insert into auth_nonces')) {
        crossedSecond = true;
        store.setBeforeSqlHook(null);
        vi.setSystemTime(startMs + 20); // .990 -> .010 of next second
      }
    });

    const state = signJwt({ nonce: 'st-cross', origin: 'https://hk.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const relayEmit = await app.request(`https://app.im.codes/api/auth/github/callback?code=c-cross&state=${encodeURIComponent(state)}`, {
      headers: { host: 'app.im.codes', cookie: 'oauth_state=st-cross' },
    });
    expect(crossedSecond).toBe(true);
    expect(relayEmit.status).toBe(302);
    const relayToken = new URL(relayEmit.headers.get('location')!).searchParams.get('relay_token')!;
    expect(relayToken).toBeTruthy();

    // Decode signed exp directly from JWT
    const payload = JSON.parse(Buffer.from(relayToken.split('.')[1], 'base64url').toString('utf8')) as { exp: number };

    // Simulate pod-local rateLimiter JTI cache saturation returning false for a fresh JTI:
    // PostgreSQL conditional DELETE is sole arbiter, so valid redemption MUST still succeed once.
    vi.spyOn(rateLimiter, 'consumeJti').mockReturnValue(false);

    // Move inside the exact signed exp second (payload.exp * 1000 + 500ms): both verifyJwt and DB nonce MUST still accept
    vi.setSystemTime(payload.exp * 1000 + 500);
    const redeemRes = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(redeemRes.status).toBe(302);
    expect(store.refreshTokens.size).toBe(1);

    // Replaying the same relay_token still inside exp second MUST fail with 401 from DB conditional DELETE
    const replayRes = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(replayRes.status).toBe(401);

    // At (exp + 1) * 1000ms, verifyJwt itself expires
    vi.setSystemTime((payload.exp + 1) * 1000);
    const expiredRes = await app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, {
      headers: { host: 'hk.im.codes' },
    });
    expect(expiredRes.status).toBe(401);
  });

  it('P0-4d: OAuth relay issuance and redemption follow users -> auth_nonces lock order, keep global cleanup outside user tx, and serialize with disable/replay', async () => {
    const store = createHardeningDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'gh-tok' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 882001, login: 'lockorder' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    // 1. Relay issuance: global cleanup runs outside tx, and inside tx `users FOR UPDATE` precedes `INSERT INTO auth_nonces`
    store.sqlLog.length = 0;
    const state1 = signJwt({ nonce: 'st-lo-1', origin: 'https://hk.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const emitRes = await app.request(`https://app.im.codes/api/auth/github/callback?code=c-lo-1&state=${encodeURIComponent(state1)}`, {
      headers: { host: 'app.im.codes', cookie: 'oauth_state=st-lo-1' },
    });
    expect(emitRes.status).toBe(302);
    const relayToken = new URL(emitRes.headers.get('location')!).searchParams.get('relay_token')!;

    const cleanupIdx = store.sqlLog.findIndex((e) => e.sql.includes('delete from auth_nonces where key_id = $1 and expires_at < $2'));
    const issueLockIdx = store.sqlLog.findIndex((e) => e.inTx && e.sql.includes('select status, sessions_valid_after from users where id = $1 for update'));
    const issueInsertIdx = store.sqlLog.findIndex((e) => e.inTx && e.sql.includes('insert into auth_nonces'));
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(store.sqlLog[cleanupIdx]!.inTx).toBe(false);
    expect(issueLockIdx).toBeGreaterThanOrEqual(0);
    expect(issueInsertIdx).toBeGreaterThan(issueLockIdx);

    // 2. Concurrent redemption of the same relay_token: only one succeeds and lock order inside tx is users FOR UPDATE -> DELETE auth_nonces -> INSERT refresh_tokens
    store.sqlLog.length = 0;
    const [red1, red2] = await Promise.all([
      app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, { headers: { host: 'hk.im.codes' } }),
      app.request(`https://hk.im.codes/api/auth/github/callback?relay_token=${encodeURIComponent(relayToken)}`, { headers: { host: 'hk.im.codes' } }),
    ]);
    expect([red1.status, red2.status].sort()).toEqual([302, 401]);
    expect(store.refreshTokens.size).toBe(1);

    const redeemLockIdx = store.sqlLog.findIndex((e) => e.inTx && e.sql.includes('select status, sessions_valid_after from users where id = $1 for update'));
    const redeemDelIdx = store.sqlLog.findIndex((e) => e.inTx && e.sql.includes('delete from auth_nonces where nonce = $1 and user_id = $2'));
    const redeemRtIdx = store.sqlLog.findIndex((e) => e.inTx && e.sql.includes('insert into refresh_tokens'));
    expect(redeemLockIdx).toBeGreaterThanOrEqual(0);
    expect(redeemDelIdx).toBeGreaterThan(redeemLockIdx);
    expect(redeemRtIdx).toBeGreaterThan(redeemDelIdx);

    // 3. If user is disabled just before lock during issuance, no auth_nonces row is written and 403 is returned
    const issuedNonceCountBefore = store.authNonces.size;
    let disabledBeforeIssueLock = false;
    store.setBeforeSqlHook(async (s) => {
      if (!disabledBeforeIssueLock && s.includes('select status, sessions_valid_after from users where id = $1 for update')) {
        disabledBeforeIssueLock = true;
        store.setBeforeSqlHook(null);
        for (const u of store.users.values()) u.status = 'disabled';
      }
    });
    const state2 = signJwt({ nonce: 'st-lo-2', origin: 'https://hk.im.codes', provider: 'github' }, env.JWT_SIGNING_KEY, 300);
    const blockedEmit = await app.request(`https://app.im.codes/api/auth/github/callback?code=c-lo-2&state=${encodeURIComponent(state2)}`, {
      headers: { host: 'app.im.codes', cookie: 'oauth_state=st-lo-2' },
    });
    expect(disabledBeforeIssueLock).toBe(true);
    expect(blockedEmit.status).toBe(403);
    expect(store.authNonces.size).toBe(issuedNonceCountBefore);
  });
});
