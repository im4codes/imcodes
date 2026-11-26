import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { EnvConfig } from '../env.js';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '../../../shared/auth-error-codes.js';
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
  | { ok: true }
  | { ok: false; status: 429; error: AuthErrorCode; retryAfterMs: number };

export type ConsumeEmailCodeResult =
  | { ok: true; codeId: string }
  | { ok: false; error: AuthErrorCode };

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
 * When `suppressSendForAntiEnumeration` is true, records a pre-consumed cooldown marker
 * without dispatching an email so unknown/inactive accounts share identical rate limits.
 */
export async function issueEmailVerificationCode(
  db: Database,
  env: Partial<EnvConfig> & { JWT_SIGNING_KEY: string },
  opts: {
    email: string;
    purpose: EmailAuthPurpose;
    userId?: string | null;
    lang?: 'zh' | 'en';
    now?: number;
    suppressSendForAntiEnumeration?: boolean;
  },
): Promise<IssueEmailCodeResult> {
  const normalizedEmail = normalizeEmail(opts.email);
  const now = opts.now ?? Date.now();

  const recent = await db.queryOne<Pick<EmailVerificationCodeRow, 'created_at'>>(
    'SELECT created_at FROM email_verification_codes WHERE LOWER(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
    [normalizedEmail, opts.purpose],
  );
  if (recent) {
    const elapsed = now - Number(recent.created_at);
    if (elapsed >= 0 && elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        status: 429,
        error: AUTH_ERROR_CODES.EMAIL_CODE_RATE_LIMITED,
        retryAfterMs: EMAIL_OTP_RESEND_COOLDOWN_MS - elapsed,
      };
    }
  }

  const codeId = randomHex(16);
  if (opts.suppressSendForAntiEnumeration) {
    await db.execute(
      `INSERT INTO email_verification_codes
        (id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at, consumed_at, created_at)
       VALUES ($1, $2, NULL, $3, $4, 0, $5, $6, $7, $8)`,
      [
        codeId,
        normalizedEmail,
        opts.purpose,
        randomHex(32),
        EMAIL_OTP_MAX_ATTEMPTS,
        now + EMAIL_OTP_TTL_MS,
        now,
        now,
      ],
    );
    return { ok: true };
  }

  const code = generateEmailOtpCode();
  const codeHash = hashEmailOtp(env.JWT_SIGNING_KEY, opts.purpose, normalizedEmail, code);

  await db.transaction(async (tx) => {
    await tx.execute(
      'UPDATE email_verification_codes SET consumed_at = $1 WHERE LOWER(email) = $2 AND purpose = $3 AND consumed_at IS NULL',
      [now, normalizedEmail, opts.purpose],
    );
    await tx.execute(
      `INSERT INTO email_verification_codes
        (id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at, consumed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NULL, $8)`,
      [
        codeId,
        normalizedEmail,
        opts.userId ?? null,
        opts.purpose,
        codeHash,
        EMAIL_OTP_MAX_ATTEMPTS,
        now + EMAIL_OTP_TTL_MS,
        now,
      ],
    );
  });

  const emailContent = buildVerificationEmail(opts.purpose, code, opts.lang ?? 'en');
  try {
    await sendEmail(env, {
      to: normalizedEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
  } catch (err) {
    // Roll back un-delivered OTP so a transient transport failure does not trigger a 60s resend lockout.
    await db.execute('DELETE FROM email_verification_codes WHERE id = $1', [codeId]).catch((cleanupErr) => {
      logger.warn({ err: cleanupErr, codeId }, 'Failed to remove undelivered email verification code');
    });
    throw err;
  }

  return { ok: true };
}

/**
 * Verify and atomically consume the latest unconsumed OTP inside an open DB transaction.
 * Never throws on user input mismatch so callers can commit `attempts + 1` before returning 400.
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
  const now = opts.now ?? Date.now();
  if (!isValidEmailOtp(opts.code)) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }

  const row = await tx.queryOne<EmailVerificationCodeRow>(
    `SELECT id, email, user_id, purpose, code_hash, attempts, max_attempts, expires_at
     FROM email_verification_codes
     WHERE LOWER(email) = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [normalizedEmail, opts.purpose],
  );
  if (!row) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }
  if (opts.userId !== undefined && opts.userId !== null && row.user_id !== opts.userId) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }
  if (now > Number(row.expires_at)) {
    await tx.execute('UPDATE email_verification_codes SET consumed_at = $1 WHERE id = $2', [now, row.id]);
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
        [nextAttempts, now, row.id],
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
    [now, row.id],
  );
  if (updated.changes !== 1) {
    return { ok: false, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID };
  }

  return { ok: true, codeId: row.id };
}
