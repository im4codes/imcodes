import { USER_STATUS } from '../../../shared/user-status.js';
import type { Env } from '../../src/env.js';
import { sha256Hex } from '../../src/security/crypto.js';
import { SERVER_ID_HEADER } from '../../../shared/http-header-names.js';
export const token = 'fixture-daemon-secret';
export const key = 'deck_fixture-api-key';
export const signingKey = 'fixture-jwt-signing-key-padding-32';
export const headers = { Authorization: `Bearer ${token}`, [SERVER_ID_HEADER]: 'srv-1', 'Content-Type': 'application/json' };
export function environment(role: string | null = null, revoked: number | null = null) {
  const execute = async () => ({ changes: 1 });
  const queryOne = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM servers WHERE') || sql.includes('from servers where')) return {
      owner_status: USER_STATUS.ACTIVE, id: 'srv-1', token_hash: sha256Hex(token), user_id: 'user-1', team_id: null, node_role: role, revoked_at: revoked,
    };
    if (sql.toLowerCase().includes('from api_keys')) return params[0] === sha256Hex(key) ? { id: 'key-1', user_id: 'user-1', user_status: USER_STATUS.ACTIVE } : null;
    if (sql.toLowerCase().includes('from users')) return { id: 'user-1', username: 'fixture', status: USER_STATUS.ACTIVE, sessions_valid_after: 0 };
    return null;
  };
  return { DB: { queryOne, query: async () => [], execute, exec: async () => {}, close: async () => {} },
    JWT_SIGNING_KEY: signingKey, BOT_ENCRYPTION_KEY: 'a'.repeat(32), TRUSTED_PROXIES: '', SERVER_URL: 'http://localhost' } as unknown as Env;
}
