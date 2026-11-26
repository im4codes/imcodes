import { apiFetch, ApiError } from '../api.js';
import { AUTH_ERROR_CODES } from '@shared/auth-error-codes.js';
import type { EmailAuthPurpose } from '@shared/email-auth.js';

export interface EmailAuthConfigResponse {
  emailAuthEnabled: boolean;
}

export async function fetchEmailAuthConfig(): Promise<EmailAuthConfigResponse> {
  return apiFetch<EmailAuthConfigResponse>('/api/auth/email/config');
}

export async function sendEmailVerificationCode(params: {
  email?: string;
  purpose: EmailAuthPurpose;
  lang?: string;
}): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/auth/email/send-code', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function bindUserEmail(email: string, code: string): Promise<{
  ok: boolean;
  email: string;
  email_verified: boolean;
}> {
  return apiFetch<{ ok: boolean; email: string; email_verified: boolean }>('/api/auth/email/bind', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
}

export async function passwordResetWithEmail(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ email, code, newPassword }),
  });
}

export function extractAuthErrorDetails(err: unknown): {
  code: string | null;
  retryAfterMs: number | null;
  apiError: ApiError | null;
} {
  const apiError = err instanceof ApiError ? err : null;
  const body = apiError?.body ?? '';
  let code = apiError?.code ?? null;
  let retryAfterMs: number | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; retryAfterMs?: unknown };
    if (!code && typeof parsed.error === 'string') code = parsed.error;
    if (typeof parsed.retryAfterMs === 'number') retryAfterMs = parsed.retryAfterMs;
  } catch {
    // non-JSON body
  }
  return { code, retryAfterMs, apiError };
}

export function mapEmailAuthErrorCode(
  t: (key: string, opts?: Record<string, unknown>) => string,
  prefix: 'login' | 'settings',
  code: string | null,
  retryAfterMs: number | null,
): string | null {
  if (!code) return null;
  switch (code) {
    case AUTH_ERROR_CODES.EMAIL_AUTH_DISABLED:
      return t('login.email_auth_disabled');
    case AUTH_ERROR_CODES.INVALID_EMAIL:
      return t(`${prefix}.invalid_email`);
    case AUTH_ERROR_CODES.EMAIL_TAKEN:
      return t(`${prefix}.email_taken`);
    case AUTH_ERROR_CODES.EMAIL_REQUIRED:
      return t('login.email_required');
    case AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED:
      return t(`${prefix}.email_code_required`);
    case AUTH_ERROR_CODES.EMAIL_CODE_INVALID:
      return t(`${prefix}.email_code_invalid`);
    case AUTH_ERROR_CODES.EMAIL_CODE_EXPIRED:
      return t(`${prefix}.email_code_expired`);
    case AUTH_ERROR_CODES.EMAIL_CODE_RATE_LIMITED: {
      const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 1000));
      return t(`${prefix}.email_code_rate_limited`, { seconds });
    }
    case AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED:
      return t(`${prefix}.email_not_verified`);
    case 'email_send_failed':
      return t(`${prefix}.email_send_failed`);
    default:
      return null;
  }
}
