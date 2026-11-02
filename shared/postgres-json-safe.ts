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

/**
 * Sanitize a parsed JSON value at the serialization boundary used for
 * PostgreSQL JSONB. The standard JSON.stringify replacer provides the
 * traversal and cycle detection; the parse step returns the exact value that
 * will be persisted. Only actual NUL characters are replaced, so a literal
 * two-character `\\u0000` sequence is preserved.
 *
 * Object keys need a small adapter because JSON.stringify replacers can change
 * values but not property names. Key-changing objects are copied once and
 * then passed back through the same standard serializer. Unsupported values,
 * cycles, depth, and node limits fail closed before a database call.
 */
export function sanitizePostgresJson(value: unknown): PostgresJsonSanitizeResult {
  let nodes = 0;
  let changed = false;
  const depthByObject = new WeakMap<object, number>();
  const sanitizedObjects = new WeakMap<object, Record<string, unknown>>();

  const replacer = function (this: unknown, key: string, current: unknown): unknown {
    nodes += 1;
    if (nodes > POSTGRES_JSON_MAX_NODES) {
      throw new PostgresJsonSafetyError('json_too_large');
    }

    const holder = this && typeof this === 'object' ? this as object : null;
    const parentDepth = holder ? (depthByObject.get(holder) ?? 0) : 0;
    const depth = key === '' ? 0 : parentDepth + 1;

    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      if (typeof current === 'string' && current.includes('\u0000')) {
        changed = true;
        return current.replace(/\u0000/g, '\uFFFD');
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new PostgresJsonSafetyError('json_unsupported_value');
      return current;
    }
    if (typeof current !== 'object' || current === null) {
      throw new PostgresJsonSafetyError('json_unsupported_value');
    }
    if (depth >= POSTGRES_JSON_MAX_DEPTH) {
      throw new PostgresJsonSafetyError('json_too_deep');
    }
    depthByObject.set(current, depth);
    if (Array.isArray(current)) return current;

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PostgresJsonSafetyError('json_unsupported_value');
    }

    const record = current as Record<string, unknown>;
    const safeKeys = Object.keys(record).map((originalKey) => {
      const safeKey = originalKey.replace(/\u0000/g, '\uFFFD');
      if (safeKey !== originalKey) changed = true;
      return { originalKey, safeKey };
    });
    if (safeKeys.every(({ originalKey, safeKey }) => originalKey === safeKey)) return current;

    const existing = sanitizedObjects.get(current);
    if (existing) {
      depthByObject.set(existing, depth);
      return existing;
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    sanitizedObjects.set(current, output);
    depthByObject.set(output, depth);
    for (const { originalKey, safeKey } of safeKeys) {
      if (Object.prototype.hasOwnProperty.call(output, safeKey)) {
        throw new PostgresJsonSafetyError('json_key_collision');
      }
      output[safeKey] = record[originalKey];
    }
    return output;
  };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, replacer);
  } catch (error) {
    if (error instanceof PostgresJsonSafetyError) throw error;
    if (error instanceof TypeError && /circular|cyclic/i.test(error.message)) {
      throw new PostgresJsonSafetyError('json_cycle');
    }
    throw new PostgresJsonSafetyError('json_serialization_failed');
  }
  if (serialized === undefined) throw new PostgresJsonSafetyError('json_unsupported_value');
  return { value: JSON.parse(serialized) as unknown, changed };
}
