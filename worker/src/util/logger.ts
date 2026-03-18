/**
 * Simple structured logger for CF Worker environment.
 * Redacts sensitive fields before writing — no raw secrets ever reach a log sink.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Patterns that match sensitive field names
const SENSITIVE_KEY_PATTERNS = [
  /_token$/i,
  /_key$/i,
  /_secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^deck_/i,
  /^api_key$/i,
];

// Patterns that match sensitive values (like the deck_ prefix in actual values)
const SENSITIVE_VALUE_PATTERNS = [
  /^deck_[0-9a-f]{32,}$/i,  // API key values
];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      result[k] = REDACTED;
    } else if (isSensitiveValue(v)) {
      result[k] = REDACTED;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = redact(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function log(level: LogLevel, context: Record<string, unknown>, message: string): void {
  const safe = redact(context);
  const entry = JSON.stringify({ level, time: Date.now(), msg: message, ...safe });
  if (level === 'error' || level === 'warn') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

const logger = {
  debug: (ctx: Record<string, unknown>, msg: string) => log('debug', ctx, msg),
  info:  (ctx: Record<string, unknown>, msg: string) => log('info', ctx, msg),
  warn:  (ctx: Record<string, unknown>, msg: string) => log('warn', ctx, msg),
  error: (ctx: Record<string, unknown>, msg: string) => log('error', ctx, msg),
};

export default logger;
