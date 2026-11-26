export const EMAIL_AUTH_PURPOSE = {
  REGISTER: 'register',
  PASSWORD_RESET: 'password_reset',
  PASSWORD_CHANGE: 'password_change',
  BIND_EMAIL: 'bind_email',
} as const;

export type EmailAuthPurpose = (typeof EMAIL_AUTH_PURPOSE)[keyof typeof EMAIL_AUTH_PURPOSE];

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_RESEND_COOLDOWN_SECONDS = 60;
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_REGEX = /^[^\s@,;<>()[\]\\"]+@[^\s@,;<>()[\]\\"]+\.[^\s@,;<>()[\]\\"]{2,}$/;
export const EMAIL_OTP_REGEX = /^\d{6}$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (CONTROL_CHAR_REGEX.test(raw)) return false;
  const normalized = normalizeEmail(raw);
  if (!normalized || normalized.length > EMAIL_MAX_LENGTH) return false;
  return EMAIL_REGEX.test(normalized);
}

export function isValidEmailOtp(raw: unknown): raw is string {
  return typeof raw === 'string' && EMAIL_OTP_REGEX.test(raw.trim());
}
