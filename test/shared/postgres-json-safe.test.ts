import { describe, expect, it } from 'vitest';
import {
  PostgresJsonSafetyError,
  sanitizePostgresJson,
} from '../../shared/postgres-json-safe.js';

describe('PostgreSQL JSON safety', () => {
  it('recursively replaces actual NULs while preserving valid escapes and Unicode', () => {
    const input = { '\u0000key': ['a\u0000b', 'literal\\u0000', '😀'] };
    expect(sanitizePostgresJson(input)).toEqual({
      changed: true,
      value: { '�key': ['a�b', 'literal\\u0000', '😀'] },
    });
  });

  it('rejects cycles and excessive depth before serialization', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => sanitizePostgresJson(cycle)).toThrowError(PostgresJsonSafetyError);

    let deep: unknown = 'leaf';
    for (let index = 0; index < 65; index += 1) deep = { deep };
    expect(() => sanitizePostgresJson(deep)).toThrowError('json_too_deep');
  });
});
