export const MEMORY_ORIGINS = [
  'chat_compacted',
  'user_note',
  'skill_import',
  'manual_pin',
  'agent_learned',
  'md_ingest',
] as const;

export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export const RESERVED_MEMORY_ORIGINS = ['quick_search_cache'] as const;
export type ReservedMemoryOrigin = (typeof RESERVED_MEMORY_ORIGINS)[number];

const MEMORY_ORIGIN_SET: ReadonlySet<string> = new Set(MEMORY_ORIGINS);
const RESERVED_MEMORY_ORIGIN_SET: ReadonlySet<string> = new Set(RESERVED_MEMORY_ORIGINS);

export function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === 'string' && MEMORY_ORIGIN_SET.has(value);
}

export function isReservedMemoryOrigin(value: unknown): value is ReservedMemoryOrigin {
  return typeof value === 'string' && RESERVED_MEMORY_ORIGIN_SET.has(value);
}

export function assertMemoryOrigin(value: unknown): MemoryOrigin {
  if (isMemoryOrigin(value)) return value;
  if (isReservedMemoryOrigin(value)) {
    throw new Error(`Reserved memory origin is not emit-safe in this milestone: ${value}`);
  }
  throw new Error(`Unknown memory origin: ${String(value)}`);
}

export function requireExplicitMemoryOrigin(value: unknown, context = 'memory write'): MemoryOrigin {
  if (value == null || value === '') {
    throw new Error(`Missing explicit memory origin for ${context}`);
  }
  return assertMemoryOrigin(value);
}
