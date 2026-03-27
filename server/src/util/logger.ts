/**
 * Simple structured logger for CF Worker environment.
 * Redacts sensitive fields before writing — no raw secrets ever reach a log sink.
 */

import { redactObject, type LogLevel } from '../../../shared/logging/redact.js';

function log(level: LogLevel, context: Record<string, unknown>, message: string): void {
  const safe = redactObject(context);
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
