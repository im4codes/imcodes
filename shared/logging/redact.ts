export type Redactable = Record<string, unknown>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const SENSITIVE_KEY_PATTERNS = [
  /_token$/i,
  /_key$/i,
  /_secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^deck_/i,
  /^api_key$/i,
];

export const SENSITIVE_VALUE_PATTERNS = [
  /^deck_[0-9a-f]{32,}$/i,
];

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

export function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

export function redactObject(obj: Redactable): Redactable {
  const result: Redactable = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      result[k] = REDACTED;
    } else if (isSensitiveValue(v)) {
      result[k] = REDACTED;
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) => (
        item && typeof item === 'object' && !Array.isArray(item)
          ? redactObject(item as Redactable)
          : isSensitiveValue(item) ? REDACTED : item
      ));
    } else if (v && typeof v === 'object') {
      result[k] = redactObject(v as Redactable);
    } else {
      result[k] = v;
    }
  }
  return result;
}
