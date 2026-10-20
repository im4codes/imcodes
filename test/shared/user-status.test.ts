import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES } from '../../shared/auth-error-codes.js';
import {
  ACCOUNT_CONNECTION_WATCH_INTERVAL_MS,
  ACCOUNT_WS_CLOSE_CODE,
  USER_STATUS,
  isUserStatusActive,
  userStatusDenialCode,
} from '../../shared/user-status.js';

describe('account status (shared/user-status.ts)', () => {
  it('only exactly `active` may act: pending, disabled, unknown and missing statuses are all refused (fail closed)', () => {
    expect(isUserStatusActive(USER_STATUS.ACTIVE)).toBe(true);
    for (const status of [USER_STATUS.PENDING, USER_STATUS.DISABLED, 'suspended', 'ACTIVE', ' active', '', null, undefined, 0, {}]) {
      expect(isUserStatusActive(status), String(status)).toBe(false);
    }
  });

  it('names the refusal: pending says pending, everything else says disabled', () => {
    expect(userStatusDenialCode(USER_STATUS.PENDING)).toBe(AUTH_ERROR_CODES.ACCOUNT_PENDING);
    for (const status of [USER_STATUS.DISABLED, 'suspended', null, undefined]) {
      expect(userStatusDenialCode(status)).toBe(AUTH_ERROR_CODES.ACCOUNT_DISABLED);
    }
  });

  it('closes live connections with the code clients already back off on (a revoked credential gets it too), within seconds', () => {
    expect(ACCOUNT_WS_CLOSE_CODE).toBe(4003);
    expect(ACCOUNT_CONNECTION_WATCH_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });
});
