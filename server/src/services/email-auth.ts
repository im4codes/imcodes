import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { EnvConfig } from '../env.js';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '../../../shared/auth-error-codes.js';
import { isUserStatusActive } from '../../../shared/user-status.js';
import {
  EMAIL_AUTH_PURPOSE,
  EMAIL_OTP_LENGTH,
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS,
  isValidEmail,
  isValidEmailOtp,
  normalizeEmail,
  type EmailAuthPurpose,
} from '../../../shared/email-auth.js';
import { randomHex, sha256Hex } from '../security/crypto.js';
import { checkAuthLockout, recordAuthFailure } from '../security/lockout.js';
import { sendEmail } from './email.js';
import logger from '../util/logger.js';

export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const EMAIL_OTP_RESEND_COOLDOWN_MS = EMAIL_OTP_RESEND_COOLDOWN_SECONDS * 1000;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

export { isValidEmail, isValidEmailOtp, normalizeEmail };

export interface EmailVerificationCodeRow {
  id: string;
  email: string;
  user_id: string | null;
  purpose: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: string | number;
  consumed_at: string | number | null;
  created_at: string | number;
}

export type IssueEmailCodeResult =
  | { ok: true; deliveryPromise?: Promise<void> }
  | { ok: false; status: 400 | 401 | 403 | 409 | 429; error: AuthErrorCode; retryAfterMs?: number };

export type ConsumeEmailCodeResult =
  | { ok: true; codeId: string; now: number }
  | { ok: false; error: AuthErrorCode };

export function emailOtpAdvisoryKey(purpose: EmailAuthPurpose, normalizedEmail: string): string {
  return `email-otp:${purpose}:${normalizedEmail}`;
}

/**
 * Sample PostgreSQL's live wall clock (`clock_timestamp()`) INSIDE an already-locked transaction so
 * lock waiters never evaluate TTL or cooldown using pre-lock application clocks or `BEGIN` transaction time.
 */
export async function getDbClockMs(tx: Database, overrideNow?: number): Promise<number> {
  if (overrideNow !== undefined) return overrideNow;
  const row = await tx.queryOne<{ now_ms: string | number }>(
    'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms',
  );
  return row && row.now_ms !== undefined && row.now_ms !== null ? Number(row.now_ms) : Date.now();
}

export function hashEmailOtp(
  signingKey: string,
  purpose: EmailAuthPurpose,
  normalizedEmail: string,
  code: string,
): string {
  return sha256Hex(`${signingKey}:${purpose}:${normalizedEmail}:${code.trim()}`);
}

export function generateEmailOtpCode(): string {
  return String(randomInt(0, 10 ** EMAIL_OTP_LENGTH)).padStart(EMAIL_OTP_LENGTH, '0');
}

export function resolveEmailLanguage(langHint?: string | null, acceptLanguage?: string | null): 'zh' | 'en' {
  const candidate = (langHint || acceptLanguage || '').trim().toLowerCase();
  return candidate.startsWith('zh') ? 'zh' : 'en';
}

export function buildVerificationEmail(
  purpose: EmailAuthPurpose,
  code: string,
  lang: 'zh' | 'en',
): { subject: string; text: string; html: string } {
  const ttlMinutes = Math.round(EMAIL_OTP_TTL_MS / 60_000);
  if (lang === 'zh') {
    const actionLabel: Record<EmailAuthPurpose, string> = {
      [EMAIL_AUTH_PURPOSE.REGISTER]: '注册账户',
      [EMAIL_AUTH_PURPOSE.PASSWORD_RESET]: '重置密码',
      [EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE]: '修改密码',
      [EMAIL_AUTH_PURPOSE.BIND_EMAIL]: '绑定邮箱',
    };
    const action = actionLabel[purpose];
    return {
      subject: `[IM.codes] ${action}验证码：${code}`,
      text: `您正在 IM.codes 进行${action}，验证码为：${code}\n该验证码 ${ttlMinutes} 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。`,
      html: `<p>您正在 <strong>IM.codes</strong> 进行${action}，验证码为：</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>该验证码 ${ttlMinutes} 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。</p>`,
    };
  }

  const actionLabel: Record<EmailAuthPurpose, string> = {
    [EMAIL_AUTH_PURPOSE.REGISTER]: 'account registration',
    [EMAIL_AUTH_PURPOSE.PASSWORD_RESET]: 'password reset',
    [EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE]: 'password change',
    [EMAIL_AUTH_PURPOSE.BIND_EMAIL]: 'email verification',
  };
  const action = actionLabel[purpose];
  return {
    subject: `[IM.codes] Verification code: ${code}`,
    text: `Use this verification code to complete your IM.codes ${action}: ${code}\nIt expires in ${ttlMinutes} minutes. Do not share this code with anyone. If you did not request it, you can safely ignore this email.`,
    html: `<p>Use this verification code to complete your <strong>IM.codes</strong> ${action}:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>It expires in ${ttlMinutes} minutes. Do not share this code with anyone.</p>`,
  };
}

