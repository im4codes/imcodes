export const MEMORY_WS = {
  SEARCH: 'memory.search',
  ARCHIVE: 'memory.archive',
  ARCHIVE_RESPONSE: 'memory.archive_response',
  RESTORE: 'memory.restore',
  RESTORE_RESPONSE: 'memory.restore_response',
  DELETE: 'memory.delete',
  DELETE_RESPONSE: 'memory.delete_response',
  PERSONAL_QUERY: 'shared_context.personal_memory.query',
  PERSONAL_RESPONSE: 'shared_context.personal_memory.response',
} as const;

export type MemoryWsType = typeof MEMORY_WS[keyof typeof MEMORY_WS];
