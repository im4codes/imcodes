export const SEND_ORIGINS = [
  'user_keyboard',
  'user_voice',
  'user_resend',
  'agent_output',
  'tool_output',
  'system_inject',
] as const;

export type SendOrigin = (typeof SEND_ORIGINS)[number];

export const DEFAULT_SEND_ORIGIN: SendOrigin = 'system_inject';

export const TRUSTED_PREF_WRITE_ORIGINS = [
  'user_keyboard',
  'user_voice',
  'user_resend',
] as const satisfies readonly SendOrigin[];

const SEND_ORIGIN_SET: ReadonlySet<string> = new Set(SEND_ORIGINS);
const TRUSTED_PREF_WRITE_ORIGIN_SET: ReadonlySet<string> = new Set(TRUSTED_PREF_WRITE_ORIGINS);

export function isSendOrigin(value: unknown): value is SendOrigin {
  return typeof value === 'string' && SEND_ORIGIN_SET.has(value);
}

export function normalizeSendOrigin(value: unknown): SendOrigin {
  return isSendOrigin(value) ? value : DEFAULT_SEND_ORIGIN;
}

export function isTrustedPreferenceWriteOrigin(value: unknown): value is (typeof TRUSTED_PREF_WRITE_ORIGINS)[number] {
  return typeof value === 'string' && TRUSTED_PREF_WRITE_ORIGIN_SET.has(value);
}