/**
 * Issue and send a single-use 6-digit verification code (stored hashed, never plaintext).
 *
 * Timing invariant: all cooldown, TTL, and `created_at`/`expires_at` timestamps are sampled from
 * PostgreSQL `clock_timestamp()` AFTER acquiring the relevant row/advisory locks inside the transaction.
 *
 * Canonical lock order inside any transaction touching `users`:
 *   1. Target `users` row (`FOR UPDATE`)
 *   2. `pg_advisory_xact_lock('email-otp:' || purpose || ':' || normalizedEmail)`
 *   3. `email_verification_codes`
 *
 * Public `password_reset` confirmation (`asyncDelivery: true`) writes its cooldown record using ONLY
 * locks (2) and (3) with ZERO dependency on `users` row locks so active login/refresh transactions on
 * known accounts never delay or stall the public confirmation response. Target account lookup, OTP
 * activation, and email delivery happen asynchronously afterwards, guarding against supersession by
 * newer requests before sending.
 */
export async function issueEmailVerificationCode(
  db: Database,
  env: Partial<EnvConfig> & { JWT_SIGNING_KEY: string },
  opts: {
    email?: string;
    purpose: EmailAuthPurpose;
    userId?: string | null;
    lang?: 'zh' | 'en';
    now?: number;
    suppressSendForAntiEnumeration?: boolean;
    lookupResetTarget?: boolean;
    lockoutIdentity?: string;
    asyncDelivery?: boolean;
  },
): Promise<IssueEmailCodeResult> {
  const explicitEmail = typeof opts.email === 'string' && opts.email.trim()
    ? normalizeEmail(opts.email)
    : '';
  const codeId = randomHex(16);
  const generatedCode = generateEmailOtpCode();

  if (opts.lockoutIdentity) {
    const lockout = await checkAuthLockout(db, opts.lockoutIdentity);
    if (lockout.locked) {
      return {
        ok: false,
        status: 429,
        error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
        retryAfterMs: lockout.lockedUntil ? Math.max(0, lockout.lockedUntil - Date.now()) : 0,
      };
    }
  }

  // Path A: Public `password_reset` confirmation (completely decoupled from `users` locks)
  if (opts.purpose === EMAIL_AUTH_PURPOSE.PASSWORD_RESET && opts.asyncDelivery) {
    if (!explicitEmail || !isValidEmail(explicitEmail)) {
      return { ok: false, status: 400, error: AUTH_ERROR_CODES.INVALID_EMAIL };
    }
    const targetEmail = explicitEmail;

    type ResetStageOutcome =
      | { ok: true; expiresAt: number }
      | { ok: false; status: 429; error: AuthErrorCode; retryAfterMs: number };

    const stageOutcome: ResetStageOutcome = await db.transaction(async (tx): Promise<ResetStageOutcome> => {
      await tx.queryOne(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [emailOtpAdvisoryKey(opts.purpose, targetEmail)],
      );
      const txNow = await getDbClockMs(tx, opts.now);

      const recent = await tx.queryOne<Pick<EmailVerificationCodeRow, 'created_at'>>(
        'SELECT created_at FROM email_verification_codes WHERE LOWER(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
        [targetEmail, opts.purpose],
      );
      if (recent) {
        const elapsed = txNow - Number(recent.created_at);
        if (elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
          return {
            ok: false,
            status: 429,
            error: AUTH_ERROR_CODES.EMAIL_CODE_RATE_LIMITED,
            retryAfterMs: Math.max(1, EMAIL_OTP_RESEND_COOLDOWN_MS - Math.max(0, elapsed)),
          };
        }
      }

      const expiresAt = txNow + EMAIL_OTP_TTL_MS;
      // Record unified pre-consumed cooldown row first; background worker binds user + activates hash if eligible.
      await tx.execute(
        `INSERT INTO email_verification_codes
          (id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at, consumed_at, created_at)
         VALUES ($1, $2, NULL, $3, $4, 0, $5, $6, $7, $8)`,
        [
          codeId,
          targetEmail,
          opts.purpose,
          randomHex(32),
          EMAIL_OTP_MAX_ATTEMPTS,
          expiresAt,
          txNow,
          txNow,
        ],
      );
      return { ok: true, expiresAt };
    });

    if (!stageOutcome.ok) {
      if (opts.lockoutIdentity) {
        const lockRes = await recordAuthFailure(db, opts.lockoutIdentity, 'email_send_rate_limited');
        if (lockRes.locked) {
          return {
            ok: false,
            status: 429,
            error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
            retryAfterMs: lockRes.lockedUntil ? Math.max(0, lockRes.lockedUntil - Date.now()) : stageOutcome.retryAfterMs,
          };
        }
      }
      return stageOutcome;
    }

    const deliveryPromise = Promise.resolve()
      .then(async () => {
        if (opts.suppressSendForAntiEnumeration) return;
        const activated = await db.transaction(async (tx): Promise<boolean> => {
          const lockedTarget = await tx.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM users WHERE LOWER(email) = $1 AND email_verified_at IS NOT NULL FOR UPDATE',
            [targetEmail],
          );
          if (!lockedTarget || !isUserStatusActive(lockedTarget.status)) {
            return false;
          }

          await tx.queryOne(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [emailOtpAdvisoryKey(opts.purpose, targetEmail)],
          );
          const bgNow = await getDbClockMs(tx, opts.now);

          const latest = await tx.queryOne<{ id: string; expires_at: string | number }>(
            'SELECT id, expires_at FROM email_verification_codes WHERE LOWER(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
            [targetEmail, opts.purpose],
          );
          if (!latest || latest.id !== codeId || bgNow > Number(latest.expires_at)) {
            return false;
          }

          const codeHash = hashEmailOtp(env.JWT_SIGNING_KEY, opts.purpose, targetEmail, generatedCode);
          await tx.execute(
            'UPDATE email_verification_codes SET consumed_at = $1 WHERE LOWER(email) = $2 AND purpose = $3 AND id != $4 AND consumed_at IS NULL',
            [bgNow, targetEmail, opts.purpose, codeId],
          );
          const upd = await tx.execute(
            'UPDATE email_verification_codes SET user_id = $1, code_hash = $2, consumed_at = NULL WHERE id = $3',
            [lockedTarget.id, codeHash, codeId],
          );
          return upd.changes === 1;
        });

        if (!activated) return;
        const emailContent = buildVerificationEmail(opts.purpose, generatedCode, opts.lang ?? 'en');
        await sendEmail(env, {
          to: targetEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      })
      .catch((err) => {
        logger.warn({ err, purpose: opts.purpose }, 'Background email verification dispatch failed');
      });

    return { ok: true, deliveryPromise };
  }

  // Path B: Authenticated / registration OTP issuance
  type TxOutcome =
    | { ok: true; suppressed: boolean; targetEmail: string }
    | {
        ok: false;
        status: 400 | 401 | 403 | 409 | 429;
        error: AuthErrorCode;
        retryAfterMs?: number;
        recordRateLimit?: boolean;
      };

  const txOutcome: TxOutcome = await db.transaction(async (tx): Promise<TxOutcome> => {
    let targetEmail = explicitEmail;
    let resolvedUserId: string | null = opts.userId ?? null;
    let suppressed = Boolean(opts.suppressSendForAntiEnumeration);

    if (opts.purpose === EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE || opts.purpose === EMAIL_AUTH_PURPOSE.BIND_EMAIL) {
      if (!opts.userId) {
        return { ok: false, status: 401, error: 'unauthorized' as AuthErrorCode };
      }
      const lockedUser = await tx.queryOne<{
        id: string;
        status: string;
        email: string | null;
        email_verified_at: string | number | null;
      }>(
        'SELECT id, status, email, email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [opts.userId],
      );
      if (!lockedUser) {
        return { ok: false, status: 401, error: 'unauthorized' as AuthErrorCode };
      }
      if (!isUserStatusActive(lockedUser.status)) {
        return {
          ok: false,
          status: 403,
          error: lockedUser.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        };
      }
      if (opts.purpose === EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE) {
        if (!lockedUser.email || !lockedUser.email_verified_at) {
          return { ok: false, status: 400, error: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED };
        }
        const verifiedEmail = normalizeEmail(lockedUser.email);
        if (explicitEmail && explicitEmail !== verifiedEmail) {
          return { ok: false, status: 400, error: AUTH_ERROR_CODES.INVALID_EMAIL };
        }
        targetEmail = verifiedEmail;
      } else {
        if (lockedUser.email_verified_at) {
          return { ok: false, status: 409, error: AUTH_ERROR_CODES.EMAIL_ALREADY_VERIFIED };
        }
        if (!targetEmail || !isValidEmail(targetEmail)) {
          return { ok: false, status: 400, error: AUTH_ERROR_CODES.INVALID_EMAIL };
        }
        const existingEmailUser = await tx.queryOne<{ id: string }>(
          'SELECT id FROM users WHERE LOWER(email) = $1',
          [targetEmail],
        );
        if (existingEmailUser && existingEmailUser.id !== lockedUser.id) {
          return { ok: false, status: 409, error: AUTH_ERROR_CODES.EMAIL_TAKEN };
        }
      }
    } else if (opts.purpose === EMAIL_AUTH_PURPOSE.PASSWORD_RESET && opts.lookupResetTarget) {
      if (!targetEmail || !isValidEmail(targetEmail)) {
        return { ok: false, status: 400, error: AUTH_ERROR_CODES.INVALID_EMAIL };
      }
      const lockedTarget = await tx.queryOne<{ id: string; status: string }>(
        'SELECT id, status FROM users WHERE LOWER(email) = $1 AND email_verified_at IS NOT NULL FOR UPDATE',
        [targetEmail],
      );
      if (!lockedTarget || !isUserStatusActive(lockedTarget.status)) {
        resolvedUserId = null;
        suppressed = true;
      } else {
        resolvedUserId = lockedTarget.id;
        suppressed = false;
      }
    } else if (!targetEmail) {
      return { ok: false, status: 400, error: AUTH_ERROR_CODES.INVALID_EMAIL };
    }

    await tx.queryOne(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [emailOtpAdvisoryKey(opts.purpose, targetEmail)],
    );
    const txNow = await getDbClockMs(tx, opts.now);

    if (opts.purpose === EMAIL_AUTH_PURPOSE.REGISTER) {
      const existingEmailUser = await tx.queryOne<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = $1',
        [targetEmail],
      );
      if (existingEmailUser) {
        return { ok: false, status: 409, error: AUTH_ERROR_CODES.EMAIL_TAKEN };
      }
    }

    const recent = await tx.queryOne<Pick<EmailVerificationCodeRow, 'created_at'>>(
      'SELECT created_at FROM email_verification_codes WHERE LOWER(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
      [targetEmail, opts.purpose],
    );
    if (recent) {
      const elapsed = txNow - Number(recent.created_at);
      if (elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
        return {
          ok: false,
          status: 429,
          error: AUTH_ERROR_CODES.EMAIL_CODE_RATE_LIMITED,
          retryAfterMs: Math.max(1, EMAIL_OTP_RESEND_COOLDOWN_MS - Math.max(0, elapsed)),
          recordRateLimit: true,
        };
      }
    }

    if (suppressed) {
      await tx.execute(
        `INSERT INTO email_verification_codes
          (id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at, consumed_at, created_at)
         VALUES ($1, $2, NULL, $3, $4, 0, $5, $6, $7, $8)`,
        [
          codeId,
          targetEmail,
          opts.purpose,
          randomHex(32),
          EMAIL_OTP_MAX_ATTEMPTS,
          txNow + EMAIL_OTP_TTL_MS,
          txNow,
          txNow,
        ],
      );
      return { ok: true, suppressed: true, targetEmail };
    }

    const codeHash = hashEmailOtp(env.JWT_SIGNING_KEY, opts.purpose, targetEmail, generatedCode);
    await tx.execute(
      'UPDATE email_verification_codes SET consumed_at = $1 WHERE LOWER(email) = $2 AND purpose = $3 AND consumed_at IS NULL',
      [txNow, targetEmail, opts.purpose],
    );
    await tx.execute(
      `INSERT INTO email_verification_codes
        (id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at, consumed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NULL, $8)`,
      [
        codeId,
        targetEmail,
        resolvedUserId,
        opts.purpose,
        codeHash,
        EMAIL_OTP_MAX_ATTEMPTS,
        txNow + EMAIL_OTP_TTL_MS,
        txNow,
      ],
    );
    return { ok: true, suppressed: false, targetEmail };
  });

  if (!txOutcome.ok) {
    if (txOutcome.recordRateLimit && opts.lockoutIdentity) {
      const lockRes = await recordAuthFailure(db, opts.lockoutIdentity, 'email_send_rate_limited');
      if (lockRes.locked) {
        return {
          ok: false,
          status: 429,
          error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
          retryAfterMs: lockRes.lockedUntil ? Math.max(0, lockRes.lockedUntil - Date.now()) : txOutcome.retryAfterMs,
        };
      }
    }
    return {
      ok: false,
      status: txOutcome.status,
      error: txOutcome.error,
      ...(txOutcome.retryAfterMs !== undefined ? { retryAfterMs: txOutcome.retryAfterMs } : {}),
    };
  }

  if (txOutcome.suppressed) {
    return { ok: true };
  }

  const emailContent = buildVerificationEmail(opts.purpose, generatedCode, opts.lang ?? 'en');
  try {
    await sendEmail(env, {
      to: txOutcome.targetEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
  } catch (err) {
    // Roll back un-delivered OTP for authenticated/registration flows so transport errors don't trap the user in a 60s cooldown.
    await db.execute('DELETE FROM email_verification_codes WHERE id = $1', [codeId]).catch((cleanupErr) => {
      logger.warn({ err: cleanupErr, codeId }, 'Failed to remove undelivered email verification code');
    });
    throw err;
  }

  return { ok: true };
}

/**
 * Verify and atomically consume the latest unconsumed OTP inside an open DB transaction.
 * Serializes per `(purpose, normalizedEmail)` via `pg_advisory_xact_lock`, locks the row `FOR UPDATE`,
 * and samples PostgreSQL `clock_timestamp()` AFTER locking so lock wait across TTL boundaries never accepts stale OTPs.
 */
export async function consumeEmailVerificationCode(
  tx: Database,
  signingKey: string,
  opts: {
    email: string;
    purpose: EmailAuthPurpose;
    code: string;
    userId?: string | null;
    now?: number;
  },
): Promise<ConsumeEmailCodeResult> {
  const normalizedEmail = normalizeEmail(opts.email);
  if (!isValidEmailOtp(opts.code)) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }

  await tx.queryOne(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [emailOtpAdvisoryKey(opts.purpose, normalizedEmail)],
  );

  const row = await tx.queryOne<EmailVerificationCodeRow>(
    `SELECT id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at
     FROM email_verification_codes
     WHERE LOWER(email) = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [normalizedEmail, opts.purpose],
  );
  const txNow = await getDbClockMs(tx, opts.now);

  if (!row) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }
  if (opts.userId !== undefined && opts.userId !== null && row.user_id !== opts.userId) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }
  if (txNow > Number(row.expires_at)) {
    await tx.execute('UPDATE email_verification_codes SET consumed_at = $1 WHERE id = $2', [txNow, row.id]);
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_EXPIRED };
  }

  const expectedHash = hashEmailOtp(signingKey, opts.purpose, normalizedEmail, opts.code);
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  const actualBuf = Buffer.from(row.code_hash, 'hex');
  const matches = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

  if (!matches) {
    const nextAttempts = Number(row.attempts) + 1;
    const maxAttempts = Number(row.max_attempts) || EMAIL_OTP_MAX_ATTEMPTS;
    if (nextAttempts >= maxAttempts) {
      await tx.execute(
        'UPDATE email_verification_codes SET attempts = $1, consumed_at = $2 WHERE id = $3',
        [nextAttempts, txNow, row.id],
      );
    } else {
      await tx.execute(
        'UPDATE email_verification_codes SET attempts = $1 WHERE id = $2',
        [nextAttempts, row.id],
      );
    }
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }

  const updated = await tx.execute(
    'UPDATE email_verification_codes SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL',
    [txNow, row.id],
  );
  if (updated.changes !== 1) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }

  return { ok: true, codeId: row.id, now: txNow };
}
