/**
 * Simple structured logger for CF Worker environment.
 * Redacts sensitive fields before writing — no raw secrets ever reach a log sink.
 */

import { redactObject, REDACTED, type Redactable, type LogLevel } from '../../../shared/logging/redact.js';

/**
 * Payload field carrying the out-of-band `{ aliasName: aliasValue }` map that the
 * browser attaches to a `session.send` (see web SessionControls / daemon
 * command-handler, which read this exact field). Its VALUES are alias plaintext
 * — user secrets (ssh strings, tokens, etc.) — and are value-secrecy scoped:
 * they must reach the daemon intact but must NEVER appear in a server log,
 * metric, diagnostic, or snapshot.
 *
 * The shared key/value redaction in `redactObject` does NOT cover this: the field
 * key `resolvedAliases` matches no sensitive-key pattern, and its object value is
 * merely recursed into (so the alias VALUES would be logged verbatim). We
 * therefore scrub the whole field here — at every nesting depth — BEFORE handing
 * the context to `redactObject`, replacing the map with a `[REDACTED]` marker so
 * neither alias names nor (critically) their values ever reach a sink.
 */
const RESOLVED_ALIASES_FIELD = 'resolvedAliases';

/**
 * Return a structurally-cloned copy of `value` in which every `resolvedAliases`
 * field (at any depth, inside objects and arrays) has its value replaced by the
 * `[REDACTED]` marker. Never mutates the caller's object. Non-plain values are
 * returned as-is; `Error` instances are passed through untouched so the existing
 * `redactObject` error handling (name/message/stack + query-param scrub) still
 * runs on them afterwards.
 */
function scrubResolvedAliases(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubResolvedAliases(item));
  }
  // Leave Error instances for redactObject's dedicated error path; recursing here
  // would strip their non-enumerable name/message/stack.
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === RESOLVED_ALIASES_FIELD ? REDACTED : scrubResolvedAliases(v);
    }
    return out;
  }
  return value;
}

function log(level: LogLevel, context: Record<string, unknown>, message: string): void {
  const scrubbed = scrubResolvedAliases(context) as Redactable;
  const safe = redactObject(scrubbed);
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
