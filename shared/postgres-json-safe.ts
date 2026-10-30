/** PostgreSQL JSON/JSONB cannot represent a NUL character in a text value. */
export const POSTGRES_JSON_MAX_DEPTH = 64;
export const POSTGRES_JSON_MAX_NODES = 100_000;

export class PostgresJsonSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresJsonSafetyError';
  }
}

export interface PostgresJsonSanitizeResult {
  value: unknown;
  changed: boolean;
}

function sanitizeString(value: string): PostgresJsonSanitizeResult {
  if (!value.includes('\u0000')) return { value, changed: false };
  return { value: value.replace(/\u0000/g, '\uFFFD'), changed: true };
}

/**
 * Make a parsed JSON value safe for PostgreSQL JSONB. NULs are replaced in
 * values and object keys; cycles, unsupported objects, and pathological depth
 * are rejected before any database call. Repeated references are allowed when
 * they are not cyclic.
 */
export function sanitizePostgresJson(value: unknown): PostgresJsonSanitizeResult {
  const active = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): PostgresJsonSanitizeResult => {
    nodes += 1;
    if (nodes > POSTGRES_JSON_MAX_NODES) {
      throw new PostgresJsonSafetyError('json_too_large');
    }
    if (current === null || typeof current === 'number' || typeof current === 'boolean') {
      return { value: current, changed: false };
    }
    if (typeof current === 'string') return sanitizeString(current);
    if (typeof current !== 'object') {
      throw new PostgresJsonSafetyError('json_unsupported_value');
    }
    if (depth >= POSTGRES_JSON_MAX_DEPTH) {
      throw new PostgresJsonSafetyError('json_too_deep');
    }
    if (active.has(current)) throw new PostgresJsonSafetyError('json_cycle');
    active.add(current);
    try {
      if (Array.isArray(current)) {
        let changed = false;
        const output = current.map((entry) => {
          const result = visit(entry, depth + 1);
          changed ||= result.changed;
          return result.value;
        });
        return { value: changed ? output : current, changed };
      }
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let changed = false;
      for (const [key, entry] of Object.entries(current)) {
        const safeKey = sanitizeString(key);
        const result = visit(entry, depth + 1);
        changed ||= safeKey.changed || result.changed;
        output[safeKey.value as string] = result.value;
      }
      return { value: changed ? output : current, changed };
    } finally {
      active.delete(current);
    }
  };

  return visit(value, 0);
}
